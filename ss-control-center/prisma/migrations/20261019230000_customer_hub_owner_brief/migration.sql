-- Customer Hub: Russian brief for the owner per analyzed message.
-- Turso: scripts/turso-migrate-customer-hub-autosend.mjs (idempotent).

ALTER TABLE "BuyerMessage" ADD COLUMN "ownerBrief" TEXT;
