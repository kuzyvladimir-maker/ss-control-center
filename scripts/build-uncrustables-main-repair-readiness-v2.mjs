#!/usr/bin/env node

/**
 * Build a deterministic, fail-closed readiness queue for the 112 strict MAIN
 * repairs. This script is local-only: it does not call an image model, Amazon,
 * R2, a database, or the network. Official carton captures are audit metadata;
 * only exact presentation-specific authenticity-registry evidence can satisfy
 * the product-identity reference gate.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const CHECK_ONLY = process.argv.includes("--check");

const OUTPUTS = {
  json: "data/audits/uncrustables-main-repair-readiness-20260718-v2.json",
  csv: "data/audits/uncrustables-main-repair-readiness-20260718-v2.csv",
};

const SOURCES = {
  strict_audit: {
    role: "STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT",
    path: "data/audits/uncrustables-live-main-strict-reaudit-20260718-v2.json",
    expected_sha256: "cdb24a4d4e7765cb9b782bf9f209d370d246e39c89e96f722f20f61a9ed1cac0",
  },
  authenticity_registry: {
    role: "PRODUCTION_AUTHENTICITY_REGISTRY",
    path: "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json",
    expected_sha256: "10cc967a28643c86653e713729952cac12aba083d83dd2a2608be120e6aeae11",
  },
  owner_style_approvals: {
    role: "OWNER_APPROVED_STYLE_FIXTURES",
    path: "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v1.json",
    expected_sha256: "d8cdd824c769ce01f923791bc83c1afebaecf45dff20c6561582332294d036e6",
  },
  official_art: {
    role: "OFFICIAL_PACKAGE_ART_AUDIT_MANIFEST",
    path: "data/audits/uncrustables-official-package-art-20260718/manifest.json",
    expected_sha256: "e961809487e06c3344ffa01592f27a9ec0722626d2e01cea6bf401d9618b2074",
  },
  official_legacy_mixed_berry_art: {
    role: "OFFICIAL_PACKAGE_ART_AUDIT_SUPPLEMENT",
    path: "data/audits/uncrustables-official-package-art-legacy-mixed-berry-20260718/manifest.json",
    expected_sha256: "d796dc7b89a1023523d591672757475f2c9b0a2103bb65cdab3b118dea48b1c5",
  },
  catalog_identity: {
    role: "CATALOG_IDENTITY_DECISION",
    path: "data/audits/uncrustables-catalog-identity-decision-20260718T072304000Z-00afce6e6bf8.json",
    expected_sha256: "205e195cfc148a3d8871b56c5471f5657e245d9840b5cf6430b7fd3d20d6731a",
  },
  frozen_spec: {
    role: "FROZEN_MAIN_SPEC_V2",
    path: "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md",
    expected_sha256: "c1d3742ca8bbaa0f4d426fb6c288214b8c9a01caa81675b2242dd07cd897b007",
  },
  kit_anchor: {
    role: "IMMUTABLE_KIT_ANCHOR",
    path: "public/bundle-factory/frozen-refs/ref-uncrustables.png",
    expected_sha256: "9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33",
  },
};

// These three exact live MAIN assets were explicitly accepted by the owner in
// the 2026-07-18 session. They are protected from MAIN regeneration/write.
// This freeze does not claim that the separate v2 provenance gate is complete.
const OWNER_FROZEN_LIVE_ASINS = new Set([
  "B0H8259J9G",
  "B0H82RQ226",
  "B0H83R4M3R",
]);

/**
 * Exact ledger-name mappings. genuine_carton_count is the reviewed count on
 * the current official carton capture, not the count embedded in a historical
 * source title and never the aggregate listing quantity.
 */
const PRODUCT_MAP = new Map([
  ["Smucker's Uncrustables Chocolate Flavored Hazelnut Spread Frozen Sandwich - 18oz/10ct", ["chocolate-hazelnut", "chocolate-hazelnut", "Chocolate Flavored Hazelnut Spread", 4]],
  ["Smucker's Uncrustables Frozen  Whole Wheat Peanut Butter & Grape Jelly Sandwiches - 8oz/4ct", ["reduced-sugar-grape-on-wheat", "reduced-sugar-grape-on-wheat", "Reduced Sugar Peanut Butter & Grape Jelly on Wheat", 4]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein 22.4oz/8ct", ["up-and-apple-protein", "up-and-apple-protein", "Up & Apple Peanut Butter & Apple Cinnamon Jelly, 12g Protein", 8]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct", ["peanut-butter-blackberry", "peanut-butter-blackberry", "Peanut Butter & Blackberry Spread", 4]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Blueberry Sandwich - 22.4oz/8ct", ["burstin-blueberry-protein", "burstin-blueberry-protein", "Burstin' Blueberry Peanut Butter & Blueberry, 12g Protein", 8]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct", ["peanut-butter-grape", "peanut-butter-grape", "Peanut Butter & Grape Jelly", 4]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Honey Spread Sandwich - 20oz/10ct", ["peanut-butter-honey", "peanut-butter-honey", "Peanut Butter & Honey Spread", 4]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct", ["peanut-butter-strawberry", "peanut-butter-strawberry", "Peanut Butter & Strawberry Jam", 4]],
  ["Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct", ["bright-eyed-berry-protein", "bright-eyed-berry-protein", "Bright-Eyed Berry Peanut Butter & Strawberry Jam, 12g Protein", 8]],
  ["Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct", ["peanut-butter", "peanut-butter", "Peanut Butter Sandwich", 4]],
  ["Smucker's Uncrustables Frozen Whole Wheat Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct", ["reduced-sugar-strawberry-on-wheat", "reduced-sugar-strawberry-on-wheat", "Reduced Sugar Peanut Butter & Strawberry Jam on Wheat", 4]],
  ["Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct", ["morning-protein-mixed-berry", "beamin-berry-blend-protein", "Beamin' Berry Blend / Morning Protein Peanut Butter & Mixed Berry Spread", 8]],
  ["Smucker's Uncrustables Peanut Butter & Strawberry Jam Sandwich (2 oz, individually wrapped, frozen)", ["peanut-butter-strawberry", "peanut-butter-strawberry", "Peanut Butter & Strawberry Jam", 4]],
  ["Smuckers Uncrustables Peanut Butter & Chocolate Flavored Spread Sandwiches, 10 Count, 2 oz Each (Frozen)", ["peanut-butter-chocolate-spread", "peanut-butter-chocolate-spread", "Peanut Butter & Chocolate Flavored Spread", 4]],
  ["Smuckers Uncrustables Peanut Butter & Mixed Berry Spread Sandwiches, 2 oz, 4 Count (Frozen)", ["peanut-butter-mixed-berry-legacy", "peanut-butter-mixed-berry-legacy", "Peanut Butter & Mixed Berry Spread, legacy 2 oz", 4]],
  ["Smuckers Uncrustables Peanut Butter & Raspberry Spread Sandwiches, 10 Count, 2 oz Each, Frozen", ["peanut-butter-raspberry", "peanut-butter-raspberry", "Peanut Butter & Raspberry Spread", 4]],
].map(([name, [canonicalFlavorId, officialFlavorId, label, genuineCartonCount]]) => [name, {
  canonical_flavor_id: canonicalFlavorId,
  official_flavor_id: officialFlavorId,
  canonical_label: label,
  genuine_carton_count: genuineCartonCount,
}]));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function absolute(localPath) {
  return join(ROOT, localPath);
}

function fileSha(localPath) {
  return sha256(readFileSync(absolute(localPath)));
}

function loadPinned(source) {
  const bytes = readFileSync(absolute(source.path));
  const actual = sha256(bytes);
  assert(actual === source.expected_sha256, `${source.role} SHA mismatch: ${actual}`);
  return {
    descriptor: { role: source.role, path: source.path, sha256: actual },
    json: source.path.endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : null,
  };
}

function normalize(value) {
  return String(value).trim().toLowerCase().replaceAll(/[’‘]/g, "'").replaceAll(/\s+/g, " ");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const loaded = Object.fromEntries(
  Object.entries(SOURCES).map(([key, source]) => [key, loadPinned(source)]),
);
const strictAudit = loaded.strict_audit.json;
const registry = loaded.authenticity_registry.json;
const styleApprovals = loaded.owner_style_approvals.json;
const officialManifest = loaded.official_art.json;
const legacyManifest = loaded.official_legacy_mixed_berry_art.json;
const identityDecision = loaded.catalog_identity.json;

assert(strictAudit.summary.reviewed === 164, "Strict audit must cover 164 rows");
assert(strictAudit.summary.KEEP === 52, "Strict audit KEEP partition changed");
assert(strictAudit.summary.REPAIR === 112, "Strict audit REPAIR partition changed");
assert(strictAudit.provenance_gate.marketplace_write_authorized === false, "Strict audit unexpectedly authorizes writes");
assert(registry.immutable === true, "Authenticity registry must be immutable");
assert(styleApprovals.immutable === true, "Style approvals must be immutable");
assert(styleApprovals.registry_sha256 === registry.sha256, "Style approvals reference a different registry seal");
assert(styleApprovals.entries.length === 3, "Expected exactly three style fixtures");
assert(styleApprovals.entries.every((entry) => entry.approval_scope === "style-reference-only" && entry.production_eligible === false), "Style fixture became production-eligible");

const officialByFlavor = new Map(
  [
    ...officialManifest.records.filter((record) => record.flavor_id !== "peanut-butter-mixed-berry-legacy"),
    ...legacyManifest.records,
  ].map((record) => [record.flavor_id, record]),
);
const identityBySku = new Map(identityDecision.decisions.map((row) => [row.sku, row]));

const registryByAlias = new Map();
for (const flavor of registry.flavors) {
  for (const alias of [flavor.flavor_id, ...(flavor.aliases ?? [])]) {
    const key = normalize(alias);
    assert(!registryByAlias.has(key), `Duplicate authenticity alias: ${alias}`);
    registryByAlias.set(key, flavor);
  }
}

const verifiedOfficialAssets = new Set();
const verifiedRegistryAssets = new Set();
const repairRows = strictAudit.rows.filter((row) => row.decision === "REPAIR");
const keepRows = strictAudit.rows.filter((row) => row.decision === "KEEP");
assert(repairRows.length === 112, `Expected 112 repairs, got ${repairRows.length}`);
assert(keepRows.length === 52, `Expected 52 keeps, got ${keepRows.length}`);

const ownerFrozenKeepRows = [...OWNER_FROZEN_LIVE_ASINS].map((asin) => {
  const row = strictAudit.rows.find((candidate) => candidate.asin === asin);
  assert(row, `Owner-frozen ASIN missing from strict audit: ${asin}`);
  assert(row.decision === "KEEP", `Owner-frozen ASIN is not strict KEEP: ${asin}`);
  assert(existsSync(absolute(row.evidence.asset_local_path)), `Owner-frozen asset missing: ${asin}`);
  assert(fileSha(row.evidence.asset_local_path) === row.evidence.asset_sha256, `Owner-frozen asset SHA mismatch: ${asin}`);
  return {
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    live_main_asset: {
      path: row.evidence.asset_local_path,
      sha256: row.evidence.asset_sha256,
      width: row.evidence.width,
      height: row.evidence.height,
    },
    action: "FREEZE_NO_MAIN_REGENERATION_OR_WRITE",
    owner_acceptance_source: "owner chat instruction, 2026-07-18",
    strict_visual_decision: "KEEP",
    provenance_status: "PENDING_SEPARATE_V2_PROVENANCE_GATE",
  };
});

function planPresentation(row) {
  const mappings = row.recipe_components.map((component) => PRODUCT_MAP.get(component.product_name));
  const exactCartonPlan = mappings.every(
    (mapping, index) => mapping && row.recipe_components[index].qty % mapping.genuine_carton_count === 0,
  );
  return {
    presentation_class: exactCartonPlan
      ? row.recipe_components.length === 1 ? "retail_boxes_single" : "retail_boxes_mix"
      : "individual_wraps",
    pack_mode: exactCartonPlan ? "retail-carton" : "individual-wrapper",
    exact_carton_decomposition: exactCartonPlan,
    decision_rule: exactCartonPlan
      ? "Every component quantity divides exactly by its reviewed genuine carton count."
      : "At least one component does not divide exactly; v2.0 requires exact reviewed wrapper evidence for every component.",
  };
}

function resolveComponent(component, presentation) {
  const blockers = [];
  const mapping = PRODUCT_MAP.get(component.product_name);
  if (!mapping) {
    blockers.push({ code: "EXACT_PRODUCT_MAPPING_MISSING", message: `No exact mapping for ${component.product_name}` });
    return {
      exact_product_name: component.product_name,
      quantity: component.qty,
      canonical_flavor_id: null,
      canonical_label: null,
      selected_pack_mode: presentation.pack_mode,
      genuine_carton_count: null,
      visible_package_count: presentation.pack_mode === "individual-wrapper" ? component.qty : null,
      project_official_art: null,
      authenticity_registry: null,
      reference_gate: "BLOCK",
      blockers,
    };
  }

  const official = officialByFlavor.get(mapping.official_flavor_id);
  let officialArt = null;
  if (!official || official.status !== "CAPTURED" || !official.local_path) {
    blockers.push({ code: "OFFICIAL_PROJECT_ART_MISSING", message: `Official project art missing for ${mapping.canonical_label}` });
  } else {
    assert(existsSync(absolute(official.local_path)), `Official art file missing: ${official.local_path}`);
    assert(fileSha(official.local_path) === official.package_art_sha256, `Official art SHA mismatch: ${official.local_path}`);
    verifiedOfficialAssets.add(official.local_path);
    officialArt = {
      present: true,
      flavor_id: official.flavor_id,
      path: official.local_path,
      sha256: official.package_art_sha256,
      authority: "AUDIT_METADATA_ONLY_NOT_MODEL_INPUT",
      production_eligible: false,
    };
  }

  const registryFlavor = registryByAlias.get(normalize(component.product_name));
  let registryResolution = null;
  if (!registryFlavor) {
    blockers.push({
      code: "AUTHENTICITY_REGISTRY_FLAVOR_MISSING",
      message: `No exact sealed-registry alias for ${component.product_name}`,
      details: { canonical_flavor_id: mapping.canonical_flavor_id },
    });
  } else {
    const matchingArt = registryFlavor.art.filter((art) =>
      art.pack_mode === presentation.pack_mode &&
      (presentation.pack_mode === "individual-wrapper" || art.retail_pack_size === mapping.genuine_carton_count),
    );
    if (matchingArt.length !== 1) {
      blockers.push({
        code: "AUTHENTICITY_REGISTRY_PRESENTATION_ART_MISSING",
        message: `No unique ${presentation.pack_mode} registry art for ${mapping.canonical_label}`,
        details: { matches: matchingArt.length, required_retail_pack_size: presentation.pack_mode === "retail-carton" ? mapping.genuine_carton_count : 1 },
      });
    } else {
      const art = matchingArt[0];
      const evidence = (art.evidence ?? []).filter((item) => item.kind === "reviewed-artifact");
      if (art.evidence?.length !== 1 || evidence.length !== 1) {
        blockers.push({
          code: "AUTHENTICITY_REGISTRY_REFERENCE_NOT_UNIQUE",
          message: `Registry art ${art.art_id} must have exactly one reviewed artifact`,
        });
      } else {
        const selected = evidence[0];
        assert(existsSync(absolute(selected.locator)), `Registry evidence missing: ${selected.locator}`);
        assert(fileSha(selected.locator) === selected.sha256, `Registry evidence SHA mismatch: ${selected.locator}`);
        verifiedRegistryAssets.add(selected.locator);
        registryResolution = {
          exact_alias_match: true,
          registry_flavor_id: registryFlavor.flavor_id,
          art_id: art.art_id,
          pack_mode: art.pack_mode,
          retail_pack_size: art.retail_pack_size,
          selected_reference: {
            path: selected.locator,
            sha256: selected.sha256,
            authority: "UNIQUE_PRESENTATION_SPECIFIC_PRODUCTION_REFERENCE",
          },
        };
      }
    }
  }

  const visiblePackageCount = presentation.pack_mode === "individual-wrapper"
    ? component.qty
    : component.qty / mapping.genuine_carton_count;
  assert(Number.isInteger(visiblePackageCount), `Non-integer package plan for ${component.product_name}`);
  return {
    exact_product_name: component.product_name,
    quantity: component.qty,
    canonical_flavor_id: mapping.canonical_flavor_id,
    canonical_label: mapping.canonical_label,
    selected_pack_mode: presentation.pack_mode,
    genuine_carton_count: mapping.genuine_carton_count,
    visible_package_count: visiblePackageCount,
    project_official_art: officialArt,
    authenticity_registry: registryResolution,
    reference_gate: blockers.length === 0 ? "PASS" : "BLOCK",
    blockers,
  };
}

const unsortedRows = repairRows.map((row) => {
  assert(!OWNER_FROZEN_LIVE_ASINS.has(row.asin), `Owner-frozen ASIN leaked into repair queue: ${row.asin}`);
  const presentation = planPresentation(row);
  const components = row.recipe_components.map((component) => resolveComponent(component, presentation));
  const identity = identityBySku.get(row.sku);
  const identityBlockers = identity?.decision === "BLOCK" ? [{
    code: "CATALOG_IDENTITY_BLOCK",
    message: identity.block_reason,
    details: { required_remediation: identity.required_remediation },
  }] : [];
  const referenceBlockers = components.flatMap((component) => component.blockers);
  const blockers = [...identityBlockers, ...referenceBlockers];
  const referenceGate = components.every((component) => component.reference_gate === "PASS") ? "PASS" : "BLOCK";
  const readiness = identityBlockers.length > 0
    ? "BLOCKED_CATALOG_IDENTITY"
    : referenceGate === "PASS"
      ? "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
      : "BLOCKED_AUTHENTICITY_PROVENANCE";
  const queueStage = readiness === "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION" ? 1
    : readiness === "BLOCKED_AUTHENTICITY_PROVENANCE" ? 2 : 3;
  const recipeBody = {
    effective_total_units: row.effective_total_units,
    components: row.recipe_components.map((component) => ({ product_name: component.product_name, quantity: component.qty })),
  };
  return {
    queue_stage: queueStage,
    queue_rank: null,
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    strict_audit: {
      decision: row.decision,
      severity: row.severity,
      reason_codes: row.reason_codes,
      observation: row.observation,
      live_main_asset: row.evidence,
    },
    exact_recipe: {
      ...recipeBody,
      component_count: row.recipe_components.length,
      fingerprint_sha256: sha256(JSON.stringify(recipeBody)),
    },
    presentation,
    components,
    reference_gate: referenceGate,
    catalog_identity_gate: identityBlockers.length === 0 ? "PASS" : "BLOCK",
    readiness,
    blockers,
    next_action: readiness === "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
      ? "Eligible only for a separately authorized controlled GPT Image 2 generation run; generated bytes still require full machine QA, image-bound human approval, production permit, and fresh Amazon compare-and-swap."
      : readiness === "BLOCKED_CATALOG_IDENTITY"
        ? "Resolve the catalog identity decision and capture fresh catalog evidence before any MAIN generation or publication."
        : "Add exact presentation-specific reviewed art to the sealed authenticity registry; official carton audit art cannot fill the production-reference gap.",
    generation_queued: false,
    generation_authorized: false,
    generated_output: null,
    amazon_write_authorized: false,
  };
});

const rows = unsortedRows
  .sort((left, right) => left.queue_stage - right.queue_stage || left.ordinal - right.ordinal)
  .map((row, index) => ({ ...row, queue_rank: index + 1 }));

const defectGroups = Object.entries(strictAudit.reason_catalog).map(([code, description]) => {
  const affected = repairRows.filter((row) => row.reason_codes.includes(code));
  return {
    code,
    description,
    affected_count: affected.length,
    affected_asins: affected.map((row) => row.asin).sort(),
    affected_skus: affected.map((row) => row.sku).sort(),
  };
}).filter((group) => group.affected_count > 0)
  .sort((left, right) => right.affected_count - left.affected_count || left.code.localeCompare(right.code));

const blockerGroups = new Map();
for (const row of rows) {
  for (const blocker of row.blockers) {
    const group = blockerGroups.get(blocker.code) ?? { code: blocker.code, affected_asins: [], affected_skus: [] };
    group.affected_asins.push(row.asin);
    group.affected_skus.push(row.sku);
    blockerGroups.set(blocker.code, group);
  }
}
const blockerSummary = [...blockerGroups.values()].map((group) => ({
  ...group,
  affected_asins: uniqueSorted(group.affected_asins),
  affected_skus: uniqueSorted(group.affected_skus),
  affected_count: new Set(group.affected_asins).size,
})).sort((left, right) => right.affected_count - left.affected_count || left.code.localeCompare(right.code));

const referenceGapGroups = new Map();
for (const row of rows) {
  for (const component of row.components.filter((item) => item.reference_gate === "BLOCK")) {
    const key = [
      component.canonical_flavor_id ?? "UNMAPPED",
      component.selected_pack_mode,
      component.genuine_carton_count ?? "UNKNOWN",
    ].join("|");
    const group = referenceGapGroups.get(key) ?? {
      canonical_flavor_id: component.canonical_flavor_id,
      canonical_label: component.canonical_label,
      required_pack_mode: component.selected_pack_mode,
      required_retail_pack_size: component.selected_pack_mode === "retail-carton"
        ? component.genuine_carton_count : 1,
      exact_product_names: [],
      official_project_art: component.project_official_art,
      official_project_art_production_eligible: false,
      missing_registry_reference: true,
      blocker_codes: [],
      affected_asins: [],
      affected_skus: [],
    };
    group.exact_product_names.push(component.exact_product_name);
    group.blocker_codes.push(...component.blockers.map((blocker) => blocker.code));
    group.affected_asins.push(row.asin);
    group.affected_skus.push(row.sku);
    referenceGapGroups.set(key, group);
  }
}
const referenceGapSummary = [...referenceGapGroups.values()].map((group) => ({
  ...group,
  exact_product_names: uniqueSorted(group.exact_product_names),
  blocker_codes: uniqueSorted(group.blocker_codes),
  affected_asins: uniqueSorted(group.affected_asins),
  affected_skus: uniqueSorted(group.affected_skus),
  affected_count: new Set(group.affected_asins).size,
})).sort((left, right) =>
  right.affected_count - left.affected_count ||
  String(left.canonical_flavor_id).localeCompare(String(right.canonical_flavor_id)) ||
  left.required_pack_mode.localeCompare(right.required_pack_mode));

const referenceReady = rows.filter((row) => row.reference_gate === "PASS" && row.catalog_identity_gate === "PASS");
const provenanceBlocked = rows.filter((row) => row.readiness === "BLOCKED_AUTHENTICITY_PROVENANCE");
const identityBlocked = rows.filter((row) => row.readiness === "BLOCKED_CATALOG_IDENTITY");
assert(rows.length === 112, "Readiness queue must contain exactly 112 rows");
assert(new Set(rows.map((row) => row.asin)).size === 112, "Repair ASINs must be unique");
assert(identityBlocked.length === 2, `Expected two catalog identity blocks, got ${identityBlocked.length}`);
assert(identityBlocked.some((row) => row.sku === "TY-AST2-JE9P"), "TY identity block missing");
assert(identityBlocked.some((row) => row.sku === "VN-AS1A-D572"), "VN identity block missing");
assert(rows.every((row) => !row.generation_authorized && !row.amazon_write_authorized), "Queue unexpectedly authorizes a mutation");
assert(referenceReady.every((row) => row.components.every((component) => component.authenticity_registry?.selected_reference)), "Reference-ready row has a missing exact registry reference");
assert(rows.every((row) => row.components.every((component) => component.canonical_flavor_id)), "An exact product-to-flavor mapping is unresolved");
assert(referenceReady.length === 9, `Expected nine reference-ready repairs, got ${referenceReady.length}`);
assert(provenanceBlocked.length === 101, `Expected 101 provenance-blocked repairs, got ${provenanceBlocked.length}`);

const body = {
  schema_version: "uncrustables-main-repair-readiness/v2.0.0",
  artifact_id: "UMRR-20260718-V2-STRICT112",
  immutable: true,
  status: "SEALED_LOCAL_READINESS_QUEUE_NO_GENERATION_NO_MARKETPLACE_WRITE",
  deterministic_build: {
    runtime_timestamp_omitted: true,
    builder_path: relative(ROOT, fileURLToPath(import.meta.url)),
  },
  safety: {
    image_model_calls: 0,
    amazon_writes: 0,
    r2_writes: 0,
    database_writes: 0,
    network_requests: 0,
    generation_authorized: false,
    marketplace_write_authorized: false,
  },
  contract: {
    strict_partition: "164 = 52 strict visual KEEP + 112 strict visual REPAIR",
    reference_rule: "Only a unique exact presentation-specific reviewed artifact in the sealed authenticity registry can pass product identity. Official project carton art is audit metadata and never a model-input fallback.",
    presentation_rule: "Use exact genuine cartons only when every component quantity divides by that component's reviewed carton count; otherwise require exact individual-wrapper evidence for every component.",
    readiness_rule: "REFERENCE_READY is not generation authorization. Every output still needs image-bound QA, owner approval, production permit, and fresh Amazon compare-and-swap.",
  },
  sources: Object.values(loaded).map((item) => item.descriptor),
  kit_anchor: {
    path: SOURCES.kit_anchor.path,
    sha256: SOURCES.kit_anchor.expected_sha256,
    authority: "KIT_GEOMETRY_BRANDING_AND_GEL_PACKS_ONLY",
  },
  owner_frozen_live_main: ownerFrozenKeepRows,
  owner_approved_style_fixtures: styleApprovals.entries.map((entry) => ({
    proof_id: entry.proof_id,
    asin: entry.asin,
    image: entry.image,
    approval_scope: entry.approval_scope,
    production_eligible: entry.production_eligible,
  })),
  summary: {
    strict_scope_rows: 164,
    strict_keep_rows_not_queued: keepRows.length,
    strict_repair_rows_queued: rows.length,
    owner_frozen_live_keep_rows: ownerFrozenKeepRows.length,
    reference_ready_pending_explicit_generation: referenceReady.length,
    blocked_authenticity_provenance: provenanceBlocked.length,
    blocked_catalog_identity: identityBlocked.length,
    official_project_art_assets_verified: verifiedOfficialAssets.size,
    registry_production_reference_assets_verified: verifiedRegistryAssets.size,
    images_generated: 0,
    amazon_rows_changed: 0,
  },
  defect_groups: defectGroups,
  blocker_summary: blockerSummary,
  reference_gap_groups: referenceGapSummary,
  rows,
};

const artifact = {
  ...body,
  seal: {
    algorithm: "sha256",
    scope: "Compact JSON serialization of every top-level field before seal, in emitted key order",
    body_sha256: sha256(JSON.stringify(body)),
  },
};
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
const csvHeader = [
  "queue_rank", "queue_stage", "ordinal", "sku", "asin", "readiness",
  "reference_gate", "catalog_identity_gate", "effective_total_units",
  "presentation_class", "pack_mode", "component_plan", "reason_codes",
  "blocker_codes", "generation_authorized", "amazon_write_authorized",
];
const csvRows = rows.map((row) => [
  row.queue_rank,
  row.queue_stage,
  row.ordinal,
  row.sku,
  row.asin,
  row.readiness,
  row.reference_gate,
  row.catalog_identity_gate,
  row.exact_recipe.effective_total_units,
  row.presentation.presentation_class,
  row.presentation.pack_mode,
  row.components.map((component) => `${component.quantity}x ${component.canonical_flavor_id ?? component.exact_product_name} as ${component.selected_pack_mode} (${component.visible_package_count} visible packages)`).join(" | "),
  row.strict_audit.reason_codes.join("|"),
  uniqueSorted(row.blockers.map((blocker) => blocker.code)).join("|"),
  row.generation_authorized,
  row.amazon_write_authorized,
]);
const csvText = `${[csvHeader, ...csvRows].map((values) => values.map(csvCell).join(",")).join("\n")}\n`;
const outputSet = [
  [OUTPUTS.json, jsonText],
  [`${OUTPUTS.json}.sha256`, `${sha256(jsonText)}  ${OUTPUTS.json.split("/").at(-1)}\n`],
  [OUTPUTS.csv, csvText],
  [`${OUTPUTS.csv}.sha256`, `${sha256(csvText)}  ${OUTPUTS.csv.split("/").at(-1)}\n`],
];

for (const [outputPath, text] of outputSet) {
  if (CHECK_ONLY) {
    assert(existsSync(absolute(outputPath)), `Missing generated artifact: ${outputPath}`);
    assert(readFileSync(absolute(outputPath), "utf8") === text, `Generated artifact is stale: ${outputPath}`);
  } else {
    writeFileSync(absolute(outputPath), text);
  }
}

process.stdout.write([
  `${CHECK_ONLY ? "verified" : "wrote"} ${OUTPUTS.json}`,
  `STRICT_REPAIR=${rows.length}`,
  `REFERENCE_READY=${referenceReady.length}`,
  `PROVENANCE_BLOCKED=${provenanceBlocked.length}`,
  `IDENTITY_BLOCKED=${identityBlocked.length}`,
  `OWNER_FROZEN_KEEP=${ownerFrozenKeepRows.length}`,
  `BODY_SHA256=${artifact.seal.body_sha256}`,
].join("\n") + "\n");
