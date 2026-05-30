-- Add image-cache columns to WalmartCatalogItem so we can display product
-- thumbnails next to SKUs in the Procurement "Снять с продажи" modal.
-- Walmart's Marketplace API doesn't expose images; we lazily scrape the
-- og:image meta tag from the public product page on first use.

ALTER TABLE "WalmartCatalogItem" ADD COLUMN "mainImageUrl" TEXT;
ALTER TABLE "WalmartCatalogItem" ADD COLUMN "mainImageFetchedAt" DATETIME;
