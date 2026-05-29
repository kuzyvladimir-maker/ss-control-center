-- Adjustments Module — Phase A.
--
-- Schema changes:
--   * orderId: NOT NULL → NULLABLE. Amazon's PostageBilling_PostageAdjustment
--     events (the real "carrier reweigh recharge") carry no per-order
--     attribution. Order/SKU linkage will come from Settlement Reports in
--     Phase B; the column must accept NULL meanwhile.
--   * storeId, currency, rawType: new optional fields. storeId tracks which
--     account the row came from; currency defaults to USD at app layer;
--     rawType preserves the original Amazon AdjustmentType string for
--     traceability (e.g. PostageBilling_PostageAdjustment).
--   * Indexes on (channel, createdAt), (adjustmentDate), (sku) for the
--     /api/adjustments and /api/adjustments/stats queries.
--
-- Safe: ShippingAdjustment is currently empty on prod (0 rows) per the
-- read-only audit 2026-05-22 — no risk of data loss in the recreate.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ShippingAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "storeId" TEXT,
    "currency" TEXT,
    "orderId" TEXT,
    "amazonOrderId" TEXT,
    "walmartOrderId" TEXT,
    "adjustmentDate" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "adjustmentAmount" REAL NOT NULL,
    "adjustmentReason" TEXT,
    "rawType" TEXT,
    "sku" TEXT,
    "productName" TEXT,
    "carrier" TEXT,
    "service" TEXT,
    "declaredWeightLbs" REAL,
    "declaredDimL" REAL,
    "declaredDimW" REAL,
    "declaredDimH" REAL,
    "originalLabelCost" REAL,
    "adjustedWeightLbs" REAL,
    "adjustedDimL" REAL,
    "adjustedDimW" REAL,
    "adjustedDimH" REAL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "skuDataFixed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT
);

INSERT INTO "new_ShippingAdjustment" (
    "id", "createdAt", "externalId", "channel", "orderId", "amazonOrderId",
    "walmartOrderId", "adjustmentDate", "adjustmentType", "adjustmentAmount",
    "adjustmentReason", "sku", "productName", "carrier", "service",
    "declaredWeightLbs", "declaredDimL", "declaredDimW", "declaredDimH",
    "originalLabelCost", "adjustedWeightLbs", "adjustedDimL", "adjustedDimW",
    "adjustedDimH", "reviewed", "skuDataFixed", "notes"
)
SELECT
    "id", "createdAt", "externalId", "channel", "orderId", "amazonOrderId",
    "walmartOrderId", "adjustmentDate", "adjustmentType", "adjustmentAmount",
    "adjustmentReason", "sku", "productName", "carrier", "service",
    "declaredWeightLbs", "declaredDimL", "declaredDimW", "declaredDimH",
    "originalLabelCost", "adjustedWeightLbs", "adjustedDimL", "adjustedDimW",
    "adjustedDimH", "reviewed", "skuDataFixed", "notes"
FROM "ShippingAdjustment";

DROP TABLE "ShippingAdjustment";
ALTER TABLE "new_ShippingAdjustment" RENAME TO "ShippingAdjustment";

CREATE UNIQUE INDEX "ShippingAdjustment_externalId_key" ON "ShippingAdjustment"("externalId");
CREATE INDEX "ShippingAdjustment_channel_createdAt_idx" ON "ShippingAdjustment"("channel", "createdAt");
CREATE INDEX "ShippingAdjustment_adjustmentDate_idx" ON "ShippingAdjustment"("adjustmentDate");
CREATE INDEX "ShippingAdjustment_sku_idx" ON "ShippingAdjustment"("sku");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
