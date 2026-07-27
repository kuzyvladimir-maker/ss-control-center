import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  PHASE1_CONNECTED_STORE_CENSUS_VERSION,
  buildPhase1ConnectedStoreCensus,
  inspectPhase1ConnectedStoreCensusArtifact,
  parsePhase1ConnectedStoreCensusArtifact,
  phase1CensusSha256Hex,
  renderPhase1ConnectedStoreCensusJson,
} from "../phase1-connected-store-census";
import {
  TEST_CENSUS_AS_OF,
  makeTestConnectedStoreCapture,
  makeTestConnectedStoreCensus,
  makeTestConnectedStoreOwnerAttestation,
} from "./phase1-connected-store-census-fixture";

const execFileAsync = promisify(execFile);

test("authoritative census derives the denominator from every explicit supported slot", () => {
  const { artifact } = makeTestConnectedStoreCensus({
    amazonConnected: [1, 3],
    walmartSupported: [1, 7],
    walmartConnected: [7],
  });
  assert.equal(artifact.schemaVersion, PHASE1_CONNECTED_STORE_CENSUS_VERSION);
  assert.equal(artifact.authoritative, true);
  assert.deepEqual(artifact.requiredScopes, {
    amazon: ["store1", "store3"],
    walmart: ["store7"],
  });
  assert.equal(artifact.counts.supportedSlots, 7);
  assert.equal(artifact.counts.notConnectedScopes, 4);
  assert.deepEqual(inspectPhase1ConnectedStoreCensusArtifact(artifact).errors, []);
});

test("missing supported slot blocks instead of silently shrinking the census", () => {
  const capture = makeTestConnectedStoreCapture();
  capture.scopes = capture.scopes.filter(
    (scope) => !(scope.channel === "amazon" && scope.storeIndex === 5),
  );
  const artifact = buildPhase1ConnectedStoreCensus({
    asOf: TEST_CENSUS_AS_OF,
    capture,
    ownerAttestation: makeTestConnectedStoreOwnerAttestation(capture),
  });
  assert.equal(artifact.authoritative, false);
  assert.ok(
    artifact.blockers.some(
      (blocker) => blocker.code === "MISSING_CENSUS_SLOT" && blocker.scopeKey === "store5",
    ),
  );
});

test("Walmart uses the explicit deployment-supported set without inventing a universal count", () => {
  const { artifact } = makeTestConnectedStoreCensus({
    walmartSupported: [1, 4, 9],
    walmartConnected: [1, 9],
  });
  assert.equal(artifact.authoritative, true);
  assert.deepEqual(artifact.capture?.supportedStoreIndexes.walmart, [1, 4, 9]);
  assert.deepEqual(artifact.requiredScopes.walmart, ["store1", "store9"]);
});

test("source disagreement is explicit UNRESOLVED and remains in the denominator", () => {
  const capture = makeTestConnectedStoreCapture();
  const store2 = capture.scopes.find(
    (scope) => scope.channel === "amazon" && scope.storeIndex === 2,
  );
  assert.ok(store2);
  store2.directoryState = "ACTIVE";
  store2.credentialState = "NOT_CONFIGURED";
  store2.connectionStatus = "UNRESOLVED";
  const artifact = buildPhase1ConnectedStoreCensus({
    asOf: TEST_CENSUS_AS_OF,
    capture,
    ownerAttestation: makeTestConnectedStoreOwnerAttestation(capture),
  });
  assert.equal(artifact.authoritative, false);
  assert.ok(artifact.requiredScopes.amazon.includes("store2"));
  assert.ok(
    artifact.blockers.some(
      (blocker) => blocker.code === "UNRESOLVED_CONNECTED_STORE_SCOPE",
    ),
  );
});

test("owner attestation binds the canonical capture and canonical artifact bytes", () => {
  const valid = makeTestConnectedStoreCensus();
  const tamperedCapture = structuredClone(valid.capture);
  tamperedCapture.target = "other-target";
  const artifact = buildPhase1ConnectedStoreCensus({
    asOf: TEST_CENSUS_AS_OF,
    capture: tamperedCapture,
    ownerAttestation: valid.ownerAttestation,
  });
  assert.ok(
    artifact.blockers.some((blocker) => blocker.code === "CENSUS_CAPTURE_HASH_MISMATCH"),
  );

  const canonical = renderPhase1ConnectedStoreCensusJson(valid.artifact);
  assert.deepEqual(parsePhase1ConnectedStoreCensusArtifact(canonical).errors, []);
  assert.ok(
    parsePhase1ConnectedStoreCensusArtifact(JSON.stringify(valid.artifact)).errors.some(
      (error) => error.includes("NON_CANONICAL_CENSUS_ARTIFACT"),
    ),
  );
});

test("census CLI prepares canonical owner-attestation bytes without self-attesting", async () => {
  const fixture = makeTestConnectedStoreCensus();
  const root = await mkdtemp(join(tmpdir(), "phase1-census-attestation-preflight-"));
  const capturePath = join(root, "capture.json");
  const directorySnapshotPath = join(root, "store-directory.json");
  const configSnapshotPath = join(root, "deployment-config.json");
  const outDir = join(root, "preflight");
  await writeFile(capturePath, JSON.stringify(fixture.capture), "utf8");
  await writeFile(directorySnapshotPath, "test-store-directory\n", "utf8");
  await writeFile(configSnapshotPath, "test-deployment-config\n", "utf8");
  const scriptPath = join(process.cwd(), "scripts", "build-phase1-connected-store-census.ts");
  const args = [
    "--import",
    "tsx",
    scriptPath,
    "--prepare-owner-attestation",
    "--as-of",
    TEST_CENSUS_AS_OF,
    "--capture",
    capturePath,
    "--store-directory-snapshot",
    directorySnapshotPath,
    "--deployment-config-snapshot",
    configSnapshotPath,
    "--out-dir",
    outDir,
  ];
  const result = await execFileAsync(process.execPath, args, { cwd: process.cwd() });
  assert.match(result.stdout, /^ATTESTATION_READY: 2 required scopes, 0 non-attestation blockers\./);
  const base = "phase1-connected-store-attestation-preflight";
  const preflight = JSON.parse(await readFile(join(outDir, `${base}.json`), "utf8"));
  const capture = await readFile(join(outDir, `${base}.capture.json`), "utf8");
  const checksum = await readFile(join(outDir, `${base}.sha256`), "utf8");
  assert.equal(preflight.schemaVersion, "phase1-connected-store-attestation-preflight/v1");
  assert.equal(preflight.authoritative, false);
  assert.equal(preflight.readyForOwnerAttestation, true);
  assert.equal(preflight.ownerAction.attestationCreatedByCli, false);
  assert.deepEqual(preflight.safety, {
    credentialsRead: false,
    databaseCalls: 0,
    networkCalls: 0,
    marketplaceMutations: 0,
  });
  assert.equal(preflight.captureSha256, phase1CensusSha256Hex(capture));
  assert.match(checksum, new RegExp(preflight.captureSha256));
  assert.deepEqual(JSON.parse(capture), preflight.capture);

  await assert.rejects(
    execFileAsync(process.execPath, [...args, "--owner-attestation", capturePath], {
      cwd: process.cwd(),
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === 2,
  );
  await assert.rejects(
    execFileAsync(process.execPath, args, { cwd: process.cwd() }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === 2,
  );
});

test("census CLI writes an immutable local artifact and has no runtime integrations", async () => {
  const fixture = makeTestConnectedStoreCensus();
  const root = await mkdtemp(join(tmpdir(), "phase1-census-test-"));
  const capturePath = join(root, "capture.json");
  const attestationPath = join(root, "attestation.json");
  const directorySnapshotPath = join(root, "store-directory.json");
  const configSnapshotPath = join(root, "deployment-config.json");
  const outDir = join(root, "out");
  await writeFile(capturePath, JSON.stringify(fixture.capture), "utf8");
  await writeFile(attestationPath, JSON.stringify(fixture.ownerAttestation), "utf8");
  await writeFile(directorySnapshotPath, "test-store-directory\n", "utf8");
  await writeFile(configSnapshotPath, "test-deployment-config\n", "utf8");
  const scriptPath = join(process.cwd(), "scripts", "build-phase1-connected-store-census.ts");
  const args = [
    "--import",
    "tsx",
    scriptPath,
    "--as-of",
    TEST_CENSUS_AS_OF,
    "--capture",
    capturePath,
    "--owner-attestation",
    attestationPath,
    "--store-directory-snapshot",
    directorySnapshotPath,
    "--deployment-config-snapshot",
    configSnapshotPath,
    "--out-dir",
    outDir,
  ];
  const result = await execFileAsync(process.execPath, args, { cwd: process.cwd() });
  assert.match(result.stdout, /^AUTHORITATIVE: 2 required scopes, 0 blockers\./);
  const json = await readFile(join(outDir, "phase1-connected-store-census.json"), "utf8");
  const checksum = await readFile(
    join(outDir, "phase1-connected-store-census.sha256"),
    "utf8",
  );
  assert.match(checksum, new RegExp(phase1CensusSha256Hex(json)));
  assert.match(checksum, new RegExp(phase1CensusSha256Hex("test-store-directory\n")));
  assert.match(checksum, new RegExp(phase1CensusSha256Hex("test-deployment-config\n")));
  await assert.rejects(
    execFileAsync(process.execPath, args, { cwd: process.cwd() }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === 2,
  );

  const source = await readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /@libsql|prisma|process\.env\[["'`]?(?:AMAZON|WALMART)/i);
  assert.equal(phase1CensusSha256Hex(json).length, 64);
});
