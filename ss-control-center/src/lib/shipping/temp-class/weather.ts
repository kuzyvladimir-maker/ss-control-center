// Weather inputs for the temperature-aware rate engine.
//
// Produces the two numbers the days table needs (see days-table.ts):
//   A (originMaxC) — the daily max in Clearwater on the ship day and the day
//                    after: the first ~36 h, when the cold must hold.
//   M (routeMaxC)  — the max daily high at the route MIDPOINT and the
//                    DESTINATION over the remaining transit window. Carrier
//                    hubs are unknown, so the midpoint stands in for them.
//
// Source: Open-Meteo forecast (free, no key) — the same client Frozen
// Analytics already uses. Cached per (rounded lat/lon, date range) for 3 h so
// a dashboard pass over many orders to the same region makes one call.
//
// No forecast (API down, unknown ZIP) → both numbers come back null and the
// days table returns NaN, which makes the caller fall back to the summer
// profile rather than guess a window.

import { fetchForecast, type WeatherDay } from "@/lib/frozen-analytics/weather-open-meteo";
import { resolveZip } from "@/lib/frozen-analytics/geocoding-zip";
import type { WeatherForClass } from "./days-table";

// Clearwater, FL 33765 — the physical ship-from warehouse (1162 Kapp Dr).
// Overridable via env for a move; defaults to Clearwater, not the Tampa lat/lon
// the analytics pipeline uses for its origin.
export const CLEARWATER_LAT = Number(process.env.ORIGIN_CLEARWATER_LAT || "27.9659");
export const CLEARWATER_LON = Number(process.env.ORIGIN_CLEARWATER_LON || "-82.7637");

// The broadest cold-chain window we ever allow (chilled cap = 5). We read the
// route forecast across this many days after the ship day so M is the worst
// heat any candidate rate could cross — conservative (hotter ⇒ fewer days),
// which is the safe direction for food.
const MAX_WINDOW_DAYS = 5;

const F_TO_C = (f: number) => ((f - 32) * 5) / 9;

// ── 3-hour forecast cache keyed by rounded coords + date range ──
interface CacheEntry {
  at: number;
  days: WeatherDay[];
}
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const forecastCache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lon: number, start: string, end: string): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}:${start}:${end}`;
}

async function cachedForecast(
  lat: number,
  lon: number,
  start: string,
  end: string,
): Promise<WeatherDay[] | null> {
  const key = cacheKey(lat, lon, start, end);
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.days;
  try {
    const days = await fetchForecast(lat, lon, start, end);
    forecastCache.set(key, { at: Date.now(), days });
    return days;
  } catch (e) {
    console.warn(
      `[temp-class weather] forecast failed for ${lat},${lon} ${start}..${end}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/** Add `n` days to a YYYY-MM-DD string (UTC-frame math, no TZ drift). */
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function maxMaxC(days: WeatherDay[] | null): number | null {
  if (!days || days.length === 0) return null;
  const highs = days.map((d) => d.tempMaxF).filter((v) => Number.isFinite(v));
  if (highs.length === 0) return null;
  return F_TO_C(Math.max(...highs));
}

export interface RouteWeather extends WeatherForClass {
  /** Resolved destination coords (null when the ZIP couldn't be geocoded). */
  destCity: string | null;
  destState: string | null;
  /** Destination max over the transit window, °C (part of routeMaxC). */
  destMaxC: number | null;
}

/**
 * Compute A (Clearwater) and M (route midpoint + destination) for an order.
 * `shipDay` is YYYY-MM-DD. Any failure degrades gracefully to null inputs so
 * the caller falls back to the summer profile.
 */
export async function getRouteWeather(
  destZip: string,
  shipDay: string,
): Promise<RouteWeather> {
  // A — Clearwater max over [shipDay, shipDay+1].
  const originDays = await cachedForecast(
    CLEARWATER_LAT,
    CLEARWATER_LON,
    shipDay,
    addDays(shipDay, 1),
  );
  const originMaxC = maxMaxC(originDays);

  // Geocode the destination; without it we can't compute M.
  const dest = (await resolveZip(destZip).catch(() => null)) ?? null;
  if (!dest) {
    return {
      originMaxC,
      routeMaxC: null,
      destCity: null,
      destState: null,
      destMaxC: null,
    };
  }

  // M — midpoint + destination max over [shipDay+1, shipDay+MAX_WINDOW_DAYS].
  const midLat = (CLEARWATER_LAT + dest.lat) / 2;
  const midLon = (CLEARWATER_LON + dest.lon) / 2;
  const mStart = addDays(shipDay, 1);
  const mEnd = addDays(shipDay, MAX_WINDOW_DAYS);
  const [midDays, destDays] = await Promise.all([
    cachedForecast(midLat, midLon, mStart, mEnd),
    cachedForecast(dest.lat, dest.lon, mStart, mEnd),
  ]);
  const midMax = maxMaxC(midDays);
  const destMax = maxMaxC(destDays);
  const routeMaxC =
    midMax == null && destMax == null
      ? null
      : Math.max(midMax ?? -Infinity, destMax ?? -Infinity);

  return {
    originMaxC,
    routeMaxC: routeMaxC === -Infinity ? null : routeMaxC,
    destCity: dest.city,
    destState: dest.state,
    destMaxC: destMax,
  };
}

/** Testing seam — let unit tests prime/clear the forecast cache. */
export function __setForecastCache(
  lat: number,
  lon: number,
  start: string,
  end: string,
  days: WeatherDay[],
): void {
  forecastCache.set(cacheKey(lat, lon, start, end), { at: Date.now(), days });
}
export function __clearForecastCache(): void {
  forecastCache.clear();
}
