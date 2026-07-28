-- Seal every paid Product Truth source observation to the exact durable budget
-- receipt that authorized its provider request. This migration runs only after
-- both canonical evidence storage and the metered budget ledger exist.
-- It performs no backfill, provider call, or mutation of historical rows.

CREATE TRIGGER "DonorOfferObservation_metered_receipt_guard"
BEFORE INSERT ON "DonorOfferObservation"
WHEN (
  lower(NEW."sourceApi") IN ('unwrangle','bluecart','oxylabs','oxylabs-google')
  AND NEW."meteredReceiptId" IS NULL
) OR (
  NEW."meteredReceiptId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "MeteredReservationReceipt" receipt
    JOIN "MeteredProviderBudget" budget ON budget."id" = receipt."budgetId"
    WHERE receipt."id" = NEW."meteredReceiptId"
      AND receipt."status" = 'succeeded'
      AND receipt."operation" IN ('search','query')
      AND EXISTS (
        SELECT 1
        FROM json_each(budget."operations") permitted
        WHERE permitted.type = 'text'
          AND permitted.value = receipt."operation"
      )
      AND budget."runId" = NEW."runId"
      AND budget."approvalId" = NEW."approvalId"
      AND (
        lower(NEW."sourceApi") = budget."provider"
        OR lower(NEW."sourceApi") LIKE budget."provider" || '-%'
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_METERED_RECEIPT_INVALID');
END;

CREATE TRIGGER "ProductContentObservation_metered_receipt_guard"
BEFORE INSERT ON "ProductContentObservation"
WHEN (
  lower(NEW."sourceApi") IN ('unwrangle','bluecart','oxylabs','oxylabs-google')
  AND NEW."meteredReceiptId" IS NULL
) OR (
  NEW."meteredReceiptId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "MeteredReservationReceipt" receipt
    JOIN "MeteredProviderBudget" budget ON budget."id" = receipt."budgetId"
    WHERE receipt."id" = NEW."meteredReceiptId"
      AND receipt."status" = 'succeeded'
      AND receipt."operation" IN ('search','query','detail')
      AND EXISTS (
        SELECT 1
        FROM json_each(budget."operations") permitted
        WHERE permitted.type = 'text'
          AND permitted.value = receipt."operation"
      )
      AND budget."runId" = NEW."runId"
      AND budget."approvalId" = NEW."approvalId"
      AND (
        lower(NEW."sourceApi") = budget."provider"
        OR lower(NEW."sourceApi") LIKE budget."provider" || '-%'
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_OBSERVATION_METERED_RECEIPT_INVALID');
END;
