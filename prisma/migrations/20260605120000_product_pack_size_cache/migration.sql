-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductPackSizeCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawTitle" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductPackSizeCache_rawTitle_key" ON "ProductPackSizeCache"("rawTitle");
