/**
 * The poller must read Walmart's real response shape.
 *
 * Walmart returns per-item results under `itemDetails.itemIngestionStatus`.
 * The poller read `itemDetails.itemDetails`, a path the API never sends, so no
 * terminal feed ever yielded an exact SKU result: every submission fell through
 * to WALMART_FEED_EXACT_SKU_RESULT_MISSING and parked the listing in
 * PENDING_REVIEW with its one-shot fence still held.
 *
 * That is the worst failure shape available — the listing is neither live nor
 * retryable, and nothing on screen says why. It stayed invisible because until
 * 2026-08-03 no item had ever been submitted for creation, so the branch had
 * never run against a real response.
 *
 * The captured sample below is Walmart's actual answer for feed
 * 18C866950B1C51E881093BFDCD56E5C9@AXkBBgA.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POLLER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../status-poller.ts",
);

/** Exactly what Walmart returned, trimmed to the fields the poller reads. */
const REAL_RESPONSE = {
  feedStatus: "PROCESSED",
  itemsReceived: 1,
  itemsSucceeded: 0,
  itemsFailed: 1,
  itemDetails: {
    itemIngestionStatus: [
      {
        sku: "FN-WM30-XEHS",
        wpid: "3RUAU6HWUWJ9",
        ingestionStatus: "DATA_ERROR",
        ingestionErrors: {
          ingestionError: [
            {
              type: "DATA_ERROR",
              code: "ERR_EXT_DATA_0101171",
              description: "We couldn't download the image from your URL.",
            },
          ],
        },
      },
    ],
  },
};

test("the per-item results are read from the path Walmart actually sends", () => {
  const source = readFileSync(POLLER, "utf8");
  assert.match(
    source,
    /raw\.itemDetails\?\.itemIngestionStatus/u,
    "The poller must read itemDetails.itemIngestionStatus.",
  );
});

test("reading the documented path finds the SKU result the old path missed", () => {
  const viaOldPath = (REAL_RESPONSE.itemDetails as Record<string, unknown>)
    .itemDetails as unknown[] | undefined;
  assert.equal(
    viaOldPath,
    undefined,
    "itemDetails.itemDetails is not a path Walmart sends — that was the defect",
  );

  const viaRealPath = REAL_RESPONSE.itemDetails.itemIngestionStatus;
  const found = viaRealPath.find((entry) => entry.sku === "FN-WM30-XEHS");
  assert.ok(found, "the SKU result is present and must be found");
  assert.equal(found.ingestionStatus, "DATA_ERROR");
  assert.equal(
    found.ingestionErrors.ingestionError[0]?.code,
    "ERR_EXT_DATA_0101171",
  );
});

test("a rejected item carries its errors, so it can be reported and retried", () => {
  const item = REAL_RESPONSE.itemDetails.itemIngestionStatus[0]!;
  const errors = item.ingestionErrors?.ingestionError ?? [];
  assert.ok(errors.length > 0, "a DATA_ERROR item must surface its reasons");
  for (const error of errors) {
    assert.ok(error.code, "every error needs a code the operator can act on");
    assert.ok(error.description, "and a description");
  }
});
