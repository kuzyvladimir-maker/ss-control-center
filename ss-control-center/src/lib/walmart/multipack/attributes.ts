// Walmart MP_ITEM 5.0 attribute layer for multipack food remediation.
//
// Source of truth: Walmart's official "MP_ITEM Spec 5.0" bulk-setup template
// (omni-marketplace-en-external-5.0.20260501, provided by Vladimir 2026-07-01;
// distilled into docs/marketplace-rules/walmart/mp-item-food-attributes.md).
// The template's machine row gives the EXACT API attribute names the feed
// expects; this module maps what we know (pack count) + what our donor carries
// (scraped from Walmart's OWN product page, so the values are already
// Walmart-valid) onto those names.
//
// Philosophy (Vladimir): the MORE attributes we fill, the better the listing
// indexes and ranks. So we fill EVERYTHING the donor gives us — not a minimal
// set. Donor values come from Walmart, so even closed-list attributes carry
// Walmart-native values. We separate SAFE (free-text/numeric — can never bounce
// on an enum) from CLOSED (validated against Walmart's enum); the caller can
// drop CLOSED ones if a test feed rejects them, without losing the safe layer.

import type { Client } from "@libsql/client";

type Specs = Record<string, string>;

// Donor spec display-name (lowercased) → { api attribute name, char cap }.
// FREE-TEXT / numeric per the spec → never rejected on an enum value.
// SAFE = confirmed accepted by live feed tests (2026-07-01). Scalar free-text /
// numeric that Walmart neither enum-validates nor requires as a JSON array for
// food product types. (Dropped after test: productLine → needs JSONArray;
// productNetContentMeasure/Unit → "not a valid field" for MP_MAINTENANCE.)
const SAFE_MAP: Record<string, { api: string; max: number }> = {
  "manufacturer": { api: "manufacturer", max: 60 },
  "ingredients": { api: "ingredients", max: 5000 },
  "ingredient list": { api: "ingredients", max: 5000 },
  "allergen statement": { api: "foodAllergenStatements", max: 4000 },
  "allergens": { api: "foodAllergenStatements", max: 4000 },
  "allergen": { api: "foodAllergenStatements", max: 4000 },
  "flavor": { api: "flavor", max: 600 },
  "net content statement": { api: "netContentStatement", max: 500 },
  "manufacturer part number": { api: "manufacturerPartNumber", max: 60 },
  "size": { api: "size", max: 500 },
};

// CLOSED = enum-validated per product type (live feed rejected containerType,
// texture, foodForm, container_material, food_condition even though the spec
// labels some "Alphanumeric"). Donor values come from Walmart so they're usually
// valid, but a mismatch bounces the whole item → sent only when includeClosed.
// The descriptive alphanumerics (cuisine/occasion/vegetable/fruit/dietary/flavor
// notes) are UNTESTED so parked here as a precaution.
const CLOSED_MAP: Record<string, { api: string; max: number }> = {
  "container type": { api: "containerType", max: 100 },
  "container material": { api: "container_material", max: 50 },
  "material": { api: "container_material", max: 50 },
  "food form": { api: "foodForm", max: 100 },
  "food condition": { api: "food_condition", max: 100 },
  "spice level": { api: "spiceLevel", max: 100 },
  "size descriptor": { api: "sizeDescriptor", max: 100 },
  "food preparation method": { api: "food_preparation_method", max: 100 },
  "preparation type": { api: "food_preparation_method", max: 100 },
  "retail packaging": { api: "ib_retail_packaging", max: 100 },
  "texture": { api: "texture", max: 100 },
  "cuisine": { api: "cuisine", max: 30 },
  "occasion": { api: "occasion", max: 2000 },
  "vegetable type": { api: "vegetable_type", max: 100 },
  "fruit type": { api: "fruitType", max: 100 },
  "dietary method": { api: "dietaryMethod", max: 1000 },
  "flavor notes": { api: "flavor_notes", max: 500 },
  "tasting notes": { api: "flavor_notes", max: 500 },
};

/** Parse RetailPrice.specifications (BlueCart shapes: flat [{name,value}] or
 *  grouped [{specifications:[…]}]) into a flat lowercased name→value map. */
function parseSpecs(raw: string | null | undefined): Specs {
  const out: Specs = {};
  if (!raw) return out;
  let root: any; try { root = JSON.parse(raw); } catch { return out; }
  const push = (name: any, value: any) => {
    const n = String(name || "").trim().toLowerCase();
    const v = String(value ?? "").trim();
    if (n && v && out[n] == null) out[n] = v;
  };
  const walk = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") {
      if (x.name && (x.value ?? x.text) != null) push(x.name, x.value ?? x.text);
      if (Array.isArray(x.specifications)) x.specifications.forEach(walk);
      if (Array.isArray(x.attributes)) x.attributes.forEach(walk);
    }
  };
  walk(root);
  return out;
}

export interface BuiltAttributes { attrs: Record<string, any>; filled: string[]; closedUsed: string[] }

/**
 * Build the Walmart MP_ITEM attribute block for a multipack food SKU.
 * @param opts.includeClosed  fill closed-list attributes too (default true).
 *   Set false to re-submit a SAFE-only payload if a test feed rejects an enum.
 */
export async function buildFoodAttributes(
  db: Client, sku: string, packCount: number, opts: { includeClosed?: boolean } = {},
): Promise<BuiltAttributes> {
  // Default OFF: a live feed test showed closed-list values (containerType,
  // foodForm, food_condition, container_material, texture, netContentUnit) get
  // enum-rejected per productType and bounce the whole item. The SAFE free-text
  // set + the quantity trio pass, so that's the default. Opt back in only when a
  // per-productType enum map is built.
  const includeClosed = opts.includeClosed === true;
  const attrs: Record<string, any> = {};
  const closedUsed: string[] = [];

  // ── Quantity trio (the star). Bundles = N ordinary, individually-saleable
  // retail units shipped together → the spec's "6-pack labeled for individual
  // sale" case: Multipack Quantity = N, Count Per Pack = 1, Total Count = N. ──
  if (packCount >= 2) {
    attrs.multipackQuantity = packCount;
    attrs.countPerPack = 1;
    attrs.count = packCount; // Total Count
  }

  // ── Donor-sourced attributes (values came from Walmart → valid) ──
  let specs: Specs = {};
  let ingredientsCol: string | null = null;
  try {
    const r = await db.execute({
      sql: `SELECT specifications, ingredients FROM RetailPrice
            WHERE sku=? AND (specifications IS NOT NULL OR ingredients IS NOT NULL)
            ORDER BY (CASE WHEN sourceApi='bluecart' THEN 0 ELSE 1 END) LIMIT 1`,
      args: [sku],
    });
    const row: any = r.rows[0];
    if (row) { specs = parseSpecs(row.specifications); ingredientsCol = row.ingredients ? String(row.ingredients) : null; }
  } catch { /* attributes are best-effort — never break the remediation */ }

  const set = (api: string, val: any, max: number, closed = false) => {
    if (attrs[api] != null || val == null) return;
    let s = String(val).trim(); if (!s) return;
    if (s.length > max) s = s.slice(0, max);
    attrs[api] = s;
    if (closed) closedUsed.push(api);
  };

  // dedicated ingredients column wins over a spec row
  if (ingredientsCol) set("ingredients", ingredientsCol, 5000);
  for (const [name, { api, max }] of Object.entries(SAFE_MAP)) set(api, specs[name], max);
  if (includeClosed) for (const [name, { api, max }] of Object.entries(CLOSED_MAP)) set(api, specs[name], max, true);

  return { attrs, filled: Object.keys(attrs), closedUsed };
}
