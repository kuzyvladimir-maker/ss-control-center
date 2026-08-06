/**
 * A refused product ID is a question, not a verdict.
 *
 * Walmart refused `756441906103` for a duplicate product ID while its own
 * catalog held no item using it. The poller believed the error, retired the
 * number, and told the operator to replace something that was never broken —
 * twice over, across four retired numbers of which two were free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyWalmartUpcRefusal } from "../distribution/status-poller";

const REFUSED = {
  channel: "WALMART",
  upc: "756441906103",
  hasPoolRow: true,
  disposition: "UPC_COLLISION" as const,
};

const free = async (upc: string) => ({
  upc,
  taken: false,
  existingItemId: null,
  checked: true,
});
const takenBy = (itemId: string) => async (upc: string) => ({
  upc,
  taken: true,
  existingItemId: itemId,
  checked: true,
});
const unanswerable = async (upc: string) => ({
  upc,
  taken: false,
  existingItemId: null,
  checked: false,
});

test("a number the catalog confirms is taken gets retired, naming the owner", async () => {
  const verdict = await classifyWalmartUpcRefusal(REFUSED, takenBy("13568055318"));
  assert.equal(verdict.quarantine, true);
  assert.equal(verdict.existingItemId, "13568055318");
  assert.equal(verdict.explanation, null);
});

test("a number the catalog says is free is kept, and the real cause is stated", async () => {
  const verdict = await classifyWalmartUpcRefusal(REFUSED, free);
  assert.equal(verdict.quarantine, false);
  assert.match(String(verdict.explanation), /no item using 756441906103/);
  // The operator must not be sent to replace it: that is what burned the pool.
  assert.match(String(verdict.explanation), /will not publish it/);
});

test("an unanswerable catalog never costs us a number", async () => {
  const verdict = await classifyWalmartUpcRefusal(REFUSED, unanswerable);
  assert.equal(verdict.quarantine, false);
  assert.match(String(verdict.explanation), /could not be asked/);
});

test("refusals that are not about the product ID ask Walmart nothing", async () => {
  let asked = 0;
  const counting = async (upc: string) => {
    asked += 1;
    return free(upc);
  };
  const verdict = await classifyWalmartUpcRefusal(
    { ...REFUSED, disposition: "MARKETPLACE_REJECTED" },
    counting,
  );
  assert.equal(asked, 0);
  assert.equal(verdict.quarantine, false);
  assert.equal(verdict.explanation, null);
});

test("Amazon listings are left alone", async () => {
  let asked = 0;
  const counting = async (upc: string) => {
    asked += 1;
    return free(upc);
  };
  const verdict = await classifyWalmartUpcRefusal(
    { ...REFUSED, channel: "AMAZON_STORE1" },
    counting,
  );
  assert.equal(asked, 0);
  assert.equal(verdict.quarantine, false);
});
