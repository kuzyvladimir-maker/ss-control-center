#!/usr/bin/env -S node --import tsx

/**
 * Immutable exhaustive correction of the v7 MAIN audit.
 *
 * Every one of v7's 60 KEEP rows was re-opened at original resolution. Two
 * independent passes checked exact variant identity, visible package/count
 * arithmetic, loose ice, exact 2+2 gel-pack layout, package-art integrity, and
 * physical scene compliance. Thirty false KEEP decisions are corrected here.
 * No generation, network request, or marketplace/database mutation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v7.json";
const predecessorFileSha =
  "4113b64013fef51c345b904bbebd46ed78c646396d8ff6937c6c7ffa9393c637";
const predecessorBodySha =
  "f5edfd2b655e83cca1c10549db1b064fd34187a6e865e431ba4ff8be05b44290";
const frozenSpecPath = "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md";
const frozenSpecFileSha =
  "331ce50e375910ae58a4908bfa8d815874bc29b29f6d8014dd4a4f662cfb8e84";
const outputStem =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v8";

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
  sources: Record<string, unknown>;
  summary: Record<string, number>;
  rows: StrictRow[];
  body_sha256: string;
  [key: string]: unknown;
}

interface Correction {
  ordinal: number;
  sku: string;
  asin: string;
  reason_codes: string[];
  observation: string;
}

const corrections: Correction[] = [
  {
    ordinal: 15,
    sku: "BK-AS5Z-8UY5",
    asin: "B0H85JF1V1",
    reason_codes: ["WRONG_FLAVOR_VISIBLE", "MISSING_RECIPE_COMPONENT"],
    observation:
      "Whole Wheat Strawberry is correctly shown as 3 x 4 = 12, but the second component is 3 x 4 regular Peanut Butter & Grape Jelly; required Blackberry is absent.",
  },
  {
    ordinal: 18,
    sku: "BX-AS5P-6WQV",
    asin: "B0H83NM5PX",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH", "LOOSE_ICE_VISIBLE"],
    observation:
      "Eleven 8-count Blueberry cartons communicate 88 rather than 120 (15 required), and loose ice/chunks are visible beside the left interior gel pack.",
  },
  {
    ordinal: 28,
    sku: "EJ-ASCD-8K87",
    asin: "B0H82PXWKS",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Six 10-count Raspberry cartons communicate 60 rather than 90 (nine required).",
  },
  {
    ordinal: 32,
    sku: "EW-ASWP-PMZX",
    asin: "B0H891WSZ9",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Two 4-count Strawberry cartons communicate 8 rather than 30; a 4-count-only carton plan also cannot decompose 30 exactly.",
  },
  {
    ordinal: 37,
    sku: "FN-ASVM-UWAG",
    asin: "B0H85J88LJ",
    reason_codes: ["MISSING_RECIPE_COMPONENT", "WRONG_NUTRITION_OR_VARIANT_TEXT"],
    observation:
      "Peanut Butter reconciles as 3 x 4 = 12, but the grape cartons are regular Peanut Butter & Grape Jelly without Whole Wheat/Reduced Sugar identity; the exact required Whole Wheat Grape component is absent.",
  },
  {
    ordinal: 43,
    sku: "GR-AS1P-DBB2",
    asin: "B0H82S7TFG",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Sixteen visible 4-count Grape cartons communicate 64 rather than 24 (six required).",
  },
  {
    ordinal: 44,
    sku: "GU-ASQ1-S7M6",
    asin: "B0H828GQLP",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "Two genuine 15-count Raspberry cartons reconcile to 30, but loose translucent ice is visibly exposed along the cooler base.",
  },
  {
    ordinal: 53,
    sku: "JH-ASV9-Z46X",
    asin: "B0H8369PMK",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "Three 8-count Up & Apple cartons reconcile to 24, but loose ice/chunks are visible at the base and behind the left gel pack.",
  },
  {
    ordinal: 56,
    sku: "JT-ASKD-KS8T",
    asin: "B0H83Z6S3Q",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Twelve 4-count Grape cartons communicate 48 rather than 120 (30 required).",
  },
  {
    ordinal: 57,
    sku: "JU-ASM0-KV4Z",
    asin: "B0H8462L4S",
    reason_codes: [
      "WRONG_FLAVOR_VISIBLE",
      "MISSING_RECIPE_COMPONENT",
      "WRONG_NUTRITION_OR_VARIANT_TEXT",
    ],
    observation:
      "The image shows 3 x 4 plain Peanut Butter plus 3 x 4 regular Grape Jelly. The exact recipe is Raspberry 12 plus Whole Wheat/Reduced Sugar Grape 12, so both required components are absent despite a coincidental total of 24.",
  },
  {
    ordinal: 64,
    sku: "LJ-ASYO-FWJK",
    asin: "B0H853SHVC",
    reason_codes: [
      "CARTON_COUNT_MATH_MISMATCH",
      "MISSING_RECIPE_COMPONENT",
      "WRONG_NUTRITION_OR_VARIANT_TEXT",
    ],
    observation:
      "Three regular Strawberry 4-count cartons are shown instead of Whole Wheat/Reduced Sugar Strawberry, and the three Hazelnut cartons do not form the required exact 12-unit component plan; the visible multiset is not 12 + 12.",
  },
  {
    ordinal: 75,
    sku: "NS-ASSD-B3JJ",
    asin: "B0H82L945T",
    reason_codes: ["UNPROVEN_VARIANT_SUBSTITUTION"],
    observation:
      "Six genuine seasonal Red, White & Berry 4-count cartons reconcile to 24, but the ledger recipe resolves to the legacy Berry Burst/Mixed Berry edition. Exact edition equivalence is not approved in the product-truth registry, so the seasonal substitution cannot pass fail-closed identity review.",
  },
  {
    ordinal: 85,
    sku: "PU-AS3D-SA5Z",
    asin: "B0H83H71F8",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH", "GEL_PACK_COUNT_OR_LAYOUT_FAIL"],
    observation:
      "Eight 10-count Hazelnut cartons communicate 80 rather than 120, and five gel packs are visible (three inside plus two outside) rather than the exact approved 2 + 2 layout.",
  },
  {
    ordinal: 88,
    sku: "QC-ASX2-RHPA",
    asin: "B0H83TQPJB",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Sixteen 4-count Whole Wheat Grape cartons communicate 64 rather than 120 (30 required).",
  },
  {
    ordinal: 93,
    sku: "QX-ASS6-4T4F",
    asin: "B0H83B6TYP",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Six 10-count Hazelnut cartons communicate 60 rather than 90 (nine required).",
  },
  {
    ordinal: 107,
    sku: "RZ-AS26-WLRM",
    asin: "B0H85PJ516",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Only two genuine 4-count Blackberry cartons are visible (8 units) beside three Hazelnut cartons; the required exact 12 + 12 component multiset is not present.",
  },
  {
    ordinal: 117,
    sku: "SZ-ASPI-JFAT",
    asin: "B0H776M5B5",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Four 4-count Blackberry cartons communicate 16 rather than the declared pack of six cartons / 24 sandwiches.",
  },
  {
    ordinal: 118,
    sku: "TH-AS6D-CCES",
    asin: "B0H845HSDZ",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "Three Raspberry 4-count plus three Hazelnut 4-count cartons reconcile to 12 + 12, but large blue loose-ice chunks are visible at the left base.",
  },
  {
    ordinal: 120,
    sku: "TP-AS91-8PAZ",
    asin: "B0H835T5HN",
    reason_codes: ["UNPROVEN_VARIANT_SUBSTITUTION", "LOOSE_ICE_VISIBLE"],
    observation:
      "Thirty seasonal Red, White & Berry wrappers are shown for a ledger recipe that resolves to the legacy Berry Burst/Mixed Berry edition; exact edition/wrapper equivalence is not approved, and loose ice is visibly spread across the cooler floor.",
  },
  {
    ordinal: 121,
    sku: "TQ-ASBR-96TC",
    asin: "B0H82BCZ44",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "Three 8-count Blueberry cartons reconcile to 24, but loose ice chunks are visible beneath and around the cartons and gel packs.",
  },
  {
    ordinal: 125,
    sku: "UD-AS9J-QNY6",
    asin: "B0H834L7P6",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "The Honey cartons are visibly standing on a granular/crushed loose-ice bed, which is forbidden even independently of any overlapping-carton count ambiguity.",
  },
  {
    ordinal: 126,
    sku: "UE-ASA6-CLLY",
    asin: "B0H83ZHZ4S",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH", "GEL_PACK_COUNT_OR_LAYOUT_FAIL"],
    observation:
      "Three Raspberry 10-count plus three Blackberry 4-count cartons communicate 30 + 12 rather than 12 + 12; five gel packs are visible (three inside plus two outside), not the exact approved four.",
  },
  {
    ordinal: 127,
    sku: "UF-ASA1-GN5P",
    asin: "B0H854DM3X",
    reason_codes: ["FICTIONAL_OR_ALTERED_PACKAGE_ART", "LOOSE_ICE_VISIBLE"],
    observation:
      "Peanut Butter reconciles as 3 x 4 = 12, but Strawberry uses an unreviewed/internally inconsistent synthetic 2-count carton beside a 10-count carton; blue loose-ice cubes are also exposed beneath the products.",
  },
  {
    ordinal: 128,
    sku: "UG-ASUO-L4D9",
    asin: "B0H83FP8WW",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Six 4-count Strawberry cartons communicate 24 rather than 90; a 4-count-only carton plan also cannot decompose 90 exactly.",
  },
  {
    ordinal: 137,
    sku: "VN-AS6Q-5AE9",
    asin: "B0H8538L32",
    reason_codes: ["FICTIONAL_OR_ALTERED_PACKAGE_ART", "VISIBLE_TEXT_INTEGRITY_FAIL"],
    observation:
      "The product/count multiset reconciles, but the repeated white-blue top-panel seals are materially changed into circular glyphs instead of the exact reviewed scalloped 'UNBEATABLY SOFT BREAD' manufacturer mark; exact package-art comparison therefore fails.",
  },
  {
    ordinal: 149,
    sku: "XV-ASEU-GDUX",
    asin: "B0H82YRTS3",
    reason_codes: ["VISIBLE_UNIT_COUNT_NOT_RECONCILED"],
    observation:
      "Exactly 24 Morning Protein Mixed Berry individual wrappers are visible (4 x 6), not the required 45.",
  },
  {
    ordinal: 150,
    sku: "XW-ASSI-SZZT",
    asin: "B0H858GF4N",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Three Honey 10-count plus three Peanut Butter 4-count cartons communicate 30 + 12 rather than the required 12 + 12.",
  },
  {
    ordinal: 152,
    sku: "YF-ASZJ-8BBH",
    asin: "B0H822MPKC",
    reason_codes: ["LOOSE_ICE_VISIBLE"],
    observation:
      "Three Honey 10-count cartons reconcile to 30, but loose gray-blue ice chunks are visible beneath and between the cartons.",
  },
  {
    ordinal: 155,
    sku: "YM-AS7P-ZX44",
    asin: "B0H83S1LDG",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "The overlapping 4-count Blackberry carton grid does not resolve to the exact 30 cartons required for 120; exact visible count arithmetic is not established and therefore fails closed.",
  },
  {
    ordinal: 158,
    sku: "ZC-ASDC-3QMV",
    asin: "B0H83TSB5J",
    reason_codes: ["CARTON_COUNT_MATH_MISMATCH"],
    observation:
      "Eight 4-count Strawberry cartons communicate 32 rather than 120 (30 required).",
  },
];

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
assert(sha256(predecessorBytes) === predecessorFileSha, "v7 file SHA drifted");
const predecessor = JSON.parse(
  predecessorBytes.toString("utf8"),
) as StrictArtifact;
const predecessorBody = { ...predecessor };
delete (predecessorBody as Partial<StrictArtifact>).body_sha256;
assert(predecessor.body_sha256 === predecessorBodySha, "v7 body SHA changed");
assert(
  sha256(JSON.stringify(predecessorBody)) === predecessorBodySha,
  "v7 nested body seal is invalid",
);
assert(predecessor.rows.length === 164, "v7 must cover 164 rows");
assert(
  predecessor.summary.KEEP === 60 && predecessor.summary.REPAIR === 104,
  "v7 partition drifted",
);
assert(
  sha256(readFileSync(absolute(frozenSpecPath))) === frozenSpecFileSha,
  "frozen spec SHA drifted",
);
assert(corrections.length === 30, "expected exactly 30 false KEEP corrections");
assert(
  new Set(corrections.map((item) => item.ordinal)).size === corrections.length,
  "duplicate correction ordinal",
);

const correctionByOrdinal = new Map(corrections.map((item) => [item.ordinal, item]));
for (const correction of corrections) {
  const prior = predecessor.rows.find((row) => row.ordinal === correction.ordinal);
  assert(prior, `missing predecessor row ${correction.ordinal}`);
  assert(prior.decision === "KEEP", `row ${correction.ordinal} was not v7 KEEP`);
  assert(prior.reason_codes.length === 0, `row ${correction.ordinal} had v7 reasons`);
  assert(prior.sku === correction.sku, `row ${correction.ordinal} SKU drifted`);
  assert(prior.asin === correction.asin, `row ${correction.ordinal} ASIN drifted`);
  assert(
    correction.reason_codes.every((code) =>
      code === "UNPROVEN_VARIANT_SUBSTITUTION" || code in predecessor.reason_catalog
    ),
    `row ${correction.ordinal} uses an unknown reason code`,
  );
}

const rows = predecessor.rows.map((row): StrictRow => {
  const correction = correctionByOrdinal.get(row.ordinal);
  if (!correction) return row;
  return {
    ...row,
    decision: "REPAIR",
    severity: "BLOCKING_DEFECT",
    reason_codes: correction.reason_codes,
    observation: correction.observation,
    recommendation: "REPAIR_BEFORE_ANY_PUBLISH",
  };
});

assert(rows.filter((row) => row.decision === "KEEP").length === 30, "v8 KEEP must be 30");
assert(rows.filter((row) => row.decision === "REPAIR").length === 134, "v8 REPAIR must be 134");
assert(
  rows.every((row) =>
    row.decision === "KEEP"
      ? row.reason_codes.length === 0 && row.severity === "VISUAL_PASS"
      : row.reason_codes.length > 0 && row.severity === "BLOCKING_DEFECT"
  ),
  "decision/reason invariant failed",
);

const reasonCatalog = {
  ...predecessor.reason_catalog,
  UNPROVEN_VARIANT_SUBSTITUTION:
    "A visible real package edition may be related to the recipe but exact variant/edition equivalence is not approved in Product Truth; fail closed rather than substitute by similarity.",
};
const reasonCounts = Object.fromEntries(
  Object.keys(reasonCatalog)
    .sort()
    .map((code) => [
      code,
      rows.filter((row) => row.reason_codes.includes(code)).length,
    ]),
);
const body = {
  ...predecessorBody,
  schema_version: "uncrustables-live-main-strict-reaudit/v8.0",
  audit_id: "ULMSR-20260718-V8-EXHAUSTIVE-KEEP-REVALIDATION",
  reviewed_at: "2026-07-19T00:35:37Z",
  scope:
    "Immutable exhaustive correction of v7 after every one of its 60 KEEP rows was re-opened at original resolution against exact recipe identity, visible package arithmetic, package art, loose-ice, frozen-kit, gel-pack, and physical-scene rules.",
  methodology: [
    "Read the complete frozen MAIN Image Spec v2.0 and pinned the corrected rule that genuine manufacturer-printed retailer-exclusive package art is allowed only when tied to exact reviewed evidence; model-added or mismatched marks remain forbidden.",
    "Re-opened all 60 v7 KEEP assets at original resolution in two independent visual passes.",
    "For each row, reconciled exact recipe variant, per-component quantity, visible carton/wrapper count and genuine printed retail pack size rather than accepting the aggregate object count.",
    "Independently checked exactly two branded gel packs inside plus two outside, no loose ice, exact cooler/Salutem scene, physical seating, and package-art/text integrity.",
    "Resolved reviewer disagreements fail-closed by direct original-resolution comparison to pinned official package art; this added ordinal 137 for materially altered top-panel art and preserved ordinals 75/120 as unproven edition substitutions rather than assuming equivalence.",
    "No image generation, Amazon read/write, ChannelMAX read/write, network request, database mutation, or object-store mutation was performed.",
  ],
  reason_catalog: reasonCatalog,
  sources: {
    ...predecessor.sources,
    prior_terminal_audit: {
      path: predecessorPath,
      file_sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
    corrected_frozen_main_spec: {
      path: frozenSpecPath,
      file_sha256: frozenSpecFileSha,
    },
    independent_review_scope: {
      predecessor_keep_rows_opened_at_original_resolution: 60,
      independent_passes: 2,
      disputed_rows_arbitrated_against_pinned_reference_art: [75, 85, 120, 125, 127, 137, 155],
    },
  },
  summary: {
    ...predecessor.summary,
    KEEP: 30,
    REPAIR: 134,
    corrected_false_keep_rows: 30,
    newly_discovered_false_keep_since_v7: 30,
    exhaustive_predecessor_keep_rows_reviewed: 60,
    loose_ice_rows: rows.filter((row) =>
      row.reason_codes.includes("LOOSE_ICE_VISIBLE")
    ).length,
    gel_pack_count_or_layout_rows: rows.filter((row) =>
      row.reason_codes.includes("GEL_PACK_COUNT_OR_LAYOUT_FAIL")
    ).length,
    unproven_variant_substitution_rows: rows.filter((row) =>
      row.reason_codes.includes("UNPROVEN_VARIANT_SUBSTITUTION")
    ).length,
  },
  rows,
  exhaustive_keep_correction: {
    predecessor_path: predecessorPath,
    predecessor_file_sha256: predecessorFileSha,
    predecessor_body_sha256: predecessorBodySha,
    reviewed_keep_ordinals: predecessor.rows
      .filter((row) => row.decision === "KEEP")
      .map((row) => row.ordinal),
    reclassified_ordinals: corrections.map((item) => item.ordinal),
    retained_keep_ordinals: rows
      .filter((row) => row.decision === "KEEP")
      .map((row) => row.ordinal),
    reason_counts: reasonCounts,
    decision_changes: 30,
    external_reads: 0,
    external_mutations: 0,
  },
};
const bodySha = sha256(JSON.stringify(body));
const artifact = { ...body, body_sha256: bodySha };
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;

const csvHeaders = [
  "ordinal",
  "sku",
  "asin",
  "decision",
  "severity",
  "effective_total_units",
  "reason_codes",
  "asset_sha256",
  "asset_local_path",
  "observation",
] as const;
const csvText = `${[
  csvHeaders.join(","),
  ...rows.map((row) =>
    csvHeaders
      .map((header) => {
        const value =
          header === "reason_codes"
            ? row.reason_codes.join("|")
            : header === "asset_sha256"
              ? row.evidence.asset_sha256
              : header === "asset_local_path"
                ? row.evidence.asset_local_path
                : row[header];
        return csvCell(value);
      })
      .join(",")
  ),
].join("\n")}\n`;

const markdown = [
  "# Uncrustables live MAIN strict re-audit — v8 exhaustive KEEP correction",
  "",
  `- Audit ID: \`${body.audit_id}\``,
  `- Reviewed at: **${body.reviewed_at}**`,
  "- Scope: **164**",
  "- Visual KEEP pending separate provenance/publish gates: **30**",
  "- REPAIR: **134**",
  "- v7 false KEEP decisions corrected: **30 of 60**",
  `- Body SHA-256: \`${bodySha}\``,
  "",
  "> This audit authorizes no image generation or marketplace write. A visual KEEP remains blocked until exact provenance, image-bound owner approval, production permit, and fresh compare-and-swap all pass.",
  "",
].join("\n");

for (const [localPath, text] of [
  [`${outputStem}.json`, jsonText],
  [`${outputStem}.csv`, csvText],
  [`${outputStem}.md`, markdown],
] as const) {
  const sidecar = `${sha256(text)}  ${path.basename(localPath)}\n`;
  if (checkOnly) {
    assert(existsSync(absolute(localPath)), `missing ${localPath}`);
    assert(readFileSync(absolute(localPath), "utf8") === text, `stale ${localPath}`);
    assert(
      readFileSync(absolute(`${localPath}.sha256`), "utf8") === sidecar,
      `stale ${localPath}.sha256`,
    );
  } else {
    writeFileSync(absolute(localPath), text);
    writeFileSync(absolute(`${localPath}.sha256`), sidecar);
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    check_only: checkOnly,
    predecessor_file_sha256: predecessorFileSha,
    frozen_spec_file_sha256: frozenSpecFileSha,
    body_sha256: bodySha,
    summary: body.summary,
    external_mutations: 0,
  }, null, 2)}\n`,
);
