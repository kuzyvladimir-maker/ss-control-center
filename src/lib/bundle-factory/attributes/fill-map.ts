/**
 * Phase 0.1 — Fill-map overlay.
 *
 * For each Amazon attribute key we KNOW how to source, this maps it to a
 * FillSource + a short note. Keys not listed here default to `review` — i.e.
 * the algorithm and the Qualification Officer must look at every column the
 * schema exposes and decide (fill / skip / needs-data), per the owner rule
 * "consider every attribute even if not every one gets filled".
 *
 * Keyed by the Amazon attribute name (shared across GROCERY/FOOD/PET_FOOD/etc.).
 */

import type { FillSource } from "./types";

export const FILL_MAP: Record<string, { fill: FillSource; source: string }> = {
  // ── Identity / brand (fixed) ──────────────────────────────────────────────
  brand: { fill: "fixed", source: "house brand (Salutem Vita / Starfit)" },
  manufacturer: { fill: "fixed", source: "Salutem Solutions LLC" },
  country_of_origin: { fill: "fixed", source: "US" },
  supplier_declared_dg_hz_regulation: { fill: "fixed", source: "not_applicable" },
  externally_assigned_product_identifier: { fill: "computed", source: "UPC from UPCPool" },
  merchant_suggested_asin: { fill: "review", source: "only if matching an existing ASIN" },

  // ── Content (catalog → Claude adapts) ─────────────────────────────────────
  item_name: { fill: "catalog", source: "Claude title from donor data + brand voice" },
  product_description: { fill: "catalog", source: "Claude description from donor data" },
  bullet_point: { fill: "catalog", source: "Claude bullets from donor data + disclaimer" },
  generic_keyword: { fill: "catalog", source: "search terms from donor + theme" },

  // ── Category placement (KB) ───────────────────────────────────────────────
  item_type_keyword: { fill: "kb", source: "KB per category/product type" },
  recommended_browse_nodes: { fill: "kb", source: "browse-node-resolver (gift-basket positioning)" },

  // ── Food compliance (reviewed manufacturer facts only) ────────────────────
  ingredients: { fill: "catalog", source: "donor.ingredients" },
  allergen_information: { fill: "review", source: "structured manufacturer-label declaration" },
  nutritional_info: { fill: "catalog", source: "donor.nutritionFacts" },
  is_expiration_dated_product: { fill: "review", source: "manufacturer label or operator verification" },
  fc_shelf_life: { fill: "review", source: "from donor if available" },

  // ── Composition / counts (computed) ───────────────────────────────────────
  number_of_items: { fill: "computed", source: "bundle pack_count" },
  item_package_quantity: { fill: "computed", source: "bundle pack_count" },
  unit_count: { fill: "review", source: "net unit count if derivable from size" },
  flavor: { fill: "catalog", source: "donor.flavor" },
  cuisine: { fill: "catalog", source: "donor / theme" },

  // ── Gifting / merchandising (KB defaults) ─────────────────────────────────
  gift_options: { fill: "kb", source: "gift defaults" },
  occasion_type: { fill: "kb", source: "occasion defaults (Birthday/Christmas/…)" },
  is_gift: { fill: "fixed", source: "true" },

  // ── Pricing / offer (computed) ────────────────────────────────────────────
  list_price: { fill: "computed", source: "pricing model × COGS" },
  purchasable_offer: { fill: "computed", source: "pricing model × COGS" },
  fulfillment_availability: { fill: "computed", source: "inventory / Veeqo" },
  merchant_shipping_group: { fill: "review", source: "shipping template" },

  // ── Images (computed main + catalog secondary) ────────────────────────────
  main_product_image_locator: { fill: "computed", source: "generated hero (frozen kit) image on R2" },
  main_offer_image_locator: { fill: "computed", source: "same hero image" },
  other_product_image_locator_1: { fill: "catalog", source: "donor secondary photo" },
  other_product_image_locator_2: { fill: "catalog", source: "donor secondary photo" },
  other_product_image_locator_3: { fill: "catalog", source: "donor secondary photo" },
  other_product_image_locator_4: { fill: "catalog", source: "donor secondary photo" },
  nutritional_panel_image_locator: { fill: "catalog", source: "donor nutrition-label photo" },

  // ── Physical (manual for now — Phase-2 scaffold) ──────────────────────────
  item_package_dimensions: { fill: "operator", source: "manual ship-specs (auto later)" },
  item_package_weight: { fill: "operator", source: "manual ship-specs (auto later)" },
  item_weight: { fill: "operator", source: "manual ship-specs (auto later)" },
  item_dimensions: { fill: "operator", source: "manual ship-specs (auto later)" },

  // ── Storage / temperature cues (computed from category) ───────────────────
  is_heat_sensitive: { fill: "review", source: "true for chocolate" },
  // temperature_rating (Listings-API name; the flat-file legacy `storage_temperature`
  // does NOT exist on GROCERY). Now COMPUTED from category with the exact FOOD
  // valid-value strings (valid-values-food.ts): frozen→"Frozen: 0 degree",
  // refrigerated→"Chilled: 33 to 38 degrees", else "Ambient: Room Temperature".
  temperature_rating: { fill: "computed", source: "category → FOOD valid-value (Frozen/Chilled/Ambient)" },

  // ── Condition / offer defaults ────────────────────────────────────────────
  // Every listing is a brand-new sealed product. Listings-API enum pending the
  // Valid Values tab (standard is `new_new`); until confirmed, review not fixed.
  condition_type: { fill: "review", source: "new (NEEDS valid-value enum, likely new_new)" },
  product_expiration_type: { fill: "review", source: "reviewed manufacturer-label value" },
  contains_liquid_contents: { fill: "fixed", source: "No (solid food)" },
  each_unit_count: { fill: "review", source: "units per each (from donor size)" },
};
