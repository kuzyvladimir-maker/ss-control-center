-- Finance Core — PayoutLine (bucketed payout breakdown)

CREATE TABLE "PayoutLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payoutId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PayoutLine_payoutId_idx" ON "PayoutLine"("payoutId");
CREATE INDEX "PayoutLine_bucket_idx" ON "PayoutLine"("bucket");
