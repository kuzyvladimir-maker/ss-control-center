import { createHash } from "node:crypto";

import type {
  ListingItem,
  ListingPatch,
} from "../../amazon-sp-api/listings";

export const BASE_OFFER_PRESERVE_PROFILE =
  "AMAZON_BASE_OFFER_PRESERVE_PROMO_V1" as const;
export const BASE_OFFER_PRESERVE_PLAN_SCHEMA =
  "uncrustables-amazon-base-offer-preserve-plan/v1" as const;
export const BASE_OFFER_PRESERVE_SELECTION_SCHEMA =
  "uncrustables-amazon-base-offer-preserve-selection/v1" as const;
export const BASE_OFFER_PATH = "/attributes/purchasable_offer" as const;
export const US_AMAZON_MARKETPLACE_ID = "ATVPDKIKX0DER" as const;

type JsonObject = Record<string, unknown>;

export interface ArtifactRef {
  path: string;
  file_sha256: string;
  embedded_body_sha256?: string | null;
}

export interface PreservedMemberState {
  present: boolean;
  value?: unknown;
  canonical_json: string;
  sha256: string;
}

export interface BaseOfferPreservePlanEntry {
  ordinal: number;
  action_id: string;
  listing_key: string;
  store_index: number;
  sku: string;
  asin: string;
  product_type: string;
  marketplace_id: typeof US_AMAZON_MARKETPLACE_ID;
  mismatch_fields: string[];
  before: {
    purchasable_offer: unknown[];
    purchasable_offer_sha256: string;
    top_level_b2b_offers: unknown[];
    top_level_b2b_offers_sha256: string;
    top_level_b2b_observed_price: number;
    discounted_price: PreservedMemberState;
    list_price: PreservedMemberState;
  };
  actual_patch: ListingPatch;
  validation_preview_patch: ListingPatch;
  simulated_after: {
    purchasable_offer: unknown[];
    purchasable_offer_sha256: string;
    discounted_price: PreservedMemberState;
    list_price: PreservedMemberState;
  };
  preservation_proof: {
    discounted_price_canonical_bytes_equal: true;
    discounted_price_semantically_equal: true;
    list_price_canonical_bytes_equal: true;
    list_price_semantically_equal: true;
  };
  target: {
    regular_base: number;
    minimum: number;
    maximum: number;
    b2b: number;
  };
}

export interface BaseOfferIdentityHold {
  ordinal: number;
  listing_key: string;
  store_index: number;
  sku: string;
  asin: string;
  target_asin: string;
  reason_codes: string[];
  action_id: null;
  patch: null;
}

export interface BaseOfferPreservePlan {
  schema_version: typeof BASE_OFFER_PRESERVE_PLAN_SCHEMA;
  profile: typeof BASE_OFFER_PRESERVE_PROFILE;
  generated_at: string;
  immutable: true;
  offline_only: true;
  external_mutations: 0;
  execution_authorized: false;
  authority: {
    base_offer_execution_owner_gate: "REQUIRED_SEPARATELY";
    promo_v4_reused_as_authority: false;
    coupon_or_sales_price_action_authorized: false;
  };
  contract: {
    exact_path: typeof BASE_OFFER_PATH;
    allowed_all_members: readonly [
      "our_price",
      "minimum_seller_allowed_price",
      "maximum_seller_allowed_price",
    ];
    allowed_b2b_members: readonly ["our_price"];
    forbidden_members: readonly ["discounted_price", "list_price"];
    selector_merge: true;
    sparse_differences_only: true;
    live_write_capability: false;
  };
  sources: {
    price_matrix: ArtifactRef;
    amazon_prechange_snapshot: ArtifactRef;
    channelmax_postwrite: ArtifactRef;
  };
  scope: {
    input_rows: 164;
    action_rows: 161;
    identity_holds: 3;
    unique_skus: 164;
    unique_asins: 164;
  };
  entries: BaseOfferPreservePlanEntry[];
  holds: BaseOfferIdentityHold[];
  body_sha256: string;
}

export interface BaseOfferPreserveSelection {
  schema_version: typeof BASE_OFFER_PRESERVE_SELECTION_SCHEMA;
  profile: typeof BASE_OFFER_PRESERVE_PROFILE;
  generated_at: string;
  immutable: true;
  offline_only: true;
  execution_authorized: false;
  source_plan_body_sha256: string;
  selected_action_ids: string[];
  selected_actions: 161;
  excluded_identity_holds: string[];
  exact_path: typeof BASE_OFFER_PATH;
  forbidden_members: readonly ["discounted_price", "list_price"];
  body_sha256: string;
}

export interface BaseOfferPreviewSet {
  action_id: string;
  actual_merge_patch: ListingPatch;
  validation_preview_patch: ListingPatch;
  simulated_after_purchasable_offer: unknown[];
  simulated_after_sha256: string;
  preservation_proof: BaseOfferPreservePlanEntry["preservation_proof"];
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mustRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function mustArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function mustString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function mustNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function memberState(container: JsonObject, member: string): PreservedMemberState {
  const present = Object.prototype.hasOwnProperty.call(container, member);
  const value = present ? container[member] : undefined;
  const envelope = present ? { present: true, value } : { present: false };
  const canonical = stableJson(envelope);
  return {
    present,
    ...(present ? { value } : {}),
    canonical_json: canonical,
    sha256: sha256(canonical),
  };
}

function topLevelB2BObservation(offers: unknown): {
  offers: unknown[];
  sha256: string;
  observedPrice: number;
} {
  const b2bOffers = mustArray(offers, "top-level listing offers").filter((raw) => {
    if (!isRecord(raw)) return false;
    const audience = isRecord(raw.audience) ? raw.audience.value : undefined;
    return (
      raw.marketplaceId === US_AMAZON_MARKETPLACE_ID &&
      (raw.offerType === "B2B" || audience === "B2B")
    );
  });
  if (b2bOffers.length !== 1) {
    throw new Error(`Expected exactly one top-level B2B offer, got ${b2bOffers.length}.`);
  }
  const offer = mustRecord(b2bOffers[0], "top-level B2B offer");
  const price = mustRecord(offer.price, "top-level B2B offer price");
  const amount = Number(price.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Top-level B2B observed price is invalid.");
  }
  const exact = clone(b2bOffers);
  return {
    offers: exact,
    sha256: sha256(stableJson(exact)),
    observedPrice: amount,
  };
}

function preservedStates(offers: unknown[], attributes: JsonObject): {
  discounted_price: PreservedMemberState;
  list_price: PreservedMemberState;
} {
  const all = offers.find(
    (item) => isRecord(item) && item.audience === "ALL",
  );
  const allRecord = mustRecord(all, "ALL offer selector");
  return {
    discounted_price: memberState(allRecord, "discounted_price"),
    // Amazon list_price is a sibling listing attribute, not an ALL-offer
    // member. Pin it from the full attributes object even though the only
    // allowed patch path is purchasable_offer.
    list_price: memberState(attributes, "list_price"),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function selectorKey(value: JsonObject): string {
  return [value.marketplace_id, value.currency, value.audience]
    .map((part) => String(part ?? ""))
    .join("|");
}

function mergeObject(base: JsonObject, delta: JsonObject): JsonObject {
  const result = clone(base);
  for (const [key, value] of Object.entries(delta)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = mergeObject(result[key] as JsonObject, value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

/** Amazon merge semantics for selector-keyed purchasable_offer arrays. */
export function applySparsePurchasableOfferMerge(
  before: unknown[],
  patchValue: unknown,
): unknown[] {
  const deltas = mustArray(patchValue, "purchasable_offer patch value").map(
    (value, index) => mustRecord(value, `patch selector ${index}`),
  );
  const result = clone(before);
  for (const delta of deltas) {
    const key = selectorKey(delta);
    const index = result.findIndex(
      (candidate) => isRecord(candidate) && selectorKey(candidate) === key,
    );
    if (index < 0) {
      result.push(clone(delta));
    } else {
      result[index] = mergeObject(mustRecord(result[index], "offer selector"), delta);
    }
  }
  return result;
}

function validatePriceSchedule(value: unknown, label: string): void {
  const values = mustArray(value, label);
  if (values.length !== 1) throw new Error(`${label} must have exactly one price item.`);
  const item = mustRecord(values[0], `${label}[0]`);
  if (Object.keys(item).some((key) => key !== "schedule")) {
    throw new Error(`${label} contains an unknown member.`);
  }
  const schedule = mustArray(item.schedule, `${label}[0].schedule`);
  if (schedule.length !== 1) throw new Error(`${label} must have one schedule row.`);
  const row = mustRecord(schedule[0], `${label}[0].schedule[0]`);
  if (Object.keys(row).some((key) => key !== "value_with_tax")) {
    throw new Error(`${label} schedule contains an unknown member.`);
  }
  const price = mustNumber(row.value_with_tax, `${label} value_with_tax`);
  if (price <= 0) throw new Error(`${label} price must be positive.`);
}

/** Fail-closed nested-member validation for the actual mutation payload. */
export function assertBaseOfferPreservePatch(patch: ListingPatch): void {
  if (patch.op !== "merge" || patch.path !== BASE_OFFER_PATH) {
    throw new Error(`Base-offer patch must be merge ${BASE_OFFER_PATH}.`);
  }
  const selectors = mustArray(patch.value, "base-offer patch value");
  if (selectors.length < 1 || selectors.length > 2) {
    throw new Error("Base-offer patch must contain one or two selectors.");
  }
  const seen = new Set<string>();
  for (const [index, raw] of selectors.entries()) {
    const selector = mustRecord(raw, `selector ${index}`);
    for (const forbidden of ["discounted_price", "list_price"] as const) {
      if (Object.prototype.hasOwnProperty.call(selector, forbidden)) {
        throw new Error(`${forbidden} is structurally forbidden in base-offer patches.`);
      }
    }
    if (
      selector.marketplace_id !== US_AMAZON_MARKETPLACE_ID ||
      selector.currency !== "USD" ||
      (selector.audience !== "ALL" && selector.audience !== "B2B")
    ) {
      throw new Error(`selector ${index} has a non-canonical selector identity.`);
    }
    const audience = String(selector.audience);
    if (seen.has(audience)) throw new Error(`Duplicate ${audience} selector.`);
    seen.add(audience);
    const allowed = new Set(
      audience === "ALL"
        ? [
            "marketplace_id",
            "currency",
            "audience",
            "our_price",
            "minimum_seller_allowed_price",
            "maximum_seller_allowed_price",
          ]
        : ["marketplace_id", "currency", "audience", "our_price"],
    );
    const priceMembers = Object.keys(selector).filter(
      (key) => !["marketplace_id", "currency", "audience"].includes(key),
    );
    if (priceMembers.length === 0) {
      throw new Error(`${audience} selector has no changed price member.`);
    }
    for (const key of Object.keys(selector)) {
      if (!allowed.has(key)) throw new Error(`${audience}.${key} is out of scope.`);
      if (selector[key] === null) throw new Error(`${audience}.${key} cannot be null.`);
    }
    for (const key of priceMembers) {
      validatePriceSchedule(selector[key], `${audience}.${key}`);
    }
  }
}

function assertPreserved(
  before: unknown[],
  after: unknown[],
  beforeAttributes: JsonObject,
  afterAttributes: JsonObject,
): BaseOfferPreservePlanEntry["preservation_proof"] {
  const beforeStates = preservedStates(before, beforeAttributes);
  const afterStates = preservedStates(after, afterAttributes);
  for (const member of ["discounted_price", "list_price"] as const) {
    if (
      beforeStates[member].canonical_json !== afterStates[member].canonical_json ||
      beforeStates[member].sha256 !== afterStates[member].sha256 ||
      stableJson(beforeStates[member].value) !== stableJson(afterStates[member].value)
    ) {
      throw new Error(`${member} changed during sparse base-offer simulation.`);
    }
  }
  return {
    discounted_price_canonical_bytes_equal: true,
    discounted_price_semantically_equal: true,
    list_price_canonical_bytes_equal: true,
    list_price_semantically_equal: true,
  };
}

function planBody(plan: BaseOfferPreservePlan): Omit<BaseOfferPreservePlan, "body_sha256"> {
  const body = { ...plan } as Partial<BaseOfferPreservePlan>;
  delete body.body_sha256;
  return body as Omit<BaseOfferPreservePlan, "body_sha256">;
}

function selectionBody(
  selection: BaseOfferPreserveSelection,
): Omit<BaseOfferPreserveSelection, "body_sha256"> {
  const body = { ...selection } as Partial<BaseOfferPreserveSelection>;
  delete body.body_sha256;
  return body as Omit<BaseOfferPreserveSelection, "body_sha256">;
}

export function sealPlan(
  body: Omit<BaseOfferPreservePlan, "body_sha256">,
): BaseOfferPreservePlan {
  return { ...body, body_sha256: sha256(stableJson(body)) };
}

export function assertBaseOfferPreservePlan(
  plan: BaseOfferPreservePlan,
): BaseOfferPreservePlan {
  if (
    plan.schema_version !== BASE_OFFER_PRESERVE_PLAN_SCHEMA ||
    plan.profile !== BASE_OFFER_PRESERVE_PROFILE ||
    plan.body_sha256 !== sha256(stableJson(planBody(plan)))
  ) {
    throw new Error("Base-offer preserve plan schema/profile/seal is invalid.");
  }
  if (
    !plan.offline_only ||
    plan.external_mutations !== 0 ||
    plan.execution_authorized ||
    plan.authority.promo_v4_reused_as_authority ||
    plan.authority.coupon_or_sales_price_action_authorized
  ) {
    throw new Error("Base-offer plan must remain offline and separately gated.");
  }
  if (plan.entries.length !== 161 || plan.holds.length !== 3) {
    throw new Error("Base-offer plan must contain exactly 161 actions and 3 holds.");
  }
  const actions = new Set<string>();
  const skus = new Set<string>();
  for (const entry of plan.entries) {
    if (actions.has(entry.action_id) || skus.has(entry.sku)) {
      throw new Error("Duplicate action or SKU in base-offer plan.");
    }
    actions.add(entry.action_id);
    skus.add(entry.sku);
    assertBaseOfferPreservePatch(entry.actual_patch);
    if (
      entry.validation_preview_patch.op !== "replace" ||
      entry.validation_preview_patch.path !== BASE_OFFER_PATH ||
      stableJson(entry.validation_preview_patch.value) !==
        stableJson(entry.actual_patch.value)
    ) {
      throw new Error(`${entry.action_id} has an invalid preview surrogate.`);
    }
    if (
      entry.before.discounted_price.sha256 !==
        entry.simulated_after.discounted_price.sha256 ||
      entry.before.list_price.sha256 !== entry.simulated_after.list_price.sha256
    ) {
      throw new Error(`${entry.action_id} does not preserve promo/list members.`);
    }
  }
  for (const hold of plan.holds) {
    if (hold.action_id !== null || hold.patch !== null || skus.has(hold.sku)) {
      throw new Error(`${hold.sku} identity hold is not fail-closed.`);
    }
    skus.add(hold.sku);
  }
  if (skus.size !== 164) throw new Error("Base-offer plan SKU scope is not exact.");
  return plan;
}

export function createBaseOfferPreserveSelection(
  plan: BaseOfferPreservePlan,
  generatedAt = plan.generated_at,
): BaseOfferPreserveSelection {
  assertBaseOfferPreservePlan(plan);
  const body: Omit<BaseOfferPreserveSelection, "body_sha256"> = {
    schema_version: BASE_OFFER_PRESERVE_SELECTION_SCHEMA,
    profile: BASE_OFFER_PRESERVE_PROFILE,
    generated_at: generatedAt,
    immutable: true,
    offline_only: true,
    execution_authorized: false,
    source_plan_body_sha256: plan.body_sha256,
    selected_action_ids: plan.entries.map((entry) => entry.action_id),
    selected_actions: 161,
    excluded_identity_holds: plan.holds.map((hold) => hold.sku),
    exact_path: BASE_OFFER_PATH,
    forbidden_members: ["discounted_price", "list_price"],
  };
  return { ...body, body_sha256: sha256(stableJson(body)) };
}

export function assertBaseOfferPreserveSelection(
  plan: BaseOfferPreservePlan,
  selection: BaseOfferPreserveSelection,
): BaseOfferPreserveSelection {
  assertBaseOfferPreservePlan(plan);
  if (
    selection.schema_version !== BASE_OFFER_PRESERVE_SELECTION_SCHEMA ||
    selection.profile !== BASE_OFFER_PRESERVE_PROFILE ||
    selection.body_sha256 !== sha256(stableJson(selectionBody(selection))) ||
    selection.source_plan_body_sha256 !== plan.body_sha256 ||
    !selection.offline_only ||
    selection.execution_authorized
  ) {
    throw new Error("Base-offer preserve selection schema/profile/seal is invalid.");
  }
  const expected = plan.entries.map((entry) => entry.action_id);
  if (
    selection.selected_actions !== 161 ||
    stableJson(selection.selected_action_ids) !== stableJson(expected) ||
    new Set(selection.selected_action_ids).size !== 161 ||
    stableJson(selection.excluded_identity_holds) !==
      stableJson(plan.holds.map((hold) => hold.sku))
  ) {
    throw new Error("Base-offer preserve selection is not the exact plan scope.");
  }
  return selection;
}

function listingAsin(listing: ListingItem): string {
  const summary = listing.summaries?.find(
    (candidate) => candidate.marketplaceId === US_AMAZON_MARKETPLACE_ID,
  );
  return mustString(summary?.asin, "live listing ASIN");
}

export function buildBaseOfferPreservePreviewSet(
  entry: BaseOfferPreservePlanEntry,
  liveListing: ListingItem,
): BaseOfferPreviewSet {
  if (liveListing.sku !== entry.sku || listingAsin(liveListing) !== entry.asin) {
    throw new Error(`${entry.action_id} live identity drifted.`);
  }
  const liveOffers = mustArray(
    liveListing.attributes?.purchasable_offer,
    `${entry.action_id} live purchasable_offer`,
  );
  const liveAttributes = mustRecord(
    liveListing.attributes,
    `${entry.action_id} live attributes`,
  );
  const liveHash = sha256(stableJson(liveOffers));
  if (liveHash !== entry.before.purchasable_offer_sha256) {
    throw new Error(`${entry.action_id} CAS failed: purchasable_offer drifted.`);
  }
  const liveListPrice = memberState(liveAttributes, "list_price");
  if (liveListPrice.sha256 !== entry.before.list_price.sha256) {
    throw new Error(`${entry.action_id} CAS failed: list_price drifted.`);
  }
  const liveB2B = topLevelB2BObservation(liveListing.offers);
  if (liveB2B.sha256 !== entry.before.top_level_b2b_offers_sha256) {
    throw new Error(`${entry.action_id} CAS failed: top-level B2B offer drifted.`);
  }
  assertBaseOfferPreservePatch(entry.actual_patch);
  const after = applySparsePurchasableOfferMerge(liveOffers, entry.actual_patch.value);
  const afterAttributes = { ...clone(liveAttributes), purchasable_offer: after };
  const proof = assertPreserved(liveOffers, after, liveAttributes, afterAttributes);
  const preview: ListingPatch = {
    op: "replace",
    path: BASE_OFFER_PATH,
    value: clone(entry.actual_patch.value),
  };
  return {
    action_id: entry.action_id,
    actual_merge_patch: clone(entry.actual_patch),
    validation_preview_patch: preview,
    simulated_after_purchasable_offer: after,
    simulated_after_sha256: sha256(stableJson(after)),
    preservation_proof: proof,
  };
}

export function buildBaseOfferPreservePlan(input: {
  matrix: unknown;
  snapshot: unknown;
  generatedAt: string;
  sources: BaseOfferPreservePlan["sources"];
}): BaseOfferPreservePlan {
  const matrix = mustRecord(input.matrix, "price matrix");
  const snapshot = mustRecord(input.snapshot, "Amazon snapshot");
  if (
    matrix.schema_version !== "uncrustables-fresh-amazon-price-matrix/v1" ||
    matrix.read_only !== true ||
    matrix.external_mutations !== 0
  ) {
    throw new Error("Fresh price matrix provenance is invalid.");
  }
  if (
    snapshot.schema_version !== "uncrustables-amazon-prechange-snapshot/v1" ||
    snapshot.capture_mode !== "LIVE_SP_API" ||
    snapshot.external_mutations !== false
  ) {
    throw new Error("Fresh Amazon prechange snapshot provenance is invalid.");
  }
  const rows = mustArray(matrix.rows, "price matrix rows");
  const snapshotEntries = mustArray(snapshot.entries, "snapshot entries");
  if (rows.length !== 164 || snapshotEntries.length !== 164) {
    throw new Error("Expected exactly 164 matrix and snapshot rows.");
  }
  const snapshotsBySku = new Map<string, JsonObject>();
  for (const [index, raw] of snapshotEntries.entries()) {
    const entry = mustRecord(raw, `snapshot entry ${index}`);
    const sku = mustString(entry.sku, `snapshot entry ${index}.sku`);
    if (snapshotsBySku.has(sku)) throw new Error(`Duplicate snapshot SKU ${sku}.`);
    const listing = mustRecord(entry.listing, `${sku} listing`);
    if (entry.listing_sha256 !== sha256(stableJson(listing))) {
      throw new Error(`${sku} snapshot listing seal is invalid.`);
    }
    snapshotsBySku.set(sku, entry);
  }

  const entries: BaseOfferPreservePlanEntry[] = [];
  const holds: BaseOfferIdentityHold[] = [];
  const allSkus = new Set<string>();
  const allAsins = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const row = mustRecord(raw, `price matrix row ${index}`);
    const sku = mustString(row.sku, `row ${index}.sku`);
    const asin = mustString(row.asin, `${sku}.asin`);
    const listingKey = mustString(row.listing_key, `${sku}.listing_key`);
    const storeIndex = mustNumber(row.store_index, `${sku}.store_index`);
    const ordinal = mustNumber(row.ordinal, `${sku}.ordinal`);
    if (allSkus.has(sku) || allAsins.has(asin)) {
      throw new Error(`Duplicate matrix identity ${sku}/${asin}.`);
    }
    allSkus.add(sku);
    allAsins.add(asin);
    const snapshotEntry = mustRecord(snapshotsBySku.get(sku), `${sku} snapshot entry`);
    const listing = mustRecord(snapshotEntry.listing, `${sku} snapshot listing`);
    if (
      snapshotEntry.asin !== asin ||
      snapshotEntry.store_index !== storeIndex ||
      listingAsin(listing as unknown as ListingItem) !== asin
    ) {
      throw new Error(`${sku} matrix/snapshot identity mismatch.`);
    }
    const surgical = mustRecord(row.surgical_base_patch, `${sku} surgical patch`);
    const identity = mustRecord(row.identity, `${sku} identity`);
    if (surgical.disposition === "HOLD_IDENTITY") {
      if (surgical.patch !== null || identity.status !== "HOLD_IDENTITY") {
        throw new Error(`${sku} identity hold is not fail-closed.`);
      }
      holds.push({
        ordinal,
        listing_key: listingKey,
        store_index: storeIndex,
        sku,
        asin,
        target_asin: mustString(row.target_asin, `${sku}.target_asin`),
        reason_codes: mustArray(identity.reason_codes, `${sku}.reason_codes`).map(
          (reason, reasonIndex) => mustString(reason, `${sku}.reason_codes[${reasonIndex}]`),
        ),
        action_id: null,
        patch: null,
      });
      continue;
    }
    if (surgical.disposition !== "PATCH_REQUIRED") {
      throw new Error(`${sku} has unsupported disposition ${String(surgical.disposition)}.`);
    }
    const patch = clone(mustRecord(surgical.patch, `${sku} patch`)) as unknown as ListingPatch;
    assertBaseOfferPreservePatch(patch);
    const attributes = mustRecord(listing.attributes, `${sku} attributes`);
    const beforeOffers = clone(
      mustArray(attributes.purchasable_offer, `${sku} purchasable_offer`),
    );
    const beforePreserved = preservedStates(beforeOffers, attributes);
    const beforeB2B = topLevelB2BObservation(listing.offers);
    const matrixAmazon = mustRecord(row.amazon, `${sku} Amazon observation`);
    if (
      beforeB2B.observedPrice !==
      mustNumber(matrixAmazon.b2b_price, `${sku}.amazon.b2b_price`)
    ) {
      throw new Error(`${sku} matrix/snapshot top-level B2B price mismatch.`);
    }
    const afterOffers = applySparsePurchasableOfferMerge(beforeOffers, patch.value);
    const afterAttributes = { ...clone(attributes), purchasable_offer: afterOffers };
    const afterPreserved = preservedStates(afterOffers, afterAttributes);
    const preservationProof = assertPreserved(
      beforeOffers,
      afterOffers,
      attributes,
      afterAttributes,
    );
    const target = mustRecord(row.target, `${sku} target`);
    const actionId = `${listingKey}:base-offer-preserve`;
    entries.push({
      ordinal,
      action_id: actionId,
      listing_key: listingKey,
      store_index: storeIndex,
      sku,
      asin,
      product_type: mustString(snapshotEntry.product_type, `${sku}.product_type`),
      marketplace_id: US_AMAZON_MARKETPLACE_ID,
      mismatch_fields: mustArray(surgical.mismatch_fields, `${sku}.mismatch_fields`).map(
        (field, fieldIndex) => mustString(field, `${sku}.mismatch_fields[${fieldIndex}]`),
      ),
      before: {
        purchasable_offer: beforeOffers,
        purchasable_offer_sha256: sha256(stableJson(beforeOffers)),
        top_level_b2b_offers: beforeB2B.offers,
        top_level_b2b_offers_sha256: beforeB2B.sha256,
        top_level_b2b_observed_price: beforeB2B.observedPrice,
        ...beforePreserved,
      },
      actual_patch: patch,
      validation_preview_patch: {
        op: "replace",
        path: BASE_OFFER_PATH,
        value: clone(patch.value),
      },
      simulated_after: {
        purchasable_offer: afterOffers,
        purchasable_offer_sha256: sha256(stableJson(afterOffers)),
        ...afterPreserved,
      },
      preservation_proof: preservationProof,
      target: {
        regular_base: mustNumber(target.regular_base, `${sku}.target.regular_base`),
        minimum: mustNumber(target.minimum, `${sku}.target.minimum`),
        maximum: mustNumber(target.maximum, `${sku}.target.maximum`),
        b2b: mustNumber(target.b2b, `${sku}.target.b2b`),
      },
    });
  }
  if (entries.length !== 161 || holds.length !== 3) {
    throw new Error(`Expected 161 actions/3 holds, got ${entries.length}/${holds.length}.`);
  }
  const body: Omit<BaseOfferPreservePlan, "body_sha256"> = {
    schema_version: BASE_OFFER_PRESERVE_PLAN_SCHEMA,
    profile: BASE_OFFER_PRESERVE_PROFILE,
    generated_at: input.generatedAt,
    immutable: true,
    offline_only: true,
    external_mutations: 0,
    execution_authorized: false,
    authority: {
      base_offer_execution_owner_gate: "REQUIRED_SEPARATELY",
      promo_v4_reused_as_authority: false,
      coupon_or_sales_price_action_authorized: false,
    },
    contract: {
      exact_path: BASE_OFFER_PATH,
      allowed_all_members: [
        "our_price",
        "minimum_seller_allowed_price",
        "maximum_seller_allowed_price",
      ],
      allowed_b2b_members: ["our_price"],
      forbidden_members: ["discounted_price", "list_price"],
      selector_merge: true,
      sparse_differences_only: true,
      live_write_capability: false,
    },
    sources: input.sources,
    scope: {
      input_rows: 164,
      action_rows: 161,
      identity_holds: 3,
      unique_skus: 164,
      unique_asins: 164,
    },
    entries,
    holds,
  };
  return assertBaseOfferPreservePlan(sealPlan(body));
}
