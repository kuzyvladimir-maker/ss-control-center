import type { Client } from "@libsql/client";

export class ProductTruthSchemaNotReadyError extends Error {
  readonly code = "PRODUCT_TRUTH_SCHEMA_NOT_READY";
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`PRODUCT_TRUTH_SCHEMA_NOT_READY missing ${missing.join(", ")}`);
    this.name = "ProductTruthSchemaNotReadyError";
    this.missing = missing;
  }
}

async function columns(db: Client, table: string): Promise<Set<string>> {
  const result = await db.execute(`PRAGMA table_info("${table}")`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function hasTable(db: Client, table: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    args: [table],
  });
  return result.rows.length > 0;
}

async function hasTrigger(db: Client, trigger: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? LIMIT 1`,
    args: [trigger],
  });
  return result.rows.length > 0;
}

async function hasIndex(db: Client, index: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='index' AND name=? LIMIT 1`,
    args: [index],
  });
  return result.rows.length > 0;
}

async function hasForeignKey(
  db: Client,
  table: string,
  from: string,
  referencedTable: string,
  to = "id",
  actions: { onDelete: "RESTRICT" | "CASCADE"; onUpdate: "RESTRICT" | "CASCADE" } = {
    onDelete: "RESTRICT",
    onUpdate: "RESTRICT",
  },
): Promise<boolean> {
  const result = await db.execute(`PRAGMA foreign_key_list("${table}")`);
  return result.rows.some((row) =>
    String(row.from) === from
    && String(row.table) === referencedTable
    && String(row.to) === to
    && String(row.on_delete).toUpperCase() === actions.onDelete
    && String(row.on_update).toUpperCase() === actions.onUpdate
  );
}

/**
 * Fail before retailer/API work when code requiring evidence separation is
 * deployed ahead of its schema migration. There is intentionally no legacy
 * fallback: a paid observation without durable provenance is not acceptable.
 */
export async function assertProductTruthEvidenceSchema(db: Client): Promise<void> {
  const missing: string[] = [];
  try {
    const productColumns = await columns(db, "DonorProduct");
    for (const column of ["identityStatus", "identityMatcherVersion", "identityEvidenceJson", "identityConfirmedAt"]) {
      if (!productColumns.has(column)) missing.push(`DonorProduct.${column}`);
    }
  } catch {
    missing.push("DonorProduct");
  }
  try {
    const offerColumns = await columns(db, "DonorOffer");
    if (!offerColumns.has("localityEvidence")) missing.push("DonorOffer.localityEvidence");
  } catch {
    missing.push("DonorOffer");
  }
  try {
    const componentColumns = await columns(db, "SkuComponent");
    for (const column of [
      "contentDonorProductId",
      "priceEvidenceDonorProductId",
      "priceEvidenceOfferId",
      "priceEvidenceObservationId",
      "matchTier",
      "matcherVersion",
      "priceEvidenceStatus",
      "pricePolicyVersion",
      "priceEvidenceJson",
    ]) {
      if (!componentColumns.has(column)) missing.push(`SkuComponent.${column}`);
    }
  } catch {
    missing.push("SkuComponent");
  }
  try {
    const costColumns = await columns(db, "SkuCost");
    for (const column of [
      "observationKey",
      "recipeHash",
      "evidenceJson",
      "evidenceOutcome",
      "matcherVersion",
      "pricePolicyVersion",
      "runId",
      "approvalId",
    ]) {
      if (!costColumns.has(column)) missing.push(`SkuCost.${column}`);
    }
  } catch {
    missing.push("SkuCost");
  }
  try {
    const requiredTables: Record<string, readonly string[]> = {
      CanonicalProductVariant: [
        "id", "variantKey", "identityHash", "keyVersion", "normalizedBrand",
        "normalizedProductLine", "normalizedFlavor", "normalizedModifiersJson",
        "normalizedForm", "sizeDimension", "sizeBaseAmount", "sizeBaseUnit",
        "outerPackCount", "identityJson", "createdAt",
      ],
      DonorProductVariantDecision: [
        "id", "decisionKey", "donorProductId", "canonicalVariantId",
        "decisionStatus", "matcherVersion", "evidenceHash", "evidenceJson",
        "decidedAt", "runId", "approvalId", "createdAt",
      ],
      ProductContentObservation: [
        "id", "observationKey", "donorProductId", "canonicalVariantId",
        "variantDecisionId", "sourceUrl", "sourceApi", "contentHash",
        "fieldHashesJson", "contentJson", "observedAt", "runId", "approvalId",
        "meteredReceiptId", "createdAt",
      ],
      DonorOfferObservation: [
        "id", "observationKey", "donorOfferId", "donorProductId",
        "canonicalVariantId", "variantDecisionId", "observedAt", "runId",
        "approvalId", "meteredReceiptId", "createdAt",
      ],
      SkuComponentEvidence: [
        "id", "evidenceKey", "skuCostId", "componentIndex", "evidenceStatus",
        "targetCanonicalVariantId", "contentCanonicalVariantId",
        "priceCanonicalVariantId", "contentObservationId", "priceObservationId",
        "matchTier", "matcherVersion", "pricePolicyVersion", "evidenceHash",
        "evidenceJson", "createdAt",
      ],
    };
    for (const [table, requiredColumns] of Object.entries(requiredTables)) {
      if (!(await hasTable(db, table))) {
        missing.push(table);
        continue;
      }
      const present = await columns(db, table);
      for (const column of requiredColumns) {
        if (!present.has(column)) missing.push(`${table}.${column}`);
      }
    }
  } catch {
    missing.push("canonical-evidence-tables");
  }
  for (const trigger of [
    "CanonicalProductVariant_insert_collision_guard",
    "CanonicalProductVariant_duplicate_insert_guard",
    "CanonicalProductVariant_update_guard",
    "CanonicalProductVariant_delete_guard",
    "DonorProductVariantDecision_update_guard",
    "DonorProductVariantDecision_delete_guard",
    "DonorProductVariantDecision_duplicate_insert_guard",
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
    "SkuComponent_evidence_contract_insert",
    "SkuComponent_evidence_contract_update",
  ]) {
    try {
      if (!(await hasTrigger(db, trigger))) missing.push(`trigger:${trigger}`);
    } catch {
      missing.push(`trigger:${trigger}`);
    }
  }
  for (const index of [
    "CanonicalProductVariant_brand_line_idx",
    "DonorProductVariantDecision_one_exact_per_donor",
    "ProductContentObservation_variant_observed_idx",
    "DonorOfferObservation_variant_observed_idx",
    "SkuComponentEvidence_cost_component_key",
    "SkuCost_observationKey_key",
    "SkuCost_period_lookup_idx",
  ]) {
    try {
      if (!(await hasIndex(db, index))) missing.push(`index:${index}`);
    } catch {
      missing.push(`index:${index}`);
    }
  }
  const foreignKeys = [
    ["DonorProductVariantDecision", "donorProductId", "DonorProduct"],
    ["DonorProductVariantDecision", "canonicalVariantId", "CanonicalProductVariant"],
    ["ProductContentObservation", "donorProductId", "DonorProduct"],
    ["ProductContentObservation", "canonicalVariantId", "CanonicalProductVariant"],
    ["ProductContentObservation", "variantDecisionId", "DonorProductVariantDecision"],
    ["DonorOfferObservation", "donorOfferId", "DonorOffer"],
    ["DonorOfferObservation", "donorProductId", "DonorProduct"],
    ["DonorOfferObservation", "canonicalVariantId", "CanonicalProductVariant"],
    ["DonorOfferObservation", "variantDecisionId", "DonorProductVariantDecision"],
    ["SkuComponentEvidence", "skuCostId", "SkuCost"],
    ["SkuComponentEvidence", "targetCanonicalVariantId", "CanonicalProductVariant"],
    ["SkuComponentEvidence", "contentCanonicalVariantId", "CanonicalProductVariant"],
    ["SkuComponentEvidence", "priceCanonicalVariantId", "CanonicalProductVariant"],
    ["SkuComponentEvidence", "contentObservationId", "ProductContentObservation"],
    ["SkuComponentEvidence", "priceObservationId", "DonorOfferObservation"],
  ] as const;
  for (const [table, from, referencedTable] of foreignKeys) {
    try {
      if (!(await hasForeignKey(db, table, from, referencedTable))) {
        missing.push(`foreign-key:${table}.${from}->${referencedTable}.id`);
      }
    } catch {
      missing.push(`foreign-key:${table}.${from}->${referencedTable}.id`);
    }
  }
  if (missing.length) throw new ProductTruthSchemaNotReadyError([...new Set(missing)]);
}

export async function assertDonorHarvestSchema(db: Client): Promise<void> {
  const missing: string[] = [];
  const table = "DonorHarvestState";
  const requiredColumns = [
    "id", "donorProductId", "source", "retailerProductId", "status",
    "requestedFields", "completedFields", "unavailableFields", "attempts",
    "maxAttempts", "nextEligibleAt", "terminalReason", "lastError",
    "lastBlockReason", "runId", "approvalId", "leaseOwner", "leaseToken",
    "leaseExpiresAt", "claimedAt", "sourceAttemptStartedAt", "finishedAt",
    "version", "createdAt", "updatedAt",
  ];
  try {
    if (!(await hasTable(db, table))) {
      missing.push(table);
    } else {
      const present = await columns(db, table);
      for (const column of requiredColumns) {
        if (!present.has(column)) missing.push(`${table}.${column}`);
      }
    }
  } catch {
    missing.push(table);
  }
  for (const trigger of [
    "DonorHarvestState_complete_insert_guard",
    "DonorHarvestState_complete_update_guard",
  ]) {
    try {
      if (!(await hasTrigger(db, trigger))) missing.push(`trigger:${trigger}`);
    } catch {
      missing.push(`trigger:${trigger}`);
    }
  }
  for (const index of [
    "DonorHarvestState_identity_key",
    "DonorHarvestState_claimable_idx",
    "DonorHarvestState_expired_lease_idx",
    "DonorHarvestState_runId_idx",
  ]) {
    try {
      if (!(await hasIndex(db, index))) missing.push(`index:${index}`);
    } catch {
      missing.push(`index:${index}`);
    }
  }
  try {
    if (!(await hasForeignKey(
      db,
      table,
      "donorProductId",
      "DonorProduct",
      "id",
      { onDelete: "RESTRICT", onUpdate: "CASCADE" },
    ))) {
      missing.push("foreign-key:DonorHarvestState.donorProductId->DonorProduct.id");
    }
  } catch {
    missing.push("foreign-key:DonorHarvestState.donorProductId->DonorProduct.id");
  }
  if (missing.length) throw new ProductTruthSchemaNotReadyError([...new Set(missing)]);
}

/** Fail closed before any canonical listing-scoped cost read or write. */
export async function assertProductTruthListingScopeSchema(db: Client): Promise<void> {
  const missing: string[] = [];
  const requiredTables: Record<string, readonly string[]> = {
    ProductTruthListingScope: [
      "listingKey", "keyVersion", "channel", "storeIndex", "sku",
      "registrationKind", "manifestSchemaVersion", "manifestSha256",
      "manifestAsOf", "ownerDecisionId", "sourceReportId",
      "sourceContentSha256", "sourceCapturedAt", "createdAt",
    ],
    SkuCostListingScopeLink: [
      "skuCostId", "listingKey", "linkVersion", "createdAt",
    ],
  };
  for (const [table, requiredColumns] of Object.entries(requiredTables)) {
    try {
      if (!(await hasTable(db, table))) {
        missing.push(table);
        continue;
      }
      const present = await columns(db, table);
      for (const column of requiredColumns) {
        if (!present.has(column)) missing.push(`${table}.${column}`);
      }
    } catch {
      missing.push(table);
    }
  }
  for (const trigger of [
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
  ]) {
    try {
      if (!(await hasTrigger(db, trigger))) missing.push(`trigger:${trigger}`);
    } catch {
      missing.push(`trigger:${trigger}`);
    }
  }
  for (const index of [
    "ProductTruthListingScope_channel_store_sku_key",
    "ProductTruthListingScope_manifest_idx",
    "SkuCostListingScopeLink_listing_cost_idx",
  ]) {
    try {
      if (!(await hasIndex(db, index))) missing.push(`index:${index}`);
    } catch {
      missing.push(`index:${index}`);
    }
  }
  try {
    if (!(await hasForeignKey(db, "SkuCostListingScopeLink", "skuCostId", "SkuCost"))) {
      missing.push("foreign-key:SkuCostListingScopeLink.skuCostId->SkuCost.id");
    }
    if (!(await hasForeignKey(
      db,
      "SkuCostListingScopeLink",
      "listingKey",
      "ProductTruthListingScope",
      "listingKey",
    ))) {
      missing.push(
        "foreign-key:SkuCostListingScopeLink.listingKey->ProductTruthListingScope.listingKey",
      );
    }
  } catch {
    missing.push("foreign-key:SkuCostListingScopeLink");
  }
  if (missing.length) throw new ProductTruthSchemaNotReadyError([...new Set(missing)]);
}

/**
 * Paid search/detail paths additionally require the post-ledger link guards.
 * Keeping this separate lets read-only/offline canonical consumers use the
 * evidence schema without pretending that paid writes are enabled.
 */
export async function assertProductTruthMeteredEvidenceSchema(db: Client): Promise<void> {
  const missing: string[] = [];
  const requiredTables: Record<string, readonly string[]> = {
    MeteredProviderBudget: [
      "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
      "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros",
      "reservedCalls", "reservedUnitsMicros", "createdAt", "updatedAt",
    ],
    MeteredReservationReceipt: [
      "id", "budgetId", "reservationKey", "operation", "unitsMicros", "status",
      "failureCode", "createdAt", "reservedAt", "settledAt", "updatedAt",
    ],
    MeteredReservationSettlement: [
      "id", "reservationId", "outcome", "detail", "settledAt",
    ],
  };
  for (const [table, requiredColumns] of Object.entries(requiredTables)) {
    try {
      if (!(await hasTable(db, table))) {
        missing.push(table);
        continue;
      }
      const present = await columns(db, table);
      for (const column of requiredColumns) {
        if (!present.has(column)) missing.push(`${table}.${column}`);
      }
    } catch {
      missing.push(table);
    }
  }
  for (const trigger of [
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
    "DonorOfferObservation_metered_receipt_guard",
    "ProductContentObservation_metered_receipt_guard",
  ]) {
    try {
      if (!(await hasTrigger(db, trigger))) missing.push(`trigger:${trigger}`);
    } catch {
      missing.push(`trigger:${trigger}`);
    }
  }
  for (const index of [
    "MeteredProviderBudget_run_provider_key",
    "MeteredProviderBudget_approval_idx",
    "MeteredReservationReceipt_budget_key",
    "MeteredReservationReceipt_budget_status_idx",
    "MeteredReservationSettlement_reservation_key",
  ]) {
    try {
      if (!(await hasIndex(db, index))) missing.push(`index:${index}`);
    } catch {
      missing.push(`index:${index}`);
    }
  }
  for (const [table, from, referencedTable] of [
    ["MeteredReservationReceipt", "budgetId", "MeteredProviderBudget"],
    ["MeteredReservationSettlement", "reservationId", "MeteredReservationReceipt"],
  ] as const) {
    try {
      if (!(await hasForeignKey(db, table, from, referencedTable))) {
        missing.push(`foreign-key:${table}.${from}->${referencedTable}.id`);
      }
    } catch {
      missing.push(`foreign-key:${table}.${from}->${referencedTable}.id`);
    }
  }
  if (missing.length) throw new ProductTruthSchemaNotReadyError([...new Set(missing)]);
}
