import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import type {
  ProductTruthDirectRetailerIdentityEvidence,
} from "../src/lib/sourcing/product-truth-direct-retailer-identity-evidence";
import type {
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import type {
  ProductTruthListingRetailerIdentityBridge,
} from "../src/lib/sourcing/product-truth-listing-retailer-identity-bridge";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthSourceDetailAdmission,
} from "../src/lib/sourcing/product-truth-source-detail-admission";
import {
  compileProductTruthTargetIdentityResolution,
  renderProductTruthTargetIdentityResolution,
  type ProductTruthTargetIdentityResolutionEvidenceInput,
} from "../src/lib/sourcing/product-truth-target-identity-resolution";

type Options = {
  componentScopePath: string;
  bridgeSnapshotPath: string;
  sourceDetailAdmissionPath: string;
  listingRetailerIdentityBridgePath: string;
  evidencePaths: string[];
  generatedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-target-identity-resolution.ts",
    "    --component-scope ABS_JSON --bridge-snapshot ABS_JSON",
    "    --source-detail-admission ABS_JSON --listing-retailer-bridge ABS_JSON",
    "    --direct-evidence ABS_EVIDENCE_JSON (repeatable)",
    "    --generated-at ISO --out ABS_NEW_DIR",
    "",
    "Safety: offline reconciliation only. Every evidence JSON is reparsed from",
    "its byte-bound sibling retailer-content.html. No network/DB/provider/write.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const singleFlags = new Set([
    "--component-scope",
    "--bridge-snapshot",
    "--source-detail-admission",
    "--listing-retailer-bridge",
    "--generated-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  const evidencePaths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (flag === "--direct-evidence") {
      evidencePaths.push(value);
    } else if (singleFlags.has(flag)) {
      if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    } else {
      fail("CLI_ARGUMENT_UNKNOWN", flag);
    }
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const paths = [
    required("--component-scope"),
    required("--bridge-snapshot"),
    required("--source-detail-admission"),
    required("--listing-retailer-bridge"),
    required("--out"),
    ...evidencePaths,
  ];
  if (paths.some((path) => !isAbsolute(path))) {
    fail("ABSOLUTE_PATH_REQUIRED", "all inputs and --out must be absolute");
  }
  if (!evidencePaths.length) {
    fail("CLI_ARGUMENT_REQUIRED", "at least one --direct-evidence");
  }
  return {
    componentScopePath: paths[0]!,
    bridgeSnapshotPath: paths[1]!,
    sourceDetailAdmissionPath: paths[2]!,
    listingRetailerIdentityBridgePath: paths[3]!,
    outDir: paths[4]!,
    evidencePaths,
    generatedAt: new Date(required("--generated-at")).toISOString(),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string): Promise<{
  value: T;
  json: string;
  sha256: string;
}> {
  const resolved = await realpath(path);
  const bytes = await readFile(resolved);
  const json = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail("SOURCE_JSON_INVALID", resolved);
  }
  return { value: value as T, json, sha256: sha256(bytes) };
}

async function loadEvidence(
  path: string,
): Promise<ProductTruthTargetIdentityResolutionEvidenceInput> {
  const source = await readJson<ProductTruthDirectRetailerIdentityEvidence>(
    path,
  );
  const htmlFile = source.value.retailerContent?.htmlFile;
  if (
    !htmlFile
    || basename(htmlFile) !== htmlFile
  ) fail("DIRECT_EVIDENCE_CONTRACT_INVALID", path);
  const htmlBytes = await readFile(resolve(dirname(path), htmlFile));
  return {
    evidence: source.value,
    evidenceJson: source.json,
    evidenceSha256: source.sha256,
    htmlBytes,
  };
}

async function writeNewFile(path: string, bytes: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const [componentScope, bridgeSnapshot, sourceDetailAdmission, listingBridge] =
    await Promise.all([
      readJson<ProductTruthComponentAcquisitionScope>(
        options.componentScopePath,
      ),
      readJson<ProductTruthLegacyBridgeSnapshot>(options.bridgeSnapshotPath),
      readJson<ProductTruthSourceDetailAdmission>(
        options.sourceDetailAdmissionPath,
      ),
      readJson<ProductTruthListingRetailerIdentityBridge>(
        options.listingRetailerIdentityBridgePath,
      ),
    ]);
  const directEvidence = await Promise.all(
    options.evidencePaths.map(loadEvidence),
  );
  const resolution = compileProductTruthTargetIdentityResolution({
    generatedAt: options.generatedAt,
    componentScope: componentScope.value,
    componentScopeJson: componentScope.json,
    componentScopeSha256: componentScope.sha256,
    bridgeSnapshot: bridgeSnapshot.value,
    bridgeSnapshotJson: bridgeSnapshot.json,
    bridgeSnapshotSha256: bridgeSnapshot.sha256,
    sourceDetailAdmission: sourceDetailAdmission.value,
    sourceDetailAdmissionJson: sourceDetailAdmission.json,
    sourceDetailAdmissionSha256: sourceDetailAdmission.sha256,
    listingRetailerIdentityBridge: listingBridge.value,
    listingRetailerIdentityBridgeJson: listingBridge.json,
    listingRetailerIdentityBridgeSha256: listingBridge.sha256,
    directEvidence,
  });
  const resolutionJson = renderProductTruthTargetIdentityResolution(
    resolution,
  );
  const resolutionSha256 = sha256(resolutionJson);
  const artifactIndex = {
    schemaVersion: "product-truth-target-identity-resolution-index/1.0.0",
    createdAt: options.generatedAt,
    artifacts: [{
      role: "target_identity_resolution",
      file: "target-identity-resolution.json",
      sha256: resolutionSha256,
    }],
    source: resolution.source,
    counts: resolution.counts,
    claims: resolution.claims,
  };
  const artifactIndexJson = renderProductTruthOperationalJson(artifactIndex);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNewFile(
      resolve(options.outDir, "target-identity-resolution.json"),
      resolutionJson,
    ),
    writeNewFile(
      resolve(options.outDir, "target-identity-resolution.sha256"),
      `${resolutionSha256}\n`,
    ),
    writeNewFile(
      resolve(options.outDir, "artifact-index.json"),
      artifactIndexJson,
    ),
    writeNewFile(
      resolve(options.outDir, "artifact-index.sha256"),
      `${sha256(artifactIndexJson)}\n`,
    ),
  ]);
  process.stdout.write(artifactIndexJson);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(parseOptions(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
