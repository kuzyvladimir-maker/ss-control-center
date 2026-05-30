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
