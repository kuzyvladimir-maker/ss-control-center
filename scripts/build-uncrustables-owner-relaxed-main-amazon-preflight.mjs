#!/usr/bin/env node

/**
 * Build the exact, offline Amazon MAIN-image repair inputs for the 24
 * owner-approved Uncrustables exceptions.
 *
 * This script performs local integrity checks only. It does not contact
 * Amazon, R2, a database, or any other external service.
 *
 * Usage:
 *   node scripts/build-uncrustables-owner-relaxed-main-amazon-preflight.mjs
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PUBLICATION_SCHEMA =
  "uncrustables-owner-relaxed-main-publication-manifest/v1";
const R2_STAGING_SCHEMA =
  "uncrustables-owner-relaxed-main-r2-staging/v1";
const DESIRED_SCHEMA = "uncrustables-surgical-desired/v1";
const PREFLIGHT_SCHEMA =
  "uncrustables-owner-relaxed-main-amazon-preflight/v1";
const MARKETPLACE_ID = "ATVPDKIKX0DER";

const DEFAULT_PUBLICATION_MANIFEST =
  "data/audits/uncrustables-owner-relaxed-main-publication-manifest-20260719-v1/uncrustables-owner-relaxed-main-publication-manifest-20260719-v1.json";
const DEFAULT_R2_STAGING =
  "data/audits/uncrustables-owner-relaxed-main-r2-staging-20260719-v1/uncrustables-owner-relaxed-main-r2-staging-20260719-v1.json";
const DEFAULT_LEDGER =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const DEFAULT_OUTPUT_DIR =
  "data/repairs/preflight/uncrustables-owner-relaxed-main-24-20260719-v1";

function parseArgs(argv) {
  const options = {
    publicationManifest: DEFAULT_PUBLICATION_MANIFEST,
    r2Staging: DEFAULT_R2_STAGING,
    ledger: DEFAULT_LEDGER,
    outputDir: DEFAULT_OUTPUT_DIR,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/build-uncrustables-owner-relaxed-main-amazon-preflight.mjs [options]",
          "",
          `  --publication-manifest=PATH  (default ${DEFAULT_PUBLICATION_MANIFEST})`,
          `  --r2-staging=PATH            (default ${DEFAULT_R2_STAGING})`,
          `  --ledger=PATH                (default ${DEFAULT_LEDGER})`,
          `  --output-dir=PATH            (default ${DEFAULT_OUTPUT_DIR})`,
          "",
          "Local reads/writes only; zero Amazon calls and zero external mutations.",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg.startsWith("--publication-manifest=")) {
      options.publicationManifest = arg.slice(
        "--publication-manifest=".length,
      );
    } else if (arg.startsWith("--r2-staging=")) {
      options.r2Staging = arg.slice("--r2-staging=".length);
    } else if (arg.startsWith("--ledger=")) {
      options.ledger = arg.slice("--ledger=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const [name, value] of Object.entries(options)) {
    if (!value.trim()) throw new Error(`${name} cannot be empty.`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeHttps(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an absolute URL.`);
  }
  assert(
    parsed.protocol === "https:" &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password,
    `${label} is not a safe public HTTPS URL.`,
  );
  return parsed;
}

async function readJsonWithBytes(file) {
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function writeImmutableJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(file, bytes, { flag: "wx" });
  const digest = sha256(bytes);
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, {
    flag: "wx",
  });
  return { path: file, sha256: digest, bytes: bytes.length };
}

function currentMainLocator(ledgerRow) {
  const values = ledgerRow?.live?.raw_attributes?.main_product_image_locator;
  if (!Array.isArray(values) || values.length !== 1) return null;
  const value = values[0];
  return typeof value?.media_location === "string"
    ? value.media_location.trim()
    : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const publicationPath = path.resolve(options.publicationManifest);
  const r2Path = path.resolve(options.r2Staging);
  const ledgerPath = path.resolve(options.ledger);
  const outputDir = path.resolve(options.outputDir);

  try {
    await access(outputDir);
    throw new Error(`Output directory already exists: ${outputDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const [publicationSource, r2Source, ledgerSource] = await Promise.all([
    readJsonWithBytes(publicationPath),
    readJsonWithBytes(r2Path),
    readJsonWithBytes(ledgerPath),
  ]);
  const publication = publicationSource.value;
  const staging = r2Source.value;
  const ledger = ledgerSource.value;
  const publicationSha = sha256(publicationSource.bytes);
  const r2Sha = sha256(r2Source.bytes);
  const ledgerSha = sha256(ledgerSource.bytes);

  assert(
    publication.schema_version === PUBLICATION_SCHEMA,
    `Unsupported publication schema: ${publication.schema_version}`,
  );
  assert(
    staging.schema_version === R2_STAGING_SCHEMA,
    `Unsupported R2 staging schema: ${staging.schema_version}`,
  );
  assert(
    publication.publication_status === "READY_LOCAL_NOT_PUBLISHED",
    "Publication manifest is not in READY_LOCAL_NOT_PUBLISHED state.",
  );
  assert(
    staging.status === "R2_VERIFIED_NOT_AMAZON_PUBLISHED",
    "R2 staging is not in R2_VERIFIED_NOT_AMAZON_PUBLISHED state.",
  );
  assert(
    staging.source_manifest?.sha256 === publicationSha,
    "R2 staging is not bound to the exact publication-manifest bytes.",
  );
  assert(
    publication.summary?.rows_ready === 24 &&
      publication.summary?.missing_assets === 0 &&
      publication.summary?.sha256_mismatches === 0 &&
      publication.summary?.external_mutations === 0,
    "Publication manifest does not prove the exact complete 24-row local cohort.",
  );
  assert(
    staging.summary?.rows === 24 &&
      staging.summary?.unique_assets === 23 &&
      staging.summary?.amazon_mutations === 0,
    "R2 staging does not prove the exact 24-row/23-asset no-Amazon cohort.",
  );
  assert(
    Array.isArray(publication.rows) && publication.rows.length === 24,
    "Publication manifest must contain exactly 24 rows.",
  );
  assert(
    Array.isArray(staging.rows) && staging.rows.length === 24,
    "R2 staging must contain exactly 24 rows.",
  );
  assert(
    ledger.complete === true &&
      ledger.immutable === true &&
      ledger.external_mutations === false &&
      Array.isArray(ledger.rows) &&
      ledger.rows.length >= 24 &&
      (ledger.mode === "live" || ledger.mode === "offline-resummarize"),
    "Source ledger must be a complete immutable live-derived no-mutation ledger.",
  );

  const publicationBySku = new Map();
  for (const row of publication.rows) {
    assert(!publicationBySku.has(row.sku), `Duplicate publication SKU ${row.sku}.`);
    publicationBySku.set(row.sku, row);
  }
  const stagingBySku = new Map();
  for (const row of staging.rows) {
    assert(!stagingBySku.has(row.sku), `Duplicate staging SKU ${row.sku}.`);
    stagingBySku.set(row.sku, row);
  }
  const ledgerBySku = new Map();
  for (const row of ledger.rows) {
    assert(!ledgerBySku.has(row.sku), `Duplicate ledger SKU ${row.sku}.`);
    ledgerBySku.set(row.sku, row);
  }

  const patchRows = [];
  for (const publicationRow of [...publication.rows].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const staged = stagingBySku.get(publicationRow.sku);
    const ledgerRow = ledgerBySku.get(publicationRow.sku);
    assert(staged, `Staging row missing for ${publicationRow.sku}.`);
    assert(ledgerRow, `Ledger row missing for ${publicationRow.sku}.`);
    assert(
      publicationRow.publication_action === "REPLACE_MAIN_ONLY" &&
        publicationRow.qa_status === "PASS_OWNER_RELAXED",
      `Publication row ${publicationRow.sku} is not owner-approved MAIN-only.`,
    );
    assert(
      staged.amazon_status === "NOT_PUBLISHED",
      `Staging row ${publicationRow.sku} is not in NOT_PUBLISHED state.`,
    );
    assert(
      staged.ordinal === publicationRow.ordinal &&
        staged.asin === publicationRow.asin &&
        staged.exact_recipe_signature ===
          publicationRow.exact_recipe_signature,
      `Publication/R2 identity mismatch for ${publicationRow.sku}.`,
    );
    assert(
      ledgerRow.asin === publicationRow.asin &&
        ledgerRow.store_index === 1 &&
        ledgerRow.live?.fetched === true &&
        typeof ledgerRow.live?.product_type === "string" &&
        ledgerRow.live.product_type.trim(),
      `Ledger identity/live evidence is incomplete for ${publicationRow.sku}.`,
    );
    assert(
      staged.main_sha256 === publicationRow.publication_asset?.sha256 &&
        isSha256(staged.main_sha256),
      `Desired MAIN SHA mismatch for ${publicationRow.sku}.`,
    );
    assert(
      stableJson(staged.rollback_main) ===
        stableJson(publicationRow.rollback_main) &&
        isSha256(staged.rollback_main?.sha256),
      `Rollback evidence mismatch for ${publicationRow.sku}.`,
    );
    safeHttps(staged.main_r2_url, `${publicationRow.sku} R2 MAIN`);
    assert(
      new URL(staged.main_r2_url).hostname.endsWith(".r2.dev"),
      `${publicationRow.sku} MAIN is not a versioned R2 locator.`,
    );
    assert(
      staged.main_r2_url.includes(staged.main_sha256),
      `${publicationRow.sku} R2 key is not content-addressed by its MAIN SHA.`,
    );

    const desiredLocalPath = path.resolve(
      path.dirname(publicationPath),
      "../../../",
      publicationRow.publication_asset.relative_path,
    );
    const rollbackLocalPath = path.resolve(
      path.dirname(publicationPath),
      "../../../",
      publicationRow.rollback_main.relative_path,
    );
    const [desiredBytes, rollbackBytes] = await Promise.all([
      readFile(desiredLocalPath),
      readFile(rollbackLocalPath),
    ]);
    assert(
      sha256(desiredBytes) === staged.main_sha256 &&
        desiredBytes.length === publicationRow.publication_asset.byte_size,
      `Desired local asset bytes changed for ${publicationRow.sku}.`,
    );
    assert(
      sha256(rollbackBytes) === staged.rollback_main.sha256 &&
        rollbackBytes.length === staged.rollback_main.byte_size,
      `Rollback local asset bytes changed for ${publicationRow.sku}.`,
    );

    const currentMain = currentMainLocator(ledgerRow);
    assert(currentMain, `Ledger MAIN locator missing for ${publicationRow.sku}.`);
    safeHttps(currentMain, `${publicationRow.sku} current Amazon MAIN`);
    assert(
      currentMain !== staged.main_r2_url,
      `${publicationRow.sku} already has the desired R2 MAIN in the sealed ledger.`,
    );

    patchRows.push({
      ordinal: publicationRow.ordinal,
      sku: publicationRow.sku,
      asin: publicationRow.asin,
      store_index: ledgerRow.store_index,
      audited_product_type: ledgerRow.live.product_type,
      exact_recipe_signature: publicationRow.exact_recipe_signature,
      owner_change_reason_code: publicationRow.owner_change_reason_code,
      current_main_locator: currentMain,
      desired_main: {
        url: staged.main_r2_url,
        sha256: staged.main_sha256,
        local_asset_relative_path:
          publicationRow.publication_asset.relative_path,
      },
      rollback_main: staged.rollback_main,
      action_id: `${publicationRow.sku}:media`,
      intended_patch: [
        {
          op: "replace",
          path: "/attributes/main_product_image_locator",
          value: [
            {
              media_location: staged.main_r2_url,
              language_tag: "en_US",
              marketplace_id: MARKETPLACE_ID,
            },
          ],
        },
      ],
    });
  }

  assert(
    patchRows.length === 24 &&
      new Set(patchRows.map((row) => row.sku)).size === 24 &&
      new Set(patchRows.map((row) => row.asin)).size === 24 &&
      new Set(patchRows.map((row) => row.action_id)).size === 24,
    "Exact 24-row identity/action uniqueness gate failed.",
  );
  assert(
    publicationBySku.size === stagingBySku.size &&
      [...stagingBySku.keys()].every((sku) => publicationBySku.has(sku)),
    "Publication and R2 staging cohorts differ.",
  );

  const sourceArtifacts = {
    publication_manifest: {
      path: publicationPath,
      sha256: publicationSha,
      schema_version: publication.schema_version,
    },
    r2_staging: {
      path: r2Path,
      sha256: r2Sha,
      schema_version: staging.schema_version,
    },
    source_ledger: {
      path: ledgerPath,
      sha256: ledgerSha,
      audit_id: ledger.audit_id,
      schema_version: ledger.schema_version,
      rows: ledger.rows.length,
    },
  };
  const desiredManifest = {
    schema_version: DESIRED_SCHEMA,
    immutable: true,
    source_ledger_sha256: ledgerSha,
    reviewed_at: publication.generated_at,
    scope: {
      marketplace_id: MARKETPLACE_ID,
      requested_rows: 24,
      action: "REPLACE_MAIN_ONLY",
    },
    source_artifacts: sourceArtifacts,
    main_image_patch_rows: patchRows.map((row) => ({
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      desired_main_url: row.desired_main.url,
      desired_main_sha256: row.desired_main.sha256,
      rollback_main_sha256: row.rollback_main.sha256,
    })),
    repairs: patchRows.map((row) => ({
      sku: row.sku,
      review: {
        confidence: "HIGH",
        rationale:
          "Owner-approved exception: replace only the incorrect/missing product-identity MAIN; preserve all other listing attributes.",
        evidence: [
          `ASIN ${row.asin}; ordinal ${row.ordinal}; exact recipe ${row.exact_recipe_signature}`,
          `Owner decision ${row.owner_change_reason_code}; QA PASS_OWNER_RELAXED`,
          `Desired MAIN sha256 ${row.desired_main.sha256}; R2 staging sha256 ${r2Sha}`,
          `Rollback MAIN sha256 ${row.rollback_main.sha256}; publication manifest sha256 ${publicationSha}`,
        ],
      },
      media: { main_image_url: row.desired_main.url },
    })),
  };
  const desiredBodySha = sha256(stableJson(desiredManifest));
  desiredManifest.body_sha256 = desiredBodySha;

  const preflight = {
    schema_version: PREFLIGHT_SCHEMA,
    immutable: true,
    generated_at: new Date().toISOString(),
    status: "OFFLINE_PATCH_INTENT_READY_VALIDATION_PREVIEW_NOT_RUN",
    source_artifacts: sourceArtifacts,
    desired_manifest_body_sha256: desiredBodySha,
    policy: {
      marketplace_id: MARKETPLACE_ID,
      patch_only: true,
      exact_attribute_path: "/attributes/main_product_image_locator",
      validation_preview_required_before_any_mutation: true,
      post_get_verification_required_after_any_future_mutation: true,
      preserve_text_structured_offer_gallery: true,
      external_calls_this_build: 0,
      amazon_calls_this_build: 0,
      amazon_mutations_this_build: 0,
    },
    summary: {
      rows: patchRows.length,
      unique_skus: new Set(patchRows.map((row) => row.sku)).size,
      unique_asins: new Set(patchRows.map((row) => row.asin)).size,
      unique_desired_assets: new Set(
        patchRows.map((row) => row.desired_main.sha256),
      ).size,
      exact_main_replace_patches: patchRows.reduce(
        (sum, row) => sum + row.intended_patch.length,
        0,
      ),
      local_desired_assets_verified: patchRows.length,
      local_rollback_assets_verified: patchRows.length,
      blockers: 0,
    },
    rows: patchRows,
  };

  await mkdir(outputDir, { recursive: true });
  const desiredArtifact = await writeImmutableJson(
    path.join(outputDir, "desired-main-only-manifest.json"),
    desiredManifest,
  );
  const preflightArtifact = await writeImmutableJson(
    path.join(outputDir, "amazon-main-only-offline-preflight.json"),
    preflight,
  );
  console.log(
    JSON.stringify(
      {
        desired_manifest: desiredArtifact,
        offline_preflight: preflightArtifact,
        rows: 24,
        unique_assets: 23,
        exact_patch_path: "/attributes/main_product_image_locator",
        amazon_calls: 0,
        external_mutations: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
