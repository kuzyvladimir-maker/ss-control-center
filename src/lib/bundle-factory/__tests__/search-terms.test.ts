// Tests for the generic_keyword (backend search terms) builder.
//   npx tsx --test src/lib/bundle-factory/__tests__/search-terms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSearchTerms } from "@/lib/bundle-factory/attributes/search-terms";

test("frozen title → product tokens + frozen synonyms, brand excluded, capped", () => {
  const kw = buildSearchTerms(
    "Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, 8oz/4ct - Pack of 6",
    "Uncrustables",
  );
  assert.ok(!/uncrustables/.test(kw), "brand token excluded");
  assert.match(kw, /peanut/);
  assert.match(kw, /blackberry/);
  assert.match(kw, /sandwiches/);
  assert.match(kw, /frozen/);
  assert.match(kw, /grab and go/); // base synonym present
  assert.ok(Buffer.byteLength(kw, "utf8") <= 240, "within Amazon 250-byte limit");
  assert.ok(!/\d/.test(kw), "numbers/units dropped");
});

test("non-frozen title omits frozen synonyms, keeps base ones", () => {
  const kw = buildSearchTerms("Assorted Chips Variety Snack Box", "Salutem Vita");
  assert.ok(!/freezer meals/.test(kw));
  assert.match(kw, /chips/);
  assert.match(kw, /grab and go/);
});

test("empty/undefined title → base synonyms only, never throws", () => {
  const kw = buildSearchTerms(null, "Salutem Vita");
  assert.match(kw, /grab and go/);
  assert.ok(Buffer.byteLength(kw, "utf8") <= 240);
});
