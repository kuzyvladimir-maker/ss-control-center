// The rate-choosing rules — Master Prompt v3.5 — in ONE place.
//
// This logic used to live inside /api/shipping/plan only, which meant a merged
// group had no algorithm at all: the operator read a price list and picked a
// line by hand. Same box, same food, same deadline — but a different (human)
// decision procedure. Moving it here lets the merged-group quote run the exact
// same code as a single order, so "Frozen, 11×6×8, 5 lb" resolves to the same
// carrier whether the box holds one order or three.
//
// Nothing here talks to Veeqo or the DB: it takes a quoted rate list and
// returns which one to buy. That's deliberate — the callers differ in how they
// fetch rates (allocation rates vs the Rate Shopping API) but must not differ
// in how they choose.

import { veeqoDateToLocal } from "@/lib/veeqo";

// ── Veeqo rate shape (actual API fields) ──
export interface VeeqoRate {
  carrier: string; // "amazon_shipping_v2"
  name: string; // full service identifier for purchase
  title: string; // display: "UPS® Ground", "FedEx Ground Economy"
  short_title: string;
  total_net_charge: string;
  base_rate: string;
  delivery_promise_date: string;
  sub_carrier_id: string; // "UPS", "FEDEX", "USPS"
  service_carrier: string; // "ups", "fedex", "usps"
  remote_shipment_id: string;
  service_id: string;
  [key: string]: unknown;
}

/**
 * Frozen calendar-day cap. Master Prompt v3.4 §5 tightens the transit
 * cap from "≤3 days" to "≤2 days" when the FrozenRiskAlert rates the
 * destination as `high` OR `critical` — hot destinations / multi-day
 * high-temp routes that put the food itself at risk regardless of
 * marketplace deadline math.
 * (Vladimir 2026-06-09: BOTH high and critical → 2 days, not critical
 *  only.) For all other levels (ok/low/medium or no alert) the default
 * ≤3-day cap applies.
 */
export function frozenMaxCalDays(riskLevel: string | null | undefined): number {
  const lvl = (riskLevel ?? "").toLowerCase();
  return lvl === "critical" || lvl === "high" ? 2 : 3;
}

// Master Prompt v3.5 (Vladimir 2026-06-12): among valid Frozen rates take the
// cheapest, BUT prefer a faster one when it costs no more than this many
// dollars MORE (absolute, not percentage). "$3 on a $13 rate is 23% — sounds
// like a lot by percent, but it's pennies for a day-earlier delivery, so take
// it; the same 25% on a $32 rate is +$8 and not worth it. Judge in dollars."
export const FROZEN_SPEED_TOLERANCE_USD = 3;

// Master Prompt v3.5: the Monday-shift wins only when shipping Monday is more
// than this fraction CHEAPER than shipping today (or when today has no valid
// rate at all). Below the threshold we just ship today.
export const MONDAY_SHIFT_MIN_SAVING_PCT = 0.15;

// ── Select best rate ──
// Rates use actual Veeqo field names:
//   sub_carrier_id = "UPS"/"FEDEX"/"USPS"
//   title = "UPS® Ground", "FedEx 2Day" etc.
//   total_net_charge = price string
//   delivery_promise_date = ISO date
// All date conversion goes through `veeqoDateToLocal` from
// veeqo/client.ts, which renders YYYY-MM-DD in America/Los_Angeles —
// the same TZ Veeqo's own UI uses for ship-by and EDD. A previous
// workaround helper (`eddNYDate`) used America/New_York, which made
// our EDD column read one day later than Veeqo's and pushed cheaper
// rates like UPS Ground Saver out of the deadline filter.
export function selectBestRate(
  rates: VeeqoRate[],
  productType: string,
  deliveryBy: string,
  actualShipDay: string,
  dayName: string,
  isAfterNoon: boolean,
  frozenRiskLevel: string | null = null
): { rate: VeeqoRate | null; diagnostic: string | null } {
  const deliveryByDate = new Date(deliveryBy + "T23:59:59");
  const shipDate = new Date(actualShipDay + "T00:00:00");

  const enriched = rates
    .map((rate) => {
      const eddLocal = veeqoDateToLocal(rate.delivery_promise_date);
      const eddDate = new Date(eddLocal + "T00:00:00");
      const calDays = Math.round(
        (eddDate.getTime() - shipDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      const carrierUp = (rate.sub_carrier_id || "").toUpperCase();
      const titleLow = (rate.title || "").toLowerCase();
      return {
        ...rate,
        eddLocal,
        eddDate,
        calDays,
        meetsDeadline: eddDate <= deliveryByDate,
        price: parseFloat(rate.total_net_charge),
        carrierUp,
        titleLow,
      };
    })
    .filter((r) => r.meetsDeadline && r.price > 0);

  if (enriched.length === 0) return { rate: null, diagnostic: null };

  // ── FROZEN (Master Prompt v3.5 — Vladimir 2026-06-12) ──
  //
  // A rate is VALID on exactly two conditions:
  //   1. EDD ≤ marketplace deadline  (already enforced in `enriched`)
  //   2. transit within the frozen window: calDays(EDD − shipDay) ≤ cap
  //      (cap = 2 when the destination is hot/critical, else 3)
  // Nothing else. All the old carrier exclusions (Ground Saver / Ground
  // Economy / tender-to-USPS), the Friday-FedEx-Express ban, the "no ground on
  // Wednesday" rule, and the percentage tolerance band were REMOVED per
  // Vladimir's explicit simplification — those two conditions are the whole
  // food-safety gate.
  //
  // Among valid rates: take the CHEAPEST, but prefer a faster one (fewer cal
  // days) when it costs no more than $FROZEN_SPEED_TOLERANCE_USD ABSOLUTE above
  // the cheapest (judge in dollars, not percent — see the constant's comment).
  if (productType === "Frozen") {
    const maxCalDays = frozenMaxCalDays(frozenRiskLevel);
    const pool = enriched.filter((r) => r.calDays <= maxCalDays);
    if (pool.length === 0) return { rate: null, diagnostic: null };

    const cheapest = Math.min(...pool.map((r) => r.price));
    const candidates = pool.filter(
      (r) => r.price - cheapest <= FROZEN_SPEED_TOLERANCE_USD,
    );
    candidates.sort((a, b) => {
      if (a.calDays !== b.calDays) return a.calDays - b.calDays; // fewer days first
      const dt = a.eddDate.getTime() - b.eddDate.getTime();
      if (dt !== 0) return dt; // earlier EDD
      return a.price - b.price; // then cheaper
    });

    // Diagnostic — a short trace the route handler attaches to planItem.notes
    // (visible in UI). Returned (not a module global) so the per-order loop can
    // run in parallel without races.
    let diagnostic: string | null = null;
    try {
      const cand = candidates
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d/${r.eddLocal}`);
      const riskTag =
        maxCalDays === 2 ? `risk=${(frozenRiskLevel ?? "").toLowerCase()}→max2d ` : "";
      const summary =
        `[frozen-rate v3.5] day=${dayName} ship=${actualShipDay} ` +
        `${riskTag}cap=${maxCalDays}d cheapest=$${cheapest.toFixed(2)} ` +
        `tol=$${FROZEN_SPEED_TOLERANCE_USD} cand=[${cand.join(" | ")}] ` +
        `picked=${candidates[0]?.title}/$${candidates[0]?.price.toFixed(2)}/${candidates[0]?.calDays}d/${candidates[0]?.eddLocal}`;
      console.log(summary);
      diagnostic = summary;
    } catch {
      /* logging must never break the buy flow */
    }
    return { rate: candidates[0], diagnostic };
  }

  // ── DRY ──
  //
  // Strict cheapest-that-meets-deadline. Previous version applied two
  // adjustments inherited from MASTER_PROMPT v3.1:
  //   - drop USPS after 12:00 ET (drop-off cut-off concern)
  //   - prefer UPS within 10% of cheapest (tracking reliability)
  // Both were removed by Vladimir's explicit decision on 2026-05-14: the
  // operator now picks the cheapest carrier regardless of who it is, and
  // does the cut-off / reliability judgement themselves looking at the
  // alt-rates list.
  // (isAfterNoon kept in the signature so call sites don't churn if the
  //  time-of-day rule comes back.)
  void isAfterNoon;
  // (No empty-pool guard here — the `enriched.length === 0` return near the top
  // of selectBestRate already covers it before the Frozen/Dry split.)
  const pool = [...enriched].sort((a, b) => a.price - b.price);
  return { rate: pool[0], diagnostic: null };
}

// Transit days (= calendar days in transit) for a pick, from its OWN ship day.
// Fewer transit days = less thaw risk for frozen.
export function transitDays(rawEdd: string, shipYmd: string): number {
  return Math.round(
    (new Date(veeqoDateToLocal(rawEdd) + "T00:00:00").getTime() -
      new Date(shipYmd + "T00:00:00").getTime()) /
      86_400_000,
  );
}

/**
 * Today vs Monday (Master Prompt v3.5 — Vladimir 2026-06-12).
 *
 * `selectBestRate` already guarantees BOTH picks meet the deadline AND the
 * frozen window, so BOTH are food-safe and on-time — within the window an
 * extra transit day does NOT harm the food. So the choice is economic. Take
 * Monday if:
 *   1. there's no valid rate today, OR
 *   2. Monday is FASTER in transit AND no more than
 *      $FROZEN_SPEED_TOLERANCE_USD pricier (a near-free speed-up — e.g.
 *      112-5404197: Mon FedEx 2Day 2d/$32.85 vs today FedEx Home 3d/$32.91), OR
 *   3. Monday is >MONDAY_SHIFT_MIN_SAVING_PCT cheaper — a big saving wins even
 *      if Monday takes one more transit day, as long as it's still in the
 *      window (e.g. 112-8268143: Mon 2Day $17.78 vs today Next Day Air Saturday
 *      $82.73 — both inside the 2-day window, so take the $17.78).
 * Otherwise keep today.
 */
export function chooseTodayOrMonday(args: {
  todayPick: VeeqoRate | null;
  mondayPick: VeeqoRate | null;
  todayShipDay: string;
  mondayShipDay: string;
}): { takeMonday: boolean; reason: string } {
  const { todayPick, mondayPick, todayShipDay, mondayShipDay } = args;
  const todayPrice = todayPick ? parseFloat(todayPick.total_net_charge) : Infinity;
  const mondayPrice = mondayPick ? parseFloat(mondayPick.total_net_charge) : Infinity;
  const todayTransit = todayPick
    ? transitDays(todayPick.delivery_promise_date, todayShipDay)
    : Infinity;
  const mondayTransit = mondayPick
    ? transitDays(mondayPick.delivery_promise_date, mondayShipDay)
    : Infinity;

  if (mondayPick && !todayPick) {
    return { takeMonday: true, reason: "no on-time rate from today" };
  }
  if (mondayPick && todayPick) {
    if (
      mondayTransit < todayTransit &&
      mondayPrice <= todayPrice + FROZEN_SPEED_TOLERANCE_USD
    ) {
      return {
        takeMonday: true,
        reason:
          `faster ${mondayTransit}d vs ${todayTransit}d transit` +
          ` (Mon $${mondayPrice.toFixed(2)} vs $${todayPrice.toFixed(2)})`,
      };
    }
    if (mondayPrice < todayPrice * (1 - MONDAY_SHIFT_MIN_SAVING_PCT)) {
      return {
        takeMonday: true,
        reason:
          `${Math.round((1 - mondayPrice / todayPrice) * 100)}% cheaper` +
          ` ($${todayPrice.toFixed(2)}→$${mondayPrice.toFixed(2)})`,
      };
    }
  }
  // Today is cheaper-or-similar (and not beaten on speed) → keep today.
  return { takeMonday: false, reason: "" };
}
