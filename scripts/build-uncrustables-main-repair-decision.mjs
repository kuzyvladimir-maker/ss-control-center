import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const ARTIFACT_PATH = "data/audits/uncrustables-main-repair-decision-20260718-v1.json";

const SOURCES = [
  {
    role: "LIVE_MAIN_MANIFEST",
    path: "data/audits/uncrustables-live-main-fetch-20260718-v1/manifest.json",
    expected_sha256: "47c2bbbc0c0f7c1cdfcbc52363012b527d3611755d90536a2f80a06ffe2d9f05",
    direct: true,
  },
  {
    role: "HUMAN_AUDIT_A",
    path: "data/audits/uncrustables-live-main-visual-audit-20260718-a.json",
    expected_sha256: "287d74179e6dde4b7aea92d98aae3c629fff12a2fcd2f5ad04f9a2d5d1bb5a0f",
    direct: true,
  },
  {
    role: "HUMAN_AUDIT_A_CORRECTION_01",
    path: "data/audits/uncrustables-live-main-visual-audit-20260718-a-correction-01.json",
    expected_sha256: "5e50d339aade5bde7d9a8d28ee60bddf33c532cc8e6f38db6ec02962745eb600",
    direct: true,
  },
  {
    role: "HUMAN_AUDIT_B",
    path: "data/audits/uncrustables-live-main-visual-audit-20260718-b.json",
    expected_sha256: "16ddb2395eb6e59ddd52005a44c62b6a81312af70da124509b147f79f8cae17b",
    direct: true,
  },
  {
    role: "SOURCE_LEDGER",
    path: "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
    expected_sha256: "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
    direct: false,
  },
  {
    role: "REVIEWED_TOTAL_OVERRIDES",
    path: "data/repairs/uncrustables-reviewed-overrides-20260717.json",
    expected_sha256: "170250cb1761a8dbf9a10d18a83a4c38ca9758ec3294bb1341c2a23106e02238",
    direct: false,
  },
];

const REUSE_BY_TARGET_ORDINAL = new Map([
  [80, 106],
  [96, 71],
  [97, 1],
  [134, 161],
  [159, 100],
]);

const EXPECTED_REPAIR_ORDINALS = [
  4, 5, 10, 13, 17, 20, 29, 40, 51, 52, 58, 59, 65, 67, 80, 84, 90, 96, 97, 99,
  103, 110, 113, 116, 120, 123, 134, 135, 138, 140, 142, 146, 159, 163,
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readSource(source) {
  const absolutePath = join(ROOT, source.path);
  const bytes = readFileSync(absolutePath);
  const actualSha256 = sha256(bytes);
  assert(
    actualSha256 === source.expected_sha256,
    `${source.role} SHA mismatch: expected ${source.expected_sha256}, got ${actualSha256}`,
  );
  return {
    descriptor: {
      role: source.role,
      path: source.path,
      sha256: actualSha256,
      direct_input: source.direct,
    },
    json: JSON.parse(bytes.toString("utf8")),
  };
}

function mapByOrdinal(rows, label) {
  const map = new Map();
  for (const row of rows) {
    assert(Number.isInteger(row.ordinal), `${label} has a row without an integer ordinal`);
    assert(!map.has(row.ordinal), `${label} duplicate ordinal ${row.ordinal}`);
    map.set(row.ordinal, row);
  }
  return map;
}

function canonicalRecipe(row) {
  return {
    effective_total_units: row.effective_total_units,
    recipe_components: row.recipe_components,
  };
}

function recipeFingerprint(row) {
  return sha256(JSON.stringify(canonicalRecipe(row)));
}

const loadedSources = SOURCES.map(readSource);
const sourceDescriptors = loadedSources.map((source) => source.descriptor);
const sourceByRole = new Map(loadedSources.map((source) => [source.descriptor.role, source.json]));

const liveManifest = sourceByRole.get("LIVE_MAIN_MANIFEST");
const auditA = sourceByRole.get("HUMAN_AUDIT_A");
const correctionA = sourceByRole.get("HUMAN_AUDIT_A_CORRECTION_01");
const auditB = sourceByRole.get("HUMAN_AUDIT_B");

assert(liveManifest.immutable === true, "Live MAIN manifest is not immutable");
assert(liveManifest.status === "COMPLETE", `Live MAIN manifest status is ${liveManifest.status}`);
assert(liveManifest.summary.expected === 164, "Live MAIN manifest expected count is not 164");
assert(liveManifest.summary.fetched === 164, "Live MAIN manifest fetched count is not 164");
assert(liveManifest.summary.failed === 0, "Live MAIN manifest contains failed fetches");
assert(auditA.summary.checked === 84, "Audit A checked count is not 84");
assert(auditB.summary.reviewed === 80, "Audit B reviewed count is not 80");
assert(correctionA.immutable_parent_preserved === true, "Audit A correction does not preserve parent");

const liveByOrdinal = mapByOrdinal(liveManifest.rows, "live manifest");
const auditAByOrdinal = mapByOrdinal(auditA.rows, "audit A");
const auditBByOrdinal = mapByOrdinal(auditB.rows, "audit B");
const correctionsByOrdinal = mapByOrdinal(correctionA.changed_rows, "audit A correction");

assert(liveByOrdinal.size === 164, `Expected 164 live rows, got ${liveByOrdinal.size}`);
assert(auditAByOrdinal.size === 84, `Expected 84 audit A rows, got ${auditAByOrdinal.size}`);
assert(auditBByOrdinal.size === 80, `Expected 80 audit B rows, got ${auditBByOrdinal.size}`);
assert(correctionsByOrdinal.size === 6, `Expected 6 correction rows, got ${correctionsByOrdinal.size}`);

const sourceDescriptorByRole = new Map(sourceDescriptors.map((source) => [source.role, source]));
assert(
  auditA.source_manifest.sha256 === sourceDescriptorByRole.get("LIVE_MAIN_MANIFEST").sha256,
  "Audit A source-manifest SHA is inconsistent",
);
assert(
  auditB.source_manifest.sha256 === sourceDescriptorByRole.get("LIVE_MAIN_MANIFEST").sha256,
  "Audit B source-manifest SHA is inconsistent",
);
assert(
  correctionA.immutable_parent_artifacts.json.sha256 === sourceDescriptorByRole.get("HUMAN_AUDIT_A").sha256,
  "Audit A correction parent SHA is inconsistent",
);
assert(
  correctionA.original_source_manifest.sha256 === sourceDescriptorByRole.get("LIVE_MAIN_MANIFEST").sha256,
  "Audit A correction source-manifest SHA is inconsistent",
);

const allOrdinals = [...liveByOrdinal.keys()].sort((a, b) => a - b);
assert(
  allOrdinals.every((ordinal, index) => ordinal === index + 1),
  "Live manifest ordinals are not the exact contiguous range 1..164",
);

const effectiveAuditByOrdinal = new Map();
for (const ordinal of allOrdinals) {
  const live = liveByOrdinal.get(ordinal);
  const baseA = auditAByOrdinal.get(ordinal);
  const rowB = auditBByOrdinal.get(ordinal);
  assert(Boolean(baseA) !== Boolean(rowB), `Ordinal ${ordinal} must be covered by exactly one base audit`);

  if (baseA) {
    assert(baseA.sku === live.sku && baseA.asin === live.asin, `Audit A identity mismatch at ordinal ${ordinal}`);
    assert(baseA.asset_sha256 === live.asset.sha256, `Audit A asset SHA mismatch at ordinal ${ordinal}`);
    const correction = correctionsByOrdinal.get(ordinal);
    if (correction) {
      assert(correction.sku === live.sku && correction.asin === live.asin, `Correction identity mismatch at ${ordinal}`);
      assert(correction.asset_sha256 === live.asset.sha256, `Correction asset SHA mismatch at ${ordinal}`);
      assert(correction.previous_decision === baseA.decision, `Correction previous decision mismatch at ${ordinal}`);
      effectiveAuditByOrdinal.set(ordinal, {
        decision: correction.corrected_decision,
        reason_codes: correction.corrected_reason_codes,
        reviewer_note: correction.corrected_reviewer_note,
        provenance: [
          {
            role: "BASE_HUMAN_AUDIT",
            path: sourceDescriptorByRole.get("HUMAN_AUDIT_A").path,
            sha256: sourceDescriptorByRole.get("HUMAN_AUDIT_A").sha256,
            audit_id: auditA.audit_id,
            row_ordinal: ordinal,
          },
          {
            role: "EFFECTIVE_INTERPRETATION_OVERRIDE",
            path: sourceDescriptorByRole.get("HUMAN_AUDIT_A_CORRECTION_01").path,
            sha256: sourceDescriptorByRole.get("HUMAN_AUDIT_A_CORRECTION_01").sha256,
            correction_id: correctionA.correction_id,
            row_ordinal: ordinal,
            correction_code: correction.correction_code,
          },
        ],
      });
    } else {
      effectiveAuditByOrdinal.set(ordinal, {
        decision: baseA.decision,
        reason_codes: baseA.reason_codes,
        reviewer_note: baseA.reviewer_note,
        provenance: [
          {
            role: "HUMAN_AUDIT",
            path: sourceDescriptorByRole.get("HUMAN_AUDIT_A").path,
            sha256: sourceDescriptorByRole.get("HUMAN_AUDIT_A").sha256,
            audit_id: auditA.audit_id,
            row_ordinal: ordinal,
          },
        ],
      });
    }
  } else {
    assert(rowB.sku === live.sku && rowB.asin === live.asin, `Audit B identity mismatch at ordinal ${ordinal}`);
    assert(rowB.evidence.asset_sha256 === live.asset.sha256, `Audit B asset SHA mismatch at ordinal ${ordinal}`);
    effectiveAuditByOrdinal.set(ordinal, {
      decision: rowB.classification,
      reason_codes: rowB.failed_criteria,
      reviewer_note: rowB.reviewer_notes,
      provenance: [
        {
          role: "HUMAN_AUDIT",
          path: sourceDescriptorByRole.get("HUMAN_AUDIT_B").path,
          sha256: sourceDescriptorByRole.get("HUMAN_AUDIT_B").sha256,
          audit_id: auditB.audit_id,
          row_ordinal: ordinal,
        },
      ],
    });
  }
}

for (const correctedOrdinal of correctionsByOrdinal.keys()) {
  assert(auditAByOrdinal.has(correctedOrdinal), `Correction ordinal ${correctedOrdinal} is outside audit A`);
}

let localAssetHashChecks = 0;
for (const row of liveManifest.rows) {
  const absoluteAssetPath = join(
    ROOT,
    "data/audits/uncrustables-live-main-fetch-20260718-v1",
    row.asset.local_path,
  );
  const actualAssetSha256 = sha256(readFileSync(absoluteAssetPath));
  assert(actualAssetSha256 === row.asset.sha256, `Local asset SHA mismatch at ordinal ${row.ordinal}`);
  localAssetHashChecks++;
}

const effectiveRepairOrdinals = allOrdinals.filter(
  (ordinal) => effectiveAuditByOrdinal.get(ordinal).decision === "REGENERATE",
);
assert(
  JSON.stringify(effectiveRepairOrdinals) === JSON.stringify(EXPECTED_REPAIR_ORDINALS),
  `Effective repair ordinals changed: ${JSON.stringify(effectiveRepairOrdinals)}`,
);

const rows = allOrdinals.map((ordinal) => {
  const live = liveByOrdinal.get(ordinal);
  const audit = effectiveAuditByOrdinal.get(ordinal);
  assert(["KEEP", "REGENERATE"].includes(audit.decision), `Unsupported audit decision at ${ordinal}`);

  const decision = audit.decision === "KEEP" ? "KEEP" : "REPAIR";
  const donorOrdinal = REUSE_BY_TARGET_ORDINAL.get(ordinal);
  const repairAction = decision === "KEEP"
    ? "NONE"
    : donorOrdinal
      ? "REUSE_EXACT_GOOD"
      : "GENERATE_GPT_IMAGE_2";

  let replacement = null;
  if (donorOrdinal) {
    const donor = liveByOrdinal.get(donorOrdinal);
    const donorAudit = effectiveAuditByOrdinal.get(donorOrdinal);
    const targetFingerprint = recipeFingerprint(live);
    const donorFingerprint = recipeFingerprint(donor);
    assert(donorAudit.decision === "KEEP", `Reuse donor ${donorOrdinal} is not an effective KEEP`);
    assert(targetFingerprint === donorFingerprint, `Reuse recipe mismatch ${ordinal} -> ${donorOrdinal}`);
    replacement = {
      status: "SEALED_EXISTING_LIVE_ASSET",
      donor: {
        ordinal: donor.ordinal,
        sku: donor.sku,
        asin: donor.asin,
        requested_url: donor.requested_main_image_url,
        resolved_url: donor.http.final_url,
        sha256: donor.asset.sha256,
        local_path: `data/audits/uncrustables-live-main-fetch-20260718-v1/${donor.asset.local_path}`,
        width: donor.asset.width,
        height: donor.asset.height,
      },
      exact_recipe_match: {
        matched: true,
        target_fingerprint_sha256: targetFingerprint,
        donor_fingerprint_sha256: donorFingerprint,
        fields: ["effective_total_units", "recipe_components"],
      },
      donor_evidence: {
        effective_audit_decision: donorAudit.decision,
        reviewer_note: donorAudit.reviewer_note,
        provenance: donorAudit.provenance,
      },
    };
  } else if (repairAction === "GENERATE_GPT_IMAGE_2") {
    replacement = {
      status: "PENDING_GENERATION_AND_VISUAL_QA",
      required_model: "gpt-image-2",
      requested_url: null,
      sha256: null,
      publication_gate: "A generated asset may replace MAIN only after exact-recipe, count, packaging-authenticity, composition, dimension, and human visual QA all pass and its bytes are sealed by SHA-256.",
    };
  }

  return {
    ordinal: live.ordinal,
    sku: live.sku,
    asin: live.asin,
    title: live.title,
    recipe: {
      canonical_total_units: live.canonical_total_units,
      reviewed_total_units: live.reviewed_total_units,
      effective_total_units: live.effective_total_units,
      total_units_source: live.total_units_source,
      component_count: live.recipe_components.length,
      components: live.recipe_components,
      fingerprint_sha256: recipeFingerprint(live),
    },
    current_main: {
      requested_url: live.requested_main_image_url,
      resolved_url: live.http.final_url,
      sha256: live.asset.sha256,
      local_path: `data/audits/uncrustables-live-main-fetch-20260718-v1/${live.asset.local_path}`,
      width: live.asset.width,
      height: live.asset.height,
    },
    decision,
    repair_action: repairAction,
    reasons: {
      codes: audit.reason_codes,
      reviewer_note: audit.reviewer_note,
    },
    evidence: {
      current_asset_sha_matches_live_manifest: true,
      source_audit_effective_decision: audit.decision,
      provenance: audit.provenance,
    },
    replacement,
  };
});

const keepCount = rows.filter((row) => row.decision === "KEEP").length;
const repairCount = rows.filter((row) => row.decision === "REPAIR").length;
const reuseCount = rows.filter((row) => row.repair_action === "REUSE_EXACT_GOOD").length;
const generateCount = rows.filter((row) => row.repair_action === "GENERATE_GPT_IMAGE_2").length;

assert(keepCount === 130, `Expected 130 KEEP rows, got ${keepCount}`);
assert(repairCount === 34, `Expected 34 REPAIR rows, got ${repairCount}`);
assert(reuseCount === 5, `Expected 5 exact-good reuse rows, got ${reuseCount}`);
assert(generateCount === 29, `Expected 29 GPT Image 2 generation rows, got ${generateCount}`);
assert(keepCount + repairCount === 164, "KEEP + REPAIR does not equal 164");
assert(reuseCount + generateCount === repairCount, "Reuse + generation does not equal REPAIR");
assert(new Set(rows.map((row) => row.sku)).size === 164, "SKUs are not unique");
assert(new Set(rows.map((row) => row.asin)).size === 164, "ASINs are not unique");

const body = {
  schema_version: "uncrustables-main-repair-decision/v1.0.0",
  artifact_id: "UMRD-20260718-V1",
  artifact_date: "2026-07-18",
  status: "SEALED_LOCAL_DECISION_ONLY",
  immutable: true,
  deterministic_build: {
    enabled: true,
    runtime_timestamp_omitted: true,
    statement: "Artifact bytes are a deterministic function of the six hash-pinned local sources and the explicit five-pair reuse mapping in the builder.",
    builder_path: relative(ROOT, fileURLToPath(import.meta.url)),
  },
  safety: {
    amazon_writes: 0,
    r2_writes: 0,
    database_writes: 0,
    network_requests: 0,
    output_scope: "Local audit artifact and SHA-256 sidecar only",
  },
  decision_contract: {
    KEEP: "The currently fetched live MAIN asset passed the effective human audit and remains unchanged.",
    REPAIR_REUSE_EXACT_GOOD: "Replace with the sealed bytes of a human-audited KEEP donor whose effective count and full recipe_components array match exactly.",
    REPAIR_GENERATE_GPT_IMAGE_2: "Generate with exact model gpt-image-2; publication remains blocked until asset-level authenticity and human visual QA are sealed.",
  },
  source_artifacts: sourceDescriptors,
  source_lineage: {
    live_manifest_run_id: liveManifest.run_id,
    live_manifest_schema_version: liveManifest.schema_version,
    live_manifest_body_sha256: liveManifest.body_sha256,
    audit_a_id: auditA.audit_id,
    audit_a_correction_id: correctionA.correction_id,
    audit_b_id: auditB.audit_id,
    marketplace_observed_at: liveManifest.source_ledger.marketplace_observed_at,
  },
  summary: {
    total_rows: rows.length,
    KEEP: keepCount,
    REPAIR: repairCount,
    REUSE_EXACT_GOOD: reuseCount,
    GENERATE_GPT_IMAGE_2: generateCount,
    unresolved: 0,
  },
  reuse_pairs: rows
    .filter((row) => row.repair_action === "REUSE_EXACT_GOOD")
    .map((row) => ({
      target_ordinal: row.ordinal,
      target_sku: row.sku,
      target_asin: row.asin,
      donor_ordinal: row.replacement.donor.ordinal,
      donor_sku: row.replacement.donor.sku,
      donor_asin: row.replacement.donor.asin,
      donor_url: row.replacement.donor.resolved_url,
      donor_sha256: row.replacement.donor.sha256,
      recipe_fingerprint_sha256: row.recipe.fingerprint_sha256,
    })),
  validation_summary: {
    result: "PASS",
    checks: {
      source_sha256_pins_verified: sourceDescriptors.length,
      direct_source_sha256_pins_verified: sourceDescriptors.filter((source) => source.direct_input).length,
      live_rows_verified: 164,
      local_live_asset_sha256_verified: localAssetHashChecks,
      audit_rows_covered_exactly_once: 164,
      audit_asset_sha_matches_live_manifest: 164,
      corrected_rows_applied: correctionsByOrdinal.size,
      expected_repair_ordinal_set_matched: true,
      unique_ordinals: 164,
      unique_skus: 164,
      unique_asins: 164,
      exact_good_reuse_pair_recipe_matches: reuseCount,
      exact_good_reuse_donors_effective_keep: reuseCount,
      generate_rows_require_exact_gpt_image_2: generateCount,
      arithmetic_164_equals_130_plus_34: keepCount + repairCount === 164,
      arithmetic_34_equals_5_plus_29: reuseCount + generateCount === repairCount,
    },
  },
  rows,
};

const bodySha256 = sha256(JSON.stringify(body));
const artifact = {
  ...body,
  seal: {
    algorithm: "sha256",
    scope: "Compact JSON serialization of every top-level field before seal, in emitted key order",
    body_sha256: bodySha256,
  },
};

const output = `${JSON.stringify(artifact, null, 2)}\n`;
const outputPath = join(ROOT, ARTIFACT_PATH);
writeFileSync(outputPath, output);
const fileSha256 = sha256(output);
writeFileSync(`${outputPath}.sha256`, `${fileSha256}  ${ARTIFACT_PATH.split("/").at(-1)}\n`);

process.stdout.write(
  `${ARTIFACT_PATH}\nbody_sha256=${bodySha256}\nfile_sha256=${fileSha256}\nKEEP=${keepCount}\nREPAIR=${repairCount}\nREUSE_EXACT_GOOD=${reuseCount}\nGENERATE_GPT_IMAGE_2=${generateCount}\n`,
);
