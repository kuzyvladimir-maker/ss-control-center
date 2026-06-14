-- Amazon Growth — per-listing PRODUCTIVITY metrics + Opportunity Score.
-- The module must rank and advise on each listing's productivity: impressions,
-- click-through, conversion, add-to-cart, purchases, returns, revenue — so the
-- AI advisor can reason over the full funnel. Sources: Sales & Traffic (sessions,
-- page views, conversion, buy-box, units, revenue), Brand Analytics SQP
-- (impressions/clicks/CTR/cart-adds/purchases — keyword-level, aggregated to ASIN),
-- returns (refund/return data). Opportunity Score = computed sales-upside rank.

ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "opportunityScore" REAL;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "revenue30d" REAL;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "returns30d" INTEGER;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "returnRate" REAL;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "impressions30d" INTEGER;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "clicks30d" INTEGER;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "ctr" REAL;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "cartAdds30d" INTEGER;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "cartAddRate" REAL;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "purchases30d" INTEGER;
ALTER TABLE "AmazonListingHealthItem" ADD COLUMN "purchaseRate" REAL;

CREATE INDEX "AmazonListingHealthItem_storeIndex_opportunityScore_idx"
    ON "AmazonListingHealthItem"("storeIndex", "opportunityScore");
