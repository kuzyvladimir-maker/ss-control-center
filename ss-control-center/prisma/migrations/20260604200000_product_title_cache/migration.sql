-- ProductTitleCache — server-side cache for Claude-Haiku-cleaned product
-- titles used by the Procurement card's Copy button. Hits are O(1) DB read;
-- misses fall through to a Claude Haiku call and persist the result here.

CREATE TABLE "ProductTitleCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawTitle" TEXT NOT NULL,
    "cleanTitle" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ProductTitleCache_rawTitle_key" ON "ProductTitleCache"("rawTitle");
