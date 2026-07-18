// node --import tsx --test scripts/__tests__/build-uncrustables-strict-main-reaudit-v6.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v6 fixes terminal metadata without changing strict visual decisions", () => {
  const check = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/build-uncrustables-strict-main-reaudit-v6.ts",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { body_sha256, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), body_sha256);
  assert.equal(artifact.reviewed_at, "2026-07-18T23:10:00Z");
  assert.equal(
    artifact.corrects.supersedes_prior_correction.reason,
    "A later review of the pinned original-resolution asset established an additional independent package/kit text-integrity defect on ordinal 38.",
  );
  assert.equal(
    artifact.metadata_correction.predecessor_file_sha256,
    "19868f5dec6bc81d1a94c3248cb8a7ba29e3a4854ea255cfc3df9636a8af415f",
  );
  assert.equal(artifact.metadata_correction.visual_decisions_changed, 0);
  assert.equal(artifact.summary.reviewed, 164);
  assert.equal(artifact.summary.KEEP, 52);
  assert.equal(artifact.summary.REPAIR, 112);

  const reasonByOrdinal = new Map(
    artifact.rows.map((row: { ordinal: number; reason_codes: string[] }) => [
      row.ordinal,
      row.reason_codes,
    ]),
  );
  assert.deepEqual(reasonByOrdinal.get(1), ["RETAILER_BADGE_VISIBLE"]);
  assert.deepEqual(reasonByOrdinal.get(2), ["LOOSE_ICE_VISIBLE"]);
  assert.deepEqual(reasonByOrdinal.get(38), [
    "LOOSE_ICE_VISIBLE",
    "VISIBLE_TEXT_INTEGRITY_FAIL",
  ]);
  assert.deepEqual(reasonByOrdinal.get(97), ["RETAILER_BADGE_VISIBLE"]);
  assert.ok(
    artifact.rows.every((row: { reason_codes: string[] }) =>
      !row.reason_codes.includes("MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR")),
  );
  assert.ok(
    artifact.carton_decomposition_observations.every(
      (review: {
        visibly_observed_pack_sizes: number[];
        production_reference_provenance: string;
      }) =>
        JSON.stringify(review.visibly_observed_pack_sizes) ===
          JSON.stringify([10, 10, 4]) &&
        review.production_reference_provenance ===
          "NOT_ESTABLISHED_BY_THIS_LIVE_COMPOSITE_OBSERVATION",
    ),
  );
  assert.equal(artifact.provenance_gate.marketplace_write_authorized, false);
});
