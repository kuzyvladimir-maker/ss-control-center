import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const jsonPath = new URL("data/audits/uncrustables-main-repair-readiness-20260718-v2.json", root);
const csvPath = new URL("data/audits/uncrustables-main-repair-readiness-20260718-v2.csv", root);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("strict 112 MAIN readiness queue is deterministic and fail-closed", () => {
  const check = spawnSync(process.execPath, [
    "scripts/build-uncrustables-main-repair-readiness-v2.mjs",
    "--check",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const text = readFileSync(jsonPath, "utf8");
  const artifact = JSON.parse(text);
  const { seal, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), seal.body_sha256);
  assert.equal(artifact.summary.strict_repair_rows_queued, 112);
  assert.equal(artifact.summary.strict_keep_rows_not_queued, 52);
  assert.equal(artifact.summary.owner_frozen_live_keep_rows, 3);
  assert.equal(artifact.summary.reference_ready_pending_explicit_generation, 9);
  assert.equal(artifact.summary.blocked_authenticity_provenance, 101);
  assert.equal(artifact.summary.blocked_catalog_identity, 2);
  assert.equal(artifact.rows.length, 112);
  assert.equal(new Set(artifact.rows.map((row) => row.asin)).size, 112);
  assert.ok(artifact.rows.every((row) => row.strict_audit.decision === "REPAIR"));
  assert.ok(artifact.rows.every((row) => !row.generation_authorized && !row.amazon_write_authorized));
  assert.ok(artifact.rows.every((row) => row.components.every((component) => component.canonical_flavor_id)));
  assert.ok(artifact.rows.filter((row) => row.reference_gate === "PASS").every(
    (row) => row.components.every((component) => component.authenticity_registry?.selected_reference),
  ));

  const frozen = new Set(artifact.owner_frozen_live_main.map((row) => row.asin));
  assert.deepEqual(frozen, new Set(["B0H8259J9G", "B0H82RQ226", "B0H83R4M3R"]));
  assert.ok(artifact.rows.every((row) => !frozen.has(row.asin)));
  assert.ok(artifact.reference_gap_groups.length > 0);
  assert.ok(artifact.reference_gap_groups.every(
    (group) => group.missing_registry_reference && group.official_project_art_production_eligible === false,
  ));
  assert.ok(artifact.owner_approved_style_fixtures.every(
    (entry) => entry.approval_scope === "style-reference-only" && entry.production_eligible === false,
  ));

  const csvLines = readFileSync(csvPath, "utf8").trimEnd().split("\n");
  assert.equal(csvLines.length, 113);
});
