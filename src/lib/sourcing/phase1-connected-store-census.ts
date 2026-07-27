import { createHash } from "node:crypto";

export const PHASE1_CONNECTED_STORE_CAPTURE_VERSION =
  "phase1-connected-store-capture/v1" as const;
export const PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION =
  "phase1-connected-store-owner-attestation/v1" as const;
export const PHASE1_CONNECTED_STORE_CENSUS_VERSION =
  "phase1-connected-store-census/v1" as const;
export const PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION =
  "phase1-connected-store-census-policy/1.0.0" as const;

export const PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT =
  "ALL_SUPPORTED_AND_CONNECTED_AMAZON_WALMART_STORE_SCOPES_ARE_ENUMERATED" as const;

export type Phase1ConnectedStoreChannel = "amazon" | "walmart";
export type Phase1ConnectedStoreStatus =
  | "CONNECTED"
  | "NOT_CONNECTED"
  | "UNRESOLVED";
export type Phase1StoreDirectoryState =
  | "ACTIVE"
  | "INACTIVE"
  | "ABSENT"
  | "UNKNOWN";
export type Phase1CredentialState =
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "UNKNOWN";

export interface Phase1ConnectedStoreSourceArtifact {
  kind: "STORE_DIRECTORY_SNAPSHOT" | "DEPLOYMENT_CONFIGURATION_SNAPSHOT";
  captureId: string;
  capturedAt: string;
  capturedBy: string;
  sourceName: string;
  contentSha256: string;
}

export interface Phase1ConnectedStoreCaptureScope {
  channel: Phase1ConnectedStoreChannel;
  scopeKey: string;
  storeIndex: number;
  connectionStatus: Phase1ConnectedStoreStatus;
  directoryState: Phase1StoreDirectoryState;
  credentialState: Phase1CredentialState;
  accountId: string | null;
  storeId: string | null;
  marketplaceId: string | null;
}

export interface Phase1ConnectedStoreCapture {
  schemaVersion: typeof PHASE1_CONNECTED_STORE_CAPTURE_VERSION;
  captureId: string;
  capturedAt: string;
  capturedBy: string;
  environment: string;
  target: string;
  supportContracts: {
    amazon: "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5";
    walmart: "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET";
  };
  supportedStoreIndexes: Record<Phase1ConnectedStoreChannel, number[]>;
  sourceArtifacts: Phase1ConnectedStoreSourceArtifact[];
  scopes: Phase1ConnectedStoreCaptureScope[];
}

export interface Phase1ConnectedStoreOwnerAttestation {
  schemaVersion: typeof PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION;
  authority: "OWNER";
  attestationId: string;
  attestedBy: string;
  attestedAt: string;
  captureSha256: string;
  statement: typeof PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT;
}

export type Phase1ConnectedStoreCensusBlockerCode =
  | "INVALID_CENSUS_AS_OF"
  | "INVALID_CENSUS_CONFIGURATION"
  | "INVALID_CENSUS_CAPTURE"
  | "INVALID_CENSUS_SOURCE_PROVENANCE"
  | "INVALID_CENSUS_SUPPORT_CONTRACT"
  | "INVALID_CENSUS_SUPPORTED_INDEXES"
  | "MISSING_CENSUS_SLOT"
  | "DUPLICATE_CENSUS_SLOT"
  | "UNSUPPORTED_CENSUS_SLOT"
  | "INVALID_CENSUS_SCOPE"
  | "CENSUS_SCOPE_STATUS_MISMATCH"
  | "UNRESOLVED_CONNECTED_STORE_SCOPE"
  | "INVALID_CENSUS_OWNER_ATTESTATION"
  | "CENSUS_CAPTURE_HASH_MISMATCH"
  | "CENSUS_CAPTURE_IN_FUTURE"
  | "CENSUS_CAPTURE_STALE"
  | "CENSUS_SOURCE_IN_FUTURE"
  | "NON_CANONICAL_CENSUS_ARTIFACT"
  | "INVALID_CENSUS_ARTIFACT";

export interface Phase1ConnectedStoreCensusBlocker {
  code: Phase1ConnectedStoreCensusBlockerCode;
  channel: Phase1ConnectedStoreChannel | null;
  scopeKey: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface Phase1ConnectedStoreCensusArtifact {
  schemaVersion: typeof PHASE1_CONNECTED_STORE_CENSUS_VERSION;
  asOf: string;
  authoritative: boolean;
  policy: {
    builderPolicyVersion: typeof PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION;
    amazonSupportContract: "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5";
    walmartSupportContract: "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET";
    requiredScopeRule: "CONNECTED_OR_UNRESOLVED";
    maxCaptureAgeHours: number;
    captureSha256: string;
  };
  capture: Phase1ConnectedStoreCapture | null;
  ownerAttestation: Phase1ConnectedStoreOwnerAttestation | null;
  requiredScopes: Record<Phase1ConnectedStoreChannel, string[]>;
  counts: {
    supportedSlots: number;
    connectedScopes: number;
    notConnectedScopes: number;
    unresolvedScopes: number;
    requiredScopes: number;
    blockerCount: number;
  };
  blockers: Phase1ConnectedStoreCensusBlocker[];
}

export interface BuildPhase1ConnectedStoreCensusInput {
  asOf: string;
  capture: unknown;
  ownerAttestation: unknown;
  maxCaptureAgeHours?: number;
}

export interface InspectPhase1ConnectedStoreCensusResult {
  artifact: Phase1ConnectedStoreCensusArtifact;
  canonicalJson: string;
  errors: string[];
}

const AMAZON_SUPPORTED_STORE_INDEXES = [1, 2, 3, 4, 5] as const;
const DEFAULT_MAX_CAPTURE_AGE_HOURS = 36;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 ? result : null;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function positiveStoreIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const child = value[key];
    if (child !== undefined) result[key] = stableJsonValue(child);
  }
  return result;
}

export function stablePhase1CensusJsonStringify(value: unknown, spaces = 2): string {
  return JSON.stringify(stableJsonValue(value), null, spaces);
}

export function phase1CensusSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function renderPhase1ConnectedStoreCaptureCanonicalJson(
  capture: Phase1ConnectedStoreCapture,
): string {
  const canonicalCapture: Phase1ConnectedStoreCapture = {
    ...capture,
    supportedStoreIndexes: {
      amazon: [...capture.supportedStoreIndexes.amazon].sort((left, right) => left - right),
      walmart: [...capture.supportedStoreIndexes.walmart].sort((left, right) => left - right),
    },
    sourceArtifacts: [...capture.sourceArtifacts].sort((left, right) =>
      compareText(left.kind, right.kind),
    ),
    scopes: [...capture.scopes].sort((left, right) =>
      compareText(left.channel, right.channel) || left.storeIndex - right.storeIndex,
    ),
  };
  return `${stablePhase1CensusJsonStringify(canonicalCapture, 0)}\n`;
}

export function computePhase1ConnectedStoreCaptureSha256(
  capture: Phase1ConnectedStoreCapture,
): string {
  return phase1CensusSha256Hex(renderPhase1ConnectedStoreCaptureCanonicalJson(capture));
}

export function renderPhase1ConnectedStoreCensusJson(
  artifact: Phase1ConnectedStoreCensusArtifact,
): string {
  return `${stablePhase1CensusJsonStringify(artifact, 2)}\n`;
}

function normalizeSupportedIndexes(
  value: unknown,
  channel: Phase1ConnectedStoreChannel,
  addBlocker: (blocker: Phase1ConnectedStoreCensusBlocker) => void,
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    addBlocker({
      code: "INVALID_CENSUS_SUPPORTED_INDEXES",
      channel,
      scopeKey: null,
      message: `Census must explicitly enumerate every supported ${channel} store index.`,
      details: null,
    });
    return [];
  }
  const result: number[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    const index = positiveStoreIndex(raw);
    if (index === null || seen.has(index)) {
      addBlocker({
        code: "INVALID_CENSUS_SUPPORTED_INDEXES",
        channel,
        scopeKey: null,
        message: `Supported ${channel} store indexes must be positive, unique integers.`,
        details: { received: raw ?? null },
      });
      continue;
    }
    seen.add(index);
    result.push(index);
  }
  result.sort((left, right) => left - right);
  return result;
}

function normalizeSourceArtifacts(
  value: unknown,
  captureMs: number | null,
  addBlocker: (blocker: Phase1ConnectedStoreCensusBlocker) => void,
): Phase1ConnectedStoreSourceArtifact[] {
  if (!Array.isArray(value)) {
    addBlocker({
      code: "INVALID_CENSUS_SOURCE_PROVENANCE",
      channel: null,
      scopeKey: null,
      message: "Capture must bind its store-directory and deployment-config snapshots.",
      details: null,
    });
    return [];
  }
  const artifacts: Phase1ConnectedStoreSourceArtifact[] = [];
  const kinds = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) {
      addBlocker({
        code: "INVALID_CENSUS_SOURCE_PROVENANCE",
        channel: null,
        scopeKey: null,
        message: `sourceArtifacts[${index}] must be an object.`,
        details: null,
      });
      continue;
    }
    const kind = raw.kind === "STORE_DIRECTORY_SNAPSHOT"
      || raw.kind === "DEPLOYMENT_CONFIGURATION_SNAPSHOT"
      ? raw.kind
      : null;
    const captureId = nonEmptyString(raw.captureId);
    const capturedAt = normalizeIsoTimestamp(raw.capturedAt);
    const capturedBy = nonEmptyString(raw.capturedBy);
    const sourceName = nonEmptyString(raw.sourceName);
    const contentSha256 = nonEmptyString(raw.contentSha256)?.toLowerCase() ?? null;
    if (
      !kind || !captureId || !capturedAt || !capturedBy || !sourceName
      || !contentSha256 || !/^[a-f0-9]{64}$/.test(contentSha256)
    ) {
      addBlocker({
        code: "INVALID_CENSUS_SOURCE_PROVENANCE",
        channel: null,
        scopeKey: null,
        message: `sourceArtifacts[${index}] needs kind, capture provenance, and a lowercase SHA-256.`,
        details: null,
      });
      continue;
    }
    if (kinds.has(kind)) {
      addBlocker({
        code: "INVALID_CENSUS_SOURCE_PROVENANCE",
        channel: null,
        scopeKey: null,
        message: `Source artifact kind ${kind} occurs more than once.`,
        details: null,
      });
    }
    kinds.add(kind);
    if (captureMs !== null && Date.parse(capturedAt) > captureMs) {
      addBlocker({
        code: "CENSUS_SOURCE_IN_FUTURE",
        channel: null,
        scopeKey: null,
        message: `${kind} was captured after the combined connected-store capture.`,
        details: { capturedAt },
      });
    }
    artifacts.push({ kind, captureId, capturedAt, capturedBy, sourceName, contentSha256 });
  }
  for (const required of [
    "STORE_DIRECTORY_SNAPSHOT",
    "DEPLOYMENT_CONFIGURATION_SNAPSHOT",
  ] as const) {
    if (!kinds.has(required)) {
      addBlocker({
        code: "INVALID_CENSUS_SOURCE_PROVENANCE",
        channel: null,
        scopeKey: null,
        message: `Capture is missing ${required} provenance.`,
        details: null,
      });
    }
  }
  return artifacts.sort((left, right) => compareText(left.kind, right.kind));
}

function expectedConnectionStatus(
  directoryState: Phase1StoreDirectoryState,
  credentialState: Phase1CredentialState,
): Phase1ConnectedStoreStatus {
  if (directoryState === "ACTIVE" && credentialState === "CONFIGURED") {
    return "CONNECTED";
  }
  if (
    (directoryState === "INACTIVE" || directoryState === "ABSENT")
    && credentialState === "NOT_CONFIGURED"
  ) {
    return "NOT_CONNECTED";
  }
  return "UNRESOLVED";
}

function normalizeCapture(
  value: unknown,
  addBlocker: (blocker: Phase1ConnectedStoreCensusBlocker) => void,
): Phase1ConnectedStoreCapture | null {
  if (!isRecord(value) || value.schemaVersion !== PHASE1_CONNECTED_STORE_CAPTURE_VERSION) {
    addBlocker({
      code: "INVALID_CENSUS_CAPTURE",
      channel: null,
      scopeKey: null,
      message: `Capture schemaVersion must be ${PHASE1_CONNECTED_STORE_CAPTURE_VERSION}.`,
      details: null,
    });
    return null;
  }
  const captureId = nonEmptyString(value.captureId);
  const capturedAt = normalizeIsoTimestamp(value.capturedAt);
  const capturedBy = nonEmptyString(value.capturedBy);
  const environment = nonEmptyString(value.environment);
  const target = nonEmptyString(value.target);
  if (!captureId || !capturedAt || !capturedBy || !environment || !target) {
    addBlocker({
      code: "INVALID_CENSUS_CAPTURE",
      channel: null,
      scopeKey: null,
      message: "Capture needs captureId, zoned capturedAt, capturedBy, environment, and target.",
      details: null,
    });
  }
  const supportContracts = isRecord(value.supportContracts) ? value.supportContracts : {};
  if (
    supportContracts.amazon !== "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5"
    || supportContracts.walmart !== "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET"
  ) {
    addBlocker({
      code: "INVALID_CENSUS_SUPPORT_CONTRACT",
      channel: null,
      scopeKey: null,
      message: "Capture must declare the proved Amazon 1..5 auth boundary and an explicit Walmart supported-index set.",
      details: null,
    });
  }
  const supported = isRecord(value.supportedStoreIndexes)
    ? value.supportedStoreIndexes
    : {};
  const supportedStoreIndexes = {
    amazon: normalizeSupportedIndexes(supported.amazon, "amazon", addBlocker),
    walmart: normalizeSupportedIndexes(supported.walmart, "walmart", addBlocker),
  };
  if (
    supportedStoreIndexes.amazon.length !== AMAZON_SUPPORTED_STORE_INDEXES.length
    || supportedStoreIndexes.amazon.some(
      (storeIndex, index) => storeIndex !== AMAZON_SUPPORTED_STORE_INDEXES[index],
    )
  ) {
    addBlocker({
      code: "INVALID_CENSUS_SUPPORTED_INDEXES",
      channel: "amazon",
      scopeKey: null,
      message: "Amazon auth.ts supports exactly store indexes 1 through 5; the census must enumerate all five slots.",
      details: { received: supportedStoreIndexes.amazon },
    });
  }

  const captureMs = capturedAt ? Date.parse(capturedAt) : null;
  const sourceArtifacts = normalizeSourceArtifacts(value.sourceArtifacts, captureMs, addBlocker);
  const rawScopes = Array.isArray(value.scopes) ? value.scopes : [];
  if (!Array.isArray(value.scopes)) {
    addBlocker({
      code: "INVALID_CENSUS_CAPTURE",
      channel: null,
      scopeKey: null,
      message: "Capture scopes must be an array.",
      details: null,
    });
  }
  const scopes: Phase1ConnectedStoreCaptureScope[] = [];
  const slotCounts = new Map<string, number>();
  for (const [index, raw] of rawScopes.entries()) {
    if (!isRecord(raw)) {
      addBlocker({
        code: "INVALID_CENSUS_SCOPE",
        channel: null,
        scopeKey: null,
        message: `scopes[${index}] must be an object.`,
        details: null,
      });
      continue;
    }
    const channel = raw.channel === "amazon" || raw.channel === "walmart"
      ? raw.channel
      : null;
    const storeIndex = positiveStoreIndex(raw.storeIndex);
    const scopeKey = nonEmptyString(raw.scopeKey)?.toLowerCase() ?? null;
    const connectionStatus = raw.connectionStatus === "CONNECTED"
      || raw.connectionStatus === "NOT_CONNECTED"
      || raw.connectionStatus === "UNRESOLVED"
      ? raw.connectionStatus
      : null;
    const directoryState = raw.directoryState === "ACTIVE"
      || raw.directoryState === "INACTIVE"
      || raw.directoryState === "ABSENT"
      || raw.directoryState === "UNKNOWN"
      ? raw.directoryState
      : null;
    const credentialState = raw.credentialState === "CONFIGURED"
      || raw.credentialState === "NOT_CONFIGURED"
      || raw.credentialState === "UNKNOWN"
      ? raw.credentialState
      : null;
    if (
      !channel || storeIndex === null || !scopeKey || !connectionStatus
      || !directoryState || !credentialState
    ) {
      addBlocker({
        code: "INVALID_CENSUS_SCOPE",
        channel,
        scopeKey,
        message: `scopes[${index}] needs channel, scopeKey, positive storeIndex, explicit status, and both source states.`,
        details: null,
      });
      continue;
    }
    const expectedScopeKey = `store${storeIndex}`;
    if (scopeKey !== expectedScopeKey) {
      addBlocker({
        code: "INVALID_CENSUS_SCOPE",
        channel,
        scopeKey,
        message: `Census scopeKey must be ${expectedScopeKey} for storeIndex ${storeIndex}.`,
        details: null,
      });
    }
    const slot = `${channel}:${storeIndex}`;
    slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
    if (!supportedStoreIndexes[channel].includes(storeIndex)) {
      addBlocker({
        code: "UNSUPPORTED_CENSUS_SLOT",
        channel,
        scopeKey,
        message: `${slot} is present in scope evidence but absent from the supported-slot declaration.`,
        details: null,
      });
    }
    const expectedStatus = expectedConnectionStatus(directoryState, credentialState);
    if (connectionStatus !== expectedStatus) {
      addBlocker({
        code: "CENSUS_SCOPE_STATUS_MISMATCH",
        channel,
        scopeKey,
        message: "Explicit connectionStatus does not match Store-directory/config evidence.",
        details: { connectionStatus, expectedStatus, directoryState, credentialState },
      });
    }
    if (connectionStatus === "UNRESOLVED") {
      addBlocker({
        code: "UNRESOLVED_CONNECTED_STORE_SCOPE",
        channel,
        scopeKey,
        message: "Connected-store evidence is unresolved; this slot remains in the required denominator and blocks freeze.",
        details: { directoryState, credentialState },
      });
    }
    const accountId = raw.accountId == null ? null : nonEmptyString(raw.accountId);
    const storeId = raw.storeId == null ? null : nonEmptyString(raw.storeId);
    const marketplaceId = raw.marketplaceId == null ? null : nonEmptyString(raw.marketplaceId);
    if (
      connectionStatus === "CONNECTED"
      && (!accountId || !storeId || (channel === "amazon" && !marketplaceId))
    ) {
      addBlocker({
        code: "INVALID_CENSUS_SCOPE",
        channel,
        scopeKey,
        message: "CONNECTED scope needs accountId and storeId; Amazon also needs marketplaceId.",
        details: null,
      });
    }
    scopes.push({
      channel,
      scopeKey,
      storeIndex,
      connectionStatus,
      directoryState,
      credentialState,
      accountId,
      storeId,
      marketplaceId,
    });
  }
  for (const channel of ["amazon", "walmart"] as const) {
    for (const storeIndex of supportedStoreIndexes[channel]) {
      const slot = `${channel}:${storeIndex}`;
      const count = slotCounts.get(slot) ?? 0;
      if (count === 0) {
        addBlocker({
          code: "MISSING_CENSUS_SLOT",
          channel,
          scopeKey: `store${storeIndex}`,
          message: `Supported slot ${slot} has no explicit CONNECTED/NOT_CONNECTED/UNRESOLVED row.`,
          details: null,
        });
      } else if (count > 1) {
        addBlocker({
          code: "DUPLICATE_CENSUS_SLOT",
          channel,
          scopeKey: `store${storeIndex}`,
          message: `Supported slot ${slot} occurs ${count} times.`,
          details: null,
        });
      }
    }
  }
  scopes.sort((left, right) =>
    compareText(left.channel, right.channel) || left.storeIndex - right.storeIndex,
  );
  return {
    schemaVersion: PHASE1_CONNECTED_STORE_CAPTURE_VERSION,
    captureId: captureId ?? "",
    capturedAt: capturedAt ?? "",
    capturedBy: capturedBy ?? "",
    environment: environment ?? "",
    target: target ?? "",
    supportContracts: {
      amazon: "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5",
      walmart: "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET",
    },
    supportedStoreIndexes,
    sourceArtifacts,
    scopes,
  };
}

function normalizeOwnerAttestation(
  value: unknown,
  capture: Phase1ConnectedStoreCapture | null,
  asOfMs: number | null,
  addBlocker: (blocker: Phase1ConnectedStoreCensusBlocker) => void,
): Phase1ConnectedStoreOwnerAttestation | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION
  ) {
    addBlocker({
      code: "INVALID_CENSUS_OWNER_ATTESTATION",
      channel: null,
      scopeKey: null,
      message: `Owner attestation schemaVersion must be ${PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION}.`,
      details: null,
    });
    return null;
  }
  const attestationId = nonEmptyString(value.attestationId);
  const attestedBy = nonEmptyString(value.attestedBy);
  const attestedAt = normalizeIsoTimestamp(value.attestedAt);
  const captureSha256 = nonEmptyString(value.captureSha256)?.toLowerCase() ?? null;
  if (
    value.authority !== "OWNER" || !attestationId || !attestedBy || !attestedAt
    || !captureSha256 || !/^[a-f0-9]{64}$/.test(captureSha256)
    || value.statement !== PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT
    || (asOfMs !== null && Date.parse(attestedAt) > asOfMs)
    || (capture?.capturedAt && Date.parse(attestedAt) < Date.parse(capture.capturedAt))
  ) {
    addBlocker({
      code: "INVALID_CENSUS_OWNER_ATTESTATION",
      channel: null,
      scopeKey: null,
      message: "Owner attestation must bind this capture, assert complete enumeration, and be dated between capture and asOf.",
      details: null,
    });
  }
  if (capture && captureSha256) {
    const actual = computePhase1ConnectedStoreCaptureSha256(capture);
    if (actual !== captureSha256) {
      addBlocker({
        code: "CENSUS_CAPTURE_HASH_MISMATCH",
        channel: null,
        scopeKey: null,
        message: "Owner attestation does not bind the canonical connected-store capture bytes.",
        details: { expected: captureSha256, actual },
      });
    }
  }
  return {
    schemaVersion: PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION,
    authority: "OWNER",
    attestationId: attestationId ?? "",
    attestedBy: attestedBy ?? "",
    attestedAt: attestedAt ?? "",
    captureSha256: captureSha256 ?? "",
    statement: PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT,
  };
}

function sortBlockers(blockers: Phase1ConnectedStoreCensusBlocker[]): void {
  blockers.sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.channel ?? "", right.channel ?? "")
    || compareText(left.scopeKey ?? "", right.scopeKey ?? "")
    || compareText(left.message, right.message),
  );
}

export function buildPhase1ConnectedStoreCensus(
  input: BuildPhase1ConnectedStoreCensusInput,
): Phase1ConnectedStoreCensusArtifact {
  const blockers: Phase1ConnectedStoreCensusBlocker[] = [];
  const blockerKeys = new Set<string>();
  const addBlocker = (blocker: Phase1ConnectedStoreCensusBlocker): void => {
    const key = stablePhase1CensusJsonStringify(blocker, 0);
    if (!blockerKeys.has(key)) {
      blockerKeys.add(key);
      blockers.push(blocker);
    }
  };
  const asOf = normalizeIsoTimestamp(input.asOf);
  const asOfMs = asOf ? Date.parse(asOf) : null;
  if (!asOf) {
    addBlocker({
      code: "INVALID_CENSUS_AS_OF",
      channel: null,
      scopeKey: null,
      message: "Census asOf must be a valid timestamp with an explicit timezone.",
      details: null,
    });
  }
  const maxCaptureAgeHours = input.maxCaptureAgeHours ?? DEFAULT_MAX_CAPTURE_AGE_HOURS;
  if (positiveFinite(maxCaptureAgeHours) === null) {
    addBlocker({
      code: "INVALID_CENSUS_CONFIGURATION",
      channel: null,
      scopeKey: null,
      message: "maxCaptureAgeHours must be positive and finite.",
      details: { received: maxCaptureAgeHours },
    });
  }
  const capture = normalizeCapture(input.capture, addBlocker);
  if (capture?.capturedAt && asOfMs !== null) {
    const capturedAtMs = Date.parse(capture.capturedAt);
    const ageHours = (asOfMs - capturedAtMs) / 3_600_000;
    if (ageHours < 0) {
      addBlocker({
        code: "CENSUS_CAPTURE_IN_FUTURE",
        channel: null,
        scopeKey: null,
        message: "Connected-store capture occurs after census asOf.",
        details: { capturedAt: capture.capturedAt, asOf },
      });
    } else if (positiveFinite(maxCaptureAgeHours) !== null && ageHours > maxCaptureAgeHours) {
      addBlocker({
        code: "CENSUS_CAPTURE_STALE",
        channel: null,
        scopeKey: null,
        message: "Connected-store capture exceeds the allowed freshness window.",
        details: { ageHours, maxCaptureAgeHours },
      });
    }
  }
  const ownerAttestation = normalizeOwnerAttestation(
    input.ownerAttestation,
    capture,
    asOfMs,
    addBlocker,
  );
  const requiredScopes: Record<Phase1ConnectedStoreChannel, string[]> = {
    amazon: [],
    walmart: [],
  };
  for (const scope of capture?.scopes ?? []) {
    if (scope.connectionStatus !== "NOT_CONNECTED") {
      requiredScopes[scope.channel].push(scope.scopeKey);
    }
  }
  requiredScopes.amazon = [...new Set(requiredScopes.amazon)].sort(compareText);
  requiredScopes.walmart = [...new Set(requiredScopes.walmart)].sort(compareText);
  sortBlockers(blockers);
  const connectedScopes = capture?.scopes.filter(
    (scope) => scope.connectionStatus === "CONNECTED",
  ).length ?? 0;
  const notConnectedScopes = capture?.scopes.filter(
    (scope) => scope.connectionStatus === "NOT_CONNECTED",
  ).length ?? 0;
  const unresolvedScopes = capture?.scopes.filter(
    (scope) => scope.connectionStatus === "UNRESOLVED",
  ).length ?? 0;
  return {
    schemaVersion: PHASE1_CONNECTED_STORE_CENSUS_VERSION,
    asOf: asOf ?? input.asOf,
    authoritative: blockers.length === 0,
    policy: {
      builderPolicyVersion: PHASE1_CONNECTED_STORE_CENSUS_POLICY_VERSION,
      amazonSupportContract: "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5",
      walmartSupportContract: "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET",
      requiredScopeRule: "CONNECTED_OR_UNRESOLVED",
      maxCaptureAgeHours,
      captureSha256: capture ? computePhase1ConnectedStoreCaptureSha256(capture) : "",
    },
    capture,
    ownerAttestation,
    requiredScopes,
    counts: {
      supportedSlots: capture
        ? capture.supportedStoreIndexes.amazon.length
          + capture.supportedStoreIndexes.walmart.length
        : 0,
      connectedScopes,
      notConnectedScopes,
      unresolvedScopes,
      requiredScopes: requiredScopes.amazon.length + requiredScopes.walmart.length,
      blockerCount: blockers.length,
    },
    blockers,
  };
}

export function inspectPhase1ConnectedStoreCensusArtifact(
  value: unknown,
): InspectPhase1ConnectedStoreCensusResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    const artifact = buildPhase1ConnectedStoreCensus({
      asOf: "",
      capture: null,
      ownerAttestation: null,
    });
    return {
      artifact,
      canonicalJson: renderPhase1ConnectedStoreCensusJson(artifact),
      errors: ["census artifact must be an object"],
    };
  }
  if (value.schemaVersion !== PHASE1_CONNECTED_STORE_CENSUS_VERSION) {
    errors.push(`schemaVersion must be ${PHASE1_CONNECTED_STORE_CENSUS_VERSION}`);
  }
  const policy = isRecord(value.policy) ? value.policy : {};
  const rebuilt = buildPhase1ConnectedStoreCensus({
    asOf: typeof value.asOf === "string" ? value.asOf : "",
    capture: value.capture,
    ownerAttestation: value.ownerAttestation,
    maxCaptureAgeHours: typeof policy.maxCaptureAgeHours === "number"
      ? policy.maxCaptureAgeHours
      : Number.NaN,
  });
  const canonicalJson = renderPhase1ConnectedStoreCensusJson(rebuilt);
  if (stablePhase1CensusJsonStringify(value, 0) !== stablePhase1CensusJsonStringify(rebuilt, 0)) {
    errors.push("census artifact does not equal the canonical builder result");
  }
  if (!rebuilt.authoritative) {
    errors.push(
      ...rebuilt.blockers.map((blocker) =>
        `[${blocker.code}] ${blocker.channel ?? "global"}:${blocker.scopeKey ?? "global"} ${blocker.message}`,
      ),
    );
  }
  return { artifact: rebuilt, canonicalJson, errors: [...new Set(errors)] };
}

export function parsePhase1ConnectedStoreCensusArtifact(
  content: string,
): InspectPhase1ConnectedStoreCensusResult {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    const inspected = inspectPhase1ConnectedStoreCensusArtifact(null);
    return {
      ...inspected,
      errors: [
        `census artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const inspected = inspectPhase1ConnectedStoreCensusArtifact(value);
  if (content !== inspected.canonicalJson) {
    inspected.errors.push(
      "[NON_CANONICAL_CENSUS_ARTIFACT] census artifact bytes must equal canonical builder JSON",
    );
  }
  inspected.errors = [...new Set(inspected.errors)];
  return inspected;
}
