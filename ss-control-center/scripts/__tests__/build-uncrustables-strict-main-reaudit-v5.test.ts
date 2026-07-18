// node --import tsx --test scripts/__tests__/build-uncrustables-strict-main-reaudit-v5.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v5.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v5 removes the false uniform-carton rule but preserves real defects", () => {
  const check = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/build-uncrustables-strict-main-reaudit-v5.ts",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { body_sha256, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), body_sha256);
  assert.equal(artifact.summary.reviewed, 164);
  assert.equal(artifact.summary.KEEP, 52);
  assert.equal(artifact.summary.REPAIR, 112);
  assert.equal(artifact.summary.corrected_false_rule_rows, 4);
  assert.equal(artifact.summary.corrected_rows_with_decision_change, 0);
  assert.ok(
    artifact.rows.every((row: { reason_codes: string[] }) =>
      !row.reason_codes.includes("MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR")),
  );

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
