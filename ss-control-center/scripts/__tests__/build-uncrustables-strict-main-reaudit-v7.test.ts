// node --import tsx --test scripts/__tests__/build-uncrustables-strict-main-reaudit-v7.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v7.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v7 allows authentic printed retailer marks but preserves residual defects", () => {
  const check = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/build-uncrustables-strict-main-reaudit-v7.ts",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { body_sha256, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), body_sha256);
  assert.equal(artifact.summary.reviewed, 164);
  assert.equal(artifact.summary.KEEP, 60);
  assert.equal(artifact.summary.REPAIR, 104);
  assert.equal(artifact.summary.corrected_rows_with_decision_change, 8);

  const rows = new Map(
    artifact.rows.map((row: {
      ordinal: number;
      decision: string;
      reason_codes: string[];
    }) => [row.ordinal, row]),
  );
  for (const ordinal of [1, 22, 31, 33, 74, 75, 97, 129]) {
    assert.equal(rows.get(ordinal).decision, "KEEP");
    assert.deepEqual(rows.get(ordinal).reason_codes, []);
  }
  assert.equal(rows.get(30).decision, "REPAIR");
  assert.deepEqual(rows.get(30).reason_codes, ["LOOSE_ICE_VISIBLE"]);
  for (const ordinal of [131, 141, 159, 161]) {
    assert.equal(rows.get(ordinal).decision, "REPAIR");
    assert.deepEqual(rows.get(ordinal).reason_codes, [
      "CARTON_COUNT_MATH_MISMATCH",
    ]);
  }
  assert.ok(
    artifact.rows.every((row: { reason_codes: string[] }) =>
      !row.reason_codes.includes("RETAILER_BADGE_VISIBLE")),
  );
  assert.equal(artifact.reason_catalog.RETAILER_BADGE_VISIBLE, undefined);
  assert.equal(artifact.provenance_gate.marketplace_write_authorized, false);
});
