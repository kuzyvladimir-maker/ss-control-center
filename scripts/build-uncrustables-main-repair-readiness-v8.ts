#!/usr/bin/env -S node --import tsx

/**
 * Build the complete 134-row fail-closed MAIN repair readiness queue from the
 * exhaustive strict v8 audit. Existing v7 rows are re-sealed; the 30 newly
 * reclassified rows are resolved locally against the pinned Product Truth,
 * official-art, identity, and authenticity-registry artifacts.
 *
 * No model, network, database, R2, Amazon, or ChannelMAX operation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const sources = {
  predecessor_readiness: {
    role: "PREDECESSOR_READINESS_QUEUE_V7",
    path: "data/audits/uncrustables-main-repair-readiness-20260718-v7.json",
    file_sha256:
      "83195c1a3b76024e5ab228b6f58b16681f87ca2df89208f84b9df0af21971ed5",
    body_sha256:
      "01f2d51cdd9697c11bb989b2cd8b4156ac418e72bed2e5c014946d90904fbb0b",
  },
  strict_audit: {
    role: "STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT_V8",
    path: "data/audits/uncrustables-live-main-strict-reaudit-20260718-v8.json",
    file_sha256:
      "2d78d37398fff719086435233afa198a5b0a33479535452b6b8652b3558d3c3b",
    body_sha256:
      "b2ca38412c74ace932eca3bf0d14b1e1b40e44443f8c7b1de6185dfbdee7f3bd",
  },
  authenticity_registry: {
    role: "PRODUCTION_AUTHENTICITY_REGISTRY",
    path: "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json",
    file_sha256:
      "10cc967a28643c86653e713729952cac12aba083d83dd2a2608be120e6aeae11",
  },
  owner_style_approvals: {
    role: "OWNER_APPROVED_STYLE_FIXTURES_SCENE_COMPLETE_V2",
    path: "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v2.json",
    file_sha256:
      "20e3ff4c1833ad417c665f7bc76700d6a4fe7de118ecc9989c804231929a3422",
  },
  official_art: {
    role: "OFFICIAL_PACKAGE_ART_AUDIT_MANIFEST",
    path: "data/audits/uncrustables-official-package-art-20260718/manifest.json",
    file_sha256:
      "e961809487e06c3344ffa01592f27a9ec0722626d2e01cea6bf401d9618b2074",
  },
  official_legacy_mixed_berry_art: {
    role: "OFFICIAL_PACKAGE_ART_AUDIT_SUPPLEMENT",
    path: "data/audits/uncrustables-official-package-art-legacy-mixed-berry-20260718/manifest.json",
    file_sha256:
      "d796dc7b89a1023523d591672757475f2c9b0a2103bb65cdab3b118dea48b1c5",
  },
  catalog_identity: {
    role: "CATALOG_IDENTITY_DECISION",
    path: "data/audits/uncrustables-catalog-identity-decision-20260718T072304000Z-00afce6e6bf8.json",
    file_sha256:
      "205e195cfc148a3d8871b56c5471f5657e245d9840b5cf6430b7fd3d20d6731a",
  },
  frozen_spec: {
    role: "FROZEN_MAIN_SPEC_V2_PRINTED_MARK_CLARIFIED",
    path: "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md",
    file_sha256:
      "331ce50e375910ae58a4908bfa8d815874bc29b29f6d8014dd4a4f662cfb8e84",
  },
  kit_anchor: {
    role: "IMMUTABLE_KIT_ANCHOR",
    path: "public/bundle-factory/frozen-refs/ref-uncrustables.png",
    file_sha256:
      "9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33",
  },
} as const;

const outputJson =
  "data/audits/uncrustables-main-repair-readiness-20260718-v8.json";
const outputCsv =
  "data/audits/uncrustables-main-repair-readiness-20260718-v8.csv";

const productMap = new Map<
  string,
  {
    canonical_flavor_id: string;
    official_flavor_id: string;
    canonical_label: string;
    genuine_carton_count: number;
  }
>([
  ["Smucker's Uncrustables Chocolate Flavored Hazelnut Spread Frozen Sandwich - 18oz/10ct", { canonical_flavor_id: "chocolate-hazelnut", official_flavor_id: "chocolate-hazelnut", canonical_label: "Chocolate Flavored Hazelnut Spread", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen  Whole Wheat Peanut Butter & Grape Jelly Sandwiches - 8oz/4ct", { canonical_flavor_id: "reduced-sugar-grape-on-wheat", official_flavor_id: "reduced-sugar-grape-on-wheat", canonical_label: "Reduced Sugar Peanut Butter & Grape Jelly on Wheat", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein 22.4oz/8ct", { canonical_flavor_id: "up-and-apple-protein", official_flavor_id: "up-and-apple-protein", canonical_label: "Up & Apple Peanut Butter & Apple Cinnamon Jelly, 12g Protein", genuine_carton_count: 8 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct", { canonical_flavor_id: "peanut-butter-blackberry", official_flavor_id: "peanut-butter-blackberry", canonical_label: "Peanut Butter & Blackberry Spread", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Blueberry Sandwich - 22.4oz/8ct", { canonical_flavor_id: "burstin-blueberry-protein", official_flavor_id: "burstin-blueberry-protein", canonical_label: "Burstin' Blueberry Peanut Butter & Blueberry, 12g Protein", genuine_carton_count: 8 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct", { canonical_flavor_id: "peanut-butter-grape", official_flavor_id: "peanut-butter-grape", canonical_label: "Peanut Butter & Grape Jelly", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Honey Spread Sandwich - 20oz/10ct", { canonical_flavor_id: "peanut-butter-honey", official_flavor_id: "peanut-butter-honey", canonical_label: "Peanut Butter & Honey Spread", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct", { canonical_flavor_id: "peanut-butter-strawberry", official_flavor_id: "peanut-butter-strawberry", canonical_label: "Peanut Butter & Strawberry Jam", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct", { canonical_flavor_id: "bright-eyed-berry-protein", official_flavor_id: "bright-eyed-berry-protein", canonical_label: "Bright-Eyed Berry Peanut Butter & Strawberry Jam, 12g Protein", genuine_carton_count: 8 }],
  ["Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct", { canonical_flavor_id: "peanut-butter", official_flavor_id: "peanut-butter", canonical_label: "Peanut Butter Sandwich", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Frozen Whole Wheat Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct", { canonical_flavor_id: "reduced-sugar-strawberry-on-wheat", official_flavor_id: "reduced-sugar-strawberry-on-wheat", canonical_label: "Reduced Sugar Peanut Butter & Strawberry Jam on Wheat", genuine_carton_count: 4 }],
  ["Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct", { canonical_flavor_id: "morning-protein-mixed-berry", official_flavor_id: "beamin-berry-blend-protein", canonical_label: "Beamin' Berry Blend / Morning Protein Peanut Butter & Mixed Berry Spread", genuine_carton_count: 8 }],
  ["Smucker's Uncrustables Peanut Butter & Strawberry Jam Sandwich (2 oz, individually wrapped, frozen)", { canonical_flavor_id: "peanut-butter-strawberry", official_flavor_id: "peanut-butter-strawberry", canonical_label: "Peanut Butter & Strawberry Jam", genuine_carton_count: 4 }],
  ["Smuckers Uncrustables Peanut Butter & Chocolate Flavored Spread Sandwiches, 10 Count, 2 oz Each (Frozen)", { canonical_flavor_id: "peanut-butter-chocolate-spread", official_flavor_id: "peanut-butter-chocolate-spread", canonical_label: "Peanut Butter & Chocolate Flavored Spread", genuine_carton_count: 4 }],
  ["Smuckers Uncrustables Peanut Butter & Mixed Berry Spread Sandwiches, 2 oz, 4 Count (Frozen)", { canonical_flavor_id: "peanut-butter-mixed-berry-legacy", official_flavor_id: "peanut-butter-mixed-berry-legacy", canonical_label: "Peanut Butter & Mixed Berry Spread, legacy 2 oz", genuine_carton_count: 4 }],
  ["Smuckers Uncrustables Peanut Butter & Raspberry Spread Sandwiches, 10 Count, 2 oz Each, Frozen", { canonical_flavor_id: "peanut-butter-raspberry", official_flavor_id: "peanut-butter-raspberry", canonical_label: "Peanut Butter & Raspberry Spread", genuine_carton_count: 4 }],
]);

interface StrictComponent {
  product_name: string;
  qty: number;
}

interface StrictRow {
  ordinal: number;
  sku: string;
  asin: string;
  title: string;
  decision: string;
  severity: string;
  reason_codes: string[];
  observation: string;
  effective_total_units: number;
  recipe_components: StrictComponent[];
  evidence: Record<string, unknown>;
}

interface Blocker {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface ComponentPlan {
  exact_product_name: string;
  quantity: number;
  canonical_flavor_id: string | null;
  canonical_label: string | null;
  selected_pack_mode: "retail-carton" | "individual-wrapper";
  genuine_carton_count: number | null;
  visible_package_count: number | null;
  project_official_art: Record<string, unknown> | null;
  authenticity_registry: Record<string, unknown> | null;
  reference_gate: "PASS" | "BLOCK";
  blockers: Blocker[];
}

interface ReadinessRow {
  queue_stage: number;
  queue_rank: number | null;
  ordinal: number;
  sku: string;
  asin: string;
  title: string;
  strict_audit: Record<string, unknown>;
  exact_recipe: {
    effective_total_units: number;
    components: Array<{ product_name: string; quantity: number }>;
    component_count: number;
    fingerprint_sha256: string;
  };
  presentation: {
    presentation_class: "retail_boxes_single" | "retail_boxes_mix" | "individual_wraps";
    pack_mode: "retail-carton" | "individual-wrapper";
    exact_carton_decomposition: boolean;
    decision_rule: string;
  };
  components: ComponentPlan[];
  reference_gate: "PASS" | "BLOCK";
  catalog_identity_gate: "PASS" | "BLOCK";
  readiness:
    | "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
    | "BLOCKED_AUTHENTICITY_PROVENANCE"
    | "BLOCKED_CATALOG_IDENTITY";
  blockers: Blocker[];
  next_action: string;
  generation_queued: false;
  generation_authorized: false;
  generated_output: null;
  amazon_write_authorized: false;
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

function normalize(value: unknown): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[’‘]/g, "'")
    .replaceAll(/\s+/g, " ");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function readPinnedJson(descriptor: {
  path: string;
  file_sha256: string;
}): any {
  const bytes = readFileSync(absolute(descriptor.path));
  assert(
    sha256(bytes) === descriptor.file_sha256,
    `${descriptor.path} SHA drifted`,
  );
  return JSON.parse(bytes.toString("utf8"));
}

for (const descriptor of Object.values(sources)) {
  const actual = sha256(readFileSync(absolute(descriptor.path)));
  assert(actual === descriptor.file_sha256, `${descriptor.role} SHA drifted`);
}

const predecessor = readPinnedJson(sources.predecessor_readiness);
const predecessorBody = { ...predecessor };
delete predecessorBody.seal;
assert(
  predecessor.seal?.body_sha256 === sources.predecessor_readiness.body_sha256,
  "v7 readiness body SHA changed",
);
assert(
  sha256(JSON.stringify(predecessorBody)) ===
    sources.predecessor_readiness.body_sha256,
  "v7 readiness nested seal invalid",
);
const strictAudit = readPinnedJson(sources.strict_audit);
const strictBody = { ...strictAudit };
delete strictBody.body_sha256;
assert(
  strictAudit.body_sha256 === sources.strict_audit.body_sha256,
  "v8 strict body SHA changed",
);
assert(
  sha256(JSON.stringify(strictBody)) === sources.strict_audit.body_sha256,
  "v8 strict nested seal invalid",
);
const registry = readPinnedJson(sources.authenticity_registry);
const styleApprovals = readPinnedJson(sources.owner_style_approvals);
const officialManifest = readPinnedJson(sources.official_art);
const legacyManifest = readPinnedJson(sources.official_legacy_mixed_berry_art);
const identityDecision = readPinnedJson(sources.catalog_identity);

assert(strictAudit.rows.length === 164, "strict audit must cover 164 rows");
assert(strictAudit.summary.KEEP === 30, "strict v8 KEEP drifted");
assert(strictAudit.summary.REPAIR === 134, "strict v8 REPAIR drifted");
assert(predecessor.rows.length === 104, "v7 readiness row count drifted");
assert(styleApprovals.schema_version === "uncrustables-main-owner-approvals/v2", "style approval schema drifted");
assert(styleApprovals.entries.length === 3, "style fixture count drifted");
assert(
  styleApprovals.entries.every(
    (entry: { approval_scope: string; production_eligible: boolean }) =>
      entry.approval_scope === "style-reference-only" &&
      entry.production_eligible === false,
  ),
  "style fixture unexpectedly became production eligible",
);

const officialByFlavor = new Map<string, any>(
  [
    ...officialManifest.records.filter(
      (record: { flavor_id: string }) =>
        record.flavor_id !== "peanut-butter-mixed-berry-legacy",
    ),
    ...legacyManifest.records,
  ].map((record: { flavor_id: string }) => [record.flavor_id, record]),
);
const identityBySku = new Map<string, any>(
  identityDecision.decisions.map((row: { sku: string }) => [row.sku, row]),
);
const registryByAlias = new Map<string, any>();
for (const flavor of registry.flavors) {
  for (const alias of [
    flavor.flavor_id,
    flavor.display_name,
    ...(flavor.aliases ?? []),
  ]) {
    const key = normalize(alias);
    const existing = registryByAlias.get(key);
    assert(
      !existing || existing.flavor_id === flavor.flavor_id,
      `ambiguous registry alias ${alias}`,
    );
    registryByAlias.set(key, flavor);
  }
}

function planPresentation(row: StrictRow): ReadinessRow["presentation"] {
  const mappings = row.recipe_components.map((component) =>
    productMap.get(component.product_name),
  );
  const exactCartonPlan = mappings.every(
    (mapping, index) =>
      mapping &&
      row.recipe_components[index].qty % mapping.genuine_carton_count === 0,
  );
  return {
    presentation_class: exactCartonPlan
      ? row.recipe_components.length === 1
        ? "retail_boxes_single"
        : "retail_boxes_mix"
      : "individual_wraps",
    pack_mode: exactCartonPlan ? "retail-carton" : "individual-wrapper",
    exact_carton_decomposition: exactCartonPlan,
    decision_rule: exactCartonPlan
      ? "Every component quantity divides exactly by that component's reviewed genuine carton count."
      : "At least one component does not divide exactly; exact reviewed individual-wrapper evidence is required for every component.",
  };
}

function resolveComponent(
  component: StrictComponent,
  presentation: ReadinessRow["presentation"],
): ComponentPlan {
  const blockers: Blocker[] = [];
  const mapping = productMap.get(component.product_name);
  if (!mapping) {
    blockers.push({
      code: "EXACT_PRODUCT_MAPPING_MISSING",
      message: `No exact mapping for ${component.product_name}`,
    });
    return {
      exact_product_name: component.product_name,
      quantity: component.qty,
      canonical_flavor_id: null,
      canonical_label: null,
      selected_pack_mode: presentation.pack_mode,
      genuine_carton_count: null,
      visible_package_count:
        presentation.pack_mode === "individual-wrapper" ? component.qty : null,
      project_official_art: null,
      authenticity_registry: null,
      reference_gate: "BLOCK",
      blockers,
    };
  }

  const official = officialByFlavor.get(mapping.official_flavor_id);
  let officialArt: Record<string, unknown> | null = null;
  if (!official || official.status !== "CAPTURED" || !official.local_path) {
    blockers.push({
      code: "OFFICIAL_PROJECT_ART_MISSING",
      message: `Official project art missing for ${mapping.canonical_label}`,
    });
  } else {
    assert(existsSync(absolute(official.local_path)), `missing ${official.local_path}`);
    assert(
      sha256(readFileSync(absolute(official.local_path))) ===
        official.package_art_sha256,
      `official art SHA drifted: ${official.local_path}`,
    );
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
  let registryResolution: Record<string, unknown> | null = null;
  if (!registryFlavor) {
    blockers.push({
      code: "AUTHENTICITY_REGISTRY_FLAVOR_MISSING",
      message: `No exact sealed-registry alias for ${component.product_name}`,
      details: { canonical_flavor_id: mapping.canonical_flavor_id },
    });
  } else {
    const matchingArt = registryFlavor.art.filter(
      (art: { pack_mode: string; retail_pack_size: number }) =>
        art.pack_mode === presentation.pack_mode &&
        (presentation.pack_mode === "individual-wrapper" ||
          art.retail_pack_size === mapping.genuine_carton_count),
    );
    if (matchingArt.length !== 1) {
      blockers.push({
        code: "AUTHENTICITY_REGISTRY_PRESENTATION_ART_MISSING",
        message: `No unique ${presentation.pack_mode} registry art for ${mapping.canonical_label}`,
        details: {
          matches: matchingArt.length,
          required_retail_pack_size:
            presentation.pack_mode === "retail-carton"
              ? mapping.genuine_carton_count
              : 1,
        },
      });
    } else {
      const art = matchingArt[0];
      const evidence = (art.evidence ?? []).filter(
        (item: { kind: string }) => item.kind === "reviewed-artifact",
      );
      if (art.evidence?.length !== 1 || evidence.length !== 1) {
        blockers.push({
          code: "AUTHENTICITY_REGISTRY_REFERENCE_NOT_UNIQUE",
          message: `Registry art ${art.art_id} must have exactly one reviewed artifact`,
        });
      } else {
        const selected = evidence[0];
        assert(existsSync(absolute(selected.locator)), `missing ${selected.locator}`);
        assert(
          sha256(readFileSync(absolute(selected.locator))) === selected.sha256,
          `registry evidence SHA drifted: ${selected.locator}`,
        );
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

  const visiblePackageCount =
    presentation.pack_mode === "individual-wrapper"
      ? component.qty
      : component.qty / mapping.genuine_carton_count;
  assert(
    Number.isInteger(visiblePackageCount),
    `non-integer package plan for ${component.product_name}`,
  );
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

function buildNewRow(row: StrictRow): ReadinessRow {
  const presentation = planPresentation(row);
  const components = row.recipe_components.map((component) =>
    resolveComponent(component, presentation),
  );
  const identity = identityBySku.get(row.sku);
  const identityBlockers: Blocker[] =
    identity?.decision === "BLOCK"
      ? [
          {
            code: "CATALOG_IDENTITY_BLOCK",
            message: identity.block_reason,
            details: { required_remediation: identity.required_remediation },
          },
        ]
      : [];
  const blockers = [
    ...identityBlockers,
    ...components.flatMap((component) => component.blockers),
  ];
  const referenceGate = components.every(
    (component) => component.reference_gate === "PASS",
  )
    ? "PASS"
    : "BLOCK";
  const readiness =
    identityBlockers.length > 0
      ? "BLOCKED_CATALOG_IDENTITY"
      : referenceGate === "PASS"
        ? "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
        : "BLOCKED_AUTHENTICITY_PROVENANCE";
  const queueStage =
    readiness === "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
      ? 1
      : readiness === "BLOCKED_AUTHENTICITY_PROVENANCE"
        ? 2
        : 3;
  const recipeBody = {
    effective_total_units: row.effective_total_units,
    components: row.recipe_components.map((component) => ({
      product_name: component.product_name,
      quantity: component.qty,
    })),
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
      source_audit: {
        path: sources.strict_audit.path,
        file_sha256: sources.strict_audit.file_sha256,
        body_sha256: sources.strict_audit.body_sha256,
      },
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
    next_action:
      readiness === "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
        ? "Eligible only for a separately authorized controlled GPT Image 2 generation run; generated bytes still require scene-complete machine QA, image-bound human approval, production permit, and fresh Amazon compare-and-swap."
        : readiness === "BLOCKED_CATALOG_IDENTITY"
          ? "Resolve the catalog identity decision and capture fresh catalog evidence before any MAIN generation or publication."
          : "Add exact presentation-specific reviewed art to the sealed authenticity registry through the one-writer Product Truth enrichment path; similar product/package art cannot fill the gap.",
    generation_queued: false,
    generation_authorized: false,
    generated_output: null,
    amazon_write_authorized: false,
  };
}

const strictRepairRows = (strictAudit.rows as StrictRow[]).filter(
  (row) => row.decision === "REPAIR",
);
const priorBySku = new Map<string, ReadinessRow>(
  (predecessor.rows as ReadinessRow[]).map((row) => [row.sku, row]),
);
const newlyAddedOrdinals: number[] = [];
const unsortedRows = strictRepairRows.map((strictRow): ReadinessRow => {
  const prior = priorBySku.get(strictRow.sku);
  if (!prior) {
    newlyAddedOrdinals.push(strictRow.ordinal);
    return buildNewRow(strictRow);
  }
  return {
    ...prior,
    ordinal: strictRow.ordinal,
    asin: strictRow.asin,
    title: strictRow.title,
    strict_audit: {
      ...prior.strict_audit,
      decision: strictRow.decision,
      severity: strictRow.severity,
      reason_codes: strictRow.reason_codes,
      observation: strictRow.observation,
      live_main_asset: strictRow.evidence,
      source_audit: {
        path: sources.strict_audit.path,
        file_sha256: sources.strict_audit.file_sha256,
        body_sha256: sources.strict_audit.body_sha256,
      },
    },
  };
});

assert(newlyAddedOrdinals.length === 30, "v8 must add 30 newly reclassified rows");
const rows = unsortedRows
  .sort(
    (left, right) =>
      left.queue_stage - right.queue_stage || left.ordinal - right.ordinal,
  )
  .map((row, index) => ({ ...row, queue_rank: index + 1 }));
assert(rows.length === 134, "v8 readiness must contain 134 rows");
assert(new Set(rows.map((row) => row.sku)).size === 134, "duplicate readiness SKU");
assert(new Set(rows.map((row) => row.asin)).size === 134, "duplicate readiness ASIN");
assert(
  rows.every(
    (row) => !row.generation_authorized && !row.amazon_write_authorized,
  ),
  "readiness queue unexpectedly authorizes mutation",
);

for (const row of rows) {
  for (const component of row.components) {
    const official = component.project_official_art as
      | { path?: string; sha256?: string }
      | null;
    if (official?.path && official.sha256) {
      assert(existsSync(absolute(official.path)), `missing ${official.path}`);
      assert(
        sha256(readFileSync(absolute(official.path))) === official.sha256,
        `official component art SHA drifted: ${official.path}`,
      );
    }
    const registryResolution = component.authenticity_registry as
      | { selected_reference?: { path?: string; sha256?: string } }
      | null;
    const selected = registryResolution?.selected_reference;
    if (selected?.path && selected.sha256) {
      assert(existsSync(absolute(selected.path)), `missing ${selected.path}`);
      assert(
        sha256(readFileSync(absolute(selected.path))) === selected.sha256,
        `registry component art SHA drifted: ${selected.path}`,
      );
    }
  }
}

const readinessCounts = Object.fromEntries(
  uniqueSorted(rows.map((row) => row.readiness)).map((readiness) => [
    readiness,
    rows.filter((row) => row.readiness === readiness).length,
  ]),
);
assert(
  readinessCounts.REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION === 13,
  `expected 13 reference-ready rows, got ${readinessCounts.REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION}`,
);
assert(
  readinessCounts.BLOCKED_AUTHENTICITY_PROVENANCE === 119,
  `expected 119 provenance blocks, got ${readinessCounts.BLOCKED_AUTHENTICITY_PROVENANCE}`,
);
assert(
  readinessCounts.BLOCKED_CATALOG_IDENTITY === 2,
  `expected 2 identity blocks, got ${readinessCounts.BLOCKED_CATALOG_IDENTITY}`,
);

const defectGroups = Object.entries(
  strictAudit.reason_catalog as Record<string, string>,
)
  .map(([code, description]) => {
    const affected = strictRepairRows.filter((row) =>
      row.reason_codes.includes(code),
    );
    return {
      code,
      description,
      affected_count: affected.length,
      affected_asins: affected.map((row) => row.asin).sort(),
      affected_skus: affected.map((row) => row.sku).sort(),
    };
  })
  .filter((group) => group.affected_count > 0)
  .sort(
    (left, right) =>
      right.affected_count - left.affected_count ||
      left.code.localeCompare(right.code),
  );

const blockerCodes = uniqueSorted(
  rows.flatMap((row) => row.blockers.map((blocker) => blocker.code)),
);
const blockerSummary = blockerCodes.map((code) => {
  const affected = rows.filter((row) =>
    row.blockers.some((blocker) => blocker.code === code),
  );
  return {
    code,
    affected_count: affected.length,
    affected_asins: affected.map((row) => row.asin).sort(),
    affected_skus: affected.map((row) => row.sku).sort(),
  };
});

const referenceGapGroups = new Map<string, any>();
for (const row of rows) {
  for (const component of row.components.filter(
    (item) => item.reference_gate === "BLOCK",
  )) {
    const key = [
      component.canonical_flavor_id ?? "UNMAPPED",
      component.selected_pack_mode,
      component.genuine_carton_count ?? "UNKNOWN",
    ].join("|");
    const group = referenceGapGroups.get(key) ?? {
      canonical_flavor_id: component.canonical_flavor_id,
      canonical_label: component.canonical_label,
      required_pack_mode: component.selected_pack_mode,
      required_retail_pack_size:
        component.selected_pack_mode === "retail-carton"
          ? component.genuine_carton_count
          : 1,
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
const referenceGapSummary = [...referenceGapGroups.values()]
  .map((group) => ({
    ...group,
    exact_product_names: uniqueSorted(group.exact_product_names),
    blocker_codes: uniqueSorted(group.blocker_codes),
    affected_asins: uniqueSorted(group.affected_asins),
    affected_skus: uniqueSorted(group.affected_skus),
    affected_count: new Set(group.affected_asins).size,
  }))
  .sort(
    (left, right) =>
      right.affected_count - left.affected_count ||
      String(left.canonical_flavor_id).localeCompare(
        String(right.canonical_flavor_id),
      ) ||
      left.required_pack_mode.localeCompare(right.required_pack_mode),
  );

const body = {
  schema_version: "uncrustables-main-repair-readiness/v8.0.0",
  artifact_id: "UMRR-20260718-V8-STRICT134-EXHAUSTIVE-KEEP-CORRECTION",
  immutable: true,
  status: "SEALED_LOCAL_READINESS_QUEUE_NO_GENERATION_NO_MARKETPLACE_WRITE",
  deterministic_build: {
    runtime_timestamp_omitted: true,
    builder_path: path.relative(root, fileURLToPath(import.meta.url)),
  },
  safety: {
    image_model_calls: 0,
    amazon_writes: 0,
    channelmax_writes: 0,
    r2_writes: 0,
    database_writes: 0,
    network_requests: 0,
    generation_authorized: false,
    marketplace_write_authorized: false,
  },
  contract: {
    strict_partition: "164 = 30 strict visual KEEP + 134 strict visual REPAIR",
    product_truth_rule:
      "Only exact Product Truth identity and a unique presentation-specific reviewed artifact in the sealed authenticity registry can pass. Similar/seasonal editions remain blocked until equivalence is explicitly approved.",
    presentation_rule:
      "Use exact genuine cartons only when every component quantity divides by that component's reviewed carton count; otherwise require exact individual-wrapper evidence for every component.",
    scene_rule:
      "Every generated candidate must pass exact per-component package arithmetic, pure-white square scene, anchor-matching cooler/branding, no loose ice, physical seating, and exactly two gel packs inside plus two outside.",
    readiness_rule:
      "REFERENCE_READY is not generation authorization. Every output still needs GPT Image 2 with pinned ordered references, scene-complete QA, image-bound owner approval, production permit, and fresh Amazon compare-and-swap.",
  },
  sources: Object.values(sources).map((descriptor) => ({
    role: descriptor.role,
    path: descriptor.path,
    sha256: descriptor.file_sha256,
    ...(descriptor === sources.predecessor_readiness ||
    descriptor === sources.strict_audit
      ? { body_sha256: descriptor.body_sha256 }
      : {}),
  })),
  kit_anchor: {
    path: sources.kit_anchor.path,
    sha256: sources.kit_anchor.file_sha256,
    authority: "KIT_GEOMETRY_BRANDING_AND_GEL_PACKS_ONLY",
  },
  owner_frozen_live_main: predecessor.owner_frozen_live_main,
  owner_approved_style_fixtures: styleApprovals.entries.map(
    (entry: Record<string, unknown>) => ({
      proof_id: entry.proof_id,
      asin: entry.asin,
      image: entry.image,
      approval_scope: entry.approval_scope,
      production_eligible: entry.production_eligible,
    }),
  ),
  summary: {
    strict_scope_rows: 164,
    strict_keep_rows_not_queued: 30,
    strict_repair_rows_queued: 134,
    newly_reclassified_rows_added: 30,
    reference_ready_pending_explicit_generation: 13,
    blocked_authenticity_provenance: 119,
    blocked_catalog_identity: 2,
    owner_frozen_live_keep_rows: predecessor.owner_frozen_live_main.length,
    images_generated: 0,
    amazon_rows_changed: 0,
    channelmax_rows_changed: 0,
  },
  blocker_summary: blockerSummary,
  reference_gap_groups: referenceGapSummary,
  defect_groups: defectGroups,
  rows,
  correction: {
    predecessor_path: sources.predecessor_readiness.path,
    predecessor_file_sha256: sources.predecessor_readiness.file_sha256,
    predecessor_body_sha256: sources.predecessor_readiness.body_sha256,
    strict_audit_path: sources.strict_audit.path,
    strict_audit_file_sha256: sources.strict_audit.file_sha256,
    strict_audit_body_sha256: sources.strict_audit.body_sha256,
    newly_added_ordinals: newlyAddedOrdinals.sort((left, right) => left - right),
    queue_membership_changed: true,
    external_mutations: 0,
  },
};
const artifact = {
  ...body,
  seal: {
    algorithm: "sha256",
    scope:
      "Compact JSON serialization of every top-level field before seal, in emitted key order",
    body_sha256: sha256(JSON.stringify(body)),
  },
};
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
const csvHeader = [
  "queue_rank",
  "queue_stage",
  "ordinal",
  "sku",
  "asin",
  "readiness",
  "reference_gate",
  "catalog_identity_gate",
  "effective_total_units",
  "presentation_class",
  "pack_mode",
  "component_plan",
  "reason_codes",
  "blocker_codes",
  "generation_authorized",
  "amazon_write_authorized",
] as const;
const csvText = `${[
  csvHeader.join(","),
  ...rows.map((row) =>
    [
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
      row.components
        .map(
          (component) =>
            `${component.quantity}x ${component.canonical_flavor_id ?? component.exact_product_name} as ${component.selected_pack_mode} (${component.visible_package_count} visible packages)`,
        )
        .join(" | "),
      (row.strict_audit.reason_codes as string[]).join("|"),
      uniqueSorted(row.blockers.map((blocker) => blocker.code)).join("|"),
      row.generation_authorized,
      row.amazon_write_authorized,
    ]
      .map(csvCell)
      .join(","),
  ),
].join("\n")}\n`;

for (const [localPath, text] of [
  [outputJson, jsonText],
  [outputCsv, csvText],
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
    body_sha256: artifact.seal.body_sha256,
    summary: body.summary,
    newly_added_ordinals: body.correction.newly_added_ordinals,
    external_mutations: 0,
  }, null, 2)}\n`,
);
