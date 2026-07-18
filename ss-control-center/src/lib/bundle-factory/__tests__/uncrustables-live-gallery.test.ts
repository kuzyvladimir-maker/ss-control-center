import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertAllowedLiveGalleryUrl,
  canonicalUncrustablesLiveGalleryJson,
  groupLiveGalleryMappingsByExactUrl,
  groupLiveGalleryReferencesByExactSha256,
  parseUncrustablesLiveGalleryRetryAfterMs,
  sealUncrustablesLiveGalleryManifestBody,
  selectReviewedTotalOverrides,
  selectSealedLiveGallery,
  uncrustablesLiveGalleryRecipeLabel,
  uncrustablesLiveGalleryRetryBackoffMs,
  uncrustablesLiveGalleryTotalLabel,
  verifyUncrustablesLiveGalleryManifestSeal,
} from "../audit/uncrustables-live-gallery";

const LEDGER_SHA = "4".repeat(64);

function reviewedArtifact(): Record<string, unknown> {
  return {
    schema_version: "uncrustables-surgical-desired/v1",
    immutable: true,
    source_ledger_sha256: LEDGER_SHA,
    reviewed_at: "2026-07-18T01:32:00.000Z",
    repairs: [
      {
        sku: "SZ-ASPI-JFAT",
        review: {
          confidence: "HIGH",
          rationale: "Selected recipe and live unit identity establish 24 pieces.",
        },
        text_count: { unit_count: 24 },
      },
      {
        sku: "NO-COUNT-FIX",
        review: { confidence: "HIGH", rationale: "Not a count repair." },
        offer: { consumer_price: 76.99 },
      },
    ],
  };
}

function ledgerFixture(): Record<string, unknown> {
  return {
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "ULR-TEST",
    immutable: true,
    complete: true,
    marketplace_observed_at: "2026-07-17T22:43:12.080Z",
    // A legacy/future `verified` boolean is deliberately irrelevant.
    verified: true,
    rows: [
      {
        sku: "AA-AS11-AAAA",
        asin: "B0TEST0001",
        canonical: {
          total_units: 24,
          components: [
            {
              product_name: "Smucker's Uncrustables Peanut Butter & Grape Jelly",
              flavor: "Peanut Butter & Grape Jelly",
              qty: 24,
            },
          ],
        },
        live: {
          fetched: true,
          title: "Grape 24 Count",
          main_image_url: "https://m.media-amazon.com/images/I/MAIN1.jpg",
          gallery_image_urls: [
            "https://m.media-amazon.com/images/I/SHARED.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/GALLERY2.jpg",
          ],
        },
      },
      {
        sku: "SZ-ASPI-JFAT",
        asin: "B0TEST0002",
        canonical: {
          total_units: 6,
          components: [
            {
              product_name: "Smucker's Uncrustables Peanut Butter & Blackberry",
              flavor: null,
              qty: 24,
            },
          ],
        },
        live: {
          fetched: true,
          title: "Blackberry 24 Count",
          main_image_url: "https://m.media-amazon.com/images/I/MAIN2.jpg",
          gallery_image_urls: [
            "https://m.media-amazon.com/images/I/SHARED.jpg",
          ],
        },
      },
      {
        sku: "FAILED-ROW",
        asin: "B0TEST0003",
        canonical: { total_units: 24, components: [] },
        live: { fetched: false },
      },
    ],
  };
}

test("allows only HTTPS Amazon image CDN URLs", () => {
  assert.equal(
    assertAllowedLiveGalleryUrl(
      "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
    ).hostname,
    "m.media-amazon.com",
  );
  assert.throws(
    () => assertAllowedLiveGalleryUrl("http://m.media-amazon.com/image.jpg"),
    /must use HTTPS/,
  );
  assert.throws(
    () => assertAllowedLiveGalleryUrl("https://m.media-amazon.com.evil.test/x"),
    /not allow-listed/,
  );
  assert.throws(
    () => assertAllowedLiveGalleryUrl("https://user:secret@m.media-amazon.com/x"),
    /credentials/,
  );
});

test("reviewed totals require immutable artifact bound to the exact ledger SHA", () => {
  const totals = selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA);
  assert.deepEqual(totals.get("SZ-ASPI-JFAT"), {
    sku: "SZ-ASPI-JFAT",
    total_units: 24,
    confidence: "HIGH",
    rationale: "Selected recipe and live unit identity establish 24 pieces.",
  });
  assert.equal(totals.has("NO-COUNT-FIX"), false);

  const stale = reviewedArtifact();
  stale.source_ledger_sha256 = "5".repeat(64);
  assert.throws(
    () => selectReviewedTotalOverrides(stale, LEDGER_SHA),
    /exact sealed ledger SHA/,
  );
});

test("non-HIGH reviewed count repair fails closed", () => {
  const artifact = reviewedArtifact();
  const repairs = artifact.repairs as Array<Record<string, unknown>>;
  repairs[0].review = {
    confidence: "MEDIUM",
    rationale: "Not enough evidence.",
  };
  assert.throws(
    () => selectReviewedTotalOverrides(artifact, LEDGER_SHA),
    /not HIGH confidence/,
  );
});

test("selects MAIN plus every gallery slot and preserves exact mappings", () => {
  const totals = selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA);
  const selected = selectSealedLiveGallery(ledgerFixture(), totals, {
    expectedRows: 2,
  });

  assert.equal(selected.rows.length, 2);
  assert.equal(selected.mappings.length, 5);
  assert.deepEqual(
    selected.rows[0].images.map((image) => image.slot),
    ["MAIN", "GALLERY_1", "GALLERY_2"],
  );
  assert.equal(selected.rows[1].canonical_total_units, 6);
  assert.equal(selected.rows[1].reviewed_total_units, 24);
  assert.equal(selected.rows[1].expected_total_units, 24);
  assert.equal(selected.rows[1].expected_total_source, "HIGH_REVIEWED_OVERRIDE");
  assert.equal(
    uncrustablesLiveGalleryTotalLabel(selected.rows[1]),
    "expected 24 (HIGH reviewed; canonical 6)",
  );
  assert.equal(
    uncrustablesLiveGalleryRecipeLabel(selected.rows[1]),
    "24x Smucker's Uncrustables Peanut Butter & Blackberry",
  );
});

test("deduplicates network targets by exact URL while preserving all slot mappings", () => {
  const selected = selectSealedLiveGallery(
    ledgerFixture(),
    selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA),
    { expectedRows: 2 },
  );
  const groups = groupLiveGalleryMappingsByExactUrl(selected.mappings);
  assert.equal(groups.length, 4);
  const shared = groups.find((group) => group.requested_url.endsWith("/SHARED.jpg"));
  assert.deepEqual(
    shared?.mappings.map((mapping) => `${mapping.sku}:${mapping.slot}`),
    ["AA-AS11-AAAA:GALLERY_1", "SZ-ASPI-JFAT:GALLERY_1"],
  );
});

test("deduplicates fetched exact URLs by exact SHA while preserving every mapping", () => {
  const grouped = groupLiveGalleryReferencesByExactSha256([
    {
      sha256: "a".repeat(64),
      url_ordinal: 1,
      mapping_ordinals: [1, 3],
    },
    {
      sha256: "a".repeat(64),
      url_ordinal: 2,
      mapping_ordinals: [2, 4],
    },
    {
      sha256: "b".repeat(64),
      url_ordinal: 3,
      mapping_ordinals: [5],
    },
  ]);
  assert.deepEqual(grouped, [
    {
      sha256: "a".repeat(64),
      url_ordinals: [1, 2],
      mapping_ordinals: [1, 2, 3, 4],
    },
    {
      sha256: "b".repeat(64),
      url_ordinals: [3],
      mapping_ordinals: [5],
    },
  ]);
});

test("canonical/component drift cannot silently label stale canonical total", () => {
  assert.throws(
    () => selectSealedLiveGallery(ledgerFixture(), new Map(), { expectedRows: 2 }),
    /HIGH-reviewed override required/,
  );
});

test("reviewed total must agree with exact recipe allocation", () => {
  const totals = selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA);
  totals.set("SZ-ASPI-JFAT", {
    sku: "SZ-ASPI-JFAT",
    total_units: 30,
    confidence: "HIGH",
    rationale: "Incorrect test override",
  });
  assert.throws(
    () => selectSealedLiveGallery(ledgerFixture(), totals, { expectedRows: 2 }),
    /reviewed total 30 conflicts with component allocation 24/,
  );
});

test("fails closed unless the exact fetched row count is present", () => {
  assert.throws(
    () =>
      selectSealedLiveGallery(
        ledgerFixture(),
        selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA),
        { expectedRows: 164 },
      ),
    /Expected exactly 164.*found 2/,
  );
});

test("fails closed on disallowed or malformed gallery entries", () => {
  const invalid = ledgerFixture();
  const rows = invalid.rows as Array<Record<string, unknown>>;
  const live = rows[0].live as Record<string, unknown>;
  live.gallery_image_urls = ["https://example.com/not-amazon.jpg"];
  assert.throws(
    () =>
      selectSealedLiveGallery(
        invalid,
        selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA),
        { expectedRows: 2 },
      ),
    /not allow-listed/,
  );
});

test("fails closed on duplicate fetched SKU or ASIN", () => {
  const duplicate = ledgerFixture();
  const rows = duplicate.rows as Array<Record<string, unknown>>;
  rows[1].asin = "B0TEST0001";
  assert.throws(
    () =>
      selectSealedLiveGallery(
        duplicate,
        selectReviewedTotalOverrides(reviewedArtifact(), LEDGER_SHA),
        { expectedRows: 2 },
      ),
    /Duplicate fetched ASIN/,
  );
});

test("retry helpers are bounded and deterministic when jitter is injected", () => {
  assert.equal(parseUncrustablesLiveGalleryRetryAfterMs("2"), 2_000);
  assert.equal(
    parseUncrustablesLiveGalleryRetryAfterMs(
      "Wed, 21 Oct 2026 07:28:00 GMT",
      Date.parse("Wed, 21 Oct 2026 07:27:59 GMT"),
    ),
    1_000,
  );
  assert.equal(uncrustablesLiveGalleryRetryBackoffMs(3, 500, () => 0), 2_000);
});

test("manifest seal is canonical and detects mutation", () => {
  const body = { z: 1, nested: { b: 2, a: 1 } };
  assert.equal(
    canonicalUncrustablesLiveGalleryJson(body),
    '{"nested":{"a":1,"b":2},"z":1}',
  );
  const manifest: Record<string, unknown> = {
    ...body,
    body_sha256: sealUncrustablesLiveGalleryManifestBody(body),
  };
  assert.equal(verifyUncrustablesLiveGalleryManifestSeal(manifest), true);
  manifest.z = 2;
  assert.equal(verifyUncrustablesLiveGalleryManifestSeal(manifest), false);
});
