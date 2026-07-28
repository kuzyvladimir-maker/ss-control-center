// node --import tsx --test scripts/__tests__/build-uncrustables-strict-main-reaudit-v8.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const artifactPath = new URL(
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v8.json",
  root,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("v8 exhaustively corrects all confirmed v7 false KEEP decisions", () => {
  const check = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/build-uncrustables-strict-main-reaudit-v8.ts",
      "--check",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const { body_sha256, ...body } = artifact;
  assert.equal(sha256(JSON.stringify(body)), body_sha256);
  assert.equal(artifact.summary.reviewed, 164);
  assert.equal(artifact.summary.KEEP, 30);
  assert.equal(artifact.summary.REPAIR, 134);
  assert.equal(artifact.summary.corrected_false_keep_rows, 30);
  assert.equal(
    artifact.exhaustive_keep_correction.reviewed_keep_ordinals.length,
    60,
  );
  assert.equal(
    artifact.exhaustive_keep_correction.reclassified_ordinals.length,
    30,
  );
  assert.equal(
    artifact.exhaustive_keep_correction.retained_keep_ordinals.length,
    30,
  );

  const rows = new Map<
    number,
    { decision: string; reason_codes: string[]; recommendation: string }
  >(
    artifact.rows.map(
      (row: {
        ordinal: number;
        decision: string;
        reason_codes: string[];
        recommendation: string;
      }) => [row.ordinal, row],
    ),
  );
  for (const ordinal of [15, 18, 28, 32, 37, 43, 44, 53, 56, 57, 64, 75, 85, 88, 93, 107, 117, 118, 120, 121, 125, 126, 127, 128, 137, 149, 150, 152, 155, 158]) {
    assert.equal(rows.get(ordinal)?.decision, "REPAIR", `ordinal ${ordinal}`);
    assert.ok((rows.get(ordinal)?.reason_codes.length ?? 0) > 0, `ordinal ${ordinal}`);
    assert.equal(
      rows.get(ordinal)?.recommendation,
      "REPAIR_BEFORE_ANY_PUBLISH",
      `ordinal ${ordinal}`,
    );
  }
  assert.ok(rows.get(75)?.reason_codes.includes("UNPROVEN_VARIANT_SUBSTITUTION"));
  assert.ok(rows.get(120)?.reason_codes.includes("UNPROVEN_VARIANT_SUBSTITUTION"));
  assert.ok(rows.get(127)?.reason_codes.includes("FICTIONAL_OR_ALTERED_PACKAGE_ART"));
  assert.ok(rows.get(137)?.reason_codes.includes("VISIBLE_TEXT_INTEGRITY_FAIL"));
  assert.ok(rows.get(85)?.reason_codes.includes("GEL_PACK_COUNT_OR_LAYOUT_FAIL"));
  assert.equal(artifact.provenance_gate.marketplace_write_authorized, false);
  assert.ok(
    artifact.rows.every((row: { decision: string; reason_codes: string[] }) =>
      row.decision === "KEEP"
        ? row.reason_codes.length === 0
        : row.reason_codes.length > 0,
    ),
  );
});
