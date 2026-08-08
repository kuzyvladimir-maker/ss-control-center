import { createHash } from "node:crypto";

import type {
  ProductTruthWalmartRequestCandidateDiagnostic,
} from "@/lib/sourcing/product-truth-read-contract";
import {
  DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
} from "@/lib/sourcing/product-truth-read-contract";

export const WALMART_STUDIO_DRAFT_WORK_ITEM_SCHEMA =
  "bundle-factory.walmart-draft-work-item/1.0.0" as const;
export const WALMART_STUDIO_DRAFT_BRIEF_SCHEMA =
  "bundle-factory.walmart-draft-brief/1.0.0" as const;

/**
 * One exact product inside a listing, and how many of it are in the box.
 *
 * A listing used to be one product, so the work item named it directly. A mixed
 * assortment — "2 flavors, 4 cans each" — needs several, and dropping that part
 * of the request is how twenty listings of the wrong thing get built.
 */
export interface WalmartStudioDraftComponent {
  donor_product_id: string;
  canonical_variant_id: string;
  content_observation_id: string;
  price_observation_id: string;
  title_at_admission: string;
  /** Retail units of THIS product in one listing. */
  quantity: number;
}

export interface WalmartStudioDraftWorkItem {
  schema_version: typeof WALMART_STUDIO_DRAFT_WORK_ITEM_SCHEMA;
  work_item_sha256: string;
  spec_index: number;
  donor_product_id: string;
  canonical_variant_id: string;
  content_observation_id: string;
  price_observation_id: string;
  title_at_admission: string;
  /**
   * Everything in the box, in order. Always at least one entry, and the first
   * mirrors the singular fields above so readers that only understand a single
   * product keep working. Quantities sum to pack_count.
   */
  components: WalmartStudioDraftComponent[];
  pack_count: number;
  store_index: number;
  shipping_template_id: string;
  shipping_template_sha256: string;
  target_margin_bps: number;
  as_of: string;
  price_max_age_ms: number;
  zip: string;
  marketplace_mutation_allowed: false;
  upc_reservation_allowed: false;
}

export interface WalmartStudioDraftBrief {
  studio_version: number;
  workflow: "CANONICAL_WALMART_NEW_SKU";
  draft_schema_version: typeof WALMART_STUDIO_DRAFT_BRIEF_SCHEMA;
  source: "prompt";
  prompt: string;
  channel: "WALMART";
  listing_count: number;
  pack_count: number;
  target_margin_pct: number;
  photo_strategy: "reuse-donor";
  walmart_shipping: {
    store_index: number;
    account_name: string;
    selected_at: string;
    template: Record<string, unknown>;
  };
  product_truth_admission: {
    as_of: string;
    price_max_age_ms: number;
    zip: string;
    matched_variants: number;
    ready_variants: number;
  };
  pricing_inputs: {
    packaging_cost_cents: number;
    shipping_label_cents: number;
    referral_fee_bps: number;
    target_margin_bps: number;
  };
  execution_work_items: WalmartStudioDraftWorkItem[];
  operator_contract: {
    engine: "walmart-studio-draft-engine";
    marketplace_mutation_authorized: false;
    upc_reservation_authorized: false;
    next_step: string;
  };
}

export class WalmartStudioDraftContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartStudioDraftContractError";
    this.code = code;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableWalmartStudioDraftJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableWalmartStudioDraftJson(value))
    .digest("hex");
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      `${label} is required`,
    );
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      `${label} must be a whole number from 1 to ${maximum}`,
    );
  }
  return Number(value);
}

function hashPayload(item: Record<string, unknown>): string {
  return sha256(item);
}

/**
 * The contents of one listing.
 *
 * A work item written before mixed assortments existed has no `components`; it
 * is read as the single product its singular fields already describe, so old
 * sealed briefs keep their exact meaning.
 */
/**
 * The exact bytes a work item is sealed over.
 *
 * `components` is deliberately absent when the listing is the plain
 * single-product multipack this lane always built: every work item sealed
 * before mixed assortments existed was hashed without that field, and adding it
 * to the digest would make each of them fail as "bytes changed after
 * admission". A mix has no such history, so it seals over its components and
 * cannot be altered afterwards either.
 */
function sealShape(
  item: Omit<WalmartStudioDraftWorkItem, "work_item_sha256">,
): Record<string, unknown> {
  // "Plain" means the components array says nothing the singular fields do not
  // already say. Comparing only the canonical variant was a hole: an admitted
  // item could have its donor, its content observation and its price
  // observation swapped for a different source that resolves to the same
  // variant, and the seal would still verify. Every field the engine actually
  // reads has to match.
  const only = item.components.length === 1 ? item.components[0] : null;
  const plainMultipack = only !== null
    && only.quantity === item.pack_count
    && only.canonical_variant_id === item.canonical_variant_id
    && only.donor_product_id === item.donor_product_id
    && only.content_observation_id === item.content_observation_id
    && only.price_observation_id === item.price_observation_id
    && only.title_at_admission === item.title_at_admission;
  if (!plainMultipack) return item as unknown as Record<string, unknown>;
  const { components: _components, ...rest } = item;
  void _components;
  return rest as unknown as Record<string, unknown>;
}

function parseComponents(raw: Record<string, unknown>): WalmartStudioDraftComponent[] {
  const packCount = positiveInteger(raw.pack_count, "pack_count", 500);
  if (raw.components === undefined || raw.components === null) {
    return [{
      donor_product_id: requiredText(raw.donor_product_id, "donor_product_id"),
      canonical_variant_id: requiredText(raw.canonical_variant_id, "canonical_variant_id"),
      content_observation_id: requiredText(raw.content_observation_id, "content_observation_id"),
      price_observation_id: requiredText(raw.price_observation_id, "price_observation_id"),
      title_at_admission: requiredText(raw.title_at_admission, "title_at_admission"),
      quantity: packCount,
    }];
  }
  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      "components must be a non-empty array",
    );
  }
  const seen = new Set<string>();
  const components = raw.components.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WalmartStudioDraftContractError(
        "WORK_ITEM_INVALID",
        `component ${index} must be an object`,
      );
    }
    const row = entry as Record<string, unknown>;
    const variantId = requiredText(row.canonical_variant_id, "canonical_variant_id");
    // The same product twice is two entries that should have been one, and it
    // would double-count in the price and read as two flavors on the listing.
    if (seen.has(variantId)) {
      throw new WalmartStudioDraftContractError(
        "WORK_ITEM_INVALID",
        `component ${variantId} appears twice in one listing`,
      );
    }
    seen.add(variantId);
    return {
      donor_product_id: requiredText(row.donor_product_id, "donor_product_id"),
      canonical_variant_id: variantId,
      content_observation_id: requiredText(row.content_observation_id, "content_observation_id"),
      price_observation_id: requiredText(row.price_observation_id, "price_observation_id"),
      title_at_admission: requiredText(row.title_at_admission, "title_at_admission"),
      quantity: positiveInteger(row.quantity, "quantity", 500),
    };
  });
  const total = components.reduce((sum, entry) => sum + entry.quantity, 0);
  if (total !== packCount) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      `components hold ${total} units but pack_count says ${packCount}`,
    );
  }
  const primary = components[0];
  const disagreement = [
    ["canonical_variant_id", primary.canonical_variant_id],
    ["donor_product_id", primary.donor_product_id],
    ["content_observation_id", primary.content_observation_id],
    ["price_observation_id", primary.price_observation_id],
    ["title_at_admission", primary.title_at_admission],
  ].find(([field, value]) => value !== requiredText(raw[field], field));
  if (disagreement) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      `the first component must be the work item's primary product; ${disagreement[0]} differs`,
    );
  }
  return components;
}

export function parseWalmartStudioDraftWorkItem(
  value: unknown,
): WalmartStudioDraftWorkItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      "Walmart draft work item must be an object",
    );
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== WALMART_STUDIO_DRAFT_WORK_ITEM_SCHEMA) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_SCHEMA_UNSUPPORTED",
      "Walmart draft work-item schema is unsupported",
    );
  }
  const asOf = requiredText(raw.as_of, "as_of");
  if (!Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      "as_of must be a canonical UTC instant",
    );
  }
  const withoutHash: Omit<WalmartStudioDraftWorkItem, "work_item_sha256"> = {
    schema_version: WALMART_STUDIO_DRAFT_WORK_ITEM_SCHEMA,
    spec_index: positiveInteger(Number(raw.spec_index) + 1, "spec_index", 500) - 1,
    donor_product_id: requiredText(raw.donor_product_id, "donor_product_id"),
    canonical_variant_id: requiredText(
      raw.canonical_variant_id,
      "canonical_variant_id",
    ),
    content_observation_id: requiredText(
      raw.content_observation_id,
      "content_observation_id",
    ),
    price_observation_id: requiredText(
      raw.price_observation_id,
      "price_observation_id",
    ),
    title_at_admission: requiredText(raw.title_at_admission, "title_at_admission"),
    components: parseComponents(raw),
    pack_count: positiveInteger(raw.pack_count, "pack_count", 500),
    store_index: positiveInteger(raw.store_index, "store_index", 5),
    shipping_template_id: requiredText(
      raw.shipping_template_id,
      "shipping_template_id",
    ),
    shipping_template_sha256: requiredText(
      raw.shipping_template_sha256,
      "shipping_template_sha256",
    ),
    target_margin_bps: positiveInteger(
      raw.target_margin_bps,
      "target_margin_bps",
      5_000,
    ),
    as_of: asOf,
    // Upper bound follows the owner-approved price-evidence window rather than
    // a second, stricter number kept in a different file (owner decision
    // 2026-08-02: shelf-stable grocery prices stay usable for 90 days).
    price_max_age_ms: positiveInteger(
      raw.price_max_age_ms,
      "price_max_age_ms",
      DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
    ),
    zip: requiredText(raw.zip, "zip"),
    marketplace_mutation_allowed: false,
    upc_reservation_allowed: false,
  };
  if (
    raw.marketplace_mutation_allowed !== false ||
    raw.upc_reservation_allowed !== false
  ) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_AUTHORITY_INVALID",
      "Draft work items cannot authorize Walmart mutation or UPC reservation",
    );
  }
  const workItemSha256 = requiredText(
    raw.work_item_sha256,
    "work_item_sha256",
  );
  if (!/^[a-f0-9]{64}$/.test(workItemSha256)) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_INVALID",
      "work_item_sha256 must be a lowercase SHA-256 digest",
    );
  }
  const expected = hashPayload(sealShape(withoutHash));
  if (workItemSha256 !== expected) {
    throw new WalmartStudioDraftContractError(
      "WORK_ITEM_HASH_MISMATCH",
      "Walmart draft work-item bytes changed after admission",
    );
  }
  return { ...withoutHash, work_item_sha256: expected };
}

export function buildWalmartStudioDraftWorkItems(input: {
  candidates: readonly ProductTruthWalmartRequestCandidateDiagnostic[];
  listingCount: number;
  packCount: number;
  /** Different products per listing. 1 (default) is the plain multipack. */
  flavorsPerListing?: number;
  /** Units of each. Defaults to the whole pack, i.e. one product. */
  unitsPerFlavor?: number;
  storeIndex: number;
  shippingTemplateId: string;
  shippingTemplateSha256: string;
  targetMarginBps: number;
  asOf: string;
  priceMaxAgeMs: number;
  zip: string;
}): WalmartStudioDraftWorkItem[] {
  const listingCount = positiveInteger(
    input.listingCount,
    "listingCount",
    500,
  );
  const flavors = Math.max(1, Math.trunc(input.flavorsPerListing ?? 1));
  const unitsEach = Math.trunc(input.unitsPerFlavor ?? input.packCount);
  if (flavors * unitsEach !== input.packCount) {
    throw new WalmartStudioDraftContractError(
      "PACK_COMPOSITION_INVALID",
      `${flavors} flavors x ${unitsEach} units is ${flavors * unitsEach}, not the requested pack of ${input.packCount}`,
    );
  }

  const ready = input.candidates.filter(
    (entry) => entry.ready && entry.candidate !== null,
  );
  // Each listing consumes `flavors` DISTINCT variants, so a mixed run needs
  // that many times more of them. Saying so up front beats building half a
  // batch and failing on the last listing.
  const needed = listingCount * flavors;
  if (ready.length < needed) {
    throw new WalmartStudioDraftContractError(
      "INSUFFICIENT_READY_VARIANTS",
      `Product Truth has ${ready.length} ready exact variants; ${needed} are required`
      + (flavors > 1 ? ` (${listingCount} listings x ${flavors} flavors)` : ""),
    );
  }

  // One variant is used once across the whole run: repeating it would put the
  // same soup in two listings, which is the duplicate Walmart penalises.
  const seenVariants = new Set<string>();
  const pool: typeof ready = [];
  for (const entry of ready) {
    if (seenVariants.has(entry.canonical_variant_id)) continue;
    seenVariants.add(entry.canonical_variant_id);
    pool.push(entry);
  }
  if (pool.length < needed) {
    throw new WalmartStudioDraftContractError(
      "INSUFFICIENT_DISTINCT_READY_VARIANTS",
      `Product Truth has ${pool.length} distinct ready exact variants; ${needed} are required`,
    );
  }

  const items: WalmartStudioDraftWorkItem[] = [];
  for (let index = 0; index < listingCount; index += 1) {
    const chosen = pool.slice(index * flavors, index * flavors + flavors);
    const components: WalmartStudioDraftComponent[] = chosen.map((entry) => ({
      donor_product_id: entry.donor_product_id,
      canonical_variant_id: entry.canonical_variant_id,
      content_observation_id: entry.candidate!.content_observation_id,
      price_observation_id: entry.candidate!.price_observation_id,
      title_at_admission: entry.title,
      quantity: unitsEach,
    }));
    const primary = components[0];
    const withoutHash: Omit<WalmartStudioDraftWorkItem, "work_item_sha256"> = {
      schema_version: WALMART_STUDIO_DRAFT_WORK_ITEM_SCHEMA,
      spec_index: index,
      donor_product_id: primary.donor_product_id,
      canonical_variant_id: primary.canonical_variant_id,
      content_observation_id: primary.content_observation_id,
      price_observation_id: primary.price_observation_id,
      title_at_admission: primary.title_at_admission,
      components,
      pack_count: input.packCount,
      store_index: input.storeIndex,
      shipping_template_id: input.shippingTemplateId,
      shipping_template_sha256: input.shippingTemplateSha256,
      target_margin_bps: input.targetMarginBps,
      as_of: input.asOf,
      price_max_age_ms: input.priceMaxAgeMs,
      zip: input.zip,
      marketplace_mutation_allowed: false,
      upc_reservation_allowed: false,
    };
    items.push(parseWalmartStudioDraftWorkItem({
      ...withoutHash,
      work_item_sha256: hashPayload(sealShape(withoutHash)),
    }));
  }
  return items;
}

export function parseWalmartStudioDraftBrief(
  value: unknown,
): WalmartStudioDraftBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_INVALID",
      "Walmart draft brief must be an object",
    );
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.workflow !== "CANONICAL_WALMART_NEW_SKU" ||
    raw.channel !== "WALMART" ||
    raw.draft_schema_version !== WALMART_STUDIO_DRAFT_BRIEF_SCHEMA
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_SCHEMA_UNSUPPORTED",
      "GenerationJob does not contain a supported Walmart draft brief",
    );
  }
  if (!Array.isArray(raw.execution_work_items)) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_INVALID",
      "execution_work_items must be an array",
    );
  }
  const items = raw.execution_work_items.map(parseWalmartStudioDraftWorkItem);
  const listingCount = positiveInteger(raw.listing_count, "listing_count", 500);
  const packCount = positiveInteger(raw.pack_count, "pack_count", 500);
  if (items.length !== listingCount) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_ITEM_COUNT_MISMATCH",
      "The sealed work-item count no longer matches listing_count",
    );
  }
  if (
    items.some(
      (item, index) => item.spec_index !== index || item.pack_count !== packCount,
    )
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_ITEM_BINDING_MISMATCH",
      "Work-item order or pack count differs from the sealed brief",
    );
  }
  const shipping = raw.walmart_shipping;
  const pricing = raw.pricing_inputs;
  const admission = raw.product_truth_admission;
  const operator = raw.operator_contract;
  if (
    !shipping || typeof shipping !== "object" || Array.isArray(shipping) ||
    !pricing || typeof pricing !== "object" || Array.isArray(pricing) ||
    !admission || typeof admission !== "object" || Array.isArray(admission) ||
    !operator || typeof operator !== "object" || Array.isArray(operator)
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_INVALID",
      "Walmart draft brief is missing a required sealed section",
    );
  }
  const shippingRecord = shipping as Record<string, unknown>;
  const template = shippingRecord.template;
  const pricingRecord = pricing as Record<string, unknown>;
  const admissionRecord = admission as Record<string, unknown>;
  const operatorRecord = operator as Record<string, unknown>;
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_INVALID",
      "walmart_shipping.template must be an object",
    );
  }
  const templateRecord = template as Record<string, unknown>;
  const storeIndex = positiveInteger(
    shippingRecord.store_index,
    "walmart_shipping.store_index",
    5,
  );
  const templateId = requiredText(templateRecord.id, "template.id");
  const templateSha256 = requiredText(
    templateRecord.template_sha256,
    "template.template_sha256",
  );
  const targetMarginBps = positiveInteger(
    pricingRecord.target_margin_bps,
    "pricing_inputs.target_margin_bps",
    5_000,
  );
  if (
    items.some(
      (item) =>
        item.store_index !== storeIndex ||
        item.shipping_template_id !== templateId ||
        item.shipping_template_sha256 !== templateSha256 ||
        item.target_margin_bps !== targetMarginBps,
    )
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_ITEM_BINDING_MISMATCH",
      "A work item is not bound to the brief's account, template, or margin",
    );
  }
  if (
    operatorRecord.engine !== "walmart-studio-draft-engine" ||
    operatorRecord.marketplace_mutation_authorized !== false ||
    operatorRecord.upc_reservation_authorized !== false
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_AUTHORITY_INVALID",
      "The draft brief cannot grant publication or UPC authority",
    );
  }
  const asOf = requiredText(admissionRecord.as_of, "product_truth_admission.as_of");
  if (
    items.some(
      (item) =>
        item.as_of !== asOf ||
        item.price_max_age_ms !== admissionRecord.price_max_age_ms ||
        item.zip !== admissionRecord.zip,
    )
  ) {
    throw new WalmartStudioDraftContractError(
      "BRIEF_ITEM_BINDING_MISMATCH",
      "A work item is not bound to the Product Truth admission snapshot",
    );
  }
  return {
    ...(raw as unknown as WalmartStudioDraftBrief),
    listing_count: listingCount,
    pack_count: packCount,
    execution_work_items: items,
  };
}
