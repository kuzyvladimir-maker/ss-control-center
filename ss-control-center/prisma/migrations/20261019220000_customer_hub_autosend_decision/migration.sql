-- Customer Hub auto-send verdict per buyer message (shadow mode first).
--
-- Только добавление одной колонки. Боевая база — Turso, туда накатывается
-- скриптом scripts/turso-migrate-customer-hub-autosend.mjs.

ALTER TABLE "BuyerMessage" ADD COLUMN "autosendDecision" TEXT;
