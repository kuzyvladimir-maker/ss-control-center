-- Walmart Catalog Cache.
--
-- Local mirror of the full Walmart item catalog, refreshed nightly by
-- /api/cron/walmart (syncCatalog sub-job). Walmart's /v3/items API has NO
-- server-side text search, so "find every SKU named X" used to paginate all
-- ~5 000 items live (~20 sequential API calls, 40-60 s). This table lets
-- Jackie's walmart_items_search query the DB in a few ms instead.
--
-- Inventory writes are unaffected — they still go straight to Walmart in real
-- time; only the name→SKU lookup reads from this cache.

CREATE TABLE "WalmartCatalogItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "itemId" TEXT,
    "title" TEXT,
    "lifecycleStatus" TEXT,
    "publishedStatus" TEXT,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WalmartCatalogItem_storeIndex_sku_key" ON "WalmartCatalogItem"("storeIndex", "sku");
CREATE INDEX "WalmartCatalogItem_storeIndex_publishedStatus_idx" ON "WalmartCatalogItem"("storeIndex", "publishedStatus");
