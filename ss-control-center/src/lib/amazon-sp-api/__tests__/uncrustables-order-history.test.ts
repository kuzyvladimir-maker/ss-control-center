import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateUncrustablesSales,
  buildHistoricalWindows,
  parseAmazonAllOrdersReport,
  parseChannelMaxInventory,
} from "../uncrustables-order-history";

test("buildHistoricalWindows creates adjacent non-overlapping windows of at most 30 days", () => {
  assert.deepEqual(
    buildHistoricalWindows("2024-12-01T00:00:00Z", "2025-02-01T00:00:00Z"),
    [
      {
        id: "20241201-20241231",
        startTime: "2024-12-01T00:00:00.000Z",
        endTime: "2024-12-31T00:00:00.000Z",
      },
      {
        id: "20241231-20250130",
        startTime: "2024-12-31T00:00:00.000Z",
        endTime: "2025-01-30T00:00:00.000Z",
      },
      {
        id: "20250130-20250201",
        startTime: "2025-01-30T00:00:00.000Z",
        endTime: "2025-02-01T00:00:00.000Z",
      },
    ],
  );
});

test("inventory and order reports join deleted SKU rows and aggregate non-cancelled revenue", () => {
  const inventory = parseChannelMaxInventory([
    "ASIN\tIsSelling\tItemName\tItemThumbnail\tSKU\tWhenAddedToCMax",
    "B0WINNER\tY\tUncrustables Raspberry 30 Count\tthumb.jpg\tSKU-WINNER\t12/10/2024",
    "B0OTHER\tN\tOther Product\t\tSKU-OTHER\t12/10/2024",
    "B0DELETED\tN\tUncrustables Grape 24 Count\told.jpg\tSKU-DELETED\t12/11/2024",
  ].join("\n"));
  assert.equal(inventory.length, 2);
  assert.equal(inventory[1].isSelling, true);

  const header = [
    "amazon-order-id", "purchase-date", "last-updated-date", "order-status",
    "fulfillment-channel", "product-name", "sku", "asin", "item-status",
    "quantity", "currency", "item-price", "shipping-price", "gift-wrap-price",
    "item-promotion-discount", "ship-promotion-discount", "is-business-order",
  ];
  const report = [
    header.join("\t"),
    ["O1", "2025-01-01T10:00:00Z", "2025-01-02T10:00:00Z", "Shipped", "MFN",
      "Uncrustables Raspberry 30 Count", "SKU-WINNER", "B0WINNER", "Shipped", "2",
      "USD", "100.00", "10.00", "0", "5.00", "1.00", "false"].join("\t"),
    ["O2", "2025-01-03T10:00:00Z", "2025-01-03T11:00:00Z", "Cancelled", "MFN",
      "Historical title without keyword", "SKU-DELETED", "B0DELETED", "Cancelled", "1",
      "USD", "50.00", "0", "0", "0", "0", "false"].join("\t"),
    ["O3", "2025-01-04T10:00:00Z", "2025-01-04T11:00:00Z", "Shipped", "MFN",
      "Other Product", "SKU-OTHER", "B0OTHER", "Shipped", "1",
      "USD", "20.00", "0", "0", "0", "0", "false"].join("\t"),
  ].join("\n");
  const aggregate = aggregateUncrustablesSales(
    parseAmazonAllOrdersReport(report),
    inventory,
  );
  assert.equal(aggregate.length, 2);
  assert.equal(aggregate[0].sku, "SKU-WINNER");
  assert.equal(aggregate[0].units, 2);
  assert.equal(aggregate[0].grossRevenue, 104);
  assert.equal(aggregate[1].sku, "SKU-DELETED");
  assert.equal(aggregate[1].units, 0);
  assert.equal(aggregate[1].cancelledUnits, 1);
  assert.equal(aggregate[1].distinctOrders, 0);
  assert.equal(aggregate[1].cancelledOrders, 1);
  assert.equal(aggregate[1].channelMax?.isSelling, false);
});

test("order parser rejects a missing identity header", () => {
  assert.throws(
    () => parseAmazonAllOrdersReport("amazon-order-id\tpurchase-date\nO1\t2025-01-01"),
    /required TSV column is missing/,
  );
});
