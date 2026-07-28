-- WalmartListingRetirement — audit log for "Снять с продажи" actions from
-- the Procurement page. One row per SKU zeroed (Walmart inventory PUT
-- amount=0). previousQty captured pre-zero so we can roll back if the
-- supplier comes back; rolledBackAt/rolledBackBy populated on un-retire.

CREATE TABLE "WalmartListingRetirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "itemId" TEXT,
    "productTitle" TEXT,
    "previousQty" INTEGER,
    "reason" TEXT,
    "triggeredFrom" TEXT,
    "searchQuery" TEXT,
    "retiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" DATETIME,
    "rolledBackBy" TEXT
);

CREATE INDEX "WalmartListingRetirement_storeIndex_retiredAt_idx"
    ON "WalmartListingRetirement"("storeIndex", "retiredAt");

CREATE INDEX "WalmartListingRetirement_sku_idx"
    ON "WalmartListingRetirement"("sku");
