// Temperature-aware shipping rate engine (frozen / chilled / dry).
//
// Owner spec: topic 135, 2026-10-23. Design doc:
// docs/wiki/frozen-weather-rate-selection-plan-2026-10-23.md.
// Summer profile (Master Prompt v3.5) stays untouched in
// src/lib/shipping/rate-selection.ts and is the one-switch rollback.

export * from "./classes";
export * from "./ice";
export * from "./days-table";
export * from "./resolve-class";
export * from "./pick-rate";
export * from "./shadow";
export * from "./profile";
export * from "./engine-line";
export * from "./card-class";
export * from "./manual-class";
export { getRouteWeather, CLEARWATER_LAT, CLEARWATER_LON } from "./weather";
export type { RouteWeather } from "./weather";
