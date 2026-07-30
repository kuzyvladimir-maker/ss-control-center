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
  applyProductTruthConsensusReuseMaterialization,
  compileProductTruthConsensusReuseMaterializationPlan,
  preflightProductTruthConsensusReuseMaterialization,
  renderProductTruthConsensusReuseApplyPreflight,
  renderProductTruthConsensusReuseApplyReport,
  renderProductTruthConsensusReuseMaterializationPlan,
  type ProductTruthConsensusReuseApplyPreflightReport,
  type ProductTruthConsensusReuseMaterializationPlan,
  type ProductTruthConsensusReuseMaterializationSources,
} from "../src/lib/sourcing/product-truth-consensus-reuse-materialization";
import type {
  ProductTruthConsensusReusePreflightReport,
} from "../src/lib/sourcing/product-truth-consensus-reuse-preflight";
import type {
  ProductTruthConsensusReuseScope,
} from "../src/lib/sourcing/product-truth-consensus-reuse-scope";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import type {
  ProductTruthLegacyBridgeStandingPolicy,
} from "../src/lib/sourcing/product-truth-legacy-bridge-apply";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Command = "plan" | "preflight" | "apply";

type CommonOptions = {
  command: Command;
  scopePath: string;
  scopeSha256: string;
  selectionPreflightPath: string;
  selectionPreflightSha256: string;
  blindTaskPath: string;
  blindTaskSha256: string;
  standingPolicyPath: string;
  standingPolicySha256: string;
  outDir: string;
};

type PlanOptions = CommonOptions & {
  command: "plan";
  waveOrdinal: number;
  createdAt: string;
  expiresAt: string;
};

type DatabaseOptions = {
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  planPath: string;
  planSha256: string;
};

type PreflightOptions = CommonOptions & DatabaseOptions & {
  command: "preflight";
  checkedAt: string;
};

type ApplyOptions = CommonOptions & DatabaseOptions & {
  command: "apply";
  applyPreflightPath: string;
  applyPreflightSha256: string;
  startedAt: string;
};

type Options = PlanOptions | PreflightOptions | ApplyOptions;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:consensus-reuse-wave -- plan",
    "    --scope ABS_JSON --scope-sha256 SHA256",
    "    --selection-preflight ABS_JSON --selection-preflight-sha256 SHA256",
    "    --blind-task ABS_JSON --blind-task-sha256 SHA256",
    "    --standing-policy ABS_JSON --standing-policy-sha256 SHA256",
    "    --wave-ordinal N --created-at UTC --expires-at UTC --out ABS_NEW_DIR",
    "",
    "  npm run product-truth:consensus-reuse-wave -- preflight",
    "    [same source flags] --plan ABS_JSON --plan-sha256 SHA256",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --checked-at UTC --out ABS_NEW_DIR",
    "",
    "  npm run product-truth:consensus-reuse-wave -- apply",
    "    [same source/database/plan flags]",
    "    --apply-preflight ABS_JSON --apply-preflight-sha256 SHA256",
    "    --started-at UTC --out ABS_NEW_DIR",
    "",
    "Safety: plan/preflight are write-free. Apply writes only the exact",
    "collision-free <=100-row canonical wave in one transaction under the",
    "standing no-paid policy. No provider, retailer or marketplace calls.",
  ].join("\n");
}

function exactInstant(value: string, flag: string): string {
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("CLI_ARGUMENT_INVALID", `${flag} must be canonical UTC`);
  }
  return value;
}

function exactSha(value: string, flag: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("CLI_ARGUMENT_INVALID", `${flag} must be lowercase SHA-256`);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const command = argv[0] as Command | undefined;
  if (!command || !["plan", "preflight", "apply"].includes(command)) {
    fail("COMMAND_REQUIRED", "expected plan, preflight or apply");
  }
  const valueFlags = new Set([
    "--scope",
    "--scope-sha256",
    "--selection-preflight",
    "--selection-preflight-sha256",
    "--blind-task",
    "--blind-task-sha256",
    "--standing-policy",
    "--standing-policy-sha256",
    "--wave-ordinal",
    "--created-at",
    "--expires-at",
    "--url",
    "--url-env",
    "--auth-token-env",
    "--plan",
    "--plan-sha256",
    "--checked-at",
    "--apply-preflight",
    "--apply-preflight-sha256",
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
    if (!isAbsolute(value)) fail("ABSOLUTE_PATH_REQUIRED", flag);
    return value;
  };
  const common: CommonOptions = {
    command,
    scopePath: absolute("--scope"),
    scopeSha256: exactSha(required("--scope-sha256"), "--scope-sha256"),
    selectionPreflightPath: absolute("--selection-preflight"),
    selectionPreflightSha256: exactSha(
      required("--selection-preflight-sha256"),
      "--selection-preflight-sha256",
    ),
    blindTaskPath: absolute("--blind-task"),
    blindTaskSha256: exactSha(
      required("--blind-task-sha256"),
      "--blind-task-sha256",
    ),
    standingPolicyPath: absolute("--standing-policy"),
    standingPolicySha256: exactSha(
      required("--standing-policy-sha256"),
      "--standing-policy-sha256",
    ),
    outDir: absolute("--out"),
  };
  if (command === "plan") {
    const waveOrdinal = Number(required("--wave-ordinal"));
    if (!Number.isSafeInteger(waveOrdinal) || waveOrdinal < 0) {
      fail("CLI_ARGUMENT_INVALID", "--wave-ordinal");
    }
    return {
      ...common,
      command,
      waveOrdinal,
      createdAt: exactInstant(required("--created-at"), "--created-at"),
      expiresAt: exactInstant(required("--expires-at"), "--expires-at"),
    };
  }
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
  const database: DatabaseOptions = {
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    planPath: absolute("--plan"),
    planSha256: exactSha(required("--plan-sha256"), "--plan-sha256"),
  };
  if (command === "preflight") {
    return {
      ...common,
      ...database,
      command,
      checkedAt: exactInstant(required("--checked-at"), "--checked-at"),
    };
  }
  return {
    ...common,
    ...database,
    command,
    applyPreflightPath: absolute("--apply-preflight"),
    applyPreflightSha256: exactSha(
      required("--apply-preflight-sha256"),
      "--apply-preflight-sha256",
    ),
    startedAt: exactInstant(required("--started-at"), "--started-at"),
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

async function writeNew(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeArtifact(input: {
  outDir: string;
  role: string;
  file: string;
  content: string;
  index: Record<string, unknown>;
}): Promise<void> {
  const artifactSha256 = sha256(input.content);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-consensus-reuse-wave-artifact-index/1.0.0",
    ...input.index,
    artifacts: [{
      role: input.role,
      file: input.file,
      sha256: artifactSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(input.outDir), { recursive: true, mode: 0o700 });
  await mkdir(input.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(input.outDir, input.file), input.content),
    writeNew(
      resolve(input.outDir, `${input.file}.sha256`),
      `${artifactSha256}\n`,
    ),
    writeNew(resolve(input.outDir, "artifact-index.json"), indexJson),
    writeNew(
      resolve(input.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
}

async function loadSources(
  options: CommonOptions,
): Promise<ProductTruthConsensusReuseMaterializationSources> {
  const [
    scope,
    selectionPreflight,
    blindTask,
    standingPolicy,
  ] = await Promise.all([
    readJson<ProductTruthConsensusReuseScope>(options.scopePath),
    readJson<ProductTruthConsensusReusePreflightReport>(
      options.selectionPreflightPath,
    ),
    readJson<unknown>(options.blindTaskPath),
    readJson<ProductTruthLegacyBridgeStandingPolicy>(
      options.standingPolicyPath,
    ),
  ]);
  return {
    scope: scope.value,
    scopeJson: scope.json,
    scopeSha256: options.scopeSha256,
    selectionPreflight: selectionPreflight.value,
    selectionPreflightJson: selectionPreflight.json,
    selectionPreflightSha256: options.selectionPreflightSha256,
    blindTask: blindTask.value,
    blindTaskJson: blindTask.json,
    blindTaskSha256: options.blindTaskSha256,
    standingPolicy: standingPolicy.value,
    standingPolicyJson: standingPolicy.json,
    standingPolicySha256: options.standingPolicySha256,
  };
}

function databaseClient(options: PreflightOptions | ApplyOptions): {
  target: ReturnType<typeof resolveProductTruthDatabaseTarget>;
  client: ReturnType<typeof createClient>;
} {
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
  if (options.command === "plan") {
    const plan = compileProductTruthConsensusReuseMaterializationPlan({
      sources,
      waveOrdinal: options.waveOrdinal,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
    });
    const planJson =
      renderProductTruthConsensusReuseMaterializationPlan(plan);
    await writeArtifact({
      outDir: options.outDir,
      role: "consensus_reuse_materialization_plan",
      file: "apply-plan.json",
      content: planJson,
      index: {
        command: options.command,
        planId: plan.planId,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        wave: plan.wave,
        source: plan.source,
        databaseWrites: plan.databaseWrites,
        claims: plan.claims,
      },
    });
    return;
  }
  const plan = await readJson<ProductTruthConsensusReuseMaterializationPlan>(
    options.planPath,
  );
  const { target, client } = databaseClient(options);
  try {
    if (options.command === "preflight") {
      const report =
        await preflightProductTruthConsensusReuseMaterialization({
          db: client,
          databaseTargetFingerprint: target.fingerprint,
          plan: plan.value,
          planJson: plan.json,
          planSha256: options.planSha256,
          sources,
          checkedAt: options.checkedAt,
        });
      const reportJson =
        renderProductTruthConsensusReuseApplyPreflight(report);
      await writeArtifact({
        outDir: options.outDir,
        role: "consensus_reuse_apply_preflight",
        file: "apply-preflight.json",
        content: reportJson,
        index: {
          command: options.command,
          planId: report.planId,
          checkedAt: report.checkedAt,
          status: report.status,
          databaseTargetFingerprint: report.databaseTargetFingerprint,
          counts: report.counts,
          claims: report.claims,
        },
      });
      return;
    }
    const preflight =
      await readJson<ProductTruthConsensusReuseApplyPreflightReport>(
        options.applyPreflightPath,
      );
    const report = await applyProductTruthConsensusReuseMaterialization({
      db: client,
      databaseTargetFingerprint: target.fingerprint,
      plan: plan.value,
      planJson: plan.json,
      planSha256: options.planSha256,
      sources,
      preflightReport: preflight.value,
      preflightReportJson: preflight.json,
      preflightReportSha256: options.applyPreflightSha256,
      startedAt: options.startedAt,
    });
    const reportJson = renderProductTruthConsensusReuseApplyReport(report);
    await writeArtifact({
      outDir: options.outDir,
      role: "consensus_reuse_apply_report",
      file: "apply-report.json",
      content: reportJson,
      index: {
        command: options.command,
        planId: report.planId,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        status: report.status,
        databaseTargetFingerprint: report.databaseTargetFingerprint,
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

const isEntrypoint =
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
