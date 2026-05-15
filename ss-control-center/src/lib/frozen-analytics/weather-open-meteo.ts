// Open-Meteo client for proactive (forecast + climate-normal) lookups.
// Historical lookups still go through the existing src/lib/weather.ts —
// that uses archive-api.open-meteo.com which only covers past dates.
//
// API is free, no key required.
//   Forecast (today + up to 16 days):   https://api.open-meteo.com/v1/forecast
//   Climate normals (30-year):          https://climate-api.open-meteo.com/v1/climate

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  tempMaxF: number;
  tempMinF: number;
  feelsLikeMaxF: number;
  weatherCode: number; // WMO code
  weatherDesc: string;
}

export interface ClimateNormal {
  date: string;
  meanTempF: number; // 30-year average
}

const WMO_CODE_DESC: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeCode(code: number): string {
  return WMO_CODE_DESC[code] || `Code ${code}`;
}

export async function fetchForecast(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<WeatherDay[]> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,apparent_temperature_max,weathercode",
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Open-Meteo forecast failed: ${res.status}`);
  const data = (await res.json()) as {
    daily?: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      apparent_temperature_max: number[];
      weathercode: number[];
    };
  };
  const daily = data.daily;
  if (!daily?.time) return [];
  return daily.time.map((date, i) => ({
    date,
    tempMaxF: daily.temperature_2m_max[i],
    tempMinF: daily.temperature_2m_min[i],
    feelsLikeMaxF: daily.apparent_temperature_max[i],
    weatherCode: daily.weathercode[i],
    weatherDesc: describeCode(daily.weathercode[i]),
  }));
}

// Climate normals are optional — when the climate API is down, anomaly stays
// null and the modifier rules just don't fire. Returns [] rather than
// throwing so the pipeline keeps running.
export async function fetchClimateNormals(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<ClimateNormal[]> {
  const url = new URL("https://climate-api.open-meteo.com/v1/climate");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("models", "MRI_AGCM3_2_S");
  url.searchParams.set("daily", "temperature_2m_mean");
  url.searchParams.set("temperature_unit", "fahrenheit");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn(`[frozen-v2] climate normals unavailable: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as {
      daily?: { time: string[]; temperature_2m_mean: number[] };
    };
    if (!data.daily?.time) return [];
    return data.daily.time.map((date, i) => ({
      date,
      meanTempF: data.daily!.temperature_2m_mean[i],
    }));
  } catch (err) {
    console.warn("[frozen-v2] climate normals fetch threw:", err);
    return [];
  }
}
