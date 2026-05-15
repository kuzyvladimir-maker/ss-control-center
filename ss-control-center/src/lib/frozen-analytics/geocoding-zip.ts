// ZIP → coordinates wrapper for Frozen Analytics v2.
//
// Reuses src/lib/geocoding.ts (Zippopotam.us, free, 24h-cached) instead of
// pulling in `uszipcode-typed` (~2MB) — see docs/dev-log/frozen-v2-progress.md
// Divergence #3. If Zippopotam.us 404s on a sparse rural ZIP, we fall back
// to Open-Meteo's geocoding endpoint.

import { zipToCoords } from "@/lib/geocoding";

export interface ZipLocation {
  zip: string;
  lat: number;
  lon: number;
  city: string;
  state: string; // 2-letter
}

export async function lookupZip(zip: string): Promise<ZipLocation | null> {
  const cleaned = zip.trim().slice(0, 5); // strip ZIP+4
  if (!/^\d{5}$/.test(cleaned)) return null;
  const r = await zipToCoords(cleaned);
  if (!r) return null;
  return {
    zip: cleaned,
    lat: r.lat,
    lon: r.lon,
    city: r.city || "Unknown",
    state: r.state || "XX",
  };
}

// Open-Meteo geocoding fallback. Returns the first match for the ZIP-as-name
// query, scoped to the US. Less accurate than Zippopotam for ZIP codes but
// good enough for rural areas Zippopotam misses.
export async function geocodeFallback(
  zip: string,
): Promise<ZipLocation | null> {
  const cleaned = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(cleaned)) return null;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${cleaned}&country=US&count=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        latitude: number;
        longitude: number;
        name: string;
        admin1_code?: string;
      }>;
    };
    const first = data.results?.[0];
    if (!first) return null;
    return {
      zip: cleaned,
      lat: first.latitude,
      lon: first.longitude,
      city: first.name,
      state: first.admin1_code || "XX",
    };
  } catch {
    return null;
  }
}

export async function resolveZip(zip: string): Promise<ZipLocation | null> {
  return (await lookupZip(zip)) ?? (await geocodeFallback(zip));
}
