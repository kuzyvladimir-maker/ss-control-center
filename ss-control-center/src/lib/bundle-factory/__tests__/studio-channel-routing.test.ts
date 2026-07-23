import { test } from "node:test";
import assert from "node:assert/strict";

import {
  studioChannelRoute,
  WALMART_CANONICAL_OPERATOR_MESSAGE,
} from "@/lib/bundle-factory/studio-channel-routing";

test("legacy Studio routes Amazon normally but never creates Walmart work", () => {
  assert.equal(studioChannelRoute("AMAZON_SALUTEM"), "LEGACY_STUDIO_ALLOWED");
  assert.equal(studioChannelRoute("AMAZON_PERSONAL"), "LEGACY_STUDIO_ALLOWED");
  assert.equal(
    studioChannelRoute("WALMART"),
    "CANONICAL_WALMART_OPERATOR_REQUIRED",
  );
  assert.match(WALMART_CANONICAL_OPERATOR_MESSAGE, /Bundle Factory Walmart pilot/);
  assert.match(WALMART_CANONICAL_OPERATOR_MESSAGE, /walmart:new-sku/);
});
