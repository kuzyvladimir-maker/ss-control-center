/** Ensures the offer price and repricer corridor match the canonical model. */

import { priceFor } from "@/lib/pricing/cost-model";
import { isOwnBrandPassthrough } from "../../own-brand";
import type { ValidatorFn } from "../types";

function band(attributes: string, key: string): number | null {
  try {
    const attrs = JSON.parse(attributes) as Record<string, unknown>;
    const offer = Array.isArray(attrs.purchasable_offer)
      ? attrs.purchasable_offer[0] as Record<string, unknown> | undefined
      : undefined;
    const rows = offer?.[key] as Array<{
      schedule?: Array<{ value_with_tax?: unknown }>;
    }> | undefined;
    const value = Number(rows?.[0]?.schedule?.[0]?.value_with_tax);
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  } catch {
    return null;
  }
}

function canonicalPriceAttributeFailures(attributes: string): string[] {
  try {
    const attrs = JSON.parse(attributes) as Record<string, unknown>;
    const failures: string[] = [];
    if (attrs.list_price != null) failures.push("list_price must be absent");
    return failures;
  } catch {
    return ["pricing attributes are not valid JSON"];
  }
}

export const validatorCanonicalPrice: ValidatorFn = async ({
  sku,
  master_bundle,
}) => {
  if (!master_bundle) {
    return {
      validator_id: "validator-canonical-price",
      passed: false,
      severity: "error",
      message: "MasterBundle missing — canonical price cannot be verified.",
    };
  }

  let expectedPrice = master_bundle.suggested_price_cents;
  let expectedFloor: number | null = null;
  if (isOwnBrandPassthrough(master_bundle.brand)) {
    const canonical = priceFor(master_bundle.pack_count);
    if (!canonical) {
      return {
        validator_id: "validator-canonical-price",
        passed: false,
        severity: "error",
        message: `No canonical price for ${master_bundle.pack_count} units.`,
      };
    }
    expectedPrice = Math.round(canonical.suggested * 100);
    expectedFloor = Math.round(canonical.floor * 100);
  } else {
    try {
      const spec = JSON.parse(master_bundle.packaging_spec) as {
        floor_price_cents?: unknown;
      };
      const parsed = Number(spec.floor_price_cents);
      expectedFloor = Number.isFinite(parsed) ? Math.round(parsed) : null;
    } catch {
      expectedFloor = null;
    }
  }

  // Amazon min/max bands are not Walmart offer fields. Walmart still needs
  // the canonical listing price and the independent margin validator, but it
  // must not be failed for lacking Amazon `purchasable_offer` attributes.
  if (sku.channel === "WALMART") {
    if (sku.price_cents !== expectedPrice) {
      return {
        validator_id: "validator-canonical-price",
        passed: false,
        severity: "error",
        message: `Canonical Walmart price mismatch: ${sku.price_cents} != ${expectedPrice}.`,
        details: {
          expected_price_cents: expectedPrice,
          actual_price_cents: sku.price_cents,
          amazon_price_bands_skipped: true,
        },
      };
    }
    return {
      validator_id: "validator-canonical-price",
      passed: true,
      details: {
        expected_price_cents: expectedPrice,
        amazon_price_bands_skipped: true,
      },
    };
  }

  const minBand = band(sku.attributes, "minimum_seller_allowed_price");
  const maxBand = band(sku.attributes, "maximum_seller_allowed_price");
  const failures: string[] = [];
  if (sku.price_cents !== expectedPrice) {
    failures.push(`price ${sku.price_cents} != ${expectedPrice}`);
  }
  if (maxBand !== expectedPrice) {
    failures.push(`maximum band ${maxBand ?? "missing"} != ${expectedPrice}`);
  }
  if (expectedFloor != null && minBand !== expectedFloor) {
    failures.push(`minimum band ${minBand ?? "missing"} != ${expectedFloor}`);
  }
  if (isOwnBrandPassthrough(master_bundle.brand) && expectedPrice % 100 !== 99) {
    failures.push("canonical Uncrustables price does not end in .99");
  }
  if (
    isOwnBrandPassthrough(master_bundle.brand) &&
    sku.business_price_cents !== expectedPrice
  ) {
    failures.push(
      `business price ${sku.business_price_cents ?? "missing"} != ${expectedPrice}`,
    );
  }
  if (isOwnBrandPassthrough(master_bundle.brand)) {
    // This validator owns Layer A only. Coupon-vs-Sale-Price arm, dates, and
    // effective price are SKU-specific and must be proven by the independent
    // SHA-sealed launch-pricing manifest/repair verifier. Guessing an arm from
    // pack_count here could approve a double discount or a missing Sale Price.
    failures.push(...canonicalPriceAttributeFailures(sku.attributes));
  }

  if (failures.length > 0) {
    return {
      validator_id: "validator-canonical-price",
      passed: false,
      severity: "error",
      message: `Canonical pricing mismatch: ${failures.join("; ")}.`,
      details: {
        expected_price_cents: expectedPrice,
        expected_floor_cents: expectedFloor,
        actual_price_cents: sku.price_cents,
        min_band_cents: minBand,
        max_band_cents: maxBand,
        promotion_overlay_validation:
          "DELEGATED_TO_SHA_SEALED_LAUNCH_PRICING_PLAN",
      },
    };
  }
  return {
    validator_id: "validator-canonical-price",
    passed: true,
    details: {
      expected_price_cents: expectedPrice,
      expected_floor_cents: expectedFloor,
      promotion_overlay_validation:
        "DELEGATED_TO_SHA_SEALED_LAUNCH_PRICING_PLAN",
    },
  };
};
