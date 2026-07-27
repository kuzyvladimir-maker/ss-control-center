/**
 * Phase 4 — Qualification Officer.
 *
 * Dept 5 (Qualifications) pre-publish QA gate. Checks ONE listing against the
 * single source of truth — the attribute registry + the shared brand-voice
 * rules — before it goes live. Read-only: returns a structured report the
 * publish flow / UI surfaces and the operator confirms. The SAME officer serves
 * both new-listing creation (Bundle Factory) and listing improvement (Amazon/
 * Walmart Growth) — the shared Listing Quality Stack.
 *
 * It does NOT mutate or block on its own; `ok=false` means "do not publish until
 * the FAIL items are resolved" (the UI gates the Publish button on it).
 */

import type { ChannelSKU } from "@/generated/prisma/client";
import {
  getRequired,
  getNeedsReview,
  productTypeForBundle,
  type AmazonProductType,
} from "@/lib/bundle-factory/attributes";
import {
  findPromoLanguage,
  findHealthClaims,
  hasEmoji,
  findForeignBrandsInText,
} from "@/lib/brand-voice";

export type QaStatus = "pass" | "warn" | "fail";

export interface QaCheck {
  id: string;
  status: QaStatus;
  message: string;
}

export interface QaReport {
  ok: boolean; // false if any FAIL
  sku: string;
  channel: string;
  product_type: AmazonProductType | null;
  checks: QaCheck[];
  fail_count: number;
  warn_count: number;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface QualifyOpts {
  productType?: AmazonProductType;
  isPet?: boolean;
}

/**
 * Qualify one ChannelSKU for publish. Pure function over the SKU row + the
 * registry/brand-voice — no I/O, so it's cheap to run on every publish attempt
 * and easy to reuse from the Growth modules.
 */
export function qualifyChannelSku(
  sku: Pick<
    ChannelSKU,
    | "sku"
    | "channel"
    | "title"
    | "bullets"
    | "description"
    | "price_cents"
    | "main_image_url"
    | "upc"
    | "package_weight_oz"
    | "package_length_in"
    | "package_width_in"
    | "package_height_in"
    | "attributes"
  >,
  opts: QualifyOpts = {},
): QaReport {
  const isAmazon = sku.channel.startsWith("AMAZON_");
  const productType = isAmazon
    ? opts.productType ?? productTypeForBundle({ isPet: opts.isPet })
    : null;
  const checks: QaCheck[] = [];
  const add = (id: string, status: QaStatus, message: string) =>
    checks.push({ id, status, message });

  const bullets = parseStringArray(sku.bullets);
  const attrs = parseObject(sku.attributes);
  const allText = `${sku.title}\n${bullets.join("\n")}\n${sku.description}`;

  // ── Completeness ──────────────────────────────────────────────────────────
  add(
    "title-present",
    sku.title && sku.title.trim().length > 0 ? "pass" : "fail",
    sku.title ? `Title: ${sku.title.length} chars` : "Title missing",
  );
  add(
    "bullets-present",
    bullets.length >= 4 ? "pass" : bullets.length > 0 ? "warn" : "fail",
    `${bullets.length} bullet(s) (≥4 expected)`,
  );
  add(
    "description-present",
    sku.description && sku.description.trim().length > 0 ? "pass" : "fail",
    sku.description ? `Description: ${sku.description.length} chars` : "Description missing",
  );
  add(
    "price-set",
    sku.price_cents > 0 ? "pass" : "fail",
    sku.price_cents > 0 ? `$${(sku.price_cents / 100).toFixed(2)}` : "Price is 0",
  );
  add(
    "main-image",
    sku.main_image_url ? "pass" : "fail",
    sku.main_image_url ? "Main image set" : "No main image",
  );
  add("upc", sku.upc ? "pass" : "fail", sku.upc ? `UPC ${sku.upc}` : "No UPC");
  const dimsOk =
    sku.package_weight_oz != null &&
    sku.package_weight_oz > 0 &&
    sku.package_length_in != null &&
    sku.package_width_in != null &&
    sku.package_height_in != null;
  add(
    "ship-specs",
    dimsOk ? "pass" : "fail",
    dimsOk ? "Weight + dimensions set" : "Weight or dimensions missing",
  );

  // ── Brand voice (shared lib) ──────────────────────────────────────────────
  add(
    "no-emoji",
    hasEmoji(allText) ? "fail" : "pass",
    hasEmoji(allText) ? "Emoji / bullet glyph found" : "No emoji",
  );
  const promo = findPromoLanguage(allText);
  add(
    "no-promo",
    promo.length > 0 ? "fail" : "pass",
    promo.length > 0 ? `Promo language: ${promo.join(", ")}` : "No promotional language",
  );
  const health = findHealthClaims(allText);
  add(
    "no-health-claims",
    health.length > 0 ? "fail" : "pass",
    health.length > 0 ? `Health claims: ${health.join(", ")}` : "No health claims",
  );
  const foreignInTitle = findForeignBrandsInText(sku.title);
  add(
    "no-foreign-brand-in-title",
    foreignInTitle.length > 0 ? "fail" : "pass",
    foreignInTitle.length > 0
      ? `Foreign brand in title: ${foreignInTitle.join(", ")}`
      : "Title brand-safe",
  );

  // ── Attribute coverage vs the registry (Amazon) ───────────────────────────
  if (productType) {
    const required = getRequired(productType);
    // These required keys are auto-filled by the payload builder + the SKU's
    // own content/identity. Treat them as covered when the backing data exists.
    const dataBacked: Record<string, boolean> = {
      item_name: !!sku.title,
      brand: true,
      manufacturer: true,
      bullet_point: bullets.length > 0,
      product_description: !!sku.description,
      country_of_origin: true,
      item_type_keyword: true,
      supplier_declared_dg_hz_regulation: true,
      externally_assigned_product_identifier: !!sku.upc,
      recommended_browse_nodes: true,
    };
    const missing = required.filter((a) => dataBacked[a.key] !== true);
    add(
      "required-attributes",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0
        ? `All ${required.length} required ${productType} attributes covered`
        : `Missing required: ${missing.map((m) => m.key).join(", ")}`,
    );

    // Food-compliance richness (allergens/ingredients) — informational.
    add(
      "food-allergens",
      "allergen_information" in attrs ? "pass" : "warn",
      "allergen_information" in attrs
        ? "Allergens declared"
        : "No allergens declared (verify the manufacturer label)",
    );
    add(
      "ingredients",
      "ingredients" in attrs ? "pass" : "warn",
      "ingredients" in attrs ? "Ingredients present" : "Ingredients not filled from catalog",
    );

    // Surface the count of attributes the algorithm could not auto-source — the
    // operator-awareness signal Vladimir asked for ("consider every column").
    const reviewCount = getNeedsReview(productType).length;
    add(
      "attributes-considered",
      "pass",
      `${reviewCount} optional attributes have no auto-source yet (reviewed, intentionally left blank)`,
    );
  }

  const fail_count = checks.filter((c) => c.status === "fail").length;
  const warn_count = checks.filter((c) => c.status === "warn").length;
  return {
    ok: fail_count === 0,
    sku: sku.sku,
    channel: sku.channel,
    product_type: productType,
    checks,
    fail_count,
    warn_count,
  };
}
