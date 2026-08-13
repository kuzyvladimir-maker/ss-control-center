// Tests for the generic_keyword (backend search terms) builder.
//   npx tsx --test src/lib/bundle-factory/__tests__/search-terms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSearchTerms } from "@/lib/bundle-factory/attributes/search-terms";

test("Uncrustables title keeps exact family, flavor and total count without generic meal noise", () => {
  const kw = buildSearchTerms(
    "Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, 8oz/4ct - Pack of 6 (total 24 pieces)",
    "Uncrustables",
  );
  assert.match(kw, /^uncrustables\b/);
  assert.match(kw, /peanut/);
  assert.match(kw, /blackberry/);
  assert.match(kw, /sandwich/);
  assert.match(kw, /24 count/);
  assert.match(kw, /frozen/);
  assert.match(kw, /grab go/); // narrow shopper-intent synonyms present
  assert.doesNotMatch(kw, /freezer meals|no prep|quick meal|family pack/);
  assert.ok(Buffer.byteLength(kw, "utf8") <= 240, "within Amazon 250-byte limit");
});

test("non-frozen title omits frozen synonyms, keeps base ones", () => {
  const kw = buildSearchTerms("Assorted Chips Variety Snack Box", "Salutem Vita");
  assert.ok(!/freezer meals/.test(kw));
  assert.match(kw, /chips/);
  assert.match(kw, /grab go/);
});

test("empty/undefined title → base synonyms only, never throws", () => {
  const kw = buildSearchTerms(null, "Salutem Vita");
  assert.match(kw, /grab go/);
  assert.ok(Buffer.byteLength(kw, "utf8") <= 240);
});
