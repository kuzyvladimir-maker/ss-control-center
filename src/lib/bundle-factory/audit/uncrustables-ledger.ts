/**
 * Pure normalization and reconciliation helpers for the Uncrustables ledger.
 *
 * This module has no DB, filesystem, or network dependencies. The CLI adapter
 * supplies DB snapshots and raw Listings Items responses; these functions turn
 * them into a deterministic, unit-testable audit record.
 */

import { MARKETPLACE_ID } from "../../amazon-sp-api/client";
import { parseTotal, priceFor, type Priced } from "../../pricing/cost-model";
import { BRAND_CARD_COLD_CHAIN_URL } from "../attributes/brand-assets";

/**
 * Amazon content-addressed CDN copies that have been downloaded and compared
 * with BRAND_CARD_COLD_CHAIN_URL. The first entry was verified on 2026-07-17
 * at 2000x2000: source PNG SHA-256
 * 9a8813c8a92f60faa4a2aae3844d19e3ada0c5e3d147567df1095b2558a6299b,
 * JPEG re-host normalized pixel similarity 99.405% (MAE 1.5165 / 255).
 *
 * Keeping the allow-list exact means an unknown Amazon CDN image remains
 * unverified; merely being hosted by Amazon never proves its identity.
 */
export const VERIFIED_BRAND_CARD_REHOST_URLS = new Set([
  "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
]);

/** Amazon CDN objects visually verified to be something else. */
export const REJECTED_BRAND_CARD_REHOST_URLS = new Set([
  // 2400x2400 Nutrition Facts panel, observed on three early BF listings.
  "https://m.media-amazon.com/images/I/81+K8ip-dSL.jpg",
]);

export type LedgerSeverity = "CRITICAL" | "ERROR" | "WARNING" | "INFO";

export interface LedgerAnomaly {
  code: string;
  severity: LedgerSeverity;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface RecipeComponentSnapshot {
  product_id?: string | null;
  product_name: string;
  brand: string | null;
  flavor: string | null;
  qty: number;
  unit_price_cents: number | null;
  source_url?: string | null;
}

export interface DraftSnapshot {
  id: string;
  generation_job_id: string;
  name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
  status: string;
  compliance_status: string;
  components: RecipeComponentSnapshot[];
  selected_variant_idx: number | null;
  selected_variant: {
    name: string | null;
    composition: RecipeComponentSnapshot[];
  } | null;
  title: string | null;
  bullets: string[];
  description: string | null;
  main_image_url: string | null;
  secondary_image_urls: string[];
  generated_content: Array<{
    channel: string;
    compliance_status: string;
    title: string;
    bullets: string[];
    description: string;
    main_image_url: string | null;
  }>;
}

export interface MasterSnapshot {
  id: string;
  generation_job_id: string | null;
  name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
  lifecycle_status: string;
  estimated_cost_cents: number;
  suggested_price_cents: number;
  main_image_url: string | null;
  secondary_image_urls: string[];
  components: RecipeComponentSnapshot[];
}

export interface ChannelSkuSnapshot {
  id: string;
  channel: string;
  store_index: number | null;
  sku: string;
  upc: string;
  asin: string | null;
  title: string;
  bullets: string[];
  description: string;
  attributes: Record<string, unknown>;
  channel_category: string | null;
  channel_browse_node: string | null;
  price_cents: number;
  business_price_cents: number | null;
  lifecycle_status: string;
  compliance_status: string;
  validation_status: string;
  listing_status: string;
  main_image_url: string | null;
  submitted_at: string | null;
  live_at: string | null;
  published_at: string | null;
  errors: unknown[];
  distribution_errors: unknown[];
}

export interface LedgerDbSnapshot {
  channel_sku: ChannelSkuSnapshot;
  master: MasterSnapshot;
  draft: DraftSnapshot | null;
}

export interface CanonicalRecipe {
  total_units: number;
  composition_source: "SELECTED_VARIANT" | "DRAFT_COMPONENTS" | "MASTER_COMPONENTS" | "MISSING";
  components: RecipeComponentSnapshot[];
  component_qty_sum: number;
  composition_signature: string | null;
  pricing: Priced | null;
}

export interface LiveOffer {
  audience: string;
  our_price: number | null;
  discounted_price: number | null;
  minimum_seller_allowed_price: number | null;
  maximum_seller_allowed_price: number | null;
  quantity_discounts: unknown[];
}

export interface LiveFulfillmentAvailability {
  source: "attributes" | "top_level";
  fulfillment_channel_code: string | null;
  quantity: number | null;
}

export interface LiveListingSnapshot {
  fetched: boolean;
  error: string | null;
  asin: string | null;
  amazon_statuses: string[];
  buyable: boolean;
  discoverable: boolean;
  product_type: string | null;
  title: string | null;
  title_total_units: number | null;
  bullets: string[];
  description: string | null;
  brand: string | null;
  category: string | null;
  browse_nodes: string[];
  item_type_keywords: string[];
  main_image_url: string | null;
  gallery_image_urls: string[];
  unit_count: number | null;
  number_of_items: number | null;
  consumer_offer: LiveOffer | null;
  business_offers: LiveOffer[];
  separate_business_price: number | null;
  fulfillment_availability: LiveFulfillmentAvailability[];
  issues: Array<{
    code: string | null;
    severity: string | null;
    message: string | null;
    attribute_names: string[];
    categories: string[];
  }>;
  raw_attributes: Record<string, unknown>;
  raw_offers: unknown;
}

export interface LedgerRow {
  sku: string;
  asin: string | null;
  channel: string;
  store_index: number | null;
  canonical: CanonicalRecipe;
  db: LedgerDbSnapshot;
  live: LiveListingSnapshot | null;
  anomalies: LedgerAnomaly[];
  highest_severity: LedgerSeverity | "NONE";
  perfect: boolean;
}

export interface LedgerSummary {
  rows: number;
  live_fetch_succeeded: number;
  live_fetch_failed: number;
  buyable: number;
  discoverable: number;
  perfect: number;
  with_critical: number;
  with_error: number;
  with_warning: number;
  with_info_only: number;
  anomaly_counts: Record<string, number>;
  severity_counts: Record<LedgerSeverity, number>;
  canonical_count_distribution: Record<string, number>;
}

type UnknownRecord = Record<string, unknown>;

const SEVERITY_RANK: Record<LedgerSeverity | "NONE", number> = {
  NONE: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstLocalizedRecord(value: unknown): UnknownRecord | null {
  const rows = array(value).map(record).filter((v): v is UnknownRecord => v != null);
  return (
    rows.find((v) => v.marketplace_id === MARKETPLACE_ID) ??
    rows.find((v) => v.marketplaceId === MARKETPLACE_ID) ??
    rows[0] ??
    null
  );
}

function localizedStrings(value: unknown, key: string = "value"): string[] {
  return array(value)
    .map(record)
    .filter((v): v is UnknownRecord => v != null)
    .filter((v) => {
      const marketplace = v.marketplace_id ?? v.marketplaceId;
      return marketplace == null || marketplace === MARKETPLACE_ID;
    })
    .map((v) => stringValue(v[key]))
    .filter((v): v is string => v != null);
}

function firstLocalizedString(value: unknown, key: string = "value"): string | null {
  return stringValue(firstLocalizedRecord(value)?.[key]);
}

function firstLocalizedNumber(value: unknown, key: string = "value"): number | null {
  return numberValue(firstLocalizedRecord(value)?.[key]);
}

function dateValue(value: unknown): number | null {
  const wrapped = record(value);
  const raw = wrapped && "value" in wrapped ? wrapped.value : value;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Select the currently active price schedule, falling back to the first valid
 * numeric schedule when Amazon omits start/end timestamps. */
export function schedulePrice(value: unknown, now: Date = new Date()): number | null {
  const schedules: UnknownRecord[] = [];
  for (const outerValue of array(value)) {
    const outer = record(outerValue);
    if (!outer) continue;
    const nested = array(outer.schedule)
      .map(record)
      .filter((v): v is UnknownRecord => v != null);
    if (nested.length) schedules.push(...nested);
    else schedules.push(outer);
  }
  const numeric = schedules.filter((s) => numberValue(s.value_with_tax ?? s.value) != null);
  if (!numeric.length) return null;
  const at = now.getTime();
  const active = numeric.find((s) => {
    const start = dateValue(s.start_at);
    const end = dateValue(s.end_at);
    return (start == null || start <= at) && (end == null || end > at);
  });
  const hasTemporalBounds = numeric.some(
    (schedule) => dateValue(schedule.start_at) != null || dateValue(schedule.end_at) != null,
  );
  if (!active && hasTemporalBounds) return null;
  const selected = active ?? numeric[0];
  return numberValue(selected.value_with_tax ?? selected.value);
}

function normalizeOffer(value: unknown, now: Date): LiveOffer | null {
  const offer = record(value);
  if (!offer) return null;
  return {
    audience:
      stringValue(offer.audience) ??
      stringValue(record(offer.audience)?.value) ??
      "ALL",
    our_price: schedulePrice(offer.our_price, now),
    discounted_price: schedulePrice(offer.discounted_price, now),
    minimum_seller_allowed_price: schedulePrice(
      offer.minimum_seller_allowed_price,
      now,
    ),
    maximum_seller_allowed_price: schedulePrice(
      offer.maximum_seller_allowed_price,
      now,
    ),
    quantity_discounts: array(
      offer.quantity_discount_plan ?? offer.quantity_discounts ?? offer.quantity_price,
    ),
  };
}

/** Listings Items `includedData=offers` returns a second, top-level offer
 * representation (`offerType: B2C|B2B`, `price.amount`). It is the only place
 * some accounts expose the active Amazon Business price, so it must be merged
 * with the attribute-shaped `purchasable_offer` entries. */
function normalizeTopLevelOffer(value: unknown): LiveOffer | null {
  const offer = record(value);
  if (!offer) return null;
  const audience =
    stringValue(record(offer.audience)?.value) ??
    stringValue(offer.audience) ??
    stringValue(offer.offerType) ??
    "ALL";
  const price = record(offer.price);
  const discounted = record(offer.discountedPrice ?? offer.discounted_price);
  return {
    audience,
    our_price: numberValue(price?.amount ?? price?.value ?? offer.price),
    discounted_price: numberValue(
      discounted?.amount ?? discounted?.value ?? offer.discountedPrice,
    ),
    minimum_seller_allowed_price: null,
    maximum_seller_allowed_price: null,
    quantity_discounts: array(
      offer.quantityDiscounts ??
        offer.quantity_discounts ??
        offer.quantityDiscountPlan,
    ),
  };
}

function isBusinessAudience(value: string): boolean {
  return /^(?:B2B|BUSINESS)$/i.test(value);
}

function isConsumerAudience(value: string): boolean {
  return /^(?:ALL|B2C|CONSUMER)$/i.test(value);
}

function dedupeOffers(values: LiveOffer[]): LiveOffer[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = [
      value.audience.toUpperCase(),
      value.our_price ?? "",
      value.discounted_price ?? "",
      value.minimum_seller_allowed_price ?? "",
      value.maximum_seller_allowed_price ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageUrl(value: unknown): string | null {
  const row = firstLocalizedRecord(value);
  return stringValue(row?.media_location ?? row?.link ?? row?.url);
}

function isAmazonMediaUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "m.media-amazon.com" || host.endsWith(".media-amazon.com");
  } catch {
    return false;
  }
}

function topLevelAvailability(value: unknown): LiveFulfillmentAvailability[] {
  return array(value)
    .map(record)
    .filter((v): v is UnknownRecord => v != null)
    .map((v) => ({
      source: "top_level" as const,
      fulfillment_channel_code: stringValue(
        v.fulfillmentChannelCode ?? v.fulfillment_channel_code,
      ),
      quantity: numberValue(v.quantity),
    }));
}

function attributeAvailability(value: unknown): LiveFulfillmentAvailability[] {
  return array(value)
    .map(record)
    .filter((v): v is UnknownRecord => v != null)
    .map((v) => ({
      source: "attributes" as const,
      fulfillment_channel_code: stringValue(
        v.fulfillment_channel_code ?? v.fulfillmentChannelCode,
      ),
      quantity: numberValue(v.quantity),
    }));
}

/** Flatten a raw Listings Items response without trusting any local DB status. */
export function extractLiveListing(
  raw: unknown,
  now: Date = new Date(),
): LiveListingSnapshot {
  const item = record(raw) ?? {};
  const attrs = record(item.attributes) ?? {};
  const summaries = array(item.summaries)
    .map(record)
    .filter((v): v is UnknownRecord => v != null);
  const summary =
    summaries.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? summaries[0] ?? {};

  const statuses = array(summary.status)
    .map(stringValue)
    .filter((v): v is string => v != null);
  const title =
    firstLocalizedString(attrs.item_name) ?? stringValue(summary.itemName);
  const mainImage =
    imageUrl(attrs.main_product_image_locator) ??
    stringValue(record(summary.mainImage)?.link);
  const gallery = Array.from({ length: 8 }, (_, i) =>
    imageUrl(attrs[`other_product_image_locator_${i + 1}`]),
  ).filter((v): v is string => v != null);

  const offers = array(attrs.purchasable_offer)
    .map((v) => normalizeOffer(v, now))
    .filter((v): v is LiveOffer => v != null);
  const topLevelOffers = array(item.offers)
    .map(normalizeTopLevelOffer)
    .filter((v): v is LiveOffer => v != null);
  const consumer =
    offers.find((offer) => isConsumerAudience(offer.audience)) ??
    topLevelOffers.find((offer) => isConsumerAudience(offer.audience)) ??
    offers.find((offer) => !isBusinessAudience(offer.audience)) ??
    null;
  const separateDiscount = schedulePrice(
    attrs.discounted_price ?? attrs.sale_price,
    now,
  );
  const consumerWithDiscount = consumer
    ? {
        ...consumer,
        discounted_price: consumer.discounted_price ?? separateDiscount,
      }
    : null;
  const businessOffers = dedupeOffers(
    [...offers, ...topLevelOffers].filter((offer) =>
      isBusinessAudience(offer.audience),
    ),
  );

  const issues = array(item.issues)
    .map(record)
    .filter((v): v is UnknownRecord => v != null)
    .map((issue) => ({
      code: stringValue(issue.code),
      severity: stringValue(issue.severity),
      message: stringValue(issue.message),
      attribute_names: array(issue.attributeNames ?? issue.attribute_names)
        .map(stringValue)
        .filter((v): v is string => v != null),
      categories: array(issue.categories)
        .map(stringValue)
        .filter((v): v is string => v != null),
    }));

  const parsedTitleCount = title ? parseTotal(title) : -1;
  return {
    fetched: true,
    error: null,
    asin: stringValue(summary.asin),
    amazon_statuses: statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    product_type: stringValue(summary.productType),
    title,
    title_total_units: parsedTitleCount > 0 ? parsedTitleCount : null,
    bullets: localizedStrings(attrs.bullet_point),
    description: firstLocalizedString(attrs.product_description),
    brand: firstLocalizedString(attrs.brand),
    category:
      firstLocalizedString(attrs.item_type_name) ??
      firstLocalizedString(attrs.item_type_keyword),
    browse_nodes: localizedStrings(attrs.recommended_browse_nodes),
    item_type_keywords: localizedStrings(attrs.item_type_keyword),
    main_image_url: mainImage,
    gallery_image_urls: gallery,
    unit_count: firstLocalizedNumber(attrs.unit_count),
    number_of_items: firstLocalizedNumber(attrs.number_of_items),
    consumer_offer: consumerWithDiscount,
    business_offers: businessOffers,
    separate_business_price: schedulePrice(attrs.business_price, now),
    fulfillment_availability: [
      ...attributeAvailability(attrs.fulfillment_availability),
      ...topLevelAvailability(item.fulfillmentAvailability),
    ],
    issues,
    raw_attributes: attrs,
    raw_offers: item.offers ?? null,
  };
}

export function failedLiveListing(error: unknown): LiveListingSnapshot {
  return {
    fetched: false,
    error: error instanceof Error ? error.message : String(error),
    asin: null,
    amazon_statuses: [],
    buyable: false,
    discoverable: false,
    product_type: null,
    title: null,
    title_total_units: null,
    bullets: [],
    description: null,
    brand: null,
    category: null,
    browse_nodes: [],
    item_type_keywords: [],
    main_image_url: null,
    gallery_image_urls: [],
    unit_count: null,
    number_of_items: null,
    consumer_offer: null,
    business_offers: [],
    separate_business_price: null,
    fulfillment_availability: [],
    issues: [],
    raw_attributes: {},
    raw_offers: null,
  };
}

function normalizedComponent(component: RecipeComponentSnapshot): RecipeComponentSnapshot {
  return {
    ...component,
    product_name: component.product_name.trim(),
    brand: component.brand?.trim() || null,
    flavor: component.flavor?.trim() || null,
    qty: Number.isFinite(component.qty) ? Math.round(component.qty) : 0,
  };
}

function componentSignature(components: RecipeComponentSnapshot[]): string | null {
  return components.length
    ? components
        .map((component) =>
          `${normalizeText(component.flavor ?? component.product_name)}:${component.qty}`,
        )
        .sort()
        .join("|")
    : null;
}

export function buildCanonicalRecipe(db: LedgerDbSnapshot): CanonicalRecipe {
  const selected = db.draft?.selected_variant?.composition ?? [];
  const draftComponents = db.draft?.components ?? [];
  const masterComponents = db.master.components ?? [];
  let source: CanonicalRecipe["composition_source"] = "MISSING";
  let components: RecipeComponentSnapshot[] = [];
  if (selected.length) {
    source = "SELECTED_VARIANT";
    components = selected;
  } else if (draftComponents.length) {
    source = "DRAFT_COMPONENTS";
    components = draftComponents;
  } else if (masterComponents.length) {
    source = "MASTER_COMPONENTS";
    components = masterComponents;
  }
  components = components.map(normalizedComponent);
  const sum = components.reduce((total, component) => total + component.qty, 0);
  const signature = componentSignature(components);
  return {
    total_units: db.master.pack_count,
    composition_source: source,
    components,
    component_qty_sum: sum,
    composition_signature: signature,
    pricing: priceFor(db.master.pack_count),
  };
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedFlavor(value: string): string {
  return normalizeText(value)
    .replace(/\b(?:spread|each|flavou?r|sandwich(?:es)?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => normalizeText(value) === normalizeText(b[index]));
}

function dollarsEqual(a: number | null, b: number | null, tolerance = 0.011): boolean {
  return a != null && b != null && Math.abs(a - b) < tolerance;
}

function anomaly(
  code: string,
  severity: LedgerSeverity,
  message: string,
  expected?: unknown,
  actual?: unknown,
): LedgerAnomaly {
  return { code, severity, message, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) };
}

function expectedChannelContent(db: LedgerDbSnapshot): {
  title: string;
  bullets: string[];
  description: string;
} {
  return {
    title: db.channel_sku.title,
    bullets: db.channel_sku.bullets,
    description: db.channel_sku.description,
  };
}

/** Reconcile one DB record with its live marketplace record. */
export function assessLedgerRow(
  db: LedgerDbSnapshot,
  live: LiveListingSnapshot | null,
): LedgerRow {
  const canonical = buildCanonicalRecipe(db);
  const problems: LedgerAnomaly[] = [];
  const expected = expectedChannelContent(db);
  const expectedCount = canonical.total_units;
  const pricing = canonical.pricing;

  if (!db.master.components.length) {
    problems.push(
      anomaly(
        "MASTER_COMPONENTS_MISSING",
        "ERROR",
        "MasterBundle has no persisted BundleComponent recipe rows.",
        ">=1",
        0,
      ),
    );
  } else {
    const masterSum = db.master.components.reduce(
      (sum, component) => sum + component.qty,
      0,
    );
    if (masterSum !== expectedCount) {
      problems.push(
        anomaly(
          "MASTER_COMPONENT_QTY_MISMATCH",
          "CRITICAL",
          "Persisted MasterBundle components do not sum to MasterBundle.pack_count.",
          expectedCount,
          masterSum,
        ),
      );
    }
    if (
      canonical.composition_signature &&
      componentSignature(db.master.components) !== canonical.composition_signature
    ) {
      problems.push(
        anomaly(
          "MASTER_RECIPE_DRIFT",
          "CRITICAL",
          "Persisted MasterBundle components differ from the selected canonical variation.",
          canonical.composition_signature,
          componentSignature(db.master.components),
        ),
      );
    }
  }
  if (!db.draft) {
    problems.push(
      anomaly("DRAFT_MISSING", "ERROR", "MasterBundle has no linked BundleDraft snapshot."),
    );
  } else {
    const draftSum = db.draft.components.reduce(
      (sum, component) => sum + component.qty,
      0,
    );
    if (db.draft.components.length && draftSum !== expectedCount) {
      problems.push(
        anomaly(
          "DRAFT_COMPONENT_QTY_MISMATCH",
          "CRITICAL",
          "BundleDraft component quantities do not sum to MasterBundle.pack_count.",
          expectedCount,
          draftSum,
        ),
      );
    }
    if (
      db.draft.selected_variant?.composition.length &&
      db.draft.components.length &&
      componentSignature(db.draft.selected_variant.composition) !==
        componentSignature(db.draft.components)
    ) {
      problems.push(
        anomaly(
          "DRAFT_VARIATION_RECIPE_DRIFT",
          "CRITICAL",
          "Draft components differ from its selected variation composition.",
          componentSignature(db.draft.selected_variant.composition),
          componentSignature(db.draft.components),
        ),
      );
    }
    const generated = db.draft.generated_content.find(
      (content) => content.channel === db.channel_sku.channel,
    );
    if (!generated) {
      problems.push(
        anomaly(
          "GENERATED_CONTENT_MISSING",
          "ERROR",
          "No GeneratedContent row exists for this channel.",
          db.channel_sku.channel,
          null,
        ),
      );
    } else {
      if (
        normalizeText(generated.title) !== normalizeText(db.channel_sku.title) ||
        !arraysEqual(generated.bullets, db.channel_sku.bullets) ||
        normalizeText(generated.description) !==
          normalizeText(db.channel_sku.description)
      ) {
        problems.push(
          anomaly(
            "GENERATED_CHANNELSKU_CONTENT_DRIFT",
            "WARNING",
            "GeneratedContent and the publish-source ChannelSKU text have diverged.",
          ),
        );
      }
      if (
        generated.main_image_url &&
        generated.main_image_url !== db.channel_sku.main_image_url
      ) {
        problems.push(
          anomaly(
            "GENERATED_IMAGE_NOT_PROMOTED_TO_CHANNELSKU",
            "ERROR",
            "GeneratedContent has a different main image URL than ChannelSKU; republish may resend the stale image.",
            generated.main_image_url,
            db.channel_sku.main_image_url,
          ),
        );
      }
    }
  }
  if (!db.channel_sku.main_image_url) {
    problems.push(
      anomaly(
        "DB_MAIN_IMAGE_MISSING",
        "ERROR",
        "ChannelSKU, the Amazon publish source, has no main image URL.",
      ),
    );
  }
  if (!canonical.components.length) {
    problems.push(
      anomaly("CANONICAL_COMPOSITION_MISSING", "CRITICAL", "No selected variation, draft recipe, or master recipe is available."),
    );
  } else if (canonical.component_qty_sum !== expectedCount) {
    problems.push(
      anomaly(
        "RECIPE_COUNT_MISMATCH",
        "CRITICAL",
        "Canonical component quantities do not sum to MasterBundle.pack_count.",
        expectedCount,
        canonical.component_qty_sum,
      ),
    );
  }
  if (db.draft && db.draft.pack_count !== expectedCount) {
    problems.push(
      anomaly(
        "DRAFT_MASTER_COUNT_MISMATCH",
        "CRITICAL",
        "BundleDraft.pack_count differs from MasterBundle.pack_count.",
        expectedCount,
        db.draft.pack_count,
      ),
    );
  }
  if (db.channel_sku.price_cents !== (pricing ? Math.round(pricing.suggested * 100) : db.channel_sku.price_cents)) {
    problems.push(
      anomaly(
        "DB_PRICE_OFF_CANONICAL",
        "WARNING",
        "ChannelSKU cached price differs from the explicit-count cost model.",
        pricing?.suggested ?? null,
        db.channel_sku.price_cents / 100,
      ),
    );
  }

  if (live) {
    if (!live.fetched) {
      const notFound = /\b404\b|not.?found/i.test(live.error ?? "");
      problems.push(
        anomaly(
          notFound ? "AMAZON_LISTING_NOT_FOUND" : "AMAZON_FETCH_FAILED",
          notFound ? "CRITICAL" : "ERROR",
          live.error ?? "Amazon listing read failed.",
        ),
      );
    } else {
      if (!live.buyable) {
        problems.push(
          anomaly("NOT_BUYABLE", "CRITICAL", "Amazon does not report BUYABLE status.", "BUYABLE", live.amazon_statuses),
        );
      }
      if (!live.discoverable) {
        problems.push(
          anomaly("NOT_DISCOVERABLE", "ERROR", "Amazon does not report DISCOVERABLE status.", "DISCOVERABLE", live.amazon_statuses),
        );
      }
      if (db.channel_sku.asin && live.asin && db.channel_sku.asin !== live.asin) {
        problems.push(
          anomaly("ASIN_MISMATCH", "CRITICAL", "DB ASIN differs from the live Amazon ASIN.", db.channel_sku.asin, live.asin),
        );
      }
      if (!db.channel_sku.asin) {
        problems.push(
          anomaly(
            "DB_ASIN_MISSING",
            "WARNING",
            "ChannelSKU has no cached ASIN even though live Amazon is authoritative.",
            live.asin,
            null,
          ),
        );
      }
      if (!live.asin) {
        problems.push(anomaly("LIVE_ASIN_MISSING", "CRITICAL", "Amazon summary has no ASIN."));
      }
      if (live.title_total_units !== expectedCount) {
        problems.push(
          anomaly("TITLE_COUNT_MISMATCH", "CRITICAL", "Live title implies a different total count than the canonical recipe.", expectedCount, live.title_total_units),
        );
      }
      const liveTitle = normalizeText(live.title);
      const contentText = normalizeText(
        [live.title, ...live.bullets, live.description].filter(Boolean).join(" "),
      );
      for (const flavor of new Set(
        canonical.components
          .map((component) => component.flavor)
          .filter((value): value is string => value != null)
          .map(normalizedFlavor)
          .filter(Boolean),
      )) {
        if (!liveTitle.includes(flavor)) {
          problems.push(
            anomaly(
              "TITLE_FLAVOR_MISSING",
              "CRITICAL",
              `Canonical flavor is absent from the live title: ${flavor}.`,
              flavor,
              live.title,
            ),
          );
        }
        if (!contentText.includes(flavor)) {
          problems.push(
            anomaly(
              "CONTENT_FLAVOR_MISSING",
              "CRITICAL",
              `Canonical flavor is absent from all live text content: ${flavor}.`,
              flavor,
              null,
            ),
          );
        }
      }
      if (live.unit_count !== expectedCount) {
        problems.push(
          anomaly("UNIT_COUNT_MISMATCH", "CRITICAL", "Amazon unit_count differs from MasterBundle.pack_count.", expectedCount, live.unit_count),
        );
      }
      if (live.number_of_items !== expectedCount) {
        problems.push(
          anomaly("NUMBER_OF_ITEMS_MISMATCH", "ERROR", "Amazon number_of_items differs from MasterBundle.pack_count.", expectedCount, live.number_of_items),
        );
      }
      if (normalizeText(live.brand) !== "uncrustables") {
        problems.push(
          anomaly("BRAND_MISMATCH", "CRITICAL", "Live brand is not the required Uncrustables brand.", "Uncrustables", live.brand),
        );
      }
      if (!/^(GROCERY|FOOD|SNACK_FOOD)$/i.test(live.product_type ?? "")) {
        problems.push(
          anomaly("PRODUCT_TYPE_UNEXPECTED", "WARNING", "Live Amazon product type is outside the supported food product types.", ["GROCERY", "FOOD", "SNACK_FOOD"], live.product_type),
        );
      }
      if (normalizeText(live.title) !== normalizeText(expected.title)) {
        problems.push(
          anomaly("TITLE_DB_LIVE_DRIFT", "WARNING", "Live title differs from the channel/generated content snapshot.", expected.title, live.title),
        );
      }
      if (!arraysEqual(live.bullets, expected.bullets)) {
        problems.push(
          anomaly("BULLETS_DB_LIVE_DRIFT", "WARNING", "Live bullets differ from the channel/generated content snapshot.", expected.bullets, live.bullets),
        );
      }
      if (normalizeText(live.description) !== normalizeText(expected.description)) {
        problems.push(
          anomaly("DESCRIPTION_DB_LIVE_DRIFT", "WARNING", "Live description differs from the channel/generated content snapshot.", expected.description, live.description),
        );
      }
      if ((live.title?.length ?? 0) > 200) {
        problems.push(
          anomaly("TITLE_TOO_LONG", "ERROR", "Live title exceeds the Amazon 200-character limit.", "<=200", live.title?.length ?? 0),
        );
      }
      if (live.bullets.length < 5 || live.bullets.length > 10) {
        problems.push(
          anomaly("BULLET_COUNT_OUTSIDE_FACTORY_STANDARD", "ERROR", "Live listing must carry 4-9 generated bullets plus the required disclaimer (5-10 total).", "5-10", live.bullets.length),
        );
      }
      if (!live.description || live.description.length > 2000) {
        problems.push(
          anomaly("DESCRIPTION_LENGTH_INVALID", "ERROR", "Live description must be non-empty and no longer than 2,000 characters.", "1-2000", live.description?.length ?? 0),
        );
      }
      if (!live.main_image_url) {
        problems.push(anomaly("MAIN_IMAGE_MISSING", "CRITICAL", "Live listing has no main image."));
      } else if (
        db.channel_sku.main_image_url &&
        live.main_image_url !== db.channel_sku.main_image_url &&
        !isAmazonMediaUrl(live.main_image_url)
      ) {
        problems.push(
          anomaly(
            "MAIN_IMAGE_DB_LIVE_DRIFT",
            "ERROR",
            "Live Amazon main image differs from the ChannelSKU publish source.",
            db.channel_sku.main_image_url,
            live.main_image_url,
          ),
        );
      }
      if (
        live.gallery_image_urls[0] !== BRAND_CARD_COLD_CHAIN_URL &&
        !VERIFIED_BRAND_CARD_REHOST_URLS.has(live.gallery_image_urls[0] ?? "")
      ) {
        const slotOne = live.gallery_image_urls[0] ?? null;
        if (slotOne && REJECTED_BRAND_CARD_REHOST_URLS.has(slotOne)) {
          problems.push(
            anomaly(
              "PRICE_INFOGRAPHIC_NOT_IN_SLOT_1",
              "ERROR",
              "The first secondary image was visually verified as a different asset, not the required pricing/thank-you infographic.",
              BRAND_CARD_COLD_CHAIN_URL,
              slotOne,
            ),
          );
        } else if (slotOne && isAmazonMediaUrl(slotOne)) {
          problems.push(
            anomaly(
              "PRICE_INFOGRAPHIC_IDENTITY_UNVERIFIED",
              "WARNING",
              "Amazon re-hosted gallery slot 1; URL-only audit cannot prove that it is the fixed pricing/thank-you infographic.",
              BRAND_CARD_COLD_CHAIN_URL,
              slotOne,
            ),
          );
        } else {
          problems.push(
            anomaly(
              "PRICE_INFOGRAPHIC_NOT_IN_SLOT_1",
              "ERROR",
              "The fixed cold-chain pricing/thank-you infographic is not the first secondary image.",
              BRAND_CARD_COLD_CHAIN_URL,
              slotOne,
            ),
          );
        }
      }
      if (live.gallery_image_urls.length < 5) {
        problems.push(
          anomaly(
            "GALLERY_TOO_SHORT",
            "ERROR",
            "Listing needs the fixed infographic plus at least four additional secondary images.",
            ">=5 secondary images",
            live.gallery_image_urls.length,
          ),
        );
      }

      const offer = live.consumer_offer;
      if (!offer) {
        problems.push(anomaly("CONSUMER_OFFER_MISSING", "CRITICAL", "Live purchasable_offer has no consumer offer."));
      } else if (pricing) {
        if (!dollarsEqual(offer.our_price, pricing.suggested)) {
          problems.push(
            anomaly("OUR_PRICE_MISMATCH", "CRITICAL", "Live base price differs from the canonical .99 price.", pricing.suggested, offer.our_price),
          );
        }
        if (!dollarsEqual(offer.minimum_seller_allowed_price, pricing.floor)) {
          problems.push(
            anomaly("MIN_PRICE_MISMATCH", "ERROR", "Live minimum seller allowed price differs from the canonical floor.", pricing.floor, offer.minimum_seller_allowed_price),
          );
        }
        if (!dollarsEqual(offer.maximum_seller_allowed_price, pricing.suggested)) {
          problems.push(
            anomaly("MAX_PRICE_MISMATCH", "ERROR", "Live maximum seller allowed price differs from the canonical .99 ceiling.", pricing.suggested, offer.maximum_seller_allowed_price),
          );
        }
        if (offer.discounted_price != null && offer.discounted_price < pricing.floor) {
          problems.push(
            anomaly("DISCOUNT_BELOW_FLOOR", "CRITICAL", "Active discounted price is below the canonical cost floor.", `>=${pricing.floor}`, offer.discounted_price),
          );
        }
      }

      if (pricing) {
        const businessPrices = [
          ...live.business_offers.map((offer) => offer.our_price),
          live.separate_business_price,
        ].filter((v): v is number => v != null);
        if (!businessPrices.length) {
          problems.push(anomaly("BUSINESS_PRICE_MISSING", "WARNING", "No live business price offer was found."));
        } else if (businessPrices.some((value) => !dollarsEqual(value, pricing.suggested))) {
          problems.push(
            anomaly("BUSINESS_PRICE_MISMATCH", "ERROR", "At least one business price differs from the canonical base price.", pricing.suggested, businessPrices),
          );
        }
      }

      const quantities = live.fulfillment_availability
        .map((v) => v.quantity)
        .filter((v): v is number => v != null);
      if (!quantities.length) {
        problems.push(anomaly("FULFILLMENT_QUANTITY_MISSING", "ERROR", "Amazon fulfillment availability has no quantity."));
      } else if (quantities.includes(100)) {
        problems.push(
          anomaly("FULFILLMENT_QUANTITY_HARDCODED_100", "WARNING", "Live quantity is the Bundle Factory hard-coded value rather than verified inventory.", "verified inventory", quantities),
        );
      }

      for (const issue of live.issues) {
        const severity = (issue.severity ?? "").toUpperCase();
        if (severity === "ERROR") {
          problems.push(
            anomaly("AMAZON_ISSUE_ERROR", "CRITICAL", issue.message ?? "Amazon returned an ERROR issue.", undefined, issue),
          );
        } else if (severity === "WARNING") {
          problems.push(
            anomaly("AMAZON_ISSUE_WARNING", "WARNING", issue.message ?? "Amazon returned a WARNING issue.", undefined, issue),
          );
        }
      }

      const dbClaimsLive = db.channel_sku.listing_status === "LIVE";
      if (dbClaimsLive !== live.buyable) {
        problems.push(
          anomaly("DB_LISTING_STATUS_STALE", "INFO", "DB listing_status disagrees with the live BUYABLE result; live Amazon status is authoritative.", live.buyable ? "LIVE/BUYABLE" : "not BUYABLE", db.channel_sku.listing_status),
        );
      }
    }
  }

  const anomalies = dedupeAnomalies(problems);
  const highest = anomalies.reduce<LedgerSeverity | "NONE">(
    (current, value) =>
      SEVERITY_RANK[value.severity] > SEVERITY_RANK[current]
        ? value.severity
        : current,
    "NONE",
  );
  return {
    sku: db.channel_sku.sku,
    asin: live?.asin ?? db.channel_sku.asin,
    channel: db.channel_sku.channel,
    store_index: db.channel_sku.store_index,
    canonical,
    db,
    live,
    anomalies,
    highest_severity: highest,
    perfect: live != null && anomalies.length === 0,
  };
}

function dedupeAnomalies(values: LedgerAnomaly[]): LedgerAnomaly[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.code}\u0000${JSON.stringify(value.actual ?? null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Add catalog-level collisions that cannot be detected from one row alone. */
export function addCatalogAnomalies(rows: LedgerRow[]): LedgerRow[] {
  const asinToSkus = new Map<string, string[]>();
  const recipeToSkus = new Map<string, string[]>();
  for (const row of rows) {
    if (row.live?.fetched && row.live.asin) {
      asinToSkus.set(row.live.asin, [...(asinToSkus.get(row.live.asin) ?? []), row.sku]);
    }
    const signature = row.canonical.composition_signature;
    if (signature) {
      recipeToSkus.set(signature, [...(recipeToSkus.get(signature) ?? []), row.sku]);
    }
  }

  return rows.map((row) => {
    const extra: LedgerAnomaly[] = [];
    if (row.live?.asin) {
      const skus = asinToSkus.get(row.live.asin) ?? [];
      if (skus.length > 1) {
        extra.push(
          anomaly("DUPLICATE_LIVE_ASIN", "CRITICAL", "Multiple Bundle Factory SKUs resolve to the same live ASIN.", "one SKU per ASIN", skus),
        );
      }
    }
    if (row.canonical.composition_signature) {
      const skus = recipeToSkus.get(row.canonical.composition_signature) ?? [];
      if (skus.length > 1) {
        extra.push(
          anomaly("DUPLICATE_RECIPE", "ERROR", "Multiple SKUs have the same normalized flavor/quantity recipe.", "one SKU per canonical recipe", skus),
        );
      }
    }
    if (!extra.length) return row;
    const anomalies = dedupeAnomalies([...row.anomalies, ...extra]);
    const highest = anomalies.reduce<LedgerSeverity | "NONE">(
      (current, value) =>
        SEVERITY_RANK[value.severity] > SEVERITY_RANK[current]
          ? value.severity
          : current,
      "NONE",
    );
    return {
      ...row,
      anomalies,
      highest_severity: highest,
      perfect: row.live != null && anomalies.length === 0,
    };
  });
}

export function summarizeLedger(rows: LedgerRow[]): LedgerSummary {
  const anomalyCounts: Record<string, number> = {};
  const severityCounts: Record<LedgerSeverity, number> = {
    CRITICAL: 0,
    ERROR: 0,
    WARNING: 0,
    INFO: 0,
  };
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[String(row.canonical.total_units)] =
      (counts[String(row.canonical.total_units)] ?? 0) + 1;
    for (const problem of row.anomalies) {
      anomalyCounts[problem.code] = (anomalyCounts[problem.code] ?? 0) + 1;
      severityCounts[problem.severity]++;
    }
  }
  return {
    rows: rows.length,
    live_fetch_succeeded: rows.filter((row) => row.live?.fetched).length,
    live_fetch_failed: rows.filter((row) => row.live && !row.live.fetched).length,
    buyable: rows.filter((row) => row.live?.buyable).length,
    discoverable: rows.filter((row) => row.live?.discoverable).length,
    perfect: rows.filter((row) => row.perfect).length,
    with_critical: rows.filter((row) => row.anomalies.some((a) => a.severity === "CRITICAL")).length,
    with_error: rows.filter((row) => row.anomalies.some((a) => a.severity === "ERROR")).length,
    with_warning: rows.filter((row) => row.anomalies.some((a) => a.severity === "WARNING")).length,
    with_info_only: rows.filter(
      (row) => row.anomalies.length > 0 && row.anomalies.every((a) => a.severity === "INFO"),
    ).length,
    anomaly_counts: Object.fromEntries(Object.entries(anomalyCounts).sort(([a], [b]) => a.localeCompare(b))),
    severity_counts: severityCounts,
    canonical_count_distribution: Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  };
}
