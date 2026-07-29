import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import {
  applyProductTruthCanonicalRecipeReconciliation,
  planProductTruthCanonicalRecipeReconciliation,
  preflightProductTruthCanonicalRecipeReconciliation,
  renderProductTruthCanonicalRecipeReconcilePlan,
  renderProductTruthCanonicalRecipeReconcilePreflight,
  renderProductTruthCanonicalRecipeReconcileReport,
  type ProductTruthCanonicalRecipeReconcilePlan,
  type ProductTruthCanonicalRecipeReconcilePreflight,
} from "../src/lib/sourcing/product-truth-canonical-recipe-reconcile";
import {
  type ProductTruthLegacyBridgeStandingPolicy,
} from "../src/lib/sourcing/product-truth-legacy-bridge-apply";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Command = "plan" | "preflight" | "apply";

type Options = {
  command: Command;
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  outDir: string;
  listingKeys: string[];
  manifestSha256: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  planPath: string | null;
  planSha256: string | null;
  checkedAt: string | null;
  policyPath: string | null;
  policySha256: string | null;
  preflightPath: string | null;
  preflightSha256: string | null;
  startedAt: string | null;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/product-truth-canonical-recipe-reconcile.ts plan",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --manifest-sha256 SHA --listing-key KEY (repeatable, 1-50)",
    "    --created-at ISO --expires-at ISO --out ABS_NEW_DIR",
    "",
    "  ... preflight",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --plan ABS_PATH --plan-sha256 SHA --checked-at ISO",
    "    --out ABS_NEW_DIR",
    "",
    "  ... apply",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --plan ABS_PATH --plan-sha256 SHA",
    "    --standing-policy ABS_PATH --standing-policy-sha256 SHA",
    "    --preflight ABS_PATH --preflight-sha256 SHA",
    "    --started-at ISO --out ABS_NEW_DIR",
    "",
    "Safety: exact explicit scope, no provider/retailer/marketplace calls,",
    "append-only listing recipes only, maximum 100 database rows per wave.",
  ].join("\n");
}

function exactPath(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value)) fail("ABSOLUTE_PATH_REQUIRED", flag);
  return value;
}

function exactSha(value: string | undefined, flag: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) fail("SHA256_REQUIRED", flag);
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const command = argv[0];
  if (command !== "plan" && command !== "preflight" && command !== "apply") {
    fail("COMMAND_REQUIRED", "expected plan, preflight, or apply");
  }
  const values = new Map<string, string>();
  const listingKeys: string[] = [];
  let allowRemote = false;
  const allowed = new Set([
    "--url",
    "--url-env",
    "--auth-token-env",
    "--allow-remote",
    "--out",
    "--listing-key",
    "--manifest-sha256",
    "--created-at",
    "--expires-at",
    "--plan",
    "--plan-sha256",
    "--checked-at",
    "--standing-policy",
    "--standing-policy-sha256",
    "--preflight",
    "--preflight-sha256",
    "--started-at",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
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
    if (flag === "--listing-key") {
      listingKeys.push(value);
    } else {
      if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    }
    index += 1;
  }
  const directUrl = values.get("--url");
  const urlEnv = values.get("--url-env");
  if ((directUrl ? 1 : 0) + (urlEnv ? 1 : 0) !== 1) {
    fail("DATABASE_URL_REQUIRED", "provide exactly one of --url or --url-env");
  }
  const url = directUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_REQUIRED", `environment ${urlEnv} is empty`);
  const outDir = exactPath(values.get("--out"), "--out");
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const commandFlags: Record<Command, ReadonlySet<string>> = {
    plan: new Set([
      "--url", "--url-env", "--auth-token-env", "--out",
      "--manifest-sha256", "--created-at", "--expires-at",
    ]),
    preflight: new Set([
      "--url", "--url-env", "--auth-token-env", "--out",
      "--plan", "--plan-sha256", "--checked-at",
    ]),
    apply: new Set([
      "--url", "--url-env", "--auth-token-env", "--out",
      "--plan", "--plan-sha256", "--standing-policy",
      "--standing-policy-sha256", "--preflight", "--preflight-sha256",
      "--started-at",
    ]),
  };
  for (const flag of values.keys()) {
    if (!commandFlags[command].has(flag)) {
      fail("CLI_ARGUMENT_FORBIDDEN", `${flag} is not valid for ${command}`);
    }
  }
  const options: Options = {
    command,
    url,
    authTokenEnv: values.get("--auth-token-env") ?? null,
    allowRemote,
    outDir,
    listingKeys,
    manifestSha256: null,
    createdAt: null,
    expiresAt: null,
    planPath: null,
    planSha256: null,
    checkedAt: null,
    policyPath: null,
    policySha256: null,
    preflightPath: null,
    preflightSha256: null,
    startedAt: null,
  };
  if (command === "plan") {
    if (!listingKeys.length) fail("CLI_ARGUMENT_REQUIRED", "--listing-key");
    options.manifestSha256 = exactSha(
      required("--manifest-sha256"),
      "--manifest-sha256",
    );
    options.createdAt = required("--created-at");
    options.expiresAt = required("--expires-at");
  } else {
    if (listingKeys.length) fail("CLI_ARGUMENT_FORBIDDEN", "--listing-key");
    options.planPath = exactPath(values.get("--plan"), "--plan");
    options.planSha256 = exactSha(
      required("--plan-sha256"),
      "--plan-sha256",
    );
    if (command === "preflight") {
      options.checkedAt = required("--checked-at");
    } else {
      options.policyPath = exactPath(
        values.get("--standing-policy"),
        "--standing-policy",
      );
      options.policySha256 = exactSha(
        required("--standing-policy-sha256"),
        "--standing-policy-sha256",
      );
      options.preflightPath = exactPath(
        values.get("--preflight"),
        "--preflight",
      );
      options.preflightSha256 = exactSha(
        required("--preflight-sha256"),
        "--preflight-sha256",
      );
      options.startedAt = required("--started-at");
    }
  }
  return options;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readExact(path: string): Promise<string> {
  const value = await readFile(path, "utf8");
  if (!value.endsWith("\n")) fail("ARTIFACT_NOT_CANONICAL", path);
  return value;
}

async function writeNewFile(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeArtifactSet(
  outDir: string,
  files: ReadonlyArray<{ name: string; value: string }>,
): Promise<void> {
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  await Promise.all(files.map((file) =>
    writeNewFile(resolve(outDir, file.name), file.value)));
}

function openDatabase(options: Options): {
  target: ReturnType<typeof resolveProductTruthDatabaseTarget>;
  db: ReturnType<typeof createClient>;
} {
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

async function runPlan(options: Options): Promise<void> {
  const { target, db } = openDatabase(options);
  try {
    const plan = await planProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: target.fingerprint,
      manifestSha256: options.manifestSha256!,
      listingKeys: options.listingKeys,
      createdAt: options.createdAt!,
      expiresAt: options.expiresAt!,
    });
    const planJson = renderProductTruthCanonicalRecipeReconcilePlan(plan);
    const planSha256 = sha256(planJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion:
        "product-truth-canonical-recipe-reconcile-artifact-index/1.0.0",
      status: "PLANNED",
      generatedAt: plan.createdAt,
      databaseTargetFingerprint: target.fingerprint,
      planId: plan.planId,
      planSha256,
      counts: {
        listings: plan.targets.length,
        maximumDatabaseRows: plan.databaseWrites.maximumRows,
        providerCalls: 0,
        paidCalls: 0,
        marketplaceMutations: 0,
      },
      artifacts: [{
        role: "reconcile_plan",
        file: "reconcile-plan.json",
        sha256: planSha256,
      }],
    });
    await writeArtifactSet(options.outDir, [
      { name: "reconcile-plan.json", value: planJson },
      { name: "reconcile-plan.sha256", value: `${planSha256}\n` },
      { name: "artifact-index.json", value: indexJson },
      { name: "artifact-index.sha256", value: `${sha256(indexJson)}\n` },
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

async function readPlan(options: Options): Promise<{
  plan: ProductTruthCanonicalRecipeReconcilePlan;
  planJson: string;
}> {
  const planJson = await readExact(options.planPath!);
  if (sha256(planJson) !== options.planSha256) {
    fail("PLAN_SHA256_MISMATCH", "plan bytes differ");
  }
  return {
    plan: JSON.parse(planJson) as ProductTruthCanonicalRecipeReconcilePlan,
    planJson,
  };
}

async function runPreflight(options: Options): Promise<void> {
  const { target, db } = openDatabase(options);
  try {
    const { plan, planJson } = await readPlan(options);
    const report = await preflightProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: target.fingerprint,
      plan,
      planJson,
      planSha256: options.planSha256!,
      checkedAt: options.checkedAt!,
    });
    const reportJson =
      renderProductTruthCanonicalRecipeReconcilePreflight(report);
    const reportSha256 = sha256(reportJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion:
        "product-truth-canonical-recipe-reconcile-preflight-index/1.0.0",
      status: report.status,
      checkedAt: report.checkedAt,
      databaseTargetFingerprint: target.fingerprint,
      planSha256: options.planSha256,
      artifacts: [{
        role: "preflight_report",
        file: "preflight-report.json",
        sha256: reportSha256,
      }],
    });
    await writeArtifactSet(options.outDir, [
      { name: "preflight-report.json", value: reportJson },
      { name: "preflight-report.sha256", value: `${reportSha256}\n` },
      { name: "artifact-index.json", value: indexJson },
      { name: "artifact-index.sha256", value: `${sha256(indexJson)}\n` },
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

async function runApply(options: Options): Promise<void> {
  const { target, db } = openDatabase(options);
  try {
    const { plan, planJson } = await readPlan(options);
    const [policyJson, preflightJson] = await Promise.all([
      readExact(options.policyPath!),
      readExact(options.preflightPath!),
    ]);
    if (sha256(policyJson) !== options.policySha256) {
      fail("STANDING_POLICY_SHA256_MISMATCH", "policy bytes differ");
    }
    if (sha256(preflightJson) !== options.preflightSha256) {
      fail("PREFLIGHT_SHA256_MISMATCH", "preflight bytes differ");
    }
    const report = await applyProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: target.fingerprint,
      plan,
      planJson,
      planSha256: options.planSha256!,
      standingPolicy:
        JSON.parse(policyJson) as ProductTruthLegacyBridgeStandingPolicy,
      standingPolicyJson: policyJson,
      standingPolicySha256: options.policySha256!,
      preflight:
        JSON.parse(preflightJson) as ProductTruthCanonicalRecipeReconcilePreflight,
      preflightJson,
      preflightSha256: options.preflightSha256!,
      startedAt: options.startedAt!,
    });
    const reportJson = renderProductTruthCanonicalRecipeReconcileReport(report);
    const reportSha256 = sha256(reportJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion:
        "product-truth-canonical-recipe-reconcile-result-index/1.0.0",
      status: report.status,
      completedAt: report.completedAt,
      databaseTargetFingerprint: target.fingerprint,
      planSha256: options.planSha256,
      standingPolicySha256: options.policySha256,
      preflightReportSha256: options.preflightSha256,
      artifacts: [{
        role: "apply_report",
        file: "apply-report.json",
        sha256: reportSha256,
      }],
    });
    await writeArtifactSet(options.outDir, [
      { name: "apply-report.json", value: reportJson },
      { name: "apply-report.sha256", value: `${reportSha256}\n` },
      { name: "artifact-index.json", value: indexJson },
      { name: "artifact-index.sha256", value: `${sha256(indexJson)}\n` },
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseOptions(argv);
  if (options.command === "plan") {
    await runPlan(options);
  } else if (options.command === "preflight") {
    await runPreflight(options);
  } else {
    await runApply(options);
  }
}

const invokedAsMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
