#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fetchManifestPath = 'data/audits/uncrustables-live-main-fetch-20260718-v1/manifest.json';
const officialManifestPath = 'data/audits/uncrustables-official-package-art-20260718/manifest.json';
const specPath = '../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md';
const priorAPath = 'data/audits/uncrustables-live-main-visual-audit-20260718-a.json';
const priorCorrectionPath = 'data/audits/uncrustables-live-main-visual-audit-20260718-a-correction-01.json';
const priorBPath = 'data/audits/uncrustables-live-main-visual-audit-20260718-b.json';
const outputStem = 'data/audits/uncrustables-live-main-strict-reaudit-20260718-v2';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (p) => fs.readFileSync(path.resolve(root, p));
const readJson = (p) => JSON.parse(read(p).toString('utf8'));
const fileSha = (p) => sha256(read(p));

const fetchManifest = readJson(fetchManifestPath);
const officialManifest = readJson(officialManifestPath);
const priorA = readJson(priorAPath);
const priorCorrection = readJson(priorCorrectionPath);
const priorB = readJson(priorBPath);

const reasonCatalog = {
  RETAILER_BADGE_VISIBLE: 'A retailer-exclusive/store badge is visibly present; v2.0 forbids retailer badges on MAIN.',
  MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR: 'One single-flavor image mixes different retail carton count/design variants; v2.0 requires one reviewed carton design.',
  CARTON_COUNT_MATH_MISMATCH: 'Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity.',
  INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE: 'A purported individual wrapper visibly retains a retail carton pack-count badge.',
  MINI_CARTON_PRESENTED_AS_WRAPPER: 'Retail carton front art was shrunk onto a crimped pouch and presented as an individual wrapper.',
  WRONG_FLAVOR_VISIBLE: 'At least one visible product/flavor is not the exact recipe product.',
  MISSING_RECIPE_COMPONENT: 'At least one required recipe component is not visibly represented.',
  FICTIONAL_OR_ALTERED_PACKAGE_ART: 'Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art.',
  WRONG_NUTRITION_OR_VARIANT_TEXT: 'Visible package text/nutrition identifies the wrong product variant.',
  GENERIC_OR_UNBRANDED_PACKAGE: 'Visible package is generic or lacks authentic readable Smucker\'s/Uncrustables identity.',
  NO_APPROVED_COOLER_SCENE: 'The approved Salutem cooler/gel-pack frozen-shipping scene is absent.',
  PRODUCT_PHYSICAL_SEATING_FAIL: 'Products are pasted, floating, outside, or otherwise not physically seated behind the cooler rim.',
  GEL_PACK_COUNT_OR_LAYOUT_FAIL: 'The image does not contain exactly two approved gel packs inside plus two outside.',
  GEL_PACK_BRANDING_FAIL: 'One or more gel packs have altered/missing approved branding.',
  SALUTEM_BRANDING_FAIL: 'Cooler Salutem emblem/wordmark/slogan is altered, missing, or incorrect.',
  VISIBLE_UNIT_COUNT_NOT_RECONCILED: 'Visible individual-unit quantities do not reconcile to the recipe quantity/components.',
};

const keepOrdinals = new Set([
  7, 8, 12, 15, 18, 28, 32, 35, 37, 39, 41, 43, 44, 50, 53, 54,
  56, 57, 62, 64, 69, 71, 73, 78, 85, 87, 88, 91, 92, 93, 105, 107,
  117, 118, 120, 121, 125, 126, 127, 128, 130, 137, 139, 143, 147, 149,
  150, 152, 153, 155, 158, 164,
]);

const groups = {
  RETAILER_BADGE_VISIBLE: [1, 22, 30, 31, 33, 74, 75, 97, 129, 131, 141, 159, 161],
  MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR: [1, 2, 38, 97],
  CARTON_COUNT_MATH_MISMATCH: [3, 6, 9, 11, 14, 23, 25, 27, 36, 45, 46, 48, 60, 61, 66, 67, 68, 70, 72, 76, 77, 82, 89, 95, 104, 111, 112, 124, 131, 132, 133, 141, 144, 156, 159, 160, 161, 163],
  INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE: [16, 19, 24, 26, 34, 42, 47, 49, 63, 79, 81, 83, 86, 98, 100, 102, 108, 109, 114, 122, 148, 151, 154, 157, 162],
  MINI_CARTON_PRESENTED_AS_WRAPPER: [16, 19, 24, 26, 34, 42, 47, 49, 63, 79, 81, 83, 86, 98, 100, 102, 108, 109, 114, 122, 148, 151, 154, 157, 162],
  WRONG_FLAVOR_VISIBLE: [3, 13, 21, 29, 40, 59, 80, 113, 115, 123, 134, 138, 142],
  MISSING_RECIPE_COMPONENT: [3, 4, 13, 21, 29, 36, 45, 59, 80, 110, 113, 115, 123, 138],
  FICTIONAL_OR_ALTERED_PACKAGE_ART: [3, 9, 21, 27, 40, 48, 65, 67, 84, 90, 94, 96, 110, 113, 115, 116, 134, 135, 138, 142, 146, 163],
  WRONG_NUTRITION_OR_VARIANT_TEXT: [13, 21, 27, 40, 52, 96, 99, 113, 116, 134, 142],
  GENERIC_OR_UNBRANDED_PACKAGE: [17, 20, 40, 51, 58, 65, 67, 84, 90, 94, 110, 116, 135, 146, 163],
  NO_APPROVED_COOLER_SCENE: [5, 10, 103, 136, 140],
  PRODUCT_PHYSICAL_SEATING_FAIL: [58],
  GEL_PACK_COUNT_OR_LAYOUT_FAIL: [55, 135],
  GEL_PACK_BRANDING_FAIL: [135],
  SALUTEM_BRANDING_FAIL: [135],
  VISIBLE_UNIT_COUNT_NOT_RECONCILED: [99, 100, 101, 106, 119, 145],
};

const reasonsByOrdinal = new Map();
for (const [code, ordinals] of Object.entries(groups)) {
  for (const ordinal of ordinals) {
    const current = reasonsByOrdinal.get(ordinal) ?? [];
    current.push(code);
    reasonsByOrdinal.set(ordinal, current);
  }
}

const specificObservations = {
  1: 'Single flavor is represented as 10 + 10 + 4 retail cartons. The 10-count art also carries a visible Walmart badge.',
  2: 'Single flavor is represented by mixed 10-count and 4-count carton designs (10 + 10 + 4), violating the one-design rule.',
  6: 'Visible 4-count cartons imply 16 units of each component, not the required 12 + 12.',
  14: 'Ten visible 10-count raspberry cartons communicate 100 units, not the required 120.',
  16: 'Every purported Beamin\' Berry wrapper visibly retains an 8-count retail-carton badge.',
  19: 'Every purported individual whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge.',
  22: 'Twelve 10-count cartons reconcile to 120, but every carton visibly carries the retailer-exclusive Walmart mark.',
  23: 'The image uses 4-count retail cartons for a 90-unit recipe; 90 / 4 is not exact.',
  26: 'Every purported blueberry wrapper visibly retains an 8-count retail-carton badge.',
  30: 'Three 10-count cartons reconcile to 30, but the cartons visibly say Only at Walmart.',
  31: 'Three 10-count cartons reconcile to 30, but the cartons visibly say Only at Walmart.',
  33: 'Beamin\' Berry cartons visibly retain Only at Target badges.',
  34: 'Every purported strawberry wrapper visibly retains a 4-count retail-carton badge.',
  38: 'Single flavor is represented as 10 + 10 + 4 retail cartons instead of one reviewed count/design.',
  42: 'Every purported peanut-butter wrapper visibly retains a 4-count retail-carton badge.',
  48: 'Only five cartons are visible for a 12 + 12 mix; the selected chocolate source is 10ct, so 12 / 10 is not exact, and its printed counts are erased.',
  49: 'Every purported blueberry wrapper visibly retains an 8-count retail-carton badge.',
  52: 'The visible Up & Apple wrappers state 6g protein, conflicting with the required 12g Protein component.',
  55: 'Three gel packs are visible inside the cooler plus two outside (five total), not the required 2 + 2.',
  60: 'Two 8-count cartons are shown for each component (16 + 16), not the required 12 + 12.',
  63: 'Every purported whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge.',
  74: 'Three 8-count cartons reconcile to 24, but each visibly carries Only at Target.',
  75: 'Six 4-count Red, White & Berry cartons reconcile to 24, but each visibly carries Only at Walmart.',
  79: 'Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge.',
  81: 'Every purported Beamin\' Berry wrapper visibly retains an 8-count retail-carton badge.',
  83: 'Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge.',
  86: 'Every purported Up & Apple wrapper visibly retains the 8-count carton badge/NEW panel.',
  96: 'The image invents 15-count Beamin\' Berry cartons; the reviewed source is an 8-count carton.',
  97: 'Single flavor is represented as 10 + 10 + 4 cartons and the 10-count cartons retain Walmart badges.',
  98: 'Every purported grape wrapper visibly retains a 4-count retail-carton badge.',
  99: 'The Apple wrappers visibly show 6g rather than the selected 12g Protein variant, and the visible unit rows exceed 12 + 12.',
  100: 'The purported wrappers retain 4-count retail-carton badges; only 8 + 8 visible units are shown for a 12 + 12 recipe.',
  102: 'Every purported strawberry wrapper visibly retains a 4-count retail-carton badge.',
  106: 'Approximately 20 honey plus 20 mixed-berry wrappers are visible, not the required 12 + 12.',
  108: 'Every purported Up & Apple wrapper retains the retail 8-count/NEW badge.',
  109: 'Every purported Red, White & Berry wrapper visibly retains a 4-count retail-carton badge.',
  114: 'Every purported peanut-butter chocolate wrapper visibly retains a 4-count retail-carton badge.',
  119: 'Exactly 8 hazelnut and 8 mixed-berry wrappers are visible (16 total), not the required 12 + 12 (24).',
  122: 'The blackberry high-count wrapper scene uses carton-front/count-badge art rather than reviewed individual wrapper art.',
  129: 'Three 8-count cartons reconcile to 24, but every carton visibly carries Only at Target.',
  131: 'Two 8-count cartons per component communicate 16 + 16 rather than 12 + 12; Beamin\' cartons also retain Target marks.',
  141: 'Two 8-count cartons per component communicate 16 + 16 rather than 12 + 12; Beamin\' cartons also retain Target marks.',
  145: 'The visible Apple and Beamin\' wrapper grids exceed 12 units per component, so the 24-count recipe is not reconciled.',
  148: 'Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge.',
  151: 'Every purported Blackberry Boom wrapper visibly retains a 4-count retail-carton badge.',
  154: 'Every purported peanut-butter wrapper visibly retains a 4-count retail-carton badge.',
  156: 'Three 10-count cartons are visible for each component (30 + 30), not 12 + 12.',
  157: 'Every purported Blackberry Boom wrapper visibly retains a 4-count retail-carton badge.',
  159: 'Peanut butter is 3 x 4 = 12, but Beamin\' Berry is 2 x 8 = 16 and retains Target marks.',
  160: 'Three 4-count grape cartons communicate 12 units, not the required 30.',
  161: 'Whole-wheat strawberry is 3 x 4 = 12, but Beamin\' Berry is 2 x 8 = 16 and retains Target marks.',
  162: 'Every purported whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge.',
};

const reuseDonors = {
  60: {role: 'OWNER_APPROVED_LIVE_EXAMPLE', status: 'INVALID_FOR_REUSE', reason: 'Component carton arithmetic is 16 + 16, not 12 + 12.'},
  71: {role: 'POTENTIAL_SINGLE_FLAVOR_DONOR', status: 'VISUAL_PASS_ONLY', reason: 'Clean 30-unit single-flavor scene; reuse for another quantity still requires a new exact count plan and image-bound approval.'},
  100: {role: 'PRIOR_COMPOSITE_DONOR', status: 'INVALID_FOR_REUSE', reason: 'Mini-carton wrappers and 8 + 8 rather than 12 + 12.'},
  106: {role: 'PRIOR_COMPOSITE_DONOR', status: 'INVALID_FOR_REUSE', reason: 'Visible unit count greatly exceeds 12 + 12.'},
  119: {role: 'OWNER_REFERENCE_COMPOSITE', status: 'INVALID_FOR_24_COUNT_REUSE', reason: 'Visible count is 8 + 8, not 12 + 12.'},
  161: {role: 'OWNER_APPROVED_LIVE_EXAMPLE', status: 'INVALID_FOR_REUSE', reason: 'Component arithmetic is 12 + 16 and Target marks remain.'},
};

const previousEffective = new Map();
for (const row of priorA.rows) previousEffective.set(row.ordinal, row.decision);
for (const row of priorCorrection.changed_rows) previousEffective.set(row.ordinal, row.corrected_decision);
for (const row of priorB.rows) previousEffective.set(row.ordinal, row.classification);

const rows = fetchManifest.rows.map((sourceRow) => {
  const ordinal = sourceRow.ordinal;
  const decision = keepOrdinals.has(ordinal) ? 'KEEP' : 'REPAIR';
  const reasonCodes = reasonsByOrdinal.get(ordinal) ?? [];
  const priorDecision = previousEffective.get(ordinal) ?? null;
  const evidencePath = path.posix.join(path.posix.dirname(fetchManifestPath), sourceRow.asset.local_path);
  const sheetNumber = Math.floor((ordinal - 1) / 12) + 1;
  const sheet = fetchManifest.contact_sheets.find((item) => item.sheet_number === sheetNumber);
  const observation = specificObservations[ordinal]
    ?? (decision === 'KEEP'
      ? 'Original-resolution visual review found the exact recipe presentation, a visually reconciled carton/wrapper count plan, the approved cooler/Salutem scene, exactly 2 inside + 2 outside gel packs, and no concrete forbidden mark or package-art defect.'
      : reasonCodes.map((code) => reasonCatalog[code]).join(' '));
  return {
    ordinal,
    ledger_row_index: sourceRow.ledger_row_index,
    sku: sourceRow.sku,
    asin: sourceRow.asin,
    title: sourceRow.title,
    effective_total_units: sourceRow.effective_total_units,
    total_units_source: sourceRow.total_units_source,
    recipe_components: sourceRow.recipe_components,
    source_main_image_url: sourceRow.requested_main_image_url,
    evidence: {
      asset_local_path: evidencePath,
      asset_sha256: sourceRow.asset.sha256,
      width: sourceRow.asset.width,
      height: sourceRow.asset.height,
      contact_sheet_local_path: sheet?.local_path ?? null,
      contact_sheet_sha256: sheet?.sha256 ?? null,
      reviewed_at_original_resolution: true,
      official_package_art_manifest: officialManifestPath,
    },
    decision,
    severity: decision === 'KEEP' ? 'VISUAL_PASS' : 'BLOCKING_DEFECT',
    recommendation: decision === 'KEEP' ? 'KEEP_LIVE_PENDING_PROVENANCE_GATE' : 'REPAIR_BEFORE_ANY_PUBLISH',
    reason_codes: reasonCodes,
    observation,
    previous_effective_decision: priorDecision,
    newly_discovered_false_keep: priorDecision === 'KEEP' && decision !== 'KEEP',
    reuse_donor: reuseDonors[ordinal] ?? null,
  };
});

const errors = [];
if (rows.length !== 164) errors.push(`Expected 164 rows, got ${rows.length}`);
const ordinalSet = new Set(rows.map((row) => row.ordinal));
if (ordinalSet.size !== 164 || Math.min(...ordinalSet) !== 1 || Math.max(...ordinalSet) !== 164) errors.push('Ordinals are not a complete unique 1..164 set.');
for (const row of rows) {
  if (row.decision === 'REPAIR' && row.reason_codes.length === 0) errors.push(`REPAIR row ${row.ordinal} has no reason code.`);
  if (row.decision === 'KEEP' && row.reason_codes.length !== 0) errors.push(`KEEP row ${row.ordinal} has failure reason codes.`);
  if (!fs.existsSync(path.resolve(root, row.evidence.asset_local_path))) errors.push(`Missing asset for row ${row.ordinal}: ${row.evidence.asset_local_path}`);
  if (fileSha(row.evidence.asset_local_path) !== row.evidence.asset_sha256) errors.push(`Asset hash mismatch for row ${row.ordinal}.`);
}
if (errors.length) throw new Error(errors.join('\n'));

const countBy = (key) => Object.fromEntries(['KEEP', 'REPAIR', 'NEEDS_EVIDENCE'].map((value) => [value, rows.filter((row) => row[key] === value).length]));
const summary = {
  reviewed: rows.length,
  ...countBy('decision'),
  newly_discovered_false_keep: rows.filter((row) => row.newly_discovered_false_keep).length,
  prior_effective_keep: rows.filter((row) => row.previous_effective_decision === 'KEEP').length,
  known_reuse_donors_checked: Object.keys(reuseDonors).length,
  invalid_reuse_donors: Object.values(reuseDonors).filter((item) => item.status.includes('INVALID')).length,
};

const body = {
  schema_version: 'uncrustables-live-main-strict-reaudit/v2.0',
  audit_id: 'ULMSR-20260718-V2',
  status: 'COMPLETED',
  immutable: true,
  reviewed_at: '2026-07-18T04:53:06Z',
  reviewer: 'Codex independent strict visual re-audit',
  scope: 'All 164 fetched live Amazon MAIN images, reviewed from original-resolution local evidence against the frozen v2.0 visual contract.',
  decision_semantics: {
    KEEP: 'No concrete visual defect was found. This is a visual KEEP only and is not marketplace publish authorization.',
    REPAIR: 'At least one concrete blocking visual defect was found; image must be repaired/replaced before any publish.',
    NEEDS_EVIDENCE: 'Reserved for unresolved visual identity/count ambiguity. None remained after this review.',
  },
  provenance_gate: {
    status: 'NOT_ESTABLISHED_BY_THIS_VISUAL_AUDIT',
    warning: 'Even KEEP rows remain pending the separate v2.0 GPT Image 2 generation-manifest, ordered-reference byte hashes, output hash, and image-bound human approval gates.',
    marketplace_write_authorized: false,
  },
  methodology: [
    'Read the complete frozen MAIN Image Spec v2.0.',
    'Reviewed all 14 contact sheets and original 2048x2048 assets; ambiguous/count-badge rows were opened individually at original resolution.',
    'Compared visible product identity against the local official Smucker\'s package-art capture and the recipe ledger.',
    'Recomputed carton arithmetic per component; mixed carton sizes do not satisfy single-flavor one-design mode even when their sum equals the aggregate.',
    'Treated carton pack-count badges on purported individual wrappers as a hard mini-carton/package-art failure.',
    'Applied retailer-mark, exact four-gel-pack, physical-seating, and cooler-branding gates independently of prior audits or owner class-fixture approvals.',
  ],
  sources: {
    frozen_spec: {path: specPath, sha256: fileSha(specPath)},
    fetch_manifest: {path: fetchManifestPath, sha256: fileSha(fetchManifestPath), body_sha256: fetchManifest.body_sha256},
    official_package_art_manifest: {path: officialManifestPath, sha256: fileSha(officialManifestPath), body_sha256: officialManifest.body_sha256},
    previous_audit_a: {path: priorAPath, sha256: fileSha(priorAPath)},
    previous_audit_a_correction: {path: priorCorrectionPath, sha256: fileSha(priorCorrectionPath)},
    previous_audit_b: {path: priorBPath, sha256: fileSha(priorBPath)},
  },
  reason_catalog: reasonCatalog,
  summary,
  newly_discovered_false_keep_ordinals: rows.filter((row) => row.newly_discovered_false_keep).map((row) => row.ordinal),
  invalid_reuse_donor_ordinals: rows.filter((row) => row.reuse_donor?.status.includes('INVALID')).map((row) => row.ordinal),
  rows,
};

const canonicalBody = JSON.stringify(body);
const bodySha = sha256(canonicalBody);
const output = {...body, body_sha256: bodySha};

const csvEscape = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csvHeaders = ['ordinal', 'sku', 'asin', 'decision', 'severity', 'effective_total_units', 'previous_effective_decision', 'newly_discovered_false_keep', 'reason_codes', 'reuse_donor_status', 'asset_sha256', 'asset_local_path', 'title', 'observation'];
const csvRows = rows.map((row) => ({
  ordinal: row.ordinal,
  sku: row.sku,
  asin: row.asin,
  decision: row.decision,
  severity: row.severity,
  effective_total_units: row.effective_total_units,
  previous_effective_decision: row.previous_effective_decision,
  newly_discovered_false_keep: row.newly_discovered_false_keep,
  reason_codes: row.reason_codes.join('|'),
  reuse_donor_status: row.reuse_donor?.status ?? '',
  asset_sha256: row.evidence.asset_sha256,
  asset_local_path: row.evidence.asset_local_path,
  title: row.title,
  observation: row.observation,
}));
const csv = [csvHeaders.join(','), ...csvRows.map((row) => csvHeaders.map((header) => csvEscape(row[header])).join(','))].join('\n') + '\n';

const falseKeepRows = rows.filter((row) => row.newly_discovered_false_keep);
const repairRows = rows.filter((row) => row.decision === 'REPAIR');
const keepRows = rows.filter((row) => row.decision === 'KEEP');
const md = `# Uncrustables live MAIN strict re-audit — v2\n\n` +
  `- Audit ID: \`${body.audit_id}\`\n` +
  `- Reviewed: **${summary.reviewed}**\n` +
  `- Visual KEEP: **${summary.KEEP}**\n` +
  `- REPAIR: **${summary.REPAIR}**\n` +
  `- NEEDS_EVIDENCE: **${summary.NEEDS_EVIDENCE}**\n` +
  `- Newly discovered false KEEP: **${summary.newly_discovered_false_keep}**\n` +
  `- Body SHA-256: \`${bodySha}\`\n\n` +
  `> Visual KEEP is not publish authorization. Every KEEP remains pending the separate GPT Image 2 provenance, ordered donor-byte, output-hash, and image-bound owner approval gates from v2.0.\n\n` +
  `## Newly discovered false KEEP\n\n` +
  `| Ordinal | SKU | ASIN | Reasons | Observation |\n|---:|---|---|---|---|\n` +
  falseKeepRows.map((row) => `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.reason_codes.join(', ')} | ${row.observation.replaceAll('|', '\\|')} |`).join('\n') +
  `\n\n## Invalid reuse donors\n\n` +
  `| Ordinal | Role | Status | Reason |\n|---:|---|---|---|\n` +
  rows.filter((row) => row.reuse_donor).map((row) => `| ${row.ordinal} | ${row.reuse_donor.role} | ${row.reuse_donor.status} | ${row.reuse_donor.reason} |`).join('\n') +
  `\n\n## REPAIR rows\n\n` +
  `| Ordinal | SKU | ASIN | Reasons |\n|---:|---|---|---|\n` +
  repairRows.map((row) => `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.reason_codes.join(', ')} |`).join('\n') +
  `\n\n## Visual KEEP rows\n\n` +
  `| Ordinal | SKU | ASIN | Units |\n|---:|---|---|---:|\n` +
  keepRows.map((row) => `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.effective_total_units} |`).join('\n') + '\n';

const jsonPath = `${outputStem}.json`;
const csvPath = `${outputStem}.csv`;
const mdPath = `${outputStem}.md`;
fs.writeFileSync(path.resolve(root, jsonPath), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.resolve(root, csvPath), csv);
fs.writeFileSync(path.resolve(root, mdPath), md);
for (const p of [jsonPath, csvPath, mdPath]) fs.writeFileSync(path.resolve(root, `${p}.sha256`), `${fileSha(p)}  ${path.basename(p)}\n`);

console.log(JSON.stringify({summary, body_sha256: bodySha, outputs: [jsonPath, csvPath, mdPath], false_keep_ordinals: body.newly_discovered_false_keep_ordinals, invalid_reuse_donor_ordinals: body.invalid_reuse_donor_ordinals}, null, 2));
