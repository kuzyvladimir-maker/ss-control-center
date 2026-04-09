// Historical weather data via Open-Meteo (free, no API key required)

export interface WeatherData {
  tempF: number | null;
  feelsLikeF: number | null;
  highF: number | null;
  description: string | null;
}

// WMO Weather codes to descriptions
const weatherCodes: Record<number, string> = {
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

export async function getHistoricalWeather(
  lat: number,
  lon: number,
  date: string // YYYY-MM-DD
): Promise<WeatherData | null> {
  try {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", lat.toString());
    url.searchParams.set("longitude", lon.toString());
    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);
    url.searchParams.set(
      "hourly",
      "temperature_2m,apparent_temperature,weather_code"
    );
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min"
    );
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "America/New_York");

    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const data = await res.json();

    // Get midday values (index 12 = noon)
    const hourlyTemps: number[] = data.hourly?.temperature_2m || [];
    const hourlyFeelsLike: number[] =
      data.hourly?.apparent_temperature || [];
    const hourlyWeatherCodes: number[] = data.hourly?.weather_code || [];
    const dailyMax: number[] = data.daily?.temperature_2m_max || [];

    const noonIdx = 12; // noon hour
    const tempF = hourlyTemps[noonIdx] ?? null;
    const feelsLikeF = hourlyFeelsLike[noonIdx] ?? null;
    const highF = dailyMax[0] ?? null;
    const weatherCode = hourlyWeatherCodes[noonIdx];
    const description =
      weatherCode !== undefined
        ? weatherCodes[weatherCode] || `Code ${weatherCode}`
        : null;

    return { tempF, feelsLikeF, highF, description };
  } catch (err) {
    console.error(`Weather fetch failed for ${lat},${lon} on ${date}:`, err);
    return null;
  }
}
