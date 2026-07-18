/**
 * Read-only preflight for deterministic Uncrustables cooler heroes.
 *
 * Reads an immutable listing ledger, loads each live draft's selected variant,
 * and proves that every flavor has a reviewed real front-photo candidate. It
 * does not download/generate/upload images and never writes Prisma/Amazon.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import type { Variant } from "@/lib/bundle-factory/variation-matrix";

interface Ledger {
  audit_id?: string;
  schema_version?: string;
  rows?: Array<{
    sku: string;
    asin: string | null;
    live: { fetched?: boolean } | null;
    db: { draft: { id: string } | null };
  }>;
}

function args(argv: string[]): { input: string; outputDir: string } {
  let input = "";
  let outputDir = "data/audits";
  for (const arg of argv) {
    if (arg.startsWith("--input=")) input = arg.slice(8).trim();
    else if (arg.startsWith("--output-dir=")) outputDir = arg.slice(13).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input=SNAPSHOT is required");
  return { input, outputDir };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function main(): Promise<void> {
  // Dynamic imports are intentional: ESM hoists static imports before dotenv,
  // which would bind Prisma to the local fallback DB instead of Turso.
  const [{ prisma }, { resolveCoolerHeroPlan }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/bundle-factory/cooler-hero"),
  ]);
  const options = args(process.argv.slice(2));
  const sourcePath = path.resolve(options.input);
  const sourceBytes = await readFile(sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8")) as Ledger;
  if (!Array.isArray(source.rows)) throw new Error("Snapshot has no rows array");
  const targets = source.rows.filter(
    (row) => row.live?.fetched && row.asin && row.db.draft?.id,
  );
  const draftIds = targets.map((row) => row.db.draft!.id);
  // Turso/SQLite adapters can silently mishandle very large IN lists. Keep
  // each read bounded and deterministic.
  const drafts = [] as Array<{
    id: string;
    variation_matrix: { selected_variant_idx: number | null; variants_json: string } | null;
  }>;
  for (let offset = 0; offset < draftIds.length; offset += 40) {
    drafts.push(...await prisma.bundleDraft.findMany({
      where: { id: { in: draftIds.slice(offset, offset + 40) } },
      select: {
        id: true,
        variation_matrix: {
          select: { selected_variant_idx: true, variants_json: true },
        },
      },
    }));
  }
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  const rows: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const draftId = target.db.draft!.id;
    const draft = byId.get(draftId);
    try {
      if (!draft?.variation_matrix) throw new Error("variation matrix missing");
      const variants = JSON.parse(draft.variation_matrix.variants_json) as Variant[];
      const selected = draft.variation_matrix.selected_variant_idx;
      if (selected == null || !variants[selected]) throw new Error("selected variant missing");
      const plan = await resolveCoolerHeroPlan(variants[selected]);
      rows.push({
        sku: target.sku,
        asin: target.asin,
        draft_id: draftId,
        pass: true,
        recipe_units: variants[selected].composition.reduce((sum, item) => sum + item.qty, 0),
        expected_flavors: plan.map((item) => item.flavor),
        visible_boxes: plan.reduce((sum, item) => sum + item.visible_boxes, 0),
        plan,
      });
    } catch (error) {
      rows.push({
        sku: target.sku,
        asin: target.asin,
        draft_id: draftId,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const now = new Date();
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `uncrustables-hero-preflight-${stamp(now)}.json`);
  const failed = rows.filter((row) => !row.pass);
  const payload = {
    schema_version: "uncrustables-hero-preflight/v1.0",
    immutable: true,
    external_mutations: false,
    created_at: now.toISOString(),
    source_snapshot: {
      path: sourcePath,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      audit_id: source.audit_id ?? null,
      schema_version: source.schema_version ?? null,
    },
    scope: {
      database_reads: true,
      database_writes: 0,
      marketplace_calls: 0,
      image_downloads: 0,
      image_uploads: 0,
    },
    summary: { target: targets.length, passed: rows.length - failed.length, failed: failed.length },
    rows,
  };
  const handle = await open(output, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  console.log(`Hero preflight: ${output}`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (failed.length > 0) process.exitCode = 2;
  await prisma.$disconnect();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
