/**
 * Phase 0.1 — Attribute registry types.
 *
 * The registry is the single machine-readable contract for which attributes a
 * listing can/should carry per marketplace product type. The raw field lists
 * are pulled live from the marketplaces' own definition APIs (Amazon
 * getDefinitionsProductType, Walmart MP_ITEM spec) and bundled as JSON under
 * `./schemas/`. The fill-map (fill-map.ts) overlays HOW the builder fills each
 * field. Both the listing builder and the Qualification Officer read this one
 * registry so they never drift.
 */

/** Amazon product types we build under. Default GROCERY; PET_FOOD for pet. */
export type AmazonProductType =
  | "GROCERY"
  | "PET_FOOD"
  | "FOOD"
  | "GOURMET_FOOD"
  | "SNACK_FOOD"
  | "CHOCOLATE_CANDY"
  | "COFFEE"
  | "TEA";

/** How the builder obtains an attribute's value. */
export type FillSource =
  | "fixed" //   constant (brand, manufacturer, country = US, dg = not_applicable)
  | "catalog" // from the donor catalog (harvested content, photos, ingredients)
  | "computed" // derived (UPC from pool, price from model, count from pack)
  | "kb" //      from the marketplace KB (item_type_keyword, browse node, occasion)
  | "operator" // manual entry for now (weight, dims) — Phase-2 scaffold
  | "review"; //  no auto-source yet → the algorithm/QA Officer must consider it

/** One attribute as pulled from the marketplace schema. */
export interface RawAttr {
  key: string;
  label: string;
  /** Hard-required by the marketplace schema (top-level `required`). */
  required: boolean;
}

/** A registry entry = the raw attribute + how we fill it. */
export interface AttrSpec extends RawAttr {
  fill: FillSource;
  /** Human note: where the value comes from / why. */
  source?: string;
}
