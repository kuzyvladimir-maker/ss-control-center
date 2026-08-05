import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { walmartListingIdentity } from "../walmart-duplicate-listing";
import {
  WALMART_STUDIO_LISTING_ATTRIBUTE_KEY,
} from "../walmart-studio-listing";

function attributes(canonicalVariantId: string, packCount: number): string {
  return JSON.stringify({
    [WALMART_STUDIO_LISTING_ATTRIBUTE_KEY]: {
      identity: { canonical_variant_id: canonicalVariantId },
      listing_scope: { pack_count: packCount },
    },
  });
}

test("a listing is identified by its exact variant and its pack size", () => {
  const eight = walmartListingIdentity(attributes("cpv1:abc", 8));
  assert.deepEqual(eight, { canonicalVariantId: "cpv1:abc", packCount: 8 });

  // Same product in a different pack is a DIFFERENT listing — proven live on
  // 2026-08-05, when Pack of 8 published while its own Pack of 6 was already
  // out. Comparing on the variant alone would have blocked a legitimate one.
  const six = walmartListingIdentity(attributes("cpv1:abc", 6));
  assert.notDeepEqual(six, eight);

  // Anything that declares no identity cannot be compared and must not be
  // guessed at: that is the frozen pilot lane, governed by its own evidence.
  assert.equal(walmartListingIdentity(null), null);
  assert.equal(walmartListingIdentity("{}"), null);
  assert.equal(walmartListingIdentity(attributes("", 8)), null);
  assert.equal(walmartListingIdentity(attributes("cpv1:abc", 0)), null);
});

test("the duplicate check runs before publishing and counts in-flight listings", async () => {
  const guard = await readFile(
    new URL("../walmart-duplicate-listing.ts", import.meta.url),
    "utf8",
  );
  // A second feed for a product whose first feed is still processing is the
  // same duplicate, found an hour earlier — so LIVE alone is not the test.
  assert.match(guard, /"SUBMITTED", "SUBMITTING", "PENDING_REVIEW", "SUBMISSION_UNKNOWN", "LIVE"/u);
  // Identity is the canonical variant and the pack size — never the title or
  // the image, which can differ on the same offer and match on different ones.
  assert.doesNotMatch(guard, /candidate\.title|\btitle:/u);

  const publish = await readFile(
    new URL("../publish-one-draft.ts", import.meta.url),
    "utf8",
  );
  assert.match(publish, /stage: "DUPLICATE"/u);
  // Only a real publish is blocked; a dry run is still allowed to show what
  // would be sent.
  assert.match(publish, /if \(apply\) \{\s*\n\s*const walmartSkus/u);
});
