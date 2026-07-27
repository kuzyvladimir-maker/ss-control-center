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
  PRODUCT_TRUTH_LEGACY_BRIDGE_APPROVAL_VERSION,
  applyProductTruthLegacyBridgeCanary,
  expectedProductTruthLegacyBridgeConfirmation,
  planProductTruthLegacyBridgeApply,
  preflightProductTruthLegacyBridgeCanary,
  renderProductTruthLegacyBridgeApplyPlan,
  renderProductTruthLegacyBridgeApplyReport,
  renderProductTruthLegacyBridgeApproval,
  renderProductTruthLegacyBridgePreflightReport,
  type ProductTruthLegacyBridgeApplyPlan,
  type ProductTruthLegacyBridgeApproval,
} from "../src/lib/sourcing/product-truth-legacy-bridge-apply";
import {
  productTruthLegacyBridgeBytesSha256,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import { resolveProductTruthDatabaseTarget } from "../src/lib/sourcing/product-truth-database-target";
import { renderProductTruthOperationalJson } from "../src/lib/sourcing/product-truth-operational-run-contract";

type PlanOptions = {
  command: "plan";
  snapshotPath: string;
  bridgePlanPath: string;
  listingKeys: string[];
  createdAt: string;
  expiresAt: string;
  outDir: string;
};

type ApplyOptions = {
  command: "apply";
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  snapshotPath: string;
  bridgePlanPath: string;
  applyPlanPath: string;
  expectedPlanSha256: string;
  approvalPath: string;
  expectedApprovalSha256: string;
  confirmation: string;
  startedAt: string;
  outDir: string;
};

type PreflightOptions = {
  command: "preflight";
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  snapshotPath: string;
  bridgePlanPath: string;
  applyPlanPath: string;
  expectedPlanSha256: string;
  checkedAt: string;
  outDir: string;
};

type CliOptions = PlanOptions | PreflightOptions | ApplyOptions;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:legacy-bridge-canary -- plan",
    "    --snapshot ABS_PATH --bridge-plan ABS_PATH",
    "    --listing-key KEY (exactly five times)",
    "    --created-at ISO --expires-at ISO --out ABS_NEW_DIR",
    "",
    "  npm run product-truth:legacy-bridge-canary -- preflight",
    "    (--url URL | --url-env ENV_NAME) [--allow-remote --auth-token-env ENV]",
    "    --snapshot ABS_PATH --bridge-plan ABS_PATH",
    "    --apply-plan ABS_PATH --plan-sha256 SHA256",
    "    --checked-at ISO --out ABS_NEW_DIR",
    "",
    "  npm run product-truth:legacy-bridge-canary -- apply",
    "    (--url URL | --url-env ENV_NAME) [--allow-remote --auth-token-env ENV]",
    "    --snapshot ABS_PATH --bridge-plan ABS_PATH",
    "    --apply-plan ABS_PATH --plan-sha256 SHA256",
    "    --approval ABS_PATH --approval-sha256 SHA256",
    "    --confirmation EXACT_TOKEN --started-at ISO --out ABS_NEW_DIR",
    "",
    "Safety:",
    "  plan is offline/read-only.",
    "  apply writes only the five owner-approved canonical graphs in one transaction.",
    "  no provider, paid, retailer, marketplace, procurement, or consumer-cutover action.",
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

function parseOptions(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command !== "plan" && command !== "preflight" && command !== "apply") {
    fail("COMMAND_REQUIRED", "expected plan, preflight, or apply");
  }
  const values = new Map<string, string>();
  const listingKeys: string[] = [];
  let allowRemote = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", flag);
      allowRemote = true;
      continue;
    }
    const allowed = new Set([
      "--snapshot", "--bridge-plan", "--listing-key", "--created-at",
      "--expires-at", "--out", "--url", "--url-env", "--auth-token-env",
      "--apply-plan", "--plan-sha256", "--approval", "--approval-sha256",
      "--confirmation", "--started-at", "--checked-at",
    ]);
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    if (flag === "--listing-key") {
      listingKeys.push(value);
    } else {
      if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    }
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const snapshotPath = exactPath(required("--snapshot"), "--snapshot");
  const bridgePlanPath = exactPath(required("--bridge-plan"), "--bridge-plan");
  const outDir = exactPath(required("--out"), "--out");
  if (command === "plan") {
    if (allowRemote) fail("CLI_ARGUMENT_FORBIDDEN", "--allow-remote is apply-only");
    return {
      command,
      snapshotPath,
      bridgePlanPath,
      listingKeys,
      createdAt: required("--created-at"),
      expiresAt: required("--expires-at"),
      outDir,
    };
  }
  if (listingKeys.length) fail("CLI_ARGUMENT_FORBIDDEN", "--listing-key is plan-only");
  const literalUrl = values.get("--url")?.trim() || null;
  const urlEnv = values.get("--url-env")?.trim() || null;
  if ((literalUrl ? 1 : 0) + (urlEnv ? 1 : 0) !== 1) {
    fail("DATABASE_URL_SOURCE_INVALID", "provide exactly one of --url or --url-env");
  }
  const url = literalUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_ENV_EMPTY", urlEnv!);
  const connected = {
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    snapshotPath,
    bridgePlanPath,
    applyPlanPath: exactPath(required("--apply-plan"), "--apply-plan"),
    expectedPlanSha256: exactSha(required("--plan-sha256"), "--plan-sha256"),
    outDir,
  };
  if (command === "preflight") {
    return {
      command,
      ...connected,
      checkedAt: required("--checked-at"),
    };
  }
  return {
    command,
    ...connected,
    approvalPath: exactPath(required("--approval"), "--approval"),
    expectedApprovalSha256: exactSha(
      required("--approval-sha256"),
      "--approval-sha256",
    ),
    confirmation: required("--confirmation"),
    startedAt: required("--started-at"),
  };
}

async function readExact(path: string): Promise<string> {
  return readFile(await realpath(path), "utf8");
}

async function writeNewFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function createNewArtifactDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path, { recursive: false, mode: 0o700 });
}

async function loadSourceArtifacts(input: {
  snapshotPath: string;
  bridgePlanPath: string;
}): Promise<{
  snapshotJson: string;
  snapshotSha256: string;
  snapshot: ProductTruthLegacyBridgeSnapshot;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  bridgePlan: ProductTruthLegacyBridgePlan;
}> {
  const [snapshotJson, bridgePlanJson] = await Promise.all([
    readExact(input.snapshotPath),
    readExact(input.bridgePlanPath),
  ]);
  let snapshot: ProductTruthLegacyBridgeSnapshot;
  let bridgePlan: ProductTruthLegacyBridgePlan;
  try {
    snapshot = JSON.parse(snapshotJson) as ProductTruthLegacyBridgeSnapshot;
    bridgePlan = JSON.parse(bridgePlanJson) as ProductTruthLegacyBridgePlan;
  } catch {
    fail("SOURCE_ARTIFACT_JSON_INVALID", "snapshot or bridge plan is not JSON");
  }
  return {
    snapshotJson,
    snapshotSha256: productTruthLegacyBridgeBytesSha256(snapshotJson),
    snapshot,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
    bridgePlan,
  };
}

async function runPlan(options: PlanOptions): Promise<void> {
  const source = await loadSourceArtifacts(options);
  const plan = planProductTruthLegacyBridgeApply({
    ...source,
    listingKeys: options.listingKeys,
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
  });
  const planJson = renderProductTruthLegacyBridgeApplyPlan(plan);
  const planSha256 = productTruthLegacyBridgeBytesSha256(planJson);
  const approvalTemplate: ProductTruthLegacyBridgeApproval = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_APPROVAL_VERSION,
    decision: "APPROVE_NO_PAID_LEGACY_BRIDGE_CANARY",
    approvedBy: "owner",
    approvalId: plan.expectedApprovalId,
    planId: plan.planId,
    planSha256,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    sourceSnapshotSha256: plan.source.snapshotSha256,
    bridgePlanSha256: plan.source.bridgePlanSha256,
    targetsSha256: plan.targetsSha256,
    listingKeys: plan.targets.map((target) => target.listingKey),
    maximumDatabaseRows: plan.databaseWrites.maximumRows,
    allowCanonicalMaterialization: true,
    allowProviderCalls: false,
    allowPaidCalls: false,
    allowMarketplaceMutations: false,
    allowProcurementMutations: false,
    allowConsumerCutover: false,
    issuedAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
  const approvalTemplateJson = renderProductTruthLegacyBridgeApproval(approvalTemplate);
  const confirmation = expectedProductTruthLegacyBridgeConfirmation(plan, planSha256);
  const index = {
    schemaVersion: "product-truth-legacy-bridge-canary-artifact-index/1.0.0",
    generatedAt: plan.createdAt,
    status: "AWAITING_OWNER_APPROVAL",
    source: plan.source,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    counts: {
      listings: plan.targets.length,
      maximumDatabaseRows: plan.databaseWrites.maximumRows,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
    },
    artifacts: [
      { role: "apply_plan", file: "apply-plan.json", sha256: planSha256 },
      {
        role: "unapproved_owner_template",
        file: "UNAPPROVED-owner-approval-template.json",
        sha256: productTruthLegacyBridgeBytesSha256(approvalTemplateJson),
      },
      {
        role: "required_confirmation",
        file: "required-confirmation.txt",
        sha256: productTruthLegacyBridgeBytesSha256(`${confirmation}\n`),
      },
    ],
  };
  const indexJson = renderProductTruthOperationalJson(index);
  await createNewArtifactDirectory(options.outDir);
  await Promise.all([
    writeNewFile(resolve(options.outDir, "apply-plan.json"), planJson),
    writeNewFile(resolve(options.outDir, "apply-plan.sha256"), `${planSha256}\n`),
    writeNewFile(
      resolve(options.outDir, "UNAPPROVED-owner-approval-template.json"),
      approvalTemplateJson,
    ),
    writeNewFile(
      resolve(options.outDir, "required-confirmation.txt"),
      `${confirmation}\n`,
    ),
    writeNewFile(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNewFile(
      resolve(options.outDir, "artifact-index.sha256"),
      `${productTruthLegacyBridgeBytesSha256(indexJson)}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
}

async function runApply(options: ApplyOptions): Promise<void> {
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
      "--auth-token-env must name a populated environment variable",
    );
  }
  const source = await loadSourceArtifacts(options);
  const [planJson, approvalJson] = await Promise.all([
    readExact(options.applyPlanPath),
    readExact(options.approvalPath),
  ]);
  const plan = JSON.parse(planJson) as ProductTruthLegacyBridgeApplyPlan;
  if (
    source.snapshotSha256 !== plan.source.snapshotSha256
    || source.bridgePlanSha256 !== plan.source.bridgePlanSha256
  ) {
    fail("SOURCE_ARTIFACT_SHA256_MISMATCH", "source custody differs from apply plan");
  }
  const approval = JSON.parse(approvalJson) as ProductTruthLegacyBridgeApproval;
  const db = createClient({
    url: target.clientUrl,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const report = await applyProductTruthLegacyBridgeCanary({
      db,
      databaseTargetFingerprint: target.fingerprint,
      plan,
      planJson,
      planSha256: options.expectedPlanSha256,
      approval,
      approvalJson,
      approvalSha256: options.expectedApprovalSha256,
      confirmation: options.confirmation,
      startedAt: options.startedAt,
      completedAt: new Date().toISOString(),
    });
    const reportJson = renderProductTruthLegacyBridgeApplyReport(report);
    const reportSha256 = productTruthLegacyBridgeBytesSha256(reportJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion: "product-truth-legacy-bridge-canary-result-index/1.0.0",
      completedAt: report.completedAt,
      status: report.status,
      databaseTargetFingerprint: target.fingerprint,
      planSha256: options.expectedPlanSha256,
      approvalSha256: options.expectedApprovalSha256,
      artifacts: [
        { role: "apply_report", file: "apply-report.json", sha256: reportSha256 },
      ],
    });
    await createNewArtifactDirectory(options.outDir);
    await Promise.all([
      writeNewFile(resolve(options.outDir, "apply-report.json"), reportJson),
      writeNewFile(resolve(options.outDir, "apply-report.sha256"), `${reportSha256}\n`),
      writeNewFile(resolve(options.outDir, "artifact-index.json"), indexJson),
      writeNewFile(
        resolve(options.outDir, "artifact-index.sha256"),
        `${productTruthLegacyBridgeBytesSha256(indexJson)}\n`,
      ),
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

async function runPreflight(options: PreflightOptions): Promise<void> {
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
      "--auth-token-env must name a populated environment variable",
    );
  }
  const source = await loadSourceArtifacts(options);
  const planJson = await readExact(options.applyPlanPath);
  const plan = JSON.parse(planJson) as ProductTruthLegacyBridgeApplyPlan;
  if (
    source.snapshotSha256 !== plan.source.snapshotSha256
    || source.bridgePlanSha256 !== plan.source.bridgePlanSha256
  ) {
    fail("SOURCE_ARTIFACT_SHA256_MISMATCH", "source custody differs from apply plan");
  }
  const db = createClient({
    url: target.clientUrl,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const report = await preflightProductTruthLegacyBridgeCanary({
      db,
      databaseTargetFingerprint: target.fingerprint,
      plan,
      planJson,
      planSha256: options.expectedPlanSha256,
      checkedAt: options.checkedAt,
    });
    const reportJson = renderProductTruthLegacyBridgePreflightReport(report);
    const reportSha256 = productTruthLegacyBridgeBytesSha256(reportJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion: "product-truth-legacy-bridge-canary-preflight-index/1.0.0",
      checkedAt: report.checkedAt,
      status: report.status,
      databaseTargetFingerprint: target.fingerprint,
      planSha256: options.expectedPlanSha256,
      artifacts: [
        { role: "preflight_report", file: "preflight-report.json", sha256: reportSha256 },
      ],
    });
    await createNewArtifactDirectory(options.outDir);
    await Promise.all([
      writeNewFile(resolve(options.outDir, "preflight-report.json"), reportJson),
      writeNewFile(resolve(options.outDir, "preflight-report.sha256"), `${reportSha256}\n`),
      writeNewFile(resolve(options.outDir, "artifact-index.json"), indexJson),
      writeNewFile(
        resolve(options.outDir, "artifact-index.sha256"),
        `${productTruthLegacyBridgeBytesSha256(indexJson)}\n`,
      ),
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
  if (options.command === "plan") await runPlan(options);
  else if (options.command === "preflight") await runPreflight(options);
  else await runApply(options);
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
