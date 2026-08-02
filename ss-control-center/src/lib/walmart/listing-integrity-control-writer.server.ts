import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";

import { prisma } from "@/lib/prisma";

import {
  verifyWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import {
  verifyWalmartListingIntegrityControlSeedPlan,
  type WalmartListingIntegrityControlSeedPlan,
} from "./listing-integrity-control-seed";
import {
  verifyWalmartListingIntegrityRunCompletionEvidence,
  type WalmartListingIntegrityRunCompletionEvidence,
} from "./listing-integrity-control-run-completion";

export const WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA =
  "walmart-listing-integrity-control-event/v1" as const;

interface RawControlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface TransactionalRawControlClient extends RawControlClient {
  $transaction<T>(operation: (client: RawControlClient) => Promise<T>): Promise<T>;
}

interface ItemRow {
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

interface EventHeadRow {
  sequence: unknown;
  eventHash: unknown;
}

interface RunCompletionRow {
  runId: unknown;
  poolBodySha256: unknown;
  releaseIdSha256: unknown;
  manifestSha256: unknown;
  status: unknown;
  updatedAt: unknown;
}

interface RunCompletionItemRow {
  ordinal: unknown;
  listingKey: unknown;
  sku: unknown;
  state: unknown;
  stateBodySha256: unknown;
}

const ZERO_SHA256 = "0".repeat(64);
const encoder = new TextEncoder();

export class WalmartListingIntegrityControlWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalmartListingIntegrityControlWriterError";
  }
}

function fail(message: string): never {
  throw new WalmartListingIntegrityControlWriterError(message);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(row[key])}`
  )).join(",")}}`;
}

function integer(value: unknown, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(`${label} is invalid`);
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value, "optional text");
}

function booleanFalse(value: unknown, label: string): false {
  if (value !== false && value !== 0
    && !(typeof value === "bigint" && value.toString() === "0")) {
    fail(`${label} must be false`);
  }
  return false;
}

function instant(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(text(value, label));
  if (!Number.isFinite(parsed.getTime())) fail(`${label} is invalid`);
  return parsed.toISOString();
}

function itemControlId(state: WalmartListingIntegrityControlState): string {
  return `wliitem-${walmartListingIntegrityControlSha256({
    run_id: state.identity.run_id,
    listing_key: state.identity.listing_key,
  }).slice(0, 32)}`;
}

function stateFromRow(
  row: ItemRow,
  poolBodySha256: string,
): WalmartListingIntegrityControlState {
  return verifyWalmartListingIntegrityControlState({
    schema_version: "walmart-listing-integrity-control-state/v1",
    identity: {
      run_id: text(row.runId, "runId"),
      pool_body_sha256: poolBodySha256,
      ordinal: integer(row.ordinal, "ordinal", 1),
      listing_key: text(row.listingKey, "listingKey"),
      sku: text(row.sku, "sku"),
      item_id: text(row.itemId, "itemId"),
      store_index: integer(row.storeIndex, "storeIndex", 1),
    },
    state: text(row.state, "state"),
    revision: integer(row.revision, "revision", 1),
    transitioned_at: instant(row.transitionedAt, "transitionedAt"),
    previous_state_sha256: optionalText(row.previousStateSha256),
    evidence_sha256: text(row.evidenceSha256, "evidenceSha256"),
    execution_package_sha256: optionalText(row.executionPackageSha256),
    owner_permit_sha256: optionalText(row.ownerPermitSha256),
    feed_id: optionalText(row.feedId),
    marketplace_write_calls: integer(row.marketplaceWriteCalls, "marketplaceWriteCalls", 0),
    automatic_retry_allowed: booleanFalse(row.automaticRetryAllowed, "automaticRetryAllowed"),
    automatic_replay_allowed: booleanFalse(row.automaticReplayAllowed, "automaticReplayAllowed"),
    body_sha256: text(row.stateBodySha256, "stateBodySha256"),
  });
}

async function appendEvent(input: {
  client: RawControlClient;
  runId: string;
  itemId: string | null;
  eventType: string;
  occurredAt: string;
  payload: unknown;
}) {
  const heads = await input.client.$queryRawUnsafe<EventHeadRow[]>(`
    SELECT sequence,eventHash FROM WalmartListingIntegrityControlEvent
    WHERE runId=? ORDER BY sequence DESC LIMIT 1
  `, input.runId);
  const previousSequence = heads[0] ? integer(heads[0].sequence, "event sequence", 1) : 0;
  const previousEventHash = heads[0]
    ? text(heads[0].eventHash, "previous event hash") : ZERO_SHA256;
  const sequence = previousSequence + 1;
  const payloadBytes = encoder.encode(canonical(input.payload));
  const payloadSha256 = walmartListingIntegrityControlSha256(input.payload);
  const eventBody = {
    run_id: input.runId,
    item_control_id: input.itemId,
    sequence,
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA,
    event_type: input.eventType,
    occurred_at: input.occurredAt,
    payload_sha256: payloadSha256,
    previous_event_hash: previousEventHash,
  };
  const eventHash = walmartListingIntegrityControlSha256(eventBody);
  const eventId = `wlievent-${eventHash.slice(0, 32)}`;
  await input.client.$executeRawUnsafe(`
    INSERT INTO WalmartListingIntegrityControlEvent (
      eventId,runId,itemControlId,sequence,schemaVersion,eventType,occurredAt,
      payload,payloadSha256,previousEventHash,eventHash,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `, eventId, input.runId, input.itemId, sequence,
  WALMART_LISTING_INTEGRITY_CONTROL_EVENT_SCHEMA, input.eventType,
  input.occurredAt, payloadBytes, payloadSha256, previousEventHash, eventHash,
  input.occurredAt);
  return { eventId, eventHash, sequence };
}

export async function seedWalmartListingIntegrityControlRun(input: {
  plan: WalmartListingIntegrityControlSeedPlan;
  client?: TransactionalRawControlClient;
}) {
  verifyWalmartListingIntegrityControlSeedPlan(input.plan);
  if (input.plan.external_active_listing_keys.length > 0) {
    fail("cannot persist a successor run while an external predecessor is active");
  }
  const client = input.client
    ?? prisma as unknown as TransactionalRawControlClient;
  return client.$transaction(async (tx) => {
    const { run } = input.plan;
    await tx.$executeRawUnsafe(`
      INSERT INTO WalmartListingIntegrityControlRun (
        runId,schemaVersion,poolBodySha256,releaseIdSha256,manifestSha256,
        runtimeStage,status,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `, run.run_id, "walmart-listing-integrity-control-run/v1",
    run.pool_body_sha256, run.release_id_sha256, run.manifest_sha256,
    "OFF", "ACTIVE", run.created_at, run.created_at);
    for (const state of input.plan.items) {
      const item = verifyWalmartListingIntegrityControlState(state);
      await tx.$executeRawUnsafe(`
        INSERT INTO WalmartListingIntegrityControlItem (
          itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
          revision,stateBodySha256,previousStateSha256,evidenceSha256,
          executionPackageSha256,ownerPermitSha256,feedId,
          marketplaceWriteCalls,automaticRetryAllowed,automaticReplayAllowed,
          transitionedAt,createdAt,updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, itemControlId(item), run.run_id, item.identity.ordinal,
      item.identity.listing_key, item.identity.sku, item.identity.item_id,
      item.identity.store_index, item.state, item.revision, item.body_sha256,
      item.previous_state_sha256, item.evidence_sha256,
      item.execution_package_sha256, item.owner_permit_sha256, item.feed_id,
      item.marketplace_write_calls, false, false, item.transitioned_at,
      run.created_at, run.created_at);
    }
    const event = await appendEvent({
      client: tx,
      runId: run.run_id,
      itemId: null,
      eventType: "RUN_SEEDED_DEFAULT_OFF",
      occurredAt: run.created_at,
      payload: input.plan,
    });
    return {
      runId: run.run_id,
      itemCount: input.plan.items.length,
      runtimeStage: "OFF" as const,
      event,
      databaseWrites: input.plan.items.length + 2,
      walmartWrites: 0 as const,
    };
  });
}

export async function completeWalmartListingIntegrityControlRun(input: {
  expected_run: {
    run_id: string;
    pool_body_sha256: string;
    release_id_sha256: string;
    manifest_sha256: string;
    status: "ACTIVE";
    updated_at: string;
    items: readonly WalmartListingIntegrityControlState[];
  };
  evidence_bytes: Uint8Array;
  client?: TransactionalRawControlClient;
}) {
  let evidence: WalmartListingIntegrityRunCompletionEvidence;
  try {
    evidence = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(
      input.evidence_bytes,
    )) as WalmartListingIntegrityRunCompletionEvidence;
  } catch {
    return fail("run completion evidence is not exact UTF-8 JSON");
  }
  verifyWalmartListingIntegrityRunCompletionEvidence(evidence);
  const expected = input.expected_run;
  if (expected.status !== "ACTIVE"
    || evidence.completed_at < instant(expected.updated_at, "run updated_at")
    || evidence.run.run_id !== expected.run_id
    || evidence.run.pool_body_sha256 !== expected.pool_body_sha256
    || evidence.run.release_id_sha256 !== expected.release_id_sha256
    || evidence.run.manifest_sha256 !== expected.manifest_sha256
    || evidence.terminal_items.length !== expected.items.length) {
    fail("completion evidence differs from the exact active run");
  }
  const expectedItems = [...expected.items]
    .sort((left, right) => left.identity.ordinal - right.identity.ordinal);
  for (let index = 0; index < expectedItems.length; index += 1) {
    const item = expectedItems[index]!;
    const claimed = evidence.terminal_items[index]!;
    if (claimed.ordinal !== item.identity.ordinal
      || claimed.listing_key !== item.identity.listing_key
      || claimed.sku !== item.identity.sku
      || claimed.state !== item.state
      || claimed.state_body_sha256 !== item.body_sha256) {
      fail("completion evidence terminal item differs from the run snapshot");
    }
  }
  const evidenceFileSha256 = createHash("sha256").update(input.evidence_bytes).digest("hex");
  const client = input.client
    ?? prisma as unknown as TransactionalRawControlClient;
  return client.$transaction(async (tx) => {
    const runs = await tx.$queryRawUnsafe<RunCompletionRow[]>(`
      SELECT runId,poolBodySha256,releaseIdSha256,manifestSha256,status,updatedAt
      FROM WalmartListingIntegrityControlRun WHERE runId=? LIMIT 2
    `, expected.run_id);
    if (runs.length !== 1) fail("exact completion run does not exist");
    const run = runs[0]!;
    const persistedRun = {
      run_id: text(run.runId, "runId"),
      pool_body_sha256: text(run.poolBodySha256, "poolBodySha256"),
      release_id_sha256: text(run.releaseIdSha256, "releaseIdSha256"),
      manifest_sha256: text(run.manifestSha256, "manifestSha256"),
      status: text(run.status, "status"),
      updated_at: instant(run.updatedAt, "updatedAt"),
    };
    if (persistedRun.run_id !== expected.run_id
      || persistedRun.pool_body_sha256 !== expected.pool_body_sha256
      || persistedRun.release_id_sha256 !== expected.release_id_sha256
      || persistedRun.manifest_sha256 !== expected.manifest_sha256
      || persistedRun.status !== "ACTIVE"
      || persistedRun.updated_at !== instant(expected.updated_at, "expected updatedAt")) {
      fail(`persisted completion run changed before atomic close: ${JSON.stringify(persistedRun)}`);
    }
    const rows = await tx.$queryRawUnsafe<RunCompletionItemRow[]>(`
      SELECT ordinal,listingKey,sku,state,stateBodySha256
      FROM WalmartListingIntegrityControlItem WHERE runId=? ORDER BY ordinal ASC
    `, expected.run_id);
    if (rows.length !== expectedItems.length) {
      fail("persisted terminal population differs from completion evidence");
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const item = expectedItems[index]!;
      if (integer(row.ordinal, "ordinal", 1) !== item.identity.ordinal
        || text(row.listingKey, "listingKey") !== item.identity.listing_key
        || text(row.sku, "sku") !== item.identity.sku
        || text(row.state, "state") !== item.state
        || text(row.stateBodySha256, "stateBodySha256") !== item.body_sha256) {
        fail("persisted terminal item changed before atomic close");
      }
    }
    const artifactId = `wlia-${walmartListingIntegrityControlSha256({
      run_id: expected.run_id,
      role: "RUN_COMPLETION_EVIDENCE",
      sha256: evidenceFileSha256,
    }).slice(0, 32)}`;
    await tx.$executeRawUnsafe(`
      INSERT INTO WalmartListingIntegrityControlArtifact (
        artifactId,runId,itemControlId,role,mediaType,byteSize,sha256,
        locator,createdAt,createdByPrincipal
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, artifactId, expected.run_id, null, "RUN_COMPLETION_EVIDENCE",
    "application/json", input.evidence_bytes.byteLength, evidenceFileSha256,
    `sha256:${evidenceFileSha256}`, evidence.completed_at,
    "walmart-listing-integrity-successor");
    const event = await appendEvent({
      client: tx,
      runId: expected.run_id,
      itemId: null,
      eventType: "RUN_COMPLETED",
      occurredAt: evidence.completed_at,
      payload: evidence,
    });
    const changed = await tx.$executeRawUnsafe(`
      UPDATE WalmartListingIntegrityControlRun SET status='COMPLETED',updatedAt=?
      WHERE runId=? AND status='ACTIVE' AND poolBodySha256=?
        AND releaseIdSha256=? AND manifestSha256=? AND updatedAt=?
    `, evidence.completed_at, expected.run_id, expected.pool_body_sha256,
    expected.release_id_sha256, expected.manifest_sha256, expected.updated_at);
    if (changed !== 1) fail("active run completion CAS was lost");
    return {
      status: "CONTROL_RUN_COMPLETED" as const,
      run_id: expected.run_id,
      terminal_item_count: expectedItems.length,
      evidence_file_sha256: evidenceFileSha256,
      event,
      database_writes: 3,
      walmart_writes: 0 as const,
    };
  });
}

export async function persistWalmartListingIntegrityControlTransition(input: {
  next: WalmartListingIntegrityControlState;
  expected_current_body_sha256: string;
  event_type: string;
  client?: TransactionalRawControlClient;
}) {
  const next = verifyWalmartListingIntegrityControlState(input.next);
  if (next.previous_state_sha256 !== input.expected_current_body_sha256) {
    fail("next state does not bind the expected current state");
  }
  const client = input.client
    ?? prisma as unknown as TransactionalRawControlClient;
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<ItemRow[]>(`
      SELECT itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
             revision,stateBodySha256,previousStateSha256,evidenceSha256,
             executionPackageSha256,ownerPermitSha256,feedId,
             marketplaceWriteCalls,automaticRetryAllowed,automaticReplayAllowed,
             transitionedAt
      FROM WalmartListingIntegrityControlItem
      WHERE runId=? AND listingKey=? LIMIT 2
    `, next.identity.run_id, next.identity.listing_key);
    if (rows.length !== 1) fail("exact persisted control item was not found");
    const row = rows[0];
    const current = stateFromRow(row, next.identity.pool_body_sha256);
    if (current.body_sha256 !== input.expected_current_body_sha256
      || next.revision !== current.revision + 1
      || walmartListingIntegrityControlSha256(next.identity)
        !== walmartListingIntegrityControlSha256(current.identity)) {
      fail("persisted predecessor or exact listing identity changed");
    }
    const changed = await tx.$executeRawUnsafe(`
      UPDATE WalmartListingIntegrityControlItem SET
        state=?,revision=?,stateBodySha256=?,previousStateSha256=?,
        evidenceSha256=?,executionPackageSha256=?,ownerPermitSha256=?,feedId=?,
        marketplaceWriteCalls=?,automaticRetryAllowed=false,
        automaticReplayAllowed=false,transitionedAt=?,updatedAt=?
      WHERE itemControlId=? AND stateBodySha256=? AND revision=?
    `, next.state, next.revision, next.body_sha256, next.previous_state_sha256,
    next.evidence_sha256, next.execution_package_sha256,
    next.owner_permit_sha256, next.feed_id, next.marketplace_write_calls,
    next.transitioned_at, next.transitioned_at, text(row.itemControlId, "itemControlId"),
    input.expected_current_body_sha256, current.revision);
    if (changed !== 1) fail("optimistic transition claim was not exclusive");
    const event = await appendEvent({
      client: tx,
      runId: next.identity.run_id,
      itemId: text(row.itemControlId, "itemControlId"),
      eventType: input.event_type,
      occurredAt: next.transitioned_at,
      payload: next,
    });
    return { state: next, event, databaseWrites: 2 as const, walmartWrites: 0 as const };
  });
}
