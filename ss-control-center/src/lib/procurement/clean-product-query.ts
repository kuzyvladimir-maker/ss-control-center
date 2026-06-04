/**
 * Strip pack/size/quantity noise from a product title so a Walmart catalog
 * search returns ALL pack variants of the same product — not just the exact
 * listing the procurement row points to.
 *
 * Used by the "Снять с продажи" modal on the Procurement page. The user
 * still sees the cleaned query in an editable input, so this is a
 * convenience default — not a hard guarantee.
 *
 * Examples:
 *   "Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)"
 *     → "Stur Drinks Black Cherry, Liquid Water Enhancer"
 *
 *   "Maruchan Ramen Noodle Pork Flavor Soup, 3 oz Shelf Stable Package (Pack of 8)"
 *     → "Maruchan Ramen Noodle Pork Flavor Soup, Shelf Stable Package"
 *
 *   "Del Monte Peaches Sliced 8.5 oz (Pack of 6)"
 *     → "Del Monte Peaches Sliced"
 *
 *   "1UP Freeze Dried Sour Worms, 2.0 oz Resealable Bag (Pack of 4)"
 *     → "1UP Freeze Dried Sour Worms, Resealable Bag"
 */
export function cleanProductQuery(title: string): string {
  let s = title;

  // 1. Pack patterns: "(Pack of 4)", "Pack of 4", "4-Pack", "4 Pack",
  //    "Set of 6", "Bundle of 3"
  s = s.replace(/\(?\b(?:pack|set|bundle|case|box)\s*of\s*\d+\)?/gi, "");
  s = s.replace(/\b\d+\s*[-\s]?(?:pack|pk|ct|count)\b/gi, "");

  // 2. Sizes: numeric + unit. Cover the common food units.
  //    "1.62 fl oz", "25 oz", "3 oz", "1 lb", "500 g", "750 ml", "12 ct"
  s = s.replace(
    /\b\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|liter|liters|l)\b\.?/gi,
    "",
  );

  // 3. Quantity descriptors in product titles
  s = s.replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:oz|lb|g|ml|ct)\b/gi, "");

  // 4. Cleanup: leftover commas/parens/dashes adjacent to whitespace
  s = s.replace(/[\(\)]/g, " ");
  s = s.replace(/\s*,\s*,/g, ","); // collapse ",, "
  s = s.replace(/\s*,\s*$/g, ""); // trailing comma
  s = s.replace(/^\s*,\s*/g, ""); // leading comma
  s = s.replace(/\s+-\s+/g, " "); // bare dashes between words
  s = s.replace(/\s{2,}/g, " "); // collapse whitespace
  s = s.trim();

  return s;
}

/**
 * Strip pack/quantity noise but KEEP the weight/volume so the operator can
 * paste it into an online-store search and find the EXACT size variant.
 *
 * Sibling of `cleanProductQuery` (which strips weight too — used when we
 * want to match any pack of the same product on Walmart catalog).
 *
 * Used by the "copy title" button on each Procurement card.
 *
 * Examples:
 *   "Arnold Premium Sub Rolls, 6 Count, 15 oz Box (Pack of 2)"
 *     → "Arnold Premium Sub Rolls, 15 oz Box"
 *
 *   "Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)"
 *     → "Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz"
 *
 *   "Fancy Feast Delights Wet Cat Food Variety Pack — 24 Cans, Cheese & Gravy"
 *     → "Fancy Feast Delights Wet Cat Food Variety Pack — Cheese & Gravy"
 *
 *   "Green Giant Nature's Pantry — 8-Can Garden Vegetable Variety Pack"
 *     → "Green Giant Nature's Pantry — Garden Vegetable Variety Pack"
 */
export function cleanProductTitleForSearch(title: string): string {
  let s = title;

  // 1. "(Pack of N)", "Pack of N", "Set of N", "Bundle of N", "Case of N",
  //    "Box of N", "Multipack of N"
  s = s.replace(
    /\(?\b(?:pack|set|bundle|case|box|multipack)\s*of\s*\d+\)?/gi,
    "",
  );

  // 2. "4-Pack", "4 Pack", "4-pk", "4 PK", "4-Count", "4 Count", "4 ct",
  //    "4-ct", "4 cans", "4-Can", "4 cnt", "4 pcs", "4-piece"
  s = s.replace(
    /\b\d+\s*[-\s]?(?:pack|pk|ct|count|cnt|cans?|piece|pieces|pcs)\b/gi,
    "",
  );

  // 3. "× 4", "x 4", "×4", "x4" multipliers at the start or near the title.
  s = s.replace(/\s*[×x]\s*\d+\b/gi, "");

  // NOTE: deliberately NOT stripping weight/volume tokens here — operator
  // wants those in the clipboard so the online-store search lands on the
  // right size variant.

  // 4. Cleanup: leftover empty parens, double commas, dangling dashes.
  s = s.replace(/\(\s*\)/g, ""); // empty parens after pack strip
  // Dash followed by comma (= we stripped what sat between them):
  // "... Pack –, Cheese" → "... Pack, Cheese". Handle em/en/hyphen.
  s = s.replace(/\s*[—–-]\s*,/g, ",");
  s = s.replace(/,\s*[—–-]\s*/g, ", ");
  s = s.replace(/\s*,\s*,/g, ","); // ",, "
  s = s.replace(/\s*,\s*$/g, ""); // trailing comma
  s = s.replace(/^\s*,\s*/g, ""); // leading comma
  s = s.replace(/\s*[—–-]\s*$/g, ""); // trailing em/en/hyphen dashes
  s = s.replace(/^\s*[—–-]\s*/g, ""); // leading dashes
  s = s.replace(/\s+([,.])/g, "$1"); // " ," → ","
  s = s.replace(/\s{2,}/g, " "); // collapse whitespace
  s = s.trim();

  return s;
}
