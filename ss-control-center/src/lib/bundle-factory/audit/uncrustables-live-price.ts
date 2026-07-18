import { createHash } from "node:crypto";

import type { UncrustablesLaunchPricingManifest, UncrustablesLaunchPricingRow } from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";

export const UNCRUSTABLES_LIVE_PRICE_AUDIT_SCHEMA =
  "uncrustables-live-product-pricing-audit/v1" as const;
export const UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE = 164 as const;

export interface UncrustablesPriceIdentity {
  sku: string;
  asin: string;
  store_index: number;
}

export type ProductPricingObservationState = "OFFER" | "NO_OFFER" | "ERROR";

export interface ProductPricingOwnOffer {
  listing_price: number;
  shipping: number;
  landed_price: number;
  currency: string | null;
  is_buy_box_winner: boolean;
  is_featured_merchant: boolean;
}

export interface ProductPricingObservation {
  sku: string;
  asin: string;
  store_index: number;
  observed_at: string;
  request_attempts: number;
  request_errors: string[];
  state: ProductPricingObservationState;
  effective_live_price: number | null;
  effective_live_price_source: "MY_OFFER_LISTING_PRICE" | null;
  seller_shipping: number | null;
  seller_landed_price: number | null;
  currency: string | null;
  is_buy_box_winner: boolean | null;
  is_featured_merchant: boolean | null;
  total_offer_count: number | null;
  own_offer_count: number | null;
  buy_box_landed_price: number | null;
  response_body_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
}

export type LaunchPhase = "PRELAUNCH" | "ACTIVE" | "POSTLAUNCH";
export type PriceRelation = "BELOW" | "MATCH" | "ABOVE" | "UNAVAILABLE";
export type CohortMembership =
  | "ACTIVE"
  | "ASSIGNED_EXCLUDED"
  | "PRE_ASSIGNMENT_EXCLUDED";

export type LivePriceReconciliationStatus =
  | "MATCH_EXPECTED"
  | "BELOW_EXPECTED"
  | "ABOVE_EXPECTED"
  | "BELOW_FLOOR"
  | "NO_OFFER"
  | "ERROR"
  | "EXCLUDED_OFFER_OBSERVED"
  | "EXCLUDED_NO_OFFER"
  | "EXCLUDED_ERROR";

export interface UncrustablesLivePriceAuditRow {
  sku: string;
  asin: string;
  store_index: number;
  cohort_membership: CohortMembership;
  exclusion_reason: string | null;
  count: number | null;
  assigned_arm: "A" | "B" | null;
  active_arm: "A" | "B" | null;
  lever: string | null;
  canonical_base_price: number | null;
  canonical_floor_price: number | null;
  canonical_effective_price: number | null;
  discount_percent: number | null;
  launch_phase_at_observation: LaunchPhase;
  expected_listing_price: number | null;
  expected_listing_price_basis:
    | "PRELAUNCH_BASE"
    | "ACTIVE_COUPON_BASE"
    | "ACTIVE_SALE_PRICE"
    | "POSTLAUNCH_BASE"
    | null;
  observation: ProductPricingObservation;
  live_vs_base: PriceRelation;
  live_vs_floor: PriceRelation;
  live_vs_effective: PriceRelation;
  live_vs_expected: PriceRelation;
  live_minus_base: number | null;
  live_minus_floor: number | null;
  live_minus_effective: number | null;
  live_minus_expected: number | null;
  reconciliation_status: LivePriceReconciliationStatus;
}

export interface UncrustablesLivePriceReconciliation {
  rows: UncrustablesLivePriceAuditRow[];
  summary: {
    offer: number;
    no_offer: number;
    error: number;
    active_match_expected: number;
    active_below_expected: number;
    active_above_expected: number;
    active_below_floor: number;
    active_no_offer: number;
    active_error: number;
    excluded_offer_observed: number;
    excluded_no_offer: number;
    excluded_error: number;
    by_reconciliation_status: Record<LivePriceReconciliationStatus, number>;
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stableJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot seal a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonValue).join(",")}]`;
  }
  if (isRecord(value)) {
    const fields = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJsonValue(child)}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error(`Cannot seal unsupported JSON value type ${typeof value}.`);
}

export function stableAuditJson(value: unknown): string {
  return stableJsonValue(value);
}

export function auditSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function livePriceAuditBodySha256(body: unknown): string {
  return auditSha256(stableAuditJson(body));
}

function finiteMoney(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

function finiteCount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function priceAmount(value: unknown): { amount: number | null; currency: string | null } {
  const record = isRecord(value) ? value : {};
  return {
    amount: finiteMoney(record.Amount),
    currency:
      typeof record.CurrencyCode === "string" && record.CurrencyCode.trim()
        ? record.CurrencyCode.trim()
        : null,
  };
}

function ownOffer(value: unknown): ProductPricingOwnOffer | null {
  if (!isRecord(value)) return null;
  const listing = priceAmount(value.ListingPrice);
  const shipping = priceAmount(value.Shipping);
  if (listing.amount == null) return null;
  const shippingAmount = shipping.amount ?? 0;
  return {
    listing_price: listing.amount,
    shipping: shippingAmount,
    landed_price: Math.round((listing.amount + shippingAmount) * 100) / 100,
    currency: listing.currency ?? shipping.currency,
    is_buy_box_winner: value.IsBuyBoxWinner === true,
    is_featured_merchant: value.IsFeaturedMerchant === true,
  };
}

function errorObservation(input: {
  identity: UncrustablesPriceIdentity;
  observedAt: string;
  requestAttempts: number;
  requestErrors: string[];
  responseBodySha256?: string | null;
  errorCode: string;
  errorMessage: string;
  totalOfferCount?: number | null;
  ownOfferCount?: number | null;
  buyBoxLandedPrice?: number | null;
}): ProductPricingObservation {
  return {
    ...input.identity,
    observed_at: input.observedAt,
    request_attempts: input.requestAttempts,
    request_errors: input.requestErrors,
    state: "ERROR",
    effective_live_price: null,
    effective_live_price_source: null,
    seller_shipping: null,
    seller_landed_price: null,
    currency: null,
    is_buy_box_winner: null,
    is_featured_merchant: null,
    total_offer_count: input.totalOfferCount ?? null,
    own_offer_count: input.ownOfferCount ?? null,
    buy_box_landed_price: input.buyBoxLandedPrice ?? null,
    response_body_sha256: input.responseBodySha256 ?? null,
    error_code: input.errorCode,
    error_message: input.errorMessage,
  };
}

export function productPricingErrorObservation(input: {
  identity: UncrustablesPriceIdentity;
  observedAt: string;
  requestAttempts: number;
  requestErrors: string[];
  errorCode?: string;
  errorMessage: string;
}): ProductPricingObservation {
  return errorObservation({
    ...input,
    errorCode: input.errorCode ?? "PRODUCT_PRICING_REQUEST_FAILED",
  });
}

/**
 * Parse the body returned by GET /products/pricing/v0/listings/{sku}/offers.
 * Only MyOffer is authoritative for this seller. A competitor or Buy Box price
 * is never silently substituted for the seller's live listing price.
 */
export function parseProductPricingObservation(input: {
  identity: UncrustablesPriceIdentity;
  responseBody: unknown;
  observedAt: string;
  requestAttempts: number;
  requestErrors?: string[];
}): ProductPricingObservation {
  const requestErrors = input.requestErrors ?? [];
  const responseBodySha256 = livePriceAuditBodySha256(input.responseBody);
  const wrapper = isRecord(input.responseBody) ? input.responseBody : null;
  const payload = wrapper && isRecord(wrapper.payload) ? wrapper.payload : wrapper;
  if (!payload || !Array.isArray(payload.Offers)) {
    return errorObservation({
      identity: input.identity,
      observedAt: input.observedAt,
      requestAttempts: input.requestAttempts,
      requestErrors,
      responseBodySha256,
      errorCode: "MALFORMED_PRODUCT_PRICING_RESPONSE",
      errorMessage: "Product Pricing response has no Offers array.",
    });
  }

  const summary = isRecord(payload.Summary) ? payload.Summary : {};
  const buyBoxPrices = Array.isArray(summary.BuyBoxPrices)
    ? summary.BuyBoxPrices
    : [];
  const firstBuyBox = isRecord(buyBoxPrices[0]) ? buyBoxPrices[0] : {};
  const buyBoxLandedPrice = priceAmount(firstBuyBox.LandedPrice).amount;
  const totalOfferCount = finiteCount(summary.TotalOfferCount);
  const rawOwnOffers = payload.Offers.filter(
    (candidate) => isRecord(candidate) && candidate.MyOffer === true,
  );

  if (rawOwnOffers.length === 0) {
    return {
      ...input.identity,
      observed_at: input.observedAt,
      request_attempts: input.requestAttempts,
      request_errors: requestErrors,
      state: "NO_OFFER",
      effective_live_price: null,
      effective_live_price_source: null,
      seller_shipping: null,
      seller_landed_price: null,
      currency: null,
      is_buy_box_winner: null,
      is_featured_merchant: null,
      total_offer_count: totalOfferCount,
      own_offer_count: 0,
      buy_box_landed_price: buyBoxLandedPrice,
      response_body_sha256: responseBodySha256,
      error_code: null,
      error_message: null,
    };
  }

  if (rawOwnOffers.length !== 1) {
    return errorObservation({
      identity: input.identity,
      observedAt: input.observedAt,
      requestAttempts: input.requestAttempts,
      requestErrors,
      responseBodySha256,
      errorCode: "AMBIGUOUS_MY_OFFER",
      errorMessage: `Product Pricing returned ${rawOwnOffers.length} MyOffer rows.`,
      totalOfferCount,
      ownOfferCount: rawOwnOffers.length,
      buyBoxLandedPrice,
    });
  }

  const mine = ownOffer(rawOwnOffers[0]);
  if (!mine) {
    return errorObservation({
      identity: input.identity,
      observedAt: input.observedAt,
      requestAttempts: input.requestAttempts,
      requestErrors,
      responseBodySha256,
      errorCode: "MY_OFFER_PRICE_MISSING",
      errorMessage: "The sole MyOffer row has no finite non-negative ListingPrice.Amount.",
      totalOfferCount,
      ownOfferCount: 1,
      buyBoxLandedPrice,
    });
  }

  if (mine.currency != null && mine.currency !== "USD") {
    return errorObservation({
      identity: input.identity,
      observedAt: input.observedAt,
      requestAttempts: input.requestAttempts,
      requestErrors,
      responseBodySha256,
      errorCode: "UNEXPECTED_CURRENCY",
      errorMessage: `Expected USD but MyOffer uses ${mine.currency}.`,
      totalOfferCount,
      ownOfferCount: 1,
      buyBoxLandedPrice,
    });
  }

  return {
    ...input.identity,
    observed_at: input.observedAt,
    request_attempts: input.requestAttempts,
    request_errors: requestErrors,
    state: "OFFER",
    effective_live_price: mine.listing_price,
    effective_live_price_source: "MY_OFFER_LISTING_PRICE",
    seller_shipping: mine.shipping,
    seller_landed_price: mine.landed_price,
    currency: mine.currency,
    is_buy_box_winner: mine.is_buy_box_winner,
    is_featured_merchant: mine.is_featured_merchant,
    total_offer_count: totalOfferCount,
    own_offer_count: 1,
    buy_box_landed_price: buyBoxLandedPrice,
    response_body_sha256: responseBodySha256,
    error_code: null,
    error_message: null,
  };
}

export function launchPhaseAt(
  instant: string,
  startAt: string,
  endAt: string,
): LaunchPhase {
  const instantMs = Date.parse(instant);
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (![instantMs, startMs, endMs].every(Number.isFinite) || endMs <= startMs) {
    throw new Error("Cannot determine launch phase from invalid timestamps.");
  }
  if (instantMs < startMs) return "PRELAUNCH";
  if (instantMs <= endMs) return "ACTIVE";
  return "POSTLAUNCH";
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function relation(live: number | null, expected: number | null): PriceRelation {
  if (live == null || expected == null) return "UNAVAILABLE";
  const delta = cents(live) - cents(expected);
  return delta === 0 ? "MATCH" : delta < 0 ? "BELOW" : "ABOVE";
}

function moneyDelta(live: number | null, expected: number | null): number | null {
  if (live == null || expected == null) return null;
  return Math.round((live - expected) * 100) / 100;
}

function expectedPrice(input: {
  row: UncrustablesLaunchPricingRow;
  phase: LaunchPhase;
}): {
  value: number;
  basis:
    | "PRELAUNCH_BASE"
    | "ACTIVE_COUPON_BASE"
    | "ACTIVE_SALE_PRICE"
    | "POSTLAUNCH_BASE";
} {
  if (input.phase === "PRELAUNCH") {
    return { value: input.row.base_price, basis: "PRELAUNCH_BASE" };
  }
  if (input.phase === "POSTLAUNCH") {
    return { value: input.row.base_price, basis: "POSTLAUNCH_BASE" };
  }
  return input.row.arm === "A"
    ? { value: input.row.base_price, basis: "ACTIVE_COUPON_BASE" }
    : { value: input.row.effective_price, basis: "ACTIVE_SALE_PRICE" };
}

export function reconcileUncrustablesLivePriceRow(input: {
  identity: UncrustablesPriceIdentity;
  proposalRow: UncrustablesLaunchPricingRow | null;
  observation: ProductPricingObservation;
  membership: CohortMembership;
  exclusionReason: string | null;
  startAt: string;
  endAt: string;
}): UncrustablesLivePriceAuditRow {
  if (
    input.observation.sku !== input.identity.sku ||
    input.observation.asin !== input.identity.asin ||
    input.observation.store_index !== input.identity.store_index
  ) {
    throw new Error(`Observation identity mismatch for ${input.identity.sku}.`);
  }
  if (input.membership !== "PRE_ASSIGNMENT_EXCLUDED" && !input.proposalRow) {
    throw new Error(`Assigned cohort member ${input.identity.sku} has no proposal row.`);
  }
  if (input.membership === "PRE_ASSIGNMENT_EXCLUDED" && input.proposalRow) {
    throw new Error(`Pre-assignment exclusion ${input.identity.sku} unexpectedly has an arm.`);
  }

  const row = input.proposalRow;
  const active = input.membership === "ACTIVE";
  const phase = launchPhaseAt(
    input.observation.observed_at,
    input.startAt,
    input.endAt,
  );
  const expected = active && row ? expectedPrice({ row, phase }) : null;
  const live = input.observation.effective_live_price;
  const liveVsFloor = relation(live, row?.floor_price ?? null);

  let status: LivePriceReconciliationStatus;
  if (!active) {
    status =
      input.observation.state === "ERROR"
        ? "EXCLUDED_ERROR"
        : input.observation.state === "NO_OFFER"
          ? "EXCLUDED_NO_OFFER"
          : "EXCLUDED_OFFER_OBSERVED";
  } else if (input.observation.state === "ERROR") {
    status = "ERROR";
  } else if (input.observation.state === "NO_OFFER") {
    status = "NO_OFFER";
  } else if (liveVsFloor === "BELOW") {
    status = "BELOW_FLOOR";
  } else {
    const liveVsExpected = relation(live, expected?.value ?? null);
    status =
      liveVsExpected === "MATCH"
        ? "MATCH_EXPECTED"
        : liveVsExpected === "BELOW"
          ? "BELOW_EXPECTED"
          : "ABOVE_EXPECTED";
  }

  return {
    ...input.identity,
    cohort_membership: input.membership,
    exclusion_reason: input.exclusionReason,
    count: row?.count ?? null,
    assigned_arm: row?.arm ?? null,
    active_arm: active ? (row?.arm ?? null) : null,
    lever: row?.lever ?? null,
    canonical_base_price: row?.base_price ?? null,
    canonical_floor_price: row?.floor_price ?? null,
    canonical_effective_price: row?.effective_price ?? null,
    discount_percent: row?.discount_percent ?? null,
    launch_phase_at_observation: phase,
    expected_listing_price: expected?.value ?? null,
    expected_listing_price_basis: expected?.basis ?? null,
    observation: input.observation,
    live_vs_base: relation(live, row?.base_price ?? null),
    live_vs_floor: liveVsFloor,
    live_vs_effective: relation(live, row?.effective_price ?? null),
    live_vs_expected: relation(live, expected?.value ?? null),
    live_minus_base: moneyDelta(live, row?.base_price ?? null),
    live_minus_floor: moneyDelta(live, row?.floor_price ?? null),
    live_minus_effective: moneyDelta(live, row?.effective_price ?? null),
    live_minus_expected: moneyDelta(live, expected?.value ?? null),
    reconciliation_status: status,
  };
}

function emptyStatusCounts(): Record<LivePriceReconciliationStatus, number> {
  return {
    MATCH_EXPECTED: 0,
    BELOW_EXPECTED: 0,
    ABOVE_EXPECTED: 0,
    BELOW_FLOOR: 0,
    NO_OFFER: 0,
    ERROR: 0,
    EXCLUDED_OFFER_OBSERVED: 0,
    EXCLUDED_NO_OFFER: 0,
    EXCLUDED_ERROR: 0,
  };
}

/**
 * Reconcile the exact sealed 164 identities against the exact v4 proposal.
 * This function performs no I/O and intentionally rejects partial scopes.
 */
export function reconcileExactUncrustablesLivePrices(input: {
  identities: UncrustablesPriceIdentity[];
  manifest: UncrustablesLaunchPricingManifest;
  observations: ProductPricingObservation[];
}): UncrustablesLivePriceReconciliation {
  if (
    input.identities.length !== UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE ||
    input.observations.length !== UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE
  ) {
    throw new Error("Live price audit requires exactly 164 identities and observations.");
  }

  const identities = [...input.identities].sort((left, right) =>
    left.sku.localeCompare(right.sku),
  );
  const identityBySku = new Map<string, UncrustablesPriceIdentity>();
  const identityByAsin = new Map<string, UncrustablesPriceIdentity>();
  for (const identity of identities) {
    if (
      !identity.sku ||
      !identity.asin ||
      !Number.isInteger(identity.store_index) ||
      identity.store_index <= 0 ||
      identityBySku.has(identity.sku) ||
      identityByAsin.has(identity.asin)
    ) {
      throw new Error(`Invalid or duplicate exact-scope identity ${identity.sku || "<missing>"}.`);
    }
    identityBySku.set(identity.sku, identity);
    identityByAsin.set(identity.asin, identity);
  }

  const proposalBySku = new Map(
    input.manifest.rows.map((row) => [row.sku, row] as const),
  );
  const assignedExclusionBySku = new Map(
    input.manifest.exclusions.map((row) => [row.sku, row] as const),
  );
  const preAssignmentExclusionBySku = new Map(
    input.manifest.pre_assignment_exclusions.map((row) => [row.sku, row] as const),
  );

  for (const row of input.manifest.rows) {
    const identity = identityBySku.get(row.sku);
    if (!identity || identity.asin !== row.asin) {
      throw new Error(`Proposal row ${row.sku}/${row.asin} is outside the sealed 164 scope.`);
    }
  }
  for (const exclusion of input.manifest.pre_assignment_exclusions) {
    const identity = identityBySku.get(exclusion.sku);
    if (
      !identity ||
      identity.asin !== exclusion.asin ||
      proposalBySku.has(exclusion.sku)
    ) {
      throw new Error(`Pre-assignment exclusion ${exclusion.sku} is not an exact unassigned cohort member.`);
    }
  }

  const observationBySku = new Map<string, ProductPricingObservation>();
  for (const observation of input.observations) {
    if (observationBySku.has(observation.sku)) {
      throw new Error(`Duplicate Product Pricing observation for ${observation.sku}.`);
    }
    observationBySku.set(observation.sku, observation);
  }

  const rows = identities.map((identity) => {
    const proposalRow = proposalBySku.get(identity.sku) ?? null;
    const assignedExclusion = assignedExclusionBySku.get(identity.sku);
    const preAssignmentExclusion = preAssignmentExclusionBySku.get(identity.sku);
    if ((proposalRow ? 1 : 0) + (preAssignmentExclusion ? 1 : 0) !== 1) {
      throw new Error(`Sealed cohort member ${identity.sku} is missing from or duplicated in v4 proposal coverage.`);
    }
    if (assignedExclusion && !proposalRow) {
      throw new Error(`Assigned exclusion ${identity.sku} has no proposal row.`);
    }
    const observation = observationBySku.get(identity.sku);
    if (!observation) {
      throw new Error(`Missing Product Pricing observation for ${identity.sku}.`);
    }
    const membership: CohortMembership = preAssignmentExclusion
      ? "PRE_ASSIGNMENT_EXCLUDED"
      : assignedExclusion
        ? "ASSIGNED_EXCLUDED"
        : "ACTIVE";
    return reconcileUncrustablesLivePriceRow({
      identity,
      proposalRow,
      observation,
      membership,
      exclusionReason:
        assignedExclusion?.reason ?? preAssignmentExclusion?.reason ?? null,
      startAt: input.manifest.scope.start_at,
      endAt: input.manifest.scope.end_at,
    });
  });

  if (
    rows.filter((row) => row.cohort_membership === "ACTIVE").length !==
      input.manifest.scope.active_rows ||
    rows.filter((row) => row.cohort_membership === "ASSIGNED_EXCLUDED").length !==
      input.manifest.scope.excluded_rows ||
    rows.filter((row) => row.cohort_membership === "PRE_ASSIGNMENT_EXCLUDED").length !==
      input.manifest.scope.pre_assignment_excluded_rows
  ) {
    throw new Error("Exact cohort membership does not reconcile to the v4 proposal scope.");
  }

  const byStatus = emptyStatusCounts();
  for (const row of rows) byStatus[row.reconciliation_status]++;
  const summary = {
    offer: rows.filter((row) => row.observation.state === "OFFER").length,
    no_offer: rows.filter((row) => row.observation.state === "NO_OFFER").length,
    error: rows.filter((row) => row.observation.state === "ERROR").length,
    active_match_expected: byStatus.MATCH_EXPECTED,
    active_below_expected: byStatus.BELOW_EXPECTED,
    active_above_expected: byStatus.ABOVE_EXPECTED,
    active_below_floor: byStatus.BELOW_FLOOR,
    active_no_offer: byStatus.NO_OFFER,
    active_error: byStatus.ERROR,
    excluded_offer_observed: byStatus.EXCLUDED_OFFER_OBSERVED,
    excluded_no_offer: byStatus.EXCLUDED_NO_OFFER,
    excluded_error: byStatus.EXCLUDED_ERROR,
    by_reconciliation_status: byStatus,
  };
  return { rows, summary };
}
