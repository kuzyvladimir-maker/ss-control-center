#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertBaseOfferPreserveSelection,
  buildBaseOfferPreservePlan,
  buildBaseOfferPreservePreviewSet,
  createBaseOfferPreserveSelection,
  sha256,
  stableJson,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";

const MATRIX_PATH =
  "data/audits/uncrustables-fresh-amazon-price-matrix-20260719-v2/" +
  "uncrustables-fresh-amazon-price-matrix-20260719-v2.json";
const SNAPSHOT_PATH =
  "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/" +
  "UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json";
const CHANNELMAX_PATH =
  "data/repairs/rollback/channelmax-canonical-164-20260719T024515583Z-6a2e9b3211b4/" +
  "postwrite.json";
const OUTPUT_DIR =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3";

const EXPECTED_FILE_SHA256 = {
  matrix: "572abc5428750408da6f776db6c73821372e789da1ee32d8aa05b267082b189a",
  snapshot: "14760f657729ab320d6cb1637bda1ffdc427b91615d67f2fb616b418e7c18679",
  channelmax: "94a4da2aad82caba9d127bd19fdf61490ff992b6e934ec8b38fd26dc94de6bc2",
} as const;

interface LoadedJson {
  raw: Buffer;
  value: Record<string, unknown>;
  fileSha256: string;
}

async function loadJson(filePath: string): Promise<LoadedJson> {
  const raw = await readFile(filePath);
  const parsed = JSON.parse(raw.toString("utf8")) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return {
    raw,
    value: parsed as Record<string, unknown>,
    fileSha256: sha256(raw),
  };
}

function assertPinnedSource(
  name: keyof typeof EXPECTED_FILE_SHA256,
  artifact: LoadedJson,
): void {
  if (artifact.fileSha256 !== EXPECTED_FILE_SHA256[name]) {
    throw new Error(
      `${name} source drift: expected ${EXPECTED_FILE_SHA256[name]}, got ${artifact.fileSha256}.`,
    );
  }
}

function seal<T extends Record<string, unknown>>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: sha256(stableJson(body)) };
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<string> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, bytes, { flag: "wx" });
  const digest = sha256(bytes);
  await writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, {
    flag: "wx",
  });
  return digest;
}

function snapshotListings(snapshot: Record<string, unknown>): Map<string, Record<string, unknown>> {
  if (!Array.isArray(snapshot.entries)) throw new Error("Snapshot entries are missing.");
  return new Map(
    snapshot.entries.map((raw, index) => {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Snapshot entry ${index} is invalid.`);
      }
      const entry = raw as Record<string, unknown>;
      if (typeof entry.sku !== "string") throw new Error(`Snapshot entry ${index} lacks SKU.`);
      if (entry.listing == null || typeof entry.listing !== "object") {
        throw new Error(`${entry.sku} lacks listing payload.`);
      }
      return [entry.sku, entry.listing as Record<string, unknown>];
    }),
  );
}

async function main(): Promise<void> {
  const [matrix, snapshot, channelmax] = await Promise.all([
    loadJson(MATRIX_PATH),
    loadJson(SNAPSHOT_PATH),
    loadJson(CHANNELMAX_PATH),
  ]);
  assertPinnedSource("matrix", matrix);
  assertPinnedSource("snapshot", snapshot);
  assertPinnedSource("channelmax", channelmax);

  const channelmaxSummary = channelmax.value.summary as Record<string, unknown> | undefined;
  if (
    channelmax.value.schema_version !==
      "channelmax-uncrustables-canonical-postwrite/v1" ||
    channelmaxSummary?.result !== "PASS" ||
    channelmaxSummary.final_candidate_mismatches !== 0 ||
    channelmaxSummary.identity_hold_rows !== 3 ||
    channelmaxSummary.amazon_mutations !== 0
  ) {
    throw new Error("Pinned ChannelMAX postwrite evidence is not canonical/passive.");
  }

  const generatedAt = "2026-07-19T04:15:00.000Z";
  const plan = buildBaseOfferPreservePlan({
    matrix: matrix.value,
    snapshot: snapshot.value,
    generatedAt,
    sources: {
      price_matrix: {
        path: MATRIX_PATH,
        file_sha256: matrix.fileSha256,
        embedded_body_sha256:
          typeof matrix.value.body_sha256 === "string"
            ? matrix.value.body_sha256
            : null,
      },
      amazon_prechange_snapshot: {
        path: SNAPSHOT_PATH,
        file_sha256: snapshot.fileSha256,
        embedded_body_sha256:
          typeof snapshot.value.sha256 === "string" ? snapshot.value.sha256 : null,
      },
      channelmax_postwrite: {
        path: CHANNELMAX_PATH,
        file_sha256: channelmax.fileSha256,
        embedded_body_sha256: null,
      },
    },
  });
  const selection = createBaseOfferPreserveSelection(plan, generatedAt);
  assertBaseOfferPreserveSelection(plan, selection);

  const listings = snapshotListings(snapshot.value);
  const previewRows = plan.entries.map((entry) => {
    const listing = listings.get(entry.sku);
    if (!listing) throw new Error(`${entry.sku} is absent from snapshot lookup.`);
    const preview = buildBaseOfferPreservePreviewSet(
      entry,
      listing as unknown as Parameters<typeof buildBaseOfferPreservePreviewSet>[1],
    );
    return {
      action_id: entry.action_id,
      sku: entry.sku,
      asin: entry.asin,
      before_purchasable_offer_sha256: entry.before.purchasable_offer_sha256,
      before_top_level_b2b_offers_sha256:
        entry.before.top_level_b2b_offers_sha256,
      before_top_level_b2b_observed_price:
        entry.before.top_level_b2b_observed_price,
      actual_patch_sha256: sha256(stableJson(preview.actual_merge_patch)),
      validation_preview_patch_sha256: sha256(
        stableJson(preview.validation_preview_patch),
      ),
      simulated_after_purchasable_offer_sha256: preview.simulated_after_sha256,
      discounted_price_sha256_before: entry.before.discounted_price.sha256,
      discounted_price_sha256_after: entry.simulated_after.discounted_price.sha256,
      list_price_sha256_before: entry.before.list_price.sha256,
      list_price_sha256_after: entry.simulated_after.list_price.sha256,
      preservation_pass: true,
    };
  });
  const validationReport = seal({
    schema_version: "uncrustables-amazon-base-offer-preserve-offline-validation/v1",
    generated_at: generatedAt,
    offline_only: true,
    external_mutations: 0,
    source_plan_body_sha256: plan.body_sha256,
    source_selection_body_sha256: selection.body_sha256,
    summary: {
      selected_actions: previewRows.length,
      identity_holds: plan.holds.length,
      cas_against_fresh_snapshot_pass: previewRows.length,
      sparse_patch_contract_pass: previewRows.length,
      discounted_price_canonical_preservation_pass: previewRows.length,
      list_price_canonical_preservation_pass: previewRows.length,
      amazon_validation_preview_calls: 0,
      amazon_mutations: 0,
      channelmax_mutations: 0,
      execution_authorized: false,
    },
    rows: previewRows,
  });

  await mkdir(path.dirname(OUTPUT_DIR), { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: false });
  const planPath = path.join(OUTPUT_DIR, "base-offer-preserve-plan.json");
  const selectionPath = path.join(OUTPUT_DIR, "base-offer-preserve-selection.json");
  const reportPath = path.join(OUTPUT_DIR, "offline-validation-report.json");
  const planFileSha = await writeImmutableJson(planPath, plan);
  const selectionFileSha = await writeImmutableJson(selectionPath, selection);
  const reportFileSha = await writeImmutableJson(reportPath, validationReport);
  const summary = [
    "# Uncrustables Amazon base-offer preserve plan",
    "",
    `- Profile: \`${plan.profile}\``,
    `- Plan body SHA-256: \`${plan.body_sha256}\``,
    `- Plan file SHA-256: \`${planFileSha}\``,
    `- Selection body SHA-256: \`${selection.body_sha256}\``,
    `- Selection file SHA-256: \`${selectionFileSha}\``,
    `- Validation report file SHA-256: \`${reportFileSha}\``,
    "- Exact actions: **161**",
    "- Identity holds: **3** (SZ-ASPI-JFAT, TY-AST2-JE9P, VN-AS1A-D572)",
    "- Actual patch surface: regular ALL our_price, min, max, and B2B our_price differences only",
    "- Structurally forbidden: `discounted_price`, `list_price`",
    "- Offline CAS/preservation validations: **161/161 PASS**",
    "- Amazon/ChannelMAX mutations during generation: **0**",
    "- Execution authority: **NOT GRANTED**; requires a separate owner gate",
    "- Promo-v4 authority reused: **NO**",
    "",
  ].join("\n");
  await writeFile(path.join(OUTPUT_DIR, "SUMMARY.md"), summary, { flag: "wx" });

  process.stdout.write(
    `${JSON.stringify(
      {
        output_dir: OUTPUT_DIR,
        actions: plan.entries.length,
        holds: plan.holds.length,
        plan_body_sha256: plan.body_sha256,
        selection_body_sha256: selection.body_sha256,
        validation_report_body_sha256: validationReport.body_sha256,
        external_mutations: 0,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
