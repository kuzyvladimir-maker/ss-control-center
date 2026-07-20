#!/usr/bin/env node

/**
 * Seal a local, sanitized connected-store capture into the only census input
 * accepted by the Phase 1 scope-manifest builder. This CLI performs local file
 * reads/writes only; it never reads credentials, a database, or a marketplace.
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPhase1ConnectedStoreCensus,
  phase1CensusSha256Hex,
  renderPhase1ConnectedStoreCaptureCanonicalJson,
  renderPhase1ConnectedStoreCensusJson,
  stablePhase1CensusJsonStringify,
} from "../src/lib/sourcing/phase1-connected-store-census";

interface CliOptions {
  mode: "BUILD_CENSUS" | "PREPARE_OWNER_ATTESTATION";
  asOf: string;
  capturePath: string;
  ownerAttestationPath: string | null;
  storeDirectorySnapshotPath: string;
  deploymentConfigSnapshotPath: string;
  outDir: string;
  artifactBaseName: string;
  maxCaptureAgeHours: number;
}

const HELP = `
Build an immutable, fail-closed Phase 1 connected-store census from local JSON.

Required:
  --as-of <ISO timestamp with timezone>
  --capture <sanitized-connected-store-capture.json>
  --store-directory-snapshot <exact sanitized Store-directory export>
  --deployment-config-snapshot <exact sanitized deployment-config export>
  --out-dir <new artifact directory>

Required for final census only:
  --owner-attestation <owner-attestation.json>

Optional:
  --prepare-owner-attestation           validate capture/snapshots and emit the
                                        canonical capture bytes + SHA-256 without
                                        creating or accepting an owner attestation
  --basename <artifact base name>       defaults: phase1-connected-store-census;
                                        attestation mode uses
                                        phase1-connected-store-attestation-preflight
  --max-capture-age-hours <number>      default: 36
  --help

The capture must explicitly enumerate Amazon slots 1..5 and every Walmart slot
supported by the captured deployment configuration. Every supported slot needs
CONNECTED, NOT_CONNECTED, or UNRESOLVED. The OWNER attestation binds the
canonical capture SHA-256 and asserts complete enumeration.

With --prepare-owner-attestation, --owner-attestation is forbidden. A successful
preflight remains non-authoritative and emits only the exact normalized capture
bytes/hash that the owner must review and bind in a separate attestation.

Exit codes: 0 authoritative or attestation-ready preflight; 2 blocked/invalid;
1 unexpected local I/O failure.
The output directory must not already exist; census artifacts are never overwritten.
`;

function takeValue(
  args: string[],
  index: number,
  name: string,
): { value: string; next: number } {
  const current = args[index];
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) throw new Error(`${name} requires a value.`);
    return { value, next: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return { value, next: index + 1 };
}

function finitePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive finite number.`);
  }
  return parsed;
}

export function parsePhase1ConnectedStoreCensusCliArguments(args: string[]): CliOptions {
  let mode: CliOptions["mode"] = "BUILD_CENSUS";
  let prepareOwnerAttestationSeen = false;
  let asOf = "";
  let capturePath = "";
  let ownerAttestationPath = "";
  let storeDirectorySnapshotPath = "";
  let deploymentConfigSnapshotPath = "";
  let outDir = "";
  let artifactBaseName = "";
  let maxCaptureAgeHours = 36;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") throw new Error("HELP");
    if (arg === "--prepare-owner-attestation") {
      if (prepareOwnerAttestationSeen) {
        throw new Error("--prepare-owner-attestation was repeated.");
      }
      prepareOwnerAttestationSeen = true;
      mode = "PREPARE_OWNER_ATTESTATION";
    } else if (arg === "--as-of" || arg.startsWith("--as-of=")) {
      const result = takeValue(args, index, "--as-of");
      asOf = result.value;
      index = result.next;
    } else if (arg === "--capture" || arg.startsWith("--capture=")) {
      const result = takeValue(args, index, "--capture");
      capturePath = result.value;
      index = result.next;
    } else if (
      arg === "--owner-attestation"
      || arg.startsWith("--owner-attestation=")
    ) {
      const result = takeValue(args, index, "--owner-attestation");
      ownerAttestationPath = result.value;
      index = result.next;
    } else if (
      arg === "--store-directory-snapshot"
      || arg.startsWith("--store-directory-snapshot=")
    ) {
      const result = takeValue(args, index, "--store-directory-snapshot");
      storeDirectorySnapshotPath = result.value;
      index = result.next;
    } else if (
      arg === "--deployment-config-snapshot"
      || arg.startsWith("--deployment-config-snapshot=")
    ) {
      const result = takeValue(args, index, "--deployment-config-snapshot");
      deploymentConfigSnapshotPath = result.value;
      index = result.next;
    } else if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const result = takeValue(args, index, "--out-dir");
      outDir = result.value;
      index = result.next;
    } else if (arg === "--basename" || arg.startsWith("--basename=")) {
      const result = takeValue(args, index, "--basename");
      artifactBaseName = result.value;
      index = result.next;
    } else if (
      arg === "--max-capture-age-hours"
      || arg.startsWith("--max-capture-age-hours=")
    ) {
      const result = takeValue(args, index, "--max-capture-age-hours");
      maxCaptureAgeHours = finitePositive(result.value, "--max-capture-age-hours");
      index = result.next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!asOf) throw new Error("--as-of is required.");
  if (!capturePath) throw new Error("--capture is required.");
  if (mode === "BUILD_CENSUS" && !ownerAttestationPath) {
    throw new Error("--owner-attestation is required unless --prepare-owner-attestation is used.");
  }
  if (mode === "PREPARE_OWNER_ATTESTATION" && ownerAttestationPath) {
    throw new Error("--owner-attestation is forbidden with --prepare-owner-attestation.");
  }
  if (!storeDirectorySnapshotPath) {
    throw new Error("--store-directory-snapshot is required.");
  }
  if (!deploymentConfigSnapshotPath) {
    throw new Error("--deployment-config-snapshot is required.");
  }
  if (!outDir) throw new Error("--out-dir is required.");
  if (!artifactBaseName) {
    artifactBaseName = mode === "PREPARE_OWNER_ATTESTATION"
      ? "phase1-connected-store-attestation-preflight"
      : "phase1-connected-store-census";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactBaseName)) {
    throw new Error("--basename may contain only letters, digits, dot, underscore, and hyphen.");
  }
  return {
    mode,
    asOf,
    capturePath,
    ownerAttestationPath: ownerAttestationPath || null,
    storeDirectorySnapshotPath,
    deploymentConfigSnapshotPath,
    outDir,
    artifactBaseName,
    maxCaptureAgeHours,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function runPhase1ConnectedStoreCensusCli(args: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parsePhase1ConnectedStoreCensusCliArguments(args);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return 2;
  }

  let capture: unknown;
  let ownerAttestation: unknown = null;
  let storeDirectorySnapshot: string;
  let deploymentConfigSnapshot: string;
  try {
    capture = JSON.parse(await readFile(resolve(options.capturePath), "utf8")) as unknown;
    if (options.ownerAttestationPath !== null) {
      ownerAttestation = JSON.parse(
        await readFile(resolve(options.ownerAttestationPath), "utf8"),
      ) as unknown;
    }
    storeDirectorySnapshot = await readFile(
      resolve(options.storeDirectorySnapshotPath),
      "utf8",
    );
    deploymentConfigSnapshot = await readFile(
      resolve(options.deploymentConfigSnapshotPath),
      "utf8",
    );
  } catch (error) {
    process.stderr.write(
      `Cannot read/parse local census input JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const artifact = buildPhase1ConnectedStoreCensus({
    asOf: options.asOf,
    capture,
    ownerAttestation,
    maxCaptureAgeHours: options.maxCaptureAgeHours,
  });
  const exactSources = [
    {
      kind: "STORE_DIRECTORY_SNAPSHOT" as const,
      path: options.storeDirectorySnapshotPath,
      content: storeDirectorySnapshot,
    },
    {
      kind: "DEPLOYMENT_CONFIGURATION_SNAPSHOT" as const,
      path: options.deploymentConfigSnapshotPath,
      content: deploymentConfigSnapshot,
    },
  ];
  for (const source of exactSources) {
    const attested = artifact.capture?.sourceArtifacts.find(
      (candidate) => candidate.kind === source.kind,
    );
    const actualName = basename(resolve(source.path));
    const actualSha256 = phase1CensusSha256Hex(source.content);
    if (
      !attested
      || attested.sourceName !== actualName
      || attested.contentSha256 !== actualSha256
    ) {
      process.stderr.write(
        `Exact ${source.kind} bytes/name do not match capture provenance: `
          + `expected ${attested?.sourceName ?? "(missing)"} ${attested?.contentSha256 ?? "(missing)"}, `
          + `received ${actualName} ${actualSha256}.\n`,
      );
      return 2;
    }
  }
  if (options.mode === "PREPARE_OWNER_ATTESTATION") {
    const unexpectedBlockers = artifact.blockers.filter(
      (blocker) => blocker.code !== "INVALID_CENSUS_OWNER_ATTESTATION",
    );
    const captureCanonicalJson = artifact.capture
      ? renderPhase1ConnectedStoreCaptureCanonicalJson(artifact.capture)
      : "null\n";
    const captureSha256 = artifact.capture
      ? phase1CensusSha256Hex(captureCanonicalJson)
      : "";
    const readyForOwnerAttestation = artifact.capture !== null
      && captureSha256 === artifact.policy.captureSha256
      && unexpectedBlockers.length === 0;
    const preflight = `${stablePhase1CensusJsonStringify({
      schemaVersion: "phase1-connected-store-attestation-preflight/v1",
      asOf: artifact.asOf,
      authoritative: false,
      readyForOwnerAttestation,
      captureSha256,
      capture: artifact.capture,
      blockers: unexpectedBlockers,
      ownerAction: {
        required: true,
        attestationCreatedByCli: false,
        requiredAttestationSchemaVersion:
          "phase1-connected-store-owner-attestation/v1",
        requiredStatement:
          "ALL_SUPPORTED_AND_CONNECTED_AMAZON_WALMART_STORE_SCOPES_ARE_ENUMERATED",
      },
      safety: {
        credentialsRead: false,
        databaseCalls: 0,
        networkCalls: 0,
        marketplaceMutations: 0,
      },
    }, 2)}\n`;
    const preflightName = `${options.artifactBaseName}.json`;
    const captureName = `${options.artifactBaseName}.capture.json`;
    const directorySnapshotName = `${options.artifactBaseName}.store-directory.snapshot`;
    const configSnapshotName = `${options.artifactBaseName}.deployment-config.snapshot`;
    const checksumName = `${options.artifactBaseName}.sha256`;
    const checksum = [
      { name: captureName, content: captureCanonicalJson },
      { name: configSnapshotName, content: deploymentConfigSnapshot },
      { name: preflightName, content: preflight },
      { name: directorySnapshotName, content: storeDirectorySnapshot },
    ]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => `${phase1CensusSha256Hex(entry.content)}  ${entry.name}`)
      .join("\n") + "\n";
    const outputDirectory = resolve(options.outDir);
    if (await pathExists(outputDirectory)) {
      process.stderr.write(
        `Refusing to reuse existing artifact directory: ${outputDirectory}\n`
          + "Choose a new output directory; census artifacts are immutable.\n",
      );
      return 2;
    }
    if (!(await pathExists(dirname(outputDirectory)))) {
      process.stderr.write(`Output parent directory does not exist: ${dirname(outputDirectory)}\n`);
      return 2;
    }
    try {
      await mkdir(outputDirectory);
      await writeAtomically(resolve(outputDirectory, preflightName), preflight);
      await writeAtomically(resolve(outputDirectory, captureName), captureCanonicalJson);
      await writeAtomically(
        resolve(outputDirectory, directorySnapshotName),
        storeDirectorySnapshot,
      );
      await writeAtomically(
        resolve(outputDirectory, configSnapshotName),
        deploymentConfigSnapshot,
      );
      await writeAtomically(resolve(outputDirectory, checksumName), checksum);
    } catch (error) {
      process.stderr.write(
        `Cannot write immutable attestation preflight: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    process.stdout.write(
      `${readyForOwnerAttestation ? "ATTESTATION_READY" : "BLOCKED"}: `
        + `${artifact.counts.requiredScopes} required scopes, `
        + `${unexpectedBlockers.length} non-attestation blockers.\n`
        + `${resolve(outputDirectory, preflightName)}\n`
        + `${resolve(outputDirectory, captureName)}\n`
        + `${resolve(outputDirectory, checksumName)}\n`,
    );
    if (!readyForOwnerAttestation) {
      for (const blocker of unexpectedBlockers) {
        process.stderr.write(
          `[${blocker.code}] ${blocker.channel ?? "global"}:${blocker.scopeKey ?? "global"} ${blocker.message}\n`,
        );
      }
      return 2;
    }
    return 0;
  }
  const json = renderPhase1ConnectedStoreCensusJson(artifact);
  const jsonName = `${options.artifactBaseName}.json`;
  const directorySnapshotName = `${options.artifactBaseName}.store-directory.snapshot`;
  const configSnapshotName = `${options.artifactBaseName}.deployment-config.snapshot`;
  const checksumName = `${options.artifactBaseName}.sha256`;
  const checksum = [
    { name: configSnapshotName, content: deploymentConfigSnapshot },
    { name: jsonName, content: json },
    { name: directorySnapshotName, content: storeDirectorySnapshot },
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${phase1CensusSha256Hex(entry.content)}  ${entry.name}`)
    .join("\n") + "\n";
  const outputDirectory = resolve(options.outDir);
  if (await pathExists(outputDirectory)) {
    process.stderr.write(
      `Refusing to reuse existing artifact directory: ${outputDirectory}\nChoose a new output directory; census artifacts are immutable.\n`,
    );
    return 2;
  }
  if (!(await pathExists(dirname(outputDirectory)))) {
    process.stderr.write(`Output parent directory does not exist: ${dirname(outputDirectory)}\n`);
    return 2;
  }
  try {
    await mkdir(outputDirectory);
    await writeAtomically(resolve(outputDirectory, jsonName), json);
    await writeAtomically(
      resolve(outputDirectory, directorySnapshotName),
      storeDirectorySnapshot,
    );
    await writeAtomically(
      resolve(outputDirectory, configSnapshotName),
      deploymentConfigSnapshot,
    );
    await writeAtomically(resolve(outputDirectory, checksumName), checksum);
  } catch (error) {
    process.stderr.write(
      `Cannot write immutable census artifact: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  process.stdout.write(
    `${artifact.authoritative ? "AUTHORITATIVE" : "BLOCKED"}: `
      + `${artifact.counts.requiredScopes} required scopes, `
      + `${artifact.counts.blockerCount} blockers.\n`
      + `${resolve(outputDirectory, jsonName)}\n`
      + `${resolve(outputDirectory, directorySnapshotName)}\n`
      + `${resolve(outputDirectory, configSnapshotName)}\n`
      + `${resolve(outputDirectory, checksumName)}\n`,
  );
  if (!artifact.authoritative) {
    for (const blocker of artifact.blockers) {
      process.stderr.write(
        `[${blocker.code}] ${blocker.channel ?? "global"}:${blocker.scopeKey ?? "global"} ${blocker.message}\n`,
      );
    }
    return 2;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runPhase1ConnectedStoreCensusCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `Unexpected local census failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
