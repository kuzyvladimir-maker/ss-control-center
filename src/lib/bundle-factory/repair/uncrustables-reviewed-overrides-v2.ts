/**
 * Deterministic construction of the second reviewed Uncrustables override set.
 *
 * The source ledger is immutable. This module does not perform network, DB, or
 * Amazon writes; it only derives conservative customer-facing copy from the
 * exact canonical recipe already sealed in that ledger.
 */

import { validateOutput, validateSemanticOutput } from "../content-generation";
import { rulePromotionalLanguage } from "../compliance/rules/rule-8-promotional-language";
import type { Variant, VariantComponent } from "../variation-matrix";
import { renderUncrustablesRepairContent } from "./uncrustables-content";
import type { DesiredRepairManifest } from "./uncrustables-surgical";

export const UNCRUSTABLES_SOURCE_LEDGER_SHA256 =
  "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f";

export const UNCRUSTABLES_REVIEWED_OVERRIDES_V2_REVIEWED_AT =
  "2026-07-18T04:50:00.000Z";

/** Exact live rows caught by the expanded frozen-delivery claim gate. */
export const FROZEN_DELIVERY_FULL_REWRITE_SKUS = [
  "DP-ASQ6-ZPZU",
  "DY-AS8W-6MJG",
  "KP-ASYC-RN84",
  "SC-ASH8-4RQG",
  "SG-AS32-LZ9Y",
  "UG-ASUO-L4D9",
  "ZH-AS8W-G5MN",
] as const;

/** Includes the two already-reviewed count rewrites preserved from v1. */
export const FULL_TEXT_REPAIR_SKUS = [
  ...FROZEN_DELIVERY_FULL_REWRITE_SKUS,
  "SZ-ASPI-JFAT",
  "VN-AS1A-D572",
] as const;

const FROZEN_DELIVERY_TERMS = [
  "ships frozen",
  "ship frozen",
  "shipped frozen",
  "delivered frozen",
  "arrive frozen",
  "arrives frozen",
] as const;

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
  canonical?: {
    total_units?: number;
    component_qty_sum?: number;
    composition_source?: string;
    composition_signature?: string;
    components?: CanonicalComponent[];
  };
  db?: {
    draft?: {
      brand?: string;
      pack_count?: number;
      selected_variant?: { name?: string };
    };
  };
  live?: {
    title?: string | null;
    bullets?: string[];
    description?: string | null;
  };
}

export interface UncrustablesLedgerForReviewedOverrides {
  rows: LedgerRow[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function liveContent(row: LedgerRow): {
  title: string;
  bullets: string[];
  description: string;
} {
  return {
    title: row.live?.title ?? "",
    bullets: row.live?.bullets ?? [],
    description: row.live?.description ?? "",
  };
}

function canonicalVariant(row: LedgerRow): Variant {
  const components = row.canonical?.components;
  assert(Array.isArray(components) && components.length > 0, `${row.sku}: canonical recipe is empty`);

  const composition: VariantComponent[] = components.map((component) => {
    assert(
      typeof component.product_id === "string" && component.product_id.length > 0,
      `${row.sku}: canonical component has no product_id`,
    );
    assert(
      typeof component.product_name === "string" && component.product_name.length > 0,
      `${row.sku}: canonical component has no product_name`,
    );
    assert(
      Number.isInteger(component.qty) && component.qty > 0,
      `${row.sku}: canonical component has invalid qty`,
    );
    return {
      research_pool_id: component.product_id,
      product_name: component.product_name,
      brand: component.brand,
      flavor: component.flavor ?? null,
      qty: component.qty,
      unit_price_cents: component.unit_price_cents,
    };
  });

  return {
    idx: 0,
    name: row.db?.draft?.selected_variant?.name ?? `${row.sku} reviewed recipe`,
    composition,
    cost_cents: 0,
    suggested_price_cents: 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 100,
    notes: "Exact immutable-ledger canonical recipe used for reviewed repair copy.",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Merge the exact seven newly detected full rewrites into the sealed v1
 * decisions. Existing offer/structured decisions and the SZ/VN full rewrites
 * are preserved byte-for-value at the object level. KP's reviewed GROCERY
 * primary and PASTRY/Ounce fallback are preserved while its text is replaced.
 */
export function buildUncrustablesReviewedOverridesV2(input: {
  ledger: UncrustablesLedgerForReviewedOverrides;
  baseManifest: DesiredRepairManifest;
}): DesiredRepairManifest {
  const { ledger, baseManifest } = input;
  assert(
    baseManifest.schema_version === "uncrustables-surgical-desired/v1",
    `Unexpected base manifest schema: ${baseManifest.schema_version}`,
  );
  assert(baseManifest.immutable === true, "Base reviewed override manifest must be immutable");
  assert(
    baseManifest.source_ledger_sha256 === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    "Base reviewed override manifest is not pinned to the exact source ledger",
  );

  const rows = new Map(ledger.rows.map((row) => [row.sku, row]));
  assert(rows.size === ledger.rows.length, "Source ledger contains duplicate SKUs");
  const repairs = new Map(
    structuredClone(baseManifest.repairs).map((repair) => [repair.sku, repair]),
  );

  for (const sku of ["SZ-ASPI-JFAT", "VN-AS1A-D572"] as const) {
    const existing = repairs.get(sku);
    assert(existing?.text_count?.title, `${sku}: v1 full title must be preserved`);
    assert(existing.text_count.bullets?.length === 5, `${sku}: v1 five bullets must be preserved`);
    assert(existing.text_count.description, `${sku}: v1 description must be preserved`);
  }

  for (const sku of FROZEN_DELIVERY_FULL_REWRITE_SKUS) {
    const row = rows.get(sku);
    assert(row, `${sku}: missing from exact source ledger`);
    const total = row.canonical?.total_units;
    assert(Number.isInteger(total) && (total as number) > 0, `${sku}: invalid canonical total`);
    assert(
      row.canonical?.composition_source === "SELECTED_VARIANT",
      `${sku}: canonical composition must come from SELECTED_VARIANT`,
    );
    assert(
      row.canonical?.component_qty_sum === total,
      `${sku}: canonical recipe/count mismatch`,
    );
    assert(
      row.db?.draft?.pack_count === total,
      `${sku}: draft/canonical count mismatch`,
    );

    const variant = canonicalVariant(row);
    const before = liveContent(row);
    const beforeText = [before.title, ...before.bullets, before.description]
      .join("\n")
      .toLowerCase();
    const matchedTerms = FROZEN_DELIVERY_TERMS.filter((term) =>
      beforeText.includes(term)
    );
    assert(matchedTerms.length > 0, `${sku}: no frozen-delivery term in sealed live text`);

    const beforeRule = rulePromotionalLanguage({
      ...before,
      brand: "Uncrustables",
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      skip_image_check: true,
    });
    assert(
      beforeRule.passed === false && beforeRule.reason === "sale_shipping_claims",
      `${sku}: sealed live text must fail the frozen-delivery claim gate`,
    );

    const rendered = renderUncrustablesRepairContent({
      variant,
      total: total as number,
    });
    assert(validateOutput(rendered, "amazon") === null, `${sku}: rendered output format failed`);
    assert(
      validateSemanticOutput(rendered, {
        brand: row.db?.draft?.brand ?? "Uncrustables",
        pack_count: total as number,
        selected_variant: variant,
      }) === null,
      `${sku}: rendered output semantic validation failed`,
    );
    const afterRule = rulePromotionalLanguage({
      ...rendered,
      brand: "Uncrustables",
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      skip_image_check: true,
    });
    assert(afterRule.passed, `${sku}: deterministic repair still violates Rule 8`);

    const existing = repairs.get(sku);
    if (existing?.text_count?.unit_count != null) {
      assert(
        existing.text_count.unit_count === total,
        `${sku}: existing reviewed unit count conflicts with canonical total`,
      );
    }
    const existingReview = existing?.review;
    repairs.set(sku, {
      ...existing,
      sku,
      review: {
        confidence: "HIGH",
        rationale: existingReview
          ? `${existingReview.rationale} A fresh strict offline content audit also found a prohibited frozen-delivery claim, so the complete title, bullets, and description are replaced with exact recipe-grounded deterministic copy.`
          : "A fresh strict offline content audit found a prohibited frozen-delivery claim in the sealed live text. The complete title, bullets, and description are replaced with conservative deterministic copy grounded only in the exact selected recipe and individual-sandwich count.",
        evidence: unique([
          ...(existingReview?.evidence ?? []),
          `Immutable source ledger SHA-256 is ${UNCRUSTABLES_SOURCE_LEDGER_SHA256}.`,
          `Sealed live text matches prohibited frozen-delivery term(s): ${matchedTerms.join(", ")}.`,
          `Canonical SELECTED_VARIANT composition quantity sum equals ${total} individual sandwiches.`,
          `Deterministic renderer passes Amazon format validation, recipe/count semantic validation, and the expanded Rule 8 gate for ${sku}.`,
        ]),
      },
      text_count: {
        ...rendered,
        unit_count: total as number,
        unit_count_type: "Count",
        number_of_items: total as number,
        ...(existing?.text_count ?? {}),
        // Full copy is always the deterministic render, while existing KP
        // product-type/fallback strategy fields above remain intact.
        ...rendered,
      },
    });
  }

  const output: DesiredRepairManifest = {
    schema_version: "uncrustables-surgical-desired/v1",
    immutable: true,
    source_ledger_sha256: UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    reviewed_at: UNCRUSTABLES_REVIEWED_OVERRIDES_V2_REVIEWED_AT,
    repairs: [...repairs.values()].sort((left, right) =>
      left.sku.localeCompare(right.sku)
    ),
  };

  assert(output.repairs.length === 10, `Expected 10 reviewed repairs, got ${output.repairs.length}`);
  const fullText = output.repairs
    .filter((repair) =>
      repair.text_count?.title &&
      repair.text_count.bullets?.length === 5 &&
      repair.text_count.description
    )
    .map((repair) => repair.sku)
    .sort();
  assert(
    JSON.stringify(fullText) === JSON.stringify([...FULL_TEXT_REPAIR_SKUS].sort()),
    `Unexpected full-text repair scope: ${fullText.join(", ")}`,
  );

  return output;
}
