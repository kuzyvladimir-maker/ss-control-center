import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

import {
  verifyWalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlState,
  type WalmartListingIntegritySchedulerStage,
} from "./listing-integrity-control-plane";
import {
  admitWalmartListingIntegrityOperatorReceipt,
} from "./listing-integrity-operator-admission";

export const WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA =
  "walmart-listing-integrity-control-event/v1" as const;
export const WALMART_LISTING_INTEGRITY_CONTROL_ZERO_HASH = "0".repeat(64);
const TRANSIENT_DATABASE_BUSY_ATTEMPTS = 5;
const TRANSIENT_DATABASE_BUSY_BASE_DELAY_MS = 100;

export interface WalmartListingIntegrityControlRawTransactionClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface WalmartListingIntegrityControlRawTransactionHost {
  $transaction<T>(callback: (
    transaction: WalmartListingIntegrityControlRawTransactionClient,
  ) => Promise<T>): Promise<T>;
}

interface PersistedItemRow {
  itemControlId: unknown;
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

interface PriorEventRow {
  sequence: unknown;
  eventHash: unknown;
}

export interface WalmartListingIntegrityPersistedTransition {
  state: WalmartListingIntegrityControlState;
  artifact: {
    artifact_id: string;
    role: string;
    sha256: string;
    locator: string;
    byte_size: number;
  };
  event: {
    event_id: string;
    sequence: number;
    event_type: string;
    payload_sha256: string;
    previous_event_hash: string;
    event_hash: string;
  };
}

export class WalmartListingIntegrityControlTransitionStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "WalmartListingIntegrityControlTransitionStoreError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new WalmartListingIntegrityControlTransitionStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(",")}}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function transientDatabaseBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor = error;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = cursor instanceof Error ? cursor.message : String(cursor);
    if (/\bSQLITE_BUSY\b/u.test(message)) return true;
    cursor = cursor instanceof Error ? cursor.cause : null;
  }
  return false;
}

async function persistAtomicTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= TRANSIENT_DATABASE_BUSY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!transientDatabaseBusy(error)
        || attempt === TRANSIENT_DATABASE_BUSY_ATTEMPTS) {
        throw error;
      }
      // This retry is below the business-operation boundary: the failed
      // database transaction is atomic and has no marketplace/model effects.
      // The next attempt still starts with the exact predecessor CAS read.
      await new Promise((accept) => setTimeout(
        accept,
        TRANSIENT_DATABASE_BUSY_BASE_DELAY_MS * attempt,
      ));
    }
  }
  throw new Error("unreachable transient database retry boundary");
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("TRANSITION_VALUE_INVALID", `${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const parsed = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail("TRANSITION_VALUE_INVALID", `${label} must be lowercase SHA-256`);
  }
  return parsed;
}

function exactInteger(value: unknown, label: string, minimum: number): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail("TRANSITION_VALUE_INVALID", `${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function exactFalse(value: unknown, label: string): false {
  if (value !== false && value !== 0
    && !(typeof value === "bigint" && value.toString() === "0")) {
    fail("TRANSITION_VALUE_INVALID", `${label} must be false`);
  }
  return false;
}

function instant(value: unknown, label: string): string {
  const parsed = value instanceof Date
    ? value.toISOString()
    : exactText(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) {
    fail("TRANSITION_VALUE_INVALID", `${label} must be a timestamp`);
  }
  return date.toISOString();
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : exactText(value, label);
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : exactSha(value, label);
}

function persistedState(
  row: PersistedItemRow,
  expected: WalmartListingIntegrityControlState,
): { itemControlId: string; state: WalmartListingIntegrityControlState } {
  const marketplaceWriteCalls = exactInteger(
    row.marketplaceWriteCalls,
    "row.marketplaceWriteCalls",
    0,
  );
  if (marketplaceWriteCalls !== 0 && marketplaceWriteCalls !== 1) {
    fail("TRANSITION_VALUE_INVALID", "row.marketplaceWriteCalls must be 0 or 1");
  }
  const identity = {
    run_id: exactText(row.runId, "row.runId", 200),
    pool_body_sha256: expected.identity.pool_body_sha256,
    ordinal: exactInteger(row.ordinal, "row.ordinal", 1),
    listing_key: exactText(row.listingKey, "row.listingKey"),
    sku: exactText(row.sku, "row.sku", 500),
    item_id: exactText(row.itemId, "row.itemId", 100),
    store_index: exactInteger(row.storeIndex, "row.storeIndex", 1),
  };
  const state = verifyWalmartListingIntegrityControlState({
    schema_version: "walmart-listing-integrity-control-state/v1",
    identity,
    state: exactText(row.state, "row.state", 64),
    revision: exactInteger(row.revision, "row.revision", 1),
    transitioned_at: instant(row.transitionedAt, "row.transitionedAt"),
    previous_state_sha256: nullableSha(row.previousStateSha256, "row.previousStateSha256"),
    evidence_sha256: exactSha(row.evidenceSha256, "row.evidenceSha256"),
    execution_package_sha256: nullableSha(row.executionPackageSha256, "row.executionPackageSha256"),
    owner_permit_sha256: nullableSha(row.ownerPermitSha256, "row.ownerPermitSha256"),
    feed_id: nullableText(row.feedId, "row.feedId"),
    marketplace_write_calls: marketplaceWriteCalls as 0 | 1,
    automatic_retry_allowed: exactFalse(row.automaticRetryAllowed, "row.automaticRetryAllowed"),
    automatic_replay_allowed: exactFalse(row.automaticReplayAllowed, "row.automaticReplayAllowed"),
    body_sha256: exactSha(row.stateBodySha256, "row.stateBodySha256"),
  });
  return {
    itemControlId: exactText(row.itemControlId, "row.itemControlId", 300),
    state,
  };
}

function statesEqual(
  left: WalmartListingIntegrityControlState,
  right: WalmartListingIntegrityControlState,
): boolean {
  return canonical(left) === canonical(right);
}

function eventIdentity(input: {
  run_id: string;
  item_control_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  payload_sha256: string;
  previous_event_hash: string;
}) {
  const eventHash = sha256(canonicalBytes({
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA,
    run_id: input.run_id,
    item_control_id: input.item_control_id,
    sequence: input.sequence,
    event_type: input.event_type,
    occurred_at: input.occurred_at,
    payload_sha256: input.payload_sha256,
    previous_event_hash: input.previous_event_hash,
  }));
  return {
    event_id: `wlie-${sha256(`${input.run_id}:${input.sequence}:${eventHash}`).slice(0, 32)}`,
    event_hash: eventHash,
  };
}

export async function persistWalmartListingIntegrityControlTransition(input: {
  current: WalmartListingIntegrityControlState;
  next: WalmartListingIntegrityControlState;
  evidence_bytes: Uint8Array;
  evidence_role: string;
  created_by_principal: string;
  store?: WalmartListingIntegrityControlRawTransactionHost;
}): Promise<WalmartListingIntegrityPersistedTransition> {
  const current = verifyWalmartListingIntegrityControlState(input.current);
  const next = verifyWalmartListingIntegrityControlState(input.next);
  if (next.previous_state_sha256 !== current.body_sha256
    || next.revision !== current.revision + 1
    || canonical(next.identity) !== canonical(current.identity)) {
    fail("TRANSITION_CHAIN_INVALID", "next state is not the exact successor of current state");
  }
  if (!(input.evidence_bytes instanceof Uint8Array) || input.evidence_bytes.byteLength < 2) {
    fail("TRANSITION_EVIDENCE_INVALID", "evidence bytes must be non-empty exact bytes");
  }
  const evidenceSha = sha256(input.evidence_bytes);
  if (evidenceSha !== next.evidence_sha256) {
    fail("TRANSITION_EVIDENCE_INVALID", "evidence bytes differ from the admitted state binding");
  }
  const evidenceRole = exactText(input.evidence_role, "evidence_role", 100);
  const principal = exactText(input.created_by_principal, "created_by_principal", 200);
  const host = input.store
    ?? prisma as unknown as WalmartListingIntegrityControlRawTransactionHost;

  return persistAtomicTransaction(() => host.$transaction(async (tx) => {
    // Prisma/libsql begins a deferred transaction. Acquire the database writer
    // before reading the CAS predecessor so SQLite never has to upgrade a
    // read snapshot after another writer commits. This is a logical no-op: the
    // exact run value is assigned to itself and remains byte-for-byte equal.
    const locked = await tx.$executeRawUnsafe(`
      UPDATE WalmartListingIntegrityControlRun
      SET updatedAt=updatedAt
      WHERE runId=? AND status='ACTIVE'
    `, current.identity.run_id);
    if (locked !== 1) {
      fail("TRANSITION_CAS_LOST", "exact active control run is missing or duplicated");
    }
    const rows = await tx.$queryRawUnsafe<PersistedItemRow[]>(`
      SELECT itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
             revision,stateBodySha256,previousStateSha256,evidenceSha256,
             executionPackageSha256,ownerPermitSha256,feedId,
             marketplaceWriteCalls,automaticRetryAllowed,
             automaticReplayAllowed,transitionedAt
      FROM WalmartListingIntegrityControlItem
      WHERE runId = ? AND listingKey = ?
    `, current.identity.run_id, current.identity.listing_key);
    if (rows.length !== 1) {
      fail("TRANSITION_CAS_LOST", "exact persisted control item is missing or duplicated");
    }
    const persisted = persistedState(rows[0]!, current);
    if (!statesEqual(persisted.state, current)) {
      fail("TRANSITION_CAS_LOST", "persisted control state differs from admitted predecessor");
    }

    const priorRows = await tx.$queryRawUnsafe<PriorEventRow[]>(`
      SELECT sequence,eventHash
      FROM WalmartListingIntegrityControlEvent
      WHERE runId = ?
      ORDER BY sequence DESC
      LIMIT 1
    `, current.identity.run_id);
    if (priorRows.length > 1) {
      fail("TRANSITION_EVENT_CHAIN_INVALID", "event predecessor query returned multiple rows");
    }
    const sequence = priorRows.length === 0
      ? 1 : exactInteger(priorRows[0]!.sequence, "event.sequence", 1) + 1;
    const previousEventHash = priorRows.length === 0
      ? WALMART_LISTING_INTEGRITY_CONTROL_ZERO_HASH
      : exactSha(priorRows[0]!.eventHash, "event.eventHash");
    const eventType = `STATE_${current.state}_TO_${next.state}`;
    const payload = canonicalBytes({
      schema_version: "walmart-listing-integrity-control-transition/v1",
      run_id: current.identity.run_id,
      item_control_id: persisted.itemControlId,
      listing_key: current.identity.listing_key,
      previous_state_body_sha256: current.body_sha256,
      next_state: next,
      evidence: {
        role: evidenceRole,
        sha256: evidenceSha,
        byte_size: input.evidence_bytes.byteLength,
        locator: `sha256:${evidenceSha}`,
      },
    });
    const payloadSha = sha256(payload);
    const event = eventIdentity({
      run_id: current.identity.run_id,
      item_control_id: persisted.itemControlId,
      sequence,
      event_type: eventType,
      occurred_at: next.transitioned_at,
      payload_sha256: payloadSha,
      previous_event_hash: previousEventHash,
    });
    const artifactId = `wlia-${sha256(`${current.identity.run_id}:${evidenceRole}:${evidenceSha}`).slice(0, 32)}`;

    await tx.$executeRawUnsafe(`
      INSERT INTO WalmartListingIntegrityControlArtifact (
        artifactId,runId,itemControlId,role,mediaType,byteSize,sha256,
        locator,createdAt,createdByPrincipal
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, artifactId, current.identity.run_id, persisted.itemControlId,
    evidenceRole, "application/json", input.evidence_bytes.byteLength,
    evidenceSha, `sha256:${evidenceSha}`, next.transitioned_at, principal);

    const changed = await tx.$executeRawUnsafe(`
      UPDATE WalmartListingIntegrityControlItem SET
        state=?,revision=?,stateBodySha256=?,previousStateSha256=?,
        evidenceSha256=?,executionPackageSha256=?,ownerPermitSha256=?,
        feedId=?,marketplaceWriteCalls=?,automaticRetryAllowed=?,
        automaticReplayAllowed=?,transitionedAt=?,updatedAt=?
      WHERE itemControlId=? AND state=? AND revision=? AND stateBodySha256=?
    `, next.state, next.revision, next.body_sha256, next.previous_state_sha256,
    next.evidence_sha256, next.execution_package_sha256,
    next.owner_permit_sha256, next.feed_id, next.marketplace_write_calls,
    false, false, next.transitioned_at, next.transitioned_at,
    persisted.itemControlId, current.state, current.revision, current.body_sha256);
    if (changed !== 1) {
      fail("TRANSITION_CAS_LOST", "persisted item changed before atomic transition commit");
    }

    await tx.$executeRawUnsafe(`
      INSERT INTO WalmartListingIntegrityControlEvent (
        eventId,runId,itemControlId,sequence,schemaVersion,eventType,
        occurredAt,payload,payloadSha256,previousEventHash,eventHash,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, event.event_id, current.identity.run_id, persisted.itemControlId,
    sequence, WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA, eventType,
    next.transitioned_at, payload, payloadSha, previousEventHash,
    event.event_hash, next.transitioned_at);
    await tx.$executeRawUnsafe(`
      UPDATE WalmartListingIntegrityControlRun SET updatedAt=? WHERE runId=?
    `, next.transitioned_at, current.identity.run_id);

    return {
      state: next,
      artifact: {
        artifact_id: artifactId,
        role: evidenceRole,
        sha256: evidenceSha,
        locator: `sha256:${evidenceSha}`,
        byte_size: input.evidence_bytes.byteLength,
      },
      event: {
        event_id: event.event_id,
        sequence,
        event_type: eventType,
        payload_sha256: payloadSha,
        previous_event_hash: previousEventHash,
        event_hash: event.event_hash,
      },
    };
  }));
}

export async function admitAndPersistWalmartListingIntegrityOperatorReceipt(input: {
  stage: WalmartListingIntegritySchedulerStage;
  current: WalmartListingIntegrityControlState;
  receipt_bytes: Uint8Array;
  store?: WalmartListingIntegrityControlRawTransactionHost;
}): Promise<WalmartListingIntegrityPersistedTransition> {
  const next = admitWalmartListingIntegrityOperatorReceipt({
    stage: input.stage,
    current: input.current,
    receipt_bytes: input.receipt_bytes,
  });
  return persistWalmartListingIntegrityControlTransition({
    current: input.current,
    next,
    evidence_bytes: input.receipt_bytes,
    evidence_role: `FROZEN_OPERATOR_${next.state}`,
    created_by_principal: "walmart-listing-integrity-frozen-worker",
    ...(input.store ? { store: input.store } : {}),
  });
}
