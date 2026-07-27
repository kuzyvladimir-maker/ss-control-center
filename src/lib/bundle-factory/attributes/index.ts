/**
 * Bundle Factory — attribute registry (Phase 0.1).
 *
 * The single machine-readable contract for marketplace listing attributes,
 * pulled live from the marketplaces' definition APIs. Read by the listing
 * builder (fills them) and the Qualification Officer (checks them).
 */

export * from "./types";
export * from "./registry";
export { FILL_MAP } from "./fill-map";
