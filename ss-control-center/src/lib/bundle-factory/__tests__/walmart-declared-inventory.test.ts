import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  declaredQuantityFromAttributes,
} from "../distribution/walmart-declared-inventory";
import {
  WALMART_STUDIO_LISTING_LANE,
} from "../walmart-studio-listing";

test("the declared quantity is read from the SKU's own offer handoff", () => {
  const attributes = JSON.stringify({
    listing_lane: WALMART_STUDIO_LISTING_LANE,
    walmart: { offer_handoff: { quantity: 50 } },
  });
  assert.equal(declaredQuantityFromAttributes(attributes), 50);

  // Nothing usable means the caller falls back to the owner's default rather
  // than writing a number this SKU never declared.
  assert.equal(declaredQuantityFromAttributes(null), null);
  assert.equal(declaredQuantityFromAttributes("{}"), null);
  assert.equal(
    declaredQuantityFromAttributes(
      JSON.stringify({ walmart: { offer_handoff: { quantity: 0 } } }),
    ),
    null,
  );
});

test("only a studio listing publishes availability, and to every node", async () => {
  const source = await readFile(
    new URL("../distribution/walmart-declared-inventory.ts", import.meta.url),
    "utf8",
  );
  // The item feed carries ONE fulfillment center; the other warehouses would
  // read zero without this write.
  assert.match(source, /setInventoryAllNodes/u);
  assert.match(source, /readInventoryAcrossNodes/u);
  // An existing catalogue item's stock is never touched by this path.
  assert.match(source, /isWalmartStudioLane/u);
  assert.match(source, /not_a_studio_listing/u);

  const poll = await readFile(
    new URL("../distribution/poll-pending-core.ts", import.meta.url),
    "utf8",
  );
  // Runs on the LIVE transition only, and cannot break the poll loop.
  assert.match(poll, /new_listing_status === "LIVE" && target\.kind === "walmart"/u);
  assert.match(poll, /catch \(inventoryError\)/u);
});
