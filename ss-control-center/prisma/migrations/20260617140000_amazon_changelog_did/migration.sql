-- Change log: diff-in-diff lift columns (Phase 1, control-adjusted measurement).
ALTER TABLE "AmazonChangeLog" ADD COLUMN "didMeasuredAt" DATETIME;
ALTER TABLE "AmazonChangeLog" ADD COLUMN "didConfidence" TEXT;
ALTER TABLE "AmazonChangeLog" ADD COLUMN "didLiftConvPp" REAL;
ALTER TABLE "AmazonChangeLog" ADD COLUMN "didLiftRevPerDay" REAL;
ALTER TABLE "AmazonChangeLog" ADD COLUMN "didControlN" INTEGER;
