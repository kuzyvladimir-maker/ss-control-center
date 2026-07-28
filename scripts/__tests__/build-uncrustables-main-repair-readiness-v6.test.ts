// node --import tsx --test scripts/__tests__/build-uncrustables-main-repair-readiness-v6.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-main-repair-readiness-20260718-v6.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v6 readiness matches the corrected strict 112 repair partition", () => {
  const check = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/build-uncrustables-main-repair-readiness-v6.ts",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { seal, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), seal.body_sha256);
  assert.equal(artifact.rows.length, 112);
  assert.equal(artifact.summary.strict_keep_rows_not_queued, 52);
  assert.equal(artifact.summary.strict_repair_rows_queued, 112);
  assert.equal(artifact.summary.reference_ready_pending_explicit_generation, 9);
  assert.equal(artifact.summary.blocked_authenticity_provenance, 101);
  assert.equal(artifact.summary.blocked_catalog_identity, 2);
  assert.equal(artifact.correction.queue_membership_changed, false);
  assert.ok(
    artifact.rows.every((row: { strict_audit: { reason_codes: string[] } }) =>
      !row.strict_audit.reason_codes.includes(
        "MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR",
      )),
  );
  const reasons = new Map(
    artifact.rows.map((row: { ordinal: number; strict_audit: { reason_codes: string[] } }) =>
      [row.ordinal, row.strict_audit.reason_codes]),
  );
  assert.deepEqual(reasons.get(1), ["RETAILER_BADGE_VISIBLE"]);
  assert.deepEqual(reasons.get(2), ["LOOSE_ICE_VISIBLE"]);
  assert.deepEqual(reasons.get(38), [
    "LOOSE_ICE_VISIBLE",
    "VISIBLE_TEXT_INTEGRITY_FAIL",
  ]);
  assert.deepEqual(reasons.get(97), ["RETAILER_BADGE_VISIBLE"]);
  assert.equal(artifact.safety.amazon_writes, 0);
  assert.equal(artifact.safety.generation_authorized, false);
});
