#!/usr/bin/env node

/**
 * Build the deterministic, local-only production-readiness manifest for the
 * 34 Uncrustables MAIN repairs. This script never calls a model, Amazon, R2,
 * a database, or the network. Missing authenticity evidence is preserved as
 * a hard blocker; official carton art is never promoted to wrapper evidence.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const OUTPUT_PATH =
  "data/audits/uncrustables-main-production-readiness-20260718-v1.json";

const SOURCES = {
  decision: {
    role: "MAIN_REPAIR_DECISION",
    path: "data/audits/uncrustables-main-repair-decision-20260718-v1.json",
    expected_sha256:
      "c437ad345fd5551d83fe72340376e2e2a25584672fab0b69d5309730a0a08dcc",
  },
  official_art: {
    role: "OFFICIAL_PACKAGE_ART_MANIFEST",
    path: "data/audits/uncrustables-official-package-art-20260718/manifest.json",
    expected_sha256:
      "e961809487e06c3344ffa01592f27a9ec0722626d2e01cea6bf401d9618b2074",
  },
  official_legacy_mixed_berry_art: {
    role: "OFFICIAL_PACKAGE_ART_SUPPLEMENT_LEGACY_MIXED_BERRY",
    path: "data/audits/uncrustables-official-package-art-legacy-mixed-berry-20260718/manifest.json",
    expected_sha256:
      "d796dc7b89a1023523d591672757475f2c9b0a2103bb65cdab3b118dea48b1c5",
  },
  owner_approvals: {
    role: "OWNER_APPROVED_CLASS_FIXTURES",
    path: "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v1.json",
    expected_sha256:
      "d8cdd824c769ce01f923791bc83c1afebaecf45dff20c6561582332294d036e6",
  },
  authenticity_registry: {
    role: "PRODUCTION_AUTHENTICITY_REGISTRY",
    path: "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json",
    expected_sha256:
      "10cc967a28643c86653e713729952cac12aba083d83dd2a2608be120e6aeae11",
  },
  identity_decision: {
    role: "CATALOG_IDENTITY_DECISION",
    path: "data/audits/uncrustables-catalog-identity-decision-20260718T072304000Z-00afce6e6bf8.json",
    expected_sha256:
      "205e195cfc148a3d8871b56c5471f5657e245d9840b5cf6430b7fd3d20d6731a",
  },
  frozen_spec: {
    role: "FROZEN_MAIN_SPEC_V2",
    path: "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md",
    expected_sha256:
      "c1d3742ca8bbaa0f4d426fb6c288214b8c9a01caa81675b2242dd07cd897b007",
  },
  anchor: {
    role: "IMMUTABLE_KIT_ANCHOR",
    path: "public/bundle-factory/frozen-refs/ref-uncrustables.png",
    expected_sha256:
      "9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33",
  },
};

const TY_SKU = "TY-AST2-JE9P";

const REUSE_EXACT_GOOD_GATE = {
  schema_version: "uncrustables-reuse-exact-good-gate/v1",
  fail_closed: true,
  required_observation_schema_version:
    "uncrustables-reuse-image-bound-observation/v1",
  required_review_method: "ORIGINAL_RESOLUTION_EXACT_ASSET_VISUAL_REVIEW",
  required_decision: "PASS",
  required_asset_binding: [
    "path",
    "sha256",
    "width",
    "height",
    "recipe_fingerprint_sha256",
  ],
  required_image_bound_checks: [
    "EXACT_RECIPE_COMPONENT_IDENTITIES",
    "EXACT_VISIBLE_COMPONENT_QUANTITIES",
    "PRESENTATION_ART_AUTHENTICITY",
    "EXACTLY_FOUR_GEL_PACKS_TWO_INSIDE_TWO_OUTSIDE",
    "NO_RETAILER_MARKS_UNDER_FROZEN_V2",
    "PACK_SIZE_AND_PRESENTATION_CONSISTENCY",
    "COOLER_BRANDING_GEOMETRY_AND_PHYSICAL_SEATING",
  ],
  acceptance_rule:
    "REUSE_EXACT_GOOD is forbidden unless one complete observation is bound to the exact candidate bytes and recipe fingerprint and every required image-bound check is explicitly PASS. A matching recipe fingerprint, prior KEEP label, URL, filename, visual similarity, or partial observation is never sufficient.",
};

const REUSE_QA_BLOCKS = new Map([
  [
    "PJ-ASDX-E8LW",
    {
      expected_donor_sha256:
        "d596dece64ba6e143531819ad38cefd532f38b67fd7cf5c1f74f446af0cbe9d6",
      blocking_findings: [
        {
          code: "GEL_PACK_COUNT_AND_LAYOUT_MISMATCH",
          expected: "Exactly four gel packs: two inside and two outside.",
          observed: "Five gel packs are visible: three inside and two outside.",
        },
      ],
    },
  ],
  [
    "RL-AS64-Q8QX",
    {
      expected_donor_sha256:
        "3398bb472d684a29a8a7f98f976497a32be31eac8dcb908712eceba1ec69f93b",
      comparison_references: [
        {
          role: "AUTHENTIC_MORNING_PROTEIN_MIXED_BERRY_WRAPPER_REFERENCE",
          path: "data/audits/uncrustables-approved-reference-qa-20260718/B0H85P9F3R-live.jpg",
          sha256:
            "846005feea2a43108672aa5d4c65f272511d4332c5f7d449ba2ee437633c4e2b",
        },
      ],
      blocking_findings: [
        {
          code: "ALTERED_OR_CARTON_DERIVED_WRAPPER_ART",
          expected:
            "Thirty genuine Morning Protein / Beamin' Berry individual wrappers matching reviewed wrapper evidence.",
          observed:
            "The thirty pouch-like units use altered, carton-derived front art rather than the genuine individual-wrapper presentation.",
        },
      ],
    },
  ],
  [
    "RM-ASCV-DVA5",
    {
      expected_donor_sha256:
        "6b7f1b519a2be868871a3fe767d5d284d567a4a00466a4cb0d5576bbb691bedb",
      blocking_findings: [
        {
          code: "RETAILER_MARK_POLICY_VIOLATION",
          expected: "No retailer mark under frozen MAIN-image v2.0 policy.",
          observed:
            "An authentic printed Walmart-exclusive badge is visible on the product packaging; authenticity does not override the frozen no-retailer-mark rule.",
        },
        {
          code: "MIXED_RETAIL_PACK_SIZE_CONSISTENCY_REVIEW_REQUIRED",
          expected:
            "One explicitly approved, internally consistent presentation for all 24 units.",
          observed:
            "The exact numeric total is 10 + 10 + 4 = 24, but the mixed 10-count and 4-count carton presentation has not passed the required consistency review.",
        },
      ],
    },
  ],
  [
    "VH-ASHZ-TJEE",
    {
      expected_donor_sha256:
        "5518355a28eb1f5cf2dafae5129e62e56bd068d0c647a6027a03d2e94ce58eb7",
      blocking_findings: [
        {
          code: "VISIBLE_COMPONENT_QUANTITY_MISMATCH",
          expected:
            "12 Strawberry-on-Wheat units plus 12 Morning Protein Mixed Berry units = 24.",
          observed:
            "Three 4-count Strawberry-on-Wheat cartons plus two 8-count Beamin' Berry cartons = 12 + 16 = 28 visible units.",
        },
      ],
    },
  ],
  [
    "ZE-AS5W-FKH3",
    {
      expected_donor_sha256:
        "963cd9952ff50dbffdf5e7fd9b7e1059df18dd8a3e5ff8b1b9829a9b1d95b097",
      blocking_findings: [
        {
          code: "VISIBLE_COMPONENT_QUANTITY_MISMATCH",
          expected:
            "12 Peanut Butter units plus 12 Morning Protein Mixed Berry units = 24.",
          observed:
            "The visible package arithmetic is 8 Peanut Butter units plus 8 Beamin' Berry units = 16, not 24.",
        },
        {
          code: "PACKAGE_CONFIGURATION_AUTHENTICITY_REVIEW_REQUIRED",
          expected:
            "Only genuine, presentation-consistent package configurations and printed count badges.",
          observed:
            "The mini-carton/count-badge treatment is not sufficiently authenticated for exact reuse.",
        },
      ],
    },
  ],
]);

/**
 * Exact ledger product-name mapping to current official package art. The
 * retail pack size is the genuine count printed on the hash-pinned official
 * carton bytes, not the aggregate listing quantity or a global guess.
 */
const PRODUCT_ART_MAP = new Map([
  [
    "Smuckers Uncrustables Peanut Butter & Raspberry Spread Sandwiches, 10 Count, 2 oz Each, Frozen",
    {
      canonical_flavor_id: "peanut-butter-raspberry",
      official_flavor_id: "peanut-butter-raspberry",
      canonical_label: "Peanut Butter & Raspberry Spread",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
    {
      canonical_flavor_id: "morning-protein-mixed-berry",
      official_flavor_id: "beamin-berry-blend-protein",
      canonical_label: "Beamin' Berry Blend / Morning Protein Peanut Butter & Mixed Berry Spread",
      official_retail_pack_size: 8,
    },
  ],
  [
    "Smucker's Uncrustables Chocolate Flavored Hazelnut Spread Frozen Sandwich - 18oz/10ct",
    {
      canonical_flavor_id: "chocolate-hazelnut",
      official_flavor_id: "chocolate-hazelnut",
      canonical_label: "Chocolate Flavored Hazelnut Spread",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
    {
      canonical_flavor_id: "peanut-butter-strawberry",
      official_flavor_id: "peanut-butter-strawberry",
      canonical_label: "Peanut Butter & Strawberry Jam",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein 22.4oz/8ct",
    {
      canonical_flavor_id: "up-and-apple-protein",
      official_flavor_id: "up-and-apple-protein",
      canonical_label: "Up & Apple Peanut Butter & Apple Cinnamon Jelly, 12g Protein",
      official_retail_pack_size: 8,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct",
    {
      canonical_flavor_id: "peanut-butter-grape",
      official_flavor_id: "peanut-butter-grape",
      canonical_label: "Peanut Butter & Grape Jelly",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct",
    {
      canonical_flavor_id: "bright-eyed-berry-protein",
      official_flavor_id: "bright-eyed-berry-protein",
      canonical_label: "Bright-Eyed Berry Peanut Butter & Strawberry Jam, 12g Protein",
      official_retail_pack_size: 8,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct",
    {
      canonical_flavor_id: "peanut-butter-blackberry",
      official_flavor_id: "peanut-butter-blackberry",
      canonical_label: "Peanut Butter & Blackberry Spread",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen  Whole Wheat Peanut Butter & Grape Jelly Sandwiches - 8oz/4ct",
    {
      canonical_flavor_id: "reduced-sugar-grape-on-wheat",
      official_flavor_id: "reduced-sugar-grape-on-wheat",
      canonical_label: "Reduced Sugar Peanut Butter & Grape Jelly on Wheat",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Blueberry Sandwich - 22.4oz/8ct",
    {
      canonical_flavor_id: "burstin-blueberry-protein",
      official_flavor_id: "burstin-blueberry-protein",
      canonical_label: "Burstin' Blueberry Peanut Butter & Blueberry, 12g Protein",
      official_retail_pack_size: 8,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Whole Wheat Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
    {
      canonical_flavor_id: "reduced-sugar-strawberry-on-wheat",
      official_flavor_id: "reduced-sugar-strawberry-on-wheat",
      canonical_label: "Reduced Sugar Peanut Butter & Strawberry Jam on Wheat",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
    {
      canonical_flavor_id: "peanut-butter",
      official_flavor_id: "peanut-butter",
      canonical_label: "Peanut Butter Sandwich",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smucker's Uncrustables Frozen Peanut Butter & Honey Spread Sandwich - 20oz/10ct",
    {
      canonical_flavor_id: "peanut-butter-honey",
      official_flavor_id: "peanut-butter-honey",
      canonical_label: "Peanut Butter & Honey Spread",
      official_retail_pack_size: 4,
    },
  ],
  [
    "Smuckers Uncrustables Peanut Butter & Mixed Berry Spread Sandwiches, 2 oz, 4 Count (Frozen)",
    {
      canonical_flavor_id: "peanut-butter-mixed-berry-legacy",
      official_flavor_id: "peanut-butter-mixed-berry-legacy",
      canonical_label: "Peanut Butter & Mixed Berry Spread, legacy 2 oz",
      official_retail_pack_size: 4,
    },
  ],
]);

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

function readPinned(source) {
  const bytes = readFileSync(absolute(source.path));
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
    },
    json: source.path.endsWith(".json")
      ? JSON.parse(bytes.toString("utf8"))
      : null,
  };
}

function normalizeLabel(value) {
  return String(value).trim().toLowerCase().replaceAll(/[’‘]/g, "'").replaceAll(/\s+/g, " ");
}

function coolerFor(total) {
  if (total <= 30) return "S";
  if (total <= 60) return "M";
  if (total <= 72) return "L";
  return "XL";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function addBlocker(blockers, code, message, details = undefined) {
  blockers.push(details ? { code, message, details } : { code, message });
}

function passesExactReuseGate(observation, expectedAsset) {
  if (!observation || !expectedAsset) return false;
  const binding = observation.asset_binding;
  if (
    observation.schema_version !==
      REUSE_EXACT_GOOD_GATE.required_observation_schema_version ||
    !binding ||
    binding.path !== expectedAsset.path ||
    binding.sha256 !== expectedAsset.sha256 ||
    binding.width !== expectedAsset.width ||
    binding.height !== expectedAsset.height ||
    binding.recipe_fingerprint_sha256 !== expectedAsset.recipe_fingerprint_sha256 ||
    observation.review_method !== REUSE_EXACT_GOOD_GATE.required_review_method ||
    observation.decision !== REUSE_EXACT_GOOD_GATE.required_decision ||
    observation.complete_exact_good_check_set !== true
  ) {
    return false;
  }
  if (
    !existsSync(absolute(binding.path)) ||
    fileSha(binding.path) !== binding.sha256
  ) {
    return false;
  }
  const checks = new Map(
    (observation.check_results ?? []).map((check) => [check.code, check.status]),
  );
  return (
    (observation.check_results ?? []).length ===
      REUSE_EXACT_GOOD_GATE.required_image_bound_checks.length &&
    checks.size === REUSE_EXACT_GOOD_GATE.required_image_bound_checks.length &&
    REUSE_EXACT_GOOD_GATE.required_image_bound_checks.every(
      (code) => checks.get(code) === "PASS",
    )
  );
}

function verifyDecisionSeal(decision) {
  const { seal, ...body } = decision;
  assert(seal?.algorithm === "sha256", "Repair decision has no supported seal");
  assert(
    sha256(JSON.stringify(body)) === seal.body_sha256,
    "Repair decision body seal mismatch",
  );
}

function promptText({
  row,
  presentation,
  components,
  cooler,
  modelInputContract,
  blocked,
}) {
  const className = presentation.presentation_class;
  const primaryStyle =
    className === "retail_boxes_single"
      ? "retail_boxes_single"
      : className === "retail_boxes_mix"
        ? "retail_boxes_mix"
        : "individual_wraps";
  const componentLines = components.map((component, index) => {
    const quantityPlan =
      className === "individual_wraps"
        ? `EXACTLY ${component.quantity} genuine individual wrappers`
        : `EXACTLY ${component.visible_package_count} genuine ${component.official_retail_pack_size}-count retail cartons (${component.visible_package_count} × ${component.official_retail_pack_size} = ${component.quantity})`;
    return `${index + 1}. ${quantityPlan} of ${component.canonical_label}; copy only the exact component reference assigned to recipe position ${index + 1}.`;
  });
  const productReferenceLines = modelInputContract.product_identity_references.map(
    (reference) =>
      `${reference.recipe_component_index}. ${reference.role}: ${reference.path ?? "MISSING"} (SHA-256 ${reference.sha256 ?? "MISSING"}; ${reference.authority}).`,
  );
  const kitReference = modelInputContract.kit_anchor_reference;
  const styleReference = modelInputContract.style_class_fixture_reference;
  return [
    blocked
      ? "DRAFT ONLY — DO NOT SUBMIT TO ANY IMAGE MODEL UNTIL EVERY SEALED BLOCKER IN THIS SPEC IS RESOLVED."
      : "Generate this exact production MAIN with GPT Image 2.",
    "Output: exactly 2048 × 2048 PNG, high quality, square 1:1, pure white Amazon MAIN background.",
    `Identity: SKU ${row.sku}, ASIN ${row.asin}, exact total ${row.recipe.effective_total_units} individual sandwiches, cooler ${cooler}.`,
    `Presentation class: ${className}; owner-approved class fixture: ${primaryStyle}.`,
    `Kit anchor model input: ${kitReference.path} (SHA-256 ${kitReference.sha256}).`,
    "Product identity model inputs — presentation-specific registry references only; the style fixture is never product identity:",
    ...productReferenceLines,
    `Separate owner-approved style-class model input: ${styleReference.path} (SHA-256 ${styleReference.sha256}; ${styleReference.presentation_class}; STYLE ONLY).`,
    "The kit anchor controls only the exact white textured EPS cooler, lid, camera, lighting, ornate green Salutem emblem, black SALUTEM SOLUTIONS wordmark, black OUR BEST SOLUTIONS FOR YOU slogan, and four gel packs. Never copy its food products.",
    "The selected owner-approved style fixture controls only class-level composition, spacing, seating, and visual finish. Never use its product pixels, flavor, count, carton, wrapper, retailer mark, or text as product identity.",
    "Recipe component plan:",
    ...componentLines,
    "Preserve every genuine Smucker's/Uncrustables flavor name, color, food image, package proportion, and genuine printed donor count exactly. Never print the aggregate listing count on a carton, wrapper, cooler, gel pack, or overlay.",
    "Show exactly four approved white gel packs: two inside at the left and right of the products and two standing outside at the front/right. Preserve the blue FROZEN GEL PACK and KEEP FROZEN / FOR FROZEN SHIPMENTS text, green emblem, and black Salutem wordmark/slogan.",
    "Every product must be physically seated inside the cooler cavity with lower edges occluded behind the front inner rim, shared perspective and lighting, realistic depth, overlap, contact, and contact shadows.",
    "No floating products, gaps beneath products, pasted edges, alpha halos, wall intersections, fictional or generic packaging, altered logos, merged flavors, missing flavors, extra flavors, retailer marks, price labels, overlays, watermarks, people, hands, props, loose ice, snow, or puddles.",
    "If an exact presentation-specific product reference is missing or unreadable, stop. Never derive wrapper art from carton art and never substitute a similar flavor.",
  ].join("\n");
}

const loaded = Object.fromEntries(
  Object.entries(SOURCES).map(([key, source]) => [key, readPinned(source)]),
);
const decision = loaded.decision.json;
const officialManifest = loaded.official_art.json;
const officialLegacyMixedBerryManifest =
  loaded.official_legacy_mixed_berry_art.json;
const ownerApprovals = loaded.owner_approvals.json;
const registry = loaded.authenticity_registry.json;
const identityDecision = loaded.identity_decision.json;

verifyDecisionSeal(decision);
assert(decision.summary.REPAIR === 34, "Expected exactly 34 MAIN repairs");
assert(decision.summary.REUSE_EXACT_GOOD === 5, "Expected exactly 5 exact-good reuses");
assert(decision.summary.GENERATE_GPT_IMAGE_2 === 29, "Expected exactly 29 original generation decisions");
assert(officialManifest.immutable === true, "Official package-art manifest is not immutable");
assert(
  officialLegacyMixedBerryManifest.immutable === true,
  "Legacy Mixed Berry official package-art supplement is not immutable",
);
assert(
  officialLegacyMixedBerryManifest.records.length === 1 &&
    officialLegacyMixedBerryManifest.records[0].flavor_id ===
      "peanut-butter-mixed-berry-legacy",
  "Legacy Mixed Berry supplement must contain exactly its one sealed flavor",
);
assert(ownerApprovals.immutable === true, "Owner fixture manifest is not immutable");
assert(ownerApprovals.entries.length === 3, "Exactly three owner-approved class fixtures are required");
assert(
  ownerApprovals.registry_sha256 === registry.sha256,
  "Owner fixtures and production registry seals disagree",
);
assert(
  registry.sha256 === "9723d515a110859e54efa8f8bff1b5f7e56f49c28b411834a2d267b68e827157",
  "Production authenticity registry internal seal changed",
);

const officialByFlavor = new Map(
  [
    ...officialManifest.records.filter(
      (record) => record.flavor_id !== "peanut-butter-mixed-berry-legacy",
    ),
    ...officialLegacyMixedBerryManifest.records,
  ].map((record) => [record.flavor_id, record]),
);
const identityBySku = new Map(
  identityDecision.decisions.map((row) => [row.sku, row]),
);
const registryFlavorByAlias = new Map();
for (const flavor of registry.flavors) {
  for (const alias of [flavor.flavor_id, ...(flavor.aliases ?? [])]) {
    const normalized = normalizeLabel(alias);
    assert(!registryFlavorByAlias.has(normalized), `Duplicate registry alias ${alias}`);
    registryFlavorByAlias.set(normalized, flavor);
  }
}

const styleClassByProof = new Map([
  ["01c-retail-boxes-single-pb-24-four-gel-packs", "retail_boxes_single"],
  ["02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs", "retail_boxes_mix"],
  ["03-individual-wraps-mix-hazelnut-berry-24", "individual_wraps"],
]);
const styleFixtures = ownerApprovals.entries.map((entry) => {
  const presentationClass = styleClassByProof.get(entry.proof_id);
  assert(presentationClass, `Unknown owner-approved fixture ${entry.proof_id}`);
  assert(entry.approval_scope === "style-reference-only", `${entry.proof_id} unexpectedly became production bytes`);
  assert(entry.production_eligible === false, `${entry.proof_id} unexpectedly became production-eligible`);
  assert(existsSync(absolute(entry.image.locator)), `Missing fixture ${entry.image.locator}`);
  assert(fileSha(entry.image.locator) === entry.image.sha256, `Fixture SHA mismatch ${entry.proof_id}`);
  return {
    presentation_class: presentationClass,
    proof_id: entry.proof_id,
    path: entry.image.locator,
    sha256: entry.image.sha256,
    width: entry.pixel_dimensions.width,
    height: entry.pixel_dimensions.height,
    approval_id: entry.human_approval.approval_id,
    approval_sha256: entry.human_approval.sha256,
    scope: "CLASS_STYLE_ONLY_NOT_PRODUCTION_OUTPUT",
  };
});
const styleFixtureByClass = new Map(
  styleFixtures.map((fixture) => [fixture.presentation_class, fixture]),
);

const officialAssetChecks = new Set();
const registryEvidenceChecks = new Set();

function componentReadiness(component, presentationClass, blockers) {
  const mapping = PRODUCT_ART_MAP.get(component.product_name);
  if (!mapping) {
    addBlocker(
      blockers,
      "EXACT_PRODUCT_TO_FLAVOR_MAPPING_MISSING",
      `No exact product-to-flavor mapping exists for ${component.product_name}`,
    );
    return {
      product_name: component.product_name,
      quantity: component.qty,
      canonical_flavor_id: null,
      canonical_label: null,
      official_retail_pack_size: null,
      official_package_art: null,
      production_registry: null,
      visible_package_count: presentationClass === "individual_wraps" ? component.qty : null,
    };
  }

  const official = officialByFlavor.get(mapping.official_flavor_id);
  let officialPackageArt = null;
  if (!official || official.status !== "CAPTURED" || !official.local_path) {
    addBlocker(
      blockers,
      "OFFICIAL_PACKAGE_ART_MISSING",
      `Official package art is unavailable for ${mapping.canonical_label}`,
      {
        official_flavor_id: mapping.official_flavor_id,
        capture_status: official?.status ?? "NO_RECORD",
        capture_error: official?.error ?? null,
        official_source_page: official?.source_page ?? null,
      },
    );
  } else {
    assert(existsSync(absolute(official.local_path)), `Missing official art ${official.local_path}`);
    assert(
      fileSha(official.local_path) === official.package_art_sha256,
      `Official package-art SHA mismatch for ${mapping.official_flavor_id}`,
    );
    officialAssetChecks.add(official.local_path);
    officialPackageArt = {
      role: "OFFICIAL_MANUFACTURER_IDENTITY_AUDIT_METADATA",
      flavor_id: official.flavor_id,
      path: official.local_path,
      sha256: official.package_art_sha256,
      source_page:
        official.source_page_final_url ??
        official.source_page ??
        official.historical_source_page,
      package_art_url: official.package_art_final_url ?? official.package_art_url,
      presentation: "retail-carton",
      genuine_printed_count: mapping.official_retail_pack_size,
      production_authority: "AUDIT_METADATA_ONLY_NEVER_A_MODEL_INPUT",
    };
  }

  const registryFlavor = registryFlavorByAlias.get(normalizeLabel(component.product_name));
  let registryResolution = null;
  if (!registryFlavor) {
    addBlocker(
      blockers,
      "PRODUCTION_REGISTRY_FLAVOR_MAPPING_MISSING",
      `The sealed production authenticity registry has no exact alias for ${component.product_name}`,
      { canonical_flavor_id: mapping.canonical_flavor_id },
    );
  } else {
    const requiredMode =
      presentationClass === "individual_wraps" ? "individual-wrapper" : "retail-carton";
    const artMatches = registryFlavor.art.filter(
      (art) =>
        art.pack_mode === requiredMode &&
        (requiredMode === "individual-wrapper" ||
          art.retail_pack_size === mapping.official_retail_pack_size),
    );
    if (artMatches.length !== 1) {
      addBlocker(
        blockers,
        "PRODUCTION_REGISTRY_PRESENTATION_ART_MISSING",
        `Registry flavor ${registryFlavor.flavor_id} has no unique reviewed ${requiredMode} art for the planned presentation`,
        {
          required_pack_size:
            requiredMode === "retail-carton"
              ? mapping.official_retail_pack_size
              : 1,
          matches: artMatches.length,
        },
      );
    } else {
      const art = artMatches[0];
      const allEvidence = art.evidence ?? [];
      const reviewedEvidence = allEvidence.filter(
        (item) => item.kind === "reviewed-artifact",
      );
      if (allEvidence.length !== 1 || reviewedEvidence.length !== 1) {
        addBlocker(
          blockers,
          "PRODUCTION_REGISTRY_PRESENTATION_REFERENCE_NOT_UNIQUE",
          `Registry art ${art.art_id} must resolve to exactly one reviewed presentation-specific artifact`,
          {
            evidence_records: allEvidence.length,
            reviewed_artifact_records: reviewedEvidence.length,
          },
        );
        registryResolution = {
          registry_flavor_id: registryFlavor.flavor_id,
          art_id: art.art_id,
          pack_mode: art.pack_mode,
          retail_pack_size: art.retail_pack_size,
          selected_reference: null,
        };
      } else {
        const item = reviewedEvidence[0];
        assert(existsSync(absolute(item.locator)), `Missing registry evidence ${item.locator}`);
        assert(fileSha(item.locator) === item.sha256, `Registry evidence SHA mismatch ${item.locator}`);
        registryEvidenceChecks.add(item.locator);
        registryResolution = {
          registry_flavor_id: registryFlavor.flavor_id,
          art_id: art.art_id,
          pack_mode: art.pack_mode,
          retail_pack_size: art.retail_pack_size,
          selected_reference: {
            role: "PRODUCTION_REGISTRY_PRESENTATION_REFERENCE",
            path: item.locator,
            sha256: item.sha256,
          },
        };
      }
    }
  }

  const visiblePackageCount =
    presentationClass === "individual_wraps"
      ? component.qty
      : component.qty / mapping.official_retail_pack_size;
  return {
    product_name: component.product_name,
    quantity: component.qty,
    canonical_flavor_id: mapping.canonical_flavor_id,
    canonical_label: mapping.canonical_label,
    official_retail_pack_size: mapping.official_retail_pack_size,
    visible_package_count: visiblePackageCount,
    official_package_art: officialPackageArt,
    production_registry: registryResolution,
  };
}

function plannedPresentation(row) {
  const mappings = row.recipe.components.map((component) =>
    PRODUCT_ART_MAP.get(component.product_name),
  );
  const exactCartonPlan = mappings.every(
    (mapping, index) =>
      mapping &&
      row.recipe.components[index].qty % mapping.official_retail_pack_size === 0,
  );
  const presentationClass = exactCartonPlan
    ? row.recipe.components.length === 1
      ? "retail_boxes_single"
      : "retail_boxes_mix"
    : "individual_wraps";
  return {
    presentation_class: presentationClass,
    decision_rule: exactCartonPlan
      ? "Every component quantity divides exactly by its SHA-bound official carton count."
      : "At least one component cannot be represented by an integer number of its official cartons; v2.0 requires individual wrappers and forbids rounding.",
    exact_carton_decomposition: exactCartonPlan,
  };
}

const repairRows = decision.rows.filter((row) => row.decision === "REPAIR");
assert(repairRows.length === 34, `Expected 34 repair rows, got ${repairRows.length}`);

const rows = repairRows.map((row) => {
  if (row.repair_action === "REUSE_EXACT_GOOD") {
    const donor = row.replacement?.donor;
    const qaBlock = REUSE_QA_BLOCKS.get(row.sku);
    assert(donor, `${row.sku} has no reuse donor`);
    assert(qaBlock, `${row.sku} has no targeted reuse QA reclassification`);
    assert(existsSync(absolute(donor.local_path)), `Missing reuse donor ${donor.local_path}`);
    assert(fileSha(donor.local_path) === donor.sha256, `Reuse donor SHA mismatch for ${row.sku}`);
    assert(
      donor.sha256 === qaBlock.expected_donor_sha256,
      `Reuse QA observation asset binding changed for ${row.sku}`,
    );
    assert(row.replacement.exact_recipe_match?.matched === true, `Reuse recipe mismatch for ${row.sku}`);
    for (const reference of qaBlock.comparison_references ?? []) {
      assert(existsSync(absolute(reference.path)), `Missing reuse QA comparator ${reference.path}`);
      assert(
        fileSha(reference.path) === reference.sha256,
        `Reuse QA comparator SHA mismatch for ${row.sku}`,
      );
    }
    const donorBinding = {
      path: donor.local_path,
      sha256: donor.sha256,
      width: donor.width,
      height: donor.height,
      recipe_fingerprint_sha256: row.recipe.fingerprint_sha256,
    };
    const imageBoundObservation = {
      schema_version: "uncrustables-reuse-image-bound-observation/v1",
      review_method: "TARGETED_ORIGINAL_RESOLUTION_BLOCKING_REAUDIT",
      review_scope: "TARGETED_BLOCKING_REAUDIT_NOT_EXACT_GOOD_CERTIFICATION",
      decision: "BLOCK",
      asset_binding: donorBinding,
      comparison_references: qaBlock.comparison_references ?? [],
      blocking_findings: qaBlock.blocking_findings,
      check_results: [],
      complete_exact_good_check_set: false,
      qualifies_for_reuse_exact_good: false,
    };
    assert(
      passesExactReuseGate(imageBoundObservation, donorBinding) === false,
      `Failing targeted observation unexpectedly authorized exact reuse for ${row.sku}`,
    );
    return {
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      title: row.title,
      action: "BLOCKED_REUSE_QA",
      readiness: "BLOCKED_NOT_GENERATION_READY_NOT_PUBLICATION_READY",
      prior_repair_action: "REUSE_EXACT_GOOD",
      recipe: row.recipe,
      donor: {
        ordinal: donor.ordinal,
        sku: donor.sku,
        asin: donor.asin,
        path: donor.local_path,
        sha256: donor.sha256,
        source_url: donor.resolved_url,
        width: donor.width,
        height: donor.height,
        recipe_fingerprint_sha256: row.recipe.fingerprint_sha256,
      },
      image_bound_observation: imageBoundObservation,
      generation_allowed: false,
      amazon_write_authorized: false,
      publication_blockers: [
        ...qaBlock.blocking_findings.map((finding) => ({
          code: finding.code,
          message: finding.observed,
        })),
        {
          code: "COMPLETE_EXACT_IMAGE_BOUND_OBSERVATION_REQUIRED",
          message:
            "A future reuse candidate must satisfy the complete fail-closed exact-good gate against its exact bytes; this targeted failing observation cannot authorize reuse.",
        },
      ],
    };
  }

  if (row.sku === TY_SKU) {
    const identity = identityBySku.get(row.sku);
    assert(identity?.decision === "BLOCK", "TY must remain identity-blocked");
    return {
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      title: row.title,
      action: "BLOCKED_IDENTITY",
      readiness: "BLOCKED_BEFORE_GENERATION",
      recipe: row.recipe,
      identity_block: {
        same_identity: identity.same_identity,
        reason: identity.block_reason,
        required_remediation: identity.required_remediation,
        evidence: identity.evidence,
      },
      prompt_spec: null,
      generation_allowed: false,
      amazon_write_authorized: false,
    };
  }

  assert(
    row.repair_action === "GENERATE_GPT_IMAGE_2",
    `Unsupported repair action for ${row.sku}: ${row.repair_action}`,
  );
  const blockers = [];
  const presentation = plannedPresentation(row);
  const fixture = styleFixtureByClass.get(presentation.presentation_class);
  assert(fixture, `No owner-approved fixture for ${presentation.presentation_class}`);
  const components = row.recipe.components.map((component) =>
    componentReadiness(component, presentation.presentation_class, blockers),
  );

  const kitAnchorReference = {
    role: "KIT_ANCHOR",
    path: SOURCES.anchor.path,
    sha256: SOURCES.anchor.expected_sha256,
    authority: "KIT_GEOMETRY_BRANDING_AND_GEL_PACKS_ONLY",
  };
  const productIdentityReferences = components.map((component, index) => {
    const selectedReference = component.production_registry?.selected_reference ?? null;
    return {
      role: `RECIPE_COMPONENT_${index + 1}_PRESENTATION_IDENTITY_REFERENCE`,
      recipe_component_index: index + 1,
      presentation_class: presentation.presentation_class,
      registry_flavor_id: component.production_registry?.registry_flavor_id ?? null,
      registry_art_id: component.production_registry?.art_id ?? null,
      path: selectedReference?.path ?? null,
      sha256: selectedReference?.sha256 ?? null,
      authority: selectedReference
        ? "UNIQUE_PRODUCTION_REGISTRY_PRESENTATION_REFERENCE"
        : "MISSING_NO_OFFICIAL_CARTON_FALLBACK_ALLOWED",
    };
  });
  for (const [index, component] of components.entries()) {
    const selectedReference = component.production_registry?.selected_reference ?? null;
    const modelReference = productIdentityReferences[index];
    assert(
      modelReference.path === (selectedReference?.path ?? null) &&
        modelReference.sha256 === (selectedReference?.sha256 ?? null),
      `Model product reference escaped registry selection for ${row.sku} component ${index + 1}`,
    );
    if (!selectedReference) {
      assert(
        modelReference.path === null && modelReference.sha256 === null,
        `Official carton fallback leaked into model inputs for ${row.sku} component ${index + 1}`,
      );
    }
  }
  const styleClassFixtureReference = {
    role: "OWNER_APPROVED_STYLE_CLASS_FIXTURE",
    presentation_class: fixture.presentation_class,
    proof_id: fixture.proof_id,
    path: fixture.path,
    sha256: fixture.sha256,
    width: fixture.width,
    height: fixture.height,
    approval_id: fixture.approval_id,
    approval_sha256: fixture.approval_sha256,
    scope: fixture.scope,
    authority: "STYLE_CLASS_ONLY_NEVER_PRODUCT_IDENTITY",
  };
  const orderedReferences = [kitAnchorReference, ...productIdentityReferences];
  const modelInputContract = {
    schema_version: "uncrustables-gpt-image-2-model-input-contract/v1",
    fail_closed: true,
    separation_rule:
      "Product identity inputs come only from unique presentation-specific production-registry selected_reference values. The owner-approved style fixture is a separate style-only input and cannot fill any product identity gap.",
    kit_anchor_reference: kitAnchorReference,
    product_identity_references: productIdentityReferences,
    style_class_fixture_reference: styleClassFixtureReference,
    ordered_model_inputs: [
      {
        model_input_index: 1,
        input_class: "KIT_ANCHOR",
        ...kitAnchorReference,
      },
      ...productIdentityReferences.map((reference, index) => ({
        model_input_index: index + 2,
        input_class: "PRODUCT_IDENTITY",
        ...reference,
      })),
      {
        model_input_index: productIdentityReferences.length + 2,
        input_class: "STYLE_CLASS_FIXTURE",
        ...styleClassFixtureReference,
      },
    ],
  };
  const generationAllowed = blockers.length === 0;
  const prompt = promptText({
    row,
    presentation,
    components,
    cooler: coolerFor(row.recipe.effective_total_units),
    modelInputContract,
    blocked: !generationAllowed,
  });
  const promptSpecBody = {
    schema_version: "uncrustables-gpt-image-2-prompt-spec/v1",
    required_model: "gpt-image-2",
    quality: "high",
    output: { width: 2048, height: 2048, format: "png" },
    sku: row.sku,
    asin: row.asin,
    recipe_fingerprint_sha256: row.recipe.fingerprint_sha256,
    effective_total_units: row.recipe.effective_total_units,
    cooler_size: coolerFor(row.recipe.effective_total_units),
    presentation,
    components,
    ordered_reference_contract: orderedReferences,
    model_input_contract: modelInputContract,
    owner_approved_style_fixture_set: styleFixtures,
    selected_owner_approved_class_fixture: fixture,
    prompt,
    prompt_sha256: sha256(prompt),
  };
  const promptSpec = {
    ...promptSpecBody,
    sha256: sha256(JSON.stringify(promptSpecBody)),
  };
  return {
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    action: "GENERATE_GPT_IMAGE_2",
    readiness: generationAllowed
      ? "REFERENCE_READY_FOR_CONTROLLED_GENERATION"
      : "PLANNED_BUT_BLOCKED_BY_REFERENCE_GAPS",
    recipe: row.recipe,
    prompt_spec: promptSpec,
    generation_allowed: generationAllowed,
    generation_blockers: blockers,
    generated_output: null,
    amazon_write_authorized: false,
    publication_gate: "Generated bytes require exact output SHA, machine QA, structured authenticity observation, image-bound owner approval, production permit, and fresh Amazon compare-and-swap.",
  };
});

const reuseRows = rows.filter((row) => row.action === "REUSE_EXACT_GOOD");
const blockedReuseQaRows = rows.filter((row) => row.action === "BLOCKED_REUSE_QA");
const generateRows = rows.filter((row) => row.action === "GENERATE_GPT_IMAGE_2");
const identityBlockedRows = rows.filter((row) => row.action === "BLOCKED_IDENTITY");
assert(reuseRows.length === 0, `No donor may remain exact-good, got ${reuseRows.length}`);
assert(blockedReuseQaRows.length === 5, `Expected 5 reuse-QA blocks, got ${blockedReuseQaRows.length}`);
assert(
  REUSE_QA_BLOCKS.size === blockedReuseQaRows.length &&
    blockedReuseQaRows.every((row) => REUSE_QA_BLOCKS.has(row.sku)),
  "Reuse QA reclassification does not exactly cover the five prior donors",
);
assert(generateRows.length === 28, `Expected 28 safe-scope generation candidates, got ${generateRows.length}`);
assert(identityBlockedRows.length === 1, `Expected one identity-blocked row, got ${identityBlockedRows.length}`);
assert(identityBlockedRows[0].sku === TY_SKU, "The identity-blocked row is not TY");
assert(
  generateRows.every((row) => row.generation_allowed === false),
  "All 28 generation candidates must remain fail-closed in this artifact",
);

const blockerIndex = new Map();
for (const row of generateRows) {
  for (const blocker of row.generation_blockers) {
    const current = blockerIndex.get(blocker.code) ?? {
      code: blocker.code,
      affected_skus: [],
      examples: [],
    };
    current.affected_skus.push(row.sku);
    if (current.examples.length < 3) current.examples.push(blocker.message);
    blockerIndex.set(blocker.code, current);
  }
}
const blockerSummary = [...blockerIndex.values()]
  .map((entry) => ({
    ...entry,
    affected_skus: uniqueSorted(entry.affected_skus),
    affected_sku_count: new Set(entry.affected_skus).size,
  }))
  .sort((left, right) => left.code.localeCompare(right.code));

const missingRegistryMappings = new Map();
for (const row of generateRows) {
  for (const component of row.prompt_spec.components) {
    if (!component.canonical_flavor_id || component.production_registry) continue;
    const current = missingRegistryMappings.get(component.canonical_flavor_id) ?? {
      canonical_flavor_id: component.canonical_flavor_id,
      canonical_label: component.canonical_label,
      product_names: [],
      official_package_art: component.official_package_art,
      affected_skus: [],
    };
    current.product_names.push(component.product_name);
    current.affected_skus.push(row.sku);
    missingRegistryMappings.set(component.canonical_flavor_id, current);
  }
}

const sourceDescriptors = Object.values(loaded).map((item) => item.descriptor);
const body = {
  schema_version: "uncrustables-main-production-readiness/v1.0.0",
  artifact_id: "UMPR-20260718-V1",
  artifact_date: "2026-07-18",
  immutable: true,
  status: "SEALED_LOCAL_PLAN_NO_GENERATION_NO_MARKETPLACE_WRITE",
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
    marketplace_write_authorized: false,
  },
  contract: {
    repair_partition: "34 = 0 REUSE_EXACT_GOOD + 5 BLOCKED_REUSE_QA + 28 planned GENERATE_GPT_IMAGE_2 + 1 TY identity block",
    reference_order: "The kit anchor is the first model input. Every product identity input must be the unique presentation-specific production-registry selected_reference; an official carton image is audit metadata only and can never be a model-input fallback.",
    class_approval_scope: "The exact selected owner-approved fixture is a separate style-only model input. It authorizes class-level composition comparison only, never product identity or unseen output bytes.",
  },
  sources: sourceDescriptors,
  kit_anchor: {
    path: SOURCES.anchor.path,
    sha256: SOURCES.anchor.expected_sha256,
    required_reference_index: 1,
  },
  reuse_exact_good_gate: REUSE_EXACT_GOOD_GATE,
  owner_approved_style_fixtures: styleFixtures,
  summary: {
    repair_rows: rows.length,
    reuse_exact_good: reuseRows.length,
    blocked_reuse_qa: blockedReuseQaRows.length,
    planned_gpt_image_2_candidates: generateRows.length,
    identity_blocked: identityBlockedRows.length,
    generation_reference_ready: generateRows.filter((row) => row.generation_allowed).length,
    generation_blocked_by_reference_gaps: generateRows.filter((row) => !row.generation_allowed).length,
    prompt_specs_built: generateRows.filter((row) => row.prompt_spec).length,
    images_generated: 0,
    amazon_rows_changed: 0,
    official_package_art_files_verified: officialAssetChecks.size,
    registry_evidence_files_verified: registryEvidenceChecks.size,
  },
  missing_authenticity_mappings: [...missingRegistryMappings.values()]
    .map((entry) => ({
      ...entry,
      product_names: uniqueSorted(entry.product_names),
      affected_skus: uniqueSorted(entry.affected_skus),
    }))
    .sort((left, right) =>
      left.canonical_flavor_id.localeCompare(right.canonical_flavor_id),
    ),
  blocker_summary: blockerSummary,
  rows,
};

const bodySha256 = sha256(JSON.stringify(body));
const artifact = {
  ...body,
  seal: {
    algorithm: "sha256",
    scope: "Compact JSON serialization of all top-level fields before seal, in emitted key order",
    body_sha256: bodySha256,
  },
};
const output = `${JSON.stringify(artifact, null, 2)}\n`;
writeFileSync(absolute(OUTPUT_PATH), output);
const fileSha256 = sha256(output);
writeFileSync(
  absolute(`${OUTPUT_PATH}.sha256`),
  `${fileSha256}  ${OUTPUT_PATH.split("/").at(-1)}\n`,
);

process.stdout.write(
  `${OUTPUT_PATH}\nbody_sha256=${bodySha256}\nfile_sha256=${fileSha256}\nREUSE_EXACT_GOOD=${reuseRows.length}\nBLOCKED_REUSE_QA=${blockedReuseQaRows.length}\nGENERATE_GPT_IMAGE_2=${generateRows.length}\nIDENTITY_BLOCKED=${identityBlockedRows.length}\nGENERATION_REFERENCE_READY=${body.summary.generation_reference_ready}\nGENERATION_BLOCKED=${body.summary.generation_blocked_by_reference_gaps}\n`,
);
