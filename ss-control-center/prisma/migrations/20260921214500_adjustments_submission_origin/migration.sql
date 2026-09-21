-- Источник подачи в истории урегулирования.
--
-- Только добавление: две колонки и индекс. 20.09.2026 в кейс Salutem Solutions
-- попали 16 строк AMZ Commerce — без этих полей по журналу невозможно увидеть,
-- из какого кабинета и с какого VPS ушло обращение.
--
-- Боевая база — Turso, туда накатывается скриптом
-- scripts/turso-migrate-adjustments-submission-origin.mjs.

ALTER TABLE "AdjustmentDisputeEvent" ADD COLUMN "submittedFromStore" TEXT;
ALTER TABLE "AdjustmentDisputeEvent" ADD COLUMN "submittedFromVps" TEXT;

CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_submittedFromStore_idx"
  ON "AdjustmentDisputeEvent"("submittedFromStore");
