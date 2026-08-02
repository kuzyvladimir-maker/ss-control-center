import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import type {
  ProductTruthComponentAcquisitionScope,
} from "../src/lib/sourcing/product-truth-component-acquisition-scope";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthSearchQueryCalibration,
} from "../src/lib/sourcing/product-truth-search-query-calibration";
import type {
  ProductTruthSourceDetailAdmission,
} from "../src/lib/sourcing/product-truth-source-detail-admission";
import {
  compileProductTruthProviderTargetWave,
  PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
  PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS,
  renderProductTruthProviderAttemptCapture,
  renderProductTruthProviderTargetWave,
  type ProductTruthProviderAttemptCapture,
  type ProductTruthProviderAttemptCaptureRow,
} from "../src/lib/sourcing/product-truth-provider-target-wave";

type Options = {
  generatedAt: string;
  expiresAt: string;
  waveId: string;
  maximumTargets: number;
  exactCanonicalVariantId: string | null;
  componentScopePath: string;
  componentScopeShaPath: string;
  searchQueryCalibrationPath: string;
  searchQueryCalibrationShaPath: string;
  sourceDetailAdmissionPath: string;
  sourceDetailAdmissionShaPath: string;
  authoritativeManifestSha256: string;
  url: string;
  allowRemote: boolean;
  authTokenEnv: string | null;
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
    "  node --import tsx scripts/build-product-truth-provider-target-wave.ts",
    "    --generated-at ISO --expires-at ISO --wave-id ID",
    `    --max-targets INTEGER  # 1-${PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS}`,
    "    [--exact-canonical-variant-id cpv1:SHA256]",
    "    --component-scope ABS_JSON --component-scope-sha ABS_SHA_FILE",
    "    --search-calibration ABS_JSON --search-calibration-sha ABS_SHA_FILE",
    "    --source-detail-admission ABS_JSON --source-detail-admission-sha ABS_SHA_FILE",
    "    --manifest-sha256 SHA",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: connected read-only capture plus local immutable artifacts only.",
    "No provider, retailer, marketplace, procurement or database write surface.",
    "Selected work is one listing per unique canonical component target and",
    "excludes metered terminal attempts before building the execution request.",
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

function exactSha(value: string | undefined, flag: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    fail("SHA256_REQUIRED", flag);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--generated-at",
    "--expires-at",
    "--wave-id",
    "--max-targets",
    "--exact-canonical-variant-id",
    "--component-scope",
    "--component-scope-sha",
    "--search-calibration",
    "--search-calibration-sha",
    "--source-detail-admission",
    "--source-detail-admission-sha",
    "--manifest-sha256",
    "--url",
    "--url-env",
    "--allow-remote",
    "--auth-token-env",
    "--out",
  ]);
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    if (flag === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", flag);
      allowRemote = true;
      continue;
    }
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
  const directUrl = values.get("--url");
  const urlEnvironment = values.get("--url-env");
  if ((directUrl ? 1 : 0) + (urlEnvironment ? 1 : 0) !== 1) {
    fail("DATABASE_URL_REQUIRED", "provide exactly one of --url or --url-env");
  }
  const url = directUrl ?? process.env[urlEnvironment!]?.trim();
  if (!url) {
    fail(
      "DATABASE_URL_REQUIRED",
      `environment ${urlEnvironment ?? "(missing)"} is empty`,
    );
  }
  const maximumTargets = Number(required("--max-targets"));
  if (
    !Number.isSafeInteger(maximumTargets)
    || maximumTargets < 1
    || maximumTargets > PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS
  ) {
    fail(
      "CLI_ARGUMENT_INVALID",
      `--max-targets must be 1-${PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS}`,
    );
  }
  const exactCanonicalVariantId =
    values.get("--exact-canonical-variant-id")?.trim() ?? null;
  if (
    exactCanonicalVariantId !== null
    && !/^cpv1:[a-f0-9]{64}$/.test(exactCanonicalVariantId)
  ) {
    fail(
      "CLI_ARGUMENT_INVALID",
      "--exact-canonical-variant-id must be cpv1:SHA256",
    );
  }
  return {
    generatedAt: canonicalInstant(
      required("--generated-at"),
      "--generated-at",
    ),
    expiresAt: canonicalInstant(required("--expires-at"), "--expires-at"),
    waveId: required("--wave-id"),
    maximumTargets,
    exactCanonicalVariantId,
    componentScopePath: absolutePath(
      values.get("--component-scope"),
      "--component-scope",
    ),
    componentScopeShaPath: absolutePath(
      values.get("--component-scope-sha"),
      "--component-scope-sha",
    ),
    searchQueryCalibrationPath: absolutePath(
      values.get("--search-calibration"),
      "--search-calibration",
    ),
    searchQueryCalibrationShaPath: absolutePath(
      values.get("--search-calibration-sha"),
      "--search-calibration-sha",
    ),
    sourceDetailAdmissionPath: absolutePath(
      values.get("--source-detail-admission"),
      "--source-detail-admission",
    ),
    sourceDetailAdmissionShaPath: absolutePath(
      values.get("--source-detail-admission-sha"),
      "--source-detail-admission-sha",
    ),
    authoritativeManifestSha256: exactSha(
      values.get("--manifest-sha256"),
      "--manifest-sha256",
    ),
    url,
    allowRemote,
    authTokenEnv: values.get("--auth-token-env") ?? null,
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

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("DATABASE_CAPTURE_INVALID", `${label} is missing`);
  }
  return value;
}

function exactInteger(value: unknown, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("DATABASE_CAPTURE_INVALID", `${label} must be a non-negative integer`);
  }
  return parsed;
}

function openDatabase(options: Options) {
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (target.kind === "remote" && !options.allowRemote) {
    fail("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG", "pass --allow-remote");
  }
  if (target.kind === "local" && options.authTokenEnv) {
    fail("LOCAL_DATABASE_AUTH_FORBIDDEN", "--auth-token-env is remote-only");
  }
  const authToken = options.authTokenEnv
    ? process.env[options.authTokenEnv]?.trim()
    : undefined;
  if (target.kind === "remote" && (!options.authTokenEnv || !authToken)) {
    fail(
      "REMOTE_DATABASE_AUTH_REQUIRED",
      "--auth-token-env must name a populated variable",
    );
  }
  return {
    target,
    db: createClient({
      url: target.clientUrl,
      ...(authToken ? { authToken } : {}),
    }),
  };
}

async function captureTerminalProviderAttempts(
  options: Options,
): Promise<ProductTruthProviderAttemptCapture> {
  const { target, db } = openDatabase(options);
  try {
    const [attemptResult, targetResult] = await Promise.all([
      db.execute(`
        SELECT item."runId" AS runId,
               run."planSha256" AS planSha256,
               item."listingKey" AS listingKey,
               item."status" AS itemStatus,
               item."stage" AS stage,
               item."finishedAt" AS finishedAt,
               COUNT(receipt."id") AS providerCalls,
               COALESCE(SUM(receipt."unitsMicros"), 0) AS providerUnitsMicros
        FROM "ProductTruthOperationalRunItem" item
        JOIN "ProductTruthOperationalRun" run
          ON run."runId"=item."runId"
        JOIN "MeteredProviderBudget" budget
          ON budget."runId"=item."runId"
        JOIN "MeteredReservationReceipt" receipt
          ON receipt."budgetId"=budget."id"
         AND receipt."createdAt">=item."startedAt"
         AND receipt."createdAt"<=item."finishedAt"
        WHERE run."planSchemaVersion" IN (
          'product-truth-operational-plan/1.0.0',
          'product-truth-operational-plan/1.1.0',
          'product-truth-operational-plan/1.2.0'
        )
          AND item."attempts">0
          AND item."status" IN (
            'done','terminal_gap','blocked','ambiguous','failed'
          )
        GROUP BY item."runId", run."planSha256", item."listingKey",
                 item."status", item."stage", item."finishedAt"
        HAVING COUNT(receipt."id")>0
        ORDER BY item."finishedAt", item."runId", item."listingKey"
      `),
      db.execute(`
        SELECT cost."runId" AS runId,
               link."listingKey" AS listingKey,
               evidence."targetCanonicalVariantId" AS targetCanonicalVariantId
        FROM "SkuCost" cost
        JOIN "SkuCostListingScopeLink" link
          ON link."skuCostId"=cost."id"
        JOIN "SkuComponentEvidence" evidence
          ON evidence."skuCostId"=cost."id"
        WHERE cost."runId" IS NOT NULL
        ORDER BY cost."runId", link."listingKey",
                 evidence."componentIndex"
      `),
    ]);
    const targetsByAttempt = new Map<string, string[]>();
    for (const row of targetResult.rows) {
      const runId = exactText(row.runId, "cost target runId");
      const listingKey = exactText(row.listingKey, "cost target listingKey");
      const targetCanonicalVariantId = exactText(
        row.targetCanonicalVariantId,
        "cost target canonicalVariantId",
      );
      const key = `${runId}\u0000${listingKey}`;
      const values = targetsByAttempt.get(key) ?? [];
      values.push(targetCanonicalVariantId);
      targetsByAttempt.set(key, values);
    }
    const attempts: ProductTruthProviderAttemptCaptureRow[] =
      attemptResult.rows.map((row, index) => {
        const runId = exactText(row.runId, `attempt[${index}].runId`);
        const listingKey = exactText(
          row.listingKey,
          `attempt[${index}].listingKey`,
        );
        const providerCalls = exactInteger(
          row.providerCalls,
          `attempt[${index}].providerCalls`,
        );
        const unitsMicros = exactInteger(
          row.providerUnitsMicros,
          `attempt[${index}].providerUnitsMicros`,
        );
        return {
          runId,
          planSha256: exactText(
            row.planSha256,
            `attempt[${index}].planSha256`,
          ),
          listingKey,
          itemStatus: exactText(
            row.itemStatus,
            `attempt[${index}].itemStatus`,
          ) as ProductTruthProviderAttemptCaptureRow["itemStatus"],
          stage: exactText(row.stage, `attempt[${index}].stage`),
          finishedAt: exactText(
            row.finishedAt,
            `attempt[${index}].finishedAt`,
          ),
          providerCalls,
          providerUnits: unitsMicros / 1_000_000,
          targetCanonicalVariantIds: [
            ...new Set(
              targetsByAttempt.get(`${runId}\u0000${listingKey}`) ?? [],
            ),
          ].sort((left, right) => left.localeCompare(right, "en-US")),
        };
      });
    return {
      schemaVersion: PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
      capturedAt: new Date().toISOString(),
      databaseTargetFingerprint: target.fingerprint,
      attempts,
      claims: {
        readOnlyDatabase: true,
        databaseWrites: 0,
        providerCalls: 0,
        marketplaceMutations: 0,
      },
    };
  } finally {
    db.close();
  }
}

async function writeNew(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const [
    componentScope,
    searchQueryCalibration,
    sourceDetailAdmission,
  ] = await Promise.all([
    readBoundJson(
      options.componentScopePath,
      options.componentScopeShaPath,
    ),
    readBoundJson(
      options.searchQueryCalibrationPath,
      options.searchQueryCalibrationShaPath,
    ),
    readBoundJson(
      options.sourceDetailAdmissionPath,
      options.sourceDetailAdmissionShaPath,
    ),
  ]);
  const capture = await captureTerminalProviderAttempts(options);
  const captureJson = renderProductTruthProviderAttemptCapture(capture);
  const captureSha256 = sha256(captureJson);
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  const wave = compileProductTruthProviderTargetWave({
    waveId: options.waveId,
    generatedAt: options.generatedAt,
    expiresAt: options.expiresAt,
    databaseTargetFingerprint: target.fingerprint,
    authoritativeManifestSha256: options.authoritativeManifestSha256,
    componentScope:
      componentScope.value as ProductTruthComponentAcquisitionScope,
    componentScopeJson: componentScope.json,
    componentScopeSha256: componentScope.sha256,
    searchQueryCalibration:
      searchQueryCalibration.value as ProductTruthSearchQueryCalibration,
    searchQueryCalibrationJson: searchQueryCalibration.json,
    searchQueryCalibrationSha256: searchQueryCalibration.sha256,
    sourceDetailAdmission:
      sourceDetailAdmission.value as ProductTruthSourceDetailAdmission,
    sourceDetailAdmissionJson: sourceDetailAdmission.json,
    sourceDetailAdmissionSha256: sourceDetailAdmission.sha256,
    attemptCapture: capture,
    attemptCaptureJson: captureJson,
    attemptCaptureSha256: captureSha256,
    maximumTargets: options.maximumTargets,
    exactCanonicalVariantIds: options.exactCanonicalVariantId
      ? [options.exactCanonicalVariantId]
      : [],
  });
  const waveJson = renderProductTruthProviderTargetWave(wave);
  const waveSha256 = sha256(waveJson);
  const requestJson = renderProductTruthOperationalJson(
    wave.operationalRequest,
  );
  const requestSha256 = sha256(requestJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-provider-target-wave-artifact-index/1.3.0",
    generatedAt: wave.generatedAt,
    waveId: wave.waveId,
    databaseTargetFingerprint: wave.databaseTargetFingerprint,
    authoritativeManifestSha256: wave.authoritativeManifestSha256,
    counts: wave.counts,
    claims: wave.claims,
    artifacts: [
      {
        role: "search_query_calibration",
        file: "search-query-calibration.json",
        sha256: searchQueryCalibration.sha256,
      },
      {
        role: "source_detail_admission",
        file: "source-detail-admission.json",
        sha256: sourceDetailAdmission.sha256,
      },
      {
        role: "terminal_provider_attempt_capture",
        file: "terminal-provider-attempt-capture.json",
        sha256: captureSha256,
      },
      {
        role: "provider_target_wave",
        file: "provider-target-wave.json",
        sha256: waveSha256,
      },
      {
        role: "operational_request",
        file: "operational-request.json",
        sha256: requestSha256,
      },
    ],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(
      resolve(options.outDir, "search-query-calibration.json"),
      searchQueryCalibration.json,
    ),
    writeNew(
      resolve(options.outDir, "search-query-calibration.sha256"),
      `${searchQueryCalibration.sha256}\n`,
    ),
    writeNew(
      resolve(options.outDir, "source-detail-admission.json"),
      sourceDetailAdmission.json,
    ),
    writeNew(
      resolve(options.outDir, "source-detail-admission.sha256"),
      `${sourceDetailAdmission.sha256}\n`,
    ),
    writeNew(
      resolve(options.outDir, "terminal-provider-attempt-capture.json"),
      captureJson,
    ),
    writeNew(
      resolve(options.outDir, "terminal-provider-attempt-capture.sha256"),
      `${captureSha256}\n`,
    ),
    writeNew(
      resolve(options.outDir, "provider-target-wave.json"),
      waveJson,
    ),
    writeNew(
      resolve(options.outDir, "provider-target-wave.sha256"),
      `${waveSha256}\n`,
    ),
    writeNew(
      resolve(options.outDir, "operational-request.json"),
      requestJson,
    ),
    writeNew(
      resolve(options.outDir, "operational-request.sha256"),
      `${requestSha256}\n`,
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
