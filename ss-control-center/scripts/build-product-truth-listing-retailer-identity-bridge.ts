import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  compileProductTruthListingRetailerIdentityBridge,
  productTruthListingRetailerIdentityBridgeSha256,
  renderProductTruthListingRetailerIdentityBridge,
  type ProductTruthListingRetailerIdentityBridge,
} from "../src/lib/sourcing/product-truth-listing-retailer-identity-bridge";
import type {
  ProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import type {
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthSourceDetailAdmission,
} from "../src/lib/sourcing/product-truth-source-detail-admission";

type Options = {
  componentScopePath: string;
  bridgeSnapshotPath: string;
  sourceDetailAdmissionPath: string;
  generatedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-listing-retailer-identity-bridge.ts",
    "    --component-scope ABS_JSON --bridge-snapshot ABS_JSON",
    "    --source-detail-admission ABS_JSON --generated-at ISO --out ABS_NEW_DIR",
    "",
    "Read-only/offline: provider calls, database writes and marketplace mutations are zero.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      fail("LISTING_RETAILER_IDENTITY_CLI_INVALID", `invalid argument near ${key ?? "EOF"}`);
    }
    if (values.has(key)) {
      fail("LISTING_RETAILER_IDENTITY_CLI_INVALID", `duplicate ${key}`);
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key)?.trim();
    if (!value) fail("LISTING_RETAILER_IDENTITY_CLI_INVALID", `${key} is required`);
    return value;
  };
  const exactKeys = new Set([
    "--component-scope",
    "--bridge-snapshot",
    "--source-detail-admission",
    "--generated-at",
    "--out",
  ]);
  for (const key of values.keys()) {
    if (!exactKeys.has(key)) {
      fail("LISTING_RETAILER_IDENTITY_CLI_INVALID", `unknown ${key}`);
    }
  }
  const absolute = (key: string): string => {
    const value = required(key);
    if (!isAbsolute(value)) {
      fail("LISTING_RETAILER_IDENTITY_CLI_INVALID", `${key} must be absolute`);
    }
    return resolve(value);
  };
  return {
    componentScopePath: absolute("--component-scope"),
    bridgeSnapshotPath: absolute("--bridge-snapshot"),
    sourceDetailAdmissionPath: absolute("--source-detail-admission"),
    generatedAt: required("--generated-at"),
    outDir: absolute("--out"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string): Promise<{ value: T; json: string; sha256: string }> {
  const json = await readFile(path, "utf8");
  let value: T;
  try {
    value = JSON.parse(json) as T;
  } catch {
    fail("LISTING_RETAILER_IDENTITY_CLI_INPUT_INVALID", `${path} is not JSON`);
  }
  return { value, json, sha256: sha256(json) };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [componentScope, bridgeSnapshot, sourceDetailAdmission] = await Promise.all([
    readJson<ProductTruthComponentAcquisitionScope>(options.componentScopePath),
    readJson<ProductTruthLegacyBridgeSnapshot>(options.bridgeSnapshotPath),
    readJson<ProductTruthSourceDetailAdmission>(options.sourceDetailAdmissionPath),
  ]);
  const bridge: ProductTruthListingRetailerIdentityBridge =
    compileProductTruthListingRetailerIdentityBridge({
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
    });
  const bridgeJson = renderProductTruthListingRetailerIdentityBridge(bridge);
  const bridgeSha256 = productTruthListingRetailerIdentityBridgeSha256(bridge);
  const index = {
    schemaVersion: "product-truth-listing-retailer-identity-bridge-index/1.0.0",
    generatedAt: bridge.generatedAt,
    files: [{
      role: "listing_retailer_identity_bridge",
      file: "listing-retailer-identity-bridge.json",
      sha256: bridgeSha256,
      byteLength: Buffer.byteLength(bridgeJson),
    }],
    counts: bridge.counts,
    claims: bridge.claims,
  };
  const indexJson = renderProductTruthOperationalJson(index);
  const indexSha256 = productTruthOperationalSha256(index);

  await mkdir(dirname(options.outDir), { recursive: true });
  await mkdir(options.outDir, { recursive: false });
  await Promise.all([
    writeFile(resolve(options.outDir, "listing-retailer-identity-bridge.json"), bridgeJson, { flag: "wx" }),
    writeFile(resolve(options.outDir, "listing-retailer-identity-bridge.sha256"), `${bridgeSha256}  listing-retailer-identity-bridge.json\n`, { flag: "wx" }),
    writeFile(resolve(options.outDir, "artifact-index.json"), indexJson, { flag: "wx" }),
    writeFile(resolve(options.outDir, "artifact-index.sha256"), `${indexSha256}  artifact-index.json\n`, { flag: "wx" }),
  ]);
  process.stdout.write(renderProductTruthOperationalJson({
    status: "COMPLETED",
    outDir: options.outDir,
    bridgeSha256,
    artifactIndexSha256: indexSha256,
    counts: bridge.counts,
    claims: bridge.claims,
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
