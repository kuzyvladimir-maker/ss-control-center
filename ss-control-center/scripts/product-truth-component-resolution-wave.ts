import { createHash } from "node:crypto";

import { createClient } from "@libsql/client";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyProductTruthComponentResolutionMaterialization,
  preflightProductTruthComponentResolutionMaterialization,
  renderProductTruthComponentResolutionApplyReport,
  renderProductTruthComponentResolutionPreflightReport,
  type ProductTruthComponentResolutionMaterializationPlan,
  type ProductTruthComponentResolutionMaterializationSources,
  type ProductTruthComponentResolutionPreflightReport,
} from "../src/lib/sourcing/product-truth-component-resolution-materialization";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
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
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Command = "preflight" | "apply";

type CommonOptions = {
  command: Command;
  componentScopePath: string;
  componentScopeSha256: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotSha256: string;
  standingPolicyPath: string;
  standingPolicySha256: string;
  planPath: string;
  planSha256: string;
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  outDir: string;
};

type PreflightOptions = CommonOptions & {
  command: "preflight";
  checkedAt: string;
};

type ApplyOptions = CommonOptions & {
  command: "apply";
  preflightPath: string;
  preflightSha256: string;
  startedAt: string;
};

type Options = PreflightOptions | ApplyOptions;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:component-resolution-wave -- preflight",
    "    --component-scope ABS_JSON --component-scope-sha256 SHA256",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha256 SHA256",
    "    --standing-policy ABS_JSON --standing-policy-sha256 SHA256",
    "    --plan ABS_JSON --plan-sha256 SHA256",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --checked-at UTC --out ABS_NEW_DIR",
    "",
    "  npm run product-truth:component-resolution-wave -- apply",
    "    [same source/database/plan flags]",
    "    --preflight ABS_JSON --preflight-sha256 SHA256",
    "    --started-at UTC --out ABS_NEW_DIR",
    "",
    "Safety: preflight is read-only. Apply is one collision-free atomic",
    "<=100-operation canonical wave. No provider, retailer, marketplace,",
    "procurement, price/inventory, delisting, or consumer-activation effects.",
  ].join("\n");
}

function exactSha(value: string, flag: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("CLI_ARGUMENT_INVALID", `${flag} must be lowercase SHA-256`);
  }
  return value;
}

function exactInstant(value: string, flag: string): string {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail("CLI_ARGUMENT_INVALID", `${flag} must be canonical UTC`);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const command = argv[0] as Command | undefined;
  if (!command || !["preflight", "apply"].includes(command)) {
    fail("COMMAND_REQUIRED", "expected preflight or apply");
  }
  const valueFlags = new Set([
    "--component-scope",
    "--component-scope-sha256",
    "--bridge-snapshot",
    "--bridge-snapshot-sha256",
    "--standing-policy",
    "--standing-policy-sha256",
    "--plan",
    "--plan-sha256",
    "--url",
    "--url-env",
    "--auth-token-env",
    "--checked-at",
    "--preflight",
    "--preflight-sha256",
    "--started-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", flag);
      allowRemote = true;
      continue;
    }
    if (!valueFlags.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
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
  const absolute = (flag: string): string => {
    const value = required(flag);
    if (!isAbsolute(value) || resolve(value) !== value) {
      fail("ABSOLUTE_PATH_REQUIRED", flag);
    }
    return value;
  };
  const literalUrl = values.get("--url")?.trim() || null;
  const urlEnv = values.get("--url-env")?.trim() || null;
  if ((literalUrl ? 1 : 0) + (urlEnv ? 1 : 0) !== 1) {
    fail(
      "DATABASE_URL_SOURCE_INVALID",
      "provide exactly one of --url or --url-env",
    );
  }
  const url = literalUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_ENV_EMPTY", urlEnv!);
  const common: CommonOptions = {
    command,
    componentScopePath: absolute("--component-scope"),
    componentScopeSha256: exactSha(
      required("--component-scope-sha256"),
      "--component-scope-sha256",
    ),
    bridgeSnapshotPath: absolute("--bridge-snapshot"),
    bridgeSnapshotSha256: exactSha(
      required("--bridge-snapshot-sha256"),
      "--bridge-snapshot-sha256",
    ),
    standingPolicyPath: absolute("--standing-policy"),
    standingPolicySha256: exactSha(
      required("--standing-policy-sha256"),
      "--standing-policy-sha256",
    ),
    planPath: absolute("--plan"),
    planSha256: exactSha(
      required("--plan-sha256"),
      "--plan-sha256",
    ),
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    outDir: absolute("--out"),
  };
  if (command === "preflight") {
    return {
      ...common,
      command,
      checkedAt: exactInstant(
        required("--checked-at"),
        "--checked-at",
      ),
    };
  }
  return {
    ...common,
    command,
    preflightPath: absolute("--preflight"),
    preflightSha256: exactSha(
      required("--preflight-sha256"),
      "--preflight-sha256",
    ),
    startedAt: exactInstant(
      required("--started-at"),
      "--started-at",
    ),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string): Promise<{
  json: string;
  value: T;
}> {
  const json = await readFile(await realpath(path), "utf8");
  try {
    return { json, value: JSON.parse(json) as T };
  } catch {
    fail("SOURCE_JSON_INVALID", path);
  }
}

async function loadSources(
  options: CommonOptions,
): Promise<ProductTruthComponentResolutionMaterializationSources> {
  const [scope, snapshot, policy] = await Promise.all([
    readJson<ProductTruthComponentAcquisitionScope>(
      options.componentScopePath,
    ),
    readJson<ProductTruthLegacyBridgeSnapshot>(
      options.bridgeSnapshotPath,
    ),
    readJson<ProductTruthLegacyBridgeStandingPolicy>(
      options.standingPolicyPath,
    ),
  ]);
  return {
    componentScope: scope.value,
    componentScopeJson: scope.json,
    componentScopeSha256: options.componentScopeSha256,
    bridgeSnapshot: snapshot.value,
    bridgeSnapshotJson: snapshot.json,
    bridgeSnapshotSha256: options.bridgeSnapshotSha256,
    standingPolicy: policy.value,
    standingPolicyJson: policy.json,
    standingPolicySha256: options.standingPolicySha256,
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

async function writeArtifact(input: {
  options: Options;
  role: string;
  file: string;
  content: string;
  index: JsonRecord;
}): Promise<void> {
  const artifactSha256 = sha256(input.content);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-component-resolution-wave-artifact-index/1.0.0",
    command: input.options.command,
    ...input.index,
    artifacts: [{
      role: input.role,
      file: input.file,
      sha256: artifactSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(input.options.outDir), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(input.options.outDir, {
    recursive: false,
    mode: 0o700,
  });
  await Promise.all([
    writeNew(resolve(input.options.outDir, input.file), input.content),
    writeNew(
      resolve(input.options.outDir, `${input.file}.sha256`),
      `${artifactSha256}\n`,
    ),
    writeNew(
      resolve(input.options.outDir, "artifact-index.json"),
      indexJson,
    ),
    writeNew(
      resolve(input.options.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
}

type JsonRecord = Record<string, unknown>;

function databaseClient(options: Options) {
  const target = resolveProductTruthDatabaseTarget(
    options.url,
    process.cwd(),
  );
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
      "--auth-token-env must name a populated environment variable",
    );
  }
  return {
    target,
    client: createClient({
      url: target.clientUrl,
      ...(authToken ? { authToken } : {}),
    }),
  };
}

async function run(options: Options): Promise<void> {
  const sources = await loadSources(options);
  const plan =
    await readJson<ProductTruthComponentResolutionMaterializationPlan>(
      options.planPath,
    );
  const { target, client } = databaseClient(options);
  try {
    if (options.command === "preflight") {
      const report =
        await preflightProductTruthComponentResolutionMaterialization({
          db: client,
          databaseTargetFingerprint: target.fingerprint,
          plan: plan.value,
          planJson: plan.json,
          planSha256: options.planSha256,
          sources,
          checkedAt: options.checkedAt,
        });
      const reportJson =
        renderProductTruthComponentResolutionPreflightReport(report);
      await writeArtifact({
        options,
        role: "component_resolution_materialization_preflight",
        file: "apply-preflight.json",
        content: reportJson,
        index: {
          planId: report.planId,
          checkedAt: report.checkedAt,
          status: report.status,
          databaseTargetFingerprint:
            report.databaseTargetFingerprint,
          counts: report.counts,
          claims: report.claims,
        },
      });
      return;
    }
    const preflight =
      await readJson<ProductTruthComponentResolutionPreflightReport>(
        options.preflightPath,
      );
    const report =
      await applyProductTruthComponentResolutionMaterialization({
        db: client,
        databaseTargetFingerprint: target.fingerprint,
        plan: plan.value,
        planJson: plan.json,
        planSha256: options.planSha256,
        sources,
        preflightReport: preflight.value,
        preflightReportJson: preflight.json,
        preflightReportSha256: options.preflightSha256,
        startedAt: options.startedAt,
      });
    const reportJson =
      renderProductTruthComponentResolutionApplyReport(report);
    await writeArtifact({
      options,
      role: "component_resolution_materialization_apply_report",
      file: "apply-report.json",
      content: reportJson,
      index: {
        planId: report.planId,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        status: report.status,
        databaseTargetFingerprint:
          report.databaseTargetFingerprint,
        counts: report.counts,
        verification: report.verification,
        claims: report.claims,
      },
    });
  } finally {
    client.close();
  }
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
