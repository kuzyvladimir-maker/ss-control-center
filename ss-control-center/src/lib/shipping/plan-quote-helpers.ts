/**
 * Pure helpers for the shipping plan's carrier quotes (/api/shipping/plan).
 *
 * 1. retryIfEmptyRates — Veeqo sometimes answers a rate request with HTTP 200
 *    and an EMPTY list (`quotes: []` on POST /shipping/api/v1/rates,
 *    `available: []` on GET /shipping/rates/{allocation}), then returns the
 *    full list a second later. On 2026-11-27 that flicker stopped valid orders
 *    with "No rate where EDD ≤ Delivery By. 0 rates checked." An empty answer
 *    is now retried twice (0.6s, then 1.4s) before the plan believes it.
 *    A thrown error is NOT retried here — veeqoFetch already retries 429/5xx.
 *
 * 2. effectiveBuyWeightLbs + alignRateToReweightedQuote — the plan quoted the
 *    catalog weight, but the buy pushes a heavier package before it re-quotes:
 *    catalog weight + extra gel ice (Live engine), then ×1.20 for FedEx One
 *    Rate (fedex-weight.ts). The buy's price guard then saw a higher price than
 *    the card and refused the label — 112-1171076-0579460 ($15.88 → $17.52) and
 *    113-8220504-0305829 ($27.78 → $32.61), 2026-11-27. The plan now re-quotes
 *    the picked service once at the weight the buy will push and takes that
 *    price, so card and buy agree.
 *
 * Nothing here talks to Veeqo: the route passes the fetchers / rate lists in.
 */

import { normTitle } from "./requote-match";
import { utcToPacificYMD } from "./dates";
import {
  FEDEX_ONE_RATE_WEIGHT_MULT,
  isFedexOneRateService,
} from "./fedex-weight";
import { ICE_WEIGHT_PER_PIECE_LB } from "./temp-class/ice";

// ── 1. Empty-quote retry ────────────────────────────────────────────────

/** Default waits between attempts when Veeqo returns an empty rate list. */
export const EMPTY_RATES_RETRY_DELAYS_MS = [600, 1400] as const;

/** True when a rate response carries at least one rate in `available`. */
export function hasRates(resp: unknown): boolean {
  const list = (resp as { available?: unknown } | null | undefined)?.available;
  return Array.isArray(list) && list.length > 0;
}

export interface RetryIfEmptyOptions<T> {
  /** Waits before each retry; length = number of retries. */
  retryDelaysMs?: readonly number[];
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** What counts as "empty". Default: no rates in `available`. */
  isEmpty?: (resp: T) => boolean;
  /** Called before each retry (for logging). `attempt` starts at 1. */
  onRetry?: (attempt: number, delayMs: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`; while its answer is empty, wait and run it again, up to
 * `retryDelaysMs.length` extra times. Returns the first non-empty answer, or
 * the last (empty) one when every attempt was empty. Errors propagate as-is.
 */
export async function retryIfEmptyRates<T>(
  fn: () => Promise<T>,
  opts: RetryIfEmptyOptions<T> = {},
): Promise<T> {
  const delays = opts.retryDelaysMs ?? EMPTY_RATES_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  const isEmpty = opts.isEmpty ?? ((r: T) => !hasRates(r));
  let resp = await fn();
  for (let i = 0; i < delays.length && isEmpty(resp); i++) {
    opts.onRetry?.(i + 1, delays[i]);
    await sleep(delays[i]);
    resp = await fn();
  }
  return resp;
}

// ── 2. Weight the buy will push ─────────────────────────────────────────

/**
 * The package weight (lbs) the buy route pushes to Veeqo before it re-quotes
 * the label. Mirrors buy/route.ts exactly: the plan item's weight is catalog +
 * extra ice; the buy multiplies THAT by 1.20 for FedEx One Rate and rounds to
 * hundredths. Returns the base weight unchanged when neither applies.
 */
export function effectiveBuyWeightLbs(args: {
  baseWeightLbs: number;
  liveIceExtra?: number | null;
  serviceTitle?: string | null;
}): number {
  const ice = Math.max(0, args.liveIceExtra ?? 0);
  const withIce =
    ice > 0 ? args.baseWeightLbs + ice * ICE_WEIGHT_PER_PIECE_LB : args.baseWeightLbs;
  return isFedexOneRateService(args.serviceTitle)
    ? Math.round(withIce * FEDEX_ONE_RATE_WEIGHT_MULT * 100) / 100
    : withIce;
}

export interface QuotedRate {
  name?: unknown;
  title?: unknown;
  sub_carrier_id?: unknown;
  total_net_charge?: unknown;
  base_rate?: unknown;
  delivery_promise_date?: unknown;
  remote_shipment_id?: unknown;
  [key: string]: unknown;
}

const priceOf = (r: QuotedRate) =>
  Number.parseFloat(String(r.total_net_charge ?? ""));

/**
 * The rate for the SAME service (same carrier + same title, case/®/spacing-
 * insensitive) in another quote — e.g. the re-quote at the buy weight.
 * Only priced rates count; the cheapest wins if Veeqo lists a service twice.
 */
export function findMatchingRateByCarrierAndTitle<R extends QuotedRate>(
  rates: R[],
  target: { sub_carrier_id?: unknown; title?: unknown },
): R | null {
  const carrier = String(target.sub_carrier_id ?? "").toUpperCase();
  const title = normTitle(target.title);
  if (!carrier || !title) return null;
  const hits = rates.filter(
    (r) =>
      String(r.sub_carrier_id ?? "").toUpperCase() === carrier &&
      normTitle(r.title) === title &&
      Number.isFinite(priceOf(r)) &&
      priceOf(r) > 0,
  );
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (priceOf(b) < priceOf(a) ? b : a));
}

export interface ReweightAlignment<R> {
  /** The rate to save — the original when nothing safe was found. */
  rate: R;
  changed: boolean;
  /** Plain-English reason when the original was kept. */
  reason: string | null;
}

const eddDay = (r: QuotedRate) =>
  r.delivery_promise_date
    ? utcToPacificYMD(String(r.delivery_promise_date))
    : null;

/**
 * Take the price of the picked service from a re-quote at the buy weight.
 * Only the price / quote-identity fields move (total_net_charge, base_rate,
 * delivery_promise_date, name, remote_shipment_id); the service itself never
 * changes. Kept unchanged when the service is missing from the re-quote, or
 * when the re-quote would deliver LATER than the pick (the plan's deadline and
 * food-safety checks were made on the original EDD — never weaken them).
 */
export function alignRateToReweightedQuote<R extends QuotedRate>(
  selected: R,
  requoted: QuotedRate[],
): ReweightAlignment<R> {
  const m = findMatchingRateByCarrierAndTitle(requoted, selected);
  if (!m) {
    return {
      rate: selected,
      changed: false,
      reason: `"${String(selected.title ?? "?")}" not in the re-quote at buy weight`,
    };
  }
  const before = eddDay(selected);
  const after = eddDay(m);
  if (before && after && after > before) {
    return {
      rate: selected,
      changed: false,
      reason: `re-quote at buy weight delivers later (${after} > ${before})`,
    };
  }
  const next: R = {
    ...selected,
    total_net_charge: m.total_net_charge,
    base_rate: m.base_rate ?? m.total_net_charge,
    delivery_promise_date: m.delivery_promise_date ?? selected.delivery_promise_date,
    name: m.name ?? selected.name,
    remote_shipment_id: m.remote_shipment_id ?? selected.remote_shipment_id,
  };
  return { rate: next, changed: true, reason: null };
}
