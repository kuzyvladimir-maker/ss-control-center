#!/usr/bin/env -S node --import tsx

/**
 * Terminal immutable metadata correction for strict MAIN re-audit v5.
 *
 * v5 contains the final visual decisions and row-38 integrity finding, but its
 * review timestamp predates that finding and its chain note refers to an
 * unpinned working crop. v6 pins v5 byte-for-byte, corrects only those record
 * fields, and preserves all 164 decisions. No image generation or marketplace
 * operation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v5.json";
const predecessorFileSha =
  "19868f5dec6bc81d1a94c3248cb8a7ba29e3a4854ea255cfc3df9636a8af415f";
const predecessorBodySha =
  "a562c9c1b79d555712124e8e644210f7bc2d2aac7b4bc1549a88712f5c0d649c";
const outputStem =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6";

interface StrictRow {
  ordinal: number;
  sku: string;
  asin: string;
  decision: string;
  severity: string;
  effective_total_units: number;
  reason_codes: string[];
  observation: string;
  evidence: {
    asset_sha256: string;
    asset_local_path: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface StrictArtifact {
  schema_version: string;
  audit_id: string;
  immutable: boolean;
  reviewed_at: string;
  corrects: Record<string, unknown>;
  sources: Record<string, unknown>;
  summary: {
    reviewed: number;
    KEEP: number;
    REPAIR: number;
    corrected_false_rule_rows: number;
    corrected_rows_with_decision_change: number;
    [key: string]: unknown;
  };
  rows: StrictRow[];
  body_sha256: string;
  [key: string]: unknown;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(localPath: string): string {
  return path.resolve(root, localPath);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const predecessorBytes = readFileSync(absolute(predecessorPath));
assert(
  sha256(predecessorBytes) === predecessorFileSha,
  "v5 strict audit file SHA drifted",
);
const predecessor = JSON.parse(
  predecessorBytes.toString("utf8"),
) as StrictArtifact;
const predecessorBody = { ...predecessor };
delete (predecessorBody as Partial<StrictArtifact>).body_sha256;
assert(
  predecessor.body_sha256 === predecessorBodySha,
  "v5 strict audit body SHA changed",
);
assert(
  sha256(JSON.stringify(predecessorBody)) === predecessorBodySha,
  "v5 strict audit nested seal is invalid",
);
assert(
  predecessor.schema_version === "uncrustables-live-main-strict-reaudit/v5.0",
  "unexpected predecessor schema",
);
assert(predecessor.immutable === true, "v5 predecessor is not immutable");
assert(predecessor.rows.length === 164, "v5 predecessor must cover 164 rows");
assert(
  predecessor.summary.reviewed === 164 &&
    predecessor.summary.KEEP === 52 &&
    predecessor.summary.REPAIR === 112,
  "v5 strict partition drifted",
);
assert(
  predecessor.rows.every((row) =>
    !row.reason_codes.includes("MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR")),
  "obsolete mixed-carton rule remains on v5",
);

const expectedReasons = new Map<number, string[]>([
  [1, ["RETAILER_BADGE_VISIBLE"]],
  [2, ["LOOSE_ICE_VISIBLE"]],
  [38, ["LOOSE_ICE_VISIBLE", "VISIBLE_TEXT_INTEGRITY_FAIL"]],
  [97, ["RETAILER_BADGE_VISIBLE"]],
]);
for (const [ordinal, expected] of expectedReasons) {
  const row = predecessor.rows.find((candidate) => candidate.ordinal === ordinal);
  assert(row, `v5 row ${ordinal} is missing`);
  assert(
    JSON.stringify(row.reason_codes) === JSON.stringify(expected),
    `v5 row ${ordinal} reason set drifted`,
  );
}

const correctedChainReason =
  "A later review of the pinned original-resolution asset established an additional independent package/kit text-integrity defect on ordinal 38.";
const body = {
  ...predecessorBody,
  schema_version: "uncrustables-live-main-strict-reaudit/v6.0",
  audit_id: "ULMSR-20260718-V6-TERMINAL-METADATA-CORRECTION",
  reviewed_at: "2026-07-18T23:10:00Z",
  scope:
    "Terminal immutable metadata correction of v5: records the ordinal-38 re-review time and identifies the pinned original-resolution asset, while preserving all 164 visual decisions and the 52 KEEP / 112 REPAIR partition.",
  corrects: {
    ...predecessor.corrects,
    supersedes_prior_correction: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
      reason: correctedChainReason,
    },
  },
  sources: {
    ...predecessor.sources,
    prior_terminal_correction: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
  },
  metadata_correction: {
    predecessor_path: predecessorPath,
    predecessor_file_sha256: predecessorFileSha,
    predecessor_body_sha256: predecessorBodySha,
    corrected_fields: [
      "reviewed_at",
      "corrects.supersedes_prior_correction",
    ],
    visual_decisions_changed: 0,
    queue_membership_changed: false,
    external_mutations: 0,
  },
};
const bodySha = sha256(JSON.stringify(body));
const artifact = { ...body, body_sha256: bodySha };
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;

const csvHeaders = [
  "ordinal", "sku", "asin", "decision", "severity", "effective_total_units",
  "reason_codes", "asset_sha256", "asset_local_path", "observation",
] as const;
const csvText = `${[
  csvHeaders.join(","),
  ...predecessor.rows.map((row) => csvHeaders.map((header) => {
    const value = header === "reason_codes"
      ? row.reason_codes.join("|")
      : header === "asset_sha256"
        ? row.evidence.asset_sha256
        : header === "asset_local_path"
          ? row.evidence.asset_local_path
          : row[header];
    return csvCell(value);
  }).join(",")),
].join("\n")}\n`;

const markdown = [
  "# Uncrustables live MAIN strict re-audit — v6 terminal record",
  "",
  `- Audit ID: \`${body.audit_id}\``,
  `- Reviewed at: **${body.reviewed_at}**`,
  `- Reviewed: **${predecessor.summary.reviewed}**`,
  `- Visual KEEP: **${predecessor.summary.KEEP}**`,
  `- REPAIR: **${predecessor.summary.REPAIR}**`,
  `- Decision changes from v5: **0**`,
  `- Body SHA-256: \`${bodySha}\``,
  "",
  "> Exact 10 + 10 + 4 single-flavor carton math is allowed. Ordinals 1/97 remain REPAIR for retailer badges; ordinal 2 remains REPAIR for forbidden loose ice; ordinal 38 remains REPAIR for loose ice and visible text-integrity defects. This audit authorizes no marketplace write.",
  "",
  "| Ordinal | SKU | ASIN | Correct v6 reason |",
  "|---:|---|---|---|",
  ...[1, 2, 38, 97].map((ordinal) => {
    const row = predecessor.rows.find((candidate) => candidate.ordinal === ordinal)!;
    return `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.reason_codes.join(", ")} |`;
  }),
  "",
].join("\n");

const outputs = [
  [`${outputStem}.json`, jsonText],
  [`${outputStem}.csv`, csvText],
  [`${outputStem}.md`, markdown],
] as const;
for (const [localPath, text] of outputs) {
  const sidecar = `${sha256(text)}  ${path.basename(localPath)}\n`;
  if (checkOnly) {
    assert(existsSync(absolute(localPath)), `missing output ${localPath}`);
    assert(
      readFileSync(absolute(localPath), "utf8") === text,
      `stale output ${localPath}`,
    );
    assert(
      readFileSync(absolute(`${localPath}.sha256`), "utf8") === sidecar,
      `stale sidecar ${localPath}.sha256`,
    );
  } else {
    writeFileSync(absolute(localPath), text);
    writeFileSync(absolute(`${localPath}.sha256`), sidecar);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  check_only: checkOnly,
  external_reads: 0,
  external_mutations: 0,
  predecessor_file_sha256: predecessorFileSha,
  body_sha256: bodySha,
  summary: predecessor.summary,
}, null, 2)}\n`);
