import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

const SOURCE = {
  ownerRelaxed:
    "data/audits/uncrustables-owner-relaxed-main-20260719-v1/uncrustables-owner-relaxed-main-20260719-v1.json",
  strictV8: "data/audits/uncrustables-live-main-strict-reaudit-20260718-v8.json",
  readinessV7: "data/audits/uncrustables-main-repair-readiness-20260718-v7.json",
  officialArt: "data/audits/uncrustables-official-package-art-20260718/manifest.json",
};

const OUTPUT_DIR =
  "data/audits/uncrustables-owner-relaxed-main-repair-matrix-20260719-v1";
const OUTPUT_STEM = "uncrustables-owner-relaxed-main-repair-matrix-20260719-v1";

const EXPECTED_ORDINALS = [
  4, 15, 21, 29, 40, 59, 65, 67, 80, 84, 94, 96, 110, 113, 115, 116,
  123, 127, 134, 135, 138, 142, 146, 163,
];

const DIRECT_REUSE = new Map([
  [80, 106],
  [96, 71],
  [134, 161],
]);

const TARGETED_COMPONENT_EDIT = new Set([
  4, 15, 21, 29, 59, 113, 115, 123, 127, 142,
]);

const PRESENTATION_FALLBACK = new Map([
  [15, "retail_boxes_mix"],
  [127, "retail_boxes_mix"],
]);

const MANUAL_CARTON_COUNT = new Map([
  ["15:reduced-sugar-strawberry-on-wheat", 4],
  ["15:peanut-butter-blackberry", 4],
  ["127:peanut-butter", 4],
  ["127:peanut-butter-strawberry", 4],
]);

const OFFICIAL_ART_ID = {
  "peanut-butter": "peanut-butter",
  "peanut-butter-grape": "peanut-butter-grape",
  "peanut-butter-strawberry": "peanut-butter-strawberry",
  "peanut-butter-raspberry": "peanut-butter-raspberry",
  "chocolate-hazelnut": "chocolate-hazelnut",
  "peanut-butter-honey": "peanut-butter-honey",
  "reduced-sugar-grape-on-wheat": "reduced-sugar-grape-on-wheat",
  "reduced-sugar-strawberry-on-wheat": "reduced-sugar-strawberry-on-wheat",
  "up-and-apple-protein": "up-and-apple-protein",
  "bright-eyed-berry-protein": "bright-eyed-berry-protein",
  "morning-protein-mixed-berry": "beamin-berry-blend-protein",
  "burstin-blueberry-protein": "burstin-blueberry-protein",
  "peanut-butter-blackberry": "peanut-butter-blackberry",
};

const LABEL = {
  "peanut-butter": "Peanut Butter",
  "peanut-butter-grape": "Peanut Butter & Grape Jelly",
  "peanut-butter-strawberry": "Peanut Butter & Strawberry Jam",
  "peanut-butter-raspberry": "Peanut Butter & Raspberry Spread",
  "chocolate-hazelnut": "Chocolate Flavored Hazelnut Spread",
  "peanut-butter-honey": "Peanut Butter & Honey Spread",
  "reduced-sugar-grape-on-wheat":
    "Reduced Sugar / Whole Wheat Peanut Butter & Grape",
  "reduced-sugar-strawberry-on-wheat":
    "Reduced Sugar / Whole Wheat Peanut Butter & Strawberry",
  "up-and-apple-protein": "Up & Apple / Apple Cinnamon, 12g Protein",
  "bright-eyed-berry-protein": "Bright-Eyed Berry / Strawberry, 12g Protein",
  "morning-protein-mixed-berry":
    "Beamin' Berry Blend / Morning Protein Peanut Butter & Mixed Berry",
  "burstin-blueberry-protein": "Burstin' Blueberry, 12g Protein",
  "peanut-butter-blackberry": "Peanut Butter & Blackberry Spread",
};

const CURATED_EXEMPLARS = {
  "peanut-butter-raspberry": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/147-XE-ASK1-BNRB-B0H81WMJBP-a2adbeecbaf7.jpg",
      note: "Genuine raspberry retail cartons in the approved Salutem cooler scene.",
    },
  ],
  "morning-protein-mixed-berry": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/129-UJ-ASQ1-9FNR-B0H82P651P-8d6ab260fb5e.jpg",
      note: "Clear Beamin' Berry Blend retail-carton identity.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_WRAPPER_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/071-MP-ASZ9-TKE7-B0H837HLKC-3398bb472d68.jpg",
      note: "Owner-kept individual-wrapper presentation for the 30-count recipe.",
    },
  ],
  "chocolate-hazelnut": [
    {
      role: "APPROVED_REFERENCE_QA_PRODUCT_PHOTO",
      path: "data/audits/uncrustables-approved-reference-qa-20260718/product-hazelnut-target.jpg",
      note: "Pinned product photo used in the approved reference QA set.",
    },
    {
      role: "APPROVED_REFERENCE_QA_WRAPPER_EXEMPLAR",
      path: "data/audits/uncrustables-approved-reference-qa-20260718/B0H85P9F3R-live.jpg",
      note: "Owner-kept hazelnut plus Morning Protein wrapper scene.",
    },
  ],
  "burstin-blueberry-protein": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/121-TQ-ASBR-96TC-B0H82BCZ44-8810e48b121e.jpg",
      note: "Clear genuine Burstin' Blueberry 8-count retail cartons.",
    },
  ],
  "bright-eyed-berry-protein": [
    {
      role: "APPROVED_REFERENCE_QA_PRODUCT_PHOTO",
      path: "data/audits/uncrustables-approved-reference-qa-20260718/product-strawberry-protein-target.jpg",
      note: "Pinned Bright-Eyed Berry product photo.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/130-UY-AS5N-A2E4-B0H83R4M3R-3f161b7094f4.jpg",
      note: "Owner-kept Bright-Eyed Berry retail-carton scene.",
    },
  ],
  "up-and-apple-protein": [
    {
      role: "LOCAL_DONOR_PRODUCT_REFERENCE",
      path: "data/audits/uncrustables-gpt-image-2-previews-20260718/donor-up-and-apple.jpg",
      note: "Local Up & Apple donor reference used by the preview workflow.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/092-QX-AS89-H8YC-B0H82RQ226-efe39efc6ba5.jpg",
      note: "Owner-kept Up & Apple 8-count retail-carton scene.",
    },
  ],
  "peanut-butter-strawberry": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/032-EW-ASWP-PMZX-B0H891WSZ9-e5b7c0f09ad4.jpg",
      note: "Genuine regular strawberry retail cartons; count mismatch is non-blocking under owner norm.",
    },
  ],
  "peanut-butter": [
    {
      role: "LOCAL_DONOR_PRODUCT_REFERENCE",
      path: "data/audits/uncrustables-gpt-image-2-previews-20260718/donor-peanut-butter.jpg",
      note: "Local plain peanut-butter donor reference used by the preview workflow.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/078-PB-ASAF-G2T6-B0H82K7Y7S-299fd08884d2.jpg",
      note: "Owner-kept plain peanut-butter retail-carton scene.",
    },
  ],
  "peanut-butter-grape": [
    {
      role: "LOCAL_DONOR_PRODUCT_REFERENCE",
      path: "data/audits/uncrustables-gpt-image-2-previews-20260718/donor-grape.jpg",
      note: "Local regular grape donor reference used by the preview workflow.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/050-HX-ASO8-XCL2-B0H832SD15-5f6904abd7c5.jpg",
      note: "Owner-kept regular grape product presentation.",
    },
  ],
  "peanut-butter-honey": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/105-RY-ASMO-6N4F-B0H8493HNR-5ce519f944e6.jpg",
      note: "Owner-kept genuine honey cartons beside raspberry cartons.",
    },
  ],
  "reduced-sugar-strawberry-on-wheat": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/069-MF-AS0J-YRT4-B0H82NHQCL-fb8d8cc04357.jpg",
      note: "Owner-kept whole-wheat/reduced-sugar strawberry presentation.",
    },
  ],
  "reduced-sugar-grape-on-wheat": [
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/087-PY-ASBM-WX6W-B0H82B7GV5-622776a2516d.jpg",
      note: "Owner-kept whole-wheat/reduced-sugar grape retail cartons.",
    },
  ],
  "peanut-butter-blackberry": [
    {
      role: "APPROVED_REFERENCE_QA_PRODUCT_PHOTO",
      path: "data/audits/uncrustables-approved-reference-qa-20260718/product-blackberry-target.jpg",
      note: "Pinned blackberry product photo.",
    },
    {
      role: "OWNER_KEEP_LIVE_MAIN_PRODUCT_EXEMPLAR",
      path: "data/audits/uncrustables-live-main-fetch-20260718-v1/assets/035-FK-AS6B-6G25-B0H8259J9G-a15332be530c.jpg",
      note: "Owner-kept single-flavor blackberry MAIN.",
    },
  ],
};

const STYLE_FIXTURE = {
  retail_boxes_single:
    "data/audits/uncrustables-gpt-image-2-previews-20260718/01c-retail-boxes-single-pb-24-four-gel-packs.png",
  retail_boxes_mix:
    "data/audits/uncrustables-gpt-image-2-previews-20260718/02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs.png",
  individual_wraps:
    "data/audits/uncrustables-gpt-image-2-previews-20260718/03-individual-wraps-mix-hazelnut-berry-24.png",
};

const KIT_ANCHOR = "public/bundle-factory/frozen-refs/ref-uncrustables.png";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function fileHash(path) {
  return sha256(await readFile(join(root, path)));
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function variantId(productName) {
  const name = productName.toLowerCase();
  if (name.includes("morning protein") && name.includes("mixed berry"))
    return "morning-protein-mixed-berry";
  if (name.includes("blueberry")) return "burstin-blueberry-protein";
  if (name.includes("apple cinnamon")) return "up-and-apple-protein";
  if (name.includes("12g protein") && name.includes("strawberry"))
    return "bright-eyed-berry-protein";
  if (name.includes("whole wheat") && name.includes("strawberry"))
    return "reduced-sugar-strawberry-on-wheat";
  if (name.includes("whole wheat") && name.includes("grape"))
    return "reduced-sugar-grape-on-wheat";
  if (name.includes("chocolate") && name.includes("hazelnut"))
    return "chocolate-hazelnut";
  if (name.includes("blackberry")) return "peanut-butter-blackberry";
  if (name.includes("raspberry")) return "peanut-butter-raspberry";
  if (name.includes("honey")) return "peanut-butter-honey";
  if (name.includes("grape")) return "peanut-butter-grape";
  if (name.includes("strawberry")) return "peanut-butter-strawberry";
  if (name.includes("peanut butter")) return "peanut-butter";
  throw new Error(`Unmapped Uncrustables product: ${productName}`);
}

function parsePackClaim(productName) {
  const slashPack = productName.match(/([\d.]+)\s*oz\s*\/\s*(\d+)\s*ct/i);
  const countPack = productName.match(/(\d+)\s*Count/i);
  const eachSize = productName.match(/([\d.]+)\s*oz\s*Each/i);
  return {
    raw_product_name: productName,
    source_pack_count_claim: slashPack
      ? Number(slashPack[2])
      : countPack
        ? Number(countPack[1])
        : null,
    source_pack_net_weight_oz: slashPack ? Number(slashPack[1]) : null,
    base_unit_size_oz: eachSize ? Number(eachSize[1]) : null,
  };
}

function recipeSignature(components) {
  return components
    .map((component) => `${variantId(component.product_name)}::${component.qty}`)
    .sort()
    .join("||");
}

function sourceRecipeSignature(components) {
  return components
    .map((component) => `${component.product_name}::${component.qty}`)
    .sort()
    .join("||");
}

async function asset(path, role, extra = {}) {
  const absolutePath = join(root, path);
  return {
    role,
    relative_path: path,
    absolute_path: absolutePath,
    sha256: await fileHash(path),
    ...extra,
  };
}

function uniqueAssets(assets) {
  const seen = new Set();
  return assets.filter((entry) => {
    const key = `${entry.role}:${entry.relative_path}:${entry.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const [ownerRelaxed, strictV8, readinessV7, officialArt] = await Promise.all([
  readJson(SOURCE.ownerRelaxed),
  readJson(SOURCE.strictV8),
  readJson(SOURCE.readinessV7),
  readJson(SOURCE.officialArt),
]);

const relaxedByOrdinal = new Map(
  ownerRelaxed.rows.map((row) => [row.ordinal, row]),
);
const strictByOrdinal = new Map(strictV8.rows.map((row) => [row.ordinal, row]));
const readinessByOrdinal = new Map(
  readinessV7.rows.map((row) => [row.ordinal, row]),
);
const officialById = new Map(
  officialArt.records
    .filter((record) => record.status === "CAPTURED")
    .map((record) => [record.flavor_id, record]),
);

assert(
  JSON.stringify(ownerRelaxed.summary.change_ordinals) ===
    JSON.stringify(EXPECTED_ORDINALS),
  "Owner-relaxed CHANGE ordinals do not match the sealed 24-row scope.",
);

const kitAnchor = await asset(KIT_ANCHOR, "OWNER_APPROVED_KIT_ANCHOR", {
  authority: "KIT_GEOMETRY_BRANDING_AND_GEL_PACKS",
});
const styleFixtureCache = new Map();
for (const [presentation, path] of Object.entries(STYLE_FIXTURE)) {
  styleFixtureCache.set(
    presentation,
    await asset(path, "OWNER_APPROVED_STYLE_CLASS_FIXTURE", {
      presentation_class: presentation,
      authority: "COMPOSITION_AND_FINISH_ONLY",
    }),
  );
}

const exemplarCache = new Map();
for (const [id, entries] of Object.entries(CURATED_EXEMPLARS)) {
  exemplarCache.set(
    id,
    await Promise.all(
      entries.map((entry) =>
        asset(entry.path, entry.role, {
          canonical_variant_id: id,
          authority: "LOCAL_REFERENCE_INVENTORY",
          note: entry.note,
        }),
      ),
    ),
  );
}

const rows = [];
for (const ordinal of EXPECTED_ORDINALS) {
  const relaxed = relaxedByOrdinal.get(ordinal);
  const strict = strictByOrdinal.get(ordinal);
  const readiness = readinessByOrdinal.get(ordinal);
  assert(relaxed?.owner_decision === "CHANGE", `Ordinal ${ordinal} is not CHANGE.`);
  assert(strict, `Missing strict-v8 row ${ordinal}.`);

  const presentationClass =
    readiness?.presentation?.presentation_class ?? PRESENTATION_FALLBACK.get(ordinal);
  assert(presentationClass, `Missing presentation class for ordinal ${ordinal}.`);
  const styleFixture = styleFixtureCache.get(presentationClass);
  assert(styleFixture, `Missing style fixture for ${presentationClass}.`);

  const readinessComponents = new Map(
    (readiness?.components ?? []).map((component) => [
      component.canonical_flavor_id,
      component,
    ]),
  );

  const components = [];
  for (let index = 0; index < strict.recipe_components.length; index += 1) {
    const recipeComponent = strict.recipe_components[index];
    const id = variantId(recipeComponent.product_name);
    const officialId = OFFICIAL_ART_ID[id];
    const official = officialById.get(officialId);
    assert(official, `No official art for ${id} (ordinal ${ordinal}).`);
    const officialAsset = await asset(
      official.local_path,
      "OFFICIAL_MANUFACTURER_EXACT_VARIANT_ART",
      {
        canonical_variant_id: id,
        manufacturer_flavor_id: official.flavor_id,
        source_page: official.source_page,
        source_page_sha256: official.source_page_sha256,
        authority: officialArt.source_authority,
      },
    );
    assert(
      officialAsset.sha256 === official.package_art_sha256,
      `Official-art hash mismatch for ${official.local_path}.`,
    );

    const readinessComponent = readinessComponents.get(id);
    const genuineCartonCount =
      readinessComponent?.genuine_carton_count ??
      MANUAL_CARTON_COUNT.get(`${ordinal}:${id}`) ??
      null;
    const packMode = presentationClass === "individual_wraps"
      ? "individual-wrapper"
      : "retail-carton";
    const visiblePlan =
      packMode === "individual-wrapper"
        ? {
            mode: "individual-wrapper",
            required_visible_units: recipeComponent.qty,
            note:
              "Aggregate listing quantity; owner norm does not require pixel-count perfection, but no flavor substitution is allowed.",
          }
        : {
            mode: "retail-carton",
            genuine_reference_carton_count: genuineCartonCount,
            preferred_visible_cartons:
              genuineCartonCount && recipeComponent.qty % genuineCartonCount === 0
                ? recipeComponent.qty / genuineCartonCount
                : null,
            required_listing_units: recipeComponent.qty,
            note:
              "Use only a genuine pack-size design; minor visible-count/layout variance is non-blocking under the owner-approved relaxed norm.",
          };

    const referenceAssets = uniqueAssets([
      officialAsset,
      ...(exemplarCache.get(id) ?? []),
    ]);
    components.push({
      recipe_position: index + 1,
      canonical_variant_id: id,
      canonical_label: LABEL[id],
      exact_product_name: recipeComponent.product_name,
      required_listing_units: recipeComponent.qty,
      recipe_source_pack_claim: parsePackClaim(recipeComponent.product_name),
      preferred_visual_pack_mode: packMode,
      visual_count_plan: visiblePlan,
      local_reference_assets: referenceAssets,
      local_exact_variant_reference_present: true,
    });
  }

  const currentMain = await asset(
    relaxed.evidence.asset_local_path,
    "CURRENT_MAIN_COMPOSITION_REFERENCE",
    {
      source_main_image_url: relaxed.source_main_image_url,
      authority: "OWNER_REVIEWED_LIVE_MAIN",
    },
  );
  assert(
    currentMain.sha256 === relaxed.evidence.asset_sha256,
    `Current MAIN hash mismatch for ordinal ${ordinal}.`,
  );

  const directReuseOrdinal = DIRECT_REUSE.get(ordinal) ?? null;
  let directReuse = null;
  if (directReuseOrdinal != null) {
    const sourceRelaxed = relaxedByOrdinal.get(directReuseOrdinal);
    const sourceStrict = strictByOrdinal.get(directReuseOrdinal);
    assert(
      sourceRelaxed?.owner_decision === "KEEP",
      `Direct-reuse source ${directReuseOrdinal} is not owner KEEP.`,
    );
    assert(
      recipeSignature(strict.recipe_components) ===
        recipeSignature(sourceStrict.recipe_components),
      `Direct-reuse recipe mismatch: ${ordinal} -> ${directReuseOrdinal}.`,
    );
    assert(
      sourceRecipeSignature(strict.recipe_components) ===
        sourceRecipeSignature(sourceStrict.recipe_components),
      `Direct-reuse source-product recipe mismatch: ${ordinal} -> ${directReuseOrdinal}.`,
    );
    directReuse = {
      source_ordinal: directReuseOrdinal,
      source_sku: sourceRelaxed.sku,
      source_asin: sourceRelaxed.asin,
      source_title: sourceRelaxed.title,
      owner_decision: sourceRelaxed.owner_decision,
      normalized_exact_variant_recipe_signature: recipeSignature(
        sourceStrict.recipe_components,
      ),
      source_product_recipe_signature: sourceRecipeSignature(
        sourceStrict.recipe_components,
      ),
      asset: await asset(
        sourceRelaxed.evidence.asset_local_path,
        "DIRECT_REUSE_OWNER_KEEP_EXACT_RECIPE_MAIN",
        {
          authority: "OWNER_RELAXED_KEEP_EXACT_RECIPE",
        },
      ),
    };
    assert(
      directReuse.asset.sha256 === sourceRelaxed.evidence.asset_sha256,
      `Direct-reuse asset hash mismatch for ${ordinal}.`,
    );
  }

  const action = directReuse
    ? "DIRECT_REUSE_EXISTING_OWNER_KEEP_MAIN"
    : TARGETED_COMPONENT_EDIT.has(ordinal)
      ? "GPT_IMAGE_2_EDIT_TARGETED_PRODUCT_COMPONENTS"
      : "GPT_IMAGE_2_EDIT_REPLACE_ALL_PRODUCT_PACKAGING";
  const generationGroup = directReuse
    ? null
    : ordinal === 4 || ordinal === 123
      ? "shared-raspberry-morning-mixed-berry-24"
      : `ordinal-${String(ordinal).padStart(3, "0")}-${strict.sku}`;

  const allReferences = uniqueAssets([
    currentMain,
    kitAnchor,
    styleFixture,
    ...components.flatMap((component) => component.local_reference_assets),
    ...(directReuse ? [directReuse.asset] : []),
  ]);

  rows.push({
    ordinal,
    sku: strict.sku,
    asin: strict.asin,
    title: strict.title,
    owner_change_reason_code: relaxed.owner_reason_code,
    owner_change_reason: relaxed.owner_reason,
    normalized_exact_variant_recipe_signature: recipeSignature(
      strict.recipe_components,
    ),
    source_product_recipe_signature: sourceRecipeSignature(
      strict.recipe_components,
    ),
    effective_total_units: strict.effective_total_units,
    presentation_class: presentationClass,
    required_real_product_components: components,
    current_main: currentMain,
    repair_decision: {
      action,
      preserve_current_cooler_scene_and_composition:
        action !== "DIRECT_REUSE_EXISTING_OWNER_KEEP_MAIN",
      gpt_image_2_required:
        action !== "DIRECT_REUSE_EXISTING_OWNER_KEEP_MAIN",
      product_layer_scope: directReuse
        ? "NONE_USE_EXISTING_EXACT_RECIPE_MAIN"
        : TARGETED_COMPONENT_EDIT.has(ordinal)
          ? "TARGETED_WRONG_OR_MISSING_COMPONENTS_ONLY"
          : "ALL_VISIBLE_PRODUCT_PACKAGING",
      generation_group: generationGroup,
      direct_reuse: directReuse,
      rationale: directReuse
        ? "An owner-KEEP local MAIN with the same normalized exact recipe already exists; no new image generation is needed."
        : "The current cooler, gel-pack scene, camera and overall layout remain usable; GPT Image 2 is needed only because the raster product layer contains a missing, wrong or fictional product and has no editable source layers.",
    },
    all_local_reference_assets: allReferences,
    reference_gap: false,
  });
}

const uniqueGenerationGroups = new Set(
  rows
    .map((row) => row.repair_decision.generation_group)
    .filter((value) => value != null),
);
const uniqueVariants = new Set(
  rows.flatMap((row) =>
    row.required_real_product_components.map(
      (component) => component.canonical_variant_id,
    ),
  ),
);

const sourceRecords = [];
for (const [key, path] of Object.entries(SOURCE)) {
  sourceRecords.push({
    role: key,
    relative_path: path,
    absolute_path: join(root, path),
    sha256: await fileHash(path),
  });
}

const baseArtifact = {
  schema_version: "uncrustables-owner-relaxed-main-repair-matrix/v1",
  artifact_id: OUTPUT_STEM,
  created_at: "2026-07-19T00:00:00.000Z",
  immutable: true,
  scope: {
    marketplace: "Amazon US",
    brand: "Smucker's Uncrustables",
    source_decision_registry: SOURCE.ownerRelaxed,
    owner_change_rows: EXPECTED_ORDINALS.length,
  },
  owner_policy: {
    standard:
      "Keep existing good MAIN images. Repair only a genuinely missing, wrong, fictional or non-existent product/package. Minor count/layout/ice/text imperfections are non-blocking.",
    image_model_when_needed: "gpt-image-2",
    preserve_good_scene: true,
  },
  safety: {
    network_reads: 0,
    paid_calls: 0,
    image_generations: 0,
    amazon_writes: 0,
    channelmax_writes: 0,
    database_writes: 0,
    statement: "Read-only local planning artifact; no generation or external mutation.",
  },
  summary: {
    rows: rows.length,
    direct_reuse_existing_owner_keep_main: rows.filter(
      (row) =>
        row.repair_decision.action ===
        "DIRECT_REUSE_EXISTING_OWNER_KEEP_MAIN",
    ).length,
    gpt_image_2_rows: rows.filter(
      (row) => row.repair_decision.gpt_image_2_required,
    ).length,
    unique_gpt_image_2_outputs: uniqueGenerationGroups.size,
    targeted_product_component_edits: rows.filter(
      (row) =>
        row.repair_decision.action ===
        "GPT_IMAGE_2_EDIT_TARGETED_PRODUCT_COMPONENTS",
    ).length,
    full_visible_product_layer_replacements: rows.filter(
      (row) =>
        row.repair_decision.action ===
        "GPT_IMAGE_2_EDIT_REPLACE_ALL_PRODUCT_PACKAGING",
    ).length,
    preserve_current_composition_rows: rows.filter(
      (row) =>
        row.repair_decision.preserve_current_cooler_scene_and_composition,
    ).length,
    unique_required_real_variants: uniqueVariants.size,
    exact_local_variant_reference_coverage: `${rows.filter((row) => !row.reference_gap).length}/${rows.length}`,
    reference_gaps: rows.filter((row) => row.reference_gap).length,
    shared_generation_groups: [
      {
        generation_group: "shared-raspberry-morning-mixed-berry-24",
        ordinals: [4, 123],
        skus: ["AJ-ASRB-HKC3", "TY-AST2-JE9P"],
        note: "Same normalized exact recipe; one approved output can serve both ASINs.",
      },
    ],
  },
  sources: sourceRecords,
  rows,
};

const bodySha256 = sha256(Buffer.from(JSON.stringify(baseArtifact)));
const artifact = { ...baseArtifact, body_sha256: bodySha256 };

await mkdir(join(root, OUTPUT_DIR), { recursive: true });
const jsonPath = join(root, OUTPUT_DIR, `${OUTPUT_STEM}.json`);
const csvPath = join(root, OUTPUT_DIR, `${OUTPUT_STEM}.csv`);

await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

const csvColumns = [
  "ordinal",
  "sku",
  "asin",
  "title",
  "owner_change_reason_code",
  "effective_total_units",
  "presentation_class",
  "normalized_exact_variant_recipe_signature",
  "source_product_recipe_signature",
  "required_real_product_components",
  "repair_action",
  "preserve_current_composition",
  "gpt_image_2_required",
  "generation_group",
  "direct_reuse_source_sku",
  "direct_reuse_source_asin",
  "direct_reuse_asset_relative_path",
  "direct_reuse_asset_absolute_path",
  "direct_reuse_asset_sha256",
  "current_main_relative_path",
  "current_main_absolute_path",
  "current_main_sha256",
  "local_reference_assets",
  "reference_gap",
];
const csvLines = [csvColumns.map(csvCell).join(",")];
for (const row of rows) {
  const direct = row.repair_decision.direct_reuse;
  const values = {
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    owner_change_reason_code: row.owner_change_reason_code,
    effective_total_units: row.effective_total_units,
    presentation_class: row.presentation_class,
    normalized_exact_variant_recipe_signature:
      row.normalized_exact_variant_recipe_signature,
    source_product_recipe_signature: row.source_product_recipe_signature,
    required_real_product_components: row.required_real_product_components
      .map(
        (component) =>
          `${component.canonical_label} | ${component.recipe_source_pack_claim.source_pack_count_claim ?? "unknown"}ct source pack | ${component.required_listing_units} listing units`,
      )
      .join(" || "),
    repair_action: row.repair_decision.action,
    preserve_current_composition:
      row.repair_decision.preserve_current_cooler_scene_and_composition,
    gpt_image_2_required: row.repair_decision.gpt_image_2_required,
    generation_group: row.repair_decision.generation_group,
    direct_reuse_source_sku: direct?.source_sku,
    direct_reuse_source_asin: direct?.source_asin,
    direct_reuse_asset_relative_path: direct?.asset.relative_path,
    direct_reuse_asset_absolute_path: direct?.asset.absolute_path,
    direct_reuse_asset_sha256: direct?.asset.sha256,
    current_main_relative_path: row.current_main.relative_path,
    current_main_absolute_path: row.current_main.absolute_path,
    current_main_sha256: row.current_main.sha256,
    local_reference_assets: row.all_local_reference_assets
      .map(
        (entry) =>
          `${entry.role}:${entry.relative_path}#sha256=${entry.sha256}`,
      )
      .join(" || "),
    reference_gap: row.reference_gap,
  };
  csvLines.push(csvColumns.map((column) => csvCell(values[column])).join(","));
}
await writeFile(csvPath, `${csvLines.join("\n")}\n`, "utf8");

for (const path of [jsonPath, csvPath]) {
  const hash = sha256(await readFile(path));
  const rel = relative(root, path);
  await writeFile(`${path}.sha256`, `${hash}  ${rel}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      output_dir: join(root, OUTPUT_DIR),
      json: relative(root, jsonPath),
      csv: relative(root, csvPath),
      summary: artifact.summary,
    },
    null,
    2,
  ),
);
