import type { Client, Transaction } from "@libsql/client";

import {
  productTruthConsumerEffectiveMode,
  type ProductTruthConsumer,
  type ProductTruthConsumerActivationMode,
  type ValidatedProductTruthConsumerActivation,
} from "./product-truth-consumer-activation";
import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  PRODUCT_TRUTH_MAX_BATCH_SCOPES,
  readProductTruthSnapshots,
  readProductTruthSnapshotsInTransaction,
  type ProductTruthReadScope,
  type ProductTruthSnapshot,
} from "./product-truth-read-contract";
import { buildProductTruthListingScope } from "./product-truth-listing-scope";
import { assertProductTruthListingScopeSchema } from "./product-truth-schema-gate";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION =
  "product-truth-consumer-gateway/1.0.0" as const;

export type ProductTruthConsumerView =
  ProductTruthSnapshot["views"][keyof ProductTruthSnapshot["views"]];

export type ProductTruthConsumerDisposition =
  | "READY"
  | "UNSOURCEABLE"
  | "BLOCKED";

export interface ProductTruthConsumerGatewayEntry {
  listingKey: string;
  channel: string;
  storeIndex: number;
  sku: string;
  disposition: ProductTruthConsumerDisposition;
  ready: boolean;
  blockers: string[];
  view: ProductTruthConsumerView;
}

export interface ProductTruthConsumerGatewayReport {
  schemaVersion: typeof PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION;
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  activationSha256: string;
  ownerApprovalId: string;
  mode: ProductTruthConsumerActivationMode;
  outputUse: "COMPARE_ONLY" | "AUTHORITATIVE_NO_FALLBACK";
  consumer: ProductTruthConsumer;
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
  readAt: string;
  asOf: string;
  maxPriceAgeMs: number;
  counts: {
    total: number;
    ready: number;
    unsourceable: number;
    blocked: number;
    fact: number;
    estimate: number;
    missing: number;
    invalid: number;
  };
  entries: ProductTruthConsumerGatewayEntry[];
  claims: {
    readOnly: true;
    legacyFallback: false;
    providerCalls: false;
    marketplaceMutations: false;
    procurementMutations: false;
  };
}

export interface ProductTruthConsumerManifestScopePage {
  authoritativeManifestSha256: string;
  manifestInventory: {
    scopeCount: number;
    partitions: Array<{
      channel: "amazon" | "walmart";
      storeIndex: number;
      scopeCount: number;
    }>;
  };
  channel: "amazon" | "walmart";
  storeIndex: number;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  scopes: Array<ProductTruthReadScope & { listingKey: string }>;
  claims: {
    readOnly: true;
    databaseWrites: false;
    providerCalls: false;
    marketplaceMutations: false;
  };
}

export class ProductTruthConsumerGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsumerGatewayError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsumerGatewayError(code, message);
}

function canonicalInstant(value: string | Date, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw.trim())) {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", `${label} must include an explicit timezone`);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", `${label} must be a valid instant`);
  }
  return new Date(milliseconds).toISOString();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function consumerView(
  snapshot: ProductTruthSnapshot,
  consumer: ProductTruthConsumer,
): ProductTruthConsumerView {
  if (consumer === "BUNDLE_FACTORY") return snapshot.views.bundleFactory;
  if (consumer === "LISTING_IMPROVEMENT") return snapshot.views.listingImprovement;
  if (consumer === "UNIT_ECONOMICS") return snapshot.views.unitEconomics;
  return snapshot.views.procurement;
}

function entryFromSnapshot(
  snapshot: ProductTruthSnapshot,
  consumer: ProductTruthConsumer,
): ProductTruthConsumerGatewayEntry {
  const view = consumerView(snapshot, consumer);
  let ready = false;
  let disposition: ProductTruthConsumerDisposition = "BLOCKED";
  let blockers: string[];
  if (view.consumer === "UNIT_ECONOMICS") {
    ready = view.status === "FACT" || view.status === "ESTIMATE";
    disposition = view.status === "UNSOURCEABLE"
      ? "UNSOURCEABLE"
      : ready
        ? "READY"
        : "BLOCKED";
    blockers = unique([
      ...view.blockers,
      ...(view.status === "UNSOURCEABLE" ? ["UNIT_ECONOMICS_UNSOURCEABLE"] : []),
    ]);
  } else {
    ready = view.ready;
    disposition = ready ? "READY" : "BLOCKED";
    blockers = unique(view.blockers);
  }
  return {
    listingKey: snapshot.snapshot.listingKey,
    channel: snapshot.snapshot.channel,
    storeIndex: snapshot.snapshot.storeIndex,
    sku: snapshot.snapshot.sku,
    disposition,
    ready,
    blockers,
    view,
  };
}

function assertSnapshotBindings(input: {
  scopes: readonly ProductTruthReadScope[];
  snapshots: readonly ProductTruthSnapshot[];
  asOf: string;
  maxPriceAgeMs: number;
}): void {
  if (input.snapshots.length !== input.scopes.length) {
    fail("CONSUMER_GATEWAY_RESULT_INVALID", "snapshot count differs from exact scope count");
  }
  input.scopes.forEach((scope, index) => {
    const exact = buildProductTruthListingScope(scope);
    const snapshot = input.snapshots[index];
    if (
      snapshot.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION
      || snapshot.snapshot.listingKey !== exact.listingKey
      || snapshot.snapshot.channel !== exact.channel
      || snapshot.snapshot.storeIndex !== exact.storeIndex
      || snapshot.snapshot.sku !== exact.sku
      || snapshot.snapshot.asOf !== input.asOf
      || snapshot.snapshot.maxPriceAgeMs !== input.maxPriceAgeMs
    ) {
      fail(
        "CONSUMER_GATEWAY_RESULT_INVALID",
        `snapshot ${index} is not bound to ${exact.listingKey} and the sealed read policy`,
      );
    }
  });
}

/**
 * Pure projection used by the runtime reader and certification tests. It never
 * substitutes a legacy result: a blocker remains a blocker in ENFORCED mode.
 */
export function buildProductTruthConsumerGatewayReport(input: {
  validatedActivation: ValidatedProductTruthConsumerActivation;
  consumer: ProductTruthConsumer;
  scopes: readonly ProductTruthReadScope[];
  snapshots: readonly ProductTruthSnapshot[];
  readAt: string | Date;
  asOf: string | Date;
}): ProductTruthConsumerGatewayReport {
  const mode = productTruthConsumerEffectiveMode(
    input.consumer,
    input.validatedActivation,
  );
  if (mode === "OFF") {
    fail(
      "CONSUMER_GATEWAY_OFF",
      `${input.consumer} has no current validated Product Truth activation`,
    );
  }
  const activation = input.validatedActivation.activation;
  if (
    input.scopes.length < 1
    || input.scopes.length > activation.readPolicy.batch.maxListingsPerBatch
  ) {
    fail(
      "CONSUMER_GATEWAY_BATCH_INVALID",
      `batch must contain 1-${activation.readPolicy.batch.maxListingsPerBatch} exact scopes`,
    );
  }
  const readAt = canonicalInstant(input.readAt, "readAt");
  const asOf = canonicalInstant(input.asOf, "asOf");
  if (
    Date.parse(readAt) < Date.parse(activation.issuedAt)
    || Date.parse(readAt) >= Date.parse(activation.expiresAt)
  ) {
    fail("CONSUMER_GATEWAY_ACTIVATION_EXPIRED", "activation is not current at readAt");
  }
  if (Date.parse(asOf) > Date.parse(readAt)) {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", "asOf cannot be later than readAt");
  }
  assertSnapshotBindings({
    scopes: input.scopes,
    snapshots: input.snapshots,
    asOf,
    maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs,
  });
  const entries = input.snapshots.map((snapshot) =>
    entryFromSnapshot(snapshot, input.consumer));
  const economicsStatuses = input.snapshots.map((snapshot) =>
    snapshot.views.unitEconomics.status);
  return {
    schemaVersion: PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    activationSha256: input.validatedActivation.activationSha256,
    ownerApprovalId: activation.ownerApproval.approvalId,
    mode,
    outputUse: mode === "SHADOW" ? "COMPARE_ONLY" : "AUTHORITATIVE_NO_FALLBACK",
    consumer: input.consumer,
    authoritativeManifestSha256: activation.authoritativeManifestSha256,
    databaseTargetFingerprint: activation.databaseTargetFingerprint,
    readAt,
    asOf,
    maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs,
    counts: {
      total: entries.length,
      ready: entries.filter((entry) => entry.disposition === "READY").length,
      unsourceable: entries.filter((entry) => entry.disposition === "UNSOURCEABLE").length,
      blocked: entries.filter((entry) => entry.disposition === "BLOCKED").length,
      fact: economicsStatuses.filter((status) => status === "FACT").length,
      estimate: economicsStatuses.filter((status) => status === "ESTIMATE").length,
      missing: economicsStatuses.filter((status) => status === "MISSING").length,
      invalid: economicsStatuses.filter((status) => status === "INVALID").length,
    },
    entries,
    claims: {
      readOnly: true,
      legacyFallback: false,
      providerCalls: false,
      marketplaceMutations: false,
      procurementMutations: false,
    },
  };
}

/**
 * The only existing-listing batch entrypoint intended for the four strategic
 * consumers. It performs set-based Product Truth reads; errors propagate and
 * there is deliberately no per-listing or legacy fallback.
 */
export async function readProductTruthConsumerBatch(
  db: Client,
  input: {
    validatedActivation: ValidatedProductTruthConsumerActivation;
    consumer: ProductTruthConsumer;
    scopes: readonly ProductTruthReadScope[];
    readAt: string | Date;
    asOf?: string | Date;
    transaction?: Transaction;
  },
): Promise<ProductTruthConsumerGatewayReport> {
  const mode = productTruthConsumerEffectiveMode(
    input.consumer,
    input.validatedActivation,
  );
  if (mode === "OFF") {
    fail(
      "CONSUMER_GATEWAY_OFF",
      `${input.consumer} has no current validated Product Truth activation`,
    );
  }
  const activation = input.validatedActivation.activation;
  if (
    input.scopes.length < 1
    || input.scopes.length > activation.readPolicy.batch.maxListingsPerBatch
  ) {
    fail(
      "CONSUMER_GATEWAY_BATCH_INVALID",
      `batch must contain 1-${activation.readPolicy.batch.maxListingsPerBatch} exact scopes`,
    );
  }
  const readAt = canonicalInstant(input.readAt, "readAt");
  const asOf = canonicalInstant(input.asOf ?? readAt, "asOf");
  const snapshots = await (input.transaction
    ? readProductTruthSnapshotsInTransaction(input.transaction, {
      scopes: input.scopes,
      expectedManifestSha256: activation.authoritativeManifestSha256,
      asOf,
      maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs,
    })
    : readProductTruthSnapshots(db, {
    scopes: input.scopes,
    expectedManifestSha256: activation.authoritativeManifestSha256,
    asOf,
    maxPriceAgeMs: activation.readPolicy.maxPriceAgeMs,
    }));
  return buildProductTruthConsumerGatewayReport({
    validatedActivation: input.validatedActivation,
    consumer: input.consumer,
    scopes: input.scopes,
    snapshots,
    readAt,
    asOf,
  });
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactManifestPageChannel(value: unknown): "amazon" | "walmart" {
  if (value !== "amazon" && value !== "walmart") {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", "channel must be amazon or walmart");
  }
  return value;
}

function manifestScopeFromRow(input: {
  row: Record<string, unknown>;
  ordinal: number | "cursor";
  authoritativeManifestSha256: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
}): ProductTruthReadScope & { listingKey: string } {
  const exact = buildProductTruthListingScope({
    channel: String(input.row.channel),
    storeIndex: Number(input.row.storeIndex),
    sku: String(input.row.sku),
  });
  if (
    exact.listingKey !== input.row.listingKey
    || exact.keyVersion !== input.row.keyVersion
    || input.row.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST"
    || input.row.manifestSchemaVersion !== "phase1-authoritative-scope-manifest/v3"
    || input.row.manifestSha256 !== input.authoritativeManifestSha256
    || exact.channel !== input.channel
    || exact.storeIndex !== input.storeIndex
  ) {
    fail(
      "CONSUMER_GATEWAY_RESULT_INVALID",
      `manifest scope row ${input.ordinal} violates its immutable binding`,
    );
  }
  return {
    listingKey: exact.listingKey,
    channel: exact.channel,
    storeIndex: exact.storeIndex,
    sku: exact.sku,
  };
}

/**
 * Lists one deterministic page from the immutable manifest-backed scope
 * registry. This is the denominator source for SHADOW diagnostics; mutable
 * marketplace cache tables are never allowed to decide which listings exist.
 */
export async function readProductTruthConsumerManifestScopePage(
  db: Client | Transaction,
  input: {
    authoritativeManifestSha256: string;
    channel: string;
    storeIndex: number;
    cursor?: string | null;
    limit: number;
    maximumPageSize: number;
  },
): Promise<ProductTruthConsumerManifestScopePage> {
  const authoritativeManifestSha256 = exactSha256(
    input.authoritativeManifestSha256,
    "authoritativeManifestSha256",
  );
  const channel = exactManifestPageChannel(input.channel);
  if (!Number.isSafeInteger(input.storeIndex) || input.storeIndex < 1) {
    fail("CONSUMER_GATEWAY_INPUT_INVALID", "storeIndex must be a positive integer");
  }
  if (
    !Number.isSafeInteger(input.maximumPageSize)
    || input.maximumPageSize < 1
    || input.maximumPageSize > PRODUCT_TRUTH_MAX_BATCH_SCOPES
  ) {
    fail(
      "CONSUMER_GATEWAY_INPUT_INVALID",
      `maximumPageSize must be 1-${PRODUCT_TRUTH_MAX_BATCH_SCOPES}`,
    );
  }
  if (
    !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > input.maximumPageSize
  ) {
    fail(
      "CONSUMER_GATEWAY_INPUT_INVALID",
      `limit must be 1-${input.maximumPageSize}`,
    );
  }
  const prefix = `${channel}:${input.storeIndex}:`;
  const cursor = input.cursor ?? null;
  if (
    cursor !== null
    && (
      typeof cursor !== "string"
      || cursor.length <= prefix.length
      || cursor.length > 1_024
      || cursor !== cursor.trim()
      || !cursor.startsWith(prefix)
    )
  ) {
    fail(
      "CONSUMER_GATEWAY_CURSOR_INVALID",
      "cursor must be an exact listingKey in the requested channel/store scope",
    );
  }
  if (cursor !== null) {
    const rebuilt = buildProductTruthListingScope({
      channel,
      storeIndex: input.storeIndex,
      sku: cursor.slice(prefix.length),
    });
    if (rebuilt.listingKey !== cursor) {
      fail("CONSUMER_GATEWAY_CURSOR_INVALID", "cursor is not canonical");
    }
  }

  await assertProductTruthListingScopeSchema(db as Client);
  const manifestRegistration = await db.execute({
    sql: `SELECT channel,storeIndex,COUNT(*) AS scopeCount
          FROM ProductTruthListingScope
          WHERE manifestSha256=?
          GROUP BY channel,storeIndex
          ORDER BY channel ASC,storeIndex ASC`,
    args: [authoritativeManifestSha256],
  });
  const partitions = manifestRegistration.rows.map((row, ordinal) => {
    const partitionChannel = exactManifestPageChannel(row.channel);
    const partitionStoreIndex = Number(row.storeIndex);
    const scopeCount = Number(row.scopeCount);
    if (
      !Number.isSafeInteger(partitionStoreIndex)
      || partitionStoreIndex < 1
      || !Number.isSafeInteger(scopeCount)
      || scopeCount < 1
    ) {
      fail(
        "CONSUMER_GATEWAY_RESULT_INVALID",
        `manifest inventory partition ${ordinal} is invalid`,
      );
    }
    return { channel: partitionChannel, storeIndex: partitionStoreIndex, scopeCount };
  });
  const registeredScopeCount = partitions.reduce(
    (total, partition) => total + partition.scopeCount,
    0,
  );
  if (!Number.isSafeInteger(registeredScopeCount) || registeredScopeCount < 1) {
    fail(
      "CONSUMER_GATEWAY_MANIFEST_NOT_REGISTERED",
      "activated manifest has no immutable listing-scope registry rows",
    );
  }
  if (!partitions.some((partition) =>
    partition.channel === channel && partition.storeIndex === input.storeIndex)) {
    fail(
      "CONSUMER_GATEWAY_PARTITION_NOT_REGISTERED",
      "requested channel/store is not a listing partition in the activated manifest",
    );
  }
  if (cursor !== null) {
    const cursorResult = await db.execute({
      sql: `SELECT listingKey,keyVersion,channel,storeIndex,sku,
                   registrationKind,manifestSchemaVersion,manifestSha256
            FROM ProductTruthListingScope
            WHERE listingKey=? AND manifestSha256=? AND channel=? AND storeIndex=?`,
      args: [cursor, authoritativeManifestSha256, channel, input.storeIndex],
    });
    if (cursorResult.rows.length !== 1) {
      fail(
        "CONSUMER_GATEWAY_CURSOR_INVALID",
        "cursor is not an exact row in the activated manifest and channel/store scope",
      );
    }
    const exactCursor = manifestScopeFromRow({
      row: cursorResult.rows[0] as unknown as Record<string, unknown>,
      ordinal: "cursor",
      authoritativeManifestSha256,
      channel,
      storeIndex: input.storeIndex,
    });
    if (exactCursor.listingKey !== cursor) {
      fail("CONSUMER_GATEWAY_CURSOR_INVALID", "cursor registry binding is invalid");
    }
  }
  const result = await db.execute({
    sql: `SELECT listingKey,keyVersion,channel,storeIndex,sku,
                 registrationKind,manifestSchemaVersion,manifestSha256
          FROM ProductTruthListingScope
          WHERE manifestSha256=? AND channel=? AND storeIndex=?
            AND (? IS NULL OR listingKey>?)
          ORDER BY listingKey ASC
          LIMIT ?`,
    args: [
      authoritativeManifestSha256,
      channel,
      input.storeIndex,
      cursor,
      cursor,
      input.limit + 1,
    ],
  });
  const hasMore = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);
  const scopes = rows.map((row, ordinal) => manifestScopeFromRow({
    row: row as unknown as Record<string, unknown>,
    ordinal,
    authoritativeManifestSha256,
    channel,
    storeIndex: input.storeIndex,
  }));
  return {
    authoritativeManifestSha256,
    manifestInventory: { scopeCount: registeredScopeCount, partitions },
    channel,
    storeIndex: input.storeIndex,
    limit: input.limit,
    cursor,
    nextCursor: hasMore ? scopes.at(-1)?.listingKey ?? null : null,
    scopes,
    claims: {
      readOnly: true,
      databaseWrites: false,
      providerCalls: false,
      marketplaceMutations: false,
    },
  };
}

export function renderProductTruthConsumerGatewayReportJson(
  report: ProductTruthConsumerGatewayReport,
): string {
  return renderProductTruthOperationalJson(report);
}

export function productTruthConsumerGatewayReportSha256(
  report: ProductTruthConsumerGatewayReport,
): string {
  return productTruthOperationalSha256(report);
}
