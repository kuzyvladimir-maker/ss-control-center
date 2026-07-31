-- Merge Orders — combine same-address orders into one shipment in the Command
-- Center instead of in Veeqo.
--
-- Merging in Veeqo bypasses the Placed (procurement) gate: a label could be
-- bought for an order whose goods were never purchased, the order then left
-- the Procurement queue, and the shortfall went unseen. Owning the flow here
-- keeps that gate in force for every member of a group.
--
-- No data is migrated; these are new tables only.

CREATE TABLE "MergeGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "channelKind" TEXT NOT NULL,
    "storeName" TEXT,
    "primaryOrderId" TEXT NOT NULL,
    "productType" TEXT,
    "boxSize" TEXT,
    "weight" REAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "service" TEXT,
    "price" REAL,
    "labelPdfUrl" TEXT,
    "boughtAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "MergeGroup_status_idx" ON "MergeGroup"("status");
CREATE INDEX "MergeGroup_checksum_idx" ON "MergeGroup"("checksum");

CREATE TABLE "MergeGroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "allocationId" TEXT,
    "walmartPurchaseOrderId" TEXT,
    "shipmentSyncedAt" DATETIME,
    "shipmentSyncError" TEXT,
    CONSTRAINT "MergeGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MergeGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MergeGroupMember_groupId_orderId_key" ON "MergeGroupMember"("groupId", "orderId");
CREATE INDEX "MergeGroupMember_orderId_idx" ON "MergeGroupMember"("orderId");
