import {
  minimumWalmartNewSkuPriceForTargetMargin,
  walmartNewSkuComparableSignal,
} from "./walmart-new-sku-economics";

export const WALMART_NEW_SKU_COMMERCIAL_DISCOVERY_SCHEMA =
  "walmart-new-sku-commercial-discovery/1.1.0" as const;

export const WALMART_NEW_SKU_DISCOVERY_AUTHORITY =
  "PROVISIONAL_PRODUCT_TRUTH_GAP_PRIORITY_ONLY_NOT_LISTING_TRUTH" as const;

const EXCLUDED_TITLE_OR_CATEGORY =
  /frozen|refrigerated|chilled|supplement|vitamin|baby|infant|pet\s|dog\s|cat\s|medical|topical|pesticide|aerosol|battery|gift\s*(?:set|basket)|variety|mixed/i;
const EXCLUDED_SOURCE_RETAILERS = new Set([
  "amazon",
  "bjs",
  "costco",
  "samsclub",
]);

export interface WalmartNewSkuCommercialDiscoveryRow {
  donor_product_id: string;
  title: string | null;
  brand: string | null;
  size: string | null;
  category: string | null;
  manufacturer_upc: string | null;
  description: string | null;
  ingredients: string | null;
  nutrition_facts: string | null;
  main_image_url: string | null;
  image_urls: string | null;
  needs_review: number | boolean | null;
  offer_id: string;
  retailer: string;
  retailer_product_id: string;
  via: string;
  price: number | null;
  pack_size_seen: number | null;
  price_per_unit: number | null;
  zip: string | null;
  locality_evidence: string | null;
  in_stock: number | boolean | null;
  is_first_party: number | boolean | null;
  offer_title: string | null;
  product_url: string | null;
  fetched_at: string | null;
}

export interface WalmartNewSkuCommercialDiscoveryCandidate {
  donor_product_id: string;
  title: string;
  brand: string;
  size: string | null;
  category: string;
  manufacturer_upc: string;
  pack_count: 2 | 3;
  source_offer: {
    retailer: string;
    retailer_product_id: string;
    product_url: string;
    unit_price_cents: number;
    fetched_at: string | null;
    stale_or_unparseable: boolean;
  };
  walmart_comparable: {
    retailer_product_id: string;
    product_url: string;
    unit_price_cents: number;
    fetched_at: string | null;
    stale_or_unparseable: boolean;
  };
  provisional_economics: {
    goods_cents: number;
    packaging_cents: 150;
    seller_shipping_label_cents: 878;
    referral_fee_bps: 1500;
    target_margin_bps: 3000;
    minimum_item_price_cents: number;
    linearized_walmart_comparable_cents: number;
    proposed_to_comparable_ratio_bps: number;
    price_competitiveness_signal:
      | "AT_OR_BELOW_EXACT_COMPARABLE"
      | "ABOVE_EXACT_COMPARABLE_WARNING";
    source_discount_bps: number;
  };
  evidence_status: "SHORTLIST_ONLY_REQUIRES_FRESH_EXACT_EVIDENCE";
}

export interface WalmartNewSkuCommercialDiscovery {
  schema_version: typeof WALMART_NEW_SKU_COMMERCIAL_DISCOVERY_SCHEMA;
  authority: typeof WALMART_NEW_SKU_DISCOVERY_AUTHORITY;
  as_of: string;
  pack_count: 2 | 3;
  product_source: "PRODUCT_TRUTH_DONOR_CATALOG";
  full_seller_catalog_read: false;
  paid_provider_calls: 0;
  marketplace_calls: 0;
  candidates: WalmartNewSkuCommercialDiscoveryCandidate[];
  claims: {
    candidates_are_not_canonical_listing_inputs: true;
    fresh_exact_product_truth_evidence_required: true;
    fresh_exact_walmart_comparable_required: true;
    walmart_comparable_is_informational_not_candidate_rejection: true;
    walmart_pricing_rule_can_still_unpublish: true;
    exact_dimensions_and_shipping_quote_required: true;
    clubs_require_separate_owner_approved_plan: true;
  };
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trueValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function normalizedRetailer(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function imageCount(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string" && value.trim()).length
      : 0;
  } catch {
    return 0;
  }
}

function unitPriceCents(
  row: WalmartNewSkuCommercialDiscoveryRow,
): number | null {
  const price = numberValue(row.price);
  const packSize = numberValue(row.pack_size_seen) ?? 1;
  const perUnit = numberValue(row.price_per_unit) ?? (
    price === null ? null : price / packSize
  );
  return perUnit === null ? null : Math.round(perUnit * 100);
}

function staleOrUnparseable(
  fetchedAt: string | null,
  asOfMs: number,
): boolean {
  if (!fetchedAt) return true;
  const parsed = Date.parse(fetchedAt);
  return !Number.isFinite(parsed) || parsed > asOfMs ||
    asOfMs - parsed > 7 * 24 * 60 * 60 * 1_000;
}

function safeText(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

type SizeDimension = "MASS" | "VOLUME" | "COUNT";

function sizeSignals(raw: string): Partial<Record<SizeDimension, number>> {
  const normalized = raw
    .toLowerCase()
    .replace(
      /(\d+)-(\d+)-(?=(?:fl-)?oz|ounce|lb|pound|gram|kg|ml|liter|count|ct)/g,
      "$1.$2-",
    )
    .replace(/[^a-z0-9.]+/g, " ");
  const signals: Partial<Record<SizeDimension, number>> = {};
  const pattern =
    /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*ounces?|ounces?|oz|pounds?|lbs?|lb|kilograms?|kg|grams?|g|milliliters?|ml|liters?|litres?|l|count|ct)\b/g;
  for (const match of normalized.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2]!.replace(/\s+/g, "");
    if (!Number.isFinite(amount) || amount <= 0) continue;
    let dimension: SizeDimension;
    let baseAmount: number;
    if (unit === "floz" || unit.startsWith("fluidounce")) {
      dimension = "VOLUME";
      baseAmount = amount * 29.5735;
    } else if (
      unit === "ml" ||
      unit.startsWith("milliliter")
    ) {
      dimension = "VOLUME";
      baseAmount = amount;
    } else if (
      unit === "l" ||
      unit.startsWith("liter") ||
      unit.startsWith("litre")
    ) {
      dimension = "VOLUME";
      baseAmount = amount * 1_000;
    } else if (unit === "count" || unit === "ct") {
      dimension = "COUNT";
      baseAmount = amount;
    } else if (
      unit === "lb" ||
      unit === "lbs" ||
      unit.startsWith("pound")
    ) {
      dimension = "MASS";
      baseAmount = amount * 453.592;
    } else if (unit === "kg" || unit.startsWith("kilogram")) {
      dimension = "MASS";
      baseAmount = amount * 1_000;
    } else if (unit === "g" || unit.startsWith("gram")) {
      dimension = "MASS";
      baseAmount = amount;
    } else {
      dimension = "MASS";
      baseAmount = amount * 28.3495;
    }
    signals[dimension] = Math.max(signals[dimension] ?? 0, baseAmount);
  }
  return signals;
}

function samePhysicalSize(
  product: WalmartNewSkuCommercialDiscoveryRow,
  source: WalmartNewSkuCommercialDiscoveryRow,
  comparable: WalmartNewSkuCommercialDiscoveryRow,
): boolean {
  const productSignals = sizeSignals(
    `${product.title ?? ""} ${product.size ?? ""}`,
  );
  const sourceSignals = sizeSignals(
    `${source.offer_title ?? ""} ${source.product_url ?? ""}`,
  );
  const comparableSignals = sizeSignals(
    `${comparable.offer_title ?? ""} ${comparable.product_url ?? ""}`,
  );
  for (const dimension of ["MASS", "VOLUME", "COUNT"] as const) {
    const values = [
      productSignals[dimension],
      sourceSignals[dimension],
      comparableSignals[dimension],
    ];
    if (values.some((value) => value === undefined)) continue;
    const [productAmount, sourceAmount, comparableAmount] = values as [
      number,
      number,
      number,
    ];
    const maximum = Math.max(productAmount, sourceAmount, comparableAmount);
    const minimum = Math.min(productAmount, sourceAmount, comparableAmount);
    const tolerance = dimension === "COUNT"
      ? 0.001
      : Math.max(2, maximum * 0.03);
    return maximum - minimum <= tolerance;
  }
  return false;
}

function eligibleOffer(
  row: WalmartNewSkuCommercialDiscoveryRow,
): boolean {
  return trueValue(row.is_first_party) &&
    trueValue(row.in_stock) &&
    row.via.toLowerCase() === "direct" &&
    unitPriceCents(row) !== null &&
    Boolean(safeText(row.product_url));
}

function bestOffer(
  rows: WalmartNewSkuCommercialDiscoveryRow[],
): WalmartNewSkuCommercialDiscoveryRow | null {
  return [...rows].sort((left, right) => {
    const priceDelta = unitPriceCents(left)! - unitPriceCents(right)!;
    if (priceDelta !== 0) return priceDelta;
    return left.offer_id.localeCompare(right.offer_id, "en-US");
  })[0] ?? null;
}

export function buildWalmartNewSkuCommercialDiscovery(input: {
  rows: WalmartNewSkuCommercialDiscoveryRow[];
  asOf: string;
  packCount: 2 | 3;
  limit?: number;
}): WalmartNewSkuCommercialDiscovery {
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs) || new Date(asOfMs).toISOString() !== input.asOf) {
    throw new Error("commercial discovery asOf must be canonical ISO UTC");
  }
  const limit = Math.max(1, Math.min(20, input.limit ?? 10));
  const grouped = new Map<string, WalmartNewSkuCommercialDiscoveryRow[]>();
  for (const row of input.rows) {
    const id = row.donor_product_id?.trim();
    if (!id) continue;
    const rows = grouped.get(id) ?? [];
    rows.push(row);
    grouped.set(id, rows);
  }

  const candidates: WalmartNewSkuCommercialDiscoveryCandidate[] = [];
  for (const [donorProductId, rows] of grouped) {
    const product = rows[0]!;
    const title = safeText(product.title);
    const brand = safeText(product.brand);
    const category = safeText(product.category);
    const manufacturerUpc = safeText(product.manufacturer_upc);
    if (
      !title ||
      !brand ||
      !category ||
      !manufacturerUpc ||
      trueValue(product.needs_review) ||
      EXCLUDED_TITLE_OR_CATEGORY.test(`${title} ${category}`) ||
      !safeText(product.description) ||
      !safeText(product.ingredients) ||
      !safeText(product.nutrition_facts) ||
      !safeText(product.main_image_url) ||
      imageCount(product.image_urls) < 2
    ) {
      continue;
    }

    const offers = rows.filter(eligibleOffer);
    const comparable = bestOffer(offers.filter(
      (row) => normalizedRetailer(row.retailer) === "walmart",
    ));
    const source = bestOffer(offers.filter(
      (row) => !EXCLUDED_SOURCE_RETAILERS.has(
        normalizedRetailer(row.retailer),
      ),
    ));
    if (!comparable || !source) continue;
    if (!samePhysicalSize(product, source, comparable)) continue;
    const comparableUnitCents = unitPriceCents(comparable)!;
    const sourceUnitCents = unitPriceCents(source)!;

    const goodsCents = sourceUnitCents * input.packCount;
    const economics = minimumWalmartNewSkuPriceForTargetMargin({
      goodsCostCents: goodsCents,
      packagingCostCents: 150,
      shippingLabelCents: 878,
    });
    const minimumItemPriceCents = economics.item_price_cents;
    const linearizedWalmartComparableCents =
      comparableUnitCents * input.packCount;
    const comparableSignal = walmartNewSkuComparableSignal({
      itemPriceCents: minimumItemPriceCents,
      linearizedComparableCents: linearizedWalmartComparableCents,
    });

    candidates.push({
      donor_product_id: donorProductId,
      title,
      brand,
      size: safeText(product.size),
      category,
      manufacturer_upc: manufacturerUpc,
      pack_count: input.packCount,
      source_offer: {
        retailer: source.retailer,
        retailer_product_id: source.retailer_product_id,
        product_url: source.product_url!.trim(),
        unit_price_cents: sourceUnitCents,
        fetched_at: safeText(source.fetched_at),
        stale_or_unparseable: staleOrUnparseable(
          source.fetched_at,
          asOfMs,
        ),
      },
      walmart_comparable: {
        retailer_product_id: comparable.retailer_product_id,
        product_url: comparable.product_url!.trim(),
        unit_price_cents: comparableUnitCents,
        fetched_at: safeText(comparable.fetched_at),
        stale_or_unparseable: staleOrUnparseable(
          comparable.fetched_at,
          asOfMs,
        ),
      },
      provisional_economics: {
        goods_cents: goodsCents,
        packaging_cents: 150,
        seller_shipping_label_cents: 878,
        referral_fee_bps: 1500,
        target_margin_bps: 3000,
        minimum_item_price_cents: minimumItemPriceCents,
        linearized_walmart_comparable_cents:
          linearizedWalmartComparableCents,
        ...comparableSignal,
        source_discount_bps: Math.round(
          (comparableUnitCents - sourceUnitCents) * 10_000 /
          comparableUnitCents,
        ),
      },
      evidence_status: "SHORTLIST_ONLY_REQUIRES_FRESH_EXACT_EVIDENCE",
    });
  }

  candidates.sort((left, right) =>
    Number(left.source_offer.stale_or_unparseable) -
      Number(right.source_offer.stale_or_unparseable) ||
    Number(left.walmart_comparable.stale_or_unparseable) -
      Number(right.walmart_comparable.stale_or_unparseable) ||
    right.provisional_economics.source_discount_bps -
      left.provisional_economics.source_discount_bps ||
    left.provisional_economics.minimum_item_price_cents -
      right.provisional_economics.minimum_item_price_cents ||
    left.title.localeCompare(right.title, "en-US") ||
    left.donor_product_id.localeCompare(right.donor_product_id, "en-US")
  );

  return {
    schema_version: WALMART_NEW_SKU_COMMERCIAL_DISCOVERY_SCHEMA,
    authority: WALMART_NEW_SKU_DISCOVERY_AUTHORITY,
    as_of: input.asOf,
    pack_count: input.packCount,
    product_source: "PRODUCT_TRUTH_DONOR_CATALOG",
    full_seller_catalog_read: false,
    paid_provider_calls: 0,
    marketplace_calls: 0,
    candidates: candidates.slice(0, limit),
    claims: {
      candidates_are_not_canonical_listing_inputs: true,
      fresh_exact_product_truth_evidence_required: true,
      fresh_exact_walmart_comparable_required: true,
      walmart_comparable_is_informational_not_candidate_rejection: true,
      walmart_pricing_rule_can_still_unpublish: true,
      exact_dimensions_and_shipping_quote_required: true,
      clubs_require_separate_owner_approved_plan: true,
    },
  };
}
