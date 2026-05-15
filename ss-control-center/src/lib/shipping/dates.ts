// Per-order date model for shipping labels. Implements §0.1 of
// MASTER_PROMPT v3.3 — every order has TWO dates:
//
//   labelDate         the date Amazon sees on the label (drives the
//                     Late Shipment Rate). Defaults to today; only
//                     pushed to next business day when shipBy > today
//                     AND it's already past the 3 PM ET cutoff.
//
//   physicalShipDate  the day the package actually leaves the
//                     warehouse. Same as labelDate for normal orders;
//                     pushed to next Monday when the Frozen Ship Date
//                     Trick fires.
//
// The Trick lives in `/api/shipping/plan` because computing it needs
// live rates from Veeqo; this module only owns the cutoff + business
// day plumbing.

import Holidays from "date-holidays";

const CUTOFF_HOUR_NY = 15; // 3 PM ET — §0.1 MASTER_PROMPT v3.3
const hd = new Holidays("US");

// Pull the NY-local date and hour out of the current wall clock. We
// use Intl.DateTimeFormat rather than Date#getHours because that
// returns the runtime TZ — which on Vercel is UTC, not NY — and we'd
// then need offset arithmetic that's brittle around DST.
function nyParts(): { y: string; m: string; d: string; hour: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return {
    y: p.find((x) => x.type === "year")!.value,
    m: p.find((x) => x.type === "month")!.value,
    d: p.find((x) => x.type === "day")!.value,
    hour: Number(p.find((x) => x.type === "hour")!.value),
  };
}

// Treat Sat/Sun and US federal holidays as non-business days. The
// holiday lib emits multiple records per date (e.g. "Christmas Day"
// + "Christmas Eve observance"); we count the day as a holiday only
// when at least one record is a `public` or `bank` holiday — `school`
// or `observance` aren't enforced by carriers.
export function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = hd.isHoliday(d);
  if (h && Array.isArray(h)) {
    return !h.some((x) => x.type === "public" || x.type === "bank");
  }
  return true;
}

export function nextBusinessDay(d: Date): Date {
  const next = new Date(d);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isBusinessDay(next));
  return next;
}

// YYYY-MM-DD for "now" in America/New_York.
export function todayNY(): string {
  const p = nyParts();
  return `${p.y}-${p.m}-${p.d}`;
}

export function isAfterCutoff(): boolean {
  return nyParts().hour >= CUTOFF_HOUR_NY;
}

// Per-order labelDate. shipByYMD is YYYY-MM-DD in NY TZ.
//
//   shipBy < today      → today  (overdue — minimise the damage)
//   shipBy == today     → today  (deadline today, no slack to spend)
//   shipBy >  today     → today  if before cutoff, else nextBusinessDay
//
// Cutoff only applies when there's slack (shipBy > today). Pushing
// the label to tomorrow when shipBy is *today* would itself violate
// the marketplace ship-by promise — better to keep today's label even
// after the cutoff.
export function computeLabelDate(shipByYMD: string): string {
  const today = todayNY();
  const todayDate = new Date(`${today}T12:00:00`);
  const shipByDate = new Date(`${shipByYMD}T12:00:00`);

  if (shipByDate <= todayDate) return today;
  if (!isAfterCutoff()) return today;
  return ymd(nextBusinessDay(todayDate));
}

// Next Monday strictly after `ymd` (so "given Monday" returns the
// following Monday). Skips federal holidays — if the candidate Monday
// is a holiday, slide forward to the next business day. Used by the
// Frozen Ship Date Trick when today's pool has no rate that delivers
// within 3 calendar days.
export function nextMondayFrom(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== 1);
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return ymdFromDate(d);
}

function ymd(d: Date): string {
  return ymdFromDate(d);
}

// Local-frame YYYY-MM-DD. We deliberately avoid `toISOString` here —
// that returns UTC, and a noon-NY date can land on the previous UTC
// day, which produces the same off-by-one bug we just fixed in the
// Frozen EDD filter.
function ymdFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
