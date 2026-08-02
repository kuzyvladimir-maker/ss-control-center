import { prisma } from "@/lib/prisma";

import {
  nextWalmartListingIntegritySchedulerDecision,
  verifyWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
  type WalmartListingIntegritySchedulerDecision,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_CONTROL_STORE_STATUS_SCHEMA =
  "walmart-listing-integrity-control-store-status/v1" as const;

export interface WalmartListingIntegrityControlStoreStatus {
  schemaVersion: typeof WALMART_LISTING_INTEGRITY_CONTROL_STORE_STATUS_SCHEMA;
  installation: "NOT_INSTALLED" | "INSTALLED";
  runtimeStage: "OFF";
  activeRun: null | {
    runId: string;
    poolBodySha256: string;
    releaseIdSha256: string;
    manifestSha256: string;
    status: "ACTIVE" | "PAUSED" | "COMPLETED" | "FAILED";
    createdAt: string;
    updatedAt: string;
    itemCount: number;
    terminalCount: number;
    qualifiedCount: number;
    quarantinedCount: number;
    activeItem: null | {
      ordinal: number;
      listingKey: string;
      sku: string;
      itemId: string;
      state: WalmartListingIntegrityControlState["state"];
      revision: number;
      transitionedAt: string;
    };
    nextDecision: WalmartListingIntegritySchedulerDecision;
  };
  claims: {
    databaseWrites: 0;
    walmartReads: 0;
    walmartWrites: 0;
    modelCalls: 0;
    runtimeActivationGranted: false;
  };
}

export interface WalmartListingIntegrityControlRunSnapshot {
  installation: "NOT_INSTALLED" | "INSTALLED";
  runtime_policy_stage: "OFF";
  run: null | {
    run_id: string;
    pool_body_sha256: string;
    release_id_sha256: string;
    manifest_sha256: string;
    status: "ACTIVE" | "PAUSED" | "COMPLETED" | "FAILED";
    created_at: string;
    updated_at: string;
    items: readonly WalmartListingIntegrityControlState[];
  };
}

interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface ControlRunRow {
  runId: unknown;
  poolBodySha256: unknown;
  releaseIdSha256: unknown;
  manifestSha256: unknown;
  runtimeStage: unknown;
  status: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ControlItemRow {
  runId: unknown;
  ordinal: unknown;
  listingKey: unknown;
  sku: unknown;
  itemId: unknown;
  storeIndex: unknown;
  state: unknown;
  revision: unknown;
  stateBodySha256: unknown;
  previousStateSha256: unknown;
  evidenceSha256: unknown;
  executionPackageSha256: unknown;
  ownerPermitSha256: unknown;
  feedId: unknown;
  marketplaceWriteCalls: unknown;
  automaticRetryAllowed: unknown;
  automaticReplayAllowed: unknown;
  transitionedAt: unknown;
}

interface TerminalListingKeyRow {
  listingKey: unknown;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL_STATES = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
  "MANUAL_REVIEW",
]);
const ADVANCE_TERMINAL_STATES = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_INTEGRITY_CONTROL_STORE_INVALID: ${message}`);
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || value !== value.trim() || !value
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const digest = exactText(value, label, 64);
  if (!SHA256.test(digest)) fail(`${label} must be lowercase SHA-256`);
  return digest;
}

function integer(value: unknown, label: string, minimum: number): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(exactText(value, label, 64));
  if (!Number.isFinite(parsed.getTime())) fail(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : exactText(value, label);
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : exactSha(value, label);
}

function exactFalse(value: unknown, label: string): false {
  if (value !== false && value !== 0
    && !(typeof value === "bigint" && value.toString() === "0")) {
    fail(`${label} must be false`);
  }
  return false;
}

function exactWriteCount(value: unknown): 0 | 1 {
  const parsed = integer(value, "marketplaceWriteCalls", 0);
  if (parsed !== 0 && parsed !== 1) fail("marketplaceWriteCalls must be 0 or 1");
  return parsed;
}

function parseRun(row: ControlRunRow) {
  const runtimeStage = exactText(row.runtimeStage, "runtimeStage", 32);
  if (runtimeStage !== "OFF") {
    fail("Stage A runtime must remain OFF until a separately approved activation migration");
  }
  const status = exactText(row.status, "status", 32);
  if (!["ACTIVE", "PAUSED", "COMPLETED", "FAILED"].includes(status)) {
    fail("run status is invalid");
  }
  return {
    runId: exactText(row.runId, "runId", 200),
    poolBodySha256: exactSha(row.poolBodySha256, "poolBodySha256"),
    releaseIdSha256: exactSha(row.releaseIdSha256, "releaseIdSha256"),
    manifestSha256: exactSha(row.manifestSha256, "manifestSha256"),
    runtimeStage: "OFF" as const,
    status: status as "ACTIVE" | "PAUSED" | "COMPLETED" | "FAILED",
    createdAt: instant(row.createdAt, "createdAt"),
    updatedAt: instant(row.updatedAt, "updatedAt"),
  };
}

function parseItem(
  row: ControlItemRow,
  run: ReturnType<typeof parseRun>,
): WalmartListingIntegrityControlState {
  if (exactText(row.runId, "item.runId", 200) !== run.runId) {
    fail("item belongs to another run");
  }
  return verifyWalmartListingIntegrityControlState({
    schema_version: "walmart-listing-integrity-control-state/v1",
    identity: {
      run_id: run.runId,
      pool_body_sha256: run.poolBodySha256,
      ordinal: integer(row.ordinal, "ordinal", 1),
      listing_key: exactText(row.listingKey, "listingKey"),
      sku: exactText(row.sku, "sku", 500),
      item_id: exactText(row.itemId, "itemId", 100),
      store_index: integer(row.storeIndex, "storeIndex", 1),
    },
    state: exactText(row.state, "state", 64),
    revision: integer(row.revision, "revision", 1),
    transitioned_at: instant(row.transitionedAt, "transitionedAt"),
    previous_state_sha256: nullableSha(
      row.previousStateSha256,
      "previousStateSha256",
    ),
    evidence_sha256: exactSha(row.evidenceSha256, "evidenceSha256"),
    execution_package_sha256: nullableSha(
      row.executionPackageSha256,
      "executionPackageSha256",
    ),
    owner_permit_sha256: nullableSha(
      row.ownerPermitSha256,
      "ownerPermitSha256",
    ),
    feed_id: nullableText(row.feedId, "feedId"),
    marketplace_write_calls: exactWriteCount(row.marketplaceWriteCalls),
    automatic_retry_allowed: exactFalse(
      row.automaticRetryAllowed,
      "automaticRetryAllowed",
    ),
    automatic_replay_allowed: exactFalse(
      row.automaticReplayAllowed,
      "automaticReplayAllowed",
    ),
    body_sha256: exactSha(row.stateBodySha256, "stateBodySha256"),
  });
}

function isMissingControlPlaneTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?WalmartListingIntegrityControl(?:Run|Item)|P2021.*WalmartListingIntegrityControl(?:Run|Item)/iu
    .test(message);
}

function emptyStatus(
  installation: WalmartListingIntegrityControlStoreStatus["installation"],
): WalmartListingIntegrityControlStoreStatus {
  return {
    schemaVersion: WALMART_LISTING_INTEGRITY_CONTROL_STORE_STATUS_SCHEMA,
    installation,
    runtimeStage: "OFF",
    activeRun: null,
    claims: {
      databaseWrites: 0,
      walmartReads: 0,
      walmartWrites: 0,
      modelCalls: 0,
      runtimeActivationGranted: false,
    },
  };
}

export async function loadWalmartListingIntegrityControlStoreStatus(
  client: RawQueryClient = prisma as unknown as RawQueryClient,
): Promise<WalmartListingIntegrityControlStoreStatus> {
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot(client);
  if (snapshot.installation === "NOT_INSTALLED") return emptyStatus("NOT_INSTALLED");
  if (!snapshot.run) return emptyStatus("INSTALLED");
  const run = snapshot.run;
  const items = [...run.items];
  const decision = nextWalmartListingIntegritySchedulerDecision({
    stage: "OFF",
    items,
  });
  const active = items.find((item) => !ADVANCE_TERMINAL_STATES.has(item.state)) ?? null;
  return {
    schemaVersion: WALMART_LISTING_INTEGRITY_CONTROL_STORE_STATUS_SCHEMA,
    installation: "INSTALLED",
    runtimeStage: "OFF",
    activeRun: {
      runId: run.run_id,
      poolBodySha256: run.pool_body_sha256,
      releaseIdSha256: run.release_id_sha256,
      manifestSha256: run.manifest_sha256,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      itemCount: items.length,
      terminalCount: items.filter((item) => TERMINAL_STATES.has(item.state)).length,
      qualifiedCount: items.filter((item) => item.state === "QUALIFIED_PASS").length,
      quarantinedCount: items.filter((item) => (
        item.state === "QUARANTINED_SOURCE_REQUIRED"
        || item.state === "QUARANTINED_UNRESOLVED"
        || item.state === "MANUAL_REVIEW"
      )).length,
      activeItem: active ? {
        ordinal: active.identity.ordinal,
        listingKey: active.identity.listing_key,
        sku: active.identity.sku,
        itemId: active.identity.item_id,
        state: active.state,
        revision: active.revision,
        transitionedAt: active.transitioned_at,
      } : null,
      nextDecision: decision,
    },
    claims: {
      databaseWrites: 0,
      walmartReads: 0,
      walmartWrites: 0,
      modelCalls: 0,
      runtimeActivationGranted: false,
    },
  };
}

export async function loadWalmartListingIntegrityControlRunSnapshot(
  client: RawQueryClient = prisma as unknown as RawQueryClient,
): Promise<WalmartListingIntegrityControlRunSnapshot> {
  let rows: ControlRunRow[];
  try {
    rows = await client.$queryRawUnsafe<ControlRunRow[]>(`
      SELECT runId,poolBodySha256,releaseIdSha256,manifestSha256,
             runtimeStage,status,createdAt,updatedAt
      FROM WalmartListingIntegrityControlRun
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END,
               createdAt DESC, runId ASC
    `);
  } catch (error) {
    if (isMissingControlPlaneTable(error)) {
      return { installation: "NOT_INSTALLED", runtime_policy_stage: "OFF", run: null };
    }
    throw error;
  }
  if (rows.length === 0) {
    return { installation: "INSTALLED", runtime_policy_stage: "OFF", run: null };
  }
  const parsedRuns = rows.map(parseRun);
  const activeRuns = parsedRuns.filter((run) => run.status === "ACTIVE");
  if (activeRuns.length > 1) fail("more than one ACTIVE run exists");
  const run = activeRuns[0] ?? parsedRuns[0];
  const itemRows = await client.$queryRawUnsafe<ControlItemRow[]>(`
    SELECT runId,ordinal,listingKey,sku,itemId,storeIndex,state,revision,
           stateBodySha256,previousStateSha256,evidenceSha256,
           executionPackageSha256,ownerPermitSha256,feedId,
           marketplaceWriteCalls,automaticRetryAllowed,
           automaticReplayAllowed,transitionedAt
    FROM WalmartListingIntegrityControlItem
    WHERE runId = ?
    ORDER BY ordinal ASC
  `, run.runId);
  const items = itemRows.map((row) => parseItem(row, run));
  return {
    installation: "INSTALLED",
    runtime_policy_stage: "OFF",
    run: {
      run_id: run.runId,
      pool_body_sha256: run.poolBodySha256,
      release_id_sha256: run.releaseIdSha256,
      manifest_sha256: run.manifestSha256,
      status: run.status,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      items: Object.freeze(items),
    },
  };
}

export async function loadWalmartListingIntegrityTerminalListingKeys(
  client: RawQueryClient = prisma as unknown as RawQueryClient,
): Promise<string[]> {
  let rows: TerminalListingKeyRow[];
  try {
    rows = await client.$queryRawUnsafe<TerminalListingKeyRow[]>(`
      SELECT DISTINCT listingKey
      FROM WalmartListingIntegrityControlItem
      WHERE state IN (
        'AUDITED_PASS',
        'QUALIFIED_PASS',
        'QUARANTINED_SOURCE_REQUIRED',
        'QUARANTINED_UNRESOLVED'
      )
      ORDER BY listingKey ASC
    `);
  } catch (error) {
    if (isMissingControlPlaneTable(error)) return [];
    throw error;
  }
  const parsed = rows.map((row, index) => exactText(
    row.listingKey,
    `terminalListingKeys[${index}]`,
  ));
  if (new Set(parsed).size !== parsed.length
    || parsed.some((value, index) => index > 0 && parsed[index - 1]!.localeCompare(value, "en") >= 0)) {
    fail("terminal listing keys must be unique and sorted");
  }
  return parsed;
}
