/**
 * Full 164-row factual rewrite for the July 2026 Uncrustables launch.
 *
 * Inputs are immutable local artifacts. The builder is pure and performs no
 * Amazon, database, object-storage, or network operations.
 */

import { validateOutput, validateSemanticOutput } from "../content-generation";
import { rulePromotionalLanguage } from "../compliance/rules/rule-8-promotional-language";
import { coolerFor } from "../../pricing/cost-model";
import type { Variant, VariantComponent } from "../variation-matrix";
import {
  hasExcessiveAmazonTitleWordFrequency,
  renderUncrustablesCommercialRepairContent,
  uncrustablesFlavorLabel,
} from "./uncrustables-content";
import type { DesiredRepairManifest } from "./uncrustables-surgical";
import { UNCRUSTABLES_SOURCE_LEDGER_SHA256 } from "./uncrustables-reviewed-overrides-v2";

export const UNCRUSTABLES_REVIEWED_OVERRIDES_V3_REVIEWED_AT =
  "2026-07-18T05:55:00.000Z";

export const UNCRUSTABLES_OWNER_FULFILLMENT_HANDOFF_SHA256 =
  "8ca9bb574a7d940b636871bb1fdfe1c0d6b88bbb39c9833812493f8746bb7841";

const OWNER_FULFILLMENT_HANDOFF_EXACT_CLAUSE =
  "покупаем поштучно, перепаковываем в фирменный кулер с гелевыми пакетами, шлём";

export const UNCRUSTABLES_LIVE_REPAIR_SCOPE = 164;

export const HISTORICAL_MISSING_ASIN_SKUS = [
  "CV-ASQK-4P65",
  "PV-ASZG-X763",
  "SV-AS9L-DRRH",
] as const;

export type FactualClaimCategory =
  | "PER_ITEM_OR_PACKAGE_WEIGHT"
  | "NUMERIC_PROTEIN_OR_NUTRITION"
  | "HANDLING_DURATION_OR_TEMPERATURE"
  | "FORMULATION_GENERALIZATION"
  | "ALLERGEN_PROSE"
  | "FROZEN_DELIVERY_PROMISE";

const FACTUAL_PATTERNS: ReadonlyArray<{
  category: FactualClaimCategory;
  pattern: RegExp;
}> = [
  {
    category: "PER_ITEM_OR_PACKAGE_WEIGHT",
    pattern: /\b\d+(?:\.\d+)?\s*(?:oz|ounce(?:s)?)\b/i,
  },
  {
    category: "NUMERIC_PROTEIN_OR_NUTRITION",
    pattern: /\b(?:\d+\s*g\s+(?:of\s+)?protein|calories?|\d+\s*g\s+(?:fat|sodium|sugar))\b/i,
  },
  {
    category: "HANDLING_DURATION_OR_TEMPERATURE",
    pattern: /\b(?:\d+\s*(?:to|-|–)\s*\d+\s*(?:minutes?|hours?|days?)|up to (?:\w+|\d+) days?|within \d+ hours?|0\s*(?:degrees|°)\s*f|microwave|refreeze)\b/i,
  },
  {
    category: "FORMULATION_GENERALIZATION",
    pattern: /\b(?:whole grains?|first ingredient|high fructose|artificial (?:sweeteners?|colors?|flavors?)|preservatives?|reduced sugar|less sugar|baked fresh|made in (?:the )?u\.?s\.?a\.?)\b/i,
  },
  {
    category: "ALLERGEN_PROSE",
    pattern: /\b(?:contains|may contain)\s+(?:peanuts?|wheat|milk|hazelnuts?)\b/i,
  },
  {
    category: "FROZEN_DELIVERY_PROMISE",
    pattern: /\b(?:ship(?:s|ped)?|deliver(?:ed|y)|arrive(?:s|d)?)\s+(?:and\s+)?frozen\b/i,
  },
] as const;

const GENERATED_UNSUPPORTED_PATTERN =
  /\b(?:\d+(?:\.\d+)?\s*(?:oz|ounces?)|calories?|fat|sodium|sugar|preservatives?|allergen-free|ships?|shipped|shipping|delivered|arrives?|\d+\s*(?:minutes?|hours?|days?)|0\s*(?:degrees|°)|microwave|refreeze|curated|gift\s+(?:set|basket)|affiliated|authorized)\b/i;

interface CanonicalComponent {
  product_id: string;
  product_name: string;
  brand: string;
  flavor?: string | null;
  qty: number;
  unit_price_cents: number;
}

interface LedgerRow {
  sku: string;
  asin: string | null;
  canonical?: {
    total_units?: number;
    component_qty_sum?: number;
    composition_source?: string;
    composition_signature?: string;
    components?: CanonicalComponent[];
    pricing?: { cooler?: string };
  };
  db?: {
    draft?: null | {
      id?: string;
      brand?: string;
      category?: string;
      pack_count?: number;
      selected_variant?: { name?: string };
    };
  };
  live?: null | {
    fetched?: boolean;
    product_type?: string;
    title?: string | null;
    bullets?: string[];
    description?: string | null;
    raw_attributes?: {
      merchant_shipping_group?: unknown;
    };
  };
}

export interface UncrustablesLedgerForFullFactualRewrite {
  rows: LedgerRow[];
}

interface ReviewedDonor {
  donor_id: string;
  expected_title: string;
  reviewed?: {
    ingredients_source?: {
      kind?: string;
      url?: string;
      retrieved_at?: string;
      locator?: string;
    };
  };
}

interface ReviewedDonorAlias {
  from_donor_id: string;
  expected_selected_product_name: string;
  to_donor_id: string;
}

export interface UncrustablesDonorEvidenceForFullFactualRewrite {
  schema_version: string;
  immutable?: boolean;
  ledger?: { sha256?: string };
  donors: ReviewedDonor[];
  aliases: ReviewedDonorAlias[];
}

export interface FullFactualRewriteSources {
  ledger: { path: string; sha256: string };
  prior_reviewed_overrides: { path: string; sha256: string };
  donor_manifest: { path: string; sha256: string };
  ptd_attribute_proof: { path: string; sha256: string };
  owner_fulfillment_handoff: {
    path: string;
    sha256: string;
    locator: "line 19";
  };
  frozen_cost_model: { path: string; sha256: string };
  frozen_image_policy: { path: string; sha256: string };
  renderer: { path: string; sha256: string };
}

export interface UncrustablesFactualArtifactSupersession {
  path: string;
  sha256: string;
  status: "SUPERSEDED_DO_NOT_APPLY";
  reason: "FUTURE_REVIEW_TIMESTAMP";
}

export interface UncrustablesReviewedOverridesV3Manifest
  extends DesiredRepairManifest {
  supersedes: UncrustablesFactualArtifactSupersession[];
}

export interface AmazonFoodPtdEvidenceForFullFactualRewrite {
  schema_version: string;
  immutable?: boolean;
  scope?: { ledger_sha256?: string };
  product_types?: {
    PASTRY?: {
      attributes?: {
        unit_count?: {
          type_value_enum?: string[];
        };
      };
    };
  };
}

export interface UncrustablesFactualContentAudit {
  schema_version: "uncrustables-factual-content-audit/v1.0";
  immutable: true;
  created_at: string;
  external_mutations: false;
  supersedes: UncrustablesFactualArtifactSupersession[];
  sources: FullFactualRewriteSources;
  policy: {
    exact_recipe_and_individual_count_only: true;
    cold_pack_claim_requires_frozen_program_evidence: true;
    owner_fulfillment_source_pinned: true;
    retain_numeric_protein_only_as_exact_manufacturer_subline_identity: true;
    own_brand_passthrough: true;
    curator_or_gift_disclaimer_required: false;
    generated_unsupported_claims_allowed: false;
  };
  summary: {
    source_rows: number;
    live_rows: number;
    historical_missing_asin_rows: number;
    full_rewrites: number;
    single_flavor_rows: number;
    mixed_flavor_rows: number;
    category_counts: Record<FactualClaimCategory, number>;
    retained_12g_subline_rows: number;
    format_failures_after: 0;
    semantic_failures_after: 0;
    compliance_failures_after: 0;
    unsupported_claim_failures_after: 0;
  };
  rows: Array<{
    sku: string;
    asin: string;
    intended_count: number;
    composition_signature: string;
    composition_kind: "SINGLE_FLAVOR" | "MIXED_FLAVOR";
    before_findings: FactualClaimCategory[];
    retained_12g_subline_identity: boolean;
    cold_pack_evidence: {
      draft_category: "FROZEN_GROCERY";
      canonical_cooler: "S" | "M" | "L" | "XL";
      merchant_shipping_group_present: true;
      owner_fulfillment_handoff: {
        sha256: typeof UNCRUSTABLES_OWNER_FULFILLMENT_HANDOFF_SHA256;
        locator: "line 19";
        claim: "BRANDED_COOLER_AND_GEL_PACKS";
      };
    };
    disposition: "FULL_DETERMINISTIC_REWRITE";
    after: {
      title_length: number;
      bullet_count: 5;
      max_bullet_length: number;
      description_length: number;
      format_pass: true;
      semantic_pass: true;
      compliance_pass: true;
      unsupported_claim_scan_pass: true;
    };
  }>;
  skipped_rows: Array<{
    sku: string;
    asin: null;
    reason: "HISTORICAL_CREATION_MISSING_ASIN";
  }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function exactLiveCorpus(row: LedgerRow): string {
  return [
    row.live?.title ?? "",
    ...(row.live?.bullets ?? []),
    row.live?.description ?? "",
  ].join("\n");
}

function factualFindings(row: LedgerRow): FactualClaimCategory[] {
  const corpus = exactLiveCorpus(row);
  return FACTUAL_PATTERNS
    .filter(({ pattern }) => pattern.test(corpus))
    .map(({ category }) => category);
}

function canonicalVariant(row: LedgerRow): Variant {
  const components = row.canonical?.components;
  assert(Array.isArray(components) && components.length > 0, `${row.sku}: canonical recipe is empty`);
  const composition: VariantComponent[] = components.map((component) => ({
    research_pool_id: component.product_id,
    product_name: component.product_name,
    brand: component.brand,
    flavor: component.flavor ?? null,
    qty: component.qty,
    unit_price_cents: component.unit_price_cents,
  }));
  assert(
    composition.every((component) =>
      component.research_pool_id &&
      component.product_name &&
      component.brand &&
      Number.isInteger(component.qty) &&
      component.qty > 0
    ),
    `${row.sku}: malformed canonical component`,
  );
  return {
    idx: 0,
    name: row.db?.draft?.selected_variant?.name ?? `${row.sku} reviewed recipe`,
    composition,
    cost_cents: 0,
    suggested_price_cents: 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 100,
    notes: "Exact immutable-ledger canonical recipe used for full factual rewrite.",
  };
}

function verifyDonorIdentity(
  sku: string,
  component: CanonicalComponent,
  donors: Map<string, ReviewedDonor>,
  aliases: Map<string, ReviewedDonorAlias>,
): { retained12g: boolean; evidence?: string } {
  const direct = donors.get(component.product_id);
  const alias = aliases.get(component.product_id);
  assert(direct || alias, `${sku}: no reviewed donor or alias for ${component.product_id}`);
  if (direct) {
    assert(
      direct.expected_title === component.product_name ||
        uncrustablesFlavorLabel(direct.expected_title) ===
          uncrustablesFlavorLabel(component.product_name),
      `${sku}: canonical flavor identity differs from reviewed donor ${component.product_id}`,
    );
  } else {
    assert(
      alias?.expected_selected_product_name === component.product_name,
      `${sku}: canonical component title differs from reviewed alias ${component.product_id}`,
    );
    assert(donors.has(alias.to_donor_id), `${sku}: reviewed alias target donor is missing`);
  }

  const retained12g = /\b12g Protein\b/i.test(component.product_name);
  if (!retained12g) return { retained12g };
  assert(direct, `${sku}: 12g product identity cannot rely on an alias`);
  assert(
    direct.expected_title === component.product_name,
    `${sku}: retained 12g sub-line is not an exact reviewed donor title`,
  );
  assert(
    direct.reviewed?.ingredients_source?.kind === "manufacturer_product_page",
    `${sku}: 12g sub-line lacks manufacturer-page evidence`,
  );
  assert(
    /^https:\/\/www\.smuckersuncrustables\.com\/sandwiches\//.test(
      direct.reviewed.ingredients_source.url ?? "",
    ),
    `${sku}: 12g sub-line manufacturer source is not official`,
  );
  return {
    retained12g,
    evidence:
      `Exact reviewed donor title retains “12g Protein”; official manufacturer source: ${direct.reviewed.ingredients_source.url}.`,
  };
}

function assertSourcePins(sources: FullFactualRewriteSources): void {
  assert(
    sources.ledger.sha256 === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    "Full factual rewrite is not pinned to the exact source ledger",
  );
  assert(
    sources.owner_fulfillment_handoff.sha256 ===
      UNCRUSTABLES_OWNER_FULFILLMENT_HANDOFF_SHA256 &&
      sources.owner_fulfillment_handoff.locator === "line 19",
    "Cold-pack copy is not pinned to the exact owner fulfillment handoff",
  );
  for (const [role, source] of Object.entries(sources)) {
    assert(source.path.length > 0, `${role}: source path is empty`);
    assert(/^[a-f0-9]{64}$/.test(source.sha256), `${role}: invalid SHA-256`);
  }
}

export function buildUncrustablesReviewedOverridesV3(input: {
  ledger: UncrustablesLedgerForFullFactualRewrite;
  priorManifest: DesiredRepairManifest;
  donorManifest: UncrustablesDonorEvidenceForFullFactualRewrite;
  ptdProof: AmazonFoodPtdEvidenceForFullFactualRewrite;
  fulfillmentHandoffText: string;
  sources: FullFactualRewriteSources;
}): {
  manifest: UncrustablesReviewedOverridesV3Manifest;
  audit: UncrustablesFactualContentAudit;
} {
  const {
    ledger,
    priorManifest,
    donorManifest,
    ptdProof,
    fulfillmentHandoffText,
    sources,
  } = input;
  assertSourcePins(sources);
  assert(
    fulfillmentHandoffText.includes(OWNER_FULFILLMENT_HANDOFF_EXACT_CLAUSE),
    "Pinned owner fulfillment handoff does not contain the exact cooler-and-gel-pack clause",
  );
  assert(priorManifest.immutable === true, "Prior reviewed manifest must be immutable");
  assert(
    priorManifest.source_ledger_sha256 === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    "Prior reviewed manifest is not pinned to the exact ledger",
  );
  assert(
    donorManifest.schema_version === "bundle-factory.uncrustables-donor-enrichment/v2" &&
      donorManifest.immutable === true &&
      donorManifest.ledger?.sha256 === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    "Reviewed donor manifest is not the exact immutable ledger-bound v2 source",
  );
  assert(
    ptdProof.schema_version === "amazon-food-ptd-attribute-proof/v1" &&
      ptdProof.immutable === true &&
      ptdProof.scope?.ledger_sha256 === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    "Amazon food PTD proof is not the exact immutable ledger-bound source",
  );
  assert(
    JSON.stringify(
      ptdProof.product_types?.PASTRY?.attributes?.unit_count?.type_value_enum,
    ) === JSON.stringify(["Ounce"]),
    "PASTRY PTD must permit only Ounce for unit_count",
  );

  const donors = new Map(donorManifest.donors.map((donor) => [donor.donor_id, donor]));
  const aliases = new Map(donorManifest.aliases.map((alias) => [alias.from_donor_id, alias]));
  assert(donors.size === 16, `Expected 16 reviewed donors, got ${donors.size}`);
  assert(aliases.size === 1, `Expected one reviewed donor alias, got ${aliases.size}`);

  const priorRepairs = new Map(
    structuredClone(priorManifest.repairs).map((repair) => [repair.sku, repair]),
  );
  const liveRows = ledger.rows.filter((row) => row.live?.fetched === true);
  const skipped = ledger.rows.filter((row) => row.live?.fetched !== true);
  assert(liveRows.length === UNCRUSTABLES_LIVE_REPAIR_SCOPE, `Expected 164 live rows, got ${liveRows.length}`);
  assert(
    new Set(liveRows.map((row) => row.sku)).size === UNCRUSTABLES_LIVE_REPAIR_SCOPE,
    "Live repair scope contains duplicate SKUs",
  );
  assert(
    new Set(liveRows.map((row) => row.asin)).size === UNCRUSTABLES_LIVE_REPAIR_SCOPE &&
      liveRows.every((row) => typeof row.asin === "string" && row.asin.length > 0),
    "Live repair scope must contain 164 unique ASINs",
  );
  assert(
    JSON.stringify(skipped.map((row) => row.sku).sort()) ===
      JSON.stringify([...HISTORICAL_MISSING_ASIN_SKUS].sort()),
    `Unexpected non-live rows: ${skipped.map((row) => row.sku).join(", ")}`,
  );
  assert(skipped.every((row) => row.asin == null), "Historical missing rows unexpectedly have ASINs");

  const repairs: DesiredRepairManifest["repairs"] = [];
  const auditRows: UncrustablesFactualContentAudit["rows"] = [];

  for (const row of [...liveRows].sort((left, right) => left.sku.localeCompare(right.sku))) {
    assert(row.asin, `${row.sku}: missing ASIN`);
    assert(row.db?.draft?.category === "FROZEN_GROCERY", `${row.sku}: not in frozen grocery program`);
    assert(
      Array.isArray(row.live?.raw_attributes?.merchant_shipping_group) &&
        row.live.raw_attributes.merchant_shipping_group.length > 0,
      `${row.sku}: no live merchant shipping group`,
    );
    assert(
      row.canonical?.composition_source === "SELECTED_VARIANT",
      `${row.sku}: canonical composition is not selected-variant grounded`,
    );

    const existing = priorRepairs.get(row.sku);
    const reviewedTotal =
      existing?.review?.confidence === "HIGH" &&
      existing.text_count?.unit_count != null
        ? existing.text_count.unit_count
        : row.canonical?.total_units;
    assert(
      Number.isInteger(reviewedTotal) && (reviewedTotal as number) > 0,
      `${row.sku}: invalid intended count`,
    );
    const total = reviewedTotal as number;
    const variant = canonicalVariant(row);
    const recipeTotal = variant.composition.reduce((sum, component) => sum + component.qty, 0);
    assert(recipeTotal === total, `${row.sku}: exact recipe allocation does not equal intended count`);
    assert(
      row.canonical?.component_qty_sum === total,
      `${row.sku}: sealed canonical component_qty_sum differs from intended count`,
    );
    assert(
      existing?.review?.confidence === "HIGH" || row.db?.draft?.pack_count === total,
      `${row.sku}: unreviewed draft/count disagreement`,
    );

    const expectedCooler = coolerFor(total);
    assert(
      row.canonical?.pricing?.cooler === expectedCooler,
      `${row.sku}: canonical cooler ${row.canonical?.pricing?.cooler ?? "missing"} does not match ${expectedCooler}`,
    );

    const donorProofs = (row.canonical?.components ?? []).map((component) =>
      verifyDonorIdentity(row.sku, component, donors, aliases)
    );
    const retained12g = donorProofs.some((proof) => proof.retained12g);
    const exact12gEvidence = donorProofs
      .map((proof) => proof.evidence)
      .filter((value): value is string => Boolean(value));

    let kpOunceEvidence: string | null = null;
    if (row.sku === "KP-ASYC-RN84") {
      assert(variant.composition.length === 1, "KP direct PASTRY repair must be single-flavor");
      const component = variant.composition[0];
      assert(component.qty === 90, "KP direct PASTRY repair must contain exactly 90 sandwiches");
      const retail = component.product_name.match(
        /\b(\d+(?:\.\d+)?)\s*oz\s*\/\s*(\d+)\s*ct\b/i,
      );
      assert(retail, "KP donor title must carry exact retail net weight/count evidence");
      const perSandwichOunces = Number(retail[1]) / Number(retail[2]);
      assert(perSandwichOunces === 2.8, `KP expected 2.8 oz per sandwich, got ${perSandwichOunces}`);
      const totalOunces = Math.round(90 * perSandwichOunces * 10) / 10;
      assert(totalOunces === 252, "KP exact ounce total must be 252");
      kpOunceEvidence =
        `KP direct PASTRY unit_count is 252 Ounce: exact reviewed donor title states ${retail[1]} oz/${retail[2]} ct (${perSandwichOunces} oz each), multiplied by 90 sandwiches; PASTRY PTD ${sources.ptd_attribute_proof.sha256} permits only Ounce.`;
    }

    const findings = factualFindings(row);
    assert(findings.length > 0, `${row.sku}: factual audit found no reason for full rewrite`);
    const rendered = renderUncrustablesCommercialRepairContent({ variant, total });
    const formatError = validateOutput(rendered, "amazon");
    const semanticError = validateSemanticOutput(rendered, {
      brand: row.db?.draft?.brand ?? "Uncrustables",
      pack_count: total,
      selected_variant: variant,
    });
    const compliance = rulePromotionalLanguage({
      ...rendered,
      brand: "Uncrustables",
      own_brand: true,
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      skip_image_check: true,
    });
    const outputCorpus = [rendered.title, ...rendered.bullets, rendered.description].join("\n");
    assert(formatError === null, `${row.sku}: rendered format failed: ${formatError}`);
    assert(semanticError === null, `${row.sku}: rendered semantic failed: ${semanticError}`);
    assert(compliance.passed, `${row.sku}: rendered Rule 8 failed: ${compliance.reason}`);
    assert(
      !GENERATED_UNSUPPORTED_PATTERN.test(outputCorpus),
      `${row.sku}: rendered output retained an unsupported factual claim`,
    );
    assert(rendered.bullets.length === 5, `${row.sku}: renderer must emit five bullets`);
    assert(
      !hasExcessiveAmazonTitleWordFrequency(rendered.title),
      `${row.sku}: title repeats a substantive word more than twice`,
    );
    assert(rendered.bullets.every((bullet) => bullet.length < 255), `${row.sku}: bullet exceeds 254 chars`);
    assert(
      rendered.bullets.every((bullet) => !/^[A-Z][A-Z -]+:/.test(bullet)),
      `${row.sku}: all-caps bullet prefix is prohibited`,
    );

    const existingReview = existing?.review;
    const rationale = row.sku === "KP-ASYC-RN84"
      ? "The listing remains in its audited PASTRY product type with no product-type transition. The repair writes the exact 90-sandwich content plus 252 Ounce unit_count and number_of_items=90 directly under PASTRY. The full copy is the same exact recipe-grounded commercial template used across the 164-row factual repair."
      : existingReview
      ? `${existingReview.rationale} The full 164-row factual audit additionally replaces all customer-facing copy with one exact recipe-grounded commercial template so no unsupported weight, formulation, handling-duration, allergen, nutrition, or delivery generalization remains.`
      : "The full 164-row factual audit found live customer-facing claims that require product-label or handling evidence beyond the sealed recipe. The complete copy is replaced with an exact recipe-grounded commercial template that preserves product identity, count, original wrappers, and the verified common cold-pack components without unsupported generalizations.";
    const reviewEvidence = unique([
      ...(row.sku === "KP-ASYC-RN84" ? [] : existingReview?.evidence ?? []),
      `Immutable source ledger SHA-256 is ${UNCRUSTABLES_SOURCE_LEDGER_SHA256}.`,
      `Exact SELECTED_VARIANT recipe allocation sums to ${total} individual sandwiches.`,
      `Before-copy factual categories: ${findings.join(", ")}.`,
      `All 164 live drafts are FROZEN_GROCERY; count ${total} maps to canonical cooler ${expectedCooler}; a live merchant shipping group is present.`,
      `Owner fulfillment evidence for the branded cooler and gel packs is pinned to ${sources.owner_fulfillment_handoff.path} ${sources.owner_fulfillment_handoff.locator} (${sources.owner_fulfillment_handoff.sha256}); cooler sizing and frozen image policy are separately pinned to ${sources.frozen_cost_model.path} (${sources.frozen_cost_model.sha256}) and ${sources.frozen_image_policy.path} (${sources.frozen_image_policy.sha256}).`,
      ...exact12gEvidence,
      ...(kpOunceEvidence ? [kpOunceEvidence] : []),
      `Renderer ${sources.renderer.sha256} passes Amazon format, exact recipe/count semantic, expanded Rule 8, unsupported-claim, title-frequency, five-bullet, and no-all-caps gates for ${row.sku}.`,
    ]);

    const desiredTextCount: NonNullable<DesiredRepairManifest["repairs"][number]["text_count"]> = {
      ...(existing?.text_count ?? {}),
      ...rendered,
      unit_count: total,
      unit_count_type: "Count",
      number_of_items: total,
    };
    if (row.sku === "KP-ASYC-RN84") {
      desiredTextCount.unit_count = 252;
      desiredTextCount.unit_count_type = "Ounce";
      desiredTextCount.number_of_items = 90;
      desiredTextCount.request_product_type = "PASTRY";
      desiredTextCount.expected_product_type = "PASTRY";
      desiredTextCount.must_clear_issue_codes = ["90244"];
      delete desiredTextCount.fallback;
    }

    repairs.push({
      ...existing,
      sku: row.sku,
      review: {
        confidence: "HIGH",
        rationale,
        evidence: reviewEvidence,
      },
      text_count: desiredTextCount,
    });

    auditRows.push({
      sku: row.sku,
      asin: row.asin,
      intended_count: total,
      composition_signature: row.canonical?.composition_signature ?? "",
      composition_kind: variant.composition.length === 1 ? "SINGLE_FLAVOR" : "MIXED_FLAVOR",
      before_findings: findings,
      retained_12g_subline_identity: retained12g,
      cold_pack_evidence: {
        draft_category: "FROZEN_GROCERY",
        canonical_cooler: expectedCooler,
        merchant_shipping_group_present: true,
        owner_fulfillment_handoff: {
          sha256: UNCRUSTABLES_OWNER_FULFILLMENT_HANDOFF_SHA256,
          locator: "line 19",
          claim: "BRANDED_COOLER_AND_GEL_PACKS",
        },
      },
      disposition: "FULL_DETERMINISTIC_REWRITE",
      after: {
        title_length: rendered.title.length,
        bullet_count: 5,
        max_bullet_length: Math.max(...rendered.bullets.map((bullet) => bullet.length)),
        description_length: rendered.description.length,
        format_pass: true,
        semantic_pass: true,
        compliance_pass: true,
        unsupported_claim_scan_pass: true,
      },
    });
  }

  assert(repairs.length === UNCRUSTABLES_LIVE_REPAIR_SCOPE, "Full repair manifest is incomplete");
  assert(
    priorManifest.repairs.every((prior) => repairs.some((repair) => repair.sku === prior.sku)),
    "A prior reviewed decision was dropped",
  );

  const categoryCounts = Object.fromEntries(
    FACTUAL_PATTERNS.map(({ category }) => [
      category,
      auditRows.filter((row) => row.before_findings.includes(category)).length,
    ]),
  ) as Record<FactualClaimCategory, number>;
  const manifest: UncrustablesReviewedOverridesV3Manifest = {
    schema_version: "uncrustables-surgical-desired/v1",
    immutable: true,
    source_ledger_sha256: UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    reviewed_at: UNCRUSTABLES_REVIEWED_OVERRIDES_V3_REVIEWED_AT,
    supersedes: [
      {
        path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r5.json",
        sha256: "3cd84d9c0b467d40f9565c0f0633c0f7202f30789d2ececf45deec0bc987b1fc",
        status: "SUPERSEDED_DO_NOT_APPLY",
        reason: "FUTURE_REVIEW_TIMESTAMP",
      },
    ],
    repairs,
  };
  const audit: UncrustablesFactualContentAudit = {
    schema_version: "uncrustables-factual-content-audit/v1.0",
    immutable: true,
    created_at: UNCRUSTABLES_REVIEWED_OVERRIDES_V3_REVIEWED_AT,
    external_mutations: false,
    supersedes: [
      {
        path: "data/audits/uncrustables-factual-content-audit-20260718-v5.json",
        sha256: "71636419eb377804076fefa0e6443c8bcdc043b909cfbe20d9369a3e89eb662e",
        status: "SUPERSEDED_DO_NOT_APPLY",
        reason: "FUTURE_REVIEW_TIMESTAMP",
      },
    ],
    sources,
    policy: {
      exact_recipe_and_individual_count_only: true,
      cold_pack_claim_requires_frozen_program_evidence: true,
      owner_fulfillment_source_pinned: true,
      retain_numeric_protein_only_as_exact_manufacturer_subline_identity: true,
      own_brand_passthrough: true,
      curator_or_gift_disclaimer_required: false,
      generated_unsupported_claims_allowed: false,
    },
    summary: {
      source_rows: ledger.rows.length,
      live_rows: liveRows.length,
      historical_missing_asin_rows: skipped.length,
      full_rewrites: repairs.length,
      single_flavor_rows: auditRows.filter((row) => row.composition_kind === "SINGLE_FLAVOR").length,
      mixed_flavor_rows: auditRows.filter((row) => row.composition_kind === "MIXED_FLAVOR").length,
      category_counts: categoryCounts,
      retained_12g_subline_rows: auditRows.filter((row) => row.retained_12g_subline_identity).length,
      format_failures_after: 0,
      semantic_failures_after: 0,
      compliance_failures_after: 0,
      unsupported_claim_failures_after: 0,
    },
    rows: auditRows,
    skipped_rows: skipped
      .map((row) => ({
        sku: row.sku,
        asin: null,
        reason: "HISTORICAL_CREATION_MISSING_ASIN" as const,
      }))
      .sort((left, right) => left.sku.localeCompare(right.sku)),
  };
  return { manifest, audit };
}
