// node --import tsx --test scripts/__tests__/build-uncrustables-main-repair-readiness-v8.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-main-repair-readiness-20260718-v8.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v8 readiness covers every strict repair and authorizes no mutation", () => {
  const check = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/build-uncrustables-main-repair-readiness-v8.ts",
      "--check",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { seal, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), seal.body_sha256);
  assert.equal(artifact.rows.length, 134);
  assert.equal(artifact.summary.strict_keep_rows_not_queued, 30);
  assert.equal(artifact.summary.strict_repair_rows_queued, 134);
  assert.equal(
    artifact.summary.reference_ready_pending_explicit_generation,
    13,
  );
  assert.equal(artifact.summary.blocked_authenticity_provenance, 119);
  assert.equal(artifact.summary.blocked_catalog_identity, 2);
  assert.equal(artifact.correction.newly_added_ordinals.length, 30);
  assert.equal(new Set(artifact.rows.map((row: { sku: string }) => row.sku)).size, 134);
  assert.equal(new Set(artifact.rows.map((row: { asin: string }) => row.asin)).size, 134);
  assert.ok(
    artifact.rows.every(
      (row: {
        generation_authorized: boolean;
        amazon_write_authorized: boolean;
      }) => !row.generation_authorized && !row.amazon_write_authorized,
    ),
  );
  assert.ok(
    artifact.rows
      .filter(
        (row: { readiness: string }) =>
          row.readiness ===
          "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION",
      )
      .every((row: { components: Array<{ authenticity_registry: unknown }> }) =>
        row.components.every((component) => component.authenticity_registry),
      ),
  );
  assert.equal(artifact.safety.amazon_writes, 0);
  assert.equal(artifact.safety.channelmax_writes, 0);
});
