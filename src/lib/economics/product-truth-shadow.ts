import type { Client, Row, Transaction } from "@libsql/client";

import {
  selectCurrentCogsRows,
  type CogsResult,
  type CogsSourceRow,
} from "./cogs-selection";
import {
  readProductTruthConsumerBatch,
  type ProductTruthConsumerGatewayReport,
  type ProductTruthConsumerManifestScopePage,
} from "../sourcing/product-truth-consumer-gateway";
import type { ValidatedProductTruthConsumerActivation } from
  "../sourcing/product-truth-consumer-activation";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../sourcing/product-truth-operational-run-contract";

export const PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_REPORT_VERSION =
  "product-truth-unit-economics-shadow-report/1.0.0" as const;

export type ProductTruthUnitEconomicsShadowMismatch =
  | "LEGACY_SCOPE_OMITTED"
  | "LEGACY_SCOPE_UNPROVEN"
  | "LEGACY_CROSS_SCOPE_COST"
  | "LEGACY_UNTYPED"
  | "STATUS_MISMATCH"
  | "COST_VALUE_MISMATCH"
  | "CANONICAL_BLOCKED"
  | "CANONICAL_COST_BASIS_UNSEPARATED"
  | "MATCH";

export interface ProductTruthUnitEconomicsShadowEntry {
  ordinal: number;
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  legacy: {
    includedInEconomicsUniverse: boolean;
    skuCostId: string | null;
    linkedListingKey: string | null;
    outcome: CogsResult["outcome"];
    cost: number | null;
    source: string | null;
    effectiveDate: string | null;
  };
  productTruth: {
    status: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "INVALID" | "MISSING";
    skuCostId: string | null;
    productCost: number | null;
    totalCost: number | null;
    source: string | null;
    effectiveDate: string | null;
    blockers: string[];
  };
  mismatchClasses: ProductTruthUnitEconomicsShadowMismatch[];
}

export interface ProductTruthUnitEconomicsShadowReport {
  schemaVersion: typeof PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_REPORT_VERSION;
  mode: "SHADOW_COMPARE_ONLY";
  outputUse: "DIAGNOSTIC_ONLY_LEGACY_UNCHANGED";
  activationSha256: string;
  ownerApprovalId: string;
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
  readAt: string;
  asOf: string;
  page: {
    manifestInventory: ProductTruthConsumerManifestScopePage["manifestInventory"];
    channel: "amazon" | "walmart";
    storeIndex: number;
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
  };
  counts: {
    total: number;
    match: number;
    mismatch: number;
    legacyScopeOmitted: number;
    legacyScopeUnproven: number;
    legacyCrossScopeCost: number;
    legacyUntyped: number;
    statusMismatch: number;
    costValueMismatch: number;
    canonicalBlocked: number;
    canonicalCostBasisUnseparated: number;
    fact: number;
    estimate: number;
    unsourceable: number;
    invalid: number;
    missing: number;
  };
  entries: ProductTruthUnitEconomicsShadowEntry[];
  claims: {
    businessOutputChanged: false;
    productTruthUsedAsAuthority: false;
    databaseWrites: false;
    providerCalls: false;
    paidCalls: false;
    marketplaceMutations: false;
    procurementMutations: false;
  };
  payloadSha256: string;
}

export class ProductTruthUnitEconomicsShadowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthUnitEconomicsShadowError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthUnitEconomicsShadowError(code, message);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Legacy raw-SKU COGS read, pinned to the caller's target, transaction and as-of. */
export async function readLegacyCogsForProductTruthShadow(
  tx: Transaction,
  input: { skus: readonly string[]; asOf: string },
): Promise<Map<string, CogsResult>> {
  if (!input.skus.length) return new Map();
  const result = await tx.execute({
    sql: `SELECT id,sku,totalCost,costPerUnit,packSize,includesPackaging,source,
                 effectiveDate,evidenceOutcome,needsReview
          FROM SkuCost
          WHERE sku IN (${placeholders(input.skus.length)})
            AND julianday(createdAt)<=julianday(?)
            AND julianday(updatedAt)<=julianday(?)
            AND (effectiveDate IS NULL OR julianday(effectiveDate)<=julianday(?))
          ORDER BY sku ASC,
                   julianday(effectiveDate) DESC,effectiveDate DESC,
                   julianday(updatedAt) DESC,updatedAt DESC,
                   julianday(createdAt) DESC,createdAt DESC,id DESC`,
    args: [...input.skus, input.asOf, input.asOf, input.asOf],
  });
  const rows: CogsSourceRow[] = result.rows.map((row: Row) => ({
    id: nullableText(row.id),
    sku: String(row.sku),
    totalCost: nullableNumber(row.totalCost),
    costPerUnit: nullableNumber(row.costPerUnit),
    packSize: nullableNumber(row.packSize),
    includesPackaging: Number(row.includesPackaging) === 1,
    source: String(row.source),
    effectiveDate: nullableText(row.effectiveDate),
    evidenceOutcome: nullableText(row.evidenceOutcome),
    needsReview: Number(row.needsReview) === 1,
  }));
  return selectCurrentCogsRows(input.skus, rows, new Date(input.asOf));
}

/** Exact legacy price-cache universe from the same read transaction and as-of. */
export async function readLegacyIncludedListingKeysForProductTruthShadow(
  tx: Transaction,
  input: {
    channel: "amazon" | "walmart";
    storeIndex: number;
    scopes: readonly { listingKey: string; sku: string }[];
    asOf: string;
  },
): Promise<Set<string>> {
  if (!input.scopes.length) return new Set();
  const skus = input.scopes.map((scope) => scope.sku);
  const result = input.channel === "amazon"
    ? await tx.execute({
      sql: `SELECT DISTINCT sku
            FROM AmazonListingSnapshot
            WHERE storeIndex=? AND sku IN (${placeholders(skus.length)})
              AND price IS NOT NULL
              AND julianday(capturedAt)<=julianday(?)`,
      args: [input.storeIndex, ...skus, input.asOf],
    })
    : await tx.execute({
      sql: `SELECT sku
            FROM WalmartBuyBoxItem
            WHERE storeIndex=? AND sku IN (${placeholders(skus.length)})
              AND sellerItemPrice IS NOT NULL
              AND julianday(capturedAt)<=julianday(?)
              AND julianday(syncedAt)<=julianday(?)`,
      args: [input.storeIndex, ...skus, input.asOf, input.asOf],
    });
  const included = new Set(result.rows.map((row) => String(row.sku)));
  return new Set(
    input.scopes
      .filter((scope) => included.has(scope.sku))
      .map((scope) => scope.listingKey),
  );
}

function cents(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0
    ? Math.round(value * 100)
    : null;
}

function legacyExpectedStatus(
  outcome: CogsResult["outcome"],
): "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "MISSING" | null {
  if (outcome === "FACT" || outcome === "ESTIMATE" || outcome === "UNSOURCEABLE") {
    return outcome;
  }
  if (outcome === "MISSING") return "MISSING";
  return null;
}

function mismatchClasses(input: {
  listingKey: string;
  legacy: CogsResult;
  legacyIncluded: boolean;
  linkedListingKey: string | null;
  productTruth: ProductTruthUnitEconomicsShadowEntry["productTruth"];
}): ProductTruthUnitEconomicsShadowMismatch[] {
  const mismatches: ProductTruthUnitEconomicsShadowMismatch[] = [];
  if (!input.legacyIncluded) mismatches.push("LEGACY_SCOPE_OMITTED");
  if (input.legacy.skuCostId && !input.linkedListingKey) {
    mismatches.push("LEGACY_SCOPE_UNPROVEN");
  }
  if (input.linkedListingKey && input.linkedListingKey !== input.listingKey) {
    mismatches.push("LEGACY_CROSS_SCOPE_COST");
  }
  if (input.legacy.outcome === "UNKNOWN") mismatches.push("LEGACY_UNTYPED");

  const canonicalReady = input.productTruth.status === "FACT"
    || input.productTruth.status === "ESTIMATE";
  const canonicalProductCents = cents(input.productTruth.productCost);
  if (canonicalReady && canonicalProductCents === null) {
    mismatches.push("CANONICAL_BLOCKED");
    if (cents(input.productTruth.totalCost) !== null) {
      mismatches.push("CANONICAL_COST_BASIS_UNSEPARATED");
    }
  } else if (!canonicalReady) {
    mismatches.push("CANONICAL_BLOCKED");
  }

  const expectedStatus = legacyExpectedStatus(input.legacy.outcome);
  if (expectedStatus === null || expectedStatus !== input.productTruth.status) {
    mismatches.push("STATUS_MISMATCH");
  }
  const legacyCents = cents(input.legacy.cost);
  if (
    canonicalReady
    && canonicalProductCents !== null
    && legacyCents !== canonicalProductCents
  ) {
    mismatches.push("COST_VALUE_MISMATCH");
  }

  const result = unique(mismatches) as ProductTruthUnitEconomicsShadowMismatch[];
  return result.length ? result : ["MATCH"];
}

function assertBindings(input: {
  page: ProductTruthConsumerManifestScopePage;
  gateway: ProductTruthConsumerGatewayReport;
}): void {
  if (
    input.gateway.consumer !== "UNIT_ECONOMICS"
    || input.gateway.mode !== "SHADOW"
    || input.gateway.outputUse !== "COMPARE_ONLY"
    || input.gateway.authoritativeManifestSha256
      !== input.page.authoritativeManifestSha256
    || input.gateway.entries.length !== input.page.scopes.length
  ) {
    fail(
      "UNIT_ECONOMICS_SHADOW_BINDING_INVALID",
      "gateway output is not the exact Unit Economics SHADOW page",
    );
  }
  input.page.scopes.forEach((scope, ordinal) => {
    const gateway = input.gateway.entries[ordinal];
    if (
      gateway?.listingKey !== scope.listingKey
      || gateway.channel !== scope.channel
      || gateway.storeIndex !== scope.storeIndex
      || gateway.sku !== scope.sku
    ) {
      fail(
        "UNIT_ECONOMICS_SHADOW_BINDING_INVALID",
        `gateway entry ${ordinal} differs from the manifest page`,
      );
    }
  });
}

export function compileProductTruthUnitEconomicsShadowReport(input: {
  page: ProductTruthConsumerManifestScopePage;
  gateway: ProductTruthConsumerGatewayReport;
  legacyBySku: ReadonlyMap<string, CogsResult>;
  legacyIncludedListingKeys: ReadonlySet<string>;
  legacyCostListingKeys: ReadonlyMap<string, string>;
}): ProductTruthUnitEconomicsShadowReport {
  assertBindings(input);
  const entries = input.page.scopes.map((scope, ordinal) => {
    const legacy = input.legacyBySku.get(scope.sku);
    if (!legacy) {
      fail(
        "UNIT_ECONOMICS_SHADOW_LEGACY_INPUT_MISSING",
        `legacy COGS result is missing for ${scope.listingKey}`,
      );
    }
    const view = input.gateway.entries[ordinal].view;
    if (view.consumer !== "UNIT_ECONOMICS") {
      fail(
        "UNIT_ECONOMICS_SHADOW_BINDING_INVALID",
        `gateway entry ${ordinal} is not a Unit Economics view`,
      );
    }
    const current = view.current;
    const linkedListingKey = legacy.skuCostId
      ? input.legacyCostListingKeys.get(legacy.skuCostId) ?? null
      : null;
    const productTruth = {
      status: view.status,
      skuCostId: current?.id ?? null,
      productCost: current?.productCost ?? null,
      totalCost: current?.totalCost ?? null,
      source: current?.source ?? null,
      effectiveDate: current?.effectiveDate ?? null,
      blockers: unique(view.blockers),
    };
    return {
      ordinal,
      listingKey: scope.listingKey,
      channel: scope.channel as "amazon" | "walmart",
      storeIndex: scope.storeIndex,
      sku: scope.sku,
      legacy: {
        includedInEconomicsUniverse:
          input.legacyIncludedListingKeys.has(scope.listingKey),
        skuCostId: legacy.skuCostId,
        linkedListingKey,
        outcome: legacy.outcome,
        cost: legacy.cost,
        source: legacy.source,
        effectiveDate: legacy.effectiveDate,
      },
      productTruth,
      mismatchClasses: mismatchClasses({
        listingKey: scope.listingKey,
        legacy,
        legacyIncluded: input.legacyIncludedListingKeys.has(scope.listingKey),
        linkedListingKey,
        productTruth,
      }),
    } satisfies ProductTruthUnitEconomicsShadowEntry;
  });
  const has = (entry: ProductTruthUnitEconomicsShadowEntry,
    mismatch: ProductTruthUnitEconomicsShadowMismatch) =>
    entry.mismatchClasses.includes(mismatch);
  const statuses = entries.map((entry) => entry.productTruth.status);
  const payload = {
    schemaVersion: PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_REPORT_VERSION,
    mode: "SHADOW_COMPARE_ONLY" as const,
    outputUse: "DIAGNOSTIC_ONLY_LEGACY_UNCHANGED" as const,
    activationSha256: input.gateway.activationSha256,
    ownerApprovalId: input.gateway.ownerApprovalId,
    authoritativeManifestSha256: input.gateway.authoritativeManifestSha256,
    databaseTargetFingerprint: input.gateway.databaseTargetFingerprint,
    readAt: input.gateway.readAt,
    asOf: input.gateway.asOf,
    page: {
      manifestInventory: input.page.manifestInventory,
      channel: input.page.channel,
      storeIndex: input.page.storeIndex,
      limit: input.page.limit,
      cursor: input.page.cursor,
      nextCursor: input.page.nextCursor,
    },
    counts: {
      total: entries.length,
      match: entries.filter((entry) => has(entry, "MATCH")).length,
      mismatch: entries.filter((entry) => !has(entry, "MATCH")).length,
      legacyScopeOmitted: entries.filter((entry) => has(entry, "LEGACY_SCOPE_OMITTED")).length,
      legacyScopeUnproven: entries.filter((entry) => has(entry, "LEGACY_SCOPE_UNPROVEN")).length,
      legacyCrossScopeCost: entries.filter((entry) => has(entry, "LEGACY_CROSS_SCOPE_COST")).length,
      legacyUntyped: entries.filter((entry) => has(entry, "LEGACY_UNTYPED")).length,
      statusMismatch: entries.filter((entry) => has(entry, "STATUS_MISMATCH")).length,
      costValueMismatch: entries.filter((entry) => has(entry, "COST_VALUE_MISMATCH")).length,
      canonicalBlocked: entries.filter((entry) => has(entry, "CANONICAL_BLOCKED")).length,
      canonicalCostBasisUnseparated: entries.filter((entry) =>
        has(entry, "CANONICAL_COST_BASIS_UNSEPARATED")).length,
      fact: statuses.filter((status) => status === "FACT").length,
      estimate: statuses.filter((status) => status === "ESTIMATE").length,
      unsourceable: statuses.filter((status) => status === "UNSOURCEABLE").length,
      invalid: statuses.filter((status) => status === "INVALID").length,
      missing: statuses.filter((status) => status === "MISSING").length,
    },
    entries,
    claims: {
      businessOutputChanged: false as const,
      productTruthUsedAsAuthority: false as const,
      databaseWrites: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      marketplaceMutations: false as const,
      procurementMutations: false as const,
    },
  };
  return { ...payload, payloadSha256: productTruthOperationalSha256(payload) };
}

export async function readProductTruthUnitEconomicsShadowReport(
  db: Client,
  input: {
    validatedActivation: ValidatedProductTruthConsumerActivation;
    page: ProductTruthConsumerManifestScopePage;
    legacyBySku: ReadonlyMap<string, CogsResult>;
    legacyIncludedListingKeys: ReadonlySet<string>;
    legacyCostListingKeys: ReadonlyMap<string, string>;
    readAt: string;
    asOf?: string;
    transaction?: Transaction;
  },
): Promise<ProductTruthUnitEconomicsShadowReport> {
  const gateway = await readProductTruthConsumerBatch(db, {
    validatedActivation: input.validatedActivation,
    consumer: "UNIT_ECONOMICS",
    scopes: input.page.scopes,
    readAt: input.readAt,
    asOf: input.asOf ?? input.readAt,
    ...(input.transaction ? { transaction: input.transaction } : {}),
  });
  return compileProductTruthUnitEconomicsShadowReport({
    page: input.page,
    gateway,
    legacyBySku: input.legacyBySku,
    legacyIncludedListingKeys: input.legacyIncludedListingKeys,
    legacyCostListingKeys: input.legacyCostListingKeys,
  });
}

export function renderProductTruthUnitEconomicsShadowReportJson(
  report: ProductTruthUnitEconomicsShadowReport,
): string {
  return renderProductTruthOperationalJson(report);
}
