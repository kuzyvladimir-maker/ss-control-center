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
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  compileProductTruthComponentAcquisitionScope,
  renderProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import type {
  ProductTruthRecipeRepairScope,
} from "../src/lib/sourcing/product-truth-recipe-repair-scope";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  generatedAt: string;
  recipeScopePath: string;
  recipeScopeShaPath: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotShaPath: string;
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
    "  node --import tsx scripts/build-product-truth-component-acquisition-scope.ts",
    "    --generated-at ISO_TIMESTAMP",
    "    --recipe-scope ABS_JSON --recipe-scope-sha ABS_SHA_FILE",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha ABS_SHA_FILE",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: immutable local artifact analysis only; no DB, provider, retailer",
    "or marketplace access, no writes outside the new output directory.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--generated-at",
    "--recipe-scope",
    "--recipe-scope-sha",
    "--bridge-snapshot",
    "--bridge-snapshot-sha",
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
    recipeScopePath: required("--recipe-scope"),
    recipeScopeShaPath: required("--recipe-scope-sha"),
    bridgeSnapshotPath: required("--bridge-snapshot"),
    bridgeSnapshotShaPath: required("--bridge-snapshot-sha"),
    outDir: required("--out"),
  };
  for (const [label, path] of Object.entries(result)) {
    if (label === "generatedAt") continue;
    if (!isAbsolute(path) || resolve(path) !== path) {
      fail("ABSOLUTE_PATH_REQUIRED", label);
    }
  }
  return result;
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
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail(
      "SOURCE_JSON_INVALID",
      `${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const plain = shaText.trim();
  const namedMatches = shaText
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match) && match![2] === basename(resolvedPath),
    )
    .map((match) => match[1]!);
  const candidates = /^[a-f0-9]{64}$/.test(plain)
    ? [plain]
    : namedMatches;
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
  return {
    path: resolvedPath,
    json,
    sha256: actualSha256,
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
  const [recipeScope, bridgeSnapshot] = await Promise.all([
    readBoundJson(options.recipeScopePath, options.recipeScopeShaPath),
    readBoundJson(
      options.bridgeSnapshotPath,
      options.bridgeSnapshotShaPath,
    ),
  ]);
  const report = compileProductTruthComponentAcquisitionScope({
    generatedAt: options.generatedAt,
    recipeRepairScope:
      recipeScope.value as ProductTruthRecipeRepairScope,
    recipeRepairScopeJson: recipeScope.json,
    recipeRepairScopeSha256: recipeScope.sha256,
    bridgeSnapshot:
      bridgeSnapshot.value as ProductTruthLegacyBridgeSnapshot,
    bridgeSnapshotJson: bridgeSnapshot.json,
    bridgeSnapshotSha256: bridgeSnapshot.sha256,
  });
  const reportJson = renderProductTruthComponentAcquisitionScope(report);
  const reportSha256 = sha256(reportJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-component-acquisition-scope-artifact-index/1.2.0",
    generatedAt: report.generatedAt,
    source: report.source,
    matcher: report.matcher,
    counts: report.counts,
    projectedClosures: report.projectedClosures,
    claims: report.claims,
    artifacts: [{
      role: "component_acquisition_scope",
      file: "component-acquisition-scope.json",
      sha256: reportSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(
      resolve(options.outDir, "component-acquisition-scope.json"),
      reportJson,
    ),
    writeNew(
      resolve(options.outDir, "component-acquisition-scope.sha256"),
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
