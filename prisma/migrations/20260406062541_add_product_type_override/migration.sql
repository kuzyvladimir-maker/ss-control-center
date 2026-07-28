-- CreateTable
CREATE TABLE "ProductTypeOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductTypeOverride_productId_key" ON "ProductTypeOverride"("productId");
