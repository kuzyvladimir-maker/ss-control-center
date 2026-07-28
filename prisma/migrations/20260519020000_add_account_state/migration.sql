-- Adds operational account state to AccountHealthSnapshot. Independent of
-- AHR score: an account can be DEACTIVATED while AHR is still Healthy
-- (selling privileges removed by Amazon enforcement). Resolved per-snapshot
-- via the Sellers API marketplaceParticipations endpoint; see
-- src/lib/amazon-sp-api/account-state.ts.
--
-- Values: ACTIVE | AT_RISK_OF_DEACTIVATION | DEACTIVATED | null (legacy rows).

ALTER TABLE "AccountHealthSnapshot" ADD COLUMN "accountState" TEXT;
