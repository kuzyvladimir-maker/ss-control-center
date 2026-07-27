-- CreateTable
CREATE TABLE "SellerFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amazonFeedbackId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "rating" INTEGER NOT NULL,
    "comments" TEXT,
    "feedbackDate" TEXT NOT NULL,
    "store" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'Amazon',
    "removable" BOOLEAN,
    "removalCategory" TEXT,
    "removalConfidence" TEXT,
    "suggestedAction" TEXT,
    "aiReasoning" TEXT,
    "removalRequestText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "removalSubmittedAt" DATETIME,
    "removalDecision" TEXT,
    "removalDecisionAt" DATETIME,
    "buyerContactSent" BOOLEAN NOT NULL DEFAULT false,
    "buyerContactText" TEXT,
    "buyerContactSentAt" DATETIME,
    "csCaseId" TEXT,
    "vladimirNotes" TEXT
);

-- CreateTable
CREATE TABLE "ProductReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asin" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "reviewDate" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "store" TEXT,
    "responseGenerated" TEXT,
    "responseSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "responseSubmittedAt" DATETIME,
    "vladimirNotes" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerFeedback_amazonFeedbackId_key" ON "SellerFeedback"("amazonFeedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_reviewId_key" ON "ProductReview"("reviewId");
