/**
 * Pre-seed for `UPCPool` — imports Vladimir's owned UPCs from the most
 * recent Active Listings Report (TSV) in `data/imports/`.
 *
 * Behaviour:
 *   - Glob `data/imports/Active_Listings_Report_*.txt` and pick the most
 *     recently modified file.
 *   - If none exists: print a clear TODO and return 0 (does NOT throw —
 *     this lets `prisma db seed` continue running other seeds).
 *   - Otherwise: parse TSV, extract (seller-sku, product-id) pairs, filter
 *     to UPCs starting with 742259 / 789232 / 617261, and upsert into
 *     UPCPool. Existing UPCs keep their current status; new UPCs are
 *     created with status=ASSIGNED if a SKU is listed (used) or AVAILABLE
 *     otherwise.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const OWNED_PREFIXES = ["742259", "789232", "617261"] as const;

/** Locate the newest `data/imports/Active_Listings_Report_*.txt` (relative
 *  to the Prisma project root). Returns null if none exists. */
function findReport(projectRoot: string): string | null {
  const dir = resolve(projectRoot, "data", "imports");
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter(
      (f) => f.startsWith("Active_Listings_Report") && f.endsWith(".txt")
    )
    .map((f) => {
      const full = join(dir, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.full ?? null;
}

type ParsedRow = {
  sellerSku: string;
  upc: string;
};

/** Parse the TSV; returns only rows whose UPC starts with an owned prefix. */
function parseReport(path: string): ParsedRow[] {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = lines[0]!.split("\t").map((c) => c.trim());
  const skuIdx = header.findIndex((c) => c.toLowerCase() === "seller-sku");
  const upcIdx = header.findIndex((c) => c.toLowerCase() === "product-id");
  if (skuIdx === -1 || upcIdx === -1) {
    throw new Error(
      `Active Listings Report ${path} missing required columns. ` +
        `Found header: ${header.join(" | ")}`
    );
  }

  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split("\t");
    const sellerSku = (cells[skuIdx] ?? "").trim();
    const upc = (cells[upcIdx] ?? "").trim();
    if (!upc) continue;
    if (!OWNED_PREFIXES.some((p) => upc.startsWith(p))) continue;
    out.push({ sellerSku, upc });
  }
  return out;
}

function prefixOf(upc: string): string {
  for (const p of OWNED_PREFIXES) {
    if (upc.startsWith(p)) return p;
  }
  return upc.slice(0, 6);
}

/** Idempotent seeder. Returns the number of records inserted/updated.
 *  Logs a TODO message and returns 0 when the report is missing. */
export async function seedUpcPool(
  prisma: import("../../src/generated/prisma/client").PrismaClient,
  projectRoot: string = process.cwd()
): Promise<number> {
  const path = findReport(projectRoot);
  if (!path) {
    console.log(
      "  ⚠ TODO: drop the Active Listings Report into data/imports/" +
        " (e.g. Active_Listings_Report_05-17-2026.txt) and re-run" +
        " `npx prisma db seed` to populate UPCPool. Skipping for now."
    );
    return 0;
  }

  console.log(`  · Parsing UPCs from ${path}`);
  let rows: ParsedRow[];
  try {
    rows = parseReport(path);
  } catch (err) {
    console.error(`  ✗ Failed to parse report: ${(err as Error).message}`);
    return 0;
  }

  // De-dupe by UPC; the first occurrence wins (one product can appear in
  // multiple listing rows if it's relisted under different SKUs).
  const seen = new Map<string, ParsedRow>();
  for (const r of rows) {
    if (!seen.has(r.upc)) seen.set(r.upc, r);
  }

  let count = 0;
  for (const r of seen.values()) {
    // ASSIGNED if the SKU column is non-empty (i.e. the UPC is actively in
    // use on a listing); otherwise AVAILABLE.
    const status = r.sellerSku ? "ASSIGNED" : "AVAILABLE";
    await prisma.uPCPool.upsert({
      where: { upc: r.upc },
      create: {
        upc: r.upc,
        upc_prefix: prefixOf(r.upc),
        status,
        acquired_from: "Active Listings Report import",
        notes: r.sellerSku
          ? `Imported on first run; SKU at import time: ${r.sellerSku}`
          : null,
      },
      // Don't downgrade an existing ASSIGNED row back to AVAILABLE on
      // re-runs — re-imports should not race with manual flips.
      update: {},
    });
    count++;
  }
  console.log(`  · Imported ${count} UPCs`);
  return count;
}
