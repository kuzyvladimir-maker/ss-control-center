/**
 * Re-run ledger normalization and anomaly classification from an immutable
 * snapshot without touching Prisma, Amazon, or any other external system.
 *
 * The live snapshot retains raw Amazon attributes/offers, so parser fixes can
 * be applied offline without spending SP-API quota or changing the observation
 * timestamp.
 *
 *   npx tsx scripts/resummarize-uncrustables-ledger.ts \
 *     --input=data/audits/uncrustables-ledger-...-live.json
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import {
  addCatalogAnomalies,
  assessLedgerRow,
  extractLiveListing,
  summarizeLedger,
  type LedgerRow,
  type LiveListingSnapshot,
} from "@/lib/bundle-factory/audit/uncrustables-ledger";

interface SourceSnapshot {
  schema_version?: string;
  audit_id?: string;
  mode?: string;
  started_at?: string;
  completed_at?: string;
  complete?: boolean;
  source_of_truth?: unknown;
  scope?: Record<string, unknown>;
  expectations?: unknown;
  summary?: unknown;
  rows?: LedgerRow[];
}

function parseArgs(argv: string[]): { input: string; outputDir: string } {
  let input = "";
  let outputDir = "data/audits";
  for (const arg of argv) {
    if (arg.startsWith("--input=")) input = arg.slice("--input=".length).trim();
    else if (arg.startsWith("--output-dir=")) {
      outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/resummarize-uncrustables-ledger.ts --input=SNAPSHOT [--output-dir=data/audits]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input=SNAPSHOT is required");
  if (!outputDir) throw new Error("--output-dir cannot be empty");
  return { input, outputDir };
}

function filenameTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function reconstructedRawListing(live: LiveListingSnapshot): Record<string, unknown> {
  const topLevelAvailability = live.fulfillment_availability
    .filter((value) => value.source === "top_level")
    .map((value) => ({
      fulfillmentChannelCode: value.fulfillment_channel_code,
      quantity: value.quantity,
    }));
  return {
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID,
        asin: live.asin,
        productType: live.product_type,
        status: live.amazon_statuses,
        itemName: live.title,
        mainImage: live.main_image_url ? { link: live.main_image_url } : undefined,
      },
    ],
    attributes: live.raw_attributes,
    offers: live.raw_offers,
    fulfillmentAvailability: topLevelAvailability,
    issues: live.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      attributeNames: issue.attribute_names,
      categories: issue.categories,
    })),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.input);
  const sourceBytes = await readFile(sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8")) as SourceSnapshot;
  if (!Array.isArray(source.rows)) {
    throw new Error(`${sourcePath} has no ledger rows array`);
  }
  if (!source.rows.every((row) => row?.db?.channel_sku?.sku)) {
    throw new Error(`${sourcePath} contains an incompatible ledger row`);
  }

  const observedAt = new Date(source.started_at ?? source.completed_at ?? 0);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error(`${sourcePath} has no valid observation timestamp`);
  }

  const reassessed = source.rows.map((row) => {
    const live = row.live?.fetched
      ? extractLiveListing(reconstructedRawListing(row.live), observedAt)
      : row.live;
    return assessLedgerRow(row.db, live);
  });
  const rows = addCatalogAnomalies(reassessed);
  const now = new Date();
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const output = path.join(
    outputDir,
    `uncrustables-ledger-${filenameTimestamp(now)}-offline.json`,
  );
  const payload = {
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: `ULR-${filenameTimestamp(now)}`,
    mode: "offline-resummarize",
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    marketplace_observed_at: observedAt.toISOString(),
    complete: source.complete ?? true,
    immutable: true,
    external_mutations: false,
    source_snapshot: {
      path: sourcePath,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      schema_version: source.schema_version ?? null,
      audit_id: source.audit_id ?? null,
      mode: source.mode ?? null,
    },
    source_of_truth: source.source_of_truth ?? null,
    scope: {
      ...(source.scope ?? {}),
      resummarized_rows: rows.length,
      network_calls: 0,
      database_calls: 0,
    },
    expectations: source.expectations ?? null,
    previous_summary: source.summary ?? null,
    summary: summarizeLedger(rows),
    rows,
  };
  const handle = await open(output, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  console.log(`Offline immutable snapshot: ${output}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

