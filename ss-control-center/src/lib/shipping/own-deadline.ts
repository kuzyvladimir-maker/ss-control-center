/**
 * Our own ship-by deadline for orders the marketplace gives none.
 *
 * Amazon and Walmart send a ship-by (Veeqo `dispatch_date` / `due_date`), so
 * those orders land in Overdue / Today / Tomorrow on their own. Orders from
 * channels without one (e.g. the NAN health Shopify store) had no bucket at
 * all and slipped out of sight. Owner's rule (2026-10-21): ship-by = the day
 * the order was placed + 2 days. The UI marks it as OUR deadline, not the
 * marketplace's.
 */

import { utcToPacificYMD } from "./dates";

/** Days from placement to our ship-by deadline. */
export const OWN_SHIP_BY_DAYS = 2;

export type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";

/** Add calendar days to a YYYY-MM-DD string (no time-zone drift). */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Our ship-by for an order placed at `placedAt` (Veeqo `created_at`),
 * anchored in Pacific like every other shipping date. Null when the
 * placement date is missing or unreadable.
 */
export function ownShipBy(
  placedAt: string | number | Date | null | undefined,
): string | null {
  if (placedAt == null || placedAt === "") return null;
  const d = new Date(placedAt);
  if (Number.isNaN(d.getTime())) return null;
  return addDaysYmd(utcToPacificYMD(d), OWN_SHIP_BY_DAYS);
}

/** Bucket a YYYY-MM-DD deadline relative to today's YYYY-MM-DD. */
export function bucketForYmd(ymd: string, todayYmd: string): ShipByBucket {
  const diffDays = Math.round(
    (new Date(`${ymd}T00:00:00Z`).getTime() -
      new Date(`${todayYmd}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === 2) return "dayafter";
  return "later";
}
