import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createClient,
  type Client,
  type InStatement,
  type ResultSet,
} from "@libsql/client";

import {
  PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
  type ProductTruthMigrationCertification,
} from "../src/lib/sourcing/product-truth-backfill-readiness";
import {
  ProductTruthDatabaseTargetError,
  resolveProductTruthDatabaseTarget,
  type ProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = dirname(SCRIPT_PATH);
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_MIGRATIONS_ROOT = resolve(PROJECT_ROOT, "prisma", "migrations");

const RECEIPT_TABLE = "ProductTruthMigrationReceipt";
const RECEIPT_UPDATE_GUARD = "ProductTruthMigrationReceipt_update_guard";
const RECEIPT_DELETE_GUARD = "ProductTruthMigrationReceipt_delete_guard";
const ACTIVATION_RECEIPT_TABLE = "ProductTruthMigrationActivationReceipt";
const ACTIVATION_RECEIPT_UPDATE_GUARD = "ProductTruthMigrationActivationReceipt_update_guard";
const ACTIVATION_RECEIPT_DELETE_GUARD = "ProductTruthMigrationActivationReceipt_delete_guard";
const CONFIRMATION_PREFIX = "APPLY_PRODUCT_TRUTH_MIGRATIONS_V2";
const PLAN_CONTRACT_VERSION = "product-truth-migration-plan/2" as const;
const APPROVAL_CONTRACT_VERSION = "product-truth-migration-approval/2" as const;
const APPLY_CONTRACT_VERSION = "product-truth-migration-apply/2" as const;
const REPORT_CONTRACT_VERSION = "product-truth-migration-report/2" as const;
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1_000;
const ZERO_SHA256 = "0".repeat(64);

type RequiredSchema = Record<string, readonly string[]>;

interface MigrationContract {
  id: string;
  prerequisites: RequiredSchema;
  allowedRemovedIndexes?: readonly string[];
  requiredTables: readonly string[];
  requiredTriggers: readonly string[];
  requiredIndexes: readonly string[];
  requiredColumns: RequiredSchema;
}

const MIGRATION_CONTRACTS: readonly MigrationContract[] = [
  {
    id: "20260718230000_product_truth_queue_v2",
    prerequisites: {
      EnrichmentJob: ["id", "target", "status", "queuedAt", "createdAt"],
    },
    requiredTables: [],
    requiredTriggers: [],
    requiredIndexes: ["EnrichmentJob_one_active_idempotencyKey"],
    requiredColumns: {
      EnrichmentJob: [
        "normalizedTarget",
        "idempotencyKey",
        "requestedFields",
        "runId",
        "approvalId",
        "estimatedSpendUnits",
        "actualSpendUnits",
        "providerAttempts",
        "terminalReason",
        "completedFields",
        "unavailableFields",
        "checkpoint",
        "nextEligibleAt",
        "leaseOwner",
        "leaseToken",
        "leaseExpiresAt",
        "heartbeatAt",
      ],
    },
  },
  {
    id: "20260718233000_donor_harvest_lifecycle",
    prerequisites: { DonorProduct: ["id"] },
    requiredTables: ["DonorHarvestState"],
    requiredTriggers: [
      "DonorHarvestState_complete_insert_guard",
      "DonorHarvestState_complete_update_guard",
    ],
    requiredIndexes: ["DonorHarvestState_identity_key"],
    requiredColumns: {
      DonorHarvestState: [
        "id",
        "donorProductId",
        "source",
        "retailerProductId",
        "status",
        "requestedFields",
        "completedFields",
        "unavailableFields",
        "attempts",
        "maxAttempts",
        "leaseToken",
        "version",
      ],
    },
  },
  {
    id: "20260718234500_product_truth_evidence_provenance",
    prerequisites: {
      DonorProduct: [
        "id",
        "identityKey",
        "brand",
        "productLine",
        "flavor",
        "containerType",
        "size",
      ],
      DonorOffer: [
        "id",
        "donorProductId",
        "retailer",
        "retailerProductId",
        "via",
      ],
      SkuComponent: ["id", "donorProductId"],
      SkuCost: [
        "id",
        "sku",
        "effectiveDate",
        "productCost",
        "packagingCost",
        "iceCost",
        "totalCost",
        "costPerUnit",
        "packSize",
        "currency",
        "source",
        "createdAt",
      ],
    },
    allowedRemovedIndexes: ["SkuCost_sku_source_effectiveDate_key"],
    requiredTables: [
      "CanonicalProductVariant",
      "DonorProductVariantDecision",
      "ProductContentObservation",
      "DonorOfferObservation",
      "SkuComponentEvidence",
    ],
    requiredTriggers: [
      "CanonicalProductVariant_insert_collision_guard",
      "CanonicalProductVariant_duplicate_insert_guard",
      "CanonicalProductVariant_update_guard",
      "CanonicalProductVariant_delete_guard",
      "DonorProductVariantDecision_duplicate_insert_guard",
      "DonorProductVariantDecision_update_guard",
      "DonorProductVariantDecision_delete_guard",
      "DonorProduct_identity_status_insert",
      "DonorProduct_duplicate_insert_guard",
      "DonorProduct_identity_contract_update",
      "DonorProduct_delete_guard",
      "DonorOffer_delete_guard",
      "DonorOffer_duplicate_insert_guard",
      "DonorOffer_source_identity_update_guard",
      "ProductContentObservation_duplicate_insert_guard",
      "ProductContentObservation_exact_alias_guard",
      "ProductContentObservation_hash_contract_insert",
      "ProductContentObservation_update_guard",
      "ProductContentObservation_delete_guard",
      "DonorOfferObservation_source_identity_guard",
      "DonorOfferObservation_duplicate_insert_guard",
      "DonorOfferObservation_exact_alias_guard",
      "DonorOfferObservation_update_guard",
      "DonorOfferObservation_delete_guard",
      "SkuComponent_evidence_contract_insert",
      "SkuComponent_evidence_contract_update",
      "SkuComponentEvidence_contract_insert",
      "SkuComponentEvidence_duplicate_insert_guard",
      "SkuComponentEvidence_sealed_cost_guard",
      "SkuComponentEvidence_update_guard",
      "SkuComponentEvidence_delete_guard",
      "SkuCost_duplicate_insert_guard",
      "SkuCost_evidence_contract_insert",
      "SkuCost_component_evidence_guard",
      "SkuCost_update_guard",
      "SkuCost_delete_guard",
    ],
    requiredIndexes: [
      "CanonicalProductVariant_brand_line_idx",
      "DonorProductVariantDecision_one_exact_per_donor",
      "ProductContentObservation_variant_observed_idx",
      "DonorOfferObservation_variant_observed_idx",
      "SkuComponentEvidence_cost_component_key",
      "SkuCost_observationKey_key",
      "SkuCost_period_lookup_idx",
    ],
    requiredColumns: {
      CanonicalProductVariant: [
        "id",
        "variantKey",
        "identityHash",
        "keyVersion",
        "normalizedBrand",
        "normalizedProductLine",
        "normalizedFlavor",
        "normalizedModifiersJson",
        "normalizedForm",
        "sizeDimension",
        "sizeBaseAmount",
        "sizeBaseUnit",
        "outerPackCount",
        "identityJson",
        "createdAt",
      ],
      DonorProductVariantDecision: [
        "id",
        "decisionKey",
        "donorProductId",
        "canonicalVariantId",
        "decisionStatus",
        "matcherVersion",
        "evidenceHash",
        "evidenceJson",
        "decidedAt",
        "runId",
        "approvalId",
        "createdAt",
      ],
      DonorProduct: [
        "identityStatus",
        "identityMatcherVersion",
        "identityEvidenceJson",
        "identityConfirmedAt",
      ],
      DonorOffer: ["localityEvidence"],
      ProductContentObservation: [
        "id",
        "observationKey",
        "donorProductId",
        "canonicalVariantId",
        "variantDecisionId",
        "sourceUrl",
        "sourceApi",
        "contentHash",
        "fieldHashesJson",
        "contentJson",
        "observedAt",
        "runId",
        "approvalId",
        "meteredReceiptId",
        "createdAt",
      ],
      DonorOfferObservation: [
        "id",
        "observationKey",
        "donorOfferId",
        "donorProductId",
        "canonicalVariantId",
        "variantDecisionId",
        "observedAt",
        "runId",
        "approvalId",
        "meteredReceiptId",
        "createdAt",
      ],
      SkuComponent: [
        "contentDonorProductId",
        "priceEvidenceDonorProductId",
        "priceEvidenceOfferId",
        "priceEvidenceObservationId",
        "matchTier",
        "matcherVersion",
        "priceEvidenceStatus",
        "pricePolicyVersion",
        "priceEvidenceJson",
      ],
      SkuComponentEvidence: [
        "id",
        "evidenceKey",
        "skuCostId",
        "componentIndex",
        "evidenceStatus",
        "targetCanonicalVariantId",
        "contentCanonicalVariantId",
        "priceCanonicalVariantId",
        "contentObservationId",
        "priceObservationId",
        "matchTier",
        "matcherVersion",
        "pricePolicyVersion",
        "evidenceHash",
        "evidenceJson",
        "createdAt",
      ],
      SkuCost: [
        "observationKey",
        "recipeHash",
        "evidenceJson",
        "evidenceOutcome",
        "matcherVersion",
        "pricePolicyVersion",
        "runId",
        "approvalId",
      ],
    },
  },
  {
    id: "20260719000000_metered_budget_ledger",
    prerequisites: {},
    requiredTables: [
      "MeteredProviderBudget",
      "MeteredReservationReceipt",
      "MeteredReservationSettlement",
    ],
    requiredTriggers: [
      "MeteredProviderBudget_initial_counters_guard",
      "MeteredProviderBudget_duplicate_insert_guard",
      "MeteredProviderBudget_contract_immutable",
      "MeteredProviderBudget_counter_monotonic",
      "MeteredProviderBudget_delete_guard",
      "MeteredReservationReceipt_initial_state_guard",
      "MeteredReservationReceipt_operation_guard",
      "MeteredReservationReceipt_duplicate_insert_guard",
      "MeteredReservationReceipt_identity_immutable",
      "MeteredReservationReceipt_status_transition",
      "MeteredReservationReceipt_reservation_coverage_guard",
      "MeteredReservationReceipt_terminal_settlement_guard",
      "MeteredReservationReceipt_lifecycle_metadata_guard",
      "MeteredReservationReceipt_delete_guard",
      "MeteredReservationSettlement_duplicate_insert_guard",
      "MeteredReservationSettlement_apply",
      "MeteredReservationSettlement_immutable",
      "MeteredReservationSettlement_delete_guard",
    ],
    requiredIndexes: ["MeteredProviderBudget_run_provider_key"],
    requiredColumns: {
      MeteredProviderBudget: [
        "id",
        "runId",
        "approvalId",
        "provider",
        "maxCalls",
        "reservedCalls",
      ],
      MeteredReservationReceipt: [
        "id",
        "budgetId",
        "reservationKey",
        "status",
      ],
      MeteredReservationSettlement: ["id", "reservationId", "outcome", "settledAt"],
    },
  },
  {
    id: "20260719001000_product_truth_metered_evidence_link",
    // Its table prerequisites are required artifacts of the two earlier,
    // deterministically ordered migrations. Their postconditions are checked
    // before this SQL is executed in the same atomic transaction.
    prerequisites: {},
    requiredTables: [],
    requiredTriggers: [
      "DonorOfferObservation_metered_receipt_guard",
      "ProductContentObservation_metered_receipt_guard",
    ],
    requiredIndexes: [],
    requiredColumns: {},
  },
  {
    id: "20260719002000_product_truth_listing_scope",
    // The ordered evidence migration supplies SkuCost evidence columns. This
    // final migration intentionally performs no legacy inference/backfill.
    prerequisites: {},
    requiredTables: [
      "ProductTruthListingScope",
      "SkuCostListingScopeLink",
    ],
    requiredTriggers: [
      "ProductTruthListingScope_duplicate_insert_guard",
      "ProductTruthListingScope_update_guard",
      "ProductTruthListingScope_delete_guard",
      "SkuCostListingScopeLink_duplicate_insert_guard",
      "SkuCostListingScopeLink_contract_insert",
      "SkuCostListingScopeLink_update_guard",
      "SkuCostListingScopeLink_delete_guard",
      "SkuCost_listing_scope_contract_insert",
      "SkuCost_listing_scope_link_guard",
      "SkuCost_nonretail_listing_scope_guard",
    ],
    requiredIndexes: [
      "ProductTruthListingScope_channel_store_sku_key",
      "ProductTruthListingScope_manifest_idx",
      "SkuCostListingScopeLink_listing_cost_idx",
    ],
    requiredColumns: {
      ProductTruthListingScope: [
        "listingKey",
        "keyVersion",
        "channel",
        "storeIndex",
        "sku",
        "registrationKind",
        "manifestSchemaVersion",
        "manifestSha256",
        "manifestAsOf",
        "ownerDecisionId",
        "sourceReportId",
        "sourceContentSha256",
        "sourceCapturedAt",
        "createdAt",
      ],
      SkuCostListingScopeLink: [
        "skuCostId",
        "listingKey",
        "linkVersion",
        "createdAt",
      ],
    },
  },
  {
    id: "20260719003000_product_truth_queue_listing_scope",
    // ProductTruthListingScope and the queue-v2 lifecycle columns are supplied
    // by earlier migrations in this exact ordered set. These are the legacy
    // queue columns this migration itself must be able to terminalize safely.
    prerequisites: {
      EnrichmentJob: ["targetType", "finishedAt", "updatedAt"],
    },
    requiredTables: [],
    requiredTriggers: [
      "EnrichmentJob_queue_v3_quiescence_guard",
      "EnrichmentJob_listing_scope_contract_insert",
      "EnrichmentJob_listing_scope_identity_immutable",
      "EnrichmentJob_listing_scope_contract_update",
    ],
    requiredIndexes: [
      "EnrichmentJob_listing_scope_status_idx",
      "EnrichmentJob_one_active_listing_intent",
    ],
    requiredColumns: {
      EnrichmentJob: ["listingKey"],
    },
  },
  {
    id: "20260719004000_product_truth_operational_run",
    // All dependencies are artifacts of the sealed migration set above. The
    // operational migration adds control-plane state and cross-table guards;
    // it never infers scope or mutates historical evidence.
    prerequisites: {},
    requiredTables: [
      "ProductTruthOperationalRun",
      "ProductTruthOperationalRunItem",
      "ProductTruthOperationalEvent",
    ],
    requiredTriggers: [
      "ProductTruthOperationalRun_initial_state_guard",
      "ProductTruthOperationalRun_identity_immutable",
      "ProductTruthOperationalRun_status_transition_guard",
      "ProductTruthOperationalRun_lease_contract_guard",
      "ProductTruthOperationalRun_time_guard",
      "ProductTruthOperationalRun_event_chain_head_guard",
      "ProductTruthOperationalRun_delete_guard",
      "MeteredProviderBudget_operational_run_guard",
      "MeteredProviderBudget_operational_counter_guard",
      "MeteredReservationReceipt_operational_run_guard",
      "MeteredReservationReceipt_operational_authorization_guard",
      "ProductTruthOperationalRunItem_initial_state_guard",
      "ProductTruthOperationalRunItem_identity_immutable",
      "ProductTruthOperationalRunItem_attempt_guard",
      "ProductTruthOperationalRunItem_attempt_queue_guard",
      "ProductTruthOperationalRunItem_status_transition_guard",
      "ProductTruthOperationalRunItem_terminal_guard",
      "ProductTruthOperationalRunItem_time_guard",
      "ProductTruthOperationalRunItem_queue_scope_guard",
      "ProductTruthOperationalRunItem_delete_guard",
      "ProductTruthOperationalEvent_chain_guard",
      "ProductTruthOperationalEvent_advance_chain",
      "ProductTruthOperationalEvent_update_guard",
      "ProductTruthOperationalEvent_delete_guard",
    ],
    requiredIndexes: [
      "ProductTruthOperationalRun_one_running_environment",
      "ProductTruthOperationalRun_status_updated_idx",
      "ProductTruthOperationalRunItem_claim_idx",
      "ProductTruthOperationalRunItem_one_active_per_run",
      "ProductTruthOperationalEvent_run_idx",
    ],
    requiredColumns: {
      ProductTruthOperationalRun: [
        "runId", "approvalId", "planSchemaVersion", "planSha256", "planJson", "mode",
        "environment", "targetFingerprint", "manifestSha256", "targetSetSha256",
        "targetCount", "sourcePolicyJson", "providerCeilingsJson", "status", "leaseOwner",
        "leaseToken", "leaseExpiresAt", "heartbeatAt", "startedAt", "finishedAt",
        "eventChainHead", "reportSha256", "artifactIndexSha256", "createdAt", "updatedAt",
      ],
      ProductTruthOperationalRunItem: [
        "id", "runId", "listingKey", "ordinal", "requestedFields", "queueJobId", "status",
        "stage", "attempts", "leaseToken", "leaseExpiresAt", "checkpointJson",
        "checkpointSha256", "resultJson", "resultSha256", "lastError", "startedAt",
        "finishedAt", "createdAt", "updatedAt",
      ],
      ProductTruthOperationalEvent: [
        "id", "runId", "eventIndex", "eventType", "itemId", "previousHash", "payloadJson",
        "payloadSha256", "eventHash", "createdAt",
      ],
    },
  },
] as const;

const REQUIRED_FOREIGN_KEYS = [
  ["DonorHarvestState", "donorProductId", "DonorProduct", "id", "RESTRICT", "CASCADE"],
  ["DonorProductVariantDecision", "donorProductId", "DonorProduct", "id", "RESTRICT", "RESTRICT"],
  ["DonorProductVariantDecision", "canonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["ProductContentObservation", "donorProductId", "DonorProduct", "id", "RESTRICT", "RESTRICT"],
  ["ProductContentObservation", "canonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["ProductContentObservation", "variantDecisionId", "DonorProductVariantDecision", "id", "RESTRICT", "RESTRICT"],
  ["DonorOfferObservation", "donorOfferId", "DonorOffer", "id", "RESTRICT", "RESTRICT"],
  ["DonorOfferObservation", "donorProductId", "DonorProduct", "id", "RESTRICT", "RESTRICT"],
  ["DonorOfferObservation", "canonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["DonorOfferObservation", "variantDecisionId", "DonorProductVariantDecision", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "skuCostId", "SkuCost", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "targetCanonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "contentCanonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "priceCanonicalVariantId", "CanonicalProductVariant", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "contentObservationId", "ProductContentObservation", "id", "RESTRICT", "RESTRICT"],
  ["SkuComponentEvidence", "priceObservationId", "DonorOfferObservation", "id", "RESTRICT", "RESTRICT"],
  ["MeteredReservationReceipt", "budgetId", "MeteredProviderBudget", "id", "RESTRICT", "RESTRICT"],
  ["MeteredReservationSettlement", "reservationId", "MeteredReservationReceipt", "id", "RESTRICT", "RESTRICT"],
  ["SkuCostListingScopeLink", "skuCostId", "SkuCost", "id", "RESTRICT", "RESTRICT"],
  ["SkuCostListingScopeLink", "listingKey", "ProductTruthListingScope", "listingKey", "RESTRICT", "RESTRICT"],
  ["EnrichmentJob", "listingKey", "ProductTruthListingScope", "listingKey", "RESTRICT", "RESTRICT"],
  ["ProductTruthOperationalRunItem", "runId", "ProductTruthOperationalRun", "runId", "RESTRICT", "RESTRICT"],
  ["ProductTruthOperationalRunItem", "listingKey", "ProductTruthListingScope", "listingKey", "RESTRICT", "RESTRICT"],
  ["ProductTruthOperationalRunItem", "queueJobId", "EnrichmentJob", "id", "RESTRICT", "RESTRICT"],
  ["ProductTruthOperationalEvent", "runId", "ProductTruthOperationalRun", "runId", "RESTRICT", "RESTRICT"],
  ["ProductTruthOperationalEvent", "itemId", "ProductTruthOperationalRunItem", "id", "RESTRICT", "RESTRICT"],
] as const;

const RECEIPT_COLUMNS = [
  "migrationId",
  "migrationSha256",
  "migrationSetSha256",
  "activationContractSha256",
  "runId",
  "approvalId",
  "targetFingerprint",
  "planSha256",
  "approvalSha256",
  "schemaBeforeSha256",
  "schemaAfterSha256",
  "queueImpactSha256",
  "action",
  "appliedAt",
] as const;

const PRISMA_RECEIPT_UPDATE_GUARD = "ProductTruthPrismaMigrationReceipt_update_guard";
const PRISMA_RECEIPT_DELETE_GUARD = "ProductTruthPrismaMigrationReceipt_delete_guard";
const PRISMA_RECEIPT_DUPLICATE_GUARD = "ProductTruthPrismaMigrationReceipt_duplicate_guard";
const PRODUCT_TRUTH_MIGRATION_IDS = MIGRATION_CONTRACTS.map((contract) => contract.id);

function receiptSchemaSql(): string {
  const protectedMigrationNames = PRODUCT_TRUTH_MIGRATION_IDS
    .map((id) => `'${id.replaceAll("'", "''")}'`)
    .join(",");
  return `
CREATE TABLE "${RECEIPT_TABLE}" (
  "migrationId" TEXT NOT NULL PRIMARY KEY,
  "migrationSha256" TEXT NOT NULL CHECK (length("migrationSha256") = 64),
  "migrationSetSha256" TEXT NOT NULL CHECK (length("migrationSetSha256") = 64),
  "activationContractSha256" TEXT NOT NULL CHECK (length("activationContractSha256") = 64),
  "runId" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "targetFingerprint" TEXT NOT NULL CHECK (length("targetFingerprint") = 64),
  "planSha256" TEXT NOT NULL CHECK (length("planSha256") = 64),
  "approvalSha256" TEXT NOT NULL CHECK (length("approvalSha256") = 64),
  "schemaBeforeSha256" TEXT NOT NULL CHECK (length("schemaBeforeSha256") = 64),
  "schemaAfterSha256" TEXT NOT NULL CHECK (length("schemaAfterSha256") = 64),
  "queueImpactSha256" TEXT NOT NULL CHECK (length("queueImpactSha256") = 64),
  "action" TEXT NOT NULL CHECK ("action" = 'applied'),
  "appliedAt" DATETIME NOT NULL
);
CREATE TRIGGER "${RECEIPT_UPDATE_GUARD}"
BEFORE UPDATE ON "${RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_MIGRATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${RECEIPT_DELETE_GUARD}"
BEFORE DELETE ON "${RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_MIGRATION_RECEIPT_IMMUTABLE');
END;
CREATE TABLE "${ACTIVATION_RECEIPT_TABLE}" (
  "planSha256" TEXT NOT NULL PRIMARY KEY CHECK (length("planSha256") = 64),
  "approvalSha256" TEXT NOT NULL CHECK (length("approvalSha256") = 64),
  "migrationSetSha256" TEXT NOT NULL CHECK (length("migrationSetSha256") = 64),
  "activationContractSha256" TEXT NOT NULL CHECK (length("activationContractSha256") = 64),
  "targetFingerprint" TEXT NOT NULL CHECK (length("targetFingerprint") = 64),
  "reportSha256" TEXT NOT NULL CHECK (length("reportSha256") = 64),
  "reportJson" TEXT NOT NULL CHECK (json_valid("reportJson")),
  "completedAt" DATETIME NOT NULL
);
CREATE TRIGGER "${ACTIVATION_RECEIPT_UPDATE_GUARD}"
BEFORE UPDATE ON "${ACTIVATION_RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_MIGRATION_ACTIVATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${ACTIVATION_RECEIPT_DELETE_GUARD}"
BEFORE DELETE ON "${ACTIVATION_RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_MIGRATION_ACTIVATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${PRISMA_RECEIPT_UPDATE_GUARD}"
BEFORE UPDATE ON "_prisma_migrations"
WHEN OLD."migration_name" IN (${protectedMigrationNames})
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_PRISMA_MIGRATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${PRISMA_RECEIPT_DELETE_GUARD}"
BEFORE DELETE ON "_prisma_migrations"
WHEN OLD."migration_name" IN (${protectedMigrationNames})
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_PRISMA_MIGRATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${PRISMA_RECEIPT_DUPLICATE_GUARD}"
BEFORE INSERT ON "_prisma_migrations"
WHEN NEW."migration_name" IN (${protectedMigrationNames})
  AND EXISTS (
    SELECT 1 FROM "_prisma_migrations" existing
    WHERE existing."migration_name" = NEW."migration_name"
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_PRISMA_MIGRATION_RECEIPT_DUPLICATE');
END;
`;
}

export type MigrationState = "pending" | "applied" | "partial" | "blocked" | "unverified";

export interface ProductTruthMigrationFile {
  id: string;
  path: string;
  sha256: string;
  sql: string;
  expectedArtifacts: string[];
  removedArtifacts: string[];
  expectedDefinitions: Array<{
    type: "table" | "trigger" | "index";
    name: string;
    normalizedSql: string;
    sha256: string;
  }>;
}

export interface ProductTruthSchemaFingerprint {
  sha256: string;
  objectCount: number;
  tableCount: number;
  triggerCount: number;
  indexCount: number;
  objects: Array<{
    type: string;
    name: string;
    tableName: string;
    sqlSha256: string;
  }>;
}

export interface ProductTruthQueueImpact {
  contractVersion: "product-truth-migration-queue-impact/1";
  queueV2CompatibilityBackfill: {
    count: number;
    rowIds: string[];
    rowsSha256: string;
  };
  queueV3Cancellation: {
    count: number;
    rowIds: string[];
    rowsSha256: string;
  };
  runningQueueJobs: {
    count: number;
    rowIds: string[];
    rowsSha256: string;
  };
  sha256: string;
}

export interface ProductTruthWriterActivity {
  contractVersion: "product-truth-migration-writer-activity/1";
  enrichmentRunning: number;
  harvestRunning: number;
  operationalRunning: number;
  unsettledMeteredReceipts: number;
  unfinishedPrismaMigrations: number;
  blockerSets: {
    enrichmentRunning: { count: number; rowIds: string[]; rowsSha256: string };
    harvestRunning: { count: number; rowIds: string[]; rowsSha256: string };
    operationalRunning: { count: number; rowIds: string[]; rowsSha256: string };
    unsettledMeteredReceipts: { count: number; rowIds: string[]; rowsSha256: string };
    unfinishedPrismaMigrations: { count: number; rowIds: string[]; rowsSha256: string };
  };
  externalWriterQuiescenceRequired: true;
  sha256: string;
}

export interface ProductTruthMigrationPlanItem {
  id: string;
  relativePath: string;
  sha256: string;
  state: MigrationState;
  tracking:
    | "tracked"
    | "untracked"
    | "hash_mismatch"
    | "binding_mismatch"
    | "not_checked";
  presentArtifacts: string[];
  missingArtifacts: string[];
  unsafePresentArtifacts: string[];
  missingPrerequisites: string[];
  blockers: string[];
}

export interface ProductTruthMigrationPlan {
  contractVersion: typeof PLAN_CONTRACT_VERSION;
  mode: "dry-run";
  generatedAt: string;
  runId: string | null;
  approvalId: string | null;
  migrationSetSha256: string;
  activationContractSha256: string;
  database: null | {
    kind: "local" | "remote";
    displayUrl: string;
    targetFingerprint: string;
  };
  migrations: ProductTruthMigrationPlanItem[];
  orderValid: boolean;
  receiptLedger: "absent" | "ready" | "invalid" | "not_checked";
  prismaLedger: "absent" | "ready" | "invalid" | "not_checked";
  schema: ProductTruthSchemaFingerprint | null;
  queueImpact: ProductTruthQueueImpact | null;
  writerActivity: ProductTruthWriterActivity | null;
  canApply: boolean;
  blockers: string[];
}

export interface ProductTruthMigrationApprovalV2 {
  contractVersion: typeof APPROVAL_CONTRACT_VERSION;
  decision: "APPROVE_PRODUCT_TRUTH_MIGRATIONS";
  approvedBy: "owner";
  runId: string;
  approvalId: string;
  planSha256: string;
  migrationSetSha256: string;
  activationContractSha256: string;
  targetFingerprint: string;
  schemaBeforeSha256: string;
  queueImpactSha256: string;
  writerActivitySha256: string;
  writersQuiesced: true;
  backupReference: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ProductTruthMigrationApplyResult {
  contractVersion: typeof APPLY_CONTRACT_VERSION;
  mode: "apply";
  migrationSetSha256: string;
  activationContractSha256: string;
  targetFingerprint: string;
  runId: string;
  approvalId: string;
  planSha256: string;
  approvalSha256: string;
  schemaBeforeSha256: string;
  schemaAfterSha256: string;
  queueImpactSha256: string;
  actions: Array<{
    id: string;
    action: "applied" | "already_applied";
    sha256: string;
  }>;
  finalPlan: ProductTruthMigrationPlan;
  reportSha256: string;
  reportPath: string;
  reportSha256Path: string;
  migrationCertificationSha256: string;
  migrationCertificationPath: string;
  migrationCertificationSha256Path: string;
}

export class ProductTruthMigrationPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthMigrationPlanError";
    this.code = code;
  }
}

interface SchemaExecutor {
  execute(statement: InStatement): Promise<ResultSet>;
}

type DatabaseTarget = ProductTruthDatabaseTarget;

interface SchemaSnapshot {
  tables: Set<string>;
  triggers: Set<string>;
  indexes: Set<string>;
  columns: Map<string, Set<string>>;
  exact: ExactSchemaSnapshot;
  fingerprint: ProductTruthSchemaFingerprint;
}

interface ExactSchemaSnapshot {
  schemaRows: Array<Record<string, unknown>>;
  tableMetadata: Array<{
    table: string;
    xinfo: Array<Record<string, unknown>>;
    foreignKeys: Array<Record<string, unknown>>;
    indexes: Array<Record<string, unknown>>;
  }>;
  indexMetadata: Array<{
    index: string;
    xinfo: Array<Record<string, unknown>>;
  }>;
}

interface ReceiptRow {
  migrationId: string;
  migrationSha256: string;
  migrationSetSha256: string;
  activationContractSha256: string;
  runId: string;
  approvalId: string;
  targetFingerprint: string;
  planSha256: string;
  approvalSha256: string;
  schemaBeforeSha256: string;
  schemaAfterSha256: string;
  queueImpactSha256: string;
  action: string;
  appliedAt: string;
}

interface PrismaMigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: string | null;
  rolled_back_at: string | null;
  applied_steps_count: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readActivationContractSha256(): Promise<string> {
  return sha256(await readFile(SCRIPT_PATH));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

export function canonicalProductTruthMigrationArtifact(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function productTruthMigrationArtifactSha256(value: unknown): string {
  return sha256(canonicalProductTruthMigrationArtifact(value));
}

function normalizeResultRows(rows: ResultSet["rows"]): Array<Record<string, unknown>> {
  return rows.map((row) => stableValue({ ...row }) as Record<string, unknown>)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
}

function assertLowerSha256(label: string, value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_ARTIFACT_HASH_INVALID",
      `${label} must be a lowercase SHA-256`,
    );
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function allMatches(sql: string, pattern: RegExp): string[] {
  const values: string[] = [];
  for (const match of sql.matchAll(pattern)) {
    const value = match[1] ?? match[2];
    if (value) values.push(value);
  }
  return values;
}

function stripSqlComments(sql: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += " ";
        index += 1;
      } else if (character === "\n") {
        output += "\n";
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote && next === quote) {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
    } else if (character === "-" && next === "-") {
      lineComment = true;
      output += " ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += " ";
      index += 1;
    } else {
      output += character;
    }
  }
  if (blockComment) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_SQL_PARSE_FAILED",
      "migration contains an unclosed block comment",
    );
  }
  return output;
}

function splitCreateTableColumns(sql: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const tablePattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/gi;

  for (const match of sql.matchAll(tablePattern)) {
    const table = match[1] ?? match[2];
    if (!table || match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let close = -1;
    for (let index = open; index < sql.length; index += 1) {
      const character = sql[index];
      const next = sql[index + 1];
      if (quote) {
        if (character === quote && next === quote) {
          index += 1;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_SQL_PARSE_FAILED",
        `${table} has an unclosed CREATE TABLE body`,
      );
    }

    const body = sql.slice(open + 1, close);
    const segments: string[] = [];
    let segmentStart = 0;
    depth = 0;
    quote = null;
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index];
      const next = body[index + 1];
      if (quote) {
        if (character === quote && next === quote) {
          index += 1;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        segments.push(body.slice(segmentStart, index));
        segmentStart = index + 1;
      }
    }
    segments.push(body.slice(segmentStart));

    const columns: string[] = [];
    for (const segment of segments) {
      const trimmed = segment
        .trim()
        .replace(/^(?:(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))\s*)+/, "")
        .trim();
      const columnMatch = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      const column = columnMatch?.[1];
      if (!column || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(column)) continue;
      columns.push(column);
    }
    result.set(table, columns);
  }
  return result;
}

function extractExpectedArtifacts(sql: string): string[] {
  const executableSql = stripSqlComments(sql);
  const tables = allMatches(
    executableSql,
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const triggers = allMatches(
    executableSql,
    /CREATE\s+TRIGGER(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const indexes = allMatches(
    executableSql,
    /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const alteredColumns = Array.from(
    executableSql.matchAll(
      /ALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+ADD\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
    ),
    (match) => `column:${match[1] ?? match[2]}.${match[3] ?? match[4]}`,
  );
  const createdColumns = Array.from(splitCreateTableColumns(executableSql), ([table, columns]) =>
    columns.map((column) => `column:${table}.${column}`),
  ).flat();

  return Array.from(new Set([
    ...tables.map((name) => `table:${name}`),
    ...triggers.map((name) => `trigger:${name}`),
    ...indexes.map((name) => `index:${name}`),
    ...alteredColumns,
    ...createdColumns,
  ])).sort();
}

function extractRemovedIndexes(sql: string): string[] {
  const executableSql = stripSqlComments(sql);
  return Array.from(new Set(allMatches(
    executableSql,
    /DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  ).map((name) => `index:${name}`))).sort();
}

function normalizeSqlDefinition(sql: string): string {
  const input = stripSqlComments(sql).trim().replace(/;\s*$/, "");
  let output = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  let pendingWhitespace = false;
  const punctuation = new Set(["(", ")", ",", "="]);
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote && next === quote) {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) output += " ";
      pendingWhitespace = false;
      quote = character;
      output += character;
    } else if (character === "[") {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) output += " ";
      pendingWhitespace = false;
      quote = "]";
      output += character;
    } else if (/\s/.test(character)) {
      pendingWhitespace = true;
    } else if (punctuation.has(character)) {
      output = output.trimEnd();
      output += character;
      pendingWhitespace = false;
    } else {
      if (pendingWhitespace && output && !punctuation.has(output.at(-1)!)) output += " ";
      pendingWhitespace = false;
      output += character;
    }
  }
  return output.trim();
}

function splitSqlStatements(sql: string): string[] {
  const input = stripSqlComments(sql);
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  let token = "";
  let leadingTokens: string[] = [];
  let trigger = false;
  let triggerCaseDepth = 0;
  let triggerEnded = false;
  const flushToken = () => {
    if (!token) return;
    const keyword = token.toUpperCase();
    leadingTokens.push(keyword);
    if (
      leadingTokens[0] === "CREATE"
      && leadingTokens.slice(1, 4).includes("TRIGGER")
    ) trigger = true;
    if (trigger && keyword === "CASE") triggerCaseDepth += 1;
    else if (trigger && keyword === "END") {
      if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
      else triggerEnded = true;
    }
    token = "";
  };
  const reset = (nextStart: number) => {
    start = nextStart;
    leadingTokens = [];
    trigger = false;
    triggerCaseDepth = 0;
    triggerEnded = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (quote) {
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      flushToken();
      quote = character;
    } else if (character === "[") {
      flushToken();
      quote = "]";
    } else if (/[A-Za-z_]/.test(character)) {
      token += character;
    } else {
      flushToken();
      if (character === ";" && (!trigger || triggerEnded)) {
        const statement = input.slice(start, index + 1).trim();
        if (statement) statements.push(statement);
        reset(index + 1);
      }
    }
  }
  flushToken();
  const tail = input.slice(start).trim();
  if (tail) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_SQL_PARSE_FAILED",
      `unterminated SQL statement: ${tail.slice(0, 120)}`,
    );
  }
  return statements;
}

function extractCreateDefinitions(sql: string): ProductTruthMigrationFile["expectedDefinitions"] {
  return splitSqlStatements(sql)
    .filter((statement) =>
      /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b/i.test(statement),
    )
    .map((statement) => {
    const match = statement.match(
      /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i,
    );
    if (!match) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_SQL_PARSE_FAILED",
        `cannot identify CREATE statement ${statement.slice(0, 120)}`,
      );
    }
    const type = match[1]!.toLowerCase() as "table" | "index" | "trigger";
    const name = match[2] ?? match[3]!;
    const normalizedSql = normalizeSqlDefinition(statement);
    return { type, name, normalizedSql, sha256: sha256(normalizedSql) };
    }).sort((left, right) => `${left.type}:${left.name}`.localeCompare(
      `${right.type}:${right.name}`,
      "en-US",
    ));
}

function assertMigrationSqlIsNonDestructive(
  contract: MigrationContract,
  sql: string,
  removedArtifacts: readonly string[],
): void {
  const executableSql = stripSqlComments(sql);
  for (const statement of splitSqlStatements(executableSql)) {
    if (!/^(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b|ALTER\s+TABLE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?=\s)\s+ADD\s+COLUMN\b|UPDATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?=\s)|DROP\s+INDEX\b)/i.test(statement)) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_STATEMENT_FORBIDDEN",
        `${contract.id} contains a statement outside the sealed activation allowlist: ${
          statement.trim().split(/\s+/).slice(0, 3).join(" ")
        }`,
      );
    }
  }
  const forbidden = executableSql.match(
    /\b(?:DROP\s+(?:TABLE|TRIGGER|VIEW)|DELETE\s+FROM|TRUNCATE\s+TABLE|VACUUM\b|ATTACH\s+DATABASE|DETACH\s+DATABASE|PRAGMA\s+writable_schema)\b/i,
  );
  if (forbidden) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_DESTRUCTIVE_SQL_FORBIDDEN",
      `${contract.id} contains forbidden statement ${forbidden[0]}`,
    );
  }

  const allowedRemovedArtifacts = new Set(
    (contract.allowedRemovedIndexes ?? []).map((name) => `index:${name}`),
  );
  const dropIndexStatementCount = executableSql.match(/\bDROP\s+INDEX\b/gi)?.length ?? 0;
  const unexpected = removedArtifacts.filter((artifact) => !allowedRemovedArtifacts.has(artifact));
  const undeclared = [...allowedRemovedArtifacts].filter(
    (artifact) => !removedArtifacts.includes(artifact),
  );
  if (
    unexpected.length > 0
    || undeclared.length > 0
    || dropIndexStatementCount !== removedArtifacts.length
  ) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_INDEX_REMOVAL_CONTRACT_INVALID",
      [
        unexpected.length > 0 ? `unexpected removals: ${unexpected.join(", ")}` : null,
        undeclared.length > 0 ? `declared removals missing from SQL: ${undeclared.join(", ")}` : null,
        dropIndexStatementCount !== removedArtifacts.length
          ? "one or more DROP INDEX statements could not be parsed uniquely"
          : null,
      ].filter(Boolean).join("; "),
    );
  }
}

function contractArtifacts(contract: MigrationContract): string[] {
  return [
    ...contract.requiredTables.map((name) => `table:${name}`),
    ...contract.requiredTriggers.map((name) => `trigger:${name}`),
    ...contract.requiredIndexes.map((name) => `index:${name}`),
    ...Object.entries(contract.requiredColumns).flatMap(([table, columns]) =>
      columns.map((column) => `column:${table}.${column}`),
    ),
  ];
}

function validateMigrationContract(
  contract: MigrationContract,
  expectedArtifacts: readonly string[],
): void {
  const expected = new Set(expectedArtifacts);
  const missing = contractArtifacts(contract).filter((artifact) => !expected.has(artifact));
  if (missing.length > 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_FILE_CONTRACT_MISSING",
      `${contract.id} does not declare required artifacts: ${missing.join(", ")}`,
    );
  }
}

export async function loadProductTruthMigrationFiles(
  migrationsRoot = DEFAULT_MIGRATIONS_ROOT,
): Promise<ProductTruthMigrationFile[]> {
  const root = resolve(migrationsRoot);
  const files: ProductTruthMigrationFile[] = [];
  for (const contract of MIGRATION_CONTRACTS) {
    const path = resolve(root, contract.id, "migration.sql");
    if (!path.startsWith(`${root}/`)) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_PATH_ESCAPE",
        `${contract.id} resolves outside the migrations root`,
      );
    }
    let sql: string;
    try {
      sql = await readFile(path, "utf8");
    } catch (error) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_FILE_UNREADABLE",
        `${contract.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sql.trim()) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_FILE_EMPTY",
        `${contract.id}/migration.sql is empty`,
      );
    }
    const removedArtifacts = extractRemovedIndexes(sql);
    assertMigrationSqlIsNonDestructive(contract, sql, removedArtifacts);
    const expectedArtifacts = extractExpectedArtifacts(sql);
    const expectedDefinitions = extractCreateDefinitions(sql);
    validateMigrationContract(contract, expectedArtifacts);
    files.push({
      id: contract.id,
      path,
      sha256: sha256(sql),
      sql,
      expectedArtifacts,
      removedArtifacts,
      expectedDefinitions,
    });
  }

  const actualOrder = files.map((file) => file.id);
  const sortedOrder = [...actualOrder].sort((left, right) => left.localeCompare(right));
  if (actualOrder.some((id, index) => id !== sortedOrder[index])) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_ORDER_INVALID",
      `configured order is not chronological: ${actualOrder.join(" -> ")}`,
    );
  }
  return files;
}

export function migrationSetSha256(files: readonly ProductTruthMigrationFile[]): string {
  return sha256(files.map((file) => `${file.id}\0${file.sha256}`).join("\n"));
}

export function resolveDatabaseTarget(databaseUrl: string, cwd = process.cwd()): DatabaseTarget {
  try {
    return resolveProductTruthDatabaseTarget(databaseUrl, cwd);
  } catch (error) {
    if (error instanceof ProductTruthDatabaseTargetError) {
      const prefix = `${error.code}: `;
      const detail = error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message;
      throw new ProductTruthMigrationPlanError(error.code, detail);
    }
    throw error;
  }
}

async function assertLocalDatabaseExists(target: DatabaseTarget): Promise<void> {
  if (target.kind !== "local" || target.localPath === null) return;
  try {
    const database = await stat(target.localPath);
    if (!database.isFile()) throw new Error("target is not a regular file");
  } catch (error) {
    throw new ProductTruthMigrationPlanError(
      "LOCAL_DATABASE_MUST_EXIST",
      `refusing to create or replace a database during activation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertDatabaseTargetAllowed(
  target: DatabaseTarget,
  options: { allowRemote?: boolean; authToken?: string },
): void {
  if (target.kind === "remote" && options.allowRemote !== true) {
    throw new ProductTruthMigrationPlanError(
      "REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG",
      "remote inspection/apply requires --allow-remote",
    );
  }
  if (target.kind === "remote" && !options.authToken?.trim()) {
    throw new ProductTruthMigrationPlanError(
      "REMOTE_DATABASE_AUTH_TOKEN_REQUIRED",
      "remote inspection/apply requires an explicitly supplied auth token",
    );
  }
}

function assertOwnerIdentifier(label: "runId" | "approvalId", value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ProductTruthMigrationPlanError(
      "OWNER_GATE_IDENTIFIER_INVALID",
      `${label} must be 1-128 characters using only letters, digits, dot, underscore or hyphen`,
    );
  }
}

export function buildProductTruthMigrationConfirmationToken(input: {
  runId: string;
  approvalId: string;
  activationContractSha256: string;
  planSha256: string;
  approvalSha256: string;
  targetFingerprint: string;
}): string {
  assertOwnerIdentifier("runId", input.runId);
  assertOwnerIdentifier("approvalId", input.approvalId);
  assertLowerSha256("activationContractSha256", input.activationContractSha256);
  assertLowerSha256("planSha256", input.planSha256);
  assertLowerSha256("approvalSha256", input.approvalSha256);
  assertLowerSha256("targetFingerprint", input.targetFingerprint);
  return [
    CONFIRMATION_PREFIX,
    input.runId,
    input.approvalId,
    input.targetFingerprint,
    input.activationContractSha256,
    input.planSha256,
    input.approvalSha256,
  ].join(":");
}

async function readSchema(executor: SchemaExecutor): Promise<SchemaSnapshot> {
  const master = await executor.execute(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE type IN ('table','trigger','index','view')
     ORDER BY type, name`,
  );
  const tables = new Set<string>();
  const triggers = new Set<string>();
  const indexes = new Set<string>();
  const schemaRows = normalizeResultRows(master.rows);
  for (const row of schemaRows) {
    const type = String(row.type ?? "");
    const name = String(row.name ?? "");
    if (type === "table") tables.add(name);
    else if (type === "trigger") triggers.add(name);
    else if (type === "index") indexes.add(name);
  }

  const columns = new Map<string, Set<string>>();
  const tableMetadata: ExactSchemaSnapshot["tableMetadata"] = [];
  for (const table of [...tables].sort((left, right) => left.localeCompare(right, "en-US"))) {
    const xinfo = await executor.execute(`PRAGMA table_xinfo(${quoteIdentifier(table)})`);
    const foreignKeys = await executor.execute(
      `PRAGMA foreign_key_list(${quoteIdentifier(table)})`,
    );
    const tableIndexes = await executor.execute(`PRAGMA index_list(${quoteIdentifier(table)})`);
    columns.set(table, new Set(xinfo.rows.map((row) => String(row.name))));
    tableMetadata.push({
      table,
      xinfo: normalizeResultRows(xinfo.rows),
      foreignKeys: normalizeResultRows(foreignKeys.rows),
      indexes: normalizeResultRows(tableIndexes.rows),
    });
  }
  const indexMetadata: ExactSchemaSnapshot["indexMetadata"] = [];
  for (const index of [...indexes].sort((left, right) => left.localeCompare(right, "en-US"))) {
    const xinfo = await executor.execute(`PRAGMA index_xinfo(${quoteIdentifier(index)})`);
    indexMetadata.push({ index, xinfo: normalizeResultRows(xinfo.rows) });
  }
  const exact: ExactSchemaSnapshot = { schemaRows, tableMetadata, indexMetadata };
  const exactSha256 = sha256(JSON.stringify(stableValue(exact)));
  const objects = schemaRows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    tableName: String(row.tbl_name ?? ""),
    sqlSha256: sha256(row.sql == null ? "<null>" : normalizeSqlDefinition(String(row.sql))),
  }));
  return {
    tables,
    triggers,
    indexes,
    columns,
    exact,
    fingerprint: {
      sha256: exactSha256,
      objectCount: schemaRows.length,
      tableCount: tables.size,
      triggerCount: triggers.size,
      indexCount: indexes.size,
      objects,
    },
  };
}

function artifactPresent(snapshot: SchemaSnapshot, artifact: string): boolean {
  const separator = artifact.indexOf(":");
  const type = artifact.slice(0, separator);
  const name = artifact.slice(separator + 1);
  if (type === "table") return snapshot.tables.has(name);
  if (type === "trigger") return snapshot.triggers.has(name);
  if (type === "index") return snapshot.indexes.has(name);
  if (type === "column") {
    const dot = name.indexOf(".");
    const table = name.slice(0, dot);
    const column = name.slice(dot + 1);
    return snapshot.columns.get(table)?.has(column) === true;
  }
  return false;
}

function prerequisiteArtifacts(contract: MigrationContract): string[] {
  return Object.entries(contract.prerequisites).flatMap(([table, columns]) => [
    `table:${table}`,
    ...columns.map((column) => `column:${table}.${column}`),
  ]);
}

function schemaDefinitionProblems(
  snapshot: SchemaSnapshot,
  definitions: readonly ProductTruthMigrationFile["expectedDefinitions"][number][],
): string[] {
  const byKey = new Map(
    snapshot.exact.schemaRows.map((row) => [
      `${String(row.type)}:${String(row.name)}`,
      row.sql == null ? null : normalizeSqlDefinition(String(row.sql)),
    ]),
  );
  const problems: string[] = [];
  for (const definition of definitions) {
    const current = byKey.get(`${definition.type}:${definition.name}`);
    if (current == null) {
      problems.push(`missing SQL definition ${definition.type}:${definition.name}`);
    } else if (sha256(current) !== definition.sha256) {
      problems.push(`SQL definition drift ${definition.type}:${definition.name}`);
    }
  }
  return problems;
}

function receiptLedgerState(snapshot: SchemaSnapshot): {
  state: ProductTruthMigrationPlan["receiptLedger"];
  blockers: string[];
} {
  if (!snapshot.tables.has(RECEIPT_TABLE)) return { state: "absent", blockers: [] };
  const missing = [
    ...RECEIPT_COLUMNS.map((column) => `column:${RECEIPT_TABLE}.${column}`),
    `trigger:${RECEIPT_UPDATE_GUARD}`,
    `trigger:${RECEIPT_DELETE_GUARD}`,
    `table:${ACTIVATION_RECEIPT_TABLE}`,
    `trigger:${ACTIVATION_RECEIPT_UPDATE_GUARD}`,
    `trigger:${ACTIVATION_RECEIPT_DELETE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_UPDATE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_DELETE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_DUPLICATE_GUARD}`,
  ].filter((artifact) => !artifactPresent(snapshot, artifact));
  const definitionProblems = schemaDefinitionProblems(
    snapshot,
    extractCreateDefinitions(receiptSchemaSql()),
  );
  return missing.length === 0 && definitionProblems.length === 0
    ? { state: "ready", blockers: [] }
    : {
        state: "invalid",
        blockers: [
          `migration receipt ledger is incomplete: ${[
            ...missing,
            ...definitionProblems,
          ].join(", ")}`,
        ],
      };
}

const PRISMA_MIGRATION_COLUMNS = [
  "id",
  "checksum",
  "finished_at",
  "migration_name",
  "logs",
  "rolled_back_at",
  "started_at",
  "applied_steps_count",
] as const;

function prismaLedgerState(snapshot: SchemaSnapshot): {
  state: ProductTruthMigrationPlan["prismaLedger"];
  blockers: string[];
} {
  if (!snapshot.tables.has("_prisma_migrations")) {
    return {
      state: "absent",
      blockers: ["_prisma_migrations is absent; dual-ledger registration cannot be proven"],
    };
  }
  const missing = PRISMA_MIGRATION_COLUMNS
    .map((column) => `column:_prisma_migrations.${column}`)
    .filter((artifact) => !artifactPresent(snapshot, artifact));
  return missing.length === 0
    ? { state: "ready", blockers: [] }
    : {
        state: "invalid",
        blockers: [`_prisma_migrations is incomplete: ${missing.join(", ")}`],
      };
}

async function readReceipts(
  executor: SchemaExecutor,
  ledgerState: ProductTruthMigrationPlan["receiptLedger"],
): Promise<{ rows: Map<string, ReceiptRow>; blockers: string[] }> {
  if (ledgerState !== "ready") return { rows: new Map(), blockers: [] };
  const result = await executor.execute(
    `SELECT ${RECEIPT_COLUMNS.map(quoteIdentifier).join(",")}
     FROM ${quoteIdentifier(RECEIPT_TABLE)} ORDER BY migrationId`,
  );
  const rows = new Map<string, ReceiptRow>();
  const blockers: string[] = [];
  for (const row of result.rows) {
    const receipt: ReceiptRow = {
      migrationId: String(row.migrationId),
      migrationSha256: String(row.migrationSha256),
      migrationSetSha256: String(row.migrationSetSha256),
      activationContractSha256: String(row.activationContractSha256),
      runId: String(row.runId),
      approvalId: String(row.approvalId),
      targetFingerprint: String(row.targetFingerprint),
      planSha256: String(row.planSha256),
      approvalSha256: String(row.approvalSha256),
      schemaBeforeSha256: String(row.schemaBeforeSha256),
      schemaAfterSha256: String(row.schemaAfterSha256),
      queueImpactSha256: String(row.queueImpactSha256),
      action: String(row.action),
      appliedAt: String(row.appliedAt),
    };
    if (rows.has(receipt.migrationId)) {
      blockers.push(`duplicate migration receipt ${receipt.migrationId}`);
    } else {
      rows.set(receipt.migrationId, receipt);
    }
  }
  const receipts = [...rows.values()];
  if (receipts.length > 1) {
    const first = receipts[0]!;
    for (const field of [
      "migrationSetSha256",
      "activationContractSha256",
      "runId",
      "approvalId",
      "targetFingerprint",
      "planSha256",
      "approvalSha256",
      "schemaBeforeSha256",
      "schemaAfterSha256",
      "queueImpactSha256",
      "action",
      "appliedAt",
    ] as const) {
      if (receipts.some((receipt) => receipt[field] !== first[field])) {
        blockers.push(`migration receipts do not share one atomic ${field} binding`);
      }
    }
  }
  return { rows, blockers };
}

async function readPrismaMigrationRows(
  executor: SchemaExecutor,
  ledgerState: ProductTruthMigrationPlan["prismaLedger"],
): Promise<{ rows: Map<string, PrismaMigrationRow>; blockers: string[] }> {
  if (ledgerState !== "ready") return { rows: new Map(), blockers: [] };
  const result = await executor.execute({
    sql: `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
          FROM "_prisma_migrations"
          WHERE migration_name IN (${PRODUCT_TRUTH_MIGRATION_IDS.map(() => "?").join(",")})
          ORDER BY migration_name`,
    args: PRODUCT_TRUTH_MIGRATION_IDS,
  });
  const rows = new Map<string, PrismaMigrationRow>();
  const blockers: string[] = [];
  for (const row of result.rows) {
    const migration: PrismaMigrationRow = {
      migration_name: String(row.migration_name),
      checksum: String(row.checksum),
      finished_at: row.finished_at == null ? null : String(row.finished_at),
      rolled_back_at: row.rolled_back_at == null ? null : String(row.rolled_back_at),
      applied_steps_count: Number(row.applied_steps_count),
    };
    if (rows.has(migration.migration_name)) {
      blockers.push(`duplicate Prisma migration receipt ${migration.migration_name}`);
    } else {
      rows.set(migration.migration_name, migration);
    }
  }
  return { rows, blockers };
}

function rowsImpact(rows: ResultSet["rows"]): {
  count: number;
  rowIds: string[];
  rowsSha256: string;
} {
  const normalized = normalizeResultRows(rows);
  return {
    count: normalized.length,
    rowIds: normalized.map((row) => String(row.id ?? "")).sort((a, b) => a.localeCompare(b, "en-US")),
    rowsSha256: sha256(JSON.stringify(stableValue(normalized))),
  };
}

async function inspectQueueImpact(
  executor: SchemaExecutor,
  snapshot: SchemaSnapshot,
): Promise<ProductTruthQueueImpact> {
  const columns = snapshot.columns.get("EnrichmentJob") ?? new Set<string>();
  if (!snapshot.tables.has("EnrichmentJob")) {
    const empty = rowsImpact([]);
    const body = {
      contractVersion: "product-truth-migration-queue-impact/1" as const,
      queueV2CompatibilityBackfill: empty,
      queueV3Cancellation: empty,
      runningQueueJobs: empty,
    };
    return { ...body, sha256: sha256(JSON.stringify(stableValue(body))) };
  }
  const identityColumns = ["id", "targetType", "target", "status", "queuedAt", "createdAt"]
    .filter((column) => columns.has(column))
    .map(quoteIdentifier)
    .join(",");
  const v2Predicate = columns.has("idempotencyKey") ? `WHERE "idempotencyKey" IS NULL` : "";
  const v2 = await executor.execute(
    `SELECT ${identityColumns} FROM "EnrichmentJob" ${v2Predicate} ORDER BY "id"`,
  );
  const listingPredicate = columns.has("listingKey")
    ? `("targetType" NOT IN ('brand','product','sku','query')
        OR ("targetType"='sku' AND "listingKey" IS NULL))`
    : `("targetType" NOT IN ('brand','product','sku','query') OR "targetType"='sku')`;
  const v3 = await executor.execute(
    `SELECT ${identityColumns} FROM "EnrichmentJob"
     WHERE "status" IN ('queued','retry_wait') AND ${listingPredicate}
     ORDER BY "id"`,
  );
  const running = await executor.execute(
    `SELECT ${identityColumns} FROM "EnrichmentJob"
     WHERE "status"='running' ORDER BY "id"`,
  );
  const body = {
    contractVersion: "product-truth-migration-queue-impact/1" as const,
    queueV2CompatibilityBackfill: rowsImpact(v2.rows),
    queueV3Cancellation: rowsImpact(v3.rows),
    runningQueueJobs: rowsImpact(running.rows),
  };
  return { ...body, sha256: sha256(JSON.stringify(stableValue(body))) };
}

async function inspectWriterRows(
  executor: SchemaExecutor,
  snapshot: SchemaSnapshot,
  table: string,
  identifier: string,
  predicate: string,
): Promise<ReturnType<typeof rowsImpact>> {
  if (!snapshot.tables.has(table)) return rowsImpact([]);
  const result = await executor.execute(
    `SELECT ${quoteIdentifier(identifier)} AS id, *
     FROM ${quoteIdentifier(table)} WHERE ${predicate} ORDER BY ${quoteIdentifier(identifier)}`,
  );
  return rowsImpact(result.rows);
}

async function inspectWriterActivity(
  executor: SchemaExecutor,
  snapshot: SchemaSnapshot,
): Promise<ProductTruthWriterActivity> {
  const blockerSets = {
    enrichmentRunning: await inspectWriterRows(
      executor,
      snapshot,
      "EnrichmentJob",
      "id",
      `"status"='running'`,
    ),
    harvestRunning: await inspectWriterRows(
      executor,
      snapshot,
      "DonorHarvestState",
      "id",
      `"status"='running'`,
    ),
    operationalRunning: await inspectWriterRows(
      executor,
      snapshot,
      "ProductTruthOperationalRun",
      "runId",
      `"status"='running'`,
    ),
    unsettledMeteredReceipts: await inspectWriterRows(
      executor,
      snapshot,
      "MeteredReservationReceipt",
      "id",
      `"status" IN ('pending','reserved')`,
    ),
    unfinishedPrismaMigrations: await inspectWriterRows(
      executor,
      snapshot,
      "_prisma_migrations",
      "id",
      `"finished_at" IS NULL AND "rolled_back_at" IS NULL`,
    ),
  };
  const body = {
    contractVersion: "product-truth-migration-writer-activity/1" as const,
    enrichmentRunning: blockerSets.enrichmentRunning.count,
    harvestRunning: blockerSets.harvestRunning.count,
    operationalRunning: blockerSets.operationalRunning.count,
    unsettledMeteredReceipts: blockerSets.unsettledMeteredReceipts.count,
    unfinishedPrismaMigrations: blockerSets.unfinishedPrismaMigrations.count,
    blockerSets,
    externalWriterQuiescenceRequired: true as const,
  };
  return { ...body, sha256: sha256(JSON.stringify(stableValue(body))) };
}

function migrationDefinitionProblems(
  snapshot: SchemaSnapshot,
  file: ProductTruthMigrationFile,
): string[] {
  return schemaDefinitionProblems(snapshot, file.expectedDefinitions);
}

async function inspectDatabasePlan(input: {
  executor: SchemaExecutor;
  files: readonly ProductTruthMigrationFile[];
  target: DatabaseTarget;
  activationContractSha256: string;
  runId?: string;
  approvalId?: string;
  now?: Date;
}): Promise<ProductTruthMigrationPlan> {
  const snapshot = await readSchema(input.executor);
  const ledger = receiptLedgerState(snapshot);
  const prismaLedger = prismaLedgerState(snapshot);
  const receiptRead = await readReceipts(input.executor, ledger.state);
  const receipts = receiptRead.rows;
  const prismaRead = await readPrismaMigrationRows(input.executor, prismaLedger.state);
  const prismaRows = prismaRead.rows;
  const setHash = migrationSetSha256(input.files);
  const queueImpact = await inspectQueueImpact(input.executor, snapshot);
  const writerActivity = await inspectWriterActivity(input.executor, snapshot);
  const projectedArtifacts = new Set<string>([
    ...[...snapshot.tables].map((name) => `table:${name}`),
    ...[...snapshot.triggers].map((name) => `trigger:${name}`),
    ...[...snapshot.indexes].map((name) => `index:${name}`),
    ...[...snapshot.columns].flatMap(([table, columns]) =>
      [...columns].map((column) => `column:${table}.${column}`),
    ),
  ]);
  const migrations = input.files.map((file, index): ProductTruthMigrationPlanItem => {
    const contract = MIGRATION_CONTRACTS[index];
    if (!contract || contract.id !== file.id) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_CONTRACT_ORDER_DRIFT",
        `no matching contract for ${file.id}`,
      );
    }
    const presentArtifacts = file.expectedArtifacts.filter((artifact) =>
      artifactPresent(snapshot, artifact),
    );
    const missingArtifacts = file.expectedArtifacts.filter((artifact) =>
      !artifactPresent(snapshot, artifact),
    );
    const unsafePresentArtifacts = file.removedArtifacts.filter((artifact) =>
      artifactPresent(snapshot, artifact),
    );
    // Prerequisites are evaluated against the ordered projected schema. A later
    // canonical migration may depend on an artifact created by an earlier pending
    // migration; inspecting only the current schema would incorrectly make every
    // fresh installation fail closed as "blocked".
    const missingPrerequisites = prerequisiteArtifacts(contract).filter(
      (artifact) => !projectedArtifacts.has(artifact),
    );
    let state: MigrationState;
    if (missingArtifacts.length === 0 && unsafePresentArtifacts.length === 0) state = "applied";
    else if (presentArtifacts.length > 0) state = "partial";
    else if (missingPrerequisites.length > 0) state = "blocked";
    else state = "pending";

    const receipt = receipts.get(file.id);
    const prismaReceipt = prismaRows.get(file.id);
    let tracking: ProductTruthMigrationPlanItem["tracking"];
    const blockers: string[] = [];
    if (!receipt && !prismaReceipt) {
      tracking = state === "applied" ? "untracked" : "not_checked";
      if (state === "applied") blockers.push("schema is applied without both immutable ledgers; auto-adopt is forbidden");
    } else if (!receipt || !prismaReceipt) {
      tracking = "binding_mismatch";
      blockers.push("ProductTruth and Prisma migration ledgers are not both present");
    } else if (receipt.migrationSha256 !== file.sha256 || prismaReceipt.checksum !== file.sha256) {
      tracking = "hash_mismatch";
      blockers.push(
        `ledger SHA mismatch: ProductTruth=${receipt.migrationSha256}, Prisma=${prismaReceipt.checksum}, local=${file.sha256}`,
      );
    } else {
      const receiptBindingProblems = [
        receipt.migrationSetSha256 !== setHash
          ? `receipt migration-set SHA ${receipt.migrationSetSha256} differs from ${setHash}`
          : null,
        receipt.activationContractSha256 !== input.activationContractSha256
          ? `receipt activation-contract SHA ${receipt.activationContractSha256} differs from ${input.activationContractSha256}`
          : null,
        receipt.targetFingerprint !== input.target.fingerprint
          ? `receipt target fingerprint ${receipt.targetFingerprint} differs from exact target ${input.target.fingerprint}`
          : null,
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt.runId)
          ? "receipt runId is invalid"
          : null,
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt.approvalId)
          ? "receipt approvalId is invalid"
          : null,
        receipt.action !== "applied"
          ? `receipt action ${receipt.action} is invalid`
          : null,
        ...([
          receipt.planSha256,
          receipt.approvalSha256,
          receipt.schemaBeforeSha256,
          receipt.schemaAfterSha256,
          receipt.queueImpactSha256,
        ].some((value) => !/^[a-f0-9]{64}$/.test(value))
          ? ["receipt contains an invalid SHA-256 binding"]
          : []),
        !Number.isFinite(Date.parse(receipt.appliedAt))
          || new Date(Date.parse(receipt.appliedAt)).toISOString() !== receipt.appliedAt
          ? `receipt appliedAt ${receipt.appliedAt} is invalid`
          : null,
        prismaReceipt.finished_at == null
          ? "Prisma migration receipt is unfinished"
          : null,
        prismaReceipt.rolled_back_at != null
          ? "Prisma migration receipt is marked rolled back"
          : null,
        prismaReceipt.applied_steps_count < 1
          ? "Prisma migration receipt has no applied step"
          : null,
      ].filter((problem): problem is string => problem !== null);
      if (receiptBindingProblems.length > 0) {
        tracking = "binding_mismatch";
        blockers.push(...receiptBindingProblems);
      } else {
        tracking = "tracked";
      }
      if (state !== "applied") blockers.push(`receipt exists but schema state is ${state}`);
    }
    if (state === "applied") blockers.push(...migrationDefinitionProblems(snapshot, file));
    if (state === "partial") blockers.push("migration artifacts are only partially present");
    if (unsafePresentArtifacts.length > 0 && presentArtifacts.length > 0) {
      blockers.push(
        `migration must remove legacy artifacts: ${unsafePresentArtifacts.join(", ")}`,
      );
    }
    if (state === "blocked") {
      blockers.push(`missing prerequisites: ${missingPrerequisites.join(", ")}`);
    }

    if (state === "pending" || state === "applied") {
      for (const artifact of file.expectedArtifacts) projectedArtifacts.add(artifact);
      for (const artifact of file.removedArtifacts) projectedArtifacts.delete(artifact);
    }

    return {
      id: file.id,
      relativePath: `prisma/migrations/${file.id}/migration.sql`,
      sha256: file.sha256,
      state,
      tracking,
      presentArtifacts,
      missingArtifacts,
      unsafePresentArtifacts,
      missingPrerequisites,
      blockers,
    };
  });

  const blockers = [
    ...ledger.blockers,
    ...prismaLedger.blockers,
    ...receiptRead.blockers,
    ...prismaRead.blockers,
  ];
  const configuredIds = new Set(input.files.map((file) => file.id));
  if (
    receipts.size === input.files.length
    && input.files.every((file) => receipts.has(file.id))
  ) {
    const receiptSchemaAfterSha256 = receipts.values().next().value?.schemaAfterSha256;
    if (receiptSchemaAfterSha256 !== snapshot.fingerprint.sha256) {
      blockers.push(
        `MIGRATION_RECEIPT_SCHEMA_AFTER_DRIFT: receipt=${
          receiptSchemaAfterSha256 ?? "missing"
        }; current=${snapshot.fingerprint.sha256}`,
      );
    }
  }
  for (const receiptId of receipts.keys()) {
    if (!configuredIds.has(receiptId)) {
      blockers.push(`unknown migration receipt is present: ${receiptId}`);
    }
  }
  if (queueImpact.runningQueueJobs.count > 0) {
    blockers.push(
      `MIGRATION_REQUIRES_QUEUE_QUIESCENCE: ${queueImpact.runningQueueJobs.count}; ids=${
        queueImpact.runningQueueJobs.rowIds.join(",")
      }; rowsSha256=${queueImpact.runningQueueJobs.rowsSha256}`,
    );
  }
  for (const [label, detail] of [
    ["harvest", writerActivity.blockerSets.harvestRunning],
    ["operational", writerActivity.blockerSets.operationalRunning],
    ["metered", writerActivity.blockerSets.unsettledMeteredReceipts],
    ["prisma", writerActivity.blockerSets.unfinishedPrismaMigrations],
  ] as const) {
    if (detail.count > 0) {
      blockers.push(
        `MIGRATION_REQUIRES_${label.toUpperCase()}_QUIESCENCE: ${detail.count}; ids=${
          detail.rowIds.join(",")
        }; rowsSha256=${detail.rowsSha256}`,
      );
    }
  }
  let sawNotApplied = false;
  let orderValid = true;
  for (const migration of migrations) {
    if (migration.state !== "applied") sawNotApplied = true;
    else if (sawNotApplied) {
      orderValid = false;
      blockers.push(`${migration.id} is applied after an earlier non-applied migration`);
    }
    blockers.push(...migration.blockers.map((blocker) => `${migration.id}: ${blocker}`));
  }
  const appliedCount = migrations.filter((migration) => migration.state === "applied").length;
  if (appliedCount > 0 && appliedCount !== migrations.length) {
    blockers.push(
      `MIGRATION_ATOMIC_RELEASE_INCOMPLETE: only ${appliedCount}/${migrations.length} migrations are applied`,
    );
  }
  const plan: ProductTruthMigrationPlan = {
    contractVersion: PLAN_CONTRACT_VERSION,
    mode: "dry-run",
    generatedAt: (input.now ?? new Date()).toISOString(),
    runId: input.runId ?? null,
    approvalId: input.approvalId ?? null,
    migrationSetSha256: setHash,
    activationContractSha256: input.activationContractSha256,
    database: {
      kind: input.target.kind,
      displayUrl: input.target.displayUrl,
      targetFingerprint: input.target.fingerprint,
    },
    migrations,
    orderValid,
    receiptLedger: ledger.state,
    prismaLedger: prismaLedger.state,
    schema: snapshot.fingerprint,
    queueImpact,
    writerActivity,
    canApply: blockers.length === 0,
    blockers,
  };
  if (!input.runId || !input.approvalId) {
    plan.blockers.push("both owner runId and approvalId are required to seal an activation plan");
    plan.canApply = false;
  }
  return plan;
}

export async function planProductTruthMigrations(options: {
  databaseUrl?: string;
  authToken?: string;
  allowRemote?: boolean;
  runId?: string;
  approvalId?: string;
  migrationsRoot?: string;
  cwd?: string;
  now?: () => Date;
} = {}): Promise<ProductTruthMigrationPlan> {
  const files = await loadProductTruthMigrationFiles(options.migrationsRoot);
  const setHash = migrationSetSha256(files);
  const activationContractSha256 = await readActivationContractSha256();
  if (!options.databaseUrl) {
    return {
      contractVersion: PLAN_CONTRACT_VERSION,
      mode: "dry-run",
      // With no target this artifact is only the deterministic release/file plan.
      // A wall-clock timestamp would make identical migration bytes hash differently
      // on every invocation without adding any inspection evidence.
      generatedAt: (options.now?.() ?? new Date(0)).toISOString(),
      runId: options.runId ?? null,
      approvalId: options.approvalId ?? null,
      migrationSetSha256: setHash,
      activationContractSha256,
      database: null,
      migrations: files.map((file) => ({
        id: file.id,
        relativePath: `prisma/migrations/${file.id}/migration.sql`,
        sha256: file.sha256,
        state: "unverified",
        tracking: "not_checked",
        presentArtifacts: [],
        missingArtifacts: file.expectedArtifacts,
        unsafePresentArtifacts: [],
        missingPrerequisites: [],
        blockers: ["database schema was not inspected because no explicit --url was supplied"],
      })),
      orderValid: true,
      receiptLedger: "not_checked",
      prismaLedger: "not_checked",
      schema: null,
      queueImpact: null,
      writerActivity: null,
      canApply: false,
      blockers: ["an explicit database URL is required before apply"],
    };
  }

  const target = resolveDatabaseTarget(options.databaseUrl, options.cwd);
  assertDatabaseTargetAllowed(target, options);
  await assertLocalDatabaseExists(target);
  const client = createClient({
    url: target.clientUrl,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  try {
    const transaction = await client.transaction("read");
    try {
      return await inspectDatabasePlan({
        executor: transaction,
        files,
        target,
        activationContractSha256,
        runId: options.runId,
        approvalId: options.approvalId,
        now: options.now?.(),
      });
    } finally {
      if (!transaction.closed) await transaction.rollback();
      transaction.close();
    }
  } finally {
    await client.close();
  }
}

function assertIsoTimestamp(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      `${label} must be an exact ISO-8601 timestamp`,
    );
  }
}

function assertImpactRows(
  label: string,
  value: ProductTruthQueueImpact["queueV2CompatibilityBackfill"],
): void {
  if (
    !Number.isSafeInteger(value?.count)
    || value.count < 0
    || !Array.isArray(value.rowIds)
    || value.rowIds.some((id) => typeof id !== "string" || !id)
    || value.count !== value.rowIds.length
    || new Set(value.rowIds).size !== value.rowIds.length
    || value.rowIds.some((id, index) => index > 0 && value.rowIds[index - 1]!.localeCompare(id, "en-US") >= 0)
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      `${label} count and sorted unique row IDs are inconsistent`,
    );
  }
  assertLowerSha256(`${label}.rowsSha256`, value.rowsSha256);
}

function assertSealedPlanIntegrity(
  plan: ProductTruthMigrationPlan,
  files: readonly ProductTruthMigrationFile[],
): void {
  if (
    !plan
    || typeof plan !== "object"
    || plan.contractVersion !== PLAN_CONTRACT_VERSION
    || plan.mode !== "dry-run"
    || !plan.database
    || !plan.schema
    || !plan.queueImpact
    || !plan.writerActivity
    || !plan.runId
    || !plan.approvalId
    || !Array.isArray(plan.migrations)
    || !Array.isArray(plan.blockers)
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "plan is not a complete V2 activation plan",
    );
  }
  assertIsoTimestamp("plan.generatedAt", plan.generatedAt);
  assertOwnerIdentifier("runId", plan.runId);
  assertOwnerIdentifier("approvalId", plan.approvalId);
  for (const [label, value] of [
    ["migrationSetSha256", plan.migrationSetSha256],
    ["activationContractSha256", plan.activationContractSha256],
    ["targetFingerprint", plan.database.targetFingerprint],
    ["schema.sha256", plan.schema.sha256],
  ] as const) assertLowerSha256(label, value);
  if (
    !Number.isSafeInteger(plan.schema.objectCount)
    || !Number.isSafeInteger(plan.schema.tableCount)
    || !Number.isSafeInteger(plan.schema.triggerCount)
    || !Number.isSafeInteger(plan.schema.indexCount)
    || !Array.isArray(plan.schema.objects)
    || plan.schema.objectCount !== plan.schema.objects.length
    || plan.schema.objects.some((object) =>
      !object
      || typeof object.type !== "string"
      || typeof object.name !== "string"
      || typeof object.tableName !== "string"
      || !/^[a-f0-9]{64}$/.test(object.sqlSha256))
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "schema fingerprint summary is inconsistent",
    );
  }
  const impact = plan.queueImpact;
  if (impact.contractVersion !== "product-truth-migration-queue-impact/1") {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "queue impact contract version is invalid",
    );
  }
  assertImpactRows("queueV2CompatibilityBackfill", impact.queueV2CompatibilityBackfill);
  assertImpactRows("queueV3Cancellation", impact.queueV3Cancellation);
  assertImpactRows("runningQueueJobs", impact.runningQueueJobs);
  const { sha256: impactSha256, ...impactBody } = impact;
  assertLowerSha256("queueImpact.sha256", impactSha256);
  if (impactSha256 !== sha256(JSON.stringify(stableValue(impactBody)))) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "queue impact body does not match its internal SHA-256",
    );
  }
  const writerActivity = plan.writerActivity;
  if (
    writerActivity.contractVersion !== "product-truth-migration-writer-activity/1"
    || writerActivity.externalWriterQuiescenceRequired !== true
    || [
      writerActivity.enrichmentRunning,
      writerActivity.harvestRunning,
      writerActivity.operationalRunning,
      writerActivity.unsettledMeteredReceipts,
      writerActivity.unfinishedPrismaMigrations,
    ].some((count) => !Number.isSafeInteger(count) || count < 0)
    || !writerActivity.blockerSets
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "writer activity summary is invalid",
    );
  }
  for (const [label, value, count] of [
    ["enrichmentRunning", writerActivity.blockerSets.enrichmentRunning, writerActivity.enrichmentRunning],
    ["harvestRunning", writerActivity.blockerSets.harvestRunning, writerActivity.harvestRunning],
    ["operationalRunning", writerActivity.blockerSets.operationalRunning, writerActivity.operationalRunning],
    [
      "unsettledMeteredReceipts",
      writerActivity.blockerSets.unsettledMeteredReceipts,
      writerActivity.unsettledMeteredReceipts,
    ],
    [
      "unfinishedPrismaMigrations",
      writerActivity.blockerSets.unfinishedPrismaMigrations,
      writerActivity.unfinishedPrismaMigrations,
    ],
  ] as const) {
    assertImpactRows(`writerActivity.${label}`, value);
    if (value.count !== count) {
      throw new ProductTruthMigrationPlanError(
        "SEALED_PLAN_CONTRACT_INVALID",
        `writerActivity.${label} count does not match its blocker set`,
      );
    }
  }
  const { sha256: writerSha256, ...writerBody } = writerActivity;
  assertLowerSha256("writerActivity.sha256", writerSha256);
  if (writerSha256 !== sha256(JSON.stringify(stableValue(writerBody)))) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_CONTRACT_INVALID",
      "writer activity body does not match its internal SHA-256",
    );
  }
  if (
    plan.migrations.length !== files.length
    || plan.migrations.some((migration, index) =>
      !migration
      || migration.id !== files[index]?.id
      || migration.sha256 !== files[index]?.sha256
      || !Array.isArray(migration.blockers)
      || !Array.isArray(migration.presentArtifacts)
      || !Array.isArray(migration.missingArtifacts)
      || !Array.isArray(migration.unsafePresentArtifacts)
      || !Array.isArray(migration.missingPrerequisites))
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_RELEASE_MISMATCH",
      "plan migration entries do not match the canonical release",
    );
  }
}

function assertPlanCanApply(plan: ProductTruthMigrationPlan): void {
  if (!plan.canApply) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_PREFLIGHT_BLOCKED",
      plan.blockers.join("; ") || "preflight did not authorize apply",
    );
  }
  const unsafe = plan.migrations.filter(
    (migration) => !["pending", "applied"].includes(migration.state),
  );
  if (unsafe.length > 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_STATE_UNSAFE",
      unsafe.map((migration) => `${migration.id}=${migration.state}`).join(", "),
    );
  }
  const untrackedApplied = plan.migrations.filter(
    (migration) => migration.state === "applied" && migration.tracking !== "tracked",
  );
  if (untrackedApplied.length > 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_AUTO_ADOPT_FORBIDDEN",
      untrackedApplied.map((migration) => migration.id).join(", "),
    );
  }
  const appliedCount = plan.migrations.filter((migration) => migration.state === "applied").length;
  if (appliedCount > 0 && appliedCount !== plan.migrations.length) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_ATOMIC_RELEASE_INCOMPLETE",
      `canonical release has only ${appliedCount}/${plan.migrations.length} applied migrations`,
    );
  }
}

async function insertReceipt(input: {
  executor: SchemaExecutor;
  file: ProductTruthMigrationFile;
  migrationSetHash: string;
  activationContractSha256: string;
  targetFingerprint: string;
  runId: string;
  approvalId: string;
  planSha256: string;
  approvalSha256: string;
  schemaBeforeSha256: string;
  schemaAfterSha256: string;
  queueImpactSha256: string;
  appliedAt: string;
}): Promise<void> {
  await input.executor.execute({
    sql: `INSERT INTO ${quoteIdentifier(RECEIPT_TABLE)} (
      migrationId, migrationSha256, migrationSetSha256, activationContractSha256,
      runId, approvalId,
      targetFingerprint, planSha256, approvalSha256, schemaBeforeSha256,
      schemaAfterSha256, queueImpactSha256, action, appliedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
    args: [
      input.file.id,
      input.file.sha256,
      input.migrationSetHash,
      input.activationContractSha256,
      input.runId,
      input.approvalId,
      input.targetFingerprint,
      input.planSha256,
      input.approvalSha256,
      input.schemaBeforeSha256,
      input.schemaAfterSha256,
      input.queueImpactSha256,
      input.appliedAt,
    ],
  });
  const receipt = await input.executor.execute({
    sql: `SELECT ${RECEIPT_COLUMNS.map(quoteIdentifier).join(",")}
          FROM ${quoteIdentifier(RECEIPT_TABLE)} WHERE migrationId=?`,
    args: [input.file.id],
  });
  const row = receipt.rows[0];
  if (
    receipt.rows.length !== 1
    || String(row?.migrationId ?? "") !== input.file.id
    || String(row?.migrationSha256 ?? "") !== input.file.sha256
    || String(row?.migrationSetSha256 ?? "") !== input.migrationSetHash
    || String(row?.activationContractSha256 ?? "") !== input.activationContractSha256
    || String(row?.runId ?? "") !== input.runId
    || String(row?.approvalId ?? "") !== input.approvalId
    || String(row?.targetFingerprint ?? "") !== input.targetFingerprint
    || String(row?.planSha256 ?? "") !== input.planSha256
    || String(row?.approvalSha256 ?? "") !== input.approvalSha256
    || String(row?.schemaBeforeSha256 ?? "") !== input.schemaBeforeSha256
    || String(row?.schemaAfterSha256 ?? "") !== input.schemaAfterSha256
    || String(row?.queueImpactSha256 ?? "") !== input.queueImpactSha256
    || String(row?.action ?? "") !== "applied"
    || String(row?.appliedAt ?? "") !== input.appliedAt
  ) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_RECEIPT_HASH_CONFLICT",
      `${input.file.id} receipt does not match the exact activation binding`,
    );
  }
}

async function insertPrismaMigrationReceipt(input: {
  executor: SchemaExecutor;
  file: ProductTruthMigrationFile;
  appliedAt: string;
}): Promise<void> {
  await input.executor.execute({
    sql: `INSERT INTO "_prisma_migrations" (
      id, checksum, finished_at, migration_name, logs, rolled_back_at,
      started_at, applied_steps_count
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
    args: [randomUUID(), input.file.sha256, input.appliedAt, input.file.id, input.appliedAt],
  });
  const receipt = await input.executor.execute({
    sql: `SELECT checksum, finished_at, rolled_back_at, applied_steps_count
          FROM "_prisma_migrations" WHERE migration_name=?`,
    args: [input.file.id],
  });
  if (
    receipt.rows.length !== 1
    || String(receipt.rows[0]?.checksum ?? "") !== input.file.sha256
    || receipt.rows[0]?.finished_at == null
    || receipt.rows[0]?.rolled_back_at != null
    || Number(receipt.rows[0]?.applied_steps_count ?? 0) < 1
  ) {
    throw new ProductTruthMigrationPlanError(
      "PRISMA_MIGRATION_RECEIPT_CONFLICT",
      `${input.file.id} Prisma receipt was not registered exactly`,
    );
  }
}

async function insertActivationReceipt(input: {
  executor: SchemaExecutor;
  planSha256: string;
  approvalSha256: string;
  migrationSetSha256: string;
  activationContractSha256: string;
  targetFingerprint: string;
  report: unknown;
  completedAt: string;
}): Promise<string> {
  const reportJson = canonicalProductTruthMigrationArtifact(input.report);
  const reportSha256 = sha256(reportJson);
  await input.executor.execute({
    sql: `INSERT INTO ${quoteIdentifier(ACTIVATION_RECEIPT_TABLE)} (
      planSha256, approvalSha256, migrationSetSha256, activationContractSha256,
      targetFingerprint, reportSha256, reportJson, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.planSha256,
      input.approvalSha256,
      input.migrationSetSha256,
      input.activationContractSha256,
      input.targetFingerprint,
      reportSha256,
      reportJson,
      input.completedAt,
    ],
  });
  const receipt = await input.executor.execute({
    sql: `SELECT * FROM ${quoteIdentifier(ACTIVATION_RECEIPT_TABLE)} WHERE planSha256=?`,
    args: [input.planSha256],
  });
  const row = receipt.rows[0];
  if (
    receipt.rows.length !== 1
    || String(row?.approvalSha256 ?? "") !== input.approvalSha256
    || String(row?.migrationSetSha256 ?? "") !== input.migrationSetSha256
    || String(row?.activationContractSha256 ?? "") !== input.activationContractSha256
    || String(row?.targetFingerprint ?? "") !== input.targetFingerprint
    || String(row?.reportSha256 ?? "") !== reportSha256
    || String(row?.reportJson ?? "") !== reportJson
    || String(row?.completedAt ?? "") !== input.completedAt
  ) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_ACTIVATION_RECEIPT_CONFLICT",
      "durable activation report receipt does not match the committed activation",
    );
  }
  return reportSha256;
}

async function assertMigrationArtifactsApplied(
  executor: SchemaExecutor,
  file: ProductTruthMigrationFile,
): Promise<void> {
  const snapshot = await readSchema(executor);
  const missing = file.expectedArtifacts.filter((artifact) => !artifactPresent(snapshot, artifact));
  const unsafePresent = file.removedArtifacts.filter((artifact) =>
    artifactPresent(snapshot, artifact),
  );
  const definitionProblems = migrationDefinitionProblems(snapshot, file);
  if (missing.length > 0 || unsafePresent.length > 0 || definitionProblems.length > 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_POSTCONDITION_FAILED",
      [
        missing.length > 0 ? `${file.id} is missing artifacts: ${missing.join(", ")}` : null,
        unsafePresent.length > 0
          ? `${file.id} retained forbidden legacy artifacts: ${unsafePresent.join(", ")}`
          : null,
        definitionProblems.length > 0
          ? `${file.id} definition problems: ${definitionProblems.join(", ")}`
          : null,
      ].filter(Boolean).join("; "),
    );
  }
}

async function assertFullSchemaPostconditions(
  executor: SchemaExecutor,
  files: readonly ProductTruthMigrationFile[],
): Promise<SchemaSnapshot> {
  const snapshot = await readSchema(executor);
  const problems = files.flatMap((file) => [
    ...file.expectedArtifacts
      .filter((artifact) => !artifactPresent(snapshot, artifact))
      .map((artifact) => `${file.id}:missing:${artifact}`),
    ...file.removedArtifacts
      .filter((artifact) => artifactPresent(snapshot, artifact))
      .map((artifact) => `${file.id}:retained:${artifact}`),
    ...migrationDefinitionProblems(snapshot, file).map((problem) => `${file.id}:${problem}`),
  ]);
  for (const [table, from, referencedTable, to, onDelete, onUpdate] of REQUIRED_FOREIGN_KEYS) {
    const metadata = snapshot.exact.tableMetadata.find((entry) => entry.table === table);
    const found = metadata?.foreignKeys.some((row) =>
      String(row.from) === from
      && String(row.table) === referencedTable
      && String(row.to) === to
      && String(row.on_delete).toUpperCase() === onDelete
      && String(row.on_update).toUpperCase() === onUpdate
    );
    if (!found) problems.push(`foreign-key:${table}.${from}->${referencedTable}.${to}`);
  }
  const foreignKeyCheck = await executor.execute("PRAGMA foreign_key_check");
  if (foreignKeyCheck.rows.length > 0) {
    problems.push(`foreign_key_check:${sha256(JSON.stringify(normalizeResultRows(foreignKeyCheck.rows)))}`);
  }
  const foreignKeysEnabled = await executor.execute("PRAGMA foreign_keys");
  if (Number(foreignKeysEnabled.rows[0]?.foreign_keys ?? 0) !== 1) {
    problems.push("foreign-key-enforcement-disabled");
  }
  const ignoredCheckConstraints = await executor.execute("PRAGMA ignore_check_constraints");
  if (Number(ignoredCheckConstraints.rows[0]?.ignore_check_constraints ?? 0) !== 0) {
    problems.push("check-constraint-enforcement-disabled");
  }
  for (const object of [
    `table:${RECEIPT_TABLE}`,
    `trigger:${RECEIPT_UPDATE_GUARD}`,
    `trigger:${RECEIPT_DELETE_GUARD}`,
    `table:${ACTIVATION_RECEIPT_TABLE}`,
    `trigger:${ACTIVATION_RECEIPT_UPDATE_GUARD}`,
    `trigger:${ACTIVATION_RECEIPT_DELETE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_UPDATE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_DELETE_GUARD}`,
    `trigger:${PRISMA_RECEIPT_DUPLICATE_GUARD}`,
  ]) {
    if (!artifactPresent(snapshot, object)) problems.push(`missing:${object}`);
  }
  problems.push(
    ...schemaDefinitionProblems(snapshot, extractCreateDefinitions(receiptSchemaSql()))
      .map((problem) => `receipt-ledger:${problem}`),
  );
  if (problems.length > 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_FULL_POSTCONDITION_FAILED",
      problems.join("; "),
    );
  }
  return snapshot;
}

async function assertQueueEffects(
  executor: SchemaExecutor,
  impact: ProductTruthQueueImpact,
): Promise<void> {
  const chunks = (ids: readonly string[]) => {
    const output: string[][] = [];
    for (let index = 0; index < ids.length; index += 400) {
      output.push(ids.slice(index, index + 400));
    }
    return output;
  };
  const cancelledIds = new Set(impact.queueV3Cancellation.rowIds);
  for (const ids of chunks(impact.queueV2CompatibilityBackfill.rowIds)) {
    const result = await executor.execute({
      sql: `SELECT COUNT(*) AS count FROM "EnrichmentJob"
            WHERE "id" IN (${ids.map(() => "?").join(",")})
              AND "normalizedTarget"=lower(trim("target"))
              AND "idempotencyKey"='legacy:' || "id"
              AND "requestedFields"='["identity","offers","content","cogs"]'
              AND "estimatedSpendUnits"=0
              AND "actualSpendUnits"=0
              AND "providerAttempts" IS NULL
              AND "completedFields" IS NULL
              AND "unavailableFields" IS NULL
              AND "checkpoint" IS NULL
              AND "leaseOwner" IS NULL
              AND "leaseToken" IS NULL
              AND "leaseExpiresAt" IS NULL
              AND "heartbeatAt" IS NULL`,
      args: ids,
    });
    if (Number(result.rows[0]?.count ?? 0) !== ids.length) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_QUEUE_EFFECT_MISMATCH",
        "queue-v2 compatibility backfill did not match the sealed impact set",
      );
    }
    const terminalized = ids.filter((id) => cancelledIds.has(id));
    const stillEligible = ids.filter((id) => !cancelledIds.has(id));
    if (terminalized.length > 0) {
      const terminalResult = await executor.execute({
        sql: `SELECT COUNT(*) AS count FROM "EnrichmentJob"
              WHERE "id" IN (${terminalized.map(() => "?").join(",")})
                AND "nextEligibleAt" IS NULL`,
        args: terminalized,
      });
      if (Number(terminalResult.rows[0]?.count ?? 0) !== terminalized.length) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_QUEUE_EFFECT_MISMATCH",
          "queue-v3 did not terminalize the sealed queue-v2 overlap exactly",
        );
      }
    }
    if (stillEligible.length > 0) {
      const eligibleResult = await executor.execute({
        sql: `SELECT COUNT(*) AS count FROM "EnrichmentJob"
              WHERE "id" IN (${stillEligible.map(() => "?").join(",")})
                AND "nextEligibleAt"=COALESCE("queuedAt","createdAt")`,
        args: stillEligible,
      });
      if (Number(eligibleResult.rows[0]?.count ?? 0) !== stillEligible.length) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_QUEUE_EFFECT_MISMATCH",
          "queue-v2 next-eligible backfill did not match the sealed non-terminal set",
        );
      }
    }
  }
  for (const ids of chunks(impact.queueV3Cancellation.rowIds)) {
    const result = await executor.execute({
      sql: `SELECT COUNT(*) AS count FROM "EnrichmentJob"
            WHERE "id" IN (${ids.map(() => "?").join(",")})
              AND "status"='cancelled'
              AND "listingKey" IS NULL
              AND "nextEligibleAt" IS NULL
              AND "leaseOwner" IS NULL
              AND "leaseToken" IS NULL
              AND "leaseExpiresAt" IS NULL
              AND "finishedAt" IS NOT NULL
              AND "terminalReason"=CASE
                WHEN "targetType"='sku' THEN 'QUEUE_V3_LISTING_SCOPE_REQUIRED'
                ELSE 'QUEUE_V3_TARGET_TYPE_INVALID'
              END`,
      args: ids,
    });
    if (Number(result.rows[0]?.count ?? 0) !== ids.length) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_QUEUE_EFFECT_MISMATCH",
        "queue-v3 cancellation did not match the sealed impact set",
      );
    }
  }
  const residualV2 = await executor.execute(
    `SELECT COUNT(*) AS count FROM "EnrichmentJob" WHERE "idempotencyKey" IS NULL`,
  );
  if (Number(residualV2.rows[0]?.count ?? 0) !== 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_QUEUE_EFFECT_MISMATCH",
      "queue-v2 left rows outside the sealed compatibility postcondition",
    );
  }
  const residualV3 = await executor.execute(
    `SELECT COUNT(*) AS count FROM "EnrichmentJob"
     WHERE "status" IN ('queued','retry_wait')
       AND (
         "targetType" NOT IN ('brand','product','sku','query')
         OR ("targetType"='sku' AND "listingKey" IS NULL)
       )`,
  );
  if (Number(residualV3.rows[0]?.count ?? 0) !== 0) {
    throw new ProductTruthMigrationPlanError(
      "MIGRATION_QUEUE_EFFECT_MISMATCH",
      "queue-v3 left pending invalid or unscoped work outside the sealed cancellation set",
    );
  }
}

async function reserveArtifactDirectory(outputDirectory: string): Promise<string> {
  const absolute = resolve(outputDirectory);
  const parent = dirname(absolute);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    throw new ProductTruthMigrationPlanError(
      "ARTIFACT_PARENT_MISSING",
      `artifact parent does not exist: ${parent}`,
    );
  }
  if (!parentStat.isDirectory()) {
    throw new ProductTruthMigrationPlanError(
      "ARTIFACT_PARENT_INVALID",
      `artifact parent is not a directory: ${parent}`,
    );
  }
  try {
    await mkdir(absolute, { recursive: false });
  } catch {
    throw new ProductTruthMigrationPlanError(
      "ARTIFACT_DIRECTORY_EXISTS",
      `artifact directory must be new: ${absolute}`,
    );
  }
  return absolute;
}

async function writeSealedJson(
  directory: string,
  basename: string,
  value: unknown,
): Promise<{ jsonPath: string; sha256Path: string; sha256: string }> {
  const bytes = canonicalProductTruthMigrationArtifact(value);
  const digest = sha256(bytes);
  const jsonPath = resolve(directory, `${basename}.json`);
  const sha256Path = resolve(directory, `${basename}.sha256`);
  await writeFile(jsonPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(sha256Path, `${digest}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { jsonPath, sha256Path, sha256: digest };
}

export async function writeProductTruthMigrationPlanArtifact(
  plan: ProductTruthMigrationPlan,
  outputDirectory: string,
): Promise<{ planPath: string; planSha256Path: string; planSha256: string }> {
  const directory = await reserveArtifactDirectory(outputDirectory);
  const sealed = await writeSealedJson(directory, "plan", plan);
  return {
    planPath: sealed.jsonPath,
    planSha256Path: sealed.sha256Path,
    planSha256: sealed.sha256,
  };
}

async function readSealedJson<T>(
  jsonPath: string,
  shaPath: string,
  label: string,
): Promise<{ value: T; sha256: string }> {
  const [bytes, shaBytes] = await Promise.all([
    readFile(resolve(jsonPath), "utf8"),
    readFile(resolve(shaPath), "utf8"),
  ]);
  const expected = shaBytes.trim();
  assertLowerSha256(`${label} SHA`, expected);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_ARTIFACT_HASH_MISMATCH",
      `${label} hash does not match its sidecar`,
    );
  }
  let value: T;
  try {
    value = JSON.parse(bytes) as T;
  } catch {
    throw new ProductTruthMigrationPlanError("SEALED_ARTIFACT_JSON_INVALID", `${label} is not JSON`);
  }
  if (canonicalProductTruthMigrationArtifact(value) !== bytes) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_ARTIFACT_NOT_CANONICAL",
      `${label} bytes are not canonical`,
    );
  }
  return { value, sha256: actual };
}

function assertApprovalCurrent(
  approval: ProductTruthMigrationApprovalV2,
  plan: ProductTruthMigrationPlan,
  planSha256: string,
  approvalSha256: string,
  now: Date,
): void {
  if (
    !approval
    || typeof approval !== "object"
    || approval.contractVersion !== APPROVAL_CONTRACT_VERSION
    || approval.decision !== "APPROVE_PRODUCT_TRUTH_MIGRATIONS"
    || approval.approvedBy !== "owner"
    || approval.writersQuiesced !== true
  ) {
    throw new ProductTruthMigrationPlanError("OWNER_APPROVAL_INVALID", "approval contract is invalid");
  }
  assertOwnerIdentifier("runId", approval.runId);
  assertOwnerIdentifier("approvalId", approval.approvalId);
  for (const [label, value] of [
    ["approval.planSha256", approval.planSha256],
    ["approval.migrationSetSha256", approval.migrationSetSha256],
    ["approval.activationContractSha256", approval.activationContractSha256],
    ["approval.targetFingerprint", approval.targetFingerprint],
    ["approval.schemaBeforeSha256", approval.schemaBeforeSha256],
    ["approval.queueImpactSha256", approval.queueImpactSha256],
    ["approval.writerActivitySha256", approval.writerActivitySha256],
  ] as const) assertLowerSha256(label, value);
  for (const [label, left, right] of [
    ["runId", approval.runId, plan.runId],
    ["approvalId", approval.approvalId, plan.approvalId],
    ["planSha256", approval.planSha256, planSha256],
    ["migrationSetSha256", approval.migrationSetSha256, plan.migrationSetSha256],
    [
      "activationContractSha256",
      approval.activationContractSha256,
      plan.activationContractSha256,
    ],
    ["targetFingerprint", approval.targetFingerprint, plan.database?.targetFingerprint],
    ["schemaBeforeSha256", approval.schemaBeforeSha256, plan.schema?.sha256],
    ["queueImpactSha256", approval.queueImpactSha256, plan.queueImpact?.sha256],
    ["writerActivitySha256", approval.writerActivitySha256, plan.writerActivity?.sha256],
  ] as const) {
    if (left !== right) {
      throw new ProductTruthMigrationPlanError(
        "OWNER_APPROVAL_BINDING_MISMATCH",
        `${label} does not match the sealed plan`,
      );
    }
  }
  assertLowerSha256("approvalSha256", approvalSha256);
  if (
    typeof approval.backupReference !== "string"
    || !approval.backupReference.trim()
    || approval.backupReference.length > 512
  ) {
    throw new ProductTruthMigrationPlanError(
      "OWNER_APPROVAL_BACKUP_REQUIRED",
      "approval must identify the exact backup/snapshot",
    );
  }
  const issued = typeof approval.issuedAt === "string" ? Date.parse(approval.issuedAt) : Number.NaN;
  const expires = typeof approval.expiresAt === "string" ? Date.parse(approval.expiresAt) : Number.NaN;
  if (
    !Number.isFinite(issued)
    || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== approval.issuedAt
    || new Date(expires).toISOString() !== approval.expiresAt
    || expires <= issued
    || expires - issued > MAX_APPROVAL_TTL_MS
    || now.getTime() < issued
    || now.getTime() > expires
  ) {
    throw new ProductTruthMigrationPlanError(
      "OWNER_APPROVAL_EXPIRED",
      "approval is not current or exceeds the maximum 30-minute TTL",
    );
  }
}

export async function applyProductTruthMigrations(options: {
  databaseUrl: string;
  authToken?: string;
  allowRemote?: boolean;
  planPath: string;
  planSha256Path: string;
  approvalPath: string;
  approvalSha256Path: string;
  confirmationToken: string;
  outputDirectory: string;
  migrationsRoot?: string;
  cwd?: string;
  now?: () => Date;
}): Promise<ProductTruthMigrationApplyResult> {
  const files = await loadProductTruthMigrationFiles(options.migrationsRoot);
  const setHash = migrationSetSha256(files);
  const activationContractSha256 = await readActivationContractSha256();
  const target = resolveDatabaseTarget(options.databaseUrl, options.cwd);
  assertDatabaseTargetAllowed(target, options);
  await assertLocalDatabaseExists(target);
  const sealedPlan = await readSealedJson<ProductTruthMigrationPlan>(
    options.planPath,
    options.planSha256Path,
    "migration plan",
  );
  const sealedApproval = await readSealedJson<ProductTruthMigrationApprovalV2>(
    options.approvalPath,
    options.approvalSha256Path,
    "owner approval",
  );
  const plan = sealedPlan.value;
  const approval = sealedApproval.value;
  assertSealedPlanIntegrity(plan, files);
  if (
    plan.migrationSetSha256 !== setHash
    || plan.activationContractSha256 !== activationContractSha256
    || plan.database?.targetFingerprint !== target.fingerprint
    || plan.migrations.length !== files.length
    || plan.migrations.some((migration, index) =>
      migration.id !== files[index]?.id || migration.sha256 !== files[index]?.sha256)
  ) {
    throw new ProductTruthMigrationPlanError(
      "SEALED_PLAN_RELEASE_MISMATCH",
      "plan does not bind the exact target and canonical eight-migration release",
    );
  }
  assertPlanCanApply(plan);
  const now = options.now?.() ?? new Date();
  assertApprovalCurrent(
    approval,
    plan,
    sealedPlan.sha256,
    sealedApproval.sha256,
    now,
  );
  const expectedConfirmation = buildProductTruthMigrationConfirmationToken({
    runId: approval.runId,
    approvalId: approval.approvalId,
    activationContractSha256,
    planSha256: sealedPlan.sha256,
    approvalSha256: sealedApproval.sha256,
    targetFingerprint: target.fingerprint,
  });
  if (options.confirmationToken !== expectedConfirmation) {
    throw new ProductTruthMigrationPlanError(
      "APPLY_CONFIRMATION_MISMATCH",
      "V2 confirmation does not exactly match run, approval, plan and target",
    );
  }
  const reportDirectory = await reserveArtifactDirectory(options.outputDirectory);

  const client: Client = createClient({
    url: target.clientUrl,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  const actions: ProductTruthMigrationApplyResult["actions"] = [];
  let schemaBeforeSha256 = ZERO_SHA256;
  let schemaAfterSha256 = ZERO_SHA256;
  let finalPlan: ProductTruthMigrationPlan | null = null;
  let durableReport: unknown = null;
  let durableReportSha256 = ZERO_SHA256;
  try {
    const transaction = await client.transaction("write");
    try {
      const preflight = await inspectDatabasePlan({
        executor: transaction,
        files,
        target,
        activationContractSha256,
        runId: approval.runId,
        approvalId: approval.approvalId,
        now,
      });
      assertPlanCanApply(preflight);
      schemaBeforeSha256 = preflight.schema?.sha256 ?? ZERO_SHA256;
      if (schemaBeforeSha256 !== plan.schema?.sha256) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_SCHEMA_DRIFT",
          "database schema changed after the sealed plan",
        );
      }
      if (preflight.queueImpact?.sha256 !== plan.queueImpact?.sha256) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_EFFECT_DRIFT",
          "queue mutation set changed after the sealed plan",
        );
      }
      if (preflight.writerActivity?.sha256 !== plan.writerActivity?.sha256) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_WRITER_ACTIVITY_DRIFT",
          "writer/quiescence state changed after the sealed plan",
        );
      }
      const plannedStates = plan.migrations.map((migration) => ({
        id: migration.id,
        state: migration.state,
        tracking: migration.tracking,
      }));
      const currentStates = preflight.migrations.map((migration) => ({
        id: migration.id,
        state: migration.state,
        tracking: migration.tracking,
      }));
      if (JSON.stringify(plannedStates) !== JSON.stringify(currentStates)) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_STATE_DRIFT",
          "migration state changed after the sealed plan",
        );
      }
      if (preflight.receiptLedger === "absent") {
        await transaction.executeMultiple(receiptSchemaSql());
      } else if (preflight.receiptLedger !== "ready") {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_RECEIPT_LEDGER_INVALID",
          "receipt ledger is neither absent nor ready",
        );
      }
      const appliedAt = now.toISOString();

      for (const migration of preflight.migrations) {
        const file = files.find((candidate) => candidate.id === migration.id);
        if (!file) {
          throw new ProductTruthMigrationPlanError(
            "MIGRATION_FILE_NOT_FOUND",
            `no loaded file for ${migration.id}`,
          );
        }
        if (migration.state === "pending") {
          await transaction.executeMultiple(file.sql);
          await assertMigrationArtifactsApplied(transaction, file);
          actions.push({ id: file.id, action: "applied", sha256: file.sha256 });
        } else {
          if (migration.tracking !== "tracked") {
            throw new ProductTruthMigrationPlanError(
              "MIGRATION_AUTO_ADOPT_FORBIDDEN",
              `${file.id} is applied without both exact receipts`,
            );
          }
          actions.push({ id: file.id, action: "already_applied", sha256: file.sha256 });
        }
      }
      await assertQueueEffects(transaction, plan.queueImpact!);
      const afterSnapshot = await assertFullSchemaPostconditions(transaction, files);
      schemaAfterSha256 = afterSnapshot.fingerprint.sha256;
      for (const action of actions) {
        if (action.action !== "applied") continue;
        const file = files.find((candidate) => candidate.id === action.id)!;
        await insertPrismaMigrationReceipt({ executor: transaction, file, appliedAt });
        await insertReceipt({
          executor: transaction,
          file,
          migrationSetHash: setHash,
          activationContractSha256,
          targetFingerprint: target.fingerprint,
          runId: approval.runId,
          approvalId: approval.approvalId,
          planSha256: sealedPlan.sha256,
          approvalSha256: sealedApproval.sha256,
          schemaBeforeSha256,
          schemaAfterSha256,
          queueImpactSha256: plan.queueImpact!.sha256,
          appliedAt,
        });
      }
      const verified = await inspectDatabasePlan({
        executor: transaction,
        files,
        target,
        activationContractSha256,
        runId: approval.runId,
        approvalId: approval.approvalId,
        now,
      });
      if (
        verified.migrations.some((migration) =>
          migration.state !== "applied" || migration.tracking !== "tracked")
        || verified.receiptLedger !== "ready"
        || verified.prismaLedger !== "ready"
      ) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_DUAL_LEDGER_VERIFICATION_FAILED",
          verified.blockers.join("; ") || "dual ledger did not verify",
        );
      }
      durableReport = {
        contractVersion: REPORT_CONTRACT_VERSION,
        mode: "apply",
        generatedAt: now.toISOString(),
        migrationSetSha256: setHash,
        activationContractSha256,
        targetFingerprint: target.fingerprint,
        runId: approval.runId,
        approvalId: approval.approvalId,
        planSha256: sealedPlan.sha256,
        approvalSha256: sealedApproval.sha256,
        schemaBeforeSha256,
        schemaAfterSha256,
        queueImpact: plan.queueImpact,
        writerActivityAtPlan: plan.writerActivity,
        actions,
        final: {
          receiptLedger: verified.receiptLedger,
          prismaLedger: verified.prismaLedger,
          migrationStates: verified.migrations.map((migration) => ({
            id: migration.id,
            state: migration.state,
            tracking: migration.tracking,
          })),
        },
      };
      durableReportSha256 = await insertActivationReceipt({
        executor: transaction,
        planSha256: sealedPlan.sha256,
        approvalSha256: sealedApproval.sha256,
        migrationSetSha256: setHash,
        activationContractSha256,
        targetFingerprint: target.fingerprint,
        report: durableReport,
        completedAt: appliedAt,
      });
      await transaction.commit();
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }

    if (durableReport === null || durableReportSha256 === ZERO_SHA256) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_MISSING",
        "activation committed without a durable canonical report receipt",
      );
    }
    const sealedReport = await writeSealedJson(reportDirectory, "report", durableReport);
    if (sealedReport.sha256 !== durableReportSha256) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_HASH_MISMATCH",
        "filesystem report does not match the durable activation receipt",
      );
    }

    const durableSnapshot = await assertFullSchemaPostconditions(client, files);
    await assertQueueEffects(client, plan.queueImpact!);
    if (durableSnapshot.fingerprint.sha256 !== schemaAfterSha256) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_POST_COMMIT_SCHEMA_DRIFT",
        "durable schema does not match the schema verified inside the activation transaction",
      );
    }
    finalPlan = await inspectDatabasePlan({
      executor: client,
      files,
      target,
      activationContractSha256,
      runId: approval.runId,
      approvalId: approval.approvalId,
      now,
    });
    if (
      !finalPlan.canApply
      || finalPlan.blockers.length > 0
      || finalPlan.schema?.sha256 !== schemaAfterSha256
      || finalPlan.migrations.some((migration) =>
        migration.state !== "applied" || migration.tracking !== "tracked")
    ) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_FINAL_VERIFICATION_FAILED",
        finalPlan.blockers.join("; ")
          || "one or more Product Truth migrations lack exact durable verification",
      );
    }
    const migrationCertification: ProductTruthMigrationCertification = {
      contractVersion: PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
      migrationSetSha256: setHash,
      migrationReportSha256: sealedReport.sha256,
      schemaFingerprintSha256: schemaAfterSha256,
      databaseTargetFingerprint: target.fingerprint,
      allMigrationsApplied: true,
      allReceiptsTracked: true,
      receiptLedgerReady: true,
    };
    const sealedCertification = await writeSealedJson(
      reportDirectory,
      "migration-certification",
      migrationCertification,
    );
    return {
      contractVersion: APPLY_CONTRACT_VERSION,
      mode: "apply",
      migrationSetSha256: setHash,
      activationContractSha256,
      targetFingerprint: target.fingerprint,
      runId: approval.runId,
      approvalId: approval.approvalId,
      planSha256: sealedPlan.sha256,
      approvalSha256: sealedApproval.sha256,
      schemaBeforeSha256,
      schemaAfterSha256,
      queueImpactSha256: plan.queueImpact!.sha256,
      actions,
      finalPlan,
      reportSha256: sealedReport.sha256,
      reportPath: sealedReport.jsonPath,
      reportSha256Path: sealedReport.sha256Path,
      migrationCertificationSha256: sealedCertification.sha256,
      migrationCertificationPath: sealedCertification.jsonPath,
      migrationCertificationSha256Path: sealedCertification.sha256Path,
    };
  } finally {
    await client.close();
  }
}

export async function recoverProductTruthMigrationReport(options: {
  databaseUrl: string;
  planSha256: string;
  outputDirectory: string;
  authToken?: string;
  allowRemote?: boolean;
  cwd?: string;
}): Promise<{
  reportPath: string;
  reportSha256Path: string;
  reportSha256: string;
  migrationCertificationPath: string;
  migrationCertificationSha256Path: string;
  migrationCertificationSha256: string;
}> {
  assertLowerSha256("planSha256", options.planSha256);
  const target = resolveDatabaseTarget(options.databaseUrl, options.cwd);
  assertDatabaseTargetAllowed(target, options);
  await assertLocalDatabaseExists(target);
  const client = createClient({
    url: target.clientUrl,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  try {
    const transaction = await client.transaction("read");
    let reportJson = "";
    let expectedSha256 = "";
    try {
      const receipt = await transaction.execute({
        sql: `SELECT reportJson,reportSha256
              FROM ${quoteIdentifier(ACTIVATION_RECEIPT_TABLE)} WHERE planSha256=?`,
        args: [options.planSha256],
      });
      if (receipt.rows.length !== 1) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_REPORT_RECOVERY_NOT_FOUND",
          "no exact durable activation report receipt exists for the requested plan",
        );
      }
      reportJson = String(receipt.rows[0]?.reportJson ?? "");
      expectedSha256 = String(receipt.rows[0]?.reportSha256 ?? "");
    } finally {
      if (!transaction.closed) await transaction.rollback();
      transaction.close();
    }
    assertLowerSha256("durable report SHA", expectedSha256);
    if (sha256(reportJson) !== expectedSha256) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_HASH_MISMATCH",
        "durable report payload does not match its immutable SHA-256",
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(reportJson);
    } catch {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_JSON_INVALID",
        "durable report payload is not JSON",
      );
    }
    if (canonicalProductTruthMigrationArtifact(report) !== reportJson) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_NOT_CANONICAL",
        "durable report payload is not canonical",
      );
    }
    if (!report || typeof report !== "object") {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_CONTRACT_INVALID",
        "durable report payload is not an activation report object",
      );
    }
    const reportRecord = report as Record<string, unknown>;
    const files = await loadProductTruthMigrationFiles();
    const setHash = migrationSetSha256(files);
    const activationContractSha256 = await readActivationContractSha256();
    if (
      reportRecord.contractVersion !== REPORT_CONTRACT_VERSION
      || reportRecord.mode !== "apply"
      || reportRecord.planSha256 !== options.planSha256
      || reportRecord.migrationSetSha256 !== setHash
      || reportRecord.activationContractSha256 !== activationContractSha256
      || reportRecord.targetFingerprint !== target.fingerprint
      || typeof reportRecord.runId !== "string"
      || typeof reportRecord.approvalId !== "string"
      || typeof reportRecord.schemaAfterSha256 !== "string"
    ) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_CONTRACT_INVALID",
        "durable report is not bound to the current exact activation release and target",
      );
    }
    const verification = await client.transaction("read");
    try {
      const current = await inspectDatabasePlan({
        executor: verification,
        files,
        target,
        activationContractSha256,
        runId: reportRecord.runId,
        approvalId: reportRecord.approvalId,
      });
      if (
        !current.canApply
        || current.blockers.length > 0
        || current.schema?.sha256 !== reportRecord.schemaAfterSha256
        || current.migrations.some((migration) =>
          migration.state !== "applied" || migration.tracking !== "tracked")
      ) {
        throw new ProductTruthMigrationPlanError(
          "MIGRATION_REPORT_RECOVERY_DATABASE_DRIFT",
          current.blockers.join("; ")
            || "database no longer matches the committed activation report",
        );
      }
    } finally {
      if (!verification.closed) await verification.rollback();
      verification.close();
    }
    const directory = await reserveArtifactDirectory(options.outputDirectory);
    const sealed = await writeSealedJson(directory, "report", report);
    if (sealed.sha256 !== expectedSha256) {
      throw new ProductTruthMigrationPlanError(
        "MIGRATION_REPORT_RECOVERY_HASH_MISMATCH",
        "recovered report hash differs from the durable receipt",
      );
    }
    const certification: ProductTruthMigrationCertification = {
      contractVersion: PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
      migrationSetSha256: setHash,
      migrationReportSha256: sealed.sha256,
      schemaFingerprintSha256: reportRecord.schemaAfterSha256,
      databaseTargetFingerprint: target.fingerprint,
      allMigrationsApplied: true,
      allReceiptsTracked: true,
      receiptLedgerReady: true,
    };
    const sealedCertification = await writeSealedJson(
      directory,
      "migration-certification",
      certification,
    );
    return {
      reportPath: sealed.jsonPath,
      reportSha256Path: sealed.sha256Path,
      reportSha256: sealed.sha256,
      migrationCertificationPath: sealedCertification.jsonPath,
      migrationCertificationSha256Path: sealedCertification.sha256Path,
      migrationCertificationSha256: sealedCertification.sha256,
    };
  } finally {
    await client.close();
  }
}

interface CliOptions {
  command: "plan" | "apply" | "recover-report";
  allowRemote: boolean;
  databaseUrl?: string;
  authTokenEnv?: string;
  runId?: string;
  approvalId?: string;
  confirmationToken?: string;
  outputDirectory?: string;
  planPath?: string;
  planSha256Path?: string;
  approvalPath?: string;
  approvalSha256Path?: string;
  help: boolean;
}

function parseCliArguments(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command !== "plan" && command !== "apply" && command !== "recover-report") {
    if (command === "--help" || command === "-h") {
      return { command: "plan", allowRemote: false, help: true };
    }
    throw new ProductTruthMigrationPlanError(
      "CLI_COMMAND_REQUIRED",
      "first argument must be plan, apply or recover-report",
    );
  }
  const result: CliOptions = { command, allowRemote: false, help: false };
  const valueFlags: ReadonlyMap<
    string,
    | "databaseUrl"
    | "authTokenEnv"
    | "runId"
    | "approvalId"
    | "confirmationToken"
    | "outputDirectory"
    | "planPath"
    | "planSha256Path"
    | "approvalPath"
    | "approvalSha256Path"
  > = new Map([
    ["--url", "databaseUrl"],
    ["--auth-token-env", "authTokenEnv"],
    ["--run-id", "runId"],
    ["--approval-id", "approvalId"],
    ["--confirm", "confirmationToken"],
    ["--out", "outputDirectory"],
    ["--plan", "planPath"],
    ["--plan-sha", "planSha256Path"],
    ["--approval", "approvalPath"],
    ["--approval-sha", "approvalSha256Path"],
  ] as const);

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-remote") result.allowRemote = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else {
      const equals = argument.indexOf("=");
      const flag = equals < 0 ? argument : argument.slice(0, equals);
      const property = valueFlags.get(flag);
      if (!property) {
        throw new ProductTruthMigrationPlanError(
          "CLI_ARGUMENT_UNKNOWN",
          `unknown argument ${flag}`,
        );
      }
      const value = equals < 0 ? argv[index + 1] : argument.slice(equals + 1);
      if (equals < 0) index += 1;
      if (!value || value.startsWith("--")) {
        throw new ProductTruthMigrationPlanError(
          "CLI_ARGUMENT_VALUE_REQUIRED",
          `${flag} requires a value`,
        );
      }
      result[property] = value;
    }
  }
  return result;
}

export function resolveProductTruthMigrationCliAuthToken(
  envName: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!envName) return undefined;
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(envName)) {
    throw new ProductTruthMigrationPlanError(
      "AUTH_TOKEN_ENV_NAME_INVALID",
      "--auth-token-env must name an uppercase environment variable",
    );
  }
  const token = environment[envName]?.trim();
  if (!token) {
    throw new ProductTruthMigrationPlanError(
      "AUTH_TOKEN_ENV_MISSING",
      `the named auth-token environment variable ${envName} is empty or absent`,
    );
  }
  return token;
}

function usage(): string {
  return [
    "Product Truth migration activation V2 (canonical eight migrations only)",
    "",
    "Sealed read-only plan:",
    "  node --import tsx scripts/product-truth-migration-plan.ts plan --url file:/ABS/db.sqlite",
    "    --run-id OWNER_RUN --approval-id OWNER_APPROVAL --out /ABS/NEW_PLAN_DIR",
    "",
    "Sealed owner-approved apply:",
    "  node --import tsx scripts/product-truth-migration-plan.ts apply --url file:/ABS/db.sqlite",
    "    --plan /ABS/plan.json --plan-sha /ABS/plan.sha256",
    "    --approval /ABS/approval.json --approval-sha /ABS/approval.sha256",
    "    --confirm EXACT_V2_TOKEN --out /ABS/NEW_REPORT_DIR",
    "",
    "Remote commands additionally require --allow-remote --auth-token-env ENV_NAME.",
    "Crash-safe report recovery:",
    "  node --import tsx scripts/product-truth-migration-plan.ts recover-report --url file:/ABS/db.sqlite",
    "    --plan /ABS/plan.json --plan-sha /ABS/plan.sha256 --out /ABS/NEW_REPORT_DIR",
    "",
    "Raw auth-token values are never accepted as CLI arguments or printed.",
  ].join("\n");
}

export async function runProductTruthMigrationCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const options = parseCliArguments(argv);
  if (options.help) {
    return { help: usage() };
  }
  const authToken = resolveProductTruthMigrationCliAuthToken(
    options.authTokenEnv,
    environment,
  );
  try {
    if (options.command === "recover-report") {
      if (
        !options.databaseUrl
        || !options.planPath
        || !options.planSha256Path
        || !options.outputDirectory
      ) {
        throw new ProductTruthMigrationPlanError(
          "RECOVER_REPORT_ARGUMENTS_INCOMPLETE",
          "recover-report requires --url, --plan, --plan-sha and --out",
        );
      }
      const sealedPlan = await readSealedJson<ProductTruthMigrationPlan>(
        options.planPath,
        options.planSha256Path,
        "migration plan",
      );
      return await recoverProductTruthMigrationReport({
        databaseUrl: options.databaseUrl,
        planSha256: sealedPlan.sha256,
        outputDirectory: options.outputDirectory,
        authToken,
        allowRemote: options.allowRemote,
      });
    }
    if (options.command === "plan") {
      if (
        !options.databaseUrl
        || !options.runId
        || !options.approvalId
        || !options.outputDirectory
      ) {
        throw new ProductTruthMigrationPlanError(
          "PLAN_ARGUMENTS_INCOMPLETE",
          "plan requires --url, --run-id, --approval-id and --out",
        );
      }
      const plan = await planProductTruthMigrations({
        databaseUrl: options.databaseUrl,
        authToken,
        allowRemote: options.allowRemote,
        runId: options.runId,
        approvalId: options.approvalId,
      });
      const artifact = await writeProductTruthMigrationPlanArtifact(
        plan,
        options.outputDirectory,
      );
      return {
        command: "plan",
        canApply: plan.canApply,
        blockers: plan.blockers,
        migrationSetSha256: plan.migrationSetSha256,
        activationContractSha256: plan.activationContractSha256,
        targetFingerprint: plan.database?.targetFingerprint ?? null,
        schemaSha256: plan.schema?.sha256 ?? null,
        queueImpactSha256: plan.queueImpact?.sha256 ?? null,
        ...artifact,
      };
    }
    if (
      !options.databaseUrl
      || !options.planPath
      || !options.planSha256Path
      || !options.approvalPath
      || !options.approvalSha256Path
      || !options.confirmationToken
      || !options.outputDirectory
    ) {
      throw new ProductTruthMigrationPlanError(
        "APPLY_OWNER_GATE_INCOMPLETE",
        "apply requires --url, --plan, --plan-sha, --approval, --approval-sha, --confirm and --out",
      );
    }
    return await applyProductTruthMigrations({
      databaseUrl: options.databaseUrl,
      authToken,
      allowRemote: options.allowRemote,
      planPath: options.planPath,
      planSha256Path: options.planSha256Path,
      approvalPath: options.approvalPath,
      approvalSha256Path: options.approvalSha256Path,
      confirmationToken: options.confirmationToken,
      outputDirectory: options.outputDirectory,
    });
  } catch (error) {
    if (!authToken || !String(error).includes(authToken)) throw error;
    const code = error instanceof ProductTruthMigrationPlanError
      ? error.code
      : "CLI_OPERATION_FAILED";
    const prefix = `${code}: `;
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(authToken, "[REDACTED]");
    throw new ProductTruthMigrationPlanError(
      code,
      message.startsWith(prefix) ? message.slice(prefix.length) : message,
    );
  }
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (invokedAsScript) {
  runProductTruthMigrationCli(process.argv.slice(2), process.env).then((result) => {
    if (result && typeof result === "object" && "help" in result) {
      console.log(String((result as { help: unknown }).help));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }).catch((error: unknown) => {
    const code = error instanceof ProductTruthMigrationPlanError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
    process.exitCode = 1;
  });
}
