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
  ProductTruthLegacyBridgeStandingPolicy,
} from "../src/lib/sourcing/product-truth-legacy-bridge-apply";
import type {
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import type {
  ProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import {
  compileProductTruthComponentResolutionMaterializationPlan,
  renderProductTruthComponentResolutionMaterializationPlan,
} from "../src/lib/sourcing/product-truth-component-resolution-materialization";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  createdAt: string;
  expiresAt: string;
  componentScopePath: string;
  componentScopeShaPath: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotShaPath: string;
  standingPolicyPath: string;
  standingPolicyShaPath: string;
  outDir: string;
};

type BoundJson = {
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
    "  npm run product-truth:component-resolution-plan --",
    "    --created-at ISO --expires-at ISO",
    "    --component-scope ABS_JSON --component-scope-sha ABS_SHA",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha ABS_SHA",
    "    --standing-policy ABS_JSON --standing-policy-sha ABS_SHA",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: immutable no-paid plan compilation only. No database, provider,",
    "retailer, marketplace, procurement, or consumer-activation effects.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const pairs = new Map<string, string>();
  const allowed = new Set([
    "--created-at",
    "--expires-at",
    "--component-scope",
    "--component-scope-sha",
    "--bridge-snapshot",
    "--bridge-snapshot-sha",
    "--standing-policy",
    "--standing-policy-sha",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_INVALID", flag ?? "<missing>");
    }
    if (pairs.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    pairs.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = pairs.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const options: Options = {
    createdAt: required("--created-at"),
    expiresAt: required("--expires-at"),
    componentScopePath: required("--component-scope"),
    componentScopeShaPath: required("--component-scope-sha"),
    bridgeSnapshotPath: required("--bridge-snapshot"),
    bridgeSnapshotShaPath: required("--bridge-snapshot-sha"),
    standingPolicyPath: required("--standing-policy"),
    standingPolicyShaPath: required("--standing-policy-sha"),
    outDir: required("--out"),
  };
  for (const [key, path] of Object.entries(options)) {
    if (key === "createdAt" || key === "expiresAt") continue;
    if (!isAbsolute(path) || resolve(path) !== path) {
      fail("ABSOLUTE_PATH_REQUIRED", key);
    }
  }
  return options;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundJson(
  path: string,
  shaPath: string,
): Promise<BoundJson> {
  const [resolvedPath, resolvedShaPath] = await Promise.all([
    realpath(path),
    realpath(shaPath),
  ]);
  const [json, shaText] = await Promise.all([
    readFile(resolvedPath, "utf8"),
    readFile(resolvedShaPath, "utf8"),
  ]);
  const plain = shaText.trim();
  const named = shaText
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match) && match![2] === basename(resolvedPath),
    )
    .map((match) => match[1]!);
  const candidates = /^[a-f0-9]{64}$/.test(plain) ? [plain] : named;
  if (candidates.length !== 1) {
    fail("SOURCE_SHA_INVALID", resolvedShaPath);
  }
  const actualSha256 = sha256(json);
  if (actualSha256 !== candidates[0]) {
    fail(
      "SOURCE_SHA_MISMATCH",
      `${resolvedPath}: ${actualSha256} != ${candidates[0]}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    fail("SOURCE_JSON_INVALID", resolvedPath);
  }
  return { json, sha256: actualSha256, value };
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
  const [scope, snapshot, policy] = await Promise.all([
    readBoundJson(
      options.componentScopePath,
      options.componentScopeShaPath,
    ),
    readBoundJson(
      options.bridgeSnapshotPath,
      options.bridgeSnapshotShaPath,
    ),
    readBoundJson(
      options.standingPolicyPath,
      options.standingPolicyShaPath,
    ),
  ]);
  const plan =
    compileProductTruthComponentResolutionMaterializationPlan({
      sources: {
        componentScope:
          scope.value as ProductTruthComponentAcquisitionScope,
        componentScopeJson: scope.json,
        componentScopeSha256: scope.sha256,
        bridgeSnapshot:
          snapshot.value as ProductTruthLegacyBridgeSnapshot,
        bridgeSnapshotJson: snapshot.json,
        bridgeSnapshotSha256: snapshot.sha256,
        standingPolicy:
          policy.value as ProductTruthLegacyBridgeStandingPolicy,
        standingPolicyJson: policy.json,
        standingPolicySha256: policy.sha256,
      },
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
    });
  const planJson =
    renderProductTruthComponentResolutionMaterializationPlan(plan);
  const planSha256 = sha256(planJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-component-resolution-plan-artifact-index/1.0.0",
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    source: plan.source,
    targetCount: plan.targets.length,
    databaseWrites: plan.databaseWrites,
    claims: plan.claims,
    artifacts: [{
      role: "component_resolution_materialization_plan",
      file: "materialization-plan.json",
      sha256: planSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "materialization-plan.json"), planJson),
    writeNew(
      resolve(options.outDir, "materialization-plan.sha256"),
      `${planSha256}\n`,
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

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
