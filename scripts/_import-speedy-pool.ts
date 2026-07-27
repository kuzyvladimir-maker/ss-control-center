/**
 * One-off importer: load the verified-free SpeedyBarcode pool into UPCPool.
 *
 * Source CSV (Jackie's audit, 2026-07-01): 22,810 purchased − 9,571
 * Veeqo-assigned = 13,239 free. Columns:
 *   upc, state, source_order, check_digit_valid, assigned_sku,
 *   marketplace_status, last_updated
 *
 * We insert each as status=AVAILABLE, acquired_from="SpeedyBarcode",
 * notes carries the source_order. acquired_at is set strictly increasing
 * in file order so reserveUpc() (ORDER BY acquired_at ASC) hands them out
 * FIFO in a stable, deterministic order.
 *
 * Idempotent: createMany({skipDuplicates}) on the @unique upc column —
 * a UPC already present in ANY status (ASSIGNED real listings, QUARANTINED
 * junk) is left untouched, so we never resurrect a used barcode.
 *
 * Run (against prod Turso):
 *   DOTENV_CONFIG_PATH=/path/.env.prod npx tsx scripts/_import-speedy-pool.ts
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";

const CSV_PATH =
  "/Users/amazon/ss-control-center/docs/speedy_free_pool---cb497d81-9aea-4afd-839b-cf47fbaee63e.csv";
const ACQUIRED_FROM = "SpeedyBarcode";
const GS1_OWNER = "Salutem Solutions LLC (SpeedyBarcode)";
// Fixed base epoch (2025-01-01) + row-index seconds → stable FIFO order.
const BASE_MS = Date.parse("2025-01-01T00:00:00.000Z");
const BATCH = 500;

function isValidUpc(upc: string): boolean {
  if (!/^\d{12}$/.test(upc)) return false;
  const d = upc.split("").map(Number);
  const sum =
    (d[0] + d[2] + d[4] + d[6] + d[8] + d[10]) * 3 +
    (d[1] + d[3] + d[5] + d[7] + d[9]);
  const check = (10 - (sum % 10)) % 10;
  return check === d[11];
}

async function main() {
  const raw = readFileSync(CSV_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  const header = raw.shift(); // strip header
  if (!header || !header.startsWith("upc,")) {
    throw new Error(`Unexpected CSV header: ${header}`);
  }

  const rows: {
    upc: string;
    upc_prefix: string;
    gs1_validated: boolean;
    gs1_owner: string;
    status: string;
    acquired_from: string;
    acquired_at: Date;
    notes: string;
  }[] = [];

  let malformed = 0;
  raw.forEach((line, i) => {
    const [upc, , source_order = "", check_digit_valid = ""] = line.split(",");
    const clean = (upc ?? "").trim();
    if (!isValidUpc(clean)) {
      malformed++;
      return;
    }
    rows.push({
      upc: clean,
      upc_prefix: clean.slice(0, 6),
      gs1_validated: check_digit_valid.trim().toLowerCase() === "true",
      gs1_owner: GS1_OWNER,
      status: "AVAILABLE",
      acquired_from: ACQUIRED_FROM,
      acquired_at: new Date(BASE_MS + i * 1000),
      notes: `Speedy free pool import 2026-07-01; order=${source_order.trim()}`,
    });
  });

  console.log(`Parsed ${rows.length} valid rows (${malformed} malformed skipped).`);

  const before = await prisma.uPCPool.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log("UPCPool BEFORE:", JSON.stringify(before));

  // libsql adapter has no skipDuplicates → pre-filter against every UPC
  // already in the pool (any status), so we never touch ASSIGNED/QUARANTINED.
  const existing = new Set(
    (await prisma.uPCPool.findMany({ select: { upc: true } })).map((r) => r.upc),
  );
  const fresh = rows.filter((r) => !existing.has(r.upc));
  const collided = rows.length - fresh.length;
  console.log(
    `Existing pool size=${existing.size}; ${collided} import rows already present (skipped).`,
  );

  let inserted = 0;
  for (let s = 0; s < fresh.length; s += BATCH) {
    const chunk = fresh.slice(s, s + BATCH);
    const res = await prisma.uPCPool.createMany({ data: chunk });
    inserted += res.count;
    process.stdout.write(
      `\r  imported ${Math.min(s + BATCH, fresh.length)}/${fresh.length} (new: ${inserted})`,
    );
  }
  console.log("");

  const after = await prisma.uPCPool.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log("UPCPool AFTER:", JSON.stringify(after));
  console.log(
    `DONE. attempted=${rows.length}, newly-inserted=${inserted}, skipped-as-duplicate=${rows.length - inserted}`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("IMPORT FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
