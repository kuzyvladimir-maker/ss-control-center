/**
 * The "deliver by" date the rate filter enforces.
 *
 * Amazon and Walmart give a real delivery promise in Veeqo's `due_date`, and
 * missing it costs us, so it is enforced as-is.
 *
 * Other channels (Shopify / NAN health, eBay, TikTok, direct) have no delivery
 * promise the marketplace enforces. On Shopify, Veeqo fills `due_date` with
 * the SHIP-BY day. Order #1371 (2026-10-23): due_date = today, so the filter
 * demanded "delivered today", every one of the 24 rates failed it, and the
 * order stopped with no way to buy. The same happened to #1352 and #1358.
 * So on these channels a due_date that is not AFTER the ship day is not a
 * delivery deadline. We fall back to a generous window and let the engine pick
 * the cheapest rate.
 */

import { utcToPacificYMD } from "./dates";

/** Window for channels without a delivery promise: ship day + this many days. */
export const NO_PROMISE_WINDOW_DAYS = 10;

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveDeliveryBy(args: {
  /** Veeqo order.due_date (ISO) — may be null. */
  dueDate: string | null | undefined;
  /** Veeqo order.dispatch_date (ISO) — may be null. */
  dispatchDate: string | null | undefined;
  /** Our ship day, YYYY-MM-DD. */
  shipDay: string;
  /** true for Amazon / Walmart: their due_date is an enforced promise. */
  enforcedDeadline: boolean;
}): { deliveryBy: string; source: "due_date" | "window" } {
  const due = args.dueDate ? utcToPacificYMD(args.dueDate) : null;
  if (due && (args.enforcedDeadline || due > args.shipDay)) {
    return { deliveryBy: due, source: "due_date" };
  }
  const base = args.dispatchDate ? utcToPacificYMD(args.dispatchDate) : args.shipDay;
  // Never anchor the window before the day we actually ship.
  const anchor = base > args.shipDay ? base : args.shipDay;
  return { deliveryBy: addDays(anchor, NO_PROMISE_WINDOW_DAYS), source: "window" };
}
