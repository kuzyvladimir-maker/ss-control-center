// ZIP code to lat/lon coordinates via Zippopotam.us (free, no API key)

export interface GeoResult {
  lat: number;
  lon: number;
  city: string;
  state: string;
}

export async function zipToCoords(zip: string): Promise<GeoResult | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, {
      next: { revalidate: 86400 }, // cache 24h
    });
    if (!res.ok) return null;

    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return null;

    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      city: place["place name"] || "",
      state: place["state abbreviation"] || "",
    };
  } catch {
    console.error(`Geocoding failed for ZIP ${zip}`);
    return null;
  }
}
