-- Persist the original outbound label cost from Veeqo
-- (shipment.outbound_label_charges.value) so adjustment enrichment can
-- copy it onto ShippingAdjustment.originalLabelCost.

ALTER TABLE "AmazonOrderShipment" ADD COLUMN "outboundLabelCost" REAL;
