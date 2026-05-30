-- AmazonOrderShipment — per-order carrier/tracking lookup populated by
-- /api/cron/orders-shipments-amazon. Used to enrich ShippingAdjustment
-- rows with carrier so the /adjustments page carrier filter works.

CREATE TABLE "AmazonOrderShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    "amazonOrderId" TEXT NOT NULL,
    "sku" TEXT,
    "asin" TEXT,
    "storeIndex" INTEGER,

    "carrier" TEXT,
    "trackingNumber" TEXT,
    "shipServiceLevel" TEXT,
    "shipDate" TEXT,
    "promiseDate" TEXT,
    "carrierInferred" TEXT
);

CREATE UNIQUE INDEX "AmazonOrderShipment_amazonOrderId_sku_key"
    ON "AmazonOrderShipment"("amazonOrderId", "sku");

CREATE INDEX "AmazonOrderShipment_amazonOrderId_idx"
    ON "AmazonOrderShipment"("amazonOrderId");

CREATE INDEX "AmazonOrderShipment_trackingNumber_idx"
    ON "AmazonOrderShipment"("trackingNumber");
