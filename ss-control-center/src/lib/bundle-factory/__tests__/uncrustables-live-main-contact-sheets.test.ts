import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyReviewedTotalOverrides,
  isRetryableHttpStatus,
  parseRetryAfterMs,
  retryBackoffMs,
  safeFilePart,
  sealManifestBody,
  selectSealedLiveMainTargets,
  verifyManifestSeal,
// @ts-expect-error -- explicit .ts lets Node's native test runner load the source.
} from "../audit/uncrustables-live-main-contact-sheets.ts";

const LEDGER_SHA = "a".repeat(64);

function row(
  sku: string,
  asin: string,
  total = 24,
  componentQty = total,
): Record<string, unknown> {
  return {
    sku,
    asin,
    live: {
      fetched: true,
      title: `Uncrustables ${total} Count`,
      main_image_url: `https://m.media-amazon.com/images/I/${asin}.jpg`,
    },
    canonical: {
      total_units: total,
      components: [
        {
          product_name: "Smucker's Uncrustables Peanut Butter Sandwich",
          flavor: "Peanut Butter",
          qty: componentQty,
        },
      ],
    },
  };
}

function ledger(rows: Record<string, unknown>[]): Record<string, unknown> {
  return {
    immutable: true,
    complete: true,
    schema_version: "uncrustables-ledger/test",
    audit_id: "TEST",
    marketplace_observed_at: "2026-07-17T22:43:12.080Z",
    rows,
  };
}

function overrides(
  repairs: Record<string, unknown>[],
  sourceLedgerSha256 = LEDGER_SHA,
): Record<string, unknown> {
  return {
    immutable: true,
    source_ledger_sha256: sourceLedgerSha256,
    repairs,
  };
}

test("sealed target selection requires exact unique fetched rows and recipe evidence", () => {
  const selected = selectSealedLiveMainTargets(
    ledger([
      row("SKU-1", "B0H0000001"),
      { ...row("IGNORED", "B0H0000009"), live: { fetched: false } },
      row("SKU-2", "B0H0000002", 30),
    ]),
    { expectedRows: 2 },
  );
  assert.equal(selected.targets.length, 2);
  assert.deepEqual(
    selected.targets.map(({ sku, asin, effective_total_units }) => ({
      sku,
      asin,
      effective_total_units,
    })),
    [
      { sku: "SKU-1", asin: "B0H0000001", effective_total_units: 24 },
      { sku: "SKU-2", asin: "B0H0000002", effective_total_units: 30 },
    ],
  );
});

test("sealed target selection rejects unsealed, duplicate, missing, and non-Amazon inputs", () => {
  assert.throws(
    () => selectSealedLiveMainTargets({ ...ledger([]), immutable: false }, { expectedRows: 1 }),
    /immutable=true/,
  );
  assert.throws(
    () =>
      selectSealedLiveMainTargets(
        ledger([row("SKU-1", "B0H0000001"), row("SKU-2", "B0H0000001")]),
        { expectedRows: 2 },
      ),
    /Duplicate fetched ASIN/,
  );
  assert.throws(
    () =>
      selectSealedLiveMainTargets(
        ledger([
          {
            ...row("SKU-1", "B0H0000001"),
            live: { fetched: true, main_image_url: "https://example.com/a.jpg" },
          },
        ]),
        { expectedRows: 1 },
      ),
    /not allow-listed/,
  );
  assert.throws(
    () =>
      selectSealedLiveMainTargets(
        ledger([{ ...row("SKU-1", "B0H0000001"), canonical: null }]),
        { expectedRows: 1 },
      ),
    /canonical total/,
  );
});

test("HIGH reviewed override resolves a sealed-ledger count conflict while retaining both totals", () => {
  const identity = selectSealedLiveMainTargets(
    ledger([row("SZ-ASPI-JFAT", "B0H776M5B5", 6, 24)]),
    { expectedRows: 1 },
  );
  const result = applyReviewedTotalOverrides(
    identity,
    overrides([
      {
        sku: "SZ-ASPI-JFAT",
        review: { confidence: "HIGH", rationale: "24 individual pieces" },
        text_count: { unit_count: 24, number_of_items: 24 },
      },
    ]),
    LEDGER_SHA,
  );
  assert.equal(result.applied.length, 1);
  assert.deepEqual(
    {
      canonical: result.identity.targets[0].canonical_total_units,
      reviewed: result.identity.targets[0].reviewed_total_units,
      effective: result.identity.targets[0].effective_total_units,
      source: result.identity.targets[0].total_units_source,
    },
    {
      canonical: 6,
      reviewed: 24,
      effective: 24,
      source: "HIGH_REVIEWED_OVERRIDE",
    },
  );
});

test("count conflict fails closed without an exact SHA-bound HIGH override", () => {
  const identity = selectSealedLiveMainTargets(
    ledger([row("SZ-ASPI-JFAT", "B0H776M5B5", 6, 24)]),
    { expectedRows: 1 },
  );
  assert.throws(
    () => applyReviewedTotalOverrides(identity, overrides([]), LEDGER_SHA),
    /has no HIGH reviewed customer-total override/,
  );
  assert.throws(
    () =>
      applyReviewedTotalOverrides(
        identity,
        overrides([], "b".repeat(64)),
        LEDGER_SHA,
      ),
    /not bound to the sealed ledger SHA/,
  );
});

test("retry policy is bounded and only retries transient HTTP statuses", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableHttpStatus(status), true, String(status));
  }
  for (const status of [200, 301, 400, 401, 403, 404, 422]) {
    assert.equal(isRetryableHttpStatus(status), false, String(status));
  }
  assert.equal(retryBackoffMs(1, 1_000, () => 0), 1_000);
  assert.equal(retryBackoffMs(2, 1_000, () => 1), 2_250);
  assert.equal(parseRetryAfterMs("2"), 2_000);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 2026 00:00:03 GMT", Date.parse("2026-01-01T00:00:00Z")),
    3_000,
  );
});

test("safeFilePart removes path syntax and manifest seal is canonical/order-independent", () => {
  assert.equal(safeFilePart(" ..A/B::C-- "), "A_B_C");
  assert.equal(safeFilePart("SKU-1.jpg"), "SKU-1.jpg");
  const left = { z: 1, a: { y: 2, x: 3 } };
  const right = { a: { x: 3, y: 2 }, z: 1 };
  assert.equal(sealManifestBody(left), sealManifestBody(right));
  const manifest: Record<string, unknown> = {
    ...left,
    body_sha256: sealManifestBody(left),
  };
  assert.equal(verifyManifestSeal(manifest), true);
  manifest.z = 2;
  assert.equal(verifyManifestSeal(manifest), false);
});
