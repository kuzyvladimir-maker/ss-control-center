import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceWalmartOfferRestorationState,
  inspectWalmartOwnOfferHtml,
  markWalmartRestorationNotificationsDelivered,
  pendingWalmartRestorationSkus,
  WALMART_OFFER_RESTORATION_TARGETS,
} from "../offer-restoration-monitor.ts";

const target = WALMART_OFFER_RESTORATION_TARGETS[0];
const OBSERVED_AT = "2026-08-09T12:00:00.000Z";

function html(productOverrides: Record<string, unknown> = {}): string {
  const product = {
    usItemId: target.itemId,
    canonicalUrl: `/ip/Test-Product/${target.itemId}`,
    name: target.title,
    availabilityStatus: "OUT_OF_STOCK",
    itemPageAvailabilityStatus: "OUT_OF_STOCK",
    showAtc: false,
    sellerName: "Other Seller LLC",
    sellerDisplayName: "Other Seller",
    sellerId: "OTHER",
    catalogSellerId: 999,
    priceInfo: { currentPrice: { price: 20 } },
    fulfillmentOptions: [
      { type: "SHIPPING", availabilityStatus: "NOT_AVAILABLE" },
    ],
    secondaryOffers: [],
    ...productOverrides,
  };
  const payload = {
    props: { pageProps: { initialData: { data: { product } } } },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

const ownIdentity = {
  sellerName: "SIRIUS TRADING INTERNATIONAL LLC",
  sellerDisplayName: "STARFITSTORE",
  sellerId: "AAF796A61B674A8E93906B5A41C19CDB",
  catalogSellerId: 101604958,
};

const buyable = {
  availabilityStatus: "IN_STOCK",
  priceInfo: { currentPrice: { price: 31.25 } },
  fulfillmentOptions: [
    { type: "SHIPPING", availabilityStatus: "IN_STOCK" },
  ],
};

test("does not confuse another buyable seller with our restored offer", () => {
  const observation = inspectWalmartOwnOfferHtml(
    html({
      availabilityStatus: "IN_STOCK",
      itemPageAvailabilityStatus: "IN_STOCK",
      showAtc: true,
      ...buyable,
    }),
    target,
    { observedAt: OBSERVED_AT },
  );
  assert.equal(observation.status, "UNAVAILABLE");
  assert.equal(observation.reason, "OWN_OFFER_NOT_PRESENT");
  assert.equal(observation.pageAvailabilityStatus, "IN_STOCK");
});

test("recognizes the exact own primary offer only with buyer and shipping proof", () => {
  const observation = inspectWalmartOwnOfferHtml(
    html({ ...ownIdentity, ...buyable, showAtc: true }),
    target,
    { observedAt: OBSERVED_AT },
  );
  assert.equal(observation.status, "AVAILABLE");
  assert.equal(observation.reason, "OWN_OFFER_BUYABLE");
  assert.equal(observation.matchedOffer?.role, "PRIMARY");
  assert.equal(observation.matchedOffer?.price, 31.25);
});

test("recognizes an exact own secondary offer without using reviews or a foreign buy box", () => {
  const observation = inspectWalmartOwnOfferHtml(
    html({
      availabilityStatus: "IN_STOCK",
      showAtc: true,
      secondaryOffers: [{ ...ownIdentity, ...buyable }],
    }),
    target,
    { observedAt: OBSERVED_AT },
  );
  assert.equal(observation.status, "AVAILABLE");
  assert.equal(observation.matchedOffer?.role, "SECONDARY");
});

test("fails closed on a bot page or a different item ID", () => {
  const bot = inspectWalmartOwnOfferHtml("<html>captcha</html>", target, {
    observedAt: OBSERVED_AT,
  });
  assert.equal(bot.status, "UNKNOWN");
  assert.match(bot.error ?? "", /__NEXT_DATA__/);

  const wrong = inspectWalmartOwnOfferHtml(
    html().replaceAll(target.itemId, "999"),
    target,
    { observedAt: OBSERVED_AT },
  );
  assert.equal(wrong.status, "UNKNOWN");
  assert.match(wrong.error ?? "", /item ID/);
});

test("queues one durable notification per unavailable-to-available transition", () => {
  const unavailable = inspectWalmartOwnOfferHtml(html(), target, {
    observedAt: OBSERVED_AT,
  });
  const baseline = advanceWalmartOfferRestorationState(
    null,
    [unavailable],
    OBSERVED_AT,
  );
  assert.deepEqual(pendingWalmartRestorationSkus(baseline), []);

  const restoredAt = "2026-08-09T16:00:00.000Z";
  const available = inspectWalmartOwnOfferHtml(
    html({ ...ownIdentity, ...buyable, showAtc: true }),
    target,
    { observedAt: restoredAt },
  );
  const restored = advanceWalmartOfferRestorationState(
    baseline,
    [available],
    restoredAt,
  );
  assert.deepEqual(pendingWalmartRestorationSkus(restored), [target.sku]);

  const delivered = markWalmartRestorationNotificationsDelivered(
    restored,
    [target.sku],
    "2026-08-09T16:01:00.000Z",
  );
  assert.deepEqual(pendingWalmartRestorationSkus(delivered), []);

  const stillAvailable = advanceWalmartOfferRestorationState(
    delivered,
    [available],
    "2026-08-09T20:00:00.000Z",
  );
  assert.deepEqual(pendingWalmartRestorationSkus(stillAvailable), []);
});
