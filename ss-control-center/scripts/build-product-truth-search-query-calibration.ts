import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import type {
  ProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import type {
  ProductTruthLegacyBridgePlan,
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  compileProductTruthSearchQueryCalibration,
  renderProductTruthSearchQueryCalibration,
} from "../src/lib/sourcing/product-truth-search-query-calibration";
import { renderProductTruthOperationalJson } from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  generatedAt: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotShaPath: string;
  bridgePlanPath: string;
  bridgePlanShaPath: string;
  componentScopePath: string;
  componentScopeShaPath: string;
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
    "  node --import tsx scripts/build-product-truth-search-query-calibration.ts",
    "    --generated-at ISO",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha ABS_SHA",
    "    --bridge-plan ABS_JSON --bridge-plan-sha ABS_SHA",
    "    --component-scope ABS_JSON --component-scope-sha ABS_SHA",
    "    --out ABS_NEW_DIR",
    "",
    "Pure offline calibration. Reads immutable local artifacts only.",
    "Makes no database, provider, retailer, marketplace or execution call.",
  ].join("\n");
}

function canonicalInstant(value: string, flag: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("CLI_ARGUMENT_INVALID", `${flag} must be canonical UTC`);
  }
  return value;
}

function absolutePath(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    fail("ABSOLUTE_PATH_REQUIRED", flag);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--generated-at",
    "--bridge-snapshot",
    "--bridge-snapshot-sha",
    "--bridge-plan",
    "--bridge-plan-sha",
    "--component-scope",
    "--component-scope-sha",
    "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", String(flag));
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", String(flag));
    }
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  return {
    generatedAt: canonicalInstant(
      required("--generated-at"),
      "--generated-at",
    ),
    bridgeSnapshotPath: absolutePath(
      values.get("--bridge-snapshot"),
      "--bridge-snapshot",
    ),
    bridgeSnapshotShaPath: absolutePath(
      values.get("--bridge-snapshot-sha"),
      "--bridge-snapshot-sha",
    ),
    bridgePlanPath: absolutePath(
      values.get("--bridge-plan"),
      "--bridge-plan",
    ),
    bridgePlanShaPath: absolutePath(
      values.get("--bridge-plan-sha"),
      "--bridge-plan-sha",
    ),
    componentScopePath: absolutePath(
      values.get("--component-scope"),
      "--component-scope",
    ),
    componentScopeShaPath: absolutePath(
      values.get("--component-scope-sha"),
      "--component-scope-sha",
    ),
    outDir: absolutePath(values.get("--out"), "--out"),
  };
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
  const named = shaText
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match) && match![2] === basename(resolvedPath),
    )
    .map((match) => match[1]!);
  const candidates = /^[a-f0-9]{64}$/.test(plain) ? [plain] : named;
  if (candidates.length !== 1 || sha256(json) !== candidates[0]) {
    fail("SOURCE_SHA_MISMATCH", resolvedPath);
  }
  return {
    json,
    sha256: candidates[0]!,
    value,
  };
}

async function writeExclusive(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [bridgeSnapshot, bridgePlan, componentScope] = await Promise.all([
    readBoundJson(options.bridgeSnapshotPath, options.bridgeSnapshotShaPath),
    readBoundJson(options.bridgePlanPath, options.bridgePlanShaPath),
    readBoundJson(options.componentScopePath, options.componentScopeShaPath),
  ]);
  const report = compileProductTruthSearchQueryCalibration({
    generatedAt: options.generatedAt,
    bridgeSnapshot:
      bridgeSnapshot.value as ProductTruthLegacyBridgeSnapshot,
    bridgeSnapshotJson: bridgeSnapshot.json,
    bridgeSnapshotSha256: bridgeSnapshot.sha256,
    bridgePlan: bridgePlan.value as ProductTruthLegacyBridgePlan,
    bridgePlanJson: bridgePlan.json,
    bridgePlanSha256: bridgePlan.sha256,
    componentScope:
      componentScope.value as ProductTruthComponentAcquisitionScope,
    componentScopeJson: componentScope.json,
    componentScopeSha256: componentScope.sha256,
  });
  const reportJson = renderProductTruthSearchQueryCalibration(report);
  const reportSha256 = sha256(reportJson);
  const index = {
    schemaVersion: "product-truth-search-query-calibration-artifact-index/1.0.0",
    generatedAt: options.generatedAt,
    reportSchemaVersion: report.schemaVersion,
    reportSha256,
    sourceSha256: {
      bridgeSnapshot: bridgeSnapshot.sha256,
      bridgePlan: bridgePlan.sha256,
      componentScope: componentScope.sha256,
    },
    counts: report.counts,
    paidWaveAdmission: report.paidWaveAdmission,
    claims: report.claims,
  };
  const indexJson = renderProductTruthOperationalJson(index);
  const indexSha256 = sha256(indexJson);

  await mkdir(options.outDir, { recursive: false });
  await Promise.all([
    writeExclusive(
      `${options.outDir}/search-query-calibration.json`,
      reportJson,
    ),
    writeExclusive(
      `${options.outDir}/search-query-calibration.sha256`,
      `${reportSha256}\n`,
    ),
    writeExclusive(`${options.outDir}/artifact-index.json`, indexJson),
    writeExclusive(
      `${options.outDir}/artifact-index.sha256`,
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(renderProductTruthOperationalJson({
    outDir: options.outDir,
    reportSha256,
    artifactIndexSha256: indexSha256,
    admittedForms: report.admittedForms,
    counts: report.counts,
    currentMetrics: report.currentMetrics,
    calibratedMetrics: report.calibratedMetrics,
    comparison: report.comparison,
    paidWaveAdmission: report.paidWaveAdmission,
  }));
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${usage()}\n`,
  );
  process.exitCode = 1;
});
