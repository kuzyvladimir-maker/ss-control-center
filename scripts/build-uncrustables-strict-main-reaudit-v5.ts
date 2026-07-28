#!/usr/bin/env -S node --import tsx

/**
 * Immutable correction of the v2 strict visual audit.
 *
 * The v2 rule that a single flavor must use one uniform carton design was
 * false. Exact mixed-size carton decompositions are truthful when every size
 * is reviewed for the exact flavor. This builder removes that reason from the
 * four affected rows, then preserves the independent live defects found at
 * original resolution. It performs no network, database, model, or channel
 * operation and never overwrites the v2 evidence.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v2.json";
const predecessorFileSha =
  "cdb24a4d4e7765cb9b782bf9f209d370d246e39c89e96f722f20f61a9ed1cac0";
const predecessorBodySha =
  "e345ae8a2727681c59f95eb5fbb6424a28c5922b6a0462d24aeb5087e6551458";
const specPath = "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md";
const specFileSha =
  "641d38e418f14e0550432c388c363045fc319a6fd61b515de7db56e4b9ad3ff2";
const priorCorrectionPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v4.json";
const priorCorrectionFileSha =
  "59f892086d1df69169474e17b317a609f130aa2dc84ed49e26b2fd613b8cf448";
const priorCorrectionBodySha =
  "ed7f2e05f5757cb91d90939adae3e785b41d6e152a2d97a8d3db3c25338a0c44";
const interimCorrectionPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v3.json";
const interimCorrectionFileSha =
  "251e2a23bcb625f441a47453b23b91add4231e5d30c2451bffe4a36fd21a6dee";
const interimCorrectionBodySha =
  "0d1db80385b1168386da85810f8dc2748338f22a2f86d02bf68438c613346890";
const outputStem =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v5";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(localPath: string): string {
  return path.resolve(root, localPath);
}

function fileSha(localPath: string): string {
  return sha256(readFileSync(absolute(localPath)));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface AuditRow {
  ordinal: number;
  sku: string;
  asin: string;
  effective_total_units: number;
  decision: "KEEP" | "REPAIR" | "NEEDS_EVIDENCE";
  severity: string;
  recommendation: string;
  reason_codes: string[];
  observation: string;
  evidence: {
    asset_local_path: string;
    asset_sha256: string;
    width: number;
    height: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PredecessorAudit {
  schema_version: string;
  body_sha256: string;
  summary: Record<string, number>;
  reason_catalog: Record<string, string>;
  methodology: string[];
  sources: Record<string, unknown>;
  rows: AuditRow[];
  newly_discovered_false_keep_ordinals: number[];
  invalid_reuse_donor_ordinals: number[];
  provenance_gate: Record<string, unknown>;
  decision_semantics: Record<string, string>;
}

const predecessorBytes = readFileSync(absolute(predecessorPath));
assert(sha256(predecessorBytes) === predecessorFileSha, "v2 audit file SHA drifted");
const predecessor = JSON.parse(
  predecessorBytes.toString("utf8"),
) as PredecessorAudit;
assert(predecessor.body_sha256 === predecessorBodySha, "v2 audit body SHA drifted");
assert(fileSha(specPath) === specFileSha, "corrected frozen spec SHA drifted");
assert(predecessor.rows.length === 164, "v2 audit no longer has 164 rows");

for (const [label, localPath, expectedFileSha, expectedBodySha] of [
  ["v4 correction", priorCorrectionPath, priorCorrectionFileSha, priorCorrectionBodySha],
  ["v3 interim correction", interimCorrectionPath, interimCorrectionFileSha, interimCorrectionBodySha],
] as const) {
  const bytes = readFileSync(absolute(localPath));
  assert(sha256(bytes) === expectedFileSha, `${label} file SHA drifted`);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const claimed = parsed.body_sha256;
  const body = { ...parsed };
  delete body.body_sha256;
  assert(claimed === expectedBodySha, `${label} body SHA field drifted`);
  assert(sha256(JSON.stringify(body)) === expectedBodySha, `${label} body seal is invalid`);
}

const correctionInputs = new Map<number, {
  flavor_id: string;
  independent_reason_codes: string[];
  observation: string;
  reviewer_finding: string;
}>([
  [1, {
    flavor_id: "peanut-butter-chocolate-spread",
    independent_reason_codes: ["RETAILER_BADGE_VISIBLE"],
    observation:
      "The visually observed exact-flavor cartons reconcile exactly as 10 + 10 + 4 = 24, with no fictional art detected by the original-resolution review. Mixed genuine pack sizes are allowed; the blocking defect is the visible Walmart badge on the package art.",
    reviewer_finding: "AUTHENTIC_CARTONS_EXACT_MATH_RETAILER_BADGE_VISIBLE",
  }],
  [2, {
    flavor_id: "peanut-butter-honey",
    independent_reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "The visually observed exact-flavor cartons reconcile exactly as 10 + 10 + 4 = 24, with no fictional art or retailer badge detected by the original-resolution review. The blocking defect is loose ice/ice chunks visibly filling the cooler below the cartons.",
    reviewer_finding: "AUTHENTIC_CARTONS_EXACT_MATH_LOOSE_ICE_VISIBLE",
  }],
  [38, {
    flavor_id: "chocolate-hazelnut",
    independent_reason_codes: [
      "LOOSE_ICE_VISIBLE",
      "VISIBLE_TEXT_INTEGRITY_FAIL",
    ],
    observation:
      "The visually observed exact-flavor cartons reconcile exactly as 10 + 10 + 4 = 24, with no extra flavor or retailer badge detected. Blue loose ice/ice chunks are visible under and behind the left gel pack/carton area. At original resolution, the 10-count carton corner/top microcopy contains visibly malformed letterforms rather than clean source-art text, and the left interior gel pack’s lower Salutem slogan is visibly distorted. This is a visual rendering-integrity finding; no exact OCR transcription is asserted.",
    reviewer_finding:
      "EXACT_CARTON_MATH_LOOSE_ICE_AND_PACKAGE_KIT_TEXT_INTEGRITY_FAIL",
  }],
  [97, {
    flavor_id: "peanut-butter-chocolate-spread",
    independent_reason_codes: ["RETAILER_BADGE_VISIBLE"],
    observation:
      "The visually observed exact-flavor cartons reconcile exactly as 10 + 10 + 4 = 24, with no fictional art detected by the original-resolution review. Mixed genuine pack sizes are allowed; the blocking defect is the visible Walmart badge on the package art.",
    reviewer_finding: "AUTHENTIC_CARTONS_EXACT_MATH_RETAILER_BADGE_VISIBLE",
  }],
] as const);

const cartonDecompositionObservations: Array<Record<string, unknown>> = [];
const rows = predecessor.rows.map((row) => {
  const correction = correctionInputs.get(row.ordinal);
  if (!correction) return row;
  assert(
    row.reason_codes.includes("MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR"),
    `row ${row.ordinal} no longer contains the false v2 reason`,
  );
  assert(row.effective_total_units === 24, `row ${row.ordinal} total changed`);
  assert(existsSync(absolute(row.evidence.asset_local_path)), `row ${row.ordinal} asset missing`);
  assert(fileSha(row.evidence.asset_local_path) === row.evidence.asset_sha256, `row ${row.ordinal} asset SHA mismatch`);

  // This is an original-resolution observation of the live composite, not a
  // production art-registry extension. Exact independent 10ct/4ct package-art
  // bytes remain required before a future mixed-size generation may run.
  const visiblePackSizes = [10, 10, 4];
  assert(
    visiblePackSizes.reduce((sum, packSize) => sum + packSize, 0) ===
      row.effective_total_units,
    `row ${row.ordinal} visible 10+10+4 observation does not reconcile`,
  );
  cartonDecompositionObservations.push({
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    flavor_id: correction.flavor_id,
    live_main_asset: row.evidence,
    visibly_observed_pack_sizes: visiblePackSizes,
    exact_math_status: "PASS_10_PLUS_10_PLUS_4_EQUALS_24",
    package_art_identity_status:
      "VISUALLY_CONSISTENT_WITH_EXACT_FLAVOR_NO_FICTIONAL_ART_DETECTED",
    production_reference_provenance:
      "NOT_ESTABLISHED_BY_THIS_LIVE_COMPOSITE_OBSERVATION",
    authority:
      "ORIGINAL_RESOLUTION_LIVE_VISUAL_OBSERVATION_ONLY_NOT_A_REVIEWED_ART_REGISTRY_ENTRY_OR_GENERATION_REFERENCE",
    independent_finding: correction.reviewer_finding,
  });
  return {
    ...row,
    decision: "REPAIR" as const,
    severity: "BLOCKING_DEFECT",
    recommendation: "REPAIR_BEFORE_ANY_PUBLISH",
    reason_codes: [...correction.independent_reason_codes],
    observation: correction.observation,
    rule_correction: {
      removed_reason_code: "MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR",
      exact_decomposition: [10, 10, 4],
      visual_decision_changed: false,
    },
  };
});

assert(cartonDecompositionObservations.length === 4, "expected four corrected rows");
assert(
  rows.every((row) => !row.reason_codes.includes("MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR")),
  "obsolete one-design reason remains on a v5 row",
);
assert(rows.filter((row) => row.decision === "KEEP").length === 52, "KEEP partition changed");
assert(rows.filter((row) => row.decision === "REPAIR").length === 112, "REPAIR partition changed");
assert(
  [2, 38].every((ordinal) =>
    rows.find((row) => row.ordinal === ordinal)?.reason_codes.includes("LOOSE_ICE_VISIBLE"),
  ),
  "loose-ice findings are not preserved",
);
assert(
  rows.find((row) => row.ordinal === 38)?.reason_codes.includes(
    "VISIBLE_TEXT_INTEGRITY_FAIL",
  ),
  "ordinal 38 text-integrity finding is not preserved",
);
assert(
  [1, 97].every((ordinal) =>
    JSON.stringify(rows.find((row) => row.ordinal === ordinal)?.reason_codes) ===
      JSON.stringify(["RETAILER_BADGE_VISIBLE"]),
  ),
  "retailer-badge-only findings are not preserved",
);

const retainedReasonCatalog = { ...predecessor.reason_catalog };
delete retainedReasonCatalog.MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR;
const reasonCatalog = {
  ...retainedReasonCatalog,
  LOOSE_ICE_VISIBLE:
    "Loose ice, ice cubes, or ice chunks are visibly present; the frozen MAIN spec permits only sealed gel packs plus subtle frost/condensation.",
  VISIBLE_TEXT_INTEGRITY_FAIL:
    "At original resolution, visible manufacturer package microcopy and/or required Salutem kit wording contains materially malformed letterforms or distorted text rather than clean source-art rendering; this is a visual finding and does not assert an OCR transcription.",
};
const methodology = predecessor.methodology
  .filter((line) => !line.includes("mixed carton sizes do not satisfy"))
  .concat([
    "Corrected the obsolete single-flavor one-design rule: exact mixed-size cartons are permitted when every package design is exact for the flavor and the deterministic reviewed-size plan reconciles with no remainder. This live audit records only visual observations; it does not extend production reference provenance.",
    "Re-opened the four affected pinned original-resolution assets independently: ordinals 1/97 retain retailer badges; ordinals 2/38 contain forbidden loose ice/ice chunks; ordinal 38 additionally contains visibly malformed package microcopy letterforms and distorted gel-pack slogan text. The latter is a visual rendering-integrity finding, not an asserted OCR transcription. Therefore all four remain REPAIR for independent defects.",
  ]);

const summary: Record<string, number> = {
  ...predecessor.summary,
  corrected_false_rule_rows: 4,
  corrected_rows_with_decision_change: 0,
  retailer_badge_only_rows: 2,
  loose_ice_rows: 2,
  visible_text_integrity_rows: 1,
};
const body = {
  schema_version: "uncrustables-live-main-strict-reaudit/v5.0",
  audit_id: "ULMSR-20260718-V5-CARTON-RULE-CORRECTION",
  status: "COMPLETED",
  immutable: true,
  reviewed_at: "2026-07-18T22:52:15Z",
  reviewer: "Codex original-resolution correction review",
  scope:
    "Immutable correction of the false single-flavor uniform-carton rule in v2; all 164 decisions remain fail-closed and the four affected assets were re-opened at original resolution.",
  corrects: {
    path: predecessorPath,
    file_sha256: predecessorFileSha,
    body_sha256: predecessorBodySha,
    superseded_rule_code: "MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR",
    predecessor_preserved: true,
    supersedes_prior_correction: {
      path: priorCorrectionPath,
      file_sha256: priorCorrectionFileSha,
      body_sha256: priorCorrectionBodySha,
      reason:
        "A later original-resolution crop established an additional independent package/kit text-integrity defect on ordinal 38.",
    },
    preserves_verified_interim_chain: {
      path: interimCorrectionPath,
      file_sha256: interimCorrectionFileSha,
      body_sha256: interimCorrectionBodySha,
    },
  },
  decision_semantics: predecessor.decision_semantics,
  provenance_gate: predecessor.provenance_gate,
  methodology,
  sources: {
    predecessor_strict_audit: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
    corrected_frozen_spec: { path: specPath, file_sha256: specFileSha },
    predecessor_sources: predecessor.sources,
  },
  reason_catalog: reasonCatalog,
  summary,
  carton_decomposition_observations: cartonDecompositionObservations,
  newly_discovered_false_keep_ordinals:
    predecessor.newly_discovered_false_keep_ordinals,
  invalid_reuse_donor_ordinals: predecessor.invalid_reuse_donor_ordinals,
  rows,
};
const bodySha = sha256(JSON.stringify(body));
const artifact = { ...body, body_sha256: bodySha };
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const csvHeaders = [
  "ordinal", "sku", "asin", "decision", "severity", "effective_total_units",
  "reason_codes", "asset_sha256", "asset_local_path", "observation",
] as const;
const csvText = `${[
  csvHeaders.join(","),
  ...rows.map((row) => csvHeaders.map((header) => {
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
  "# Uncrustables live MAIN strict re-audit — v5 carton-rule correction",
  "",
  `- Audit ID: \`${body.audit_id}\``,
  `- Reviewed: **${summary.reviewed}**`,
  `- Visual KEEP: **${summary.KEEP}**`,
  `- REPAIR: **${summary.REPAIR}**`,
  `- False mixed-carton reasons removed: **${summary.corrected_false_rule_rows}**`,
  `- Decision changes: **${summary.corrected_rows_with_decision_change}**`,
  `- Body SHA-256: \`${bodySha}\``,
  "",
  "> Exact 10 + 10 + 4 single-flavor carton math is allowed. Ordinals 1/97 remain REPAIR for retailer badges; ordinals 2/38 remain REPAIR for forbidden loose ice. This audit authorizes no marketplace write.",
  "",
  "| Ordinal | SKU | ASIN | Correct v5 reason |",
  "|---:|---|---|---|",
  ...[1, 2, 38, 97].map((ordinal) => {
    const row = rows.find((candidate) => candidate.ordinal === ordinal)!;
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
    assert(readFileSync(absolute(localPath), "utf8") === text, `stale output ${localPath}`);
    assert(readFileSync(absolute(`${localPath}.sha256`), "utf8") === sidecar, `stale sidecar ${localPath}.sha256`);
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
  body_sha256: bodySha,
  summary,
  corrected_ordinals: [1, 2, 38, 97],
  outputs: outputs.map(([localPath]) => localPath),
}, null, 2)}\n`);
