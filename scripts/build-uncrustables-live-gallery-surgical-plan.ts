/**
 * Build a deterministic, read-only surgical gallery plan for all 164 live
 * Uncrustables listings.
 *
 * This script performs local reads and local artifact writes only. It does not
 * call Amazon, R2, a database, or any other network service.
 *
 * Run:
 *   npx tsx scripts/build-uncrustables-live-gallery-surgical-plan.ts
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalUncrustablesLiveGalleryJson,
  sealUncrustablesLiveGalleryManifestBody,
  verifyUncrustablesLiveGalleryManifestSeal,
} from "../src/lib/bundle-factory/audit/uncrustables-live-gallery";
import {
  LIVE_GALLERY_DISALLOWED_SHA256,
  LIVE_GALLERY_FIXED_CARD,
  LIVE_GALLERY_SHARED_FALLBACK_PRIORITY,
  LIVE_GALLERY_SURGICAL_PLAN_SCHEMA,
  buildLiveGallerySurgicalRowPlan,
  indexLiveGalleryVisualAssets,
  type LiveGallerySkuConclusion,
  type LiveGalleryVisualAsset,
  type SurgicalGalleryRowPlan,
} from "../src/lib/bundle-factory/repair/uncrustables-live-gallery-surgical-plan";

const EXPECTED_VISUAL_AUDIT_FILE_SHA256 =
  "ae7d818178d663a20ca0058f20ad68a5cb5137e8a8e26c2bf01407e2111dcc94";
const EXPECTED_FETCH_MANIFEST_FILE_SHA256 =
  "aeea0813c67584d5d082186fca92535487b7a96de1dedd9e0e0bb67930944f02";
const EXPECTED_VISUAL_AUDIT_BODY_SHA256 =
  "390a7db5af60b16d3f5005139682878e56b7211e829d9dd47ca585cede267f08";
const EXPECTED_ROWS = 164;
const EXPECTED_AUDITED_ASSETS = 84;

const DEFAULT_VISUAL_AUDIT =
  "data/audits/uncrustables-live-gallery-visual-audit-20260718.json";
const DEFAULT_FETCH_MANIFEST =
  "data/audits/uncrustables-live-gallery-fetch-20260718/manifest.json";
const DEFAULT_OUTPUT_PREFIX =
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1";
const SELECTOR_SOURCE =
  "src/lib/bundle-factory/repair/uncrustables-product-gallery.ts";
const PLAN_MODULE_SOURCE =
  "src/lib/bundle-factory/repair/uncrustables-live-gallery-surgical-plan.ts";
const GENERATOR_SOURCE =
  "scripts/build-uncrustables-live-gallery-surgical-plan.ts";

interface VisualAuditArtifact {
  schema_version: string;
  generated_at: string;
  status: string;
  body_sha256: string;
  source_manifest: {
    path: string;
    sha256: string;
    body_sha256: string;
    run_id: string;
    completed_at: string;
    source_ledger: unknown;
    source_reviewed_overrides: unknown;
  };
  scope: unknown;
  policy: unknown;
  summary: unknown;
  assets: LiveGalleryVisualAsset[];
  sku_conclusions: LiveGallerySkuConclusion[];
}

interface FetchManifestAsset {
  sha256: string;
  local_path: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
  exact_urls: Array<{ requested_url: string }>;
}

interface FetchManifestRow {
  ordinal: number;
  sku: string;
  asin: string;
  recipe_components: unknown[];
  images: Array<{
    slot: string;
    requested_url: string;
  }>;
}

interface FetchManifestArtifact extends Record<string, unknown> {
  schema_version: string;
  run_id: string;
  completed_at: string;
  immutable: boolean;
  status: string;
  body_sha256: string;
  source_ledger: unknown;
  source_reviewed_overrides: unknown;
  summary: unknown;
  rows: FetchManifestRow[];
  exact_hash_assets: FetchManifestAsset[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): {
  visualAudit: string;
  fetchManifest: string;
  outputPrefix: string;
} {
  let visualAudit = DEFAULT_VISUAL_AUDIT;
  let fetchManifest = DEFAULT_FETCH_MANIFEST;
  let outputPrefix = DEFAULT_OUTPUT_PREFIX;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--visual-audit" && value) {
      visualAudit = value;
      index++;
    } else if (arg === "--fetch-manifest" && value) {
      fetchManifest = value;
      index++;
    } else if (arg === "--output-prefix" && value) {
      outputPrefix = value;
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return { visualAudit, fetchManifest, outputPrefix };
}

function verifyVisualAuditBodySeal(audit: VisualAuditArtifact): void {
  assert(
    audit.body_sha256 === EXPECTED_VISUAL_AUDIT_BODY_SHA256,
    "Visual-audit embedded body SHA is not the reviewed digest.",
  );
  const body = { ...audit } as Record<string, unknown>;
  delete body.body_sha256;
  assert(
    sha256(JSON.stringify(body)) === audit.body_sha256,
    "Visual-audit body seal verification failed.",
  );
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function fileEvidence(root: string, relativePath: string) {
  const bytes = await readFile(path.resolve(root, relativePath));
  return {
    path: relativePath,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

async function verifyAuditAssetsAgainstFetch(
  root: string,
  auditAssets: LiveGalleryVisualAsset[],
  fetchAssets: FetchManifestAsset[],
): Promise<void> {
  const fetchBySha = new Map(fetchAssets.map((asset) => [asset.sha256, asset]));
  assert(fetchBySha.size === fetchAssets.length, "Duplicate fetch asset SHA.");
  await Promise.all(
    auditAssets.map(async (asset) => {
      const fetched = fetchBySha.get(asset.sha256);
      assert(fetched, `Audit asset ${asset.sha256} is absent from fetch manifest.`);
      assert(fetched.bytes === asset.bytes, `Byte mismatch for ${asset.sha256}.`);
      assert(fetched.width === asset.width, `Width mismatch for ${asset.sha256}.`);
      assert(fetched.height === asset.height, `Height mismatch for ${asset.sha256}.`);
      assert(fetched.format === asset.format, `Format mismatch for ${asset.sha256}.`);
      const fetchedUrls = new Set(
        fetched.exact_urls.map((entry) => entry.requested_url),
      );
      assert(
        asset.exact_urls.every((url) => fetchedUrls.has(url)),
        `Exact URL mismatch for ${asset.sha256}.`,
      );
      const localBytes = await readFile(path.resolve(root, asset.local_path));
      assert(localBytes.length === asset.bytes, `Local byte mismatch for ${asset.sha256}.`);
      assert(sha256(localBytes) === asset.sha256, `Local SHA mismatch for ${asset.sha256}.`);
    }),
  );
}

function verifyRowsAgainstFetch(
  auditRows: LiveGallerySkuConclusion[],
  fetchRows: FetchManifestRow[],
  fetchAssets: FetchManifestAsset[],
): void {
  const fetchBySku = new Map(fetchRows.map((row) => [row.sku, row]));
  assert(fetchBySku.size === fetchRows.length, "Duplicate fetch-manifest SKU.");
  const urlToSha = new Map<string, string>();
  for (const asset of fetchAssets) {
    for (const exactUrl of asset.exact_urls) {
      const prior = urlToSha.get(exactUrl.requested_url);
      assert(!prior || prior === asset.sha256, "One exact URL maps to multiple SHAs.");
      urlToSha.set(exactUrl.requested_url, asset.sha256);
    }
  }
  for (const auditRow of auditRows) {
    const fetched = fetchBySku.get(auditRow.sku);
    assert(fetched, `Audit row ${auditRow.sku} is absent from fetch manifest.`);
    assert(fetched.asin === auditRow.asin, `ASIN mismatch for ${auditRow.sku}.`);
    assert(fetched.ordinal === auditRow.ordinal, `Ordinal mismatch for ${auditRow.sku}.`);
    assert(
      canonicalUncrustablesLiveGalleryJson(fetched.recipe_components) ===
        canonicalUncrustablesLiveGalleryJson(auditRow.recipe_components),
      `Recipe-component mismatch for ${auditRow.sku}.`,
    );
    const fetchedSecondary = fetched.images.filter((image) => image.slot !== "MAIN");
    assert(
      fetchedSecondary.length === auditRow.secondary_assets.length,
      `Secondary count mismatch for ${auditRow.sku}.`,
    );
    for (const [index, expected] of fetchedSecondary.entries()) {
      const observed = auditRow.secondary_assets[index];
      assert(observed.slot === expected.slot, `Slot mismatch for ${auditRow.sku}.`);
      assert(observed.url === expected.requested_url, `URL mismatch for ${auditRow.sku}.`);
      assert(
        observed.sha256 === urlToSha.get(expected.requested_url),
        `SHA mapping mismatch for ${auditRow.sku}/${expected.slot}.`,
      );
    }
  }
}

function csvCell(value: unknown): string {
  const stringValue = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\n\r]/.test(stringValue)
    ? `"${stringValue.replaceAll('"', '""')}"`
    : stringValue;
}

function buildCsv(rows: SurgicalGalleryRowPlan[]): string {
  const columns = [
    "ordinal",
    "sku",
    "asin",
    "action",
    "write_required",
    "source_visual_audit_conclusion",
    "recipe_keys",
    "reason_codes",
    "before_secondary_count",
    "after_secondary_count",
    "after_product_or_context_count",
    "after_component_asset_counts",
    "after_component_sequence",
    "after_sha256",
    "after_source_urls",
    "validation_pass",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const values = [
      row.ordinal,
      row.sku,
      row.asin,
      row.action,
      row.write_required,
      row.source_visual_audit_conclusion,
      row.recipe_keys,
      row.reason_codes,
      row.before.validation.secondary_count,
      row.after.validation.secondary_count,
      row.after.validation.product_or_context_count,
      Object.entries(row.after.validation.component_asset_counts)
        .map(([key, count]) => `${key}:${count}`)
        .join("|"),
      row.after.validation.exact_component_sequence,
      row.after.secondary_assets.map((asset) => asset.sha256),
      row.after.secondary_assets.map((asset) => asset.source_url),
      row.after.validation.pass,
    ];
    lines.push(values.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(
  planId: string,
  sourceEvidence: Record<string, { path: string; sha256: string; bytes: number }>,
  rows: SurgicalGalleryRowPlan[],
): string {
  const keep = rows.filter((row) => row.action === "KEEP").length;
  const rebuild = rows.length - keep;
  const reclassified = rows.filter(
    (row) =>
      row.source_visual_audit_conclusion === "KEEP" &&
      row.action === "REBUILD_GALLERY",
  );
  const lines = [
    "# Uncrustables live gallery surgical plan v1",
    "",
    `- Plan ID: \`${planId}\``,
    `- Scope: ${rows.length} live SKU/ASIN rows`,
    `- KEEP (no gallery write): ${keep}`,
    `- REBUILD_GALLERY: ${rebuild}`,
    "- External writes performed: none",
    "- GALLERY_1: exact owner-approved price/thank-you card for every row",
    "- Remaining images: 4–6, unique by exact pixel SHA",
    "- Mixes: every component covered in deterministic round-robin order",
    "",
    "## Pinned sources",
    "",
    "| Source | SHA-256 | Bytes |",
    "|---|---|---:|",
    ...Object.values(sourceEvidence).map(
      (source) => `| \`${source.path}\` | \`${source.sha256}\` | ${source.bytes} |`,
    ),
    "",
    "## Strict reclassifications",
    "",
    reclassified.length
      ? `${reclassified.length} prior KEEP row(s) are rebuilt because a shared 1280×720 lunchbox creative visibly contains both raspberry and strawberry packages and is not exact for a single-flavor raspberry SKU.`
      : "None.",
    "",
    "## Per-listing decision",
    "",
    "| # | SKU | ASIN | Recipe | Action | Before → After | Reason |",
    "|---:|---|---|---|---|---:|---|",
    ...rows.map(
      (row) =>
        `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.recipe_keys.join(" + ")} | ${row.action} | ${row.before.validation.secondary_count} → ${row.after.validation.secondary_count} | ${row.reason_codes.join("; ") || "—"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function writeAtomic(outputPath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, outputPath);
}

async function writeWithShaSidecar(outputPath: string, bytes: Buffer): Promise<string> {
  const digest = sha256(bytes);
  await writeAtomic(outputPath, bytes);
  await writeAtomic(
    `${outputPath}.sha256`,
    Buffer.from(`${digest}  ${path.basename(outputPath)}\n`, "utf8"),
  );
  return digest;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const visualAuditPath = path.resolve(root, options.visualAudit);
  const fetchManifestPath = path.resolve(root, options.fetchManifest);
  const outputPrefix = path.resolve(root, options.outputPrefix);

  const [visualAuditBytes, fetchManifestBytes] = await Promise.all([
    readFile(visualAuditPath),
    readFile(fetchManifestPath),
  ]);
  assert(
    sha256(visualAuditBytes) === EXPECTED_VISUAL_AUDIT_FILE_SHA256,
    "Visual-audit file SHA is not the reviewed digest.",
  );
  assert(
    sha256(fetchManifestBytes) === EXPECTED_FETCH_MANIFEST_FILE_SHA256,
    "Fetch-manifest file SHA is not the reviewed digest.",
  );
  const visualAudit = JSON.parse(visualAuditBytes.toString("utf8")) as VisualAuditArtifact;
  const fetchManifest = JSON.parse(
    fetchManifestBytes.toString("utf8"),
  ) as FetchManifestArtifact;
  verifyVisualAuditBodySeal(visualAudit);
  assert(
    verifyUncrustablesLiveGalleryManifestSeal(fetchManifest),
    "Fetch-manifest canonical body seal verification failed.",
  );
  assert(
    visualAudit.schema_version === "uncrustables-live-gallery-visual-audit/v1.0" &&
      visualAudit.status === "COMPLETE_READ_ONLY_VISUAL_AUDIT",
    "Unexpected visual-audit schema or status.",
  );
  assert(
    fetchManifest.immutable === true && fetchManifest.status === "COMPLETE",
    "Fetch manifest is not immutable/complete.",
  );
  assert(
    visualAudit.source_manifest.sha256 === EXPECTED_FETCH_MANIFEST_FILE_SHA256,
    "Visual audit is not bound to the exact fetch manifest.",
  );
  assert(
    visualAudit.source_manifest.body_sha256 === fetchManifest.body_sha256,
    "Visual audit and fetch manifest body seals differ.",
  );
  assert(
    visualAudit.sku_conclusions.length === EXPECTED_ROWS &&
      fetchManifest.rows.length === EXPECTED_ROWS,
    `Expected exactly ${EXPECTED_ROWS} rows.`,
  );
  assert(
    visualAudit.assets.length === EXPECTED_AUDITED_ASSETS,
    `Expected exactly ${EXPECTED_AUDITED_ASSETS} audited secondary assets.`,
  );
  assert(
    new Set(visualAudit.sku_conclusions.map((row) => row.sku)).size === EXPECTED_ROWS,
    "Visual audit contains duplicate SKU rows.",
  );
  assert(
    new Set(visualAudit.sku_conclusions.map((row) => row.asin)).size === EXPECTED_ROWS,
    "Visual audit contains duplicate ASIN rows.",
  );
  indexLiveGalleryVisualAssets(visualAudit.assets);
  await verifyAuditAssetsAgainstFetch(
    root,
    visualAudit.assets,
    fetchManifest.exact_hash_assets,
  );
  verifyRowsAgainstFetch(
    visualAudit.sku_conclusions,
    fetchManifest.rows,
    fetchManifest.exact_hash_assets,
  );

  const rows = [...visualAudit.sku_conclusions]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => buildLiveGallerySurgicalRowPlan(row, visualAudit.assets));
  assert(rows.length === EXPECTED_ROWS, "Plan row count drifted.");
  assert(rows.every((row) => row.after.validation.pass), "An after-gallery failed.");
  assert(
    rows.every(
      (row) =>
        row.after.secondary_assets[0]?.sha256 === LIVE_GALLERY_FIXED_CARD.sha256 &&
        row.after.secondary_assets[0]?.source_url === LIVE_GALLERY_FIXED_CARD.url,
    ),
    "At least one row lacks the exact fixed GALLERY_1 card.",
  );
  assert(
    rows.every((row) =>
      row.after.secondary_assets.every(
        (asset) => !LIVE_GALLERY_DISALLOWED_SHA256.has(asset.sha256),
      ),
    ),
    "At least one after-gallery contains a disallowed asset.",
  );

  const sourceEvidence = {
    visual_audit: await fileEvidence(root, toRelative(root, visualAuditPath)),
    live_fetch_manifest: await fileEvidence(root, toRelative(root, fetchManifestPath)),
    balanced_selector: await fileEvidence(root, SELECTOR_SOURCE),
    surgical_plan_module: await fileEvidence(root, PLAN_MODULE_SOURCE),
    generator: await fileEvidence(root, GENERATOR_SOURCE),
  };
  const planId = `ULGSP-${sha256(
    canonicalUncrustablesLiveGalleryJson({
      schema: LIVE_GALLERY_SURGICAL_PLAN_SCHEMA,
      source_hashes: Object.fromEntries(
        Object.entries(sourceEvidence).map(([key, evidence]) => [key, evidence.sha256]),
      ),
      policy: {
        fixed_card_sha256: LIVE_GALLERY_FIXED_CARD.sha256,
        disallowed_sha256: [...LIVE_GALLERY_DISALLOWED_SHA256].sort(),
        shared_fallback_priority: LIVE_GALLERY_SHARED_FALLBACK_PRIORITY,
      },
    }),
  ).slice(0, 20)}`;

  const keepRows = rows.filter((row) => row.action === "KEEP");
  const rebuildRows = rows.filter((row) => row.action === "REBUILD_GALLERY");
  const strictReclassifications = rows.filter(
    (row) =>
      row.source_visual_audit_conclusion === "KEEP" &&
      row.action === "REBUILD_GALLERY",
  );
  const afterCountDistribution = Object.fromEntries(
    [5, 6, 7].map((count) => [
      String(count),
      rows.filter((row) => row.after.validation.secondary_count === count).length,
    ]),
  );
  const usedAssets = new Set(
    rows.flatMap((row) => row.after.secondary_assets.map((asset) => asset.sha256)),
  );
  const body = {
    schema_version: LIVE_GALLERY_SURGICAL_PLAN_SCHEMA,
    plan_id: planId,
    deterministic_as_of: visualAudit.generated_at,
    status: "SEALED_LOCAL_READ_ONLY_PLAN",
    immutable_inputs: true,
    scope: {
      listing_rows: EXPECTED_ROWS,
      marketplace: "Amazon.com",
      field: "secondary image gallery only",
      main_images_excluded: true,
      old_future_donor_manifest_used: false,
    },
    safety: {
      no_amazon_api_calls: true,
      no_r2_writes: true,
      no_database_writes: true,
      no_network_calls: true,
      local_artifact_writes_only: true,
      selected_urls_are_source_evidence_not_newly_uploaded_urls: true,
    },
    sources: {
      ...sourceEvidence,
      visual_audit_body_sha256: visualAudit.body_sha256,
      fetch_manifest_body_sha256: fetchManifest.body_sha256,
      fetch_run_id: fetchManifest.run_id,
      source_ledger: fetchManifest.source_ledger,
      source_reviewed_overrides: fetchManifest.source_reviewed_overrides,
    },
    policy: {
      gallery_1: {
        exact_url: LIVE_GALLERY_FIXED_CARD.url,
        exact_sha256: LIVE_GALLERY_FIXED_CARD.sha256,
        occurrences_required: 1,
      },
      product_or_context_images: { min: 4, max: 6 },
      asset_evidence:
        "Exact live bytes, SHA-256, URL, local file, dimensions, and completed human visual audit required.",
      recipe_specific_selection:
        "Only a single-key RECIPE_SPECIFIC_NEEDS_MAPPING asset may represent that exact recipe component.",
      shared_context:
        "Only the four explicitly audited flavor-neutral SHAs are accepted; replacement selection uses them solely to reach the four-image minimum.",
      mix_balance:
        "Every component must be represented and exact component assets must follow deterministic component-order round robin with count delta <= 1.",
      uniqueness: "Exact decoded-byte SHA-256 across the entire secondary gallery.",
      multi_key_creatives:
        "Rejected from component selection; prevents an unsold flavor from entering a single-flavor gallery.",
      disallowed_sha256: [...LIVE_GALLERY_DISALLOWED_SHA256].sort(),
      disallowed_reasons: [
        "non-exact cross-flavor promotional collage",
        "Target-specific lifestyle copy",
        "nutrition panel carrying wrong-slot policy issues",
      ],
      keep_rule:
        "KEEP only when the complete current gallery independently passes every invariant; otherwise rebuild.",
    },
    summary: {
      listing_rows: rows.length,
      keep_no_write: keepRows.length,
      rebuild_gallery: rebuildRows.length,
      write_required_rows: rebuildRows.length,
      strict_prior_keep_reclassified: strictReclassifications.length,
      strict_prior_keep_reclassified_skus: strictReclassifications.map(
        (row) => row.sku,
      ),
      after_validation_pass: rows.filter((row) => row.after.validation.pass).length,
      after_validation_fail: rows.filter((row) => !row.after.validation.pass).length,
      after_secondary_count_distribution: afterCountDistribution,
      unique_after_assets_including_fixed_card: usedAssets.size,
      disallowed_after_asset_occurrences: rows.reduce(
        (count, row) =>
          count +
          row.after.secondary_assets.filter((asset) =>
            LIVE_GALLERY_DISALLOWED_SHA256.has(asset.sha256),
          ).length,
        0,
      ),
      rows_with_exact_component_coverage: rows.filter((row) =>
        Object.values(row.after.validation.component_asset_counts).every(
          (count) => count >= 1,
        ),
      ).length,
      mix_rows: rows.filter((row) => row.recipe_keys.length > 1).length,
      mix_rows_round_robin_valid: rows.filter(
        (row) => row.recipe_keys.length > 1 && row.after.validation.pass,
      ).length,
    },
    validation: {
      expected_rows: EXPECTED_ROWS,
      exact_rows_observed: rows.length,
      exact_audited_assets_observed: visualAudit.assets.length,
      every_local_asset_sha_verified: true,
      audit_rows_byte_mapped_to_fetch_manifest: true,
      every_after_gallery_valid: true,
      every_after_gallery_fixed_card_exact: true,
      every_after_gallery_policy_issue_free: true,
      every_after_gallery_disallowed_sha_free: true,
      every_after_gallery_unique_sha: true,
      every_recipe_component_covered: true,
    },
    rows,
  };
  const bodySha256 = sealUncrustablesLiveGalleryManifestBody(body);
  const sealedPlan = { ...body, body_sha256: bodySha256 };
  const jsonBytes = Buffer.from(`${JSON.stringify(sealedPlan, null, 2)}\n`, "utf8");
  const csvBytes = Buffer.from(buildCsv(rows), "utf8");
  const markdownBytes = Buffer.from(
    buildMarkdown(planId, sourceEvidence, rows),
    "utf8",
  );

  const [jsonSha, csvSha, markdownSha] = await Promise.all([
    writeWithShaSidecar(`${outputPrefix}.json`, jsonBytes),
    writeWithShaSidecar(`${outputPrefix}.csv`, csvBytes),
    writeWithShaSidecar(`${outputPrefix}.md`, markdownBytes),
  ]);
  process.stdout.write(
    `${toRelative(root, outputPrefix)}\tplan_id=${planId}\trows=${rows.length}` +
      `\tkeep=${keepRows.length}\trebuild=${rebuildRows.length}` +
      `\tbody_sha256=${bodySha256}\tjson_sha256=${jsonSha}` +
      `\tcsv_sha256=${csvSha}\tmd_sha256=${markdownSha}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

