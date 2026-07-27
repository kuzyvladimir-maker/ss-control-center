// Unit conversion + display helpers. Centralised so when we add a per-user
// settings toggle (Setting table) the whole app flips by changing one place.
// Open-Meteo returns Fahrenheit, so internally we store F and convert at the
// UI boundary. Default is metric — Vladimir operates in °C.

export type TempUnit = "celsius" | "fahrenheit";

export const DEFAULT_TEMP_UNIT: TempUnit = "celsius";

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

/** Absolute temperature display, e.g. 93°F → "34°C". */
export function formatTemp(
  fahrenheit: number | null | undefined,
  unit: TempUnit = DEFAULT_TEMP_UNIT,
): string {
  if (fahrenheit == null || Number.isNaN(fahrenheit)) return "—";
  if (unit === "fahrenheit") return `${Math.round(fahrenheit)}°F`;
  return `${Math.round(fToC(fahrenheit))}°C`;
}

/** Temperature DIFFERENCE display (anomaly). 1°F diff = 5/9°C diff = ~0.56°C.
 *  e.g. +8°F anomaly → "+4°C". Sign is preserved. */
export function formatAnomaly(
  fahrenheitDiff: number | null | undefined,
  unit: TempUnit = DEFAULT_TEMP_UNIT,
): string {
  if (fahrenheitDiff == null || Number.isNaN(fahrenheitDiff)) return "";
  const value =
    unit === "celsius" ? (fahrenheitDiff * 5) / 9 : fahrenheitDiff;
  const rounded = Math.round(value);
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded}°${unit === "celsius" ? "C" : "F"}`;
}

/** "°C" or "°F" — for inline use in messages built piece-by-piece. */
export function tempUnitSymbol(unit: TempUnit = DEFAULT_TEMP_UNIT): string {
  return unit === "celsius" ? "°C" : "°F";
}
