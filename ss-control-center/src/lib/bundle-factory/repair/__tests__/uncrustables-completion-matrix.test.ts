// node --import tsx --test src/lib/bundle-factory/repair/__tests__/uncrustables-completion-matrix.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDefaultUncrustablesCompletionMatrix,
  sealRecord,
  sha256,
  stableJson,
} from "../uncrustables-completion-matrix";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

test("builds the exact conservative 164-row completion matrix", async () => {
  const built = await buildDefaultUncrustablesCompletionMatrix(repoRoot);
  const { matrix } = built;

  assert.equal(matrix.summary.total_rows, 164);
  assert.equal(matrix.deterministic_as_of, "2026-07-18T23:10:00.000Z");
  assert.ok(
    matrix.sources.some(
      (source) =>
        source.source_id === "strict_main_v6" &&
        source.path ===
          "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6.json" &&
        source.file_sha256 ===
          "87d9adf66cc322becccd0eb214e13d073272c3c11405e4bdd15e93c98f08eb4c" &&
        source.body_sha256 ===
          "befae9606c9dca01175c555f181cfcff53bd248aa5060ee2194e3e611739ff8e",
    ),
  );
  assert.ok(
    matrix.sources.some(
      (source) =>
        source.source_id === "amazon_live_pricing" &&
        source.path ===
          "data/audits/live-pricing/ULPA-20260718T221726816Z-8096129d8101-75cebdca9037-be7a076ea423.json" &&
        source.file_sha256 ===
          "f72761f27d52cafc8262cfda35ab4185e5ca501209678a3c00c1d75711471759" &&
        source.body_sha256 ===
          "be7a076ea4232f5384423c412b625cedf5ac7acb39345fe839d11ddc4a92615a",
    ),
  );
  assert.equal(matrix.rows.length, 164);
  assert.equal(new Set(matrix.rows.map((row) => row.sku)).size, 164);
  assert.equal(new Set(matrix.rows.map((row) => row.asin)).size, 164);
  assert.equal(matrix.summary.proven_ideal_rows, 0);
  assert.equal(matrix.summary.ready_to_publish_rows, 0);
  assert.ok(matrix.rows.every((row) => row.overall.readiness === "NOT_PROVEN_IDEAL"));

  assert.deepEqual(matrix.summary.catalog_status, {
    ACTIVE_COHORT_IN_SEALED_PLAN: 162,
    BLOCKED_CATALOG_IDENTITY_CONFLICT_8541: 2,
  });
  assert.deepEqual(matrix.summary.main_image_status, {
    REPAIR_REQUIRED: 112,
    VISUAL_KEEP_PROVENANCE_PENDING: 52,
  });
  assert.deepEqual(matrix.summary.main_repair_readiness, {
    BLOCKED_AUTHENTICITY_PROVENANCE: 101,
    BLOCKED_CATALOG_IDENTITY: 2,
    NOT_APPLICABLE_STRICT_KEEP: 52,
    REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION: 9,
  });
  assert.deepEqual(matrix.summary.gallery_status, {
    KEEP_NO_WRITE_POINT_IN_TIME: 44,
    REBUILD_NOT_APPLIED: 118,
    VERIFIED_POINT_IN_TIME: 2,
  });
  assert.deepEqual(matrix.summary.text_status, {
    NOT_APPLIED_CATALOG_BLOCKED: 2,
    VERIFIED_POINT_IN_TIME: 162,
  });
  assert.deepEqual(matrix.summary.structured_attributes_status, {
    NOT_APPLIED_CATALOG_BLOCKED: 2,
    VERIFIED_POINT_IN_TIME: 162,
  });
  assert.deepEqual(matrix.summary.launch_promotion_status, {
    EXCLUDED_CATALOG_IDENTITY_CONFLICT: 2,
    PROPOSED_NOT_OWNER_APPROVED_OR_APPLIED: 162,
  });
  assert.deepEqual(matrix.summary.channelmax_status, {
    LIVE_DEFAULT_MODEL_OVERWRITE_RISK: 161,
    LIVE_IDENTITY_MISMATCH: 1,
    LIVE_MANUAL_MODEL_BOUNDS_MISMATCH: 2,
  });

  const approvedAsins = ["B0H8259J9G", "B0H82RQ226", "B0H83R4M3R"];
  for (const asin of approvedAsins) {
    const row = matrix.rows.find((candidate) => candidate.asin === asin);
    assert.ok(row, `missing approved ASIN ${asin}`);
    assert.equal(row.main_image.status, "VISUAL_KEEP_PROVENANCE_PENDING");
  }
  const correctedMainReasons = new Map(
    matrix.rows
      .filter((row) => [1, 2, 38, 97].includes(row.ordinal))
      .map((row) => [row.ordinal, row.main_image.reason_codes]),
  );
  assert.deepEqual(correctedMainReasons.get(1), ["RETAILER_BADGE_VISIBLE"]);
  assert.deepEqual(correctedMainReasons.get(2), ["LOOSE_ICE_VISIBLE"]);
  assert.deepEqual(correctedMainReasons.get(38), [
    "LOOSE_ICE_VISIBLE",
    "VISIBLE_TEXT_INTEGRITY_FAIL",
  ]);
  assert.deepEqual(correctedMainReasons.get(97), ["RETAILER_BADGE_VISIBLE"]);
  const qx = matrix.rows.find((row) => row.sku === "QX-AS89-H8YC");
  assert.equal(qx?.amazon_pricing.status, "NO_OFFER_POINT_IN_TIME");
  assert.equal(qx?.amazon_pricing.evidence.observed_at, "2026-07-18T22:19:08.267Z");

  const galleryVerified = matrix.rows
    .filter((row) => row.gallery.status === "VERIFIED_POINT_IN_TIME")
    .map((row) => row.sku)
    .sort();
  assert.deepEqual(galleryVerified, ["AD-AS4H-QXZD", "AZ-ASMY-VEQ2"]);

  const channelIdentityMismatch = matrix.rows.find(
    (row) => row.channelmax.status === "LIVE_IDENTITY_MISMATCH",
  );
  assert.equal(channelIdentityMismatch?.sku, "SZ-ASPI-JFAT");
  assert.equal(channelIdentityMismatch?.asin, "B0H776M5B5");
  assert.equal(channelIdentityMismatch?.channelmax.observed_asin, "B0H75VN18Z");
  assert.equal(channelIdentityMismatch?.channelmax.identity_exact_match, false);

  const manualMismatchSkus = matrix.rows
    .filter((row) => row.channelmax.status === "LIVE_MANUAL_MODEL_BOUNDS_MISMATCH")
    .map((row) => row.sku)
    .sort();
  assert.deepEqual(manualMismatchSkus, ["VC-ASV1-378P", "VN-AS1A-D572"]);

  assert.equal(built.csv.trimEnd().split("\n").length, 165);
  assert.equal(matrix.output_artifacts.csv_sha256, sha256(built.csv));
  assert.equal(
    matrix.output_artifacts.summary_markdown_sha256,
    sha256(built.summaryMarkdown),
  );
  assert.equal(
    sealRecord(matrix as unknown as Record<string, unknown>, "body_sha256"),
    matrix.body_sha256,
  );
});

test("is deterministic for the same immutable local evidence", async () => {
  const first = await buildDefaultUncrustablesCompletionMatrix(repoRoot);
  const second = await buildDefaultUncrustablesCompletionMatrix(repoRoot);

  assert.equal(first.matrix.body_sha256, second.matrix.body_sha256);
  assert.equal(first.matrix.matrix_id, second.matrix.matrix_id);
  assert.equal(first.csv, second.csv);
  assert.equal(first.summaryMarkdown, second.summaryMarkdown);
  assert.equal(stableJson(first.matrix), stableJson(second.matrix));
});

test("stable body seals reject a changed field", () => {
  const original = {
    schema_version: "fixture/v1",
    rows: [{ sku: "A", ready: false }],
  };
  const sealed = { ...original, body_sha256: sha256(stableJson(original)) };
  assert.equal(sealRecord(sealed, "body_sha256"), sealed.body_sha256);

  const changed = {
    ...sealed,
    rows: [{ sku: "A", ready: true }],
  };
  assert.notEqual(sealRecord(changed, "body_sha256"), sealed.body_sha256);
});
