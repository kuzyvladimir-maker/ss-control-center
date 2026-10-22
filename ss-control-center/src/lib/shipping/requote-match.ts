/**
 * Find the planned service in the live Veeqo rate pool at buy time.
 *
 * The plan picks Frozen rates through the new Rate Shopping API
 * (POST /shipping/api/v1/rates, anchored to the PHYSICAL ship day). Those
 * quotes have no remote_shipment_id and their per-quote id (`rate_id`, stored
 * as serviceType) never exists in the allocation pool the buy re-quotes
 * (GET /shipping/rates/{allocation}). So the buy falls back to the service
 * itself: carrier + title.
 *
 * That fallback used to be an exact title compare, which broke on
 * date-dependent variants. Order 111-5099040-5027461 (2026-10-22): the plan
 * quoted "Fedex 2Day® One Rate (Saturday)" for shipping TODAY, but the GET
 * pool is anchored to the order's Veeqo dispatch_date (the later Amazon
 * ship-by), where 2Day doesn't land on a Saturday, so there was no
 * "(Saturday)" rate among the 23 live ones. Result: "no rate match …
 * remote_shipment_id=null", buy refused.
 *
 * Tiers, strongest first:
 *   1. "id"    — same per-quote id (serviceType === live `name`).
 *   2. "title" — same carrier + same title (case/®/spacing-insensitive).
 *   3. "base"  — same carrier + same title once a "(Saturday)"-style suffix
 *                is dropped, AND it delivers no later than the planned EDD,
 *                so a fallback can never quietly buy a slower delivery.
 * Tiers 2–3 are a DIFFERENT quote than the one on the card, so they also
 * have to pass a price guard: no more than max($1, 5%) above the plan.
 *
 * Pure: the route supplies live rates and the plan item; nothing here talks to
 * Veeqo or buys anything.
 */

import { utcToPacificYMD } from "./dates";

export interface LiveRate {
  name?: unknown;
  title?: unknown;
  sub_carrier_id?: unknown;
  total_net_charge?: unknown;
  delivery_promise_date?: unknown;
  [key: string]: unknown;
}

export interface PlannedService {
  /** Per-quote id from the plan (new API rate_id / old API name). */
  serviceType: string | null;
  /** Display title, e.g. "Fedex 2Day® One Rate (Saturday)". */
  service: string | null;
  /** "FEDEX" | "UPS" | "USPS". */
  subCarrierId: string | null;
  /** Planned price (USD). */
  price: number | null;
  /** Planned EDD, YYYY-MM-DD (Pacific). */
  edd: string | null;
}

export type MatchTier = "id" | "title" | "base";

export interface RequoteMatch<R extends LiveRate> {
  rate: R | null;
  tier: MatchTier | null;
  /** Why nothing was taken — plain English for the operator. */
  reason: string | null;
  /** Closest live alternatives, for the operator to pick — never auto-bought. */
  alternatives: string[];
}

/** Absolute floor of the price guard (USD). */
export const REQUOTE_PRICE_TOLERANCE_USD = 1;
/** Relative part of the price guard. */
export const REQUOTE_PRICE_TOLERANCE_PCT = 0.05;

export function normTitle(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title without trailing "(…)" variants such as "(Saturday)". */
export function baseTitle(s: unknown): string {
  return normTitle(s).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

const priceOf = (r: LiveRate) => Number.parseFloat(String(r.total_net_charge ?? ""));
const eddOf = (r: LiveRate) =>
  r.delivery_promise_date ? utcToPacificYMD(String(r.delivery_promise_date)) : null;
const carrierOf = (r: LiveRate) => String(r.sub_carrier_id ?? "").toUpperCase();

export function maxAcceptablePrice(planned: number): number {
  return (
    planned +
    Math.max(REQUOTE_PRICE_TOLERANCE_USD, planned * REQUOTE_PRICE_TOLERANCE_PCT)
  );
}

function fmtRate(r: LiveRate): string {
  const p = priceOf(r);
  const edd = eddOf(r);
  return `${String(r.title ?? "?")} $${Number.isFinite(p) ? p.toFixed(2) : "?"}${
    edd ? ` (arrives ${edd})` : ""
  }`;
}

/** Up to 3 live rates that arrive by the planned EDD, cheapest first; same
 *  carrier listed first. Falls back to the cheapest overall when none do. */
function alternativesFor(live: LiveRate[], want: PlannedService): string[] {
  const priced = live.filter((r) => Number.isFinite(priceOf(r)) && priceOf(r) > 0);
  const onTime = want.edd
    ? priced.filter((r) => {
        const e = eddOf(r);
        return e != null && e <= want.edd!;
      })
    : priced;
  const pool = onTime.length > 0 ? onTime : priced;
  const carrier = (want.subCarrierId ?? "").toUpperCase();
  return [...pool]
    .sort((a, b) => {
      const ca = carrierOf(a) === carrier ? 0 : 1;
      const cb = carrierOf(b) === carrier ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return priceOf(a) - priceOf(b);
    })
    .slice(0, 3)
    .map(fmtRate);
}

export function matchLiveRate<R extends LiveRate>(
  live: R[],
  want: PlannedService,
): RequoteMatch<R> {
  const carrier = (want.subCarrierId ?? "").toUpperCase();

  // 1. Same quote id.
  if (want.serviceType) {
    const hit = live.find((r) => String(r.name ?? "") === want.serviceType);
    if (hit) return { rate: hit, tier: "id", reason: null, alternatives: [] };
  }

  const sameCarrier = live.filter((r) => carrierOf(r) === carrier);
  const priceOk = (r: LiveRate) => {
    if (want.price == null || !Number.isFinite(want.price)) return true;
    const p = priceOf(r);
    return Number.isFinite(p) && p <= maxAcceptablePrice(want.price);
  };

  // 2. Same carrier + same title.
  const full = normTitle(want.service);
  const byTitle = full ? sameCarrier.filter((r) => normTitle(r.title) === full) : [];
  // 3. Same carrier + base title, delivering no later than planned.
  const base = baseTitle(want.service);
  const byBase = base
    ? sameCarrier.filter((r) => {
        if (normTitle(r.title) === full) return false; // already tier 2
        if (baseTitle(r.title) !== base) return false;
        if (!want.edd) return true;
        const e = eddOf(r);
        return e != null && e <= want.edd;
      })
    : [];

  const cheapest = (rs: R[]) =>
    [...rs].sort((a, b) => priceOf(a) - priceOf(b))[0] ?? null;

  for (const [tier, rs] of [
    ["title", byTitle],
    ["base", byBase],
  ] as const) {
    const ok = rs.filter(priceOk);
    if (ok.length > 0) {
      return { rate: cheapest(ok), tier, reason: null, alternatives: [] };
    }
  }

  // Found the service, but only at a higher price → say so, buy nothing.
  const pricey = cheapest([...byTitle, ...byBase]);
  if (pricey && want.price != null) {
    return {
      rate: null,
      tier: null,
      reason:
        `"${want.service}" now costs $${priceOf(pricey).toFixed(2)} — ` +
        `more than the planned $${want.price.toFixed(2)} ` +
        `(limit $${maxAcceptablePrice(want.price).toFixed(2)}).`,
      alternatives: alternativesFor(live, want),
    };
  }

  return {
    rate: null,
    tier: null,
    reason:
      `"${want.service ?? want.serviceType}" is not among the ${live.length} ` +
      `live rates for this ship date${want.edd ? ` (needed by ${want.edd})` : ""}.`,
    alternatives: alternativesFor(live, want),
  };
}
