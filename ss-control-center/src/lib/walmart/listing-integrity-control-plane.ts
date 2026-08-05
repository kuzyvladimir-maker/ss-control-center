import { createHash } from "node:crypto";

export const WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA =
  "walmart-listing-integrity-control-state/v1" as const;

export const WALMART_LISTING_INTEGRITY_CONTROL_STATES = Object.freeze([
  "QUEUED",
  "DIAGNOSING",
  "AUDITED_PASS",
  "ISSUE_PROVEN",
  "QUARANTINED_SOURCE_REQUIRED",
  "REPAIR_PLANNED",
  "AWAITING_OWNER",
  "OWNER_APPROVED",
  "APPLY_REQUESTING",
  "APPLIED",
  "PROPAGATING",
  "LIVE_REREAD",
  "QUALIFIED_PASS",
  "QUARANTINED_UNRESOLVED",
  "MANUAL_REVIEW",
] as const);

export type WalmartListingIntegrityControlStateName =
  typeof WALMART_LISTING_INTEGRITY_CONTROL_STATES[number];

export type WalmartListingIntegritySchedulerStage =
  | "OFF"
  | "READ_ONLY"
  | "ONE_SKU";

export interface WalmartListingIntegrityControlIdentity {
  run_id: string;
  pool_body_sha256: string;
  ordinal: number;
  listing_key: string;
  sku: string;
  item_id: string;
  store_index: number;
}

export interface WalmartListingIntegrityControlState {
  schema_version: typeof WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA;
  identity: WalmartListingIntegrityControlIdentity;
  state: WalmartListingIntegrityControlStateName;
  revision: number;
  transitioned_at: string;
  previous_state_sha256: string | null;
  evidence_sha256: string;
  execution_package_sha256: string | null;
  owner_permit_sha256: string | null;
  feed_id: string | null;
  marketplace_write_calls: 0 | 1;
  automatic_retry_allowed: false;
  automatic_replay_allowed: false;
  body_sha256: string;
}

export type WalmartListingIntegritySchedulerDecision =
  | { action: "STOP_DEFAULT_OFF"; listing_key: string | null }
  | { action: "RUN_DIAGNOSE"; listing_key: string }
  | { action: "ADVANCE_TO_NEXT_SKU"; listing_key: string }
  | { action: "PREPARE_REPAIR_PLAN"; listing_key: string }
  | { action: "WAIT_OWNER_APPROVAL"; listing_key: string }
  | { action: "RUN_FROZEN_EXECUTE"; listing_key: string }
  | { action: "POLL_EXACT_FEED_GET_ONLY"; listing_key: string; feed_id: string }
  | { action: "RUN_FRESH_QUALIFICATION"; listing_key: string; feed_id: string }
  | { action: "STOP_MANUAL_REVIEW"; listing_key: string }
  | { action: "QUEUE_COMPLETE"; listing_key: null };

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,767}$/u;
const CONTROL_STATES = new Set<string>(WALMART_LISTING_INTEGRITY_CONTROL_STATES);
const TERMINAL_ADVANCE_STATES = new Set<WalmartListingIntegrityControlStateName>([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);
const APPLY_IN_FLIGHT_STATES = new Set<WalmartListingIntegrityControlStateName>([
  "APPLY_REQUESTING",
  "APPLIED",
  "PROPAGATING",
  "LIVE_REREAD",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<
  WalmartListingIntegrityControlStateName,
  readonly WalmartListingIntegrityControlStateName[]
>> = Object.freeze({
  QUEUED: ["DIAGNOSING"],
  DIAGNOSING: ["AUDITED_PASS", "ISSUE_PROVEN", "QUARANTINED_SOURCE_REQUIRED", "MANUAL_REVIEW"],
  AUDITED_PASS: [],
  ISSUE_PROVEN: ["REPAIR_PLANNED", "QUARANTINED_UNRESOLVED", "MANUAL_REVIEW"],
  QUARANTINED_SOURCE_REQUIRED: [],
  REPAIR_PLANNED: ["AWAITING_OWNER", "MANUAL_REVIEW"],
  AWAITING_OWNER: ["OWNER_APPROVED", "QUARANTINED_UNRESOLVED", "MANUAL_REVIEW"],
  OWNER_APPROVED: ["APPLY_REQUESTING", "MANUAL_REVIEW"],
  APPLY_REQUESTING: ["APPLIED", "MANUAL_REVIEW"],
  APPLIED: ["PROPAGATING", "LIVE_REREAD", "QUARANTINED_UNRESOLVED", "MANUAL_REVIEW"],
  PROPAGATING: ["LIVE_REREAD", "QUARANTINED_UNRESOLVED", "MANUAL_REVIEW"],
  // A fresh Qualification may legitimately remain PENDING_PROPAGATION until
  // Walmart's buyer surface catches up. Keep the item in LIVE_REREAD so the
  // scheduler repeats Qualification; returning to PROPAGATING would
  // incorrectly poll an already-terminal feed.
  LIVE_REREAD: ["LIVE_REREAD", "QUALIFIED_PASS", "QUARANTINED_UNRESOLVED", "MANUAL_REVIEW"],
  QUALIFIED_PASS: [],
  QUARANTINED_UNRESOLVED: [],
  MANUAL_REVIEW: [],
});

export class WalmartListingIntegrityControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalmartListingIntegrityControlPlaneError";
  }
}

function fail(message: string): never {
  throw new WalmartListingIntegrityControlPlaneError(message);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(",")}}`;
}

export function walmartListingIntegrityControlSha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || value !== value.trim() || !value
    || value.length > maximum || !SAFE_ID.test(value)) {
    fail(`${label} must be bounded safe text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be canonical UTC`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function parseIdentity(value: unknown): WalmartListingIntegrityControlIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("identity must be an object");
  }
  const identity = value as Record<string, unknown>;
  return {
    run_id: exactText(identity.run_id, "identity.run_id", 200),
    pool_body_sha256: exactSha(identity.pool_body_sha256, "identity.pool_body_sha256"),
    ordinal: positiveInteger(identity.ordinal, "identity.ordinal"),
    listing_key: exactText(identity.listing_key, "identity.listing_key"),
    sku: exactText(identity.sku, "identity.sku", 500),
    item_id: exactText(identity.item_id, "identity.item_id", 100),
    store_index: positiveInteger(identity.store_index, "identity.store_index"),
  };
}

function withoutBodySha(state: WalmartListingIntegrityControlState) {
  const body = { ...state } as Partial<WalmartListingIntegrityControlState>;
  delete body.body_sha256;
  return body;
}

export function verifyWalmartListingIntegrityControlState(
  value: unknown,
): WalmartListingIntegrityControlState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("control state must be an object");
  }
  const state = value as WalmartListingIntegrityControlState;
  if (state.schema_version !== WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA
    || !CONTROL_STATES.has(String(state.state))) {
    fail("control state schema or state is invalid");
  }
  parseIdentity(state.identity);
  positiveInteger(state.revision, "revision");
  instant(state.transitioned_at, "transitioned_at");
  if (state.previous_state_sha256 !== null) {
    exactSha(state.previous_state_sha256, "previous_state_sha256");
  }
  exactSha(state.evidence_sha256, "evidence_sha256");
  if (state.execution_package_sha256 !== null) {
    exactSha(state.execution_package_sha256, "execution_package_sha256");
  }
  if (state.owner_permit_sha256 !== null) {
    exactSha(state.owner_permit_sha256, "owner_permit_sha256");
  }
  if (state.feed_id !== null) exactText(state.feed_id, "feed_id", 500);
  if (![0, 1].includes(state.marketplace_write_calls)
    || state.automatic_retry_allowed !== false
    || state.automatic_replay_allowed !== false
    || walmartListingIntegrityControlSha256(withoutBodySha(state)) !== state.body_sha256) {
    fail("control state seal or immutable policy differs");
  }
  if (state.marketplace_write_calls === 1 && !state.owner_permit_sha256) {
    fail("a marketplace write requires an exact owner permit");
  }
  if (APPLY_IN_FLIGHT_STATES.has(state.state)
    && (!state.execution_package_sha256 || !state.owner_permit_sha256)) {
    fail("apply lifecycle requires exact package and owner permit bindings");
  }
  if (["APPLIED", "PROPAGATING", "LIVE_REREAD", "QUALIFIED_PASS"].includes(state.state)
    && (!state.feed_id || state.marketplace_write_calls !== 1)) {
    fail("post-apply lifecycle requires one write and one exact feed");
  }
  return state;
}

function sealControlState(
  body: Omit<WalmartListingIntegrityControlState, "body_sha256">,
): WalmartListingIntegrityControlState {
  return Object.freeze({
    ...body,
    identity: Object.freeze({ ...body.identity }),
    body_sha256: walmartListingIntegrityControlSha256(body),
  });
}

export function createWalmartListingIntegrityQueuedState(input: {
  identity: WalmartListingIntegrityControlIdentity;
  created_at: string;
  queue_evidence_sha256: string;
}): WalmartListingIntegrityControlState {
  const state = sealControlState({
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA,
    identity: parseIdentity(input.identity),
    state: "QUEUED",
    revision: 1,
    transitioned_at: instant(input.created_at, "created_at"),
    previous_state_sha256: null,
    evidence_sha256: exactSha(input.queue_evidence_sha256, "queue_evidence_sha256"),
    execution_package_sha256: null,
    owner_permit_sha256: null,
    feed_id: null,
    marketplace_write_calls: 0,
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
  });
  return verifyWalmartListingIntegrityControlState(state);
}

function exactSameIdentity(
  left: WalmartListingIntegrityControlIdentity,
  right: WalmartListingIntegrityControlIdentity,
): boolean {
  return walmartListingIntegrityControlSha256(left)
    === walmartListingIntegrityControlSha256(right);
}

export function transitionWalmartListingIntegrityControlState(input: {
  current: WalmartListingIntegrityControlState;
  next_state: WalmartListingIntegrityControlStateName;
  transitioned_at: string;
  evidence_sha256: string;
  execution_package_sha256?: string | null;
  owner_permit_sha256?: string | null;
  feed_id?: string | null;
  marketplace_write_calls?: 0 | 1;
}): WalmartListingIntegrityControlState {
  const current = verifyWalmartListingIntegrityControlState(input.current);
  if (!ALLOWED_TRANSITIONS[current.state].includes(input.next_state)) {
    fail(`transition ${current.state} -> ${input.next_state} is not permitted`);
  }
  if (Date.parse(input.transitioned_at) < Date.parse(current.transitioned_at)) {
    fail("transition time moved backwards");
  }
  const next = sealControlState({
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA,
    identity: current.identity,
    state: input.next_state,
    revision: current.revision + 1,
    transitioned_at: instant(input.transitioned_at, "transitioned_at"),
    previous_state_sha256: current.body_sha256,
    evidence_sha256: exactSha(input.evidence_sha256, "evidence_sha256"),
    execution_package_sha256: input.execution_package_sha256
      ?? current.execution_package_sha256,
    owner_permit_sha256: input.owner_permit_sha256 ?? current.owner_permit_sha256,
    feed_id: input.feed_id ?? current.feed_id,
    marketplace_write_calls: input.marketplace_write_calls
      ?? current.marketplace_write_calls,
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
  });
  const verified = verifyWalmartListingIntegrityControlState(next);
  if (!exactSameIdentity(verified.identity, current.identity)) {
    fail("transition changed listing identity");
  }
  if (verified.state === "APPLY_REQUESTING"
    && (verified.marketplace_write_calls !== 0 || verified.feed_id !== null)) {
    fail("APPLY_REQUESTING must precede the sole write/feed response");
  }
  if (verified.state === "APPLIED"
    && (verified.marketplace_write_calls !== 1 || !verified.feed_id)) {
    fail("APPLIED requires exactly one write and exact feed id");
  }
  return verified;
}

export function recoverWalmartListingIntegrityCaptureLogFalseQuarantine(input: {
  current: WalmartListingIntegrityControlState;
  recovered_at: string;
  recovery_evidence_sha256: string;
}): WalmartListingIntegrityControlState {
  const current = verifyWalmartListingIntegrityControlState(input.current);
  if (!["QUARANTINED_SOURCE_REQUIRED", "DIAGNOSING"].includes(current.state)
    || current.marketplace_write_calls !== 0
    || current.execution_package_sha256 !== null
    || current.owner_permit_sha256 !== null
    || current.feed_id !== null) {
    fail("capture-log recovery requires one zero-write diagnosis-only state");
  }
  if (Date.parse(input.recovered_at) < Date.parse(current.transitioned_at)) {
    fail("capture-log recovery time moved backwards");
  }
  return verifyWalmartListingIntegrityControlState(sealControlState({
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_STATE_SCHEMA,
    identity: current.identity,
    state: "QUEUED",
    revision: current.revision + 1,
    transitioned_at: instant(input.recovered_at, "recovered_at"),
    previous_state_sha256: current.body_sha256,
    evidence_sha256: exactSha(
      input.recovery_evidence_sha256,
      "recovery_evidence_sha256",
    ),
    execution_package_sha256: null,
    owner_permit_sha256: null,
    feed_id: null,
    marketplace_write_calls: 0,
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
  }));
}

function decisionForState(
  state: WalmartListingIntegrityControlState,
): WalmartListingIntegritySchedulerDecision {
  const listingKey = state.identity.listing_key;
  switch (state.state) {
    case "QUEUED":
    case "DIAGNOSING":
      return { action: "RUN_DIAGNOSE", listing_key: listingKey };
    case "AUDITED_PASS":
    case "QUALIFIED_PASS":
    case "QUARANTINED_SOURCE_REQUIRED":
    case "QUARANTINED_UNRESOLVED":
      return { action: "ADVANCE_TO_NEXT_SKU", listing_key: listingKey };
    case "ISSUE_PROVEN":
    case "REPAIR_PLANNED":
      return { action: "PREPARE_REPAIR_PLAN", listing_key: listingKey };
    case "AWAITING_OWNER":
      return { action: "WAIT_OWNER_APPROVAL", listing_key: listingKey };
    case "OWNER_APPROVED":
    case "APPLY_REQUESTING":
      return { action: "RUN_FROZEN_EXECUTE", listing_key: listingKey };
    case "APPLIED":
    case "PROPAGATING":
      return {
        action: "POLL_EXACT_FEED_GET_ONLY",
        listing_key: listingKey,
        feed_id: state.feed_id as string,
      };
    case "LIVE_REREAD":
      return {
        action: "RUN_FRESH_QUALIFICATION",
        listing_key: listingKey,
        feed_id: state.feed_id as string,
      };
    case "MANUAL_REVIEW":
      return { action: "STOP_MANUAL_REVIEW", listing_key: listingKey };
  }
}

export function nextWalmartListingIntegritySchedulerDecision(input: {
  stage: WalmartListingIntegritySchedulerStage;
  items: readonly WalmartListingIntegrityControlState[];
}): WalmartListingIntegritySchedulerDecision {
  const items = input.items.map(verifyWalmartListingIntegrityControlState)
    .sort((left, right) => left.identity.ordinal - right.identity.ordinal);
  const listingKeys = new Set(items.map((item) => item.identity.listing_key));
  const ordinals = new Set(items.map((item) => item.identity.ordinal));
  if (listingKeys.size !== items.length || ordinals.size !== items.length) {
    fail("queue contains duplicate listing keys or ordinals");
  }
  if (items.some((item) => item.identity.run_id !== items[0]?.identity.run_id
      || item.identity.pool_body_sha256 !== items[0]?.identity.pool_body_sha256)) {
    fail("queue mixes runs or pool identities");
  }
  const inFlight = items.filter((item) => APPLY_IN_FLIGHT_STATES.has(item.state));
  if (inFlight.length > 1) fail("more than one live apply is in flight");

  const activeIndex = items.findIndex((item) => !TERMINAL_ADVANCE_STATES.has(item.state));
  if (activeIndex < 0) return { action: "QUEUE_COMPLETE", listing_key: null };
  if (items.slice(activeIndex + 1).some((item) => item.state !== "QUEUED")) {
    fail("a later SKU advanced before the strict predecessor terminalized");
  }
  const active = items[activeIndex];
  if (input.stage === "OFF") {
    return { action: "STOP_DEFAULT_OFF", listing_key: active.identity.listing_key };
  }
  const decision = decisionForState(active);
  if (input.stage === "READ_ONLY"
    && ["RUN_FROZEN_EXECUTE", "POLL_EXACT_FEED_GET_ONLY", "RUN_FRESH_QUALIFICATION"]
      .includes(decision.action)) {
    return { action: "STOP_DEFAULT_OFF", listing_key: active.identity.listing_key };
  }
  return decision;
}
