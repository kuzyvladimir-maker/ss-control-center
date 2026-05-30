-- Dispute tracking on ShippingAdjustment.
-- Once Vladimir files a Buy Shipping Adjustment dispute via Amazon
-- Seller Central support, we record the Case ID + timestamp so the
-- /adjustments page can:
--   * show "Disputed · #20424098481" badge instead of "New"
--   * deep-link the badge to /cu/case-dashboard/view-case?caseID=...
--   * exclude the row from the sidebar pillCount queue

ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputeCaseId" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputedAt" DATETIME;
