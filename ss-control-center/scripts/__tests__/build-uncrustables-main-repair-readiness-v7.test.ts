// node --import tsx --test scripts/__tests__/build-uncrustables-main-repair-readiness-v7.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-main-repair-readiness-20260718-v7.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v7 readiness is the exact corrected 104-row REPAIR partition", () => {
  const check = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/build-uncrustables-main-repair-readiness-v7.ts",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { seal, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), seal.body_sha256);
  assert.equal(artifact.rows.length, 104);
  assert.equal(artifact.summary.strict_keep_rows_not_queued, 60);
  assert.equal(artifact.summary.strict_repair_rows_queued, 104);
  assert.equal(artifact.summary.reference_ready_pending_explicit_generation, 6);
  assert.equal(artifact.summary.blocked_authenticity_provenance, 96);
  assert.equal(artifact.summary.blocked_catalog_identity, 2);
  assert.equal(artifact.summary.authentic_retailer_mark_keep_promotions, 8);
  assert.equal(artifact.correction.queue_membership_changed, true);

  const byOrdinal = new Map(
    artifact.rows.map((row: {
      ordinal: number;
      strict_audit: { reason_codes: string[] };
    }) => [row.ordinal, row]),
  );
  for (const ordinal of [1, 22, 31, 33, 74, 75, 97, 129]) {
    assert.equal(byOrdinal.has(ordinal), false);
  }
  assert.deepEqual(byOrdinal.get(30).strict_audit.reason_codes, [
    "LOOSE_ICE_VISIBLE",
  ]);
  assert.ok(
    artifact.rows.every((row: { strict_audit: { reason_codes: string[] } }) =>
      !row.strict_audit.reason_codes.includes("RETAILER_BADGE_VISIBLE")),
  );
  assert.equal(artifact.safety.amazon_writes, 0);
  assert.equal(artifact.safety.generation_authorized, false);
});
