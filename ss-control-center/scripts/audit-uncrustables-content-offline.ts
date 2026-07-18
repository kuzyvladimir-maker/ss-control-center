/**
 * Offline semantic/content audit for an immutable Uncrustables ledger.
 *
 * No Prisma, Amazon, or other network calls. The selected VariationMatrix
 * snapshot is the recipe authority; live marketplace text is checked for
 * exact unit count, every flavor/allocation, formatting, and prohibited claims.
 *
 * Usage:
 *   npx tsx scripts/audit-uncrustables-content-offline.ts \
 *     --input=data/audits/uncrustables-ledger-...-offline.json
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  validateOutput,
  validateSemanticOutput,
} from "@/lib/bundle-factory/content-generation";
import { rulePromotionalLanguage } from "@/lib/bundle-factory/compliance/rules/rule-8-promotional-language";
import type { ComplianceInput } from "@/lib/bundle-factory/compliance/types";
import type { Variant } from "@/lib/bundle-factory/variation-matrix";

interface SnapshotComponent {
  product_id?: string | null;
  product_name: string;
  brand: string | null;
  flavor: string | null;
  qty: number;
  unit_price_cents: number | null;
}

interface SnapshotRow {
  sku: string;
  asin: string | null;
  db: {
    draft: null | {
      id: string;
      brand: string;
      pack_count: number;
      selected_variant: null | {
        name: string | null;
        composition: SnapshotComponent[];
      };
    };
  };
  live: null | {
    fetched: boolean;
    title: string | null;
    bullets: string[];
    description: string | null;
  };
}

interface Snapshot {
  schema_version?: string;
  audit_id?: string;
  marketplace_observed_at?: string;
  rows?: SnapshotRow[];
}

function parseArgs(argv: string[]): { input: string; outputDir: string } {
  let input = "";
  let outputDir = "data/audits";
  for (const arg of argv) {
    if (arg.startsWith("--input=")) input = arg.slice("--input=".length).trim();
    else if (arg.startsWith("--output-dir=")) outputDir = arg.slice("--output-dir=".length).trim();
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/audit-uncrustables-content-offline.ts --input=SNAPSHOT [--output-dir=data/audits]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input=SNAPSHOT is required");
  if (!outputDir) throw new Error("--output-dir cannot be empty");
  return { input, outputDir };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function asVariant(row: SnapshotRow): Variant | null {
  const selected = row.db.draft?.selected_variant;
  if (!selected?.composition.length) return null;
  return {
    idx: 0,
    name: selected.name ?? row.sku,
    composition: selected.composition.map((component) => ({
      research_pool_id: component.product_id ?? `missing-${row.sku}`,
      product_name: component.product_name,
      brand: component.brand ?? "Uncrustables",
      flavor: component.flavor,
      qty: component.qty,
      unit_price_cents: component.unit_price_cents ?? 0,
    })),
    cost_cents: 0,
    suggested_price_cents: 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 0,
    notes: "offline audit reconstruction",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(args.input);
  const sourceBytes = await readFile(sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8")) as Snapshot;
  if (!Array.isArray(source.rows)) throw new Error("Snapshot has no rows array");

  const checked: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const row of source.rows) {
    if (!row.live?.fetched || !row.live.title || !row.live.description) {
      skipped.push({ sku: row.sku, asin: row.asin, reason: "no fetched live content" });
      continue;
    }
    const variant = asVariant(row);
    const draft = row.db.draft;
    if (!variant || !draft) {
      skipped.push({ sku: row.sku, asin: row.asin, reason: "no selected recipe" });
      continue;
    }
    const parsed = {
      title: row.live.title,
      bullets: row.live.bullets,
      description: row.live.description,
    };
    const formatError = validateOutput(parsed, "amazon");
    const semanticError = validateSemanticOutput(parsed, {
      brand: draft.brand,
      pack_count: draft.pack_count,
      selected_variant: variant,
    });
    const claims = rulePromotionalLanguage({
      title: row.live.title,
      brand: draft.brand,
      bullets: row.live.bullets,
      description: row.live.description,
      browse_node: null,
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      skip_image_check: true,
    } satisfies ComplianceInput);
    const failures = [
      ...(formatError ? [{ type: "FORMAT", message: formatError }] : []),
      ...(semanticError ? [{ type: "SEMANTIC", message: semanticError }] : []),
      ...(!claims.passed
        ? [{ type: "CLAIMS", message: claims.reason, details: claims.details }]
        : []),
    ];
    checked.push({
      sku: row.sku,
      asin: row.asin,
      draft_id: draft.id,
      intended_count: draft.pack_count,
      title: row.live.title,
      failures,
      pass: failures.length === 0,
    });
  }

  const now = new Date();
  const outputDir = path.resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `uncrustables-content-${stamp(now)}-offline.json`);
  const failed = checked.filter((row) => !row.pass);
  const payload = {
    schema_version: "uncrustables-content-audit/v1.0",
    audit_id: `UCA-${stamp(now)}`,
    mode: "offline",
    immutable: true,
    external_mutations: false,
    created_at: now.toISOString(),
    marketplace_observed_at: source.marketplace_observed_at ?? null,
    source_snapshot: {
      path: sourcePath,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      schema_version: source.schema_version ?? null,
      audit_id: source.audit_id ?? null,
    },
    scope: { network_calls: 0, database_calls: 0 },
    summary: {
      rows_in_source: source.rows.length,
      checked: checked.length,
      passed: checked.length - failed.length,
      failed: failed.length,
      skipped: skipped.length,
      format_failures: failed.filter((row) => (row.failures as Array<{ type: string }>).some((failure) => failure.type === "FORMAT")).length,
      semantic_failures: failed.filter((row) => (row.failures as Array<{ type: string }>).some((failure) => failure.type === "SEMANTIC")).length,
      claim_failures: failed.filter((row) => (row.failures as Array<{ type: string }>).some((failure) => failure.type === "CLAIMS")).length,
    },
    failed_rows: failed,
    skipped_rows: skipped,
    rows: checked,
  };
  const handle = await open(output, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  console.log(`Offline immutable content audit: ${output}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
