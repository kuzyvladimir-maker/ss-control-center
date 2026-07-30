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
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthSearchQueryCalibration,
} from "../src/lib/sourcing/product-truth-search-query-calibration";
import {
  compileProductTruthSourceDetailAdmission,
  renderProductTruthSourceDetailAdmission,
} from "../src/lib/sourcing/product-truth-source-detail-admission";

type Options = {
  generatedAt: string;
  componentScopePath: string;
  componentScopeShaPath: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotShaPath: string;
  searchCalibrationPath: string;
  searchCalibrationShaPath: string;
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
    "  node --import tsx scripts/build-product-truth-source-detail-admission.ts",
    "    --generated-at ISO",
    "    --component-scope ABS_JSON --component-scope-sha ABS_SHA",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha ABS_SHA",
    "    --search-calibration ABS_JSON --search-calibration-sha ABS_SHA",
    "    --out ABS_NEW_DIR",
    "",
    "Pure offline admission. No database, provider, retailer or marketplace call.",
    "The artifact does not authorize execution.",
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
    "--component-scope",
    "--component-scope-sha",
    "--bridge-snapshot",
    "--bridge-snapshot-sha",
    "--search-calibration",
    "--search-calibration-sha",
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
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", String(flag));
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
    componentScopePath: absolutePath(
      values.get("--component-scope"),
      "--component-scope",
    ),
    componentScopeShaPath: absolutePath(
      values.get("--component-scope-sha"),
      "--component-scope-sha",
    ),
    bridgeSnapshotPath: absolutePath(
      values.get("--bridge-snapshot"),
      "--bridge-snapshot",
    ),
    bridgeSnapshotShaPath: absolutePath(
      values.get("--bridge-snapshot-sha"),
      "--bridge-snapshot-sha",
    ),
    searchCalibrationPath: absolutePath(
      values.get("--search-calibration"),
      "--search-calibration",
    ),
    searchCalibrationShaPath: absolutePath(
      values.get("--search-calibration-sha"),
      "--search-calibration-sha",
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
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [componentScope, bridgeSnapshot, searchCalibration] =
    await Promise.all([
      readBoundJson(
        options.componentScopePath,
        options.componentScopeShaPath,
      ),
      readBoundJson(
        options.bridgeSnapshotPath,
        options.bridgeSnapshotShaPath,
      ),
      readBoundJson(
        options.searchCalibrationPath,
        options.searchCalibrationShaPath,
      ),
    ]);
  const admission = compileProductTruthSourceDetailAdmission({
    generatedAt: options.generatedAt,
    componentScope:
      componentScope.value as ProductTruthComponentAcquisitionScope,
    componentScopeJson: componentScope.json,
    componentScopeSha256: componentScope.sha256,
    bridgeSnapshot:
      bridgeSnapshot.value as ProductTruthLegacyBridgeSnapshot,
    bridgeSnapshotJson: bridgeSnapshot.json,
    bridgeSnapshotSha256: bridgeSnapshot.sha256,
    searchQueryCalibration:
      searchCalibration.value as ProductTruthSearchQueryCalibration,
    searchQueryCalibrationJson: searchCalibration.json,
    searchQueryCalibrationSha256: searchCalibration.sha256,
  });
  const admissionJson =
    renderProductTruthSourceDetailAdmission(admission);
  const admissionSha256 = sha256(admissionJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-source-detail-admission-artifact-index/1.1.0",
    generatedAt: admission.generatedAt,
    databaseTargetFingerprint: admission.databaseTargetFingerprint,
    source: admission.source,
    counts: admission.counts,
    claims: admission.claims,
    artifacts: [{
      role: "source_detail_admission",
      file: "source-detail-admission.json",
      sha256: admissionSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeExclusive(
      resolve(options.outDir, "source-detail-admission.json"),
      admissionJson,
    ),
    writeExclusive(
      resolve(options.outDir, "source-detail-admission.sha256"),
      `${admissionSha256}\n`,
    ),
    writeExclusive(
      resolve(options.outDir, "artifact-index.json"),
      indexJson,
    ),
    writeExclusive(
      resolve(options.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(renderProductTruthOperationalJson({
    outDir: options.outDir,
    admissionSha256,
    artifactIndexSha256: indexSha256,
    counts: admission.counts,
    topTargets: admission.targets.slice(0, 10),
    claims: admission.claims,
  }));
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${usage()}\n`,
  );
  process.exitCode = 1;
});
