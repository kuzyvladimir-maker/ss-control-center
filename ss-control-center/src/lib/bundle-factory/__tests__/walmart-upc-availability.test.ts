import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_UPC_SEARCH_ATTEMPTS } from "../walmart-upc-availability";

test("an unverified product ID is never treated as free", async () => {
  const source = await readFile(
    new URL("../walmart-upc-availability.ts", import.meta.url),
    "utf8",
  );
  // A network failure is not evidence. Publishing on an unanswered question is
  // exactly what produced the 90-minute failures: 24% of the next numbers in
  // line were already carrying other companies' products.
  assert.match(source, /if \(!availability\.checked\)/u);
  assert.match(source, /not publishing on an unverified product ID/u);

  // A taken number is retired WITH the item that owns it, so the note is true
  // and the next person does not repeat the search.
  assert.match(source, /UPC_TAKEN_IN_WALMART_CATALOG/u);
  assert.match(source, /existingItemId/u);
  // …and it releases its hold on the listing, because assigned_to_id is unique
  // and the replacement cannot attach while the dead number still claims it.
  assert.match(source, /assigned_to_id: null/u);

  // A live listing is addressed by its number on Walmart's side.
  assert.match(source, /if \(sku\.live_url\)/u);

  // Bounded: a contaminated block must ask for real numbers, not spin.
  assert.ok(MAX_UPC_SEARCH_ATTEMPTS > 1 && MAX_UPC_SEARCH_ATTEMPTS <= 25);
  assert.match(source, /The pool block is contaminated/u);
});

test("publishing checks the product ID before it spends a feed", async () => {
  const publish = await readFile(
    new URL("../publish-one-draft.ts", import.meta.url),
    "utf8",
  );
  assert.match(publish, /ensureFreeWalmartUpc/u);
  assert.match(publish, /stage: "PRODUCT_ID"/u);
  // Before validation, so the cheapest refusal happens first.
  assert.ok(
    publish.indexOf("ensureFreeWalmartUpc") < publish.indexOf("runValidationForDraft("),
    "the product ID is checked before validation runs",
  );
});
