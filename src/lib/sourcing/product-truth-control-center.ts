import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";

import {
  PRODUCT_TRUTH_MAX_BATCH_SCOPES,
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  readProductTruthSnapshotsInTransaction,
  type ProductTruthReadScope,
  type ProductTruthSnapshot,
} from "./product-truth-read-contract";
import { readProductTruthConsumerManifestScopePage } from
  "./product-truth-consumer-gateway";
import { buildProductTruthListingScope } from "./product-truth-listing-scope";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";
import type { ProductTruthControlCenterRuntimeActive } from
  "./product-truth-control-center-runtime";

export const PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION =
  "product-truth-control-center-api/1.0.0" as const;

export const PRODUCT_TRUTH_LOCALITY_ZIP = "33765" as const;

export const PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS = Object.freeze({
  readOnly: true,
  databaseWrites: false,
  legacyFallback: false,
  providerCalls: false,
  paidCalls: false,
  marketplaceMutations: false,
  procurementMutations: false,
  consumerCutoverClaimed: false,
});

const REQUIRED_TABLES = [
  "CanonicalProductVariant",
  "DonorOfferObservation",
  "EnrichmentJob",
  "MeteredProviderBudget",
  "MeteredReservationReceipt",
  "ProductContentObservation",
  "ProductTruthListingScope",
  "ProductTruthOperationalEvent",
  "ProductTruthOperationalRun",
  "ProductTruthOperationalRunItem",
  "SkuComponentEvidence",
  "SkuCost",
  "SkuCostListingScopeLink",
] as const;

type ProductTruthReadExecutor = Pick<Client | Transaction, "execute">;

export class ProductTruthControlCenterReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthControlCenterReadError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthControlCenterReadError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function canonicalInstant(value: string | Date, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  const milliseconds = Date.parse(raw);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== raw
  ) {
    fail("CONTROL_CENTER_READ_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return raw;
}

function exactLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      "CONTROL_CENTER_READ_INPUT_INVALID",
      `limit must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

function nullableExactText(
  value: string | null | undefined,
  label: string,
  maximum = 1_024,
): string | null {
  if (value == null) return null;
  if (!value || value !== value.trim() || value.length > maximum) {
    fail("CONTROL_CENTER_READ_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} is missing`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", "expected nullable text");
  }
  return value;
}

function number(value: unknown, label: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} is not numeric`);
  }
  return normalized;
}

function integer(value: unknown, label: string): number {
  const normalized = number(value, label);
  if (!Number.isSafeInteger(normalized)) {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} is not an integer`);
  }
  return normalized;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} is not JSON text`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} is invalid JSON`, error);
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("CONTROL_CENTER_READ_RESULT_INVALID", `${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * All Control Center-owned SQL passes this fail-closed lexical gate. Canonical
 * Product Truth readers have their own certified SELECT-only implementation
 * and execute inside the same database-enforced read transaction.
 */
export function assertProductTruthControlCenterReadSql(sql: string): void {
  const normalized = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "")
    .trimStart();
  const first = normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH") {
    fail(
      "CONTROL_CENTER_WRITE_SQL_FORBIDDEN",
      "Control Center projections permit only SELECT or WITH statements",
    );
  }
  if (
    /(?:^|[;\s])(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|VACUUM|ATTACH|DETACH|REINDEX)(?:\s|$)/iu
      .test(normalized)
  ) {
    fail(
      "CONTROL_CENTER_WRITE_SQL_FORBIDDEN",
      "Control Center projections contain a forbidden write or DDL token",
    );
  }
}

async function read(
  executor: ProductTruthReadExecutor,
  statement: { sql: string; args?: InValue[] },
): Promise<ResultSet> {
  assertProductTruthControlCenterReadSql(statement.sql);
  return executor.execute({
    sql: statement.sql,
    args: statement.args ?? [],
  });
}

async function assertControlCenterSchema(db: Client): Promise<void> {
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthListingScopeSchema(db);
  const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
  const result = await read(db, {
    sql: `SELECT name
          FROM sqlite_master
          WHERE type='table' AND name IN (${placeholders})
          ORDER BY name`,
    args: [...REQUIRED_TABLES],
  });
  const actual = new Set(result.rows.map((row) => String(row.name)));
  const missing = REQUIRED_TABLES.filter((name) => !actual.has(name));
  if (missing.length) {
    fail(
      "CONTROL_CENTER_SCHEMA_NOT_READY",
      `required Product Truth tables are missing: ${missing.join(", ")}`,
    );
  }
}

export interface ProductTruthControlCenterOverview {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION;
  view: "OVERVIEW";
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  readAt: string;
  databaseTargetFingerprint: string;
  authoritativeManifestSha256: string;
  locality: { zip: typeof PRODUCT_TRUTH_LOCALITY_ZIP };
  scope: {
    denominator: number;
    partitions: Array<{
      channel: "amazon" | "walmart";
      storeIndex: number;
      count: number;
    }>;
  };
  readiness: {
    bundleFactory: { ready: number; blocked: number };
    listingImprovement: { ready: number; blocked: number };
    unitEconomics: {
      ready: number;
      blocked: number;
      fact: number;
      estimate: number;
      unsourceable: number;
      missing: number;
      invalid: number;
    };
    procurement: { ready: number; blocked: number };
  };
  catalog: {
    canonicalVariants: number;
    variantsWithExactContent: number;
    contentObservations: number;
    offerObservations: number;
    firstPartyOfferObservations: number;
    localOfferObservations: number;
  };
  operations: {
    runs: number;
    activeRuns: number;
    blockedRuns: number;
    operationalQueueJobs: number;
    activeQueueJobs: number;
    reservedCalls: number;
    reservedUnits: number;
  };
  claims: typeof PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS;
}

type ReadinessSummary = ProductTruthControlCenterOverview["readiness"];

export function summarizeProductTruthSnapshots(
  snapshots: readonly ProductTruthSnapshot[],
): ReadinessSummary {
  const bundleReady = snapshots.filter(
    (snapshot) => snapshot.views.bundleFactory.ready,
  ).length;
  const listingReady = snapshots.filter(
    (snapshot) => snapshot.views.listingImprovement.ready,
  ).length;
  const procurementReady = snapshots.filter(
    (snapshot) => snapshot.views.procurement.ready,
  ).length;
  const statuses = snapshots.map((snapshot) => snapshot.views.unitEconomics.status);
  const fact = statuses.filter((status) => status === "FACT").length;
  const estimate = statuses.filter((status) => status === "ESTIMATE").length;
  const unsourceable = statuses.filter((status) => status === "UNSOURCEABLE").length;
  const missing = statuses.filter((status) => status === "MISSING").length;
  const invalid = statuses.filter((status) => status === "INVALID").length;
  const denominator = snapshots.length;
  return {
    bundleFactory: {
      ready: bundleReady,
      blocked: denominator - bundleReady,
    },
    listingImprovement: {
      ready: listingReady,
      blocked: denominator - listingReady,
    },
    unitEconomics: {
      ready: fact + estimate,
      blocked: denominator - fact - estimate,
      fact,
      estimate,
      unsourceable,
      missing,
      invalid,
    },
    procurement: {
      ready: procurementReady,
      blocked: denominator - procurementReady,
    },
  };
}

function scopeFromRow(
  row: Record<string, unknown>,
  manifestSha256: string,
): ProductTruthReadScope & { listingKey: string } {
  const exact = buildProductTruthListingScope({
    channel: text(row.channel, "scope.channel"),
    storeIndex: integer(row.storeIndex, "scope.storeIndex"),
    sku: text(row.sku, "scope.sku"),
  });
  if (
    exact.listingKey !== row.listingKey
    || exact.keyVersion !== row.keyVersion
    || row.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST"
    || row.manifestSchemaVersion !== "phase1-authoritative-scope-manifest/v3"
    || row.manifestSha256 !== manifestSha256
    || (exact.channel !== "amazon" && exact.channel !== "walmart")
  ) {
    fail(
      "CONTROL_CENTER_SCOPE_BINDING_INVALID",
      `listing scope ${String(row.listingKey)} contradicts the immutable manifest binding`,
    );
  }
  return {
    listingKey: exact.listingKey,
    channel: exact.channel,
    storeIndex: exact.storeIndex,
    sku: exact.sku,
  };
}

async function readAllManifestScopes(
  tx: Transaction,
  manifestSha256: string,
): Promise<Array<ProductTruthReadScope & { listingKey: string }>> {
  const result = await read(tx, {
    sql: `SELECT listingKey,keyVersion,channel,storeIndex,sku,
                 registrationKind,manifestSchemaVersion,manifestSha256
          FROM ProductTruthListingScope
          WHERE manifestSha256=?
          ORDER BY channel ASC,storeIndex ASC,listingKey ASC`,
    args: [manifestSha256],
  });
  if (result.rows.length === 0) {
    fail(
      "CONTROL_CENTER_MANIFEST_NOT_REGISTERED",
      "the configured authoritative manifest has no immutable listing scopes",
    );
  }
  return result.rows.map((row) =>
    scopeFromRow(row as Record<string, unknown>, manifestSha256));
}

async function readAllSnapshots(
  tx: Transaction,
  input: {
    scopes: readonly ProductTruthReadScope[];
    manifestSha256: string;
    asOf: string;
    maxPriceAgeMs: number;
  },
): Promise<ProductTruthSnapshot[]> {
  const snapshots: ProductTruthSnapshot[] = [];
  for (
    let index = 0;
    index < input.scopes.length;
    index += PRODUCT_TRUTH_MAX_BATCH_SCOPES
  ) {
    snapshots.push(...await readProductTruthSnapshotsInTransaction(tx, {
      scopes: input.scopes.slice(index, index + PRODUCT_TRUTH_MAX_BATCH_SCOPES),
      expectedManifestSha256: input.manifestSha256,
      asOf: input.asOf,
      maxPriceAgeMs: input.maxPriceAgeMs,
    }));
  }
  return snapshots;
}

async function readCatalogInventory(tx: Transaction) {
  const result = await read(tx, {
    sql: `SELECT
            (SELECT COUNT(*) FROM CanonicalProductVariant) AS canonicalVariants,
            (SELECT COUNT(DISTINCT canonicalVariantId)
             FROM ProductContentObservation) AS variantsWithExactContent,
            (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations,
            (SELECT COUNT(*) FROM DonorOfferObservation
             WHERE canonicalVariantId IS NOT NULL) AS offerObservations,
            (SELECT COUNT(*) FROM DonorOfferObservation
             WHERE canonicalVariantId IS NOT NULL AND isFirstParty=1)
              AS firstPartyOfferObservations,
            (SELECT COUNT(*) FROM DonorOfferObservation
             WHERE canonicalVariantId IS NOT NULL
               AND (zip=? OR localityEvidence='store_scoped'))
              AS localOfferObservations`,
    args: [PRODUCT_TRUTH_LOCALITY_ZIP],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) fail("CONTROL_CENTER_READ_RESULT_INVALID", "catalog inventory is empty");
  return {
    canonicalVariants: integer(row.canonicalVariants, "catalog.canonicalVariants"),
    variantsWithExactContent: integer(
      row.variantsWithExactContent,
      "catalog.variantsWithExactContent",
    ),
    contentObservations: integer(
      row.contentObservations,
      "catalog.contentObservations",
    ),
    offerObservations: integer(row.offerObservations, "catalog.offerObservations"),
    firstPartyOfferObservations: integer(
      row.firstPartyOfferObservations,
      "catalog.firstPartyOfferObservations",
    ),
    localOfferObservations: integer(
      row.localOfferObservations,
      "catalog.localOfferObservations",
    ),
  };
}

async function readOperationsInventory(tx: Transaction) {
  const result = await read(tx, {
    sql: `SELECT
            (SELECT COUNT(*) FROM ProductTruthOperationalRun) AS runs,
            (SELECT COUNT(*) FROM ProductTruthOperationalRun
             WHERE status='running') AS activeRuns,
            (SELECT COUNT(*) FROM ProductTruthOperationalRun
             WHERE status IN ('blocked','ambiguous','failed')) AS blockedRuns,
            (SELECT COUNT(*) FROM EnrichmentJob
             WHERE listingKey IS NOT NULL AND runId IS NOT NULL
               AND approvalId IS NOT NULL) AS operationalQueueJobs,
            (SELECT COUNT(*) FROM EnrichmentJob
             WHERE listingKey IS NOT NULL AND runId IS NOT NULL
               AND approvalId IS NOT NULL
               AND status IN ('queued','running','retry_wait')) AS activeQueueJobs,
            (SELECT COALESCE(SUM(reservedCalls),0)
             FROM MeteredProviderBudget) AS reservedCalls,
            (SELECT COALESCE(SUM(reservedUnitsMicros),0)
             FROM MeteredProviderBudget) AS reservedUnitsMicros`,
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) fail("CONTROL_CENTER_READ_RESULT_INVALID", "operations inventory is empty");
  return {
    runs: integer(row.runs, "operations.runs"),
    activeRuns: integer(row.activeRuns, "operations.activeRuns"),
    blockedRuns: integer(row.blockedRuns, "operations.blockedRuns"),
    operationalQueueJobs: integer(
      row.operationalQueueJobs,
      "operations.operationalQueueJobs",
    ),
    activeQueueJobs: integer(row.activeQueueJobs, "operations.activeQueueJobs"),
    reservedCalls: integer(row.reservedCalls, "operations.reservedCalls"),
    reservedUnits:
      integer(row.reservedUnitsMicros, "operations.reservedUnitsMicros") / 1_000_000,
  };
}

export async function readProductTruthControlCenterOverview(
  db: Client,
  input: {
    runtime: ProductTruthControlCenterRuntimeActive;
    readAt: string | Date;
  },
): Promise<ProductTruthControlCenterOverview> {
  const readAt = canonicalInstant(input.readAt, "readAt");
  await assertControlCenterSchema(db);
  const tx = await db.transaction("read");
  try {
    const scopes = await readAllManifestScopes(
      tx,
      input.runtime.authoritativeManifestSha256,
    );
    const snapshots = await readAllSnapshots(tx, {
      scopes,
      manifestSha256: input.runtime.authoritativeManifestSha256,
      asOf: readAt,
      maxPriceAgeMs: input.runtime.maxPriceAgeMs,
    });
    const partitionCounts = new Map<string, {
      channel: "amazon" | "walmart";
      storeIndex: number;
      count: number;
    }>();
    for (const scope of scopes) {
      const channel = scope.channel as "amazon" | "walmart";
      const key = `${channel}:${scope.storeIndex}`;
      const current = partitionCounts.get(key) ?? {
        channel,
        storeIndex: scope.storeIndex,
        count: 0,
      };
      current.count += 1;
      partitionCounts.set(key, current);
    }
    const catalog = await readCatalogInventory(tx);
    const operations = await readOperationsInventory(tx);
    return {
      schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION,
      view: "OVERVIEW",
      readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
      readAt,
      databaseTargetFingerprint: input.runtime.database.target.fingerprint,
      authoritativeManifestSha256:
        input.runtime.authoritativeManifestSha256,
      locality: { zip: PRODUCT_TRUTH_LOCALITY_ZIP },
      scope: {
        denominator: scopes.length,
        partitions: [...partitionCounts.values()],
      },
      readiness: summarizeProductTruthSnapshots(snapshots),
      catalog,
      operations,
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    };
  } finally {
    tx.close();
  }
}

export interface ProductTruthControlCenterListings {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION;
  view: "LISTINGS";
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  readAt: string;
  databaseTargetFingerprint: string;
  page: {
    channel: "amazon" | "walmart";
    storeIndex: number;
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
    manifestInventory: {
      scopeCount: number;
      partitions: Array<{
        channel: "amazon" | "walmart";
        storeIndex: number;
        scopeCount: number;
      }>;
    };
  };
  snapshots: ProductTruthSnapshot[];
  claims: typeof PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS;
}

export async function readProductTruthControlCenterListings(
  db: Client,
  input: {
    runtime: ProductTruthControlCenterRuntimeActive;
    readAt: string | Date;
    channel: string;
    storeIndex: number;
    cursor?: string | null;
    limit: number;
  },
): Promise<ProductTruthControlCenterListings> {
  const readAt = canonicalInstant(input.readAt, "readAt");
  const limit = exactLimit(input.limit, 50);
  await assertControlCenterSchema(db);
  const tx = await db.transaction("read");
  try {
    const page = await readProductTruthConsumerManifestScopePage(tx, {
      authoritativeManifestSha256:
        input.runtime.authoritativeManifestSha256,
      channel: input.channel,
      storeIndex: input.storeIndex,
      cursor: input.cursor ?? null,
      limit,
      maximumPageSize: 50,
    });
    const snapshots = page.scopes.length
      ? await readProductTruthSnapshotsInTransaction(tx, {
        scopes: page.scopes,
        expectedManifestSha256:
          input.runtime.authoritativeManifestSha256,
        asOf: readAt,
        maxPriceAgeMs: input.runtime.maxPriceAgeMs,
      })
      : [];
    return {
      schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION,
      view: "LISTINGS",
      readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
      readAt,
      databaseTargetFingerprint: input.runtime.database.target.fingerprint,
      page: {
        channel: page.channel,
        storeIndex: page.storeIndex,
        limit: page.limit,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        manifestInventory: page.manifestInventory,
      },
      snapshots,
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    };
  } finally {
    tx.close();
  }
}

export interface ProductTruthControlCenterVariant {
  canonicalVariantId: string;
  variantKey: string;
  identityHash: string;
  keyVersion: string;
  brand: string;
  productLine: string | null;
  flavor: string | null;
  modifiers: unknown[];
  form: string | null;
  size: {
    dimension: string;
    amount: number;
    unit: string;
    outerPackCount: number;
  };
  identity: unknown;
  sourceCount: number;
  contentObservationCount: number;
  latestContent: null | {
    observationId: string;
    donorProductId: string;
    sourceUrl: string;
    sourceApi: string;
    observedAt: string;
    contentHash: string;
    facts: unknown;
    runId: string | null;
    approvalId: string | null;
    meteredReceiptId: string | null;
  };
  offers: Array<{
    observationId: string;
    retailer: string;
    retailerProductId: string;
    title: string | null;
    price: number | null;
    pricePerUnit: number | null;
    packSizeSeen: number | null;
    currency: string;
    zip: string | null;
    localityEvidence: string | null;
    inStock: boolean | null;
    productUrl: string | null;
    sellerName: string | null;
    isFirstParty: boolean;
    sourceApi: string | null;
    observedAt: string;
    runId: string | null;
    approvalId: string | null;
    meteredReceiptId: string | null;
  }>;
}

export interface ProductTruthControlCenterVariants {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION;
  view: "VARIANTS";
  readAt: string;
  databaseTargetFingerprint: string;
  query: string | null;
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
  variants: ProductTruthControlCenterVariant[];
  claims: typeof PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  if (value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  fail("CONTROL_CENTER_READ_RESULT_INVALID", "expected nullable boolean");
}

export async function readProductTruthControlCenterVariants(
  db: Client,
  input: {
    runtime: ProductTruthControlCenterRuntimeActive;
    readAt: string | Date;
    query?: string | null;
    cursor?: string | null;
    limit: number;
  },
): Promise<ProductTruthControlCenterVariants> {
  const readAt = canonicalInstant(input.readAt, "readAt");
  const limit = exactLimit(input.limit, 50);
  const cursor = nullableExactText(input.cursor, "cursor");
  const query = nullableExactText(input.query, "query", 200);
  await assertControlCenterSchema(db);
  const tx = await db.transaction("read");
  try {
    const filters = ["variant.variantKey > ?"];
    const filterArgs: InValue[] = [cursor ?? ""];
    if (query) {
      filters.push(`(
        variant.normalizedBrand LIKE ? ESCAPE '\\'
        OR COALESCE(variant.normalizedProductLine,'') LIKE ? ESCAPE '\\'
        OR COALESCE(variant.normalizedFlavor,'') LIKE ? ESCAPE '\\'
        OR variant.variantKey=?
      )`);
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      filterArgs.push(pattern, pattern, pattern, query);
    }
    const variantsResult = await read(tx, {
      sql: `SELECT
              variant.*,
              (SELECT COUNT(DISTINCT decision.donorProductId)
               FROM DonorProductVariantDecision decision
               WHERE decision.canonicalVariantId=variant.id
                 AND decision.decisionStatus='exact_confirmed') AS sourceCount,
              (SELECT COUNT(*)
               FROM ProductContentObservation observation
               WHERE observation.canonicalVariantId=variant.id
                 AND observation.observedAt<=?) AS contentObservationCount,
              content.id AS contentId,
              content.donorProductId AS contentDonorProductId,
              content.sourceUrl AS contentSourceUrl,
              content.sourceApi AS contentSourceApi,
              content.observedAt AS contentObservedAt,
              content.contentHash AS contentHash,
              content.contentJson AS contentJson,
              content.runId AS contentRunId,
              content.approvalId AS contentApprovalId,
              content.meteredReceiptId AS contentMeteredReceiptId
            FROM CanonicalProductVariant variant
            LEFT JOIN ProductContentObservation content
              ON content.id=(
                SELECT candidate.id
                FROM ProductContentObservation candidate
                WHERE candidate.canonicalVariantId=variant.id
                  AND candidate.observedAt<=?
                ORDER BY candidate.observedAt DESC,candidate.id DESC
                LIMIT 1
              )
            WHERE ${filters.join(" AND ")}
            ORDER BY variant.variantKey ASC
            LIMIT ?`,
      args: [readAt, readAt, ...filterArgs, limit + 1],
    });
    const hasMore = variantsResult.rows.length > limit;
    const variantRows = variantsResult.rows.slice(0, limit);
    const variantIds = variantRows.map((row) => String(row.id));
    const offersByVariant = new Map<
      string,
      ProductTruthControlCenterVariant["offers"]
    >();
    if (variantIds.length) {
      const placeholders = variantIds.map(() => "?").join(",");
      const offers = await read(tx, {
        sql: `WITH ranked AS (
                SELECT observation.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY observation.canonicalVariantId,
                                      observation.retailer,
                                      observation.retailerProductId
                         ORDER BY observation.observedAt DESC,
                                  observation.id DESC
                       ) AS observationRank
                FROM DonorOfferObservation observation
                WHERE observation.canonicalVariantId IN (${placeholders})
                  AND observation.observedAt<=?
              )
              SELECT * FROM ranked
              WHERE observationRank=1
              ORDER BY canonicalVariantId ASC,retailer ASC,retailerProductId ASC`,
        args: [...variantIds, readAt],
      });
      for (const raw of offers.rows) {
        const row = raw as Record<string, unknown>;
        const canonicalVariantId = text(
          row.canonicalVariantId,
          "offer.canonicalVariantId",
        );
        const values = offersByVariant.get(canonicalVariantId) ?? [];
        values.push({
          observationId: text(row.id, "offer.id"),
          retailer: text(row.retailer, "offer.retailer"),
          retailerProductId: text(
            row.retailerProductId,
            "offer.retailerProductId",
          ),
          title: nullableText(row.title),
          price: row.price == null ? null : number(row.price, "offer.price"),
          pricePerUnit: row.pricePerUnit == null
            ? null
            : number(row.pricePerUnit, "offer.pricePerUnit"),
          packSizeSeen: row.packSizeSeen == null
            ? null
            : integer(row.packSizeSeen, "offer.packSizeSeen"),
          currency: text(row.currency, "offer.currency"),
          zip: nullableText(row.zip),
          localityEvidence: nullableText(row.localityEvidence),
          inStock: booleanOrNull(row.inStock),
          productUrl: nullableText(row.productUrl),
          sellerName: nullableText(row.sellerName),
          isFirstParty: booleanOrNull(row.isFirstParty) === true,
          sourceApi: nullableText(row.sourceApi),
          observedAt: canonicalInstant(
            text(row.observedAt, "offer.observedAt"),
            "offer.observedAt",
          ),
          runId: nullableText(row.runId),
          approvalId: nullableText(row.approvalId),
          meteredReceiptId: nullableText(row.meteredReceiptId),
        });
        offersByVariant.set(canonicalVariantId, values);
      }
    }
    const variants = variantRows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const canonicalVariantId = text(row.id, "variant.id");
      const latestContent = row.contentId == null
        ? null
        : {
          observationId: text(row.contentId, "content.id"),
          donorProductId: text(
            row.contentDonorProductId,
            "content.donorProductId",
          ),
          sourceUrl: text(row.contentSourceUrl, "content.sourceUrl"),
          sourceApi: text(row.contentSourceApi, "content.sourceApi"),
          observedAt: canonicalInstant(
            text(row.contentObservedAt, "content.observedAt"),
            "content.observedAt",
          ),
          contentHash: text(row.contentHash, "content.contentHash"),
          facts: parseJson(row.contentJson, "content.contentJson"),
          runId: nullableText(row.contentRunId),
          approvalId: nullableText(row.contentApprovalId),
          meteredReceiptId: nullableText(row.contentMeteredReceiptId),
        };
      return {
        canonicalVariantId,
        variantKey: text(row.variantKey, "variant.variantKey"),
        identityHash: text(row.identityHash, "variant.identityHash"),
        keyVersion: text(row.keyVersion, "variant.keyVersion"),
        brand: text(row.normalizedBrand, "variant.normalizedBrand"),
        productLine: nullableText(row.normalizedProductLine),
        flavor: nullableText(row.normalizedFlavor),
        modifiers: parseJson(
          row.normalizedModifiersJson,
          "variant.normalizedModifiersJson",
        ) as unknown[],
        form: nullableText(row.normalizedForm),
        size: {
          dimension: text(row.sizeDimension, "variant.sizeDimension"),
          amount: number(row.sizeBaseAmount, "variant.sizeBaseAmount"),
          unit: text(row.sizeBaseUnit, "variant.sizeBaseUnit"),
          outerPackCount: integer(
            row.outerPackCount,
            "variant.outerPackCount",
          ),
        },
        identity: jsonObject(row.identityJson, "variant.identityJson"),
        sourceCount: integer(row.sourceCount, "variant.sourceCount"),
        contentObservationCount: integer(
          row.contentObservationCount,
          "variant.contentObservationCount",
        ),
        latestContent,
        offers: offersByVariant.get(canonicalVariantId) ?? [],
      } satisfies ProductTruthControlCenterVariant;
    });
    return {
      schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION,
      view: "VARIANTS",
      readAt,
      databaseTargetFingerprint: input.runtime.database.target.fingerprint,
      query,
      cursor,
      nextCursor: hasMore
        ? variants.at(-1)?.variantKey ?? null
        : null,
      limit,
      variants,
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    };
  } finally {
    tx.close();
  }
}

export interface ProductTruthControlCenterOperations {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION;
  view: "OPERATIONS";
  readAt: string;
  databaseTargetFingerprint: string;
  runs: Array<{
    runId: string;
    approvalId: string;
    mode: string;
    environment: string;
    status: string;
    manifestSha256: string;
    targetCount: number;
    planSha256: string;
    eventChainHead: string;
    reportSha256: string | null;
    artifactIndexSha256: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    itemCounts: Record<string, number>;
    queueCounts: Record<string, number>;
    budgets: Array<{
      provider: string;
      operations: unknown;
      maxCalls: number;
      reservedCalls: number;
      maxUnits: number | null;
      reservedUnits: number;
      issuedAt: string;
      expiresAt: string;
      receiptCounts: Record<string, number>;
    }>;
    blockers: Array<{
      listingKey: string;
      status: string;
      stage: string;
      lastError: string | null;
      updatedAt: string;
    }>;
  }>;
  claims: typeof PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS;
}

function increment(
  target: Record<string, number>,
  key: string,
  amount: number,
): void {
  target[key] = (target[key] ?? 0) + amount;
}

export async function readProductTruthControlCenterOperations(
  db: Client,
  input: {
    runtime: ProductTruthControlCenterRuntimeActive;
    readAt: string | Date;
    limit: number;
  },
): Promise<ProductTruthControlCenterOperations> {
  const readAt = canonicalInstant(input.readAt, "readAt");
  const limit = exactLimit(input.limit, 50);
  await assertControlCenterSchema(db);
  const tx = await db.transaction("read");
  try {
    const runsResult = await read(tx, {
      sql: `SELECT runId,approvalId,mode,environment,status,manifestSha256,
                   targetCount,planSha256,eventChainHead,reportSha256,
                   artifactIndexSha256,createdAt,updatedAt,startedAt,finishedAt
            FROM ProductTruthOperationalRun
            ORDER BY createdAt DESC,runId ASC
            LIMIT ?`,
      args: [limit],
    });
    const runIds = runsResult.rows.map((row) => String(row.runId));
    const itemCounts = new Map<string, Record<string, number>>();
    const queueCounts = new Map<string, Record<string, number>>();
    const budgets = new Map<
      string,
      ProductTruthControlCenterOperations["runs"][number]["budgets"]
    >();
    const blockers = new Map<
      string,
      ProductTruthControlCenterOperations["runs"][number]["blockers"]
    >();
    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(",");
      const itemsResult = await read(tx, {
        sql: `SELECT runId,status,COUNT(*) AS count
              FROM ProductTruthOperationalRunItem
              WHERE runId IN (${placeholders})
              GROUP BY runId,status`,
        args: runIds,
      });
      const queueResult = await read(tx, {
        sql: `SELECT runId,status,COUNT(*) AS count
              FROM EnrichmentJob
              WHERE runId IN (${placeholders})
                AND listingKey IS NOT NULL AND approvalId IS NOT NULL
              GROUP BY runId,status`,
        args: runIds,
      });
      const budgetResult = await read(tx, {
        sql: `SELECT budget.runId,budget.provider,budget.operations,
                     budget.maxCalls,budget.reservedCalls,
                     budget.maxUnitsMicros,budget.reservedUnitsMicros,
                     budget.issuedAt,budget.expiresAt,
                     receipt.status AS receiptStatus,
                     COUNT(receipt.id) AS receiptCount
              FROM MeteredProviderBudget budget
              LEFT JOIN MeteredReservationReceipt receipt
                ON receipt.budgetId=budget.id
              WHERE budget.runId IN (${placeholders})
              GROUP BY budget.id,receipt.status
              ORDER BY budget.runId,budget.provider,receipt.status`,
        args: runIds,
      });
      const blockerResult = await read(tx, {
        sql: `SELECT runId,listingKey,status,stage,lastError,updatedAt
              FROM ProductTruthOperationalRunItem
              WHERE runId IN (${placeholders})
                AND status IN ('blocked','ambiguous','failed','terminal_gap')
              ORDER BY updatedAt DESC,listingKey ASC`,
        args: runIds,
      });
      for (const row of itemsResult.rows) {
        const runId = text(row.runId, "item.runId");
        const values = itemCounts.get(runId) ?? {};
        increment(
          values,
          text(row.status, "item.status"),
          integer(row.count, "item.count"),
        );
        itemCounts.set(runId, values);
      }
      for (const row of queueResult.rows) {
        const runId = text(row.runId, "queue.runId");
        const values = queueCounts.get(runId) ?? {};
        increment(
          values,
          text(row.status, "queue.status"),
          integer(row.count, "queue.count"),
        );
        queueCounts.set(runId, values);
      }
      for (const raw of budgetResult.rows) {
        const row = raw as Record<string, unknown>;
        const runId = text(row.runId, "budget.runId");
        const provider = text(row.provider, "budget.provider");
        const values = budgets.get(runId) ?? [];
        let budget = values.find((candidate) => candidate.provider === provider);
        if (!budget) {
          budget = {
            provider,
            operations: parseJson(row.operations, "budget.operations"),
            maxCalls: integer(row.maxCalls, "budget.maxCalls"),
            reservedCalls: integer(
              row.reservedCalls,
              "budget.reservedCalls",
            ),
            maxUnits: row.maxUnitsMicros == null
              ? null
              : integer(row.maxUnitsMicros, "budget.maxUnitsMicros") / 1_000_000,
            reservedUnits:
              integer(
                row.reservedUnitsMicros,
                "budget.reservedUnitsMicros",
              ) / 1_000_000,
            issuedAt: canonicalInstant(
              text(row.issuedAt, "budget.issuedAt"),
              "budget.issuedAt",
            ),
            expiresAt: canonicalInstant(
              text(row.expiresAt, "budget.expiresAt"),
              "budget.expiresAt",
            ),
            receiptCounts: {},
          };
          values.push(budget);
          budgets.set(runId, values);
        }
        if (row.receiptStatus != null) {
          increment(
            budget.receiptCounts,
            text(row.receiptStatus, "receipt.status"),
            integer(row.receiptCount, "receipt.count"),
          );
        }
      }
      for (const raw of blockerResult.rows) {
        const row = raw as Record<string, unknown>;
        const runId = text(row.runId, "blocker.runId");
        const values = blockers.get(runId) ?? [];
        if (values.length < 20) {
          values.push({
            listingKey: text(row.listingKey, "blocker.listingKey"),
            status: text(row.status, "blocker.status"),
            stage: text(row.stage, "blocker.stage"),
            lastError: nullableText(row.lastError),
            updatedAt: canonicalInstant(
              text(row.updatedAt, "blocker.updatedAt"),
              "blocker.updatedAt",
            ),
          });
        }
        blockers.set(runId, values);
      }
    }
    const runs = runsResult.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const runId = text(row.runId, "run.runId");
      return {
        runId,
        approvalId: text(row.approvalId, "run.approvalId"),
        mode: text(row.mode, "run.mode"),
        environment: text(row.environment, "run.environment"),
        status: text(row.status, "run.status"),
        manifestSha256: text(row.manifestSha256, "run.manifestSha256"),
        targetCount: integer(row.targetCount, "run.targetCount"),
        planSha256: text(row.planSha256, "run.planSha256"),
        eventChainHead: text(row.eventChainHead, "run.eventChainHead"),
        reportSha256: nullableText(row.reportSha256),
        artifactIndexSha256: nullableText(row.artifactIndexSha256),
        createdAt: canonicalInstant(
          text(row.createdAt, "run.createdAt"),
          "run.createdAt",
        ),
        updatedAt: canonicalInstant(
          text(row.updatedAt, "run.updatedAt"),
          "run.updatedAt",
        ),
        startedAt: row.startedAt == null
          ? null
          : canonicalInstant(
            text(row.startedAt, "run.startedAt"),
            "run.startedAt",
          ),
        finishedAt: row.finishedAt == null
          ? null
          : canonicalInstant(
            text(row.finishedAt, "run.finishedAt"),
            "run.finishedAt",
          ),
        itemCounts: itemCounts.get(runId) ?? {},
        queueCounts: queueCounts.get(runId) ?? {},
        budgets: budgets.get(runId) ?? [],
        blockers: blockers.get(runId) ?? [],
      };
    });
    return {
      schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_API_VERSION,
      view: "OPERATIONS",
      readAt,
      databaseTargetFingerprint: input.runtime.database.target.fingerprint,
      runs,
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    };
  } finally {
    tx.close();
  }
}
