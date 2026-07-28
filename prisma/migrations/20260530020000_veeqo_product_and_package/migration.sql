-- Persist Veeqo product + package metadata so the /adjustments expansion
-- can show product image, declared package dims, and a tracking-number
-- link. These let Vladimir judge whether a carrier reweigh charge was
-- justified before disputing.

ALTER TABLE "AmazonOrderShipment" ADD COLUMN "productName"      TEXT;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "productImageUrl"  TEXT;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageWeightLbs" REAL;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimL"      REAL;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimW"      REAL;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimH"      REAL;
ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageName"      TEXT;

-- Same on ShippingAdjustment — the page reads from here directly.
ALTER TABLE "ShippingAdjustment" ADD COLUMN "productImageUrl" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "trackingNumber"  TEXT;
