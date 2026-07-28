#!/usr/bin/env -S node --import tsx

/**
 * Immutable policy correction for strict MAIN re-audit v6.
 *
 * v6 treated every visible retailer badge as a forbidden overlay. The pinned
 * manufacturer references prove that the affected Target/Walmart marks are
 * printed parts of genuine retail cartons. This correction removes that false
 * defect from all 13 affected rows, promotes the 8 rows with no residual
 * defect to KEEP, and records the independently visible loose ice on ordinal
 * 30. No image generation or marketplace operation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6.json";
const predecessorFileSha =
  "87d9adf66cc322becccd0eb214e13d073272c3c11405e4bdd15e93c98f08eb4c";
const predecessorBodySha =
  "befae9606c9dca01175c555f181cfcff53bd248aa5060ee2194e3e611739ff8e";
const outputStem =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v7";

const referenceEvidence = [
  {
    role: "AUTHENTIC_TARGET_PRINTED_MARK_REFERENCE",
    path: "data/audits/uncrustables-approved-reference-qa-20260718/product-morning-protein-mixed-berry-target.jpg",
    sha256: "177f2e781d838ff4f7076608ed78f6ec52d46b81efda9754593c6ddd54721f0e",
  },
  {
    role: "OFFICIAL_MANUFACTURER_WALMART_PRINTED_MARK_REFERENCE_CHOCOLATE_SPREAD",
    path: "data/audits/uncrustables-official-package-art-20260718/peanut-butter-chocolate-spread-front-center.jpg",
    sha256: "5a000b78c6b6b5a99b1aab7d2f0db5652477c28ac504de3bd5c5c5a02071fe45",
  },
  {
    role: "OFFICIAL_MANUFACTURER_WALMART_PRINTED_MARK_REFERENCE_RED_WHITE_BERRY",
    path: "data/audits/uncrustables-official-package-art-20260718/red-white-and-berry-limited-front-center.jpg",
    sha256: "04729891f4bee28be397af04125652f5c7b136c45c0b557f9fab57ed3096d8d7",
  },
] as const;

const badgeAffectedOrdinals = [
  1, 22, 30, 31, 33, 74, 75, 97, 129, 131, 141, 159, 161,
] as const;
const promotedKeepOrdinals = [1, 22, 31, 33, 74, 75, 97, 129] as const;

interface StrictRow {
  ordinal: number;
  sku: string;
  asin: string;
  decision: string;
  severity: string;
  effective_total_units: number;
  reason_codes: string[];
  observation: string;
  recommendation: string;
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
  methodology: string[];
  reason_catalog: Record<string, string>;
  corrects: Record<string, unknown>;
  sources: Record<string, unknown>;
  summary: Record<string, number>;
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
  "v6 strict audit file SHA drifted",
);
const predecessor = JSON.parse(
  predecessorBytes.toString("utf8"),
) as StrictArtifact;
const predecessorBody = { ...predecessor };
delete (predecessorBody as Partial<StrictArtifact>).body_sha256;
assert(predecessor.body_sha256 === predecessorBodySha, "v6 body SHA changed");
assert(
  sha256(JSON.stringify(predecessorBody)) === predecessorBodySha,
  "v6 nested body seal is invalid",
);
assert(predecessor.rows.length === 164, "v6 must contain 164 rows");
assert(
  predecessor.summary.KEEP === 52 && predecessor.summary.REPAIR === 112,
  "v6 strict partition drifted",
);
for (const reference of referenceEvidence) {
  assert(
    sha256(readFileSync(absolute(reference.path))) === reference.sha256,
    `${reference.role} SHA drifted`,
  );
}

const badgeAffected = predecessor.rows.filter((row) =>
  row.reason_codes.includes("RETAILER_BADGE_VISIBLE"),
);
assert(
  JSON.stringify(badgeAffected.map((row) => row.ordinal)) ===
    JSON.stringify(badgeAffectedOrdinals),
  "v6 retailer-badge cohort drifted",
);

const promotedSet = new Set<number>(promotedKeepOrdinals);
const residualObservations = new Map<number, string>([
  [
    30,
    "Three genuine 10-count Peanut Butter & Chocolate Flavored Spread cartons reconcile exactly to 30, and the Walmart mark is authentic manufacturer-printed package art. Blue loose ice/chunks remain visibly exposed under and behind the left interior gel pack, so the row still requires repair.",
  ],
  [
    131,
    "Two genuine 8-count cartons per component communicate 16 + 16 rather than the required 12 + 12. The printed Target mark is authentic package art and is not a defect; the count mismatch remains blocking.",
  ],
  [
    141,
    "Two genuine 8-count cartons per component communicate 16 + 16 rather than the required 12 + 12. The printed Target mark is authentic package art and is not a defect; the count mismatch remains blocking.",
  ],
  [
    159,
    "Peanut Butter reconciles as 3 x 4 = 12, but Beamin' Berry is shown as 2 x 8 = 16 rather than 12. The printed Target mark is authentic package art and is not a defect; the count mismatch remains blocking.",
  ],
  [
    161,
    "Whole Wheat Strawberry reconciles as 3 x 4 = 12, but Beamin' Berry is shown as 2 x 8 = 16 rather than 12. The printed Target mark is authentic package art and is not a defect; the count mismatch remains blocking.",
  ],
]);

const rows = predecessor.rows.map((row): StrictRow => {
  if (!row.reason_codes.includes("RETAILER_BADGE_VISIBLE")) return row;
  const remainingReasons = row.reason_codes.filter(
    (code) => code !== "RETAILER_BADGE_VISIBLE",
  );
  if (promotedSet.has(row.ordinal)) {
    assert(remainingReasons.length === 0, `row ${row.ordinal} has residual reasons`);
    return {
      ...row,
      decision: "KEEP",
      severity: "VISUAL_PASS",
      reason_codes: [],
      observation:
        "Original-resolution review and the pinned exact package-art reference confirm genuine manufacturer-printed retailer-exclusive carton markings, exact visible count math, the approved cooler/Salutem scene, exactly 2 inside + 2 outside gel packs, and no residual blocking visual defect.",
      recommendation: "KEEP_LIVE_PENDING_PROVENANCE_GATE",
    };
  }
  if (row.ordinal === 30) {
    assert(remainingReasons.length === 0, "row 30 reason set drifted");
    return {
      ...row,
      reason_codes: ["LOOSE_ICE_VISIBLE"],
      observation: residualObservations.get(30)!,
    };
  }
  assert(
    remainingReasons.length === 1 &&
      remainingReasons[0] === "CARTON_COUNT_MATH_MISMATCH",
    `row ${row.ordinal} residual reason set drifted`,
  );
  return {
    ...row,
    reason_codes: remainingReasons,
    observation: residualObservations.get(row.ordinal)!,
  };
});

assert(rows.filter((row) => row.decision === "KEEP").length === 60, "v7 KEEP must be 60");
assert(rows.filter((row) => row.decision === "REPAIR").length === 104, "v7 REPAIR must be 104");
assert(
  rows.every((row) => !row.reason_codes.includes("RETAILER_BADGE_VISIBLE")),
  "deprecated retailer badge code remains",
);
assert(
  JSON.stringify(rows.find((row) => row.ordinal === 30)?.reason_codes) ===
    JSON.stringify(["LOOSE_ICE_VISIBLE"]),
  "row 30 must retain the independently visible loose-ice defect",
);

const reasonCatalog = { ...predecessor.reason_catalog };
delete reasonCatalog.RETAILER_BADGE_VISIBLE;
const { metadata_correction: predecessorMetadataCorrection, ...predecessorCore } =
  predecessorBody as StrictArtifact & { metadata_correction?: unknown };
const body = {
  ...predecessorCore,
  schema_version: "uncrustables-live-main-strict-reaudit/v7.0",
  audit_id: "ULMSR-20260718-V7-AUTHENTIC-RETAILER-MARK-CORRECTION",
  reviewed_at: "2026-07-18T23:56:27Z",
  scope:
    "Immutable policy correction of v6: manufacturer-printed retailer-exclusive marks supported by exact package-art references are product markings, not overlays. Removes the false retailer-badge defect from 13 rows, promotes 8 rows with no residual defect to KEEP, and preserves or records every independent defect.",
  methodology: [
    "Read the complete frozen MAIN Image Spec v2.0 and the v6 immutable audit.",
    "Re-opened all 13 original-resolution assets carrying RETAILER_BADGE_VISIBLE and checked count math, loose ice, physical seating, gel-pack count/branding, cooler branding, flavor identity, and visible package integrity independently of the badge.",
    "Compared the observed Target/Walmart marks against the pinned exact manufacturer/package references.",
    "Classified a retailer mark printed on authentic product packaging as part of the product. A model-added overlay, mismatched retailer mark, or altered package remains forbidden under the existing fictional/altered-art rules.",
    "Confirmed eight rows have no residual defect; ordinal 30 retains visible loose ice; ordinals 131/141/159/161 retain carton-count math mismatches.",
    "No generation, Amazon read/write, ChannelMAX read/write, database operation, or object-store operation was performed.",
  ],
  reason_catalog: reasonCatalog,
  corrects: {
    ...predecessor.corrects,
    supersedes_prior_correction: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
      reason:
        "v6 incorrectly treated authentic manufacturer-printed retailer-exclusive package markings as prohibited overlays.",
    },
  },
  sources: {
    ...predecessor.sources,
    prior_terminal_correction: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
    authentic_retailer_mark_references: referenceEvidence,
  },
  summary: {
    ...predecessor.summary,
    KEEP: 60,
    REPAIR: 104,
    corrected_false_rule_rows: 13,
    corrected_rows_with_decision_change: 8,
    retailer_badge_only_rows: 0,
    loose_ice_rows: 3,
  },
  rows,
  predecessor_metadata_correction: predecessorMetadataCorrection,
  policy_correction: {
    predecessor_path: predecessorPath,
    predecessor_file_sha256: predecessorFileSha,
    predecessor_body_sha256: predecessorBodySha,
    affected_ordinals: badgeAffectedOrdinals,
    promoted_keep_ordinals: promotedKeepOrdinals,
    residual_loose_ice_ordinal: 30,
    residual_count_mismatch_ordinals: [131, 141, 159, 161],
    decision_changes: 8,
    external_reads: 0,
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
  "# Uncrustables live MAIN strict re-audit — v7 retailer-mark correction",
  "",
  `- Audit ID: \`${body.audit_id}\``,
  `- Reviewed at: **${body.reviewed_at}**`,
  "- Reviewed: **164**",
  "- Visual KEEP: **60**",
  "- REPAIR: **104**",
  "- Decisions changed from v6: **8 REPAIR → KEEP**",
  `- Body SHA-256: \`${bodySha}\``,
  "",
  "> Genuine manufacturer-printed Target/Walmart markings are package art, not overlays. Ordinal 30 remains REPAIR for visible loose ice; ordinals 131/141/159/161 remain REPAIR for count math. This audit authorizes no marketplace write.",
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
  summary: body.summary,
}, null, 2)}\n`);
