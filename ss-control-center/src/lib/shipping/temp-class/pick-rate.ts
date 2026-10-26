// Temperature-aware rate pick.
//
// Same decision procedure as the summer profile (src/lib/shipping/
// rate-selection.ts) but the transit cap comes from the weather-driven days
// table instead of a flat 2/3. Owner rules (topic 135, 2026-10-23):
//
//   1. Drop every rate that misses the marketplace deadline OR exceeds the
//      allowed days for its class/size/weather.
//   2. Take the cheapest remaining rate; a faster one wins only when it costs
//      at most $1 more ($3 when the route is hot, M > 20 °C — same reasoning as
//      summer's flat $3: a day earlier is worth pennies, not dollars).
//   3. Next Day / overnight is never auto-bought (buyer must have paid for it);
//      the operator can still force it via the Carrier override.
//   4. Upsizing the cooler is not offered (136/136 historical cases were
//      $10–16 more expensive — see the plan doc).
//
// Pure: takes a quoted rate list + the class/size/weather, returns the pick.
// The Monday-shift and the summer fallback stay in the caller.

import { veeqoDateToLocal } from "@/lib/veeqo";
import type { VeeqoRate } from "@/lib/shipping/rate-selection";
import type { TempClass } from "./classes";
import type { CoolerSize } from "./ice";
import { allowedDays, type WeatherForClass } from "./days-table";

// No speed premium (owner 2026-10-26): among the rates inside the allowed
// transit window the CHEAPEST wins; a faster one only on an exact price tie.
// (It used to pay up to $1, or $3 on a hot route, for a faster rate — e.g. a
// 2-day UPS Ground $13.18 over a $10.48 3-day rate inside a 3-day limit.)
const SPEED_TOLERANCE_USD = 0;
const SPEED_TOLERANCE_HOT_USD = 0;

const NEXT_DAY_RE = /next day|overnight|priority mail express/i;

export function isNextDay(rate: Pick<VeeqoRate, "title" | "name">): boolean {
  return NEXT_DAY_RE.test(rate.title || "") || NEXT_DAY_RE.test(rate.name || "");
}

export interface EnrichedRate extends VeeqoRate {
  eddLocal: string;
  calDays: number;
  price: number;
  meetsDeadline: boolean;
}

function enrich(
  rates: VeeqoRate[],
  deliveryBy: string,
  shipDay: string,
): EnrichedRate[] {
  const deliveryByDate = new Date(deliveryBy + "T23:59:59");
  const shipDate = new Date(shipDay + "T00:00:00");
  return rates
    .map((rate) => {
      const eddLocal = veeqoDateToLocal(rate.delivery_promise_date);
      const eddDate = new Date(eddLocal + "T00:00:00");
      const calDays = Math.round(
        (eddDate.getTime() - shipDate.getTime()) / 86_400_000,
      );
      return {
        ...rate,
        eddLocal,
        calDays,
        price: parseFloat(rate.total_net_charge),
        meetsDeadline: eddDate <= deliveryByDate,
      };
    })
    .filter((r) => r.meetsDeadline && r.price > 0);
}

export interface TempAwareSelection {
  rate: EnrichedRate | null;
  allowedDays: number;
  extraIce: number;
  reason: string;
  reasonRu?: string;
  /** NaN allowedDays means "no forecast" — caller must use the summer profile. */
  noForecast: boolean;
  diagnostic: string;
}

/**
 * Pick the best temperature-aware rate. `weather` null inputs (no forecast)
 * returns noForecast=true so the caller falls back to summer.
 */
export function selectTempAwareRate(args: {
  rates: VeeqoRate[];
  tempClass: TempClass;
  size: CoolerSize;
  deliveryBy: string;
  shipDay: string;
  weather: WeatherForClass;
  hasIncident?: boolean;
  /** The summer v3.5 cap for this order (3 days, 2 on a Frozen Analytics heat
   *  alert). The weather table may ADD days but never allow fewer than summer
   *  (owner 2026-10-26: winter must be cheaper, never stricter). */
  summerCapDays?: number;
}): TempAwareSelection {
  const { rates, tempClass, size, deliveryBy, shipDay, weather, hasIncident } =
    args;

  const dr = allowedDays({
    tempClass,
    size,
    weather,
    hasIncident,
    summerCapDays: args.summerCapDays,
  });
  const base = {
    allowedDays: dr.allowedDays,
    extraIce: dr.extraIce,
    reason: dr.reason,
    reasonRu: dr.reasonRu,
  };

  if (Number.isNaN(dr.allowedDays)) {
    return {
      rate: null,
      ...base,
      noForecast: true,
      diagnostic: `[temp-rate] ${dr.reason}`,
    };
  }

  const enriched = enrich(rates, deliveryBy, shipDay)
    // Cold-chain cap (DRY = Infinity, so unaffected).
    .filter((r) => r.calDays <= dr.allowedDays)
    // Never auto-buy Next Day.
    .filter((r) => !isNextDay(r));

  if (enriched.length === 0) {
    return {
      rate: null,
      ...base,
      noForecast: false,
      diagnostic:
        `[temp-rate] ${tempClass} ${size} cap=${dr.allowedDays}d ` +
        `ice+${dr.extraIce} · 0 candidates after deadline/cap/next-day filter`,
    };
  }

  const cheapest = Math.min(...enriched.map((r) => r.price));
  const hot = (weather.routeMaxC ?? -Infinity) > 20;
  const tol = hot ? SPEED_TOLERANCE_HOT_USD : SPEED_TOLERANCE_USD;
  const candidates = enriched.filter((r) => r.price - cheapest <= tol + 0.005);
  candidates.sort((a, b) => {
    if (a.calDays !== b.calDays) return a.calDays - b.calDays; // fewer days first
    const dt =
      new Date(a.eddLocal).getTime() - new Date(b.eddLocal).getTime();
    if (dt !== 0) return dt;
    return a.price - b.price;
  });

  const pick = candidates[0];
  const diagnostic =
    `[temp-rate] ${tempClass} ${size} ${dr.reason} cap=${dr.allowedDays}d ` +
    `ice+${dr.extraIce} tol=$${tol} cheapest=$${cheapest.toFixed(2)} → ` +
    `${pick.title}/$${pick.price.toFixed(2)}/${pick.calDays}d/${pick.eddLocal}`;

  return {
    rate: pick,
    ...base,
    noForecast: false,
    diagnostic,
  };
}
