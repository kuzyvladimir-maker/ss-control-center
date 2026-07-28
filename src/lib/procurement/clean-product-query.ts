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
 * Remove weight / volume / size tokens from a title:
 *   "18.5 oz", "18.5 oz.", "1.62 fl oz", "4.2 lb", "750 ml", "2 l", "500 g",
 *   and the combined "4 x 12 oz" / "4 × 12 oz" form.
 * A trailing period on the unit ("18.5 oz.") is consumed too.
 *
 * Single source of truth for size stripping, shared by:
 *   - `cleanProductTitleForSearch` (the regex fallback below), and
 *   - the /api/procurement/clean-title route, which applies it to BOTH the
 *     AI output AND any value coming back from the DB cache — so titles
 *     cached earlier (when weight was kept on purpose) still come out
 *     size-free without having to flush the cache.
 *
 * Only digit-led tokens are touched, so product names that merely contain a
 * unit letter are safe ("5 Gum", "100 Grand", "7 Up" are left alone).
 */
export function stripSizeTokens(input: string): string {
  let s = input;

  // Combined "4 x 12 oz" / "4 × 12 oz" (number × number unit).
  s = s.replace(
    /\b\d+(?:\.\d+)?\s*[×x]\s*\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounces?|lb|lbs|pounds?|mg|mcg|kg|g|grams?|ml|milliliters?|l|liters?)\b\.?/gi,
    "",
  );
  // Plain "<number> <unit>".
  s = s.replace(
    /\b\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounces?|lb|lbs|pounds?|mg|mcg|kg|g|grams?|ml|milliliters?|l|liters?)\b\.?/gi,
    "",
  );

  // Tidy the gap left behind (mid-string, trailing, or between commas).
  s = s.replace(/\s*,\s*,/g, ",");
  s = s.replace(/\s*,\s*$/g, "");
  s = s.replace(/^\s*,\s*/g, "");
  s = s.replace(/\s*[—–-]\s*$/g, "");
  s = s.replace(/\s+([,.])/g, "$1");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}

/**
 * Strip pack/quantity noise AND weight/volume so the "copy title" button on
 * each Procurement card yields a clean, size-free search string. The operator
 * pastes it into a marketplace search; keeping the weight used to pin the
 * result to one size variant, which Vladimir asked to drop (2026-06-30).
 *
 * Sibling of `cleanProductQuery` (also strips weight — used by the Walmart
 * "Снять с продажи" catalog search).
 *
 * Examples:
 *   "Arnold Premium Sub Rolls, 6 Count, 15 oz Box (Pack of 2)"
 *     → "Arnold Premium Sub Rolls, Box"
 *
 *   "Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)"
 *     → "Stur Drinks Black Cherry, Liquid Water Enhancer"
 *
 *   "Progresso Chickpea & Noodle Protein Soup, Vegetarian, 18.5 oz. (Pack of 6)"
 *     → "Progresso Chickpea & Noodle Protein Soup, Vegetarian"
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

  // 4. Weight / volume / size tokens ("18.5 oz", "1 lb", "750 ml", …) — the
  //    operator wants the copied title size-free so the marketplace search
  //    isn't pinned to one weight variant.
  s = stripSizeTokens(s);

  // 5. Cleanup: leftover empty parens, double commas, dangling dashes.
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
