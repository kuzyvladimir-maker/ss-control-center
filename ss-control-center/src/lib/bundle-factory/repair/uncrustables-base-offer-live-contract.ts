import type { ListingItem, ListingPatch } from "../../amazon-sp-api/listings";
import {
  BASE_OFFER_PATH,
  BASE_OFFER_PRESERVE_PROFILE,
  US_AMAZON_MARKETPLACE_ID,
  applySparsePurchasableOfferMerge,
  assertBaseOfferPreservePatch,
  assertBaseOfferPreservePlan,
  assertBaseOfferPreserveSelection,
  sha256,
  stableJson,
  type BaseOfferPreservePlan,
  type BaseOfferPreservePlanEntry,
  type BaseOfferPreserveSelection,
  type PreservedMemberState,
} from "./uncrustables-base-offer-preserve";
import {
  verifyPreChangeSnapshot,
  type UncrustablesPreChangeSnapshot,
} from "./uncrustables-amazon-rollback";

export const BASE_OFFER_LIVE_SELECTION_SCHEMA =
  "uncrustables-amazon-base-offer-live-selection/v1" as const;
export const BASE_OFFER_ROLLBACK_BINDING_SCHEMA =
  "uncrustables-amazon-base-offer-rollback-binding/v1" as const;
export const BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA =
  "uncrustables-amazon-base-offer-live-authorization/v1" as const;
export const BASE_OFFER_LIVE_ARM_ENV =
  "BF_UNCRUSTABLES_AMAZON_BASE_OFFER_PRESERVE_LIVE_ARM" as const;
export const LK_FIRST_CANARY_SKU = "LK-AS7X-K43B" as const;
export const LK_FIRST_CANARY_ACTION_ID =
  "amazon:1:LK-AS7X-K43B:base-offer-preserve" as const;

type JsonObject = Record<string, unknown>;

export type BaseOfferLiveSelectionKind = "CANARY" | "WAVE";
export type BaseOfferLiveMode =
  | "OFFLINE_VALIDATE"
  | "VALIDATION_PREVIEW"
  | "APPLY";

export interface BaseOfferLiveSelection {
  schema_version: typeof BASE_OFFER_LIVE_SELECTION_SCHEMA;
  profile: typeof BASE_OFFER_PRESERVE_PROFILE;
  immutable: true;
  offline_only: true;
  execution_authorized: false;
  created_at: string;
  selection_id: string;
  kind: BaseOfferLiveSelectionKind;
  source_plan_body_sha256: string;
  source_full_selection_body_sha256: string;
  selected_action_ids: string[];
  selected_skus: string[];
  selected_actions: number;
  first_action_id: string;
  policy: {
    serial_execution: true;
    one_patch_attempt_per_action: true;
    fresh_164_row_snapshot_required: true;
    validation_preview_required: true;
    immediate_prewrite_cas_required: true;
    stable_readback_required: true;
    discounted_price_must_be_preserved: true;
    top_level_list_price_must_be_preserved: true;
    top_level_b2b_cas_required: true;
    exact_patch_path: typeof BASE_OFFER_PATH;
  };
  body_sha256: string;
}

export interface BaseOfferRollbackBindingEntry {
  action_id: string;
  sku: string;
  asin: string;
  store_index: number;
  product_type: string;
  snapshot_listing_sha256: string;
  before_purchasable_offer_sha256: string;
  before_discounted_price_sha256: string;
  before_list_price_sha256: string;
  before_top_level_b2b_offers_sha256: string;
  forward_patch_sha256: string;
  inverse_patch: ListingPatch;
  inverse_patch_sha256: string;
}

export interface BaseOfferRollbackBinding {
  schema_version: typeof BASE_OFFER_ROLLBACK_BINDING_SCHEMA;
  profile: typeof BASE_OFFER_PRESERVE_PROFILE;
  immutable: true;
  execution_authorized: false;
  created_at: string;
  binding_id: string;
  source_plan_body_sha256: string;
  source_full_selection_body_sha256: string;
  source_live_selection_body_sha256: string;
  snapshot: {
    path: string;
    file_sha256: string;
    body_sha256: string;
    snapshot_id: string;
    capture_mode: "LIVE_SP_API";
    completed_at: string;
    rows: 164;
  };
  policy: {
    snapshot_max_age_ms: number;
    snapshot_capture_span_max_ms: number;
    exact_164_row_scope: true;
    inverse_patch_coverage_exact: true;
    discounted_price_omitted_from_forward_and_inverse: true;
    list_price_omitted_from_forward_and_inverse: true;
  };
  entries: BaseOfferRollbackBindingEntry[];
  body_sha256: string;
}

export interface BaseOfferLiveAuthorization {
  schema_version: typeof BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA;
  profile: typeof BASE_OFFER_PRESERVE_PROFILE;
  immutable: true;
  authorization_id: string;
  owner_approved: true;
  created_at: string;
  expires_at: string;
  permit: "APPLY_AMAZON_BASE_OFFER_PRESERVE_PROMO_V1";
  source_plan_body_sha256: string;
  source_full_selection_body_sha256: string;
  source_live_selection_body_sha256: string;
  source_rollback_binding_body_sha256: string;
  snapshot_file_sha256: string;
  snapshot_body_sha256: string;
  selected_action_ids: string[];
  account: {
    store_index: number;
    marketplace_id: typeof US_AMAZON_MARKETPLACE_ID;
    amazon_merchant_id: string;
  };
  constraints: {
    exact_patch_path: typeof BASE_OFFER_PATH;
    discounted_price_action_authorized: false;
    list_price_action_authorized: false;
    sales_price_action_authorized: false;
    coupon_action_authorized: false;
    one_patch_attempt_per_action: true;
    stable_readback_required: true;
  };
  body_sha256: string;
}

export interface VerifiedFreshRollbackContext {
  snapshotBySku: Map<string, UncrustablesPreChangeSnapshot["entries"][number]>;
  completedAtMs: number;
}

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function money(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive price.`);
  }
  return number;
}

function bodyWithoutSeal<T extends { body_sha256: string }>(
  value: T,
): Omit<T, "body_sha256"> {
  const body = { ...value } as Partial<T>;
  delete body.body_sha256;
  return body as Omit<T, "body_sha256">;
}

function seal<T extends JsonObject>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: sha256(stableJson(body)) };
}

function exactMemberState(container: JsonObject, member: string): PreservedMemberState {
  const present = Object.prototype.hasOwnProperty.call(container, member);
  const value = present ? container[member] : undefined;
  const envelope = present ? { present: true, value } : { present: false };
  const canonical = stableJson(envelope);
  return {
    present,
    ...(present ? { value: clone(value) } : {}),
    canonical_json: canonical,
    sha256: sha256(canonical),
  };
}

function allOffer(listing: ListingItem): JsonObject {
  const offers = listing.attributes?.purchasable_offer;
  if (!Array.isArray(offers)) {
    throw new Error(`${listing.sku} has no purchasable_offer array.`);
  }
  const matches = offers.filter(
    (item) => isRecord(item) && item.audience === "ALL",
  );
  if (matches.length !== 1) {
    throw new Error(`${listing.sku} must have exactly one ALL offer selector.`);
  }
  return matches[0] as JsonObject;
}

export function exactTopLevelB2BOffers(listing: ListingItem): unknown[] {
  if (!Array.isArray(listing.offers)) {
    throw new Error(`${listing.sku} has no top-level offers array.`);
  }
  const matches = listing.offers.filter((item) => {
    if (!isRecord(item)) return false;
    const audience = isRecord(item.audience) ? item.audience.value : item.audience;
    return (
      item.marketplaceId === US_AMAZON_MARKETPLACE_ID &&
      (item.offerType === "B2B" || audience === "B2B")
    );
  });
  if (matches.length !== 1) {
    throw new Error(`${listing.sku} must have exactly one top-level B2B offer.`);
  }
  return clone(matches);
}

export function exactTopLevelB2BPrice(listing: ListingItem): number {
  const offer = exactTopLevelB2BOffers(listing)[0];
  if (!isRecord(offer) || !isRecord(offer.price)) {
    throw new Error(`${listing.sku} B2B offer price is missing.`);
  }
  return money(offer.price.amount, `${listing.sku} B2B offer price`);
}

export function createBaseOfferLiveSelection(input: {
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  kind: BaseOfferLiveSelectionKind;
  actionIds: string[];
  createdAt?: Date;
  selectionId?: string;
}): BaseOfferLiveSelection {
  assertBaseOfferPreservePlan(input.plan);
  assertBaseOfferPreserveSelection(input.plan, input.fullSelection);
  if (
    input.actionIds.length === 0 ||
    new Set(input.actionIds).size !== input.actionIds.length
  ) {
    throw new Error("Live selection requires a non-empty unique exact action order.");
  }
  if (input.kind === "CANARY" && input.actionIds.length > 5) {
    throw new Error("Base-offer canary may contain at most 5 actions.");
  }
  if (
    input.kind === "CANARY" &&
    input.actionIds[0] !== LK_FIRST_CANARY_ACTION_ID
  ) {
    throw new Error(`The first sealed base-offer canary must be exactly ${LK_FIRST_CANARY_SKU}.`);
  }
  const fullSet = new Set(input.fullSelection.selected_action_ids);
  const entriesByAction = new Map(
    input.plan.entries.map((entry) => [entry.action_id, entry]),
  );
  const selected = input.actionIds.map((actionId) => {
    const entry = entriesByAction.get(actionId);
    if (!entry || !fullSet.has(actionId)) {
      throw new Error(`Live selection action ${actionId} is outside FINAL v3 scope.`);
    }
    return entry;
  });
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const body = {
    schema_version: BASE_OFFER_LIVE_SELECTION_SCHEMA,
    profile: BASE_OFFER_PRESERVE_PROFILE,
    immutable: true as const,
    offline_only: true as const,
    execution_authorized: false as const,
    created_at: createdAt,
    selection_id:
      input.selectionId?.trim() ||
      `UBOLS-${createdAt.replace(/[-:.]/g, "")}-${sha256(stableJson(input.actionIds)).slice(0, 12)}`,
    kind: input.kind,
    source_plan_body_sha256: input.plan.body_sha256,
    source_full_selection_body_sha256: input.fullSelection.body_sha256,
    selected_action_ids: [...input.actionIds],
    selected_skus: selected.map((entry) => entry.sku),
    selected_actions: selected.length,
    first_action_id: input.actionIds[0],
    policy: {
      serial_execution: true as const,
      one_patch_attempt_per_action: true as const,
      fresh_164_row_snapshot_required: true as const,
      validation_preview_required: true as const,
      immediate_prewrite_cas_required: true as const,
      stable_readback_required: true as const,
      discounted_price_must_be_preserved: true as const,
      top_level_list_price_must_be_preserved: true as const,
      top_level_b2b_cas_required: true as const,
      exact_patch_path: BASE_OFFER_PATH,
    },
  };
  return assertBaseOfferLiveSelection(
    input.plan,
    input.fullSelection,
    seal(body) as BaseOfferLiveSelection,
  );
}

export function assertBaseOfferLiveSelection(
  plan: BaseOfferPreservePlan,
  fullSelection: BaseOfferPreserveSelection,
  selection: BaseOfferLiveSelection,
): BaseOfferLiveSelection {
  assertBaseOfferPreservePlan(plan);
  assertBaseOfferPreserveSelection(plan, fullSelection);
  if (
    selection.schema_version !== BASE_OFFER_LIVE_SELECTION_SCHEMA ||
    selection.profile !== BASE_OFFER_PRESERVE_PROFILE ||
    !selection.offline_only ||
    selection.execution_authorized ||
    selection.body_sha256 !== sha256(stableJson(bodyWithoutSeal(selection))) ||
    selection.source_plan_body_sha256 !== plan.body_sha256 ||
    selection.source_full_selection_body_sha256 !== fullSelection.body_sha256 ||
    !["CANARY", "WAVE"].includes(selection.kind) ||
    selection.selected_actions !== selection.selected_action_ids.length ||
    selection.selected_actions !== selection.selected_skus.length ||
    selection.selected_actions === 0 ||
    new Set(selection.selected_action_ids).size !== selection.selected_actions ||
    new Set(selection.selected_skus).size !== selection.selected_actions ||
    selection.first_action_id !== selection.selected_action_ids[0]
  ) {
    throw new Error("Base-offer live selection schema/scope/seal is invalid.");
  }
  if (selection.kind === "CANARY" && selection.selected_actions > 5) {
    throw new Error("Base-offer live canary exceeds 5 actions.");
  }
  if (
    selection.kind === "CANARY" &&
    selection.first_action_id !== LK_FIRST_CANARY_ACTION_ID
  ) {
    throw new Error(`The first sealed base-offer canary must be exactly ${LK_FIRST_CANARY_SKU}.`);
  }
  const fullSet = new Set(fullSelection.selected_action_ids);
  const entries = new Map(plan.entries.map((entry) => [entry.action_id, entry]));
  selection.selected_action_ids.forEach((actionId, index) => {
    const entry = entries.get(actionId);
    if (
      !entry ||
      !fullSet.has(actionId) ||
      entry.sku !== selection.selected_skus[index]
    ) {
      throw new Error(`Live selection action ${actionId} is not exact FINAL v3 scope.`);
    }
  });
  if (
    !selection.policy.serial_execution ||
    !selection.policy.one_patch_attempt_per_action ||
    !selection.policy.fresh_164_row_snapshot_required ||
    !selection.policy.validation_preview_required ||
    !selection.policy.immediate_prewrite_cas_required ||
    !selection.policy.stable_readback_required ||
    !selection.policy.discounted_price_must_be_preserved ||
    !selection.policy.top_level_list_price_must_be_preserved ||
    !selection.policy.top_level_b2b_cas_required ||
    selection.policy.exact_patch_path !== BASE_OFFER_PATH
  ) {
    throw new Error("Base-offer live selection safety policy is incomplete.");
  }
  return selection;
}

function summaryAsin(listing: ListingItem): string | null {
  return (
    listing.summaries?.find(
      (summary) => summary.marketplaceId === US_AMAZON_MARKETPLACE_ID,
    )?.asin ?? null
  );
}

function assertExactPlanSnapshotScope(
  plan: BaseOfferPreservePlan,
  snapshot: UncrustablesPreChangeSnapshot,
): Map<string, UncrustablesPreChangeSnapshot["entries"][number]> {
  const expected = new Map(
    [...plan.entries, ...plan.holds].map((entry) => [entry.sku, entry]),
  );
  if (expected.size !== 164 || snapshot.entries.length !== 164) {
    throw new Error("Plan/snapshot must bind the exact 164-row scope.");
  }
  const bySku = new Map<string, UncrustablesPreChangeSnapshot["entries"][number]>();
  for (const snapshotEntry of snapshot.entries) {
    const planned = expected.get(snapshotEntry.sku);
    if (
      !planned ||
      planned.asin !== snapshotEntry.asin ||
      planned.store_index !== snapshotEntry.store_index ||
      summaryAsin(snapshotEntry.listing) !== planned.asin ||
      bySku.has(snapshotEntry.sku)
    ) {
      throw new Error(`Fresh snapshot identity mismatch for ${snapshotEntry.sku}.`);
    }
    bySku.set(snapshotEntry.sku, snapshotEntry);
  }
  if (bySku.size !== 164) throw new Error("Fresh snapshot does not cover 164 unique SKUs.");
  return bySku;
}

function assertFreshSnapshot(input: {
  plan: BaseOfferPreservePlan;
  snapshot: UncrustablesPreChangeSnapshot;
  snapshotBytes: Buffer;
  expectedFileSha256: string;
  now: Date;
  maxAgeMs: number;
  maxCaptureSpanMs: number;
}): VerifiedFreshRollbackContext {
  verifyPreChangeSnapshot(input.snapshot);
  if (
    input.snapshot.capture_mode !== "LIVE_SP_API" ||
    !input.snapshot.apply_eligible ||
    input.snapshot.external_mutations !== false ||
    sha256(input.snapshotBytes) !== input.expectedFileSha256
  ) {
    throw new Error("Rollback snapshot is not exact apply-eligible LIVE_SP_API bytes.");
  }
  const parsed = JSON.parse(input.snapshotBytes.toString("utf8")) as unknown;
  if (stableJson(parsed) !== stableJson(input.snapshot)) {
    throw new Error("Rollback snapshot object differs from its exact file bytes.");
  }
  const completedAtMs = Date.parse(
    canonicalInstant(input.snapshot.completed_at, "snapshot completed_at"),
  );
  const nowMs = input.now.getTime();
  if (
    completedAtMs > nowMs ||
    nowMs - completedAtMs > input.maxAgeMs ||
    input.maxAgeMs <= 0 ||
    input.maxAgeMs > 30 * 60 * 1000
  ) {
    throw new Error("Rollback snapshot is stale, future-dated, or has an unsafe age policy.");
  }
  const capturedTimes = input.snapshot.entries.map((entry) =>
    Date.parse(canonicalInstant(entry.captured_at, `${entry.sku} captured_at`)),
  );
  const firstCapture = Math.min(...capturedTimes);
  const lastCapture = Math.max(...capturedTimes);
  if (
    firstCapture > completedAtMs ||
    lastCapture > completedAtMs ||
    lastCapture - firstCapture > input.maxCaptureSpanMs ||
    completedAtMs - firstCapture > input.maxCaptureSpanMs ||
    input.maxCaptureSpanMs <= 0 ||
    input.maxCaptureSpanMs > 30 * 60 * 1000
  ) {
    throw new Error("Rollback snapshot 164-row capture span is not fresh enough.");
  }
  return {
    snapshotBySku: assertExactPlanSnapshotScope(input.plan, input.snapshot),
    completedAtMs,
  };
}

function stateFromListing(listing: ListingItem): {
  purchasableOffer: unknown[];
  purchasableOfferSha256: string;
  discountedPrice: PreservedMemberState;
  listPrice: PreservedMemberState;
  b2bOffers: unknown[];
  b2bOffersSha256: string;
  b2bPrice: number;
} {
  const attributes = (listing.attributes ?? {}) as JsonObject;
  const purchasableOffer = attributes.purchasable_offer;
  if (!Array.isArray(purchasableOffer)) {
    throw new Error(`${listing.sku} purchasable_offer is missing.`);
  }
  const b2bOffers = exactTopLevelB2BOffers(listing);
  return {
    purchasableOffer: clone(purchasableOffer),
    purchasableOfferSha256: sha256(stableJson(purchasableOffer)),
    discountedPrice: exactMemberState(allOffer(listing), "discounted_price"),
    listPrice: exactMemberState(attributes, "list_price"),
    b2bOffers,
    b2bOffersSha256: sha256(stableJson(b2bOffers)),
    b2bPrice: exactTopLevelB2BPrice(listing),
  };
}

export function assertEntryMatchesFreshSnapshot(
  entry: BaseOfferPreservePlanEntry,
  listing: ListingItem,
): void {
  if (listing.sku !== entry.sku || summaryAsin(listing) !== entry.asin) {
    throw new Error(`${entry.action_id} fresh snapshot identity drifted.`);
  }
  const state = stateFromListing(listing);
  if (
    state.purchasableOfferSha256 !== entry.before.purchasable_offer_sha256 ||
    state.discountedPrice.sha256 !== entry.before.discounted_price.sha256 ||
    state.listPrice.sha256 !== entry.before.list_price.sha256 ||
    state.b2bOffersSha256 !== entry.before.top_level_b2b_offers_sha256 ||
    state.b2bPrice !== entry.before.top_level_b2b_observed_price
  ) {
    throw new Error(`${entry.action_id} fresh rollback state differs from FINAL v3 CAS.`);
  }
}

function selectorKey(value: JsonObject): string {
  return `${String(value.marketplace_id)}\u0000${String(value.currency)}\u0000${String(value.audience)}`;
}

function inversePatchFor(
  entry: BaseOfferPreservePlanEntry,
  listing: ListingItem,
): ListingPatch {
  assertBaseOfferPreservePatch(entry.actual_patch);
  const beforeAttributes = (listing.attributes ?? {}) as JsonObject;
  const beforeOffers = Array.isArray(beforeAttributes.purchasable_offer)
    ? clone(beforeAttributes.purchasable_offer)
    : [];
  const canonicalBefore = [...beforeOffers] as unknown[];
  const b2bKey = `${US_AMAZON_MARKETPLACE_ID}\u0000USD\u0000B2B`;
  const b2bObserved = {
    marketplace_id: US_AMAZON_MARKETPLACE_ID,
    currency: "USD",
    audience: "B2B",
    our_price: [{ schedule: [{ value_with_tax: exactTopLevelB2BPrice(listing) }] }],
  };
  const existingB2B = canonicalBefore.find(
    (raw) => isRecord(raw) && selectorKey(raw) === b2bKey,
  );
  if (isRecord(existingB2B)) existingB2B.our_price = clone(b2bObserved.our_price);
  else canonicalBefore.push(b2bObserved);
  const after = applySparsePurchasableOfferMerge(
    canonicalBefore,
    entry.actual_patch.value,
  );
  const beforeBySelector = new Map(
    canonicalBefore
      .filter(isRecord)
      .map((offer) => [selectorKey(offer), offer] as const),
  );
  const afterBySelector = new Map(
    after.filter(isRecord).map((offer) => [selectorKey(offer), offer] as const),
  );
  const inverse: JsonObject[] = [];
  for (const raw of entry.actual_patch.value as unknown[]) {
    if (!isRecord(raw)) throw new Error(`${entry.action_id} has invalid patch selector.`);
    const key = selectorKey(raw);
    const before = beforeBySelector.get(key);
    const expectedAfter = afterBySelector.get(key);
    if (!expectedAfter) throw new Error(`${entry.action_id} inverse expected state missing.`);
    const selector: JsonObject = {
      marketplace_id: raw.marketplace_id,
      currency: raw.currency,
      audience: raw.audience,
    };
    for (const member of Object.keys(raw).filter(
      (name) => !["marketplace_id", "currency", "audience"].includes(name),
    )) {
      selector[member] =
        before && Object.prototype.hasOwnProperty.call(before, member)
          ? clone(before[member])
          : null;
    }
    inverse.push(selector);
  }
  const patch: ListingPatch = {
    op: "merge",
    path: BASE_OFFER_PATH,
    value: inverse,
  };
  const bytes = stableJson(patch);
  if (bytes.includes("discounted_price") || bytes.includes("list_price")) {
    throw new Error(`${entry.action_id} inverse patch crosses promo/list boundary.`);
  }
  return patch;
}

export function createBaseOfferRollbackBinding(input: {
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  liveSelection: BaseOfferLiveSelection;
  snapshotPath: string;
  snapshotBytes: Buffer;
  snapshot: UncrustablesPreChangeSnapshot;
  now?: Date;
  maxAgeMs?: number;
  maxCaptureSpanMs?: number;
}): BaseOfferRollbackBinding {
  assertBaseOfferLiveSelection(input.plan, input.fullSelection, input.liveSelection);
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? 10 * 60 * 1000;
  const maxCaptureSpanMs = input.maxCaptureSpanMs ?? 10 * 60 * 1000;
  const fileSha256 = sha256(input.snapshotBytes);
  const fresh = assertFreshSnapshot({
    plan: input.plan,
    snapshot: input.snapshot,
    snapshotBytes: input.snapshotBytes,
    expectedFileSha256: fileSha256,
    now,
    maxAgeMs,
    maxCaptureSpanMs,
  });
  const entriesByAction = new Map(
    input.plan.entries.map((entry) => [entry.action_id, entry]),
  );
  const entries = input.liveSelection.selected_action_ids.map((actionId) => {
    const entry = entriesByAction.get(actionId);
    if (!entry) throw new Error(`Rollback binding action ${actionId} is absent.`);
    const snapshotEntry = fresh.snapshotBySku.get(entry.sku);
    if (!snapshotEntry) throw new Error(`Rollback snapshot lacks ${entry.sku}.`);
    assertEntryMatchesFreshSnapshot(entry, snapshotEntry.listing);
    const inversePatch = inversePatchFor(entry, snapshotEntry.listing);
    return {
      action_id: entry.action_id,
      sku: entry.sku,
      asin: entry.asin,
      store_index: entry.store_index,
      product_type: entry.product_type,
      snapshot_listing_sha256: snapshotEntry.listing_sha256,
      before_purchasable_offer_sha256: entry.before.purchasable_offer_sha256,
      before_discounted_price_sha256: entry.before.discounted_price.sha256,
      before_list_price_sha256: entry.before.list_price.sha256,
      before_top_level_b2b_offers_sha256:
        entry.before.top_level_b2b_offers_sha256,
      forward_patch_sha256: sha256(stableJson(entry.actual_patch)),
      inverse_patch: inversePatch,
      inverse_patch_sha256: sha256(stableJson(inversePatch)),
    };
  });
  const body = {
    schema_version: BASE_OFFER_ROLLBACK_BINDING_SCHEMA,
    profile: BASE_OFFER_PRESERVE_PROFILE,
    immutable: true as const,
    execution_authorized: false as const,
    created_at: now.toISOString(),
    binding_id: `UBORB-${now.toISOString().replace(/[-:.]/g, "")}-${input.liveSelection.body_sha256.slice(0, 12)}`,
    source_plan_body_sha256: input.plan.body_sha256,
    source_full_selection_body_sha256: input.fullSelection.body_sha256,
    source_live_selection_body_sha256: input.liveSelection.body_sha256,
    snapshot: {
      path: input.snapshotPath,
      file_sha256: fileSha256,
      body_sha256: input.snapshot.sha256,
      snapshot_id: input.snapshot.snapshot_id,
      capture_mode: "LIVE_SP_API" as const,
      completed_at: input.snapshot.completed_at,
      rows: 164 as const,
    },
    policy: {
      snapshot_max_age_ms: maxAgeMs,
      snapshot_capture_span_max_ms: maxCaptureSpanMs,
      exact_164_row_scope: true as const,
      inverse_patch_coverage_exact: true as const,
      discounted_price_omitted_from_forward_and_inverse: true as const,
      list_price_omitted_from_forward_and_inverse: true as const,
    },
    entries,
  };
  return assertBaseOfferRollbackBinding(
    input.plan,
    input.fullSelection,
    input.liveSelection,
    seal(body) as BaseOfferRollbackBinding,
    {
      snapshot: input.snapshot,
      snapshotBytes: input.snapshotBytes,
      now,
    },
  );
}

export function assertBaseOfferRollbackBinding(
  plan: BaseOfferPreservePlan,
  fullSelection: BaseOfferPreserveSelection,
  liveSelection: BaseOfferLiveSelection,
  binding: BaseOfferRollbackBinding,
  runtime: {
    snapshot: UncrustablesPreChangeSnapshot;
    snapshotBytes: Buffer;
    now: Date;
  },
): BaseOfferRollbackBinding {
  assertBaseOfferLiveSelection(plan, fullSelection, liveSelection);
  if (
    binding.schema_version !== BASE_OFFER_ROLLBACK_BINDING_SCHEMA ||
    binding.profile !== BASE_OFFER_PRESERVE_PROFILE ||
    !binding.immutable ||
    binding.execution_authorized ||
    binding.body_sha256 !== sha256(stableJson(bodyWithoutSeal(binding))) ||
    binding.source_plan_body_sha256 !== plan.body_sha256 ||
    binding.source_full_selection_body_sha256 !== fullSelection.body_sha256 ||
    binding.source_live_selection_body_sha256 !== liveSelection.body_sha256 ||
    binding.snapshot.body_sha256 !== runtime.snapshot.sha256 ||
    binding.snapshot.file_sha256 !== sha256(runtime.snapshotBytes) ||
    binding.snapshot.snapshot_id !== runtime.snapshot.snapshot_id ||
    binding.snapshot.completed_at !== runtime.snapshot.completed_at ||
    binding.snapshot.rows !== 164 ||
    binding.entries.length !== liveSelection.selected_actions
  ) {
    throw new Error("Base-offer rollback binding schema/scope/seal is invalid.");
  }
  const fresh = assertFreshSnapshot({
    plan,
    snapshot: runtime.snapshot,
    snapshotBytes: runtime.snapshotBytes,
    expectedFileSha256: binding.snapshot.file_sha256,
    now: runtime.now,
    maxAgeMs: binding.policy.snapshot_max_age_ms,
    maxCaptureSpanMs: binding.policy.snapshot_capture_span_max_ms,
  });
  const planned = new Map(plan.entries.map((entry) => [entry.action_id, entry]));
  binding.entries.forEach((bound, index) => {
    const actionId = liveSelection.selected_action_ids[index];
    const entry = planned.get(actionId);
    const snapshotEntry = entry ? fresh.snapshotBySku.get(entry.sku) : null;
    if (
      !entry ||
      !snapshotEntry ||
      bound.action_id !== actionId ||
      bound.sku !== entry.sku ||
      bound.asin !== entry.asin ||
      bound.store_index !== entry.store_index ||
      bound.product_type !== entry.product_type ||
      bound.snapshot_listing_sha256 !== snapshotEntry.listing_sha256 ||
      bound.forward_patch_sha256 !== sha256(stableJson(entry.actual_patch))
    ) {
      throw new Error(`Rollback binding entry ${actionId} is not exact.`);
    }
    assertEntryMatchesFreshSnapshot(entry, snapshotEntry.listing);
    const expectedInverse = inversePatchFor(entry, snapshotEntry.listing);
    if (
      stableJson(bound.inverse_patch) !== stableJson(expectedInverse) ||
      bound.inverse_patch_sha256 !== sha256(stableJson(expectedInverse)) ||
      stableJson(bound.inverse_patch).includes("discounted_price") ||
      stableJson(bound.inverse_patch).includes("list_price")
    ) {
      throw new Error(`Rollback inverse patch for ${actionId} is invalid.`);
    }
  });
  return binding;
}

export function baseOfferAuthorizationBodySha256(
  authorization: BaseOfferLiveAuthorization,
): string {
  return sha256(stableJson(bodyWithoutSeal(authorization)));
}

export function assertBaseOfferLiveAuthorization(input: {
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  liveSelection: BaseOfferLiveSelection;
  rollbackBinding: BaseOfferRollbackBinding;
  authorization: BaseOfferLiveAuthorization;
  snapshot: UncrustablesPreChangeSnapshot;
  snapshotBytes: Buffer;
  now?: Date;
}): BaseOfferLiveAuthorization {
  const now = input.now ?? new Date();
  assertBaseOfferRollbackBinding(
    input.plan,
    input.fullSelection,
    input.liveSelection,
    input.rollbackBinding,
    { snapshot: input.snapshot, snapshotBytes: input.snapshotBytes, now },
  );
  const authorization = input.authorization;
  const createdAt = Date.parse(canonicalInstant(authorization.created_at, "authorization created_at"));
  const expiresAt = Date.parse(canonicalInstant(authorization.expires_at, "authorization expires_at"));
  const nowMs = now.getTime();
  if (
    authorization.schema_version !== BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA ||
    authorization.profile !== BASE_OFFER_PRESERVE_PROFILE ||
    !authorization.immutable ||
    authorization.owner_approved !== true ||
    authorization.permit !== "APPLY_AMAZON_BASE_OFFER_PRESERVE_PROMO_V1" ||
    authorization.body_sha256 !== baseOfferAuthorizationBodySha256(authorization) ||
    createdAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > 15 * 60 * 1000 ||
    createdAt < Date.parse(input.snapshot.completed_at) ||
    createdAt < Date.parse(input.rollbackBinding.created_at) ||
    authorization.source_plan_body_sha256 !== input.plan.body_sha256 ||
    authorization.source_full_selection_body_sha256 !== input.fullSelection.body_sha256 ||
    authorization.source_live_selection_body_sha256 !== input.liveSelection.body_sha256 ||
    authorization.source_rollback_binding_body_sha256 !== input.rollbackBinding.body_sha256 ||
    authorization.snapshot_file_sha256 !== input.rollbackBinding.snapshot.file_sha256 ||
    authorization.snapshot_body_sha256 !== input.rollbackBinding.snapshot.body_sha256 ||
    stableJson(authorization.selected_action_ids) !==
      stableJson(input.liveSelection.selected_action_ids) ||
    authorization.account.store_index !== 1 ||
    authorization.account.marketplace_id !== US_AMAZON_MARKETPLACE_ID ||
    typeof authorization.account.amazon_merchant_id !== "string" ||
    !/^[A-Z0-9]+$/.test(authorization.account.amazon_merchant_id) ||
    authorization.constraints.exact_patch_path !== BASE_OFFER_PATH ||
    authorization.constraints.discounted_price_action_authorized !== false ||
    authorization.constraints.list_price_action_authorized !== false ||
    authorization.constraints.sales_price_action_authorized !== false ||
    authorization.constraints.coupon_action_authorized !== false ||
    !authorization.constraints.one_patch_attempt_per_action ||
    !authorization.constraints.stable_readback_required
  ) {
    throw new Error("Base-offer live authorization is invalid, stale, or differently bound.");
  }
  digest(authorization.body_sha256, "authorization body_sha256");
  return authorization;
}

export function baseOfferLiveArmToken(input: {
  mode: Exclude<BaseOfferLiveMode, "OFFLINE_VALIDATE">;
  plan: BaseOfferPreservePlan;
  liveSelection: BaseOfferLiveSelection;
  rollbackBinding: BaseOfferRollbackBinding;
  authorization?: BaseOfferLiveAuthorization | null;
}): string {
  if (input.mode === "APPLY" && !input.authorization) {
    throw new Error("APPLY arm token requires the exact owner authorization.");
  }
  if (input.mode === "VALIDATION_PREVIEW" && input.authorization) {
    throw new Error("Preview arm token must not borrow mutation authorization.");
  }
  const authorization = input.authorization?.body_sha256 ?? "NO-AUTHORIZATION";
  return [
    `AMAZON_BASE_OFFER_PRESERVE_${input.mode}_V1`,
    input.plan.body_sha256,
    input.liveSelection.body_sha256,
    input.rollbackBinding.body_sha256,
    authorization,
  ].join(":");
}

export function assertBaseOfferLiveArm(input: {
  mode: BaseOfferLiveMode;
  expectedToken?: string;
  confirmation?: string | null;
  environment?: Record<string, string | undefined>;
}): void {
  if (input.mode === "OFFLINE_VALIDATE") {
    if (input.confirmation || input.environment?.[BASE_OFFER_LIVE_ARM_ENV]) {
      throw new Error("Offline validation refuses ambient live arm credentials.");
    }
    return;
  }
  if (
    !input.expectedToken ||
    input.confirmation !== input.expectedToken ||
    input.environment?.[BASE_OFFER_LIVE_ARM_ENV] !== input.expectedToken
  ) {
    throw new Error(
      `${input.mode} requires exact confirmation and ${BASE_OFFER_LIVE_ARM_ENV}; no Amazon call was made.`,
    );
  }
}

export type BaseOfferLiveStateClassification =
  | "BEFORE"
  | "DESIRED"
  | "NON_DESIRED";

export interface BaseOfferLiveStateObservation {
  classification: BaseOfferLiveStateClassification;
  state_sha256: string;
  preservation_ok: boolean;
  issue_19038_absent: boolean;
  checks: Array<{ name: string; ok: boolean; actual: unknown; expected: unknown }>;
}

function offerSelector(
  offers: unknown[],
  audience: "ALL" | "B2B",
): JsonObject | null {
  const matches = offers.filter(
    (raw) => isRecord(raw) && raw.audience === audience,
  );
  if (matches.length > 1) {
    throw new Error(`Live purchasable_offer repeats ${audience} selector.`);
  }
  return (matches[0] as JsonObject | undefined) ?? null;
}

function issueCodes(listing: ListingItem): string[] {
  return [
    ...new Set(
      (listing.issues ?? [])
        .map((issue) => String(issue.code ?? "").trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function observeBaseOfferLiveState(
  entry: BaseOfferPreservePlanEntry,
  listing: ListingItem,
): BaseOfferLiveStateObservation {
  if (listing.sku !== entry.sku || summaryAsin(listing) !== entry.asin) {
    throw new Error(`${entry.action_id} live readback identity drifted.`);
  }
  const state = stateFromListing(listing);
  const preservationChecks = [
    {
      name: "discounted_price_preserved",
      ok: state.discountedPrice.sha256 === entry.before.discounted_price.sha256,
      actual: state.discountedPrice.sha256,
      expected: entry.before.discounted_price.sha256,
    },
    {
      name: "top_level_list_price_preserved",
      ok: state.listPrice.sha256 === entry.before.list_price.sha256,
      actual: state.listPrice.sha256,
      expected: entry.before.list_price.sha256,
    },
  ];
  const currentAll = offerSelector(state.purchasableOffer, "ALL");
  const expectedAfterAll = offerSelector(
    entry.simulated_after.purchasable_offer,
    "ALL",
  );
  const beforeAll = offerSelector(entry.before.purchasable_offer, "ALL");
  if (!currentAll || !expectedAfterAll || !beforeAll) {
    throw new Error(`${entry.action_id} ALL selector is missing from state comparison.`);
  }
  const targetChecks: BaseOfferLiveStateObservation["checks"] = [];
  const beforeChecks: BaseOfferLiveStateObservation["checks"] = [];
  const selectors = entry.actual_patch.value as unknown[];
  for (const raw of selectors) {
    if (!isRecord(raw) || (raw.audience !== "ALL" && raw.audience !== "B2B")) {
      throw new Error(`${entry.action_id} has an invalid sealed selector.`);
    }
    for (const member of Object.keys(raw).filter(
      (name) => !["marketplace_id", "currency", "audience"].includes(name),
    )) {
      if (raw.audience === "ALL") {
        targetChecks.push({
          name: `ALL.${member}_desired`,
          ok: stableJson(currentAll[member]) === stableJson(raw[member]),
          actual: currentAll[member],
          expected: raw[member],
        });
        beforeChecks.push({
          name: `ALL.${member}_before`,
          ok: stableJson(currentAll[member]) === stableJson(beforeAll[member]),
          actual: currentAll[member],
          expected: beforeAll[member],
        });
      } else {
        const desiredSchedule = raw.our_price;
        const desired = Array.isArray(desiredSchedule) &&
            isRecord(desiredSchedule[0]) &&
            Array.isArray(desiredSchedule[0].schedule) &&
            isRecord(desiredSchedule[0].schedule[0])
          ? Number(desiredSchedule[0].schedule[0].value_with_tax)
          : Number.NaN;
        targetChecks.push({
          name: "B2B.our_price_desired",
          ok: Number.isFinite(desired) && state.b2bPrice === desired,
          actual: state.b2bPrice,
          expected: desired,
        });
        beforeChecks.push({
          name: "B2B.our_price_before",
          ok: state.b2bPrice === entry.before.top_level_b2b_observed_price,
          actual: state.b2bPrice,
          expected: entry.before.top_level_b2b_observed_price,
        });
      }
    }
  }
  const codes = issueCodes(listing);
  const issue19038Absent = !codes.includes("19038");
  const issueCheck = {
    name: "issue_19038_absent",
    ok: issue19038Absent,
    actual: codes,
    expected: "19038 absent",
  };
  const preservationOk = preservationChecks.every((check) => check.ok);
  const desired =
    preservationOk &&
    targetChecks.every((check) => check.ok) &&
    issue19038Absent;
  const before =
    preservationOk &&
    beforeChecks.every((check) => check.ok);
  const classification: BaseOfferLiveStateClassification = desired
    ? "DESIRED"
    : before
      ? "BEFORE"
      : "NON_DESIRED";
  const checks = [...preservationChecks, ...targetChecks, issueCheck];
  return {
    classification,
    state_sha256: sha256(
      stableJson({
        action_id: entry.action_id,
        purchasable_offer: state.purchasableOffer,
        top_level_b2b_offers: state.b2bOffers,
        discounted_price: state.discountedPrice,
        list_price: state.listPrice,
        issue_codes: codes,
      }),
    ),
    preservation_ok: preservationOk,
    issue_19038_absent: issue19038Absent,
    checks,
  };
}
