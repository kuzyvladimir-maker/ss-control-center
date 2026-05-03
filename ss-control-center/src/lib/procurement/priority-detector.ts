/**
 * Decide whether a Veeqo order qualifies as "priority" — the kind that
 * deserves a Telegram nudge so Vladimir doesn't miss the cutoff.
 *
 * Per spec, priority = ANY of:
 *   - Premium flag (orange "Premium" badge in Veeqo)
 *   - Shipping method matches Next Day / Two Day / Expedited / Same Day
 *   - Expected dispatch date is today or tomorrow (NY time)
 *
 * Inputs are typed loosely because Veeqo response shape drifts.
 */

const EXPRESS_KEYWORDS = [
  "next day",
  "one-day",
  "1-day",
  "1 day",
  "next-day",
  "two-day",
  "two day",
  "2-day",
  "2nd day",
  "same day",
  "same-day",
  "expedited",
  "express",
  "overnight",
  "priority mail",
  "priority overnight",
];

interface OrderShape {
  is_premium?: unknown;
  priority?: unknown;
  delivery_method?: { name?: unknown } | null;
  expected_dispatch_date?: unknown;
  deliver_by?: unknown;
}

function getDayInNY(d: Date): string {
  // YYYY-MM-DD in America/New_York
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function dayOffsetFromNYToday(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const target = getDayInNY(d);
  const today = getDayInNY(new Date());
  const t = new Date(`${target}T00:00:00`);
  const n = new Date(`${today}T00:00:00`);
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return null;
  return Math.round((t.getTime() - n.getTime()) / (24 * 60 * 60 * 1000));
}

export interface PriorityReason {
  kind: "premium" | "express-shipping" | "tight-dispatch";
  detail: string;
}

export function detectPriority(
  order: OrderShape | null | undefined
): PriorityReason | null {
  if (!order) return null;

  if (order.is_premium === true || order.priority === "premium") {
    return { kind: "premium", detail: "Premium" };
  }

  const method = order.delivery_method?.name;
  if (typeof method === "string" && method) {
    const lower = method.toLowerCase();
    for (const kw of EXPRESS_KEYWORDS) {
      if (lower.includes(kw)) {
        return { kind: "express-shipping", detail: method };
      }
    }
  }

  // Tight dispatch: today (offset=0) or tomorrow (offset=1) in NY tz.
  const offsetDispatch = dayOffsetFromNYToday(order.expected_dispatch_date);
  const offsetShipBy = dayOffsetFromNYToday(order.deliver_by);
  const tightest =
    offsetDispatch !== null && offsetShipBy !== null
      ? Math.min(offsetDispatch, offsetShipBy)
      : (offsetDispatch ?? offsetShipBy);
  if (tightest !== null && tightest <= 1) {
    return {
      kind: "tight-dispatch",
      detail: tightest <= 0 ? "сегодня" : "завтра",
    };
  }

  return null;
}
