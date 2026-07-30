import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Phase1ScopeManifest } from "../src/lib/sourcing/phase1-scope-manifest";
import type {
  ProductTruthLegacyBridgePlan,
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import type {
  ProductTruthConsumerReadinessReport,
} from "../src/lib/sourcing/product-truth-consumer-readiness";
import {
  compileProductTruthRecipeRepairScope,
  renderProductTruthRecipeRepairScope,
} from "../src/lib/sourcing/product-truth-recipe-repair-scope";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  generatedAt: string;
  legacyStatePath: string;
  manifestPath: string;
  manifestShaPath: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotShaPath: string;
  bridgePlanPath: string;
  bridgePlanShaPath: string;
  readinessPath: string;
  readinessShaPath: string;
  outDir: string;
};

type BoundJson = {
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
    "  npm run product-truth:recipe-repair-scope --",
    "    --generated-at ISO_TIMESTAMP",
    "    --legacy-state ABS_LEGACY_STATE_JSON",
    "    --manifest ABS_MANIFEST_JSON --manifest-sha ABS_SHA_FILE",
    "    --bridge-snapshot ABS_SNAPSHOT_JSON --bridge-snapshot-sha ABS_SHA_FILE",
    "    --bridge-plan ABS_PLAN_JSON --bridge-plan-sha ABS_SHA_FILE",
    "    --readiness ABS_READINESS_JSON --readiness-sha ABS_SHA_FILE",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: immutable local artifact analysis only; no DB, provider, retailer",
    "or marketplace access, no writes outside the new output directory.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--generated-at",
    "--legacy-state",
    "--manifest",
    "--manifest-sha",
    "--bridge-snapshot",
    "--bridge-snapshot-sha",
    "--bridge-plan",
    "--bridge-plan-sha",
    "--readiness",
    "--readiness-sha",
    "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const generatedAt = required("--generated-at");
  if (
    !Number.isFinite(Date.parse(generatedAt))
    || new Date(Date.parse(generatedAt)).toISOString() !== generatedAt
  ) {
    fail("CLI_ARGUMENT_INVALID", "--generated-at must be canonical UTC");
  }
  const result: Options = {
    generatedAt,
    legacyStatePath: required("--legacy-state"),
    manifestPath: required("--manifest"),
    manifestShaPath: required("--manifest-sha"),
    bridgeSnapshotPath: required("--bridge-snapshot"),
    bridgeSnapshotShaPath: required("--bridge-snapshot-sha"),
    bridgePlanPath: required("--bridge-plan"),
    bridgePlanShaPath: required("--bridge-plan-sha"),
    readinessPath: required("--readiness"),
    readinessShaPath: required("--readiness-sha"),
    outDir: required("--out"),
  };
  for (const [label, path] of Object.entries(result)) {
    if (label === "generatedAt") continue;
    if (!isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED", label);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<{
  path: string;
  json: string;
  value: unknown;
}> {
  const resolved = await realpath(path);
  const json = await readFile(resolved, "utf8");
  try {
    return { path: resolved, json, value: JSON.parse(json) };
  } catch (error) {
    fail(
      "SOURCE_JSON_INVALID",
      `${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readBoundJson(path: string, shaPath: string): Promise<BoundJson> {
  const [source, resolvedShaPath] = await Promise.all([
    readJson(path),
    realpath(shaPath),
  ]);
  const shaText = await readFile(resolvedShaPath, "utf8");
  const plain = shaText.trim();
  const namedMatches = shaText
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match) && match![2] === basename(source.path),
    )
    .map((match) => match[1]!);
  const candidates = /^[a-f0-9]{64}$/.test(plain)
    ? [plain]
    : namedMatches;
  if (candidates.length !== 1) {
    fail("SOURCE_SHA_INVALID", resolvedShaPath);
  }
  const expectedSha256 = candidates[0]!;
  const actualSha256 = sha256(source.json);
  if (actualSha256 !== expectedSha256) {
    fail(
      "SOURCE_SHA_MISMATCH",
      `${source.path}: ${actualSha256} != ${expectedSha256}`,
    );
  }
  return { ...source, sha256: actualSha256 };
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
  const [
    historicalState,
    manifest,
    bridgeSnapshot,
    bridgePlan,
    readiness,
  ] = await Promise.all([
    readJson(options.legacyStatePath),
    readBoundJson(options.manifestPath, options.manifestShaPath),
    readBoundJson(
      options.bridgeSnapshotPath,
      options.bridgeSnapshotShaPath,
    ),
    readBoundJson(options.bridgePlanPath, options.bridgePlanShaPath),
    readBoundJson(options.readinessPath, options.readinessShaPath),
  ]);
  const historicalStateSha256 = sha256(historicalState.json);
  const report = compileProductTruthRecipeRepairScope({
    generatedAt: options.generatedAt,
    legacyImageState: historicalState.value,
    legacyImageStateJson: historicalState.json,
    legacyImageStateSha256: historicalStateSha256,
    manifest: manifest.value as Phase1ScopeManifest,
    manifestJson: manifest.json,
    manifestSha256: manifest.sha256,
    bridgeSnapshot:
      bridgeSnapshot.value as ProductTruthLegacyBridgeSnapshot,
    bridgeSnapshotJson: bridgeSnapshot.json,
    bridgeSnapshotSha256: bridgeSnapshot.sha256,
    bridgePlan: bridgePlan.value as ProductTruthLegacyBridgePlan,
    bridgePlanJson: bridgePlan.json,
    bridgePlanSha256: bridgePlan.sha256,
    readiness: readiness.value as ProductTruthConsumerReadinessReport,
    readinessJson: readiness.json,
    readinessSha256: readiness.sha256,
  });
  const reportJson = renderProductTruthRecipeRepairScope(report);
  const reportSha256 = sha256(reportJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion: "product-truth-recipe-repair-scope-artifact-index/1.0.0",
    generatedAt: report.generatedAt,
    source: report.source,
    counts: report.counts,
    laneCounts: report.laneCounts,
    claims: report.claims,
    artifacts: [{
      role: "recipe_repair_scope",
      file: "recipe-repair-scope.json",
      sha256: reportSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "recipe-repair-scope.json"), reportJson),
    writeNew(
      resolve(options.outDir, "recipe-repair-scope.sha256"),
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
    process.exitCode = 1;
  });
}
