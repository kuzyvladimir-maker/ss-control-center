import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  reconcileProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseResolution,
} from "../src/lib/sourcing/product-truth-consensus-reuse-resolution";
import {
  renderProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseScope,
} from "../src/lib/sourcing/product-truth-consensus-reuse-scope";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  generatedAt: string;
  baseScopePath: string;
  baseScopeSha256: string;
  resolutionPath: string;
  resolutionSha256: string;
  canonicalBindingSnapshotPath: string;
  canonicalBindingSnapshotSha256: string;
  outDir: string;
};

type JsonArtifact = {
  path: string;
  json: string;
  sha256: string;
  value: unknown;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:consensus-reuse-resolve --",
    "    --generated-at ISO_TIMESTAMP",
    "    --base-scope ABS_SCOPE_JSON --base-scope-sha256 SHA256",
    "    --resolution ABS_REVIEW_JSON --resolution-sha256 SHA256",
    "    --canonical-binding-snapshot ABS_SNAPSHOT_JSON",
    "    --canonical-binding-snapshot-sha256 SHA256",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: local immutable reconciliation only. No DB, provider, retailer",
    "or marketplace access and no writes outside the new output directory.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const flags = {
    "--generated-at": "generatedAt",
    "--base-scope": "baseScopePath",
    "--base-scope-sha256": "baseScopeSha256",
    "--resolution": "resolutionPath",
    "--resolution-sha256": "resolutionSha256",
    "--canonical-binding-snapshot": "canonicalBindingSnapshotPath",
    "--canonical-binding-snapshot-sha256":
      "canonicalBindingSnapshotSha256",
    "--out": "outDir",
  } as const;
  const values = new Map<keyof Options, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as keyof typeof flags;
    const key = flags[flag];
    if (!key) fail("CLI_ARGUMENT_UNKNOWN", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (values.has(key)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    values.set(key, value);
    index += 1;
  }
  const required = (key: keyof Options): string => {
    const value = values.get(key)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", key);
    return value;
  };
  const result: Options = {
    generatedAt: required("generatedAt"),
    baseScopePath: required("baseScopePath"),
    baseScopeSha256: required("baseScopeSha256"),
    resolutionPath: required("resolutionPath"),
    resolutionSha256: required("resolutionSha256"),
    canonicalBindingSnapshotPath:
      required("canonicalBindingSnapshotPath"),
    canonicalBindingSnapshotSha256:
      required("canonicalBindingSnapshotSha256"),
    outDir: required("outDir"),
  };
  if (
    !Number.isFinite(Date.parse(result.generatedAt))
    || new Date(Date.parse(result.generatedAt)).toISOString()
      !== result.generatedAt
  ) {
    fail("CLI_ARGUMENT_INVALID", "--generated-at must be canonical UTC");
  }
  for (const [key, value] of Object.entries(result)) {
    if (key.endsWith("Sha256") && !/^[a-f0-9]{64}$/.test(value)) {
      fail("SHA256_REQUIRED", key);
    }
    if (
      key !== "generatedAt"
      && !key.endsWith("Sha256")
      && !isAbsolute(value)
    ) {
      fail("ABSOLUTE_PATH_REQUIRED", key);
    }
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<JsonArtifact> {
  const resolved = await realpath(path);
  const json = await readFile(resolved, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail(
      "SOURCE_JSON_INVALID",
      `${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path: resolved,
    json,
    sha256: sha256(json),
    value,
  };
}

async function writeNew(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const [baseScope, resolution, snapshot] = await Promise.all([
    readJson(options.baseScopePath),
    readJson(options.resolutionPath),
    readJson(options.canonicalBindingSnapshotPath),
  ]);
  const report = reconcileProductTruthConsensusReuseScope({
    generatedAt: options.generatedAt,
    baseScope: baseScope.value as ProductTruthConsensusReuseScope,
    baseScopeJson: baseScope.json,
    baseScopeSha256: options.baseScopeSha256,
    resolution:
      resolution.value as ProductTruthConsensusReuseResolution,
    resolutionJson: resolution.json,
    resolutionSha256: options.resolutionSha256,
    canonicalBindingSnapshot: snapshot.value,
    canonicalBindingSnapshotJson: snapshot.json,
    canonicalBindingSnapshotSha256:
      options.canonicalBindingSnapshotSha256,
  });
  const reportJson = renderProductTruthConsensusReuseScope(report);
  const reportSha256 = sha256(reportJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-consensus-reuse-resolved-scope-artifact-index/1.0.0",
    generatedAt: report.generatedAt,
    source: report.source,
    counts: report.counts,
    resolvedReconciliationGroups: report.resolvedReconciliationGroups,
    claims: report.claims,
    artifacts: [{
      role: "resolved_consensus_reuse_scope",
      file: "consensus-reuse-scope.json",
      sha256: reportSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(
      resolve(options.outDir, "consensus-reuse-scope.json"),
      reportJson,
    ),
    writeNew(
      resolve(options.outDir, "consensus-reuse-scope.sha256"),
      `${reportSha256}\n`,
    ),
    writeNew(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNew(
      resolve(options.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
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
    process.exitCode = 2;
  });
}
