-- CreateTable
CREATE TABLE "CsCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "store" TEXT,
    "orderId" TEXT,
    "customerName" TEXT,
    "product" TEXT,
    "productType" TEXT,
    "category" TEXT,
    "categoryName" TEXT,
    "priority" TEXT,
    "language" TEXT,
    "branch" TEXT,
    "branchName" TEXT,
    "response" TEXT,
    "action" TEXT,
    "urgency" TEXT,
    "internalNotes" TEXT,
    "imageData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShippingPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShippingPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "sku" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "productType" TEXT NOT NULL,
    "weight" REAL,
    "boxSize" TEXT,
    "budgetMax" REAL,
    "carrier" TEXT,
    "service" TEXT,
    "price" REAL,
    "edd" TEXT,
    "deliveryBy" TEXT,
    "actualShipDay" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "trackingNumber" TEXT,
    "labelPdfUrl" TEXT,
    "allocationId" TEXT,
    "carrierId" TEXT,
    "remoteShipmentId" TEXT,
    "serviceType" TEXT,
    "subCarrierId" TEXT,
    "serviceCarrier" TEXT,
    "totalNetCharge" TEXT,
    "baseRate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShippingPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ShippingPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");
