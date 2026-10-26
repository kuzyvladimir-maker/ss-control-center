// Assemble the "shadow" result the card shows during the shadow week: what the
// temperature-aware engine WOULD pick, how much it would save versus the summer
// pick, the 4-/5-day prices summer never quoted, and the ice the warehouse
// would pack. Pure — the plan route feeds it the already-fetched rate list.

import { veeqoDateToLocal } from "@/lib/veeqo";
import type { VeeqoRate } from "@/lib/shipping/rate-selection";
import type { TempClass } from "./classes";
import { buildIcePlan, type CoolerSize } from "./ice";
import {
  selectTempAwareRate,
  isNextDay,
  type EnrichedRate,
} from "./pick-rate";
import type { WeatherForClass } from "./days-table";

export interface ShadowPick {
  carrier: string | null;
  service: string | null;
  price: number;
  edd: string;
  calDays: number;
}

export interface ShadowResult {
  tempClass: TempClass;
  size: CoolerSize;
  originMaxC: number | null;
  routeMaxC: number | null;
  allowedDays: number | null; // null = no cold-chain cap (dry) or no forecast
  extraIce: number;
  iceBase: number;
  iceTotal: number;
  iceWeightDeltaLb: number;
  pick: ShadowPick | null;
  summerPrice: number | null;
  /** summerPrice − pick.price; positive = the new logic is cheaper. */
  savingsUsd: number | null;
  /** Cheapest on-time rate at each longer transit summer never bought. */
  longerTransitPrices: Array<{ service: string; price: number; calDays: number; edd: string }>;
  iceNote: string;
  reason: string;
  /** Why this day limit, in plain Russian (card line). */
  reasonRu?: string;
  diagnostic: string;
  noForecast: boolean;
  /** Destination shown on the card's engine line (set by the plan route). */
  destCity?: string | null;
  destState?: string | null;
  destMaxC?: number | null;
}

function toPick(r: EnrichedRate | null): ShadowPick | null {
  if (!r) return null;
  return {
    carrier: r.sub_carrier_id || null,
    service: r.title || null,
    price: r.price,
    edd: r.eddLocal,
    calDays: r.calDays,
  };
}

function iceNoteText(
  tempClass: TempClass,
  size: CoolerSize,
  base: number,
  extra: number,
): string {
  const total = base + extra;
  const cls = tempClass.charAt(0) + tempClass.slice(1).toLowerCase();
  if (extra <= 0) return `${cls} · ${size} cooler · ${base} ice pieces (base)`;
  return (
    `${cls} · ${size} cooler · ${base} base + ${extra} extra ice = ${total} pieces ` +
    `(+${extra} lb on label)`
  );
}

export function buildShadowResult(args: {
  rates: VeeqoRate[];
  tempClass: TempClass;
  size: CoolerSize;
  deliveryBy: string;
  shipDay: string;
  weather: WeatherForClass;
  summerRate: VeeqoRate | null;
  hasIncident?: boolean;
  summerCapDays?: number;
}): ShadowResult {
  const {
    rates,
    tempClass,
    size,
    deliveryBy,
    shipDay,
    weather,
    summerRate,
    hasIncident,
  } = args;

  const sel = selectTempAwareRate({
    rates,
    tempClass,
    size,
    deliveryBy,
    shipDay,
    weather,
    hasIncident,
    summerCapDays: args.summerCapDays,
  });

  const ice = buildIcePlan(size, sel.extraIce);
  const pick = toPick(sel.rate);
  const summerPrice = summerRate
    ? parseFloat(summerRate.total_net_charge)
    : null;
  const savingsUsd =
    pick && summerPrice != null
      ? Math.round((summerPrice - pick.price) * 100) / 100
      : null;

  // Longer-transit prices summer never quoted (calDays ≥ 3, on time, not Next
  // Day): the cheapest rate at each transit length, so the owner sees what an
  // extra day in the truck actually costs.
  const deliveryByDate = new Date(deliveryBy + "T23:59:59");
  const shipDate = new Date(shipDay + "T00:00:00");
  const cheapestByDays = new Map<
    number,
    { service: string; price: number; calDays: number; edd: string }
  >();
  for (const r of rates) {
    if (isNextDay(r)) continue;
    const price = parseFloat(r.total_net_charge);
    if (!(price > 0)) continue;
    const eddLocal = veeqoDateToLocal(r.delivery_promise_date);
    const eddDate = new Date(eddLocal + "T00:00:00");
    if (eddDate > deliveryByDate) continue;
    const calDays = Math.round(
      (eddDate.getTime() - shipDate.getTime()) / 86_400_000,
    );
    if (calDays < 3) continue;
    const cur = cheapestByDays.get(calDays);
    if (!cur || price < cur.price) {
      cheapestByDays.set(calDays, {
        service: r.title || r.name || "rate",
        price,
        calDays,
        edd: eddLocal,
      });
    }
  }
  const longerTransitPrices = [...cheapestByDays.values()].sort(
    (a, b) => a.calDays - b.calDays,
  );

  return {
    tempClass,
    size,
    originMaxC: weather.originMaxC,
    routeMaxC: weather.routeMaxC,
    allowedDays: Number.isFinite(sel.allowedDays)
      ? sel.allowedDays
      : sel.noForecast
        ? null
        : null,
    extraIce: ice.extra,
    iceBase: ice.base,
    iceTotal: ice.total,
    iceWeightDeltaLb: ice.weightDeltaLb,
    pick,
    summerPrice,
    savingsUsd,
    longerTransitPrices,
    iceNote: iceNoteText(tempClass, size, ice.base, ice.extra),
    reason: sel.reason,
    reasonRu: sel.reasonRu,
    diagnostic: sel.diagnostic,
    noForecast: sel.noForecast,
  };
}
