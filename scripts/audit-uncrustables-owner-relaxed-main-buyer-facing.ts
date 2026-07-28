/**
 * Compare the sealed owner-approved MAIN repair assets with the buyer-facing
 * Amazon summary image captured immediately before a live wave.
 *
 * This is a read-only image audit. It never calls Listings PATCH, writes R2,
 * or changes the database. Remote image GETs are performed only by the
 * allow-listed PerceptualMediaEquivalence implementation.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PerceptualMediaEquivalence } from
  "@/lib/bundle-factory/repair/media-equivalence";
import { stableJson } from
  "@/lib/bundle-factory/repair/uncrustables-surgical";

const MARKETPLACE_ID = "ATVPDKIKX0DER";

interface Options {
  planPath: string;
  snapshotPath: string;
  outputPath: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  const planPath = values.get("plan");
  const snapshotPath = values.get("snapshot");
  const outputPath = values.get("output");
  if (!planPath || !snapshotPath || !outputPath) {
    throw new Error("Required: --plan=PATH --snapshot=PATH --output=PATH");
  }
  return { planPath, snapshotPath, outputPath };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function marketplaceSummaryMain(listing: Record<string, unknown>): string | null {
  const summaries = Array.isArray(listing.summaries) ? listing.summaries : [];
  for (const value of summaries) {
    const summary = object(value);
    if (summary?.marketplaceId !== MARKETPLACE_ID) continue;
    const mainImage = object(summary.mainImage);
    if (typeof mainImage?.link === "string" && mainImage.link.length > 0) {
      return mainImage.link;
    }
  }
  return null;
}

function marketplaceAttributeMain(listing: Record<string, unknown>): string | null {
  const attributes = object(listing.attributes);
  const values = Array.isArray(attributes?.main_product_image_locator)
    ? attributes.main_product_image_locator
    : [];
  for (const value of values) {
    const row = object(value);
    if (
      row?.marketplace_id === MARKETPLACE_ID &&
      typeof row.media_location === "string" &&
      row.media_location.length > 0
    ) {
      return row.media_location;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [planBytes, snapshotBytes] = await Promise.all([
    readFile(options.planPath),
    readFile(options.snapshotPath),
  ]);
  const plan = JSON.parse(planBytes.toString("utf8")) as {
    sha256: string;
    entries: Array<{
      ordinal: number;
      sku: string;
      asin: string;
      actions: Array<{
        action_id: string;
        kind: string;
        desired?: { value?: { main_image_url?: string } };
      }>;
    }>;
  };
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as {
    sha256: string;
    completed_at: string;
    entries: Array<{ sku: string; asin: string; listing: Record<string, unknown> }>;
  };
  const snapshotBySku = new Map(snapshot.entries.map((row) => [row.sku, row]));
  const candidates = plan.entries.flatMap((entry) =>
    entry.actions
      .filter((action) => action.kind === "MEDIA")
      .map((action) => {
        const desired = action.desired?.value?.main_image_url;
        if (!desired) throw new Error(`Missing desired MAIN for ${action.action_id}`);
        const captured = snapshotBySku.get(entry.sku);
        if (!captured || captured.asin !== entry.asin) {
          throw new Error(`Snapshot identity mismatch for ${entry.sku}`);
        }
        return {
          ordinal: entry.ordinal,
          sku: entry.sku,
          asin: entry.asin,
          action_id: action.action_id,
          desired_main_url: desired,
          buyer_summary_main_url: marketplaceSummaryMain(captured.listing),
          seller_attribute_main_url: marketplaceAttributeMain(captured.listing),
        };
      }),
  );
  const equivalence = new PerceptualMediaEquivalence();
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    rows.push(...await Promise.all(batch.map(async (candidate) => {
      let buyerEquivalent: boolean | null = null;
      let sellerEquivalent: boolean | null = null;
      let error: string | null = null;
      try {
        if (candidate.buyer_summary_main_url) {
          buyerEquivalent = await equivalence.equivalent(
            candidate.desired_main_url,
            candidate.buyer_summary_main_url,
          );
        }
        if (candidate.seller_attribute_main_url) {
          sellerEquivalent = await equivalence.equivalent(
            candidate.desired_main_url,
            candidate.seller_attribute_main_url,
          );
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const disposition = error || buyerEquivalent == null
        ? "HOLD_EVIDENCE"
        : buyerEquivalent
          ? "KEEP_BUYER_MAIN_ALREADY_EQUIVALENT"
          : "PATCH_BUYER_MAIN_NOT_EQUIVALENT";
      return {
        ...candidate,
        buyer_summary_equivalent_to_desired: buyerEquivalent,
        seller_attribute_equivalent_to_desired: sellerEquivalent,
        disposition,
        error,
      };
    })));
  }
  rows.sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
  const body = {
    schema_version: "uncrustables-owner-relaxed-main-buyer-facing-audit/v1",
    immutable: true,
    generated_at: new Date().toISOString(),
    marketplace_id: MARKETPLACE_ID,
    source_plan: {
      path: options.planPath,
      file_sha256: sha256(planBytes),
      body_sha256: plan.sha256,
    },
    source_snapshot: {
      path: options.snapshotPath,
      file_sha256: sha256(snapshotBytes),
      body_sha256: snapshot.sha256,
      completed_at: snapshot.completed_at,
    },
    policy: {
      authority: "BUYER_FACING_SUMMARY_MAIN_OVER_SELLER_ATTRIBUTE_LOCATOR",
      equivalence: "PERCEPTUAL_CROSS_HOST_MAE_MAX_6_5",
      suitable_current_images_are_not_replaced: true,
      amazon_writes: false,
      database_writes: false,
      r2_writes: false,
    },
    summary: {
      rows: rows.length,
      keep: rows.filter((row) =>
        row.disposition === "KEEP_BUYER_MAIN_ALREADY_EQUIVALENT"
      ).length,
      patch: rows.filter((row) =>
        row.disposition === "PATCH_BUYER_MAIN_NOT_EQUIVALENT"
      ).length,
      hold: rows.filter((row) => row.disposition === "HOLD_EVIDENCE").length,
    },
    rows,
    external_mutations: {
      amazon_writes: 0,
      database_writes: 0,
      r2_writes: 0,
    },
  };
  const report = { ...body, body_sha256: sha256(stableJson(body)) };
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({
    output: options.outputPath,
    body_sha256: report.body_sha256,
    summary: report.summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
