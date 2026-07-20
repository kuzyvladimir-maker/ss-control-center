import {
  PHASE1_CONNECTED_STORE_CAPTURE_VERSION,
  PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT,
  PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION,
  buildPhase1ConnectedStoreCensus,
  computePhase1ConnectedStoreCaptureSha256,
  phase1CensusSha256Hex,
  renderPhase1ConnectedStoreCensusJson,
  type Phase1ConnectedStoreCapture,
  type Phase1ConnectedStoreCaptureScope,
  type Phase1ConnectedStoreOwnerAttestation,
} from "../phase1-connected-store-census";

export const TEST_CENSUS_AS_OF = "2026-07-18T22:00:00.000Z";
export const TEST_CENSUS_CAPTURED_AT = "2026-07-18T20:00:00.000Z";

export interface TestConnectedStoreCensusOptions {
  asOf?: string;
  amazonConnected?: number[];
  walmartConnected?: number[];
  walmartSupported?: number[];
  identityStyle?: "scope-key" | "index";
}

export function testScopeIdentity(
  channel: "amazon" | "walmart",
  storeIndex: number,
  style: "scope-key" | "index" = "scope-key",
): Pick<Phase1ConnectedStoreCaptureScope, "accountId" | "storeId" | "marketplaceId"> {
  const scopeKey = `store${storeIndex}`;
  const suffix = style === "scope-key" ? scopeKey : String(storeIndex);
  return {
    accountId: `${channel}-account-${suffix}`,
    storeId: `${channel}-store-${suffix}`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
  };
}

export function makeTestConnectedStoreCapture(
  options: TestConnectedStoreCensusOptions = {},
): Phase1ConnectedStoreCapture {
  const amazonConnected = new Set(options.amazonConnected ?? [1]);
  const walmartConnected = new Set(options.walmartConnected ?? [1]);
  const walmartSupported = [...new Set(options.walmartSupported ?? [1])].sort(
    (left, right) => left - right,
  );
  const scopes: Phase1ConnectedStoreCaptureScope[] = [];
  for (const storeIndex of [1, 2, 3, 4, 5]) {
    const connected = amazonConnected.has(storeIndex);
    scopes.push({
      channel: "amazon",
      scopeKey: `store${storeIndex}`,
      storeIndex,
      connectionStatus: connected ? "CONNECTED" : "NOT_CONNECTED",
      directoryState: connected ? "ACTIVE" : "ABSENT",
      credentialState: connected ? "CONFIGURED" : "NOT_CONFIGURED",
      ...(connected
        ? testScopeIdentity("amazon", storeIndex, options.identityStyle)
        : { accountId: null, storeId: null, marketplaceId: null }),
    });
  }
  for (const storeIndex of walmartSupported) {
    const connected = walmartConnected.has(storeIndex);
    scopes.push({
      channel: "walmart",
      scopeKey: `store${storeIndex}`,
      storeIndex,
      connectionStatus: connected ? "CONNECTED" : "NOT_CONNECTED",
      directoryState: connected ? "ACTIVE" : "ABSENT",
      credentialState: connected ? "CONFIGURED" : "NOT_CONFIGURED",
      ...(connected
        ? testScopeIdentity("walmart", storeIndex, options.identityStyle)
        : { accountId: null, storeId: null, marketplaceId: null }),
    });
  }
  return {
    schemaVersion: PHASE1_CONNECTED_STORE_CAPTURE_VERSION,
    captureId: "test-connected-store-capture",
    capturedAt: TEST_CENSUS_CAPTURED_AT,
    capturedBy: "Test Capture Operator",
    environment: "test",
    target: "fixture-deployment",
    supportContracts: {
      amazon: "AMAZON_SP_AUTH_STORE_INDEX_1_TO_5",
      walmart: "WALMART_EXPLICIT_SUPPORTED_STORE_INDEX_SET",
    },
    supportedStoreIndexes: {
      amazon: [1, 2, 3, 4, 5],
      walmart: walmartSupported,
    },
    sourceArtifacts: [
      {
        kind: "STORE_DIRECTORY_SNAPSHOT",
        captureId: "test-store-directory",
        capturedAt: TEST_CENSUS_CAPTURED_AT,
        capturedBy: "Test Capture Operator",
        sourceName: "store-directory.json",
        contentSha256: phase1CensusSha256Hex("test-store-directory\n"),
      },
      {
        kind: "DEPLOYMENT_CONFIGURATION_SNAPSHOT",
        captureId: "test-deployment-config",
        capturedAt: TEST_CENSUS_CAPTURED_AT,
        capturedBy: "Test Capture Operator",
        sourceName: "deployment-config.json",
        contentSha256: phase1CensusSha256Hex("test-deployment-config\n"),
      },
    ],
    scopes,
  };
}

export function makeTestConnectedStoreOwnerAttestation(
  capture: Phase1ConnectedStoreCapture,
): Phase1ConnectedStoreOwnerAttestation {
  return {
    schemaVersion: PHASE1_CONNECTED_STORE_OWNER_ATTESTATION_VERSION,
    authority: "OWNER",
    attestationId: "test-owner-census-attestation",
    attestedBy: "Vladimir",
    attestedAt: "2026-07-18T21:00:00.000Z",
    captureSha256: computePhase1ConnectedStoreCaptureSha256(capture),
    statement: PHASE1_CONNECTED_STORE_COMPLETENESS_STATEMENT,
  };
}

export function makeTestConnectedStoreCensus(
  options: TestConnectedStoreCensusOptions = {},
) {
  const capture = makeTestConnectedStoreCapture(options);
  const ownerAttestation = makeTestConnectedStoreOwnerAttestation(capture);
  const artifact = buildPhase1ConnectedStoreCensus({
    asOf: options.asOf ?? TEST_CENSUS_AS_OF,
    capture,
    ownerAttestation,
  });
  if (!artifact.authoritative) {
    throw new Error(
      `Test census fixture unexpectedly blocked: ${JSON.stringify(artifact.blockers)}`,
    );
  }
  return {
    capture,
    ownerAttestation,
    artifact,
    sourceName: "phase1-connected-store-census.json",
    content: renderPhase1ConnectedStoreCensusJson(artifact),
  };
}
