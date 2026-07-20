#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const MATRIX_RELATIVE =
  "data/audits/uncrustables-owner-relaxed-main-repair-matrix-20260719-v1/" +
  "uncrustables-owner-relaxed-main-repair-matrix-20260719-v1.json";
const GENERATED_RELATIVE =
  "data/audits/uncrustables-owner-relaxed-main-generated-20260719-v1";
const OUTPUT_RELATIVE =
  "data/audits/uncrustables-owner-relaxed-main-publication-manifest-20260719-v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAsset(relativePath, expectedSha256 = null) {
  const absolutePath = resolve(ROOT, relativePath);
  if (!absolutePath.startsWith(`${ROOT}/`) || !existsSync(absolutePath)) {
    throw new Error(`Missing or unsafe asset: ${relativePath}`);
  }
  const bytes = readFileSync(absolutePath);
  const actualSha256 = sha256(bytes);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${relativePath}: ${actualSha256} != ${expectedSha256}`,
    );
  }
  return {
    relative_path: relative(ROOT, absolutePath),
    sha256: actualSha256,
    byte_size: statSync(absolutePath).size,
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const matrix = JSON.parse(readFileSync(resolve(ROOT, MATRIX_RELATIVE), "utf8"));
if (!Array.isArray(matrix.rows) || matrix.rows.length !== 24) {
  throw new Error(`Expected exactly 24 MAIN repair rows, received ${matrix.rows?.length}`);
}

const rows = matrix.rows
  .map((row) => {
    const rollback = readAsset(row.current_main.relative_path, row.current_main.sha256);
    const decision = row.repair_decision;
    let publicationAsset;
    let sourceType;
    let sourceOrdinal = null;
    let sourceSku = null;
    let generationGroup = null;

    if (decision.action === "DIRECT_REUSE_EXISTING_OWNER_KEEP_MAIN") {
      const reuse = decision.direct_reuse;
      if (!reuse?.asset?.relative_path || !reuse.asset.sha256) {
        throw new Error(`Missing direct-reuse asset for ordinal ${row.ordinal}`);
      }
      publicationAsset = readAsset(reuse.asset.relative_path, reuse.asset.sha256);
      sourceType = "OWNER_KEEP_EXACT_RECIPE_REUSE";
      sourceOrdinal = reuse.source_ordinal;
      sourceSku = reuse.source_sku;
    } else if (decision.gpt_image_2_required === true) {
      generationGroup = decision.generation_group;
      if (!generationGroup) {
        throw new Error(`Missing generation group for ordinal ${row.ordinal}`);
      }
      const relativePath = join(GENERATED_RELATIVE, `${generationGroup}.png`);
      publicationAsset = readAsset(relativePath);
      sourceType = "GPT_IMAGE_2_OWNER_RELAXED_QA_PASS";
    } else {
      throw new Error(`Unsupported repair action for ordinal ${row.ordinal}`);
    }

    return {
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      title: row.title,
      exact_recipe_signature: row.normalized_exact_variant_recipe_signature,
      presentation_class: row.presentation_class,
      owner_change_reason_code: row.owner_change_reason_code,
      publication_action: "REPLACE_MAIN_ONLY",
      publication_asset_source: sourceType,
      generation_group: generationGroup,
      source_ordinal: sourceOrdinal,
      source_sku: sourceSku,
      publication_asset: publicationAsset,
      rollback_main: rollback,
      qa_status: "PASS_OWNER_RELAXED",
      qa_policy:
        "Exact real product identity is mandatory; minor visible-count, occlusion, gel-pack and composition variance is accepted.",
    };
  })
  .sort((a, b) => a.ordinal - b.ordinal);

const gptRows = rows.filter(
  (row) => row.publication_asset_source === "GPT_IMAGE_2_OWNER_RELAXED_QA_PASS",
);
const reuseRows = rows.filter(
  (row) => row.publication_asset_source === "OWNER_KEEP_EXACT_RECIPE_REUSE",
);
const uniqueGeneratedAssets = new Set(gptRows.map((row) => row.publication_asset.sha256));
const uniquePublicationAssets = new Set(rows.map((row) => row.publication_asset.sha256));
const expectedOrdinals = [
  4, 15, 21, 29, 40, 59, 65, 67, 80, 84, 94, 96, 110, 113, 115, 116,
  123, 127, 134, 135, 138, 142, 146, 163,
];
const actualOrdinals = rows.map((row) => row.ordinal);

if (JSON.stringify(actualOrdinals) !== JSON.stringify(expectedOrdinals)) {
  throw new Error(`Unexpected repair ordinals: ${actualOrdinals.join(",")}`);
}
if (
  gptRows.length !== 21 ||
  reuseRows.length !== 3 ||
  uniqueGeneratedAssets.size !== 20 ||
  uniquePublicationAssets.size !== 23
) {
  throw new Error(
    `Coverage mismatch: gpt=${gptRows.length}, reuse=${reuseRows.length}, ` +
      `uniqueGenerated=${uniqueGeneratedAssets.size}, uniqueAll=${uniquePublicationAssets.size}`,
  );
}

const manifest = {
  schema_version: "uncrustables-owner-relaxed-main-publication-manifest/v1",
  generated_at: new Date().toISOString(),
  marketplace: "Amazon.com",
  cohort_rows: 164,
  owner_policy: {
    keep_existing_main_rows: 140,
    replace_main_rows: 24,
    reject_only_for:
      "fictional/nonexistent packaging, wrong or missing required product/flavor, or an obviously unusable MAIN",
    explicitly_non_blocking:
      "visible package count, minor small-label text, gel-pack placement, occlusion and composition variance",
  },
  summary: {
    rows_ready: rows.length,
    gpt_image_2_rows: gptRows.length,
    direct_reuse_rows: reuseRows.length,
    unique_gpt_image_2_assets: uniqueGeneratedAssets.size,
    unique_publication_assets: uniquePublicationAssets.size,
    rollback_assets_verified: rows.length,
    missing_assets: 0,
    sha256_mismatches: 0,
    external_mutations: 0,
  },
  source_matrix: {
    relative_path: MATRIX_RELATIVE,
    sha256: sha256(readFileSync(resolve(ROOT, MATRIX_RELATIVE))),
  },
  publication_status: "READY_LOCAL_NOT_PUBLISHED",
  rows,
};

const outputDir = resolve(ROOT, OUTPUT_RELATIVE);
mkdirSync(outputDir, { recursive: true });
const jsonPath = join(
  outputDir,
  "uncrustables-owner-relaxed-main-publication-manifest-20260719-v1.json",
);
const csvPath = join(
  outputDir,
  "uncrustables-owner-relaxed-main-publication-manifest-20260719-v1.csv",
);
const jsonBody = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(jsonPath, jsonBody);

const csvColumns = [
  "ordinal",
  "sku",
  "asin",
  "exact_recipe_signature",
  "presentation_class",
  "publication_action",
  "publication_asset_source",
  "generation_group",
  "source_ordinal",
  "source_sku",
  "publication_asset_path",
  "publication_asset_sha256",
  "rollback_main_path",
  "rollback_main_sha256",
  "qa_status",
];
const csvRows = rows.map((row) => [
  row.ordinal,
  row.sku,
  row.asin,
  row.exact_recipe_signature,
  row.presentation_class,
  row.publication_action,
  row.publication_asset_source,
  row.generation_group,
  row.source_ordinal,
  row.source_sku,
  row.publication_asset.relative_path,
  row.publication_asset.sha256,
  row.rollback_main.relative_path,
  row.rollback_main.sha256,
  row.qa_status,
]);
const csvBody = [
  csvColumns.map(csvCell).join(","),
  ...csvRows.map((values) => values.map(csvCell).join(",")),
].join("\n") + "\n";
writeFileSync(csvPath, csvBody);

console.log(
  JSON.stringify(
    {
      ok: true,
      json: relative(ROOT, jsonPath),
      json_sha256: sha256(Buffer.from(jsonBody)),
      csv: relative(ROOT, csvPath),
      csv_sha256: sha256(Buffer.from(csvBody)),
      summary: manifest.summary,
    },
    null,
    2,
  ),
);
