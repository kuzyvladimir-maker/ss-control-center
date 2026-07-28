// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-live-price-audit.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseProductPricingObservation,
  reconcileExactUncrustablesLivePrices,
  reconcileUncrustablesLivePriceRow,
  type ProductPricingObservation,
  type UncrustablesPriceIdentity,
} from "@/lib/bundle-factory/audit/uncrustables-live-price";
import type {
  UncrustablesLaunchPricingManifest,
  UncrustablesLaunchPricingRow,
} from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";

const identity: UncrustablesPriceIdentity = {
  sku: "QX-AS89-H8YC",
  asin: "B0H82RQ226",
  store_index: 1,
};

function pricingResponse(price: number, overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      Summary: {
        TotalOfferCount: 2,
        BuyBoxPrices: [{ LandedPrice: { Amount: 45.5, CurrencyCode: "USD" } }],
      },
      Offers: [
        {
          MyOffer: false,
          IsBuyBoxWinner: true,
          ListingPrice: { Amount: 45.5, CurrencyCode: "USD" },
          Shipping: { Amount: 0, CurrencyCode: "USD" },
        },
        {
          MyOffer: true,
          IsBuyBoxWinner: false,
          IsFeaturedMerchant: true,
          ListingPrice: { Amount: price, CurrencyCode: "USD" },
          Shipping: { Amount: 3.99, CurrencyCode: "USD" },
          ...overrides,
        },
      ],
    },
  };
}

function observation(price: number, observedAt: string): ProductPricingObservation {
  return parseProductPricingObservation({
    identity,
    responseBody: pricingResponse(price),
    observedAt,
    requestAttempts: 1,
  });
}

function proposalRow(arm: "A" | "B"): UncrustablesLaunchPricingRow {
  return {
    ...identity,
    count: 24,
    arm,
    lever: arm === "A" ? "COUPON_13" : "SALEPRICE_13",
    base_price: 76.99,
    floor_price: 66.95,
    effective_price: 66.98,
    discount_percent: 13,
    sale_price_schedule:
      arm === "A"
        ? null
        : {
            value_with_tax: 66.98,
            start_at: "2026-07-20T00:00:00.000Z",
            end_at: "2026-08-19T23:59:59.000Z",
          },
  };
}

test("Product Pricing parser uses only MyOffer and never substitutes Buy Box", () => {
  const parsed = observation(76.99, "2026-07-18T18:00:00.000Z");
  assert.equal(parsed.state, "OFFER");
  assert.equal(parsed.effective_live_price, 76.99);
  assert.equal(parsed.seller_landed_price, 80.98);
  assert.equal(parsed.buy_box_landed_price, 45.5);
  assert.equal(parsed.effective_live_price_source, "MY_OFFER_LISTING_PRICE");
  assert.match(parsed.response_body_sha256 ?? "", /^[a-f0-9]{64}$/);
});

test("Product Pricing parser records no own offer and ambiguous own offers distinctly", () => {
  const response = pricingResponse(76.99);
  (response.payload.Offers[1] as Record<string, unknown>).MyOffer = false;
  const noOffer = parseProductPricingObservation({
    identity,
    responseBody: response,
    observedAt: "2026-07-18T18:00:00.000Z",
    requestAttempts: 1,
  });
  assert.equal(noOffer.state, "NO_OFFER");
  assert.equal(noOffer.effective_live_price, null);

  const ambiguousResponse = pricingResponse(76.99);
  (ambiguousResponse.payload.Offers[0] as Record<string, unknown>).MyOffer = true;
  const ambiguous = parseProductPricingObservation({
    identity,
    responseBody: ambiguousResponse,
    observedAt: "2026-07-18T18:00:00.000Z",
    requestAttempts: 1,
  });
  assert.equal(ambiguous.state, "ERROR");
  assert.equal(ambiguous.error_code, "AMBIGUOUS_MY_OFFER");
});

test("reconciliation expects base before launch and for active coupons, Sale Price for active arm B", () => {
  const common = {
    identity,
    membership: "ACTIVE" as const,
    exclusionReason: null,
    startAt: "2026-07-20T00:00:00.000Z",
    endAt: "2026-08-19T23:59:59.000Z",
  };
  const prelaunchSale = reconcileUncrustablesLivePriceRow({
    ...common,
    proposalRow: proposalRow("B"),
    observation: observation(76.99, "2026-07-18T18:00:00.000Z"),
  });
  assert.equal(prelaunchSale.expected_listing_price, 76.99);
  assert.equal(prelaunchSale.expected_listing_price_basis, "PRELAUNCH_BASE");
  assert.equal(prelaunchSale.reconciliation_status, "MATCH_EXPECTED");

  const activeCoupon = reconcileUncrustablesLivePriceRow({
    ...common,
    proposalRow: proposalRow("A"),
    observation: observation(76.99, "2026-07-25T18:00:00.000Z"),
  });
  assert.equal(activeCoupon.expected_listing_price, 76.99);
  assert.equal(activeCoupon.expected_listing_price_basis, "ACTIVE_COUPON_BASE");
  assert.equal(activeCoupon.reconciliation_status, "MATCH_EXPECTED");

  const activeSale = reconcileUncrustablesLivePriceRow({
    ...common,
    proposalRow: proposalRow("B"),
    observation: observation(66.98, "2026-07-25T18:00:00.000Z"),
  });
  assert.equal(activeSale.expected_listing_price, 66.98);
  assert.equal(activeSale.expected_listing_price_basis, "ACTIVE_SALE_PRICE");
  assert.equal(activeSale.reconciliation_status, "MATCH_EXPECTED");
});

test("below-floor takes precedence over ordinary expected-price drift", () => {
  const row = reconcileUncrustablesLivePriceRow({
    identity,
    proposalRow: proposalRow("B"),
    observation: observation(66.94, "2026-07-25T18:00:00.000Z"),
    membership: "ACTIVE",
    exclusionReason: null,
    startAt: "2026-07-20T00:00:00.000Z",
    endAt: "2026-08-19T23:59:59.000Z",
  });
  assert.equal(row.live_vs_floor, "BELOW");
  assert.equal(row.reconciliation_status, "BELOW_FLOOR");
});

test("exact reconciliation refuses partial scope and accounts for all 164 identities", () => {
  assert.throws(
    () =>
      reconcileExactUncrustablesLivePrices({
        identities: [identity],
        manifest: {} as UncrustablesLaunchPricingManifest,
        observations: [observation(76.99, "2026-07-18T18:00:00.000Z")],
      }),
    /exactly 164/i,
  );

  const identities = Array.from({ length: 164 }, (_, index) => ({
    sku: `SKU-${String(index).padStart(3, "0")}`,
    asin: `ASIN-${String(index).padStart(3, "0")}`,
    store_index: 1,
  }));
  const rows = identities.slice(0, 163).map((member, index) => ({
    ...proposalRow(index % 2 === 0 ? "A" : "B"),
    ...member,
  }));
  const excluded = rows[162];
  const preExcluded = identities[163];
  const manifest = {
    rows,
    exclusions: [
      {
        sku: excluded.sku,
        asin: excluded.asin,
        reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
      },
    ],
    pre_assignment_exclusions: [
      {
        sku: preExcluded.sku,
        asin: preExcluded.asin,
        reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
      },
    ],
    scope: {
      start_at: "2026-07-20T00:00:00.000Z",
      end_at: "2026-08-19T23:59:59.000Z",
      active_rows: 162,
      excluded_rows: 1,
      pre_assignment_excluded_rows: 1,
    },
  } as unknown as UncrustablesLaunchPricingManifest;
  const observations = identities.map((member) =>
    parseProductPricingObservation({
      identity: member,
      responseBody: pricingResponse(76.99),
      observedAt: "2026-07-18T18:00:00.000Z",
      requestAttempts: 1,
    }),
  );
  const reconciled = reconcileExactUncrustablesLivePrices({
    identities,
    manifest,
    observations,
  });
  assert.equal(reconciled.rows.length, 164);
  assert.equal(
    reconciled.rows.filter((row) => row.cohort_membership === "ACTIVE").length,
    162,
  );
  assert.equal(reconciled.summary.excluded_offer_observed, 2);
});
