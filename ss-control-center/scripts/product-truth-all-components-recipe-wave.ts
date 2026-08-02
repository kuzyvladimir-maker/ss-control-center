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
  applyProductTruthAllComponentsRecipeMaterialization,
  planProductTruthAllComponentsRecipeMaterialization,
  preflightProductTruthAllComponentsRecipeMaterialization,
  renderProductTruthAllComponentsRecipePlan,
  renderProductTruthAllComponentsRecipePreflight,
  renderProductTruthAllComponentsRecipeReport,
  type ProductTruthAllComponentsRecipePlan,
  type ProductTruthAllComponentsRecipePreflight,
  type ProductTruthAllComponentsRecipeSources,
} from "../src/lib/sourcing/product-truth-all-components-recipe-materialization";
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
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import type {
  ProductTruthRecipeRepairScope,
} from "../src/lib/sourcing/product-truth-recipe-repair-scope";
import type {
  ProductTruthTargetIdentityResolution,
} from "../src/lib/sourcing/product-truth-target-identity-resolution";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Command = "plan" | "preflight" | "apply";
type JsonRecord = Record<string, unknown>;

type Options = {
  command: Command;
  recipeRepairScopePath: string;
  recipeRepairScopeSha256: string;
  componentScopePath: string;
  componentScopeSha256: string;
  bridgeSnapshotPath: string;
  bridgeSnapshotSha256: string;
  standingPolicyPath: string;
  standingPolicySha256: string;
  targetIdentityResolutionPath: string | null;
  targetIdentityResolutionSha256: string | null;
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  outDir: string;
  listingKeys: string[];
  createdAt: string | null;
  expiresAt: string | null;
  planPath: string | null;
  planSha256: string | null;
  checkedAt: string | null;
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
    "  npm run product-truth:all-components-recipe-wave -- plan",
    "    --recipe-repair-scope ABS_JSON --recipe-repair-scope-sha256 SHA",
    "    --component-scope ABS_JSON --component-scope-sha256 SHA",
    "    --bridge-snapshot ABS_JSON --bridge-snapshot-sha256 SHA",
    "    --standing-policy ABS_JSON --standing-policy-sha256 SHA",
    "    [--target-identity-resolution ABS_JSON --target-identity-resolution-sha256 SHA]",
    "    (--url URL | --url-env ENV) [--allow-remote --auth-token-env ENV]",
    "    --listing-key KEY (repeatable, explicit 1-50)",
    "    --created-at UTC --expires-at UTC --out ABS_NEW_DIR",
    "",
    "  ... preflight",
    "    [same source/database flags]",
    "    --plan ABS_JSON --plan-sha256 SHA --checked-at UTC",
    "    --out ABS_NEW_DIR",
    "",
    "  ... apply",
    "    [same source/database/plan flags]",
    "    --preflight ABS_JSON --preflight-sha256 SHA --started-at UTC",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: explicit all-components-exact scope only; one atomic <=100-row",
    "append-only recipe + typed UNSOURCEABLE COGS wave. Legacy donor links",
    "are ignored. No provider, retailer, marketplace, procurement, price,",
    "inventory, delisting, or consumer-activation effects.",
  ].join("\n");
}

function exactSha(value: string | undefined, flag: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    fail("SHA256_REQUIRED", flag);
  }
  return value;
}

function exactPath(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    fail("ABSOLUTE_PATH_REQUIRED", flag);
  }
  return value;
}

function exactInstant(value: string | undefined, flag: string): string {
  if (
    !value
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail("CANONICAL_UTC_REQUIRED", flag);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const command = argv[0] as Command | undefined;
  if (!command || !["plan", "preflight", "apply"].includes(command)) {
    fail("COMMAND_REQUIRED", "expected plan, preflight, or apply");
  }
  const values = new Map<string, string>();
  const listingKeys: string[] = [];
  let allowRemote = false;
  const allowed = new Set([
    "--recipe-repair-scope",
    "--recipe-repair-scope-sha256",
    "--component-scope",
    "--component-scope-sha256",
    "--bridge-snapshot",
    "--bridge-snapshot-sha256",
    "--standing-policy",
    "--standing-policy-sha256",
    "--target-identity-resolution",
    "--target-identity-resolution-sha256",
    "--url",
    "--url-env",
    "--auth-token-env",
    "--allow-remote",
    "--listing-key",
    "--created-at",
    "--expires-at",
    "--plan",
    "--plan-sha256",
    "--checked-at",
    "--preflight",
    "--preflight-sha256",
    "--started-at",
    "--out",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
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
  const directUrl = values.get("--url")?.trim() || null;
  const urlEnv = values.get("--url-env")?.trim() || null;
  if (Number(Boolean(directUrl)) + Number(Boolean(urlEnv)) !== 1) {
    fail(
      "DATABASE_URL_REQUIRED",
      "provide exactly one of --url or --url-env",
    );
  }
  const url = directUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_REQUIRED", `environment ${urlEnv} is empty`);
  const options: Options = {
    command,
    recipeRepairScopePath: exactPath(
      values.get("--recipe-repair-scope"),
      "--recipe-repair-scope",
    ),
    recipeRepairScopeSha256: exactSha(
      values.get("--recipe-repair-scope-sha256"),
      "--recipe-repair-scope-sha256",
    ),
    componentScopePath: exactPath(
      values.get("--component-scope"),
      "--component-scope",
    ),
    componentScopeSha256: exactSha(
      values.get("--component-scope-sha256"),
      "--component-scope-sha256",
    ),
    bridgeSnapshotPath: exactPath(
      values.get("--bridge-snapshot"),
      "--bridge-snapshot",
    ),
    bridgeSnapshotSha256: exactSha(
      values.get("--bridge-snapshot-sha256"),
      "--bridge-snapshot-sha256",
    ),
    standingPolicyPath: exactPath(
      values.get("--standing-policy"),
      "--standing-policy",
    ),
    standingPolicySha256: exactSha(
      values.get("--standing-policy-sha256"),
      "--standing-policy-sha256",
    ),
    targetIdentityResolutionPath: values.has("--target-identity-resolution")
      ? exactPath(
        values.get("--target-identity-resolution"),
        "--target-identity-resolution",
      )
      : null,
    targetIdentityResolutionSha256:
      values.has("--target-identity-resolution-sha256")
        ? exactSha(
          values.get("--target-identity-resolution-sha256"),
          "--target-identity-resolution-sha256",
        )
        : null,
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    outDir: exactPath(values.get("--out"), "--out"),
    listingKeys,
    createdAt: null,
    expiresAt: null,
    planPath: null,
    planSha256: null,
    checkedAt: null,
    preflightPath: null,
    preflightSha256: null,
    startedAt: null,
  };
  if (
    Boolean(options.targetIdentityResolutionPath)
      !== Boolean(options.targetIdentityResolutionSha256)
  ) {
    fail(
      "CLI_ARGUMENT_PAIR_REQUIRED",
      "target identity resolution path and SHA-256 must be supplied together",
    );
  }
  if (command === "plan") {
    if (!listingKeys.length) fail("CLI_ARGUMENT_REQUIRED", "--listing-key");
    options.listingKeys = [...listingKeys].sort((left, right) =>
      left.localeCompare(right, "en-US"));
    options.createdAt = exactInstant(
      values.get("--created-at"),
      "--created-at",
    );
    options.expiresAt = exactInstant(
      values.get("--expires-at"),
      "--expires-at",
    );
  } else {
    if (listingKeys.length) fail("CLI_ARGUMENT_FORBIDDEN", "--listing-key");
    options.planPath = exactPath(values.get("--plan"), "--plan");
    options.planSha256 = exactSha(
      values.get("--plan-sha256"),
      "--plan-sha256",
    );
    if (command === "preflight") {
      options.checkedAt = exactInstant(
        values.get("--checked-at"),
        "--checked-at",
      );
    } else {
      options.preflightPath = exactPath(
        values.get("--preflight"),
        "--preflight",
      );
      options.preflightSha256 = exactSha(
        values.get("--preflight-sha256"),
        "--preflight-sha256",
      );
      options.startedAt = exactInstant(
        values.get("--started-at"),
        "--started-at",
      );
    }
  }
  return options;
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
  options: Options,
): Promise<ProductTruthAllComponentsRecipeSources> {
  const [recipe, component, snapshot, policy, resolution] = await Promise.all([
    readJson<ProductTruthRecipeRepairScope>(options.recipeRepairScopePath),
    readJson<ProductTruthComponentAcquisitionScope>(options.componentScopePath),
    readJson<ProductTruthLegacyBridgeSnapshot>(options.bridgeSnapshotPath),
    readJson<ProductTruthLegacyBridgeStandingPolicy>(
      options.standingPolicyPath,
    ),
    options.targetIdentityResolutionPath
      ? readJson<ProductTruthTargetIdentityResolution>(
        options.targetIdentityResolutionPath,
      )
      : Promise.resolve(null),
  ]);
  return {
    recipeRepairScope: recipe.value,
    recipeRepairScopeJson: recipe.json,
    recipeRepairScopeSha256: options.recipeRepairScopeSha256,
    componentScope: component.value,
    componentScopeJson: component.json,
    componentScopeSha256: options.componentScopeSha256,
    bridgeSnapshot: snapshot.value,
    bridgeSnapshotJson: snapshot.json,
    bridgeSnapshotSha256: options.bridgeSnapshotSha256,
    standingPolicy: policy.value,
    standingPolicyJson: policy.json,
    standingPolicySha256: options.standingPolicySha256,
    targetIdentityResolution: resolution?.value ?? null,
    targetIdentityResolutionJson: resolution?.json ?? null,
    targetIdentityResolutionSha256:
      options.targetIdentityResolutionSha256,
  };
}

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
      "product-truth-all-components-recipe-wave-artifact-index/1.0.0",
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

async function run(options: Options): Promise<void> {
  const sources = await loadSources(options);
  const { target, client } = databaseClient(options);
  try {
    if (options.command === "plan") {
      const plan = await planProductTruthAllComponentsRecipeMaterialization({
        db: client,
        sources,
        listingKeys: options.listingKeys,
        createdAt: options.createdAt!,
        expiresAt: options.expiresAt!,
      });
      const planJson = renderProductTruthAllComponentsRecipePlan(plan);
      await writeArtifact({
        options,
        role: "all_components_recipe_materialization_plan",
        file: "plan.json",
        content: planJson,
        index: {
          planId: plan.planId,
          createdAt: plan.createdAt,
          expiresAt: plan.expiresAt,
          databaseTargetFingerprint: plan.databaseTargetFingerprint,
          selectedListingKeys: plan.selectedListingKeys,
          databaseWrites: plan.databaseWrites,
          claims: plan.claims,
        },
      });
      return;
    }
    const plan = await readJson<ProductTruthAllComponentsRecipePlan>(
      options.planPath!,
    );
    if (options.command === "preflight") {
      const preflight =
        await preflightProductTruthAllComponentsRecipeMaterialization({
          db: client,
          databaseTargetFingerprint: target.fingerprint,
          plan: plan.value,
          planJson: plan.json,
          planSha256: options.planSha256!,
          sources,
          checkedAt: options.checkedAt!,
        });
      const preflightJson =
        renderProductTruthAllComponentsRecipePreflight(preflight);
      await writeArtifact({
        options,
        role: "all_components_recipe_materialization_preflight",
        file: "apply-preflight.json",
        content: preflightJson,
        index: {
          planId: preflight.planId,
          checkedAt: preflight.checkedAt,
          status: preflight.status,
          databaseTargetFingerprint: preflight.databaseTargetFingerprint,
          counts: preflight.counts,
        },
      });
      return;
    }
    const preflight =
      await readJson<ProductTruthAllComponentsRecipePreflight>(
        options.preflightPath!,
      );
    const report =
      await applyProductTruthAllComponentsRecipeMaterialization({
        db: client,
        databaseTargetFingerprint: target.fingerprint,
        plan: plan.value,
        planJson: plan.json,
        planSha256: options.planSha256!,
        sources,
        preflight: preflight.value,
        preflightJson: preflight.json,
        preflightSha256: options.preflightSha256!,
        startedAt: options.startedAt!,
      });
    const reportJson = renderProductTruthAllComponentsRecipeReport(report);
    await writeArtifact({
      options,
      role: "all_components_recipe_materialization_report",
      file: "apply-report.json",
      content: reportJson,
      index: {
        planId: report.planId,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        status: report.status,
        databaseTargetFingerprint: report.databaseTargetFingerprint,
        counts: report.counts,
        verification: report.verification,
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
