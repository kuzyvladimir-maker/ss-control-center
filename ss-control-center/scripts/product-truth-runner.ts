import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, parse as parsePath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";

import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  assertProductTruthOperationalManifestBinding,
  parseProductTruthOperationalPlan,
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
  validateProductTruthOperationalApproval,
  type ProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
  type ValidatedProductTruthOperationalApproval,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import { buildProductTruthOperationalPlanFromRequest } from "../src/lib/sourcing/product-truth-operational-plan-request";
import {
  assertProductTruthOperationalRunSchema,
  listProductTruthOperationalEvents,
  productTruthOperationalRunSummary,
} from "../src/lib/sourcing/product-truth-operational-run-store";
import {
  readProductTruthOperationalLedger,
} from "../src/lib/sourcing/product-truth-operational-ledger";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
  buildProductTruthTargetedWalmartEvidencePlan,
  buildProductTruthTargetedWalmartEvidenceRequest,
  parseProductTruthTargetedWalmartEvidencePlan,
  validateProductTruthTargetedWalmartEvidenceApproval,
  type ProductTruthTargetedWalmartEvidencePlan,
} from "../src/lib/sourcing/product-truth-targeted-walmart-evidence-contract";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_PRODUCTION_ADAPTER,
  executeProductTruthTargetedWalmartEvidence,
  inspectProductTruthTargetedWalmartEvidenceRun,
  readTargetedWalmartLegacyDonorSnapshot,
  readTargetedWalmartLegacyIdentityTemplate,
  readTargetedWalmartDonorSnapshot,
} from "../src/lib/sourcing/product-truth-targeted-walmart-evidence";
import {
  donorHarvestStateId,
  getDonorHarvestState,
} from "../src/lib/sourcing/donor-harvest-store";
import {
  inspectWalmartNewSkuSourceRelease,
} from "../src/lib/bundle-factory/walmart-new-sku-source-release";
import {
  readProductTruthConsumerReadiness,
  renderProductTruthConsumerReadinessJson,
  type ProductTruthConsumerReadinessReport,
} from "../src/lib/sourcing/product-truth-consumer-readiness";
import type {
  ExecuteProductTruthOperationalRunInput,
  ProductTruthOperationalExecutionResult,
} from "../src/lib/sourcing/product-truth-operational-runner";
import {
  renderPhase1ScopeManifestJson,
  type Phase1ScopeManifest,
} from "../src/lib/sourcing/phase1-scope-manifest";
import {
  PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
  type ProductTruthMigrationCertification,
} from "../src/lib/sourcing/product-truth-backfill-readiness";
import {
  PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION,
  PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION,
  applyProductTruthOwnerBackfill,
  planProductTruthOwnerBackfill,
  writeProductTruthBackfillPlanArtifacts,
  writeProductTruthBackfillReportArtifacts,
  type ProductTruthOwnerBackfillApproval,
  type ProductTruthOwnerBackfillPlan,
} from "./product-truth-backfill-writer";
import {
  parseProductTruthMatcherReplayCorpus,
  renderProductTruthMatcherReplayReportJson,
  runProductTruthMatcherReplay,
} from "../src/lib/sourcing/product-truth-matcher-replay";
import {
  canonicalProductTruthMigrationArtifact,
  loadProductTruthMigrationFiles,
  migrationSetSha256,
  planProductTruthMigrations,
  resolveDatabaseTarget,
  type ProductTruthMigrationPlan,
} from "./product-truth-migration-plan";

const APPROVAL_INSTRUCTIONS_VERSION =
  "product-truth-operational-approval-instructions/1.0.0" as const;
const ARTIFACT_INDEX_VERSION =
  "product-truth-operational-artifact-index/1.0.0" as const;
const STATUS_VERSION = "product-truth-operational-status/1.0.0" as const;
const INSPECTION_REPORT_VERSION =
  "product-truth-operational-inspection-report/1.0.0" as const;
const READINESS_ARTIFACT_INDEX_VERSION =
  "product-truth-consumer-readiness-artifact-index/1.0.0" as const;
const MATCHER_REPLAY_ARTIFACT_INDEX_VERSION =
  "product-truth-matcher-replay-artifact-index/1.0.0" as const;

const JSON_LIMIT_BYTES = 5 * 1024 * 1024;
const MANIFEST_LIMIT_BYTES = 100 * 1024 * 1024;
const BACKFILL_PLAN_LIMIT_BYTES = 100 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMANDS = [
  "doctor",
  "plan",
  "readiness",
  "backfill-plan",
  "backfill-apply",
  "matcher-replay",
  "execute",
  "resume",
  "status",
  "report",
] as const;

type ProductTruthRunnerCommand = (typeof COMMANDS)[number];
type DatabaseTarget = ReturnType<typeof resolveDatabaseTarget>;

interface CommonDatabaseOptions {
  databaseUrl: string;
  allowRemote: boolean;
  authTokenEnv?: string;
  help: boolean;
}

export type ProductTruthRunnerCliOptions =
  | {
      command: "matcher-replay";
      corpusPath: string;
      requiredCaseCount: number;
      outputDirectory: string;
      help: boolean;
    }
  | (CommonDatabaseOptions & {
      command: "doctor";
      donorProductId?: string;
      query?: string;
      runId?: string;
      expiresAt?: string;
      unwrangleReserveFloor?: number;
      outputDirectory?: string;
      canonicalIdentityPath?: string;
    })
  | (CommonDatabaseOptions & {
      command: "plan";
      requestPath: string;
      manifestPath?: string;
      outputDirectory: string;
    })
  | (CommonDatabaseOptions & {
      command: "readiness";
      manifestPath: string;
      asOf: string;
      maxPriceAgeMs: number;
      outputDirectory: string;
    })
  | (CommonDatabaseOptions & {
      command: "backfill-plan";
      manifestPath: string;
      migrationCertificationPath: string;
      migrationCertificationShaPath: string;
      migrationReportPath: string;
      migrationReportShaPath: string;
      planId: string;
      expiresAt: string;
      outputDirectory: string;
    })
  | (CommonDatabaseOptions & {
      command: "backfill-apply";
      planPath: string;
      planShaPath: string;
      manifestPath: string;
      approvalPath: string;
      approvalShaPath: string;
      executionConfirmation: string;
      outputDirectory: string;
    })
  | (CommonDatabaseOptions & {
      command: "execute" | "resume";
      planPath: string;
      planShaPath: string;
      manifestPath?: string;
      approvalPath: string;
      executionConfirmation: string;
      outputDirectory: string;
    })
  | (CommonDatabaseOptions & {
      command: "status" | "report";
      runId: string;
    });

export class ProductTruthRunnerCliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthRunnerCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageError(code: string, message: string): never {
  throw new ProductTruthRunnerCliError(code, message, 64);
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new ProductTruthRunnerCliError(code, message, 1, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail("ARTIFACT_SHAPE_INVALID", `${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactValue(value: string | undefined, flag: string): string {
  if (!value || value !== value.trim()) usageError("CLI_ARGUMENT_REQUIRED", `${flag} is required`);
  return value;
}

type FlagMap = Map<string, string | true>;

const COMMAND_VALUE_FLAGS: Record<ProductTruthRunnerCommand, readonly string[]> = {
  doctor: [
    "--url", "--auth-token-env", "--donor-product-id", "--query", "--run-id",
    "--expires-at", "--unwrangle-reserve-floor", "--out", "--canonical-identity",
  ],
  plan: ["--url", "--auth-token-env", "--request", "--manifest", "--out"],
  readiness: [
    "--url", "--auth-token-env", "--manifest", "--as-of",
    "--max-price-age-ms", "--out",
  ],
  "backfill-plan": [
    "--url", "--auth-token-env", "--manifest", "--migration-certification",
    "--migration-certification-sha", "--migration-report", "--migration-report-sha",
    "--plan-id", "--expires-at", "--out",
  ],
  "backfill-apply": [
    "--url", "--auth-token-env", "--plan", "--plan-sha", "--manifest",
    "--approval", "--approval-sha", "--confirm", "--out",
  ],
  "matcher-replay": ["--corpus", "--required-case-count", "--out"],
  execute: [
    "--url", "--auth-token-env", "--plan", "--plan-sha", "--manifest",
    "--approval", "--confirm", "--out",
  ],
  resume: [
    "--url", "--auth-token-env", "--plan", "--plan-sha", "--manifest",
    "--approval", "--confirm", "--out",
  ],
  status: ["--url", "--auth-token-env", "--run-id"],
  report: ["--url", "--auth-token-env", "--run-id"],
};

const COMMAND_BOOLEAN_FLAGS: Record<ProductTruthRunnerCommand, readonly string[]> = {
  doctor: ["--allow-remote", "--help"],
  plan: ["--allow-remote", "--help"],
  readiness: ["--allow-remote", "--help"],
  "backfill-plan": ["--allow-remote", "--help"],
  "backfill-apply": ["--allow-remote", "--help"],
  "matcher-replay": ["--help"],
  execute: ["--allow-remote", "--help"],
  resume: ["--allow-remote", "--help"],
  status: ["--allow-remote", "--help"],
  report: ["--allow-remote", "--help"],
};

function parseFlags(command: ProductTruthRunnerCommand, argv: readonly string[]): FlagMap {
  const values = new Set(COMMAND_VALUE_FLAGS[command]);
  const booleans = new Set(COMMAND_BOOLEAN_FLAGS[command]);
  const result: FlagMap = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      usageError("CLI_POSITIONAL_ARGUMENT_FORBIDDEN", `unexpected positional argument ${argument}`);
    }
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt < 0 ? argument : argument.slice(0, equalsAt);
    if (result.has(flag)) usageError("CLI_ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    if (booleans.has(flag)) {
      if (equalsAt >= 0) usageError("CLI_BOOLEAN_VALUE_FORBIDDEN", `${flag} does not accept a value`);
      result.set(flag, true);
      continue;
    }
    if (!values.has(flag)) usageError("CLI_ARGUMENT_UNKNOWN", `unknown ${command} argument ${flag}`);
    const value = equalsAt < 0 ? argv[index + 1] : argument.slice(equalsAt + 1);
    if (equalsAt < 0) index += 1;
    if (!value || (equalsAt < 0 && value.startsWith("--")) || value !== value.trim()) {
      usageError("CLI_ARGUMENT_VALUE_REQUIRED", `${flag} requires one exact value`);
    }
    result.set(flag, value);
  }
  return result;
}

function flagText(flags: FlagMap, flag: string): string | undefined {
  const value = flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

function exactPositiveIntegerFlag(
  value: string | undefined,
  flag: string,
  maximum: number,
): number {
  const text = exactValue(value, flag);
  if (!/^[1-9][0-9]*$/.test(text)) {
    usageError("CLI_ARGUMENT_VALUE_INVALID", `${flag} must be a positive base-10 integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    usageError("CLI_ARGUMENT_VALUE_INVALID", `${flag} must not exceed ${maximum}`);
  }
  return parsed;
}

function exactNonNegativeNumberFlag(value: string | undefined, flag: string): number {
  const text = exactValue(value, flag);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) {
    usageError("CLI_ARGUMENT_VALUE_INVALID", `${flag} must be a non-negative decimal number`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    usageError("CLI_ARGUMENT_VALUE_INVALID", `${flag} must be finite and non-negative`);
  }
  return parsed;
}

/** Strict parser: no ambient URL, implicit scope, or catch-all command exists. */
export function parseProductTruthRunnerArguments(
  argv: readonly string[],
): ProductTruthRunnerCliOptions {
  const commandRaw = argv[0];
  if (!commandRaw) usageError("CLI_COMMAND_REQUIRED", `command must be one of: ${COMMANDS.join(", ")}`);
  if (!(COMMANDS as readonly string[]).includes(commandRaw)) {
    usageError("CLI_COMMAND_UNKNOWN", `unknown command ${commandRaw}`);
  }
  const command = commandRaw as ProductTruthRunnerCommand;
  const flags = parseFlags(command, argv.slice(1));
  const help = flags.get("--help") === true;
  if (help && flags.size !== 1) {
    usageError("CLI_HELP_ARGUMENTS_FORBIDDEN", `${command} --help cannot be combined with execution flags`);
  }
  if (help) {
    return {
      command,
      databaseUrl: "help-only",
      allowRemote: false,
      help: true,
    } as ProductTruthRunnerCliOptions;
  }

  if (command === "matcher-replay") {
    return {
      command,
      corpusPath: exactValue(flagText(flags, "--corpus"), "--corpus"),
      requiredCaseCount: exactPositiveIntegerFlag(
        flagText(flags, "--required-case-count"),
        "--required-case-count",
        1_000_000,
      ),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
      help: false,
    };
  }

  const common = {
    databaseUrl: exactValue(flagText(flags, "--url"), "--url"),
    allowRemote: flags.get("--allow-remote") === true,
    authTokenEnv: flagText(flags, "--auth-token-env"),
    help: false,
  };
  if (command === "doctor") {
    const targetedValues = [
      flagText(flags, "--donor-product-id"),
      flagText(flags, "--query"),
      flagText(flags, "--run-id"),
      flagText(flags, "--expires-at"),
      flagText(flags, "--unwrangle-reserve-floor"),
      flagText(flags, "--out"),
    ];
    const targetedCount = targetedValues.filter((value) => value !== undefined).length;
    if (targetedCount === 0 && flagText(flags, "--canonical-identity")) {
      usageError(
        "CLI_TARGETED_DOCTOR_ARGUMENTS_INCOMPLETE",
        "--canonical-identity is valid only with the complete targeted doctor scope",
      );
    }
    if (targetedCount !== 0 && targetedCount !== targetedValues.length) {
      usageError(
        "CLI_TARGETED_DOCTOR_ARGUMENTS_INCOMPLETE",
        "targeted doctor requires --donor-product-id, --query, --run-id, --expires-at, --unwrangle-reserve-floor and --out together",
      );
    }
    return targetedCount === 0 ? { ...common, command } : {
      ...common,
      command,
      donorProductId: exactValue(targetedValues[0], "--donor-product-id"),
      query: exactValue(targetedValues[1], "--query"),
      runId: exactValue(targetedValues[2], "--run-id"),
      expiresAt: exactValue(targetedValues[3], "--expires-at"),
      unwrangleReserveFloor: exactNonNegativeNumberFlag(
        targetedValues[4],
        "--unwrangle-reserve-floor",
      ),
      outputDirectory: exactValue(targetedValues[5], "--out"),
      canonicalIdentityPath: flagText(flags, "--canonical-identity"),
    };
  }
  if (command === "plan") {
    return {
      ...common,
      command,
      requestPath: exactValue(flagText(flags, "--request"), "--request"),
      manifestPath: flagText(flags, "--manifest"),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
    };
  }
  if (command === "readiness") {
    return {
      ...common,
      command,
      manifestPath: exactValue(flagText(flags, "--manifest"), "--manifest"),
      asOf: exactValue(flagText(flags, "--as-of"), "--as-of"),
      maxPriceAgeMs: exactPositiveIntegerFlag(
        flagText(flags, "--max-price-age-ms"),
        "--max-price-age-ms",
        30 * 24 * 60 * 60 * 1_000,
      ),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
    };
  }
  if (command === "backfill-plan") {
    return {
      ...common,
      command,
      manifestPath: exactValue(flagText(flags, "--manifest"), "--manifest"),
      migrationCertificationPath: exactValue(
        flagText(flags, "--migration-certification"),
        "--migration-certification",
      ),
      migrationCertificationShaPath: exactValue(
        flagText(flags, "--migration-certification-sha"),
        "--migration-certification-sha",
      ),
      migrationReportPath: exactValue(
        flagText(flags, "--migration-report"),
        "--migration-report",
      ),
      migrationReportShaPath: exactValue(
        flagText(flags, "--migration-report-sha"),
        "--migration-report-sha",
      ),
      planId: exactValue(flagText(flags, "--plan-id"), "--plan-id"),
      expiresAt: exactValue(flagText(flags, "--expires-at"), "--expires-at"),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
    };
  }
  if (command === "backfill-apply") {
    return {
      ...common,
      command,
      planPath: exactValue(flagText(flags, "--plan"), "--plan"),
      planShaPath: exactValue(flagText(flags, "--plan-sha"), "--plan-sha"),
      manifestPath: exactValue(flagText(flags, "--manifest"), "--manifest"),
      approvalPath: exactValue(flagText(flags, "--approval"), "--approval"),
      approvalShaPath: exactValue(flagText(flags, "--approval-sha"), "--approval-sha"),
      executionConfirmation: exactValue(flagText(flags, "--confirm"), "--confirm"),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
    };
  }
  if (command === "execute" || command === "resume") {
    return {
      ...common,
      command,
      planPath: exactValue(flagText(flags, "--plan"), "--plan"),
      planShaPath: exactValue(flagText(flags, "--plan-sha"), "--plan-sha"),
      manifestPath: flagText(flags, "--manifest"),
      approvalPath: exactValue(flagText(flags, "--approval"), "--approval"),
      executionConfirmation: exactValue(flagText(flags, "--confirm"), "--confirm"),
      outputDirectory: exactValue(flagText(flags, "--out"), "--out"),
    };
  }
  return {
    ...common,
    command,
    runId: exactValue(flagText(flags, "--run-id"), "--run-id"),
  };
}

export function productTruthRunnerUsage(command?: ProductTruthRunnerCommand): string {
  const lines = [
    "Product Truth operational runner (explicit scope, default deny)",
    "",
    "Commands:",
    "  doctor --url URL [--allow-remote --auth-token-env NAME]",
    "  doctor --donor-product-id ID --query QUERY --run-id RUN_ID --expires-at ISO_TIMESTAMP",
    "       --unwrangle-reserve-floor UNITS --url URL --out NEW_DIR",
    "       [--canonical-identity OWNER_IDENTITY.json] [--allow-remote --auth-token-env NAME]",
    "       # exact donor writes a request; legacy donor first writes an owner-review template",
    "  plan --request REQUEST.json --manifest MANIFEST.json --url URL --out NEW_DIR",
    "       [--allow-remote]  # canonical listing lane",
    "  plan --request TARGETED_REQUEST.json --url URL --out NEW_DIR",
    "       [--allow-remote --auth-token-env NAME]  # exact one-donor read-only lane",
    "  readiness --manifest MANIFEST.json --as-of ISO_TIMESTAMP",
    "       --max-price-age-ms INTEGER --url URL --out NEW_DIR",
    "       [--allow-remote --auth-token-env NAME]",
    "  backfill-plan --manifest MANIFEST.json --migration-certification CERT.json",
    "       --migration-certification-sha CERT.sha256 --migration-report REPORT.json",
    "       --migration-report-sha REPORT.sha256",
    "       --plan-id PLAN_ID --expires-at ISO_TIMESTAMP --url URL --out NEW_DIR",
    "       [--allow-remote --auth-token-env NAME]",
    "  backfill-apply --plan plan.json --plan-sha plan.sha256 --manifest MANIFEST.json",
    "       --approval APPROVAL.json --approval-sha APPROVAL.sha256",
    "       --confirm EXACT_TOKEN --url URL --out NEW_DIR",
    "       [--allow-remote --auth-token-env NAME]",
    "  matcher-replay --corpus CORPUS.json --required-case-count INTEGER",
    "       --out NEW_DIR",
    "  execute --plan plan.json --plan-sha plan.sha256 --manifest MANIFEST.json",
    "       --approval APPROVAL.json --confirm EXACT_TOKEN --url URL --out NEW_DIR",
    "       [--allow-remote --auth-token-env NAME]",
    "  execute --plan targeted-plan.json --plan-sha plan.sha256 --approval APPROVAL.json",
    "       --confirm EXACT_TOKEN --url URL --out NEW_DIR [--allow-remote --auth-token-env NAME]",
    "  resume  (same exact required artifacts and flags as execute)",
    "  status --run-id RUN_ID --url URL [--allow-remote --auth-token-env NAME]",
    "  report --run-id RUN_ID --url URL [--allow-remote --auth-token-env NAME]",
    "",
    "Rules:",
    "  Database-bound commands require explicit --url; ambient database URLs are never inferred.",
    "  Remote targets require --allow-remote; connected commands also require",
    "  --auth-token-env NAME. The token value is never printed.",
    "  listing-scope plan is offline; targeted one-donor plan reconnects read-only to revalidate exact sealed state. Neither calls a provider.",
    "  readiness is read-only, covers the full manifest, and grants no activation.",
    "  backfill-plan is a connected read-only snapshot; backfill-apply may only",
    "  import sealed authoritative listing scopes and never recomputes canonical cost.",
    "  matcher-replay is strictly offline: --url, database, approval, and provider flags",
    "  are forbidden; the corpus must be exact canonical JSON.",
    "  Every --out path must be a new directory; artifacts are never overwritten.",
  ];
  return command ? `${lines.join("\n")}\n\nSelected command: ${command}` : lines.join("\n");
}

interface ResolvedCliDatabaseTarget {
  target: DatabaseTarget;
  authToken?: string;
}

function resolveCliDatabaseTarget(input: {
  databaseUrl: string;
  allowRemote: boolean;
  authTokenEnv?: string;
  connect: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ResolvedCliDatabaseTarget {
  let target: DatabaseTarget;
  try {
    target = resolveDatabaseTarget(input.databaseUrl, input.cwd);
  } catch (error) {
    fail("DATABASE_TARGET_INVALID", "explicit database target is invalid", { cause: error });
  }
  if (target.kind === "remote") {
    const parsed = new URL(target.clientUrl);
    if (parsed.search) {
      usageError(
        "DATABASE_URL_QUERY_FORBIDDEN",
        "remote database URL query parameters are forbidden; supply auth only via --auth-token-env",
      );
    }
    if (!input.allowRemote) {
      usageError("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG", "remote target requires --allow-remote");
    }
    if (!input.connect) {
      if (input.authTokenEnv) {
        usageError("PLAN_AUTH_TOKEN_FORBIDDEN", "offline plan does not accept --auth-token-env");
      }
      return { target };
    }
    const name = input.authTokenEnv;
    if (!name || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
      usageError(
        "REMOTE_DATABASE_AUTH_ENV_REQUIRED",
        "remote connection requires --auth-token-env with an uppercase environment variable name",
      );
    }
    const authToken = input.env[name]?.trim();
    if (!authToken) {
      fail("REMOTE_DATABASE_AUTH_TOKEN_MISSING", `environment variable ${name} is empty or absent`);
    }
    return { target, authToken };
  }
  if (input.authTokenEnv) {
    usageError("LOCAL_DATABASE_AUTH_FORBIDDEN", "local file target does not accept --auth-token-env");
  }
  return { target };
}

async function readExactRegularUtf8File(
  inputPath: string,
  label: string,
  cwd: string,
  maximumBytes: number,
): Promise<{ absolutePath: string; text: string }> {
  const absolutePath = resolve(cwd, inputPath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    fail("ARTIFACT_FILE_MISSING", `${label} does not exist`, { cause: error });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail("ARTIFACT_FILE_INVALID", `${label} must be a regular non-symlink file`);
  }
  if (stats.size < 1 || stats.size > maximumBytes) {
    fail("ARTIFACT_FILE_SIZE_INVALID", `${label} must be 1-${maximumBytes} bytes`);
  }
  const bytes = await readFile(absolutePath);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail("ARTIFACT_UTF8_INVALID", `${label} is not canonical UTF-8 text`);
  }
  return { absolutePath, text };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail("ARTIFACT_JSON_INVALID", `${label} is not valid JSON`, { cause: error });
  }
}

function assertCanonicalJson(text: string, value: unknown, label: string): void {
  if (text !== renderProductTruthOperationalJson(value)) {
    fail("ARTIFACT_NOT_CANONICAL", `${label} bytes are not canonical Product Truth JSON`);
  }
}

async function readCanonicalManifest(
  manifestPath: string,
  cwd: string,
): Promise<{ manifest: Phase1ScopeManifest; manifestJson: string; manifestSha256: string }> {
  const file = await readExactRegularUtf8File(
    manifestPath,
    "manifest",
    cwd,
    MANIFEST_LIMIT_BYTES,
  );
  const manifest = parseJson(file.text, "manifest") as Phase1ScopeManifest;
  let canonical: string;
  try {
    canonical = renderPhase1ScopeManifestJson(manifest);
  } catch (error) {
    fail("MANIFEST_INVALID", "manifest cannot be rendered canonically", { cause: error });
  }
  if (file.text !== canonical) {
    fail("MANIFEST_NOT_CANONICAL", "manifest bytes must equal canonical manifest JSON");
  }
  return { manifest, manifestJson: file.text, manifestSha256: sha256(file.text) };
}

function parseSha256File(text: string): string {
  if (!/^[a-f0-9]{64}\n?$/.test(text)) {
    fail("PLAN_SHA_FILE_INVALID", "plan SHA file must contain one lowercase SHA-256 and optional newline");
  }
  const digest = text.trim();
  if (!SHA256_PATTERN.test(digest)) fail("PLAN_SHA_FILE_INVALID", "plan SHA-256 is malformed");
  return digest;
}

type ProductTruthMigrationQueueImpact = NonNullable<ProductTruthMigrationPlan["queueImpact"]>;
type ProductTruthMigrationWriterActivity = NonNullable<ProductTruthMigrationPlan["writerActivity"]>;

interface ProductTruthMigrationApplyReport {
  contractVersion: "product-truth-migration-report/2";
  mode: "apply";
  generatedAt: string;
  migrationSetSha256: string;
  activationContractSha256: string;
  targetFingerprint: string;
  runId: string;
  approvalId: string;
  planSha256: string;
  approvalSha256: string;
  schemaBeforeSha256: string;
  schemaAfterSha256: string;
  queueImpact: ProductTruthMigrationQueueImpact;
  writerActivityAtPlan: ProductTruthMigrationWriterActivity;
  actions: Array<{
    id: string;
    action: "applied" | "already_applied";
    sha256: string;
  }>;
  final: {
    receiptLedger: "ready";
    prismaLedger: "ready";
    migrationStates: Array<{
      id: string;
      state: "applied";
      tracking: "tracked";
    }>;
  };
}

interface LoadedProductTruthMigrationBridge {
  certification: ProductTruthMigrationCertification;
  certificationJson: string;
  certificationSha256: string;
  report: ProductTruthMigrationApplyReport;
  reportJson: string;
  reportSha256: string;
}

interface VerifiedProductTruthMigrationBridge extends LoadedProductTruthMigrationBridge {
  canonicalMigrationSetSha256: string;
  liveSchemaFingerprintSha256: string;
  liveReceiptLedger: "ready";
  livePrismaLedger: "ready";
}

function exactArtifactSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `${label} must be an exact lowercase SHA-256`);
  }
}

function exactArtifactInstant(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `${label} must be a canonical UTC ISO instant`);
  }
}

function exactArtifactIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `${label} is not an exact owner identifier`);
  }
}

function assertMigrationImpactRows(value: unknown, label: string): void {
  if (!isRecord(value)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `${label} must be an object`);
  }
  exactKeys(value, ["count", "rowIds", "rowsSha256"], label);
  const count = value.count;
  const rowIds = value.rowIds;
  if (
    typeof count !== "number"
    || !Number.isSafeInteger(count)
    || count < 0
    || !Array.isArray(rowIds)
    || rowIds.some((id) => typeof id !== "string" || !id)
    || rowIds.length !== count
    || new Set(rowIds).size !== rowIds.length
    || rowIds.some((id, index) =>
      index > 0 && String(rowIds[index - 1]).localeCompare(String(id), "en-US") >= 0)
  ) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `${label} must contain sorted unique exact rows`);
  }
  exactArtifactSha256(value.rowsSha256, `${label}.rowsSha256`);
}

function assertMigrationQueueImpact(
  value: unknown,
): asserts value is ProductTruthMigrationQueueImpact {
  if (!isRecord(value)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report queueImpact must be an object");
  }
  exactKeys(value, [
    "contractVersion", "queueV2CompatibilityBackfill", "queueV3Cancellation",
    "runningQueueJobs", "sha256",
  ], "migration report queueImpact");
  if (value.contractVersion !== "product-truth-migration-queue-impact/1") {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report queueImpact version is invalid");
  }
  assertMigrationImpactRows(
    value.queueV2CompatibilityBackfill,
    "migration report queueImpact.queueV2CompatibilityBackfill",
  );
  assertMigrationImpactRows(
    value.queueV3Cancellation,
    "migration report queueImpact.queueV3Cancellation",
  );
  assertMigrationImpactRows(
    value.runningQueueJobs,
    "migration report queueImpact.runningQueueJobs",
  );
  exactArtifactSha256(value.sha256, "migration report queueImpact.sha256");
}

function assertMigrationWriterActivity(
  value: unknown,
): asserts value is ProductTruthMigrationWriterActivity {
  if (!isRecord(value)) {
    fail(
      "MIGRATION_BRIDGE_ARTIFACT_INVALID",
      "migration report writerActivityAtPlan must be an object",
    );
  }
  exactKeys(value, [
    "contractVersion", "enrichmentRunning", "harvestRunning", "operationalRunning",
    "unsettledMeteredReceipts", "unfinishedPrismaMigrations", "blockerSets",
    "externalWriterQuiescenceRequired", "sha256",
  ], "migration report writerActivityAtPlan");
  if (value.contractVersion !== "product-truth-migration-writer-activity/1") {
    fail(
      "MIGRATION_BRIDGE_ARTIFACT_INVALID",
      "migration report writerActivityAtPlan version is invalid",
    );
  }
  if (!isRecord(value.blockerSets)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "writerActivityAtPlan.blockerSets is invalid");
  }
  const blockerSetNames = [
    "enrichmentRunning", "harvestRunning", "operationalRunning",
    "unsettledMeteredReceipts", "unfinishedPrismaMigrations",
  ] as const;
  exactKeys(value.blockerSets, blockerSetNames, "migration report writerActivityAtPlan.blockerSets");
  for (const name of blockerSetNames) {
    assertMigrationImpactRows(
      value.blockerSets[name],
      `migration report writerActivityAtPlan.blockerSets.${name}`,
    );
    if (
      !Number.isSafeInteger(value[name])
      || Number(value[name]) < 0
      || value[name] !== (value.blockerSets[name] as Record<string, unknown>).count
    ) {
      fail(
        "MIGRATION_BRIDGE_ARTIFACT_INVALID",
        `migration report writerActivityAtPlan.${name} differs from its blocker set`,
      );
    }
  }
  if (value.externalWriterQuiescenceRequired !== true) {
    fail(
      "MIGRATION_BRIDGE_ARTIFACT_INVALID",
      "migration report must require external writer quiescence",
    );
  }
  exactArtifactSha256(value.sha256, "migration report writerActivityAtPlan.sha256");
}

function assertMigrationReportArtifactShape(
  value: unknown,
): asserts value is ProductTruthMigrationApplyReport {
  if (!isRecord(value)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report must be an object");
  }
  exactKeys(value, [
    "contractVersion", "mode", "generatedAt", "migrationSetSha256",
    "activationContractSha256", "targetFingerprint", "runId", "approvalId",
    "planSha256", "approvalSha256", "schemaBeforeSha256", "schemaAfterSha256",
    "queueImpact", "writerActivityAtPlan", "actions", "final",
  ], "migration report");
  if (value.contractVersion !== "product-truth-migration-report/2" || value.mode !== "apply") {
    fail(
      "MIGRATION_BRIDGE_ARTIFACT_INVALID",
      "migration report must be a product-truth-migration-report/2 apply artifact",
    );
  }
  exactArtifactInstant(value.generatedAt, "migration report generatedAt");
  for (const name of [
    "migrationSetSha256", "activationContractSha256", "targetFingerprint",
    "planSha256", "approvalSha256", "schemaBeforeSha256", "schemaAfterSha256",
  ] as const) exactArtifactSha256(value[name], `migration report ${name}`);
  exactArtifactIdentifier(value.runId, "migration report runId");
  exactArtifactIdentifier(value.approvalId, "migration report approvalId");
  assertMigrationQueueImpact(value.queueImpact);
  assertMigrationWriterActivity(value.writerActivityAtPlan);
  if (!Array.isArray(value.actions)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report actions must be an array");
  }
  value.actions.forEach((action, index) => {
    if (!isRecord(action)) {
      fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `migration report actions[${index}] is invalid`);
    }
    exactKeys(action, ["id", "action", "sha256"], `migration report actions[${index}]`);
    exactArtifactIdentifier(action.id, `migration report actions[${index}].id`);
    if (action.action !== "applied" && action.action !== "already_applied") {
      fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `migration report actions[${index}] is invalid`);
    }
    exactArtifactSha256(action.sha256, `migration report actions[${index}].sha256`);
  });
  if (!isRecord(value.final)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report final must be an object");
  }
  exactKeys(
    value.final,
    ["receiptLedger", "prismaLedger", "migrationStates"],
    "migration report final",
  );
  if (value.final.receiptLedger !== "ready" || value.final.prismaLedger !== "ready") {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report final dual ledgers are not ready");
  }
  if (!Array.isArray(value.final.migrationStates)) {
    fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", "migration report final migrationStates is invalid");
  }
  value.final.migrationStates.forEach((state, index) => {
    if (!isRecord(state)) {
      fail("MIGRATION_BRIDGE_ARTIFACT_INVALID", `migration report final state ${index} is invalid`);
    }
    exactKeys(state, ["id", "state", "tracking"], `migration report final state ${index}`);
    exactArtifactIdentifier(state.id, `migration report final state ${index}.id`);
    if (state.state !== "applied" || state.tracking !== "tracked") {
      fail(
        "MIGRATION_BRIDGE_ARTIFACT_INVALID",
        `migration report final state ${index} is not applied and tracked`,
      );
    }
  });
}

function parseMigrationSha256Sidecar(text: string, label: string): string {
  if (!/^[a-f0-9]{64}\n$/.test(text)) {
    fail(
      "MIGRATION_BRIDGE_SHA_SIDECAR_INVALID",
      `${label} must contain exactly one lowercase SHA-256 followed by a newline`,
    );
  }
  return text.slice(0, 64);
}

async function readCanonicalMigrationBridge(input: {
  certificationPath: string;
  certificationShaPath: string;
  reportPath: string;
  reportShaPath: string;
  cwd: string;
}): Promise<LoadedProductTruthMigrationBridge> {
  const [certificationFile, certificationShaFile, reportFile, reportShaFile] = await Promise.all([
    readExactRegularUtf8File(
      input.certificationPath,
      "migration certification",
      input.cwd,
      JSON_LIMIT_BYTES,
    ),
    readExactRegularUtf8File(
      input.certificationShaPath,
      "migration certification SHA",
      input.cwd,
      1024,
    ),
    readExactRegularUtf8File(input.reportPath, "migration report", input.cwd, JSON_LIMIT_BYTES),
    readExactRegularUtf8File(input.reportShaPath, "migration report SHA", input.cwd, 1024),
  ]);
  const certificationValue = parseJson(
    certificationFile.text,
    "migration certification",
  );
  const reportValue = parseJson(reportFile.text, "migration report");
  if (
    certificationFile.text !== canonicalProductTruthMigrationArtifact(certificationValue)
    || reportFile.text !== canonicalProductTruthMigrationArtifact(reportValue)
  ) {
    fail(
      "MIGRATION_BRIDGE_ARTIFACT_NOT_CANONICAL",
      "certification and report bytes must exactly equal canonical migration artifacts",
    );
  }
  assertMigrationCertificationArtifactShape(certificationValue);
  assertMigrationReportArtifactShape(reportValue);
  const certificationSha256 = parseMigrationSha256Sidecar(
    certificationShaFile.text,
    "migration certification SHA sidecar",
  );
  const reportSha256 = parseMigrationSha256Sidecar(
    reportShaFile.text,
    "migration report SHA sidecar",
  );
  if (certificationSha256 !== sha256(certificationFile.text)) {
    fail(
      "MIGRATION_CERTIFICATION_HASH_MISMATCH",
      "migration certification bytes do not match the required SHA sidecar",
    );
  }
  if (reportSha256 !== sha256(reportFile.text)) {
    fail(
      "MIGRATION_REPORT_HASH_MISMATCH",
      "migration report bytes do not match the required SHA sidecar",
    );
  }
  return {
    certification: certificationValue,
    certificationJson: certificationFile.text,
    certificationSha256,
    report: reportValue,
    reportJson: reportFile.text,
    reportSha256,
  };
}

async function verifyCanonicalMigrationBridge(input: {
  bridge: LoadedProductTruthMigrationBridge;
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<VerifiedProductTruthMigrationBridge> {
  const { bridge } = input;
  const certification = bridge.certification;
  const report = bridge.report;
  if (certification.contractVersion !== PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION) {
    fail(
      "MIGRATION_CERTIFICATION_CONTRACT_INVALID",
      `migration certification must use ${PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION}`,
    );
  }
  for (const [label, value] of [
    ["certification migrationSetSha256", certification.migrationSetSha256],
    ["certification migrationReportSha256", certification.migrationReportSha256],
    ["certification schemaFingerprintSha256", certification.schemaFingerprintSha256],
    ["certification databaseTargetFingerprint", certification.databaseTargetFingerprint],
  ] as const) exactArtifactSha256(value, label);
  if (
    certification.allMigrationsApplied !== true
    || certification.allReceiptsTracked !== true
    || certification.receiptLedgerReady !== true
  ) {
    fail(
      "MIGRATION_CERTIFICATION_NOT_READY",
      "migration certification does not assert applied migrations and ready exact receipts",
    );
  }
  if (certification.migrationReportSha256 !== bridge.reportSha256) {
    fail(
      "MIGRATION_CERTIFICATION_REPORT_MISMATCH",
      "migration certification does not bind the supplied canonical migration report",
    );
  }
  if (
    certification.databaseTargetFingerprint !== input.resolved.target.fingerprint
    || report.targetFingerprint !== input.resolved.target.fingerprint
  ) {
    fail(
      "MIGRATION_BRIDGE_TARGET_MISMATCH",
      "migration certification or report belongs to a different exact database target",
    );
  }

  const [canonicalFiles, livePlan] = await Promise.all([
    loadProductTruthMigrationFiles(),
    planProductTruthMigrations({
      databaseUrl: input.resolved.target.clientUrl,
      ...(input.resolved.authToken ? { authToken: input.resolved.authToken } : {}),
      allowRemote: input.resolved.target.kind === "remote",
      runId: report.runId,
      approvalId: report.approvalId,
      cwd: input.cwd,
      now: () => new Date(input.now),
    }),
  ]);
  const canonicalMigrationSetSha256 = migrationSetSha256(canonicalFiles);
  if (
    certification.migrationSetSha256 !== canonicalMigrationSetSha256
    || report.migrationSetSha256 !== canonicalMigrationSetSha256
    || livePlan.migrationSetSha256 !== canonicalMigrationSetSha256
  ) {
    fail(
      "MIGRATION_BRIDGE_RELEASE_MISMATCH",
      "certification, report, live ledgers, and canonical migration files do not share one release hash",
    );
  }
  if (
    livePlan.database?.targetFingerprint !== input.resolved.target.fingerprint
    || report.activationContractSha256 !== livePlan.activationContractSha256
  ) {
    fail(
      "MIGRATION_BRIDGE_RELEASE_MISMATCH",
      "migration report differs from the live target or current activation contract",
    );
  }
  if (
    livePlan.canApply !== true
    || livePlan.blockers.length !== 0
    || livePlan.receiptLedger !== "ready"
    || livePlan.prismaLedger !== "ready"
    || livePlan.migrations.some((migration) =>
      migration.state !== "applied" || migration.tracking !== "tracked")
  ) {
    fail(
      "MIGRATION_BRIDGE_LIVE_LEDGER_INVALID",
      livePlan.blockers.join("; ")
        || "live Product Truth and Prisma migration ledgers are not both exact and ready",
    );
  }
  const liveSchemaFingerprintSha256 = livePlan.schema?.sha256;
  if (
    !liveSchemaFingerprintSha256
    || certification.schemaFingerprintSha256 !== liveSchemaFingerprintSha256
    || report.schemaAfterSha256 !== liveSchemaFingerprintSha256
  ) {
    fail(
      "MIGRATION_BRIDGE_SCHEMA_FINGERPRINT_MISMATCH",
      "certification and report do not match the exact live schema fingerprint",
    );
  }

  if (
    report.actions.length !== canonicalFiles.length
    || report.actions.some((action, index) =>
      action.id !== canonicalFiles[index]?.id || action.sha256 !== canonicalFiles[index]?.sha256)
  ) {
    fail(
      "MIGRATION_REPORT_ACTIONS_MISMATCH",
      "migration report actions do not exactly match the ordered canonical migration files",
    );
  }
  const liveStates = livePlan.migrations.map((migration) => ({
    id: migration.id,
    state: migration.state,
    tracking: migration.tracking,
  }));
  if (JSON.stringify(report.final.migrationStates) !== JSON.stringify(liveStates)) {
    fail(
      "MIGRATION_REPORT_LIVE_STATE_MISMATCH",
      "migration report final states differ from the exact live dual-ledger state",
    );
  }
  return {
    ...bridge,
    canonicalMigrationSetSha256,
    liveSchemaFingerprintSha256,
    liveReceiptLedger: "ready",
    livePrismaLedger: "ready",
  };
}

async function assertDurableMigrationActivationReceipt(
  db: Client,
  bridge: VerifiedProductTruthMigrationBridge,
): Promise<void> {
  let result;
  try {
    result = await db.execute({
      sql: `SELECT
              planSha256, approvalSha256, migrationSetSha256,
              activationContractSha256, targetFingerprint, reportSha256,
              reportJson, completedAt
            FROM ProductTruthMigrationActivationReceipt
            WHERE planSha256=?`,
      args: [bridge.report.planSha256],
    });
  } catch (error) {
    fail(
      "MIGRATION_ACTIVATION_RECEIPT_UNREADABLE",
      "durable migration activation receipt could not be read",
      { cause: error },
    );
  }
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || String(row?.planSha256 ?? "") !== bridge.report.planSha256
    || String(row?.approvalSha256 ?? "") !== bridge.report.approvalSha256
    || String(row?.migrationSetSha256 ?? "") !== bridge.canonicalMigrationSetSha256
    || String(row?.activationContractSha256 ?? "")
      !== bridge.report.activationContractSha256
    || String(row?.targetFingerprint ?? "") !== bridge.report.targetFingerprint
    || String(row?.reportSha256 ?? "") !== bridge.reportSha256
    || String(row?.reportJson ?? "") !== bridge.reportJson
    || String(row?.completedAt ?? "") !== bridge.report.generatedAt
  ) {
    fail(
      "MIGRATION_ACTIVATION_RECEIPT_MISMATCH",
      "supplied migration report does not exactly match its immutable live activation receipt",
    );
  }
}

interface LoadedProductTruthBackfillApplyArtifacts {
  plan: ProductTruthOwnerBackfillPlan;
  planSha256: string;
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
  approval: ProductTruthOwnerBackfillApproval;
  approvalSha256: string;
}

async function loadProductTruthBackfillApplyArtifacts(input: {
  planPath: string;
  planShaPath: string;
  manifestPath: string;
  approvalPath: string;
  approvalShaPath: string;
  targetFingerprint: string;
  cwd: string;
}): Promise<LoadedProductTruthBackfillApplyArtifacts> {
  const [planFile, planShaFile, manifestFile, approvalFile, approvalShaFile] = await Promise.all([
    readExactRegularUtf8File(input.planPath, "backfill plan", input.cwd, BACKFILL_PLAN_LIMIT_BYTES),
    readExactRegularUtf8File(input.planShaPath, "backfill plan SHA", input.cwd, 1024),
    readCanonicalManifest(input.manifestPath, input.cwd),
    readExactRegularUtf8File(input.approvalPath, "backfill approval", input.cwd, JSON_LIMIT_BYTES),
    readExactRegularUtf8File(input.approvalShaPath, "backfill approval SHA", input.cwd, 1024),
  ]);
  const planValue = parseJson(planFile.text, "backfill plan");
  assertCanonicalJson(planFile.text, planValue, "backfill plan");
  assertBackfillPlanArtifactShape(planValue);
  const planSha256 = parseSha256File(planShaFile.text);
  const { planSha256: embeddedPlanSha256, ...planBody } = planValue;
  const computedPlanSha256 = productTruthOperationalSha256(planBody);
  if (
    planSha256 !== computedPlanSha256
    || embeddedPlanSha256 !== computedPlanSha256
  ) {
    fail("BACKFILL_PLAN_HASH_MISMATCH", "backfill plan, embedded SHA, and SHA artifact differ");
  }
  if (planValue.databaseTargetFingerprint !== input.targetFingerprint) {
    fail(
      "DATABASE_TARGET_FINGERPRINT_MISMATCH",
      "explicit database target differs from sealed backfill plan",
    );
  }
  const approvalValue = parseJson(approvalFile.text, "backfill approval");
  assertCanonicalJson(approvalFile.text, approvalValue, "backfill approval");
  assertBackfillApprovalArtifactShape(approvalValue);
  const approvalSha256 = parseSha256File(approvalShaFile.text);
  if (
    approvalSha256 !== sha256(approvalFile.text)
    || approvalSha256 !== productTruthOperationalSha256(approvalValue)
  ) {
    fail("BACKFILL_APPROVAL_HASH_MISMATCH", "backfill approval bytes and SHA artifact differ");
  }
  return {
    plan: planValue,
    planSha256,
    manifest: manifestFile.manifest,
    manifestJson: manifestFile.manifestJson,
    manifestSha256: manifestFile.manifestSha256,
    approval: approvalValue,
    approvalSha256,
  };
}

function assertApprovalArtifactShape(
  value: unknown,
  plan: ProductTruthOperationalPlan,
): asserts value is ProductTruthOperationalApproval {
  if (!isRecord(value)) fail("APPROVAL_ARTIFACT_INVALID", "approval must be an object");
  exactKeys(value, [
    "schemaVersion", "approvedBy", "runId", "approvalId", "action", "planSha256",
    "targetFingerprint", "issuedAt", "expiresAt", "meteredPermit", "balanceEvidence",
  ], "approval");
  if (value.schemaVersion !== PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION) {
    fail("APPROVAL_ARTIFACT_INVALID", `approval must use ${PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION}`);
  }
  if (!isRecord(value.meteredPermit)) {
    fail("APPROVAL_ARTIFACT_INVALID", "approval.meteredPermit must be an object");
  }
  exactKeys(value.meteredPermit, [
    "version", "runId", "approvalId", "approvedBy", "issuedAt", "expiresAt", "providers",
  ], "approval.meteredPermit");
  if (!isRecord(value.meteredPermit.providers)) {
    fail("APPROVAL_ARTIFACT_INVALID", "approval.meteredPermit.providers must be an object");
  }
  const providerNames = Object.keys(value.meteredPermit.providers).sort();
  const expectedProviders = plan.providerCeilings.map((ceiling) => ceiling.provider).sort();
  if (
    providerNames.length !== expectedProviders.length
    || providerNames.some((provider, index) => provider !== expectedProviders[index])
  ) {
    fail("APPROVAL_ARTIFACT_INVALID", "approval provider set differs from the sealed plan");
  }
  for (const ceiling of plan.providerCeilings) {
    const allowance = value.meteredPermit.providers[ceiling.provider];
    if (!isRecord(allowance)) {
      fail("APPROVAL_ARTIFACT_INVALID", `${ceiling.provider} allowance must be an object`);
    }
    exactKeys(
      allowance,
      ceiling.maxUnits === null
        ? ["operations", "maxCalls"]
        : ["operations", "maxCalls", "maxUnits"],
      `approval.meteredPermit.providers.${ceiling.provider}`,
    );
  }
  if (!Array.isArray(value.balanceEvidence)) {
    fail("APPROVAL_ARTIFACT_INVALID", "approval.balanceEvidence must be an array");
  }
  value.balanceEvidence.forEach((evidence, index) => {
    if (!isRecord(evidence)) {
      fail("APPROVAL_ARTIFACT_INVALID", `approval.balanceEvidence[${index}] must be an object`);
    }
    exactKeys(
      evidence,
      ["provider", "observedAt", "balanceUnits", "reserveFloor", "evidenceSha256"],
      `approval.balanceEvidence[${index}]`,
    );
  });
}

function assertMigrationCertificationArtifactShape(
  value: unknown,
): asserts value is ProductTruthMigrationCertification {
  if (!isRecord(value)) {
    fail("BACKFILL_CERTIFICATION_INVALID", "migration certification must be an object");
  }
  exactKeys(value, [
    "contractVersion", "migrationSetSha256", "migrationReportSha256",
    "schemaFingerprintSha256", "databaseTargetFingerprint", "allMigrationsApplied",
    "allReceiptsTracked", "receiptLedgerReady",
  ], "migration certification");
}

function assertRecordArrayShape(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): void {
  if (!Array.isArray(value)) fail("BACKFILL_ARTIFACT_INVALID", `${label} must be an array`);
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      fail("BACKFILL_ARTIFACT_INVALID", `${label}[${index}] must be an object`);
    }
    exactKeys(entry, expectedKeys, `${label}[${index}]`);
  });
}

function assertBackfillPlanArtifactShape(
  value: unknown,
): asserts value is ProductTruthOwnerBackfillPlan {
  if (!isRecord(value)) fail("BACKFILL_PLAN_ARTIFACT_INVALID", "backfill plan must be an object");
  exactKeys(value, [
    "schemaVersion", "planId", "createdAt", "expiresAt", "databaseTargetFingerprint",
    "manifest", "migrationCertification", "readinessPlanSha256", "preconditions",
    "operations", "rollbackPolicy", "claims", "planSha256",
  ], "backfill plan");
  if (value.schemaVersion !== PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION) {
    fail(
      "BACKFILL_PLAN_ARTIFACT_INVALID",
      `backfill plan must use ${PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION}`,
    );
  }
  if (!isRecord(value.manifest)) fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.manifest must be an object");
  exactKeys(value.manifest, ["schemaVersion", "sha256", "asOf", "listingCount"], "plan.manifest");
  assertMigrationCertificationArtifactShape(value.migrationCertification);
  if (!isRecord(value.preconditions)) {
    fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.preconditions must be an object");
  }
  exactKeys(value.preconditions, ["stateSha256", "state", "writersQuiescent"], "plan.preconditions");
  if (!isRecord(value.preconditions.state)) {
    fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.preconditions.state must be an object");
  }
  exactKeys(
    value.preconditions.state,
    ["writerActivity", "manifestScopeRows", "canonicalOutcomes", "foreignKeyViolations"],
    "plan.preconditions.state",
  );
  assertRecordArrayShape(
    value.preconditions.state.writerActivity,
    ["source", "id", "status", "updatedAt"],
    "plan.preconditions.state.writerActivity",
  );
  assertRecordArrayShape(
    value.preconditions.state.manifestScopeRows,
    [
      "listingKey", "keyVersion", "channel", "storeIndex", "sku", "registrationKind",
      "manifestSchemaVersion", "manifestSha256", "manifestAsOf", "ownerDecisionId",
      "sourceReportId", "sourceContentSha256", "sourceCapturedAt", "createdAt",
    ],
    "plan.preconditions.state.manifestScopeRows",
  );
  assertRecordArrayShape(
    value.preconditions.state.canonicalOutcomes,
    [
      "listingKey", "skuCostId", "evidenceOutcome", "observationKey", "recipeHash",
      "effectiveDate", "createdAt",
    ],
    "plan.preconditions.state.canonicalOutcomes",
  );
  if (
    !Array.isArray(value.preconditions.state.foreignKeyViolations)
    || value.preconditions.state.foreignKeyViolations.some((entry) => typeof entry !== "string")
  ) {
    fail("BACKFILL_PLAN_ARTIFACT_INVALID", "foreignKeyViolations must be a string array");
  }
  if (!isRecord(value.operations)) {
    fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.operations must be an object");
  }
  exactKeys(
    value.operations,
    ["scopeImports", "canonicalCostRecomputes", "reviewTasks"],
    "plan.operations",
  );
  assertRecordArrayShape(
    value.operations.scopeImports,
    ["operation", "ordinal", "row"],
    "plan.operations.scopeImports",
  );
  for (const [index, operation] of (value.operations.scopeImports as unknown[]).entries()) {
    const record = operation as Record<string, unknown>;
    if (!isRecord(record.row)) {
      fail("BACKFILL_PLAN_ARTIFACT_INVALID", `scopeImports[${index}].row must be an object`);
    }
    exactKeys(record.row, [
      "listingKey", "keyVersion", "channel", "storeIndex", "sku", "registrationKind",
      "manifestSchemaVersion", "manifestSha256", "manifestAsOf", "ownerDecisionId",
      "sourceReportId", "sourceContentSha256", "sourceCapturedAt", "createdAt",
    ], `plan.operations.scopeImports[${index}].row`);
  }
  if (!Array.isArray(value.operations.canonicalCostRecomputes)
      || value.operations.canonicalCostRecomputes.length !== 0) {
    fail("BACKFILL_PLAN_ARTIFACT_UNSAFE", "canonicalCostRecomputes must be an empty array");
  }
  assertRecordArrayShape(
    value.operations.reviewTasks,
    [
      "taskId", "taskType", "listingKey", "channel", "storeIndex", "sku", "reason",
      "requiredDisposition", "execution", "automaticExecution", "providerCallsPermitted",
      "legacyInferencePermitted",
    ],
    "plan.operations.reviewTasks",
  );
  if (!isRecord(value.rollbackPolicy)) {
    fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.rollbackPolicy must be an object");
  }
  exactKeys(
    value.rollbackPolicy,
    ["transactionMode", "rollbackBeforeCommit", "postCommitDeleteRollback", "recovery"],
    "plan.rollbackPolicy",
  );
  if (!isRecord(value.claims)) fail("BACKFILL_PLAN_ARTIFACT_INVALID", "plan.claims must be an object");
  exactKeys(value.claims, [
    "authoritativeScopeImportOnly", "reviewTasksAreArtifactOnly",
    "databaseWritesLimitedToListingScope", "canonicalCostWrites", "legacyTruthPromotion",
    "providerCalls", "paidCalls", "marketplaceMutations", "procurementMutations",
  ], "plan.claims");
}

function assertBackfillApprovalArtifactShape(
  value: unknown,
): asserts value is ProductTruthOwnerBackfillApproval {
  if (!isRecord(value)) {
    fail("BACKFILL_APPROVAL_ARTIFACT_INVALID", "backfill approval must be an object");
  }
  exactKeys(value, [
    "schemaVersion", "decision", "approvedBy", "approvalId", "ownerDecisionId",
    "planId", "planSha256", "databaseTargetFingerprint", "manifestSha256",
    "preconditionStateSha256", "allowScopeImport", "allowCanonicalCostRecompute",
    "allowLegacyTruthPromotion", "backupReference", "issuedAt", "expiresAt",
  ], "backfill approval");
  if (value.schemaVersion !== PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION) {
    fail(
      "BACKFILL_APPROVAL_ARTIFACT_INVALID",
      `backfill approval must use ${PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION}`,
    );
  }
}

export interface LoadedProductTruthListingExecutionArtifacts {
  lane: "listing";
  plan: ProductTruthOperationalPlan;
  planSha256: string;
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  approval: ProductTruthOperationalApproval;
  validatedApproval: ValidatedProductTruthOperationalApproval;
}

export interface LoadedProductTruthTargetedExecutionArtifacts {
  lane: "targeted_walmart_evidence";
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  approval: ProductTruthOperationalApproval;
  validatedApproval: ValidatedProductTruthOperationalApproval;
}

export type LoadedProductTruthExecutionArtifacts =
  | LoadedProductTruthListingExecutionArtifacts
  | LoadedProductTruthTargetedExecutionArtifacts;

/**
 * Pure filesystem/contract preflight. It does not open a DB or call a provider.
 */
export async function loadProductTruthExecutionArtifacts(input: {
  planPath: string;
  planShaPath: string;
  manifestPath?: string;
  approvalPath: string;
  executionConfirmation: string;
  targetFingerprint: string;
  now: string;
  cwd?: string;
}): Promise<LoadedProductTruthExecutionArtifacts> {
  const cwd = input.cwd ?? process.cwd();
  const [planFile, shaFile, approvalFile] = await Promise.all([
    readExactRegularUtf8File(input.planPath, "plan", cwd, JSON_LIMIT_BYTES),
    readExactRegularUtf8File(input.planShaPath, "plan SHA", cwd, 1024),
    readExactRegularUtf8File(input.approvalPath, "approval", cwd, JSON_LIMIT_BYTES),
  ]);
  const planValue = parseJson(planFile.text, "plan");
  const targeted = isRecord(planValue)
    && planValue.schemaVersion === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION;
  const plan = targeted
    ? parseProductTruthTargetedWalmartEvidencePlan(planValue)
    : parseProductTruthOperationalPlan(planValue);
  assertCanonicalJson(planFile.text, plan, "plan");
  const planSha256 = parseSha256File(shaFile.text);
  if (
    planSha256 !== sha256(planFile.text)
    || planSha256 !== productTruthOperationalSha256(plan)
  ) {
    fail("PLAN_HASH_MISMATCH", "plan bytes, plan SHA artifact, and parsed plan do not match");
  }
  if (plan.targetFingerprint !== input.targetFingerprint) {
    fail("DATABASE_TARGET_FINGERPRINT_MISMATCH", "explicit database target differs from sealed plan");
  }
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== input.now) {
    fail("EXECUTION_CLOCK_INVALID", "execution clock must be a canonical ISO timestamp");
  }
  if (nowMs < Date.parse(plan.createdAt) || nowMs >= Date.parse(plan.expiresAt)) {
    fail("PLAN_NOT_CURRENT", "sealed plan is not current at execution time");
  }
  const approvalValue = parseJson(approvalFile.text, "approval");
  assertCanonicalJson(approvalFile.text, approvalValue, "approval");
  if (targeted) {
    if (input.manifestPath) {
      usageError(
        "TARGETED_EVIDENCE_MANIFEST_FORBIDDEN",
        "targeted execution must not receive a Phase 1 listing manifest",
      );
    }
    const targetedPlan = plan as ProductTruthTargetedWalmartEvidencePlan;
    const validatedApproval = validateProductTruthTargetedWalmartEvidenceApproval({
      plan: targetedPlan,
      planSha256,
      approval: approvalValue,
      executionConfirmation: input.executionConfirmation,
      now: input.now,
    });
    return {
      lane: "targeted_walmart_evidence",
      plan: targetedPlan,
      planSha256,
      approval: approvalValue as ProductTruthOperationalApproval,
      validatedApproval,
    };
  }
  if (!input.manifestPath) {
    usageError("CLI_ARGUMENT_REQUIRED", "canonical listing execution requires --manifest");
  }
  const listingPlan = plan as ProductTruthOperationalPlan;
  const manifestFile = await readCanonicalManifest(input.manifestPath, cwd);
  assertProductTruthOperationalManifestBinding({
    plan: listingPlan,
    manifest: manifestFile.manifest,
    manifestJson: manifestFile.manifestJson,
  });
  assertApprovalArtifactShape(approvalValue, listingPlan);
  const validatedApproval = validateProductTruthOperationalApproval({
    plan: listingPlan,
    planSha256,
    approval: approvalValue,
    executionConfirmation: input.executionConfirmation,
    now: input.now,
  });
  return {
    lane: "listing",
    plan: listingPlan,
    planSha256,
    manifest: manifestFile.manifest,
    manifestJson: manifestFile.manifestJson,
    approval: approvalValue,
    validatedApproval,
  };
}

interface ArtifactFile {
  name: string;
  content: string;
}

function resolveNewOutputDirectory(cwd: string, requested: string): string {
  const output = resolve(cwd, requested);
  if (output === parsePath(output).root || output === resolve(cwd)) {
    usageError("OUTPUT_DIRECTORY_UNSAFE", "--out must be a dedicated new child directory");
  }
  return output;
}

async function assertOutputDirectoryAvailable(output: string): Promise<void> {
  try {
    await lstat(output);
    fail("OUTPUT_DIRECTORY_EXISTS", `artifact directory already exists: ${output}`);
  } catch (error) {
    if (error instanceof ProductTruthRunnerCliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("OUTPUT_DIRECTORY_INVALID", `cannot inspect artifact directory ${output}`, { cause: error });
    }
  }
  const parent = dirname(output);
  let stats;
  try {
    stats = await lstat(parent);
  } catch (error) {
    fail("OUTPUT_PARENT_MISSING", `artifact parent directory does not exist: ${parent}`, { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("OUTPUT_PARENT_INVALID", "artifact parent must be a real directory, not a symlink");
  }
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) {
    fail("OUTPUT_PARENT_NONCANONICAL", "artifact parent path must be canonical");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function writeAtomicFile(directory: string, file: ArtifactFile): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(file.name)) {
    fail("ARTIFACT_NAME_INVALID", `unsafe artifact name ${file.name}`);
  }
  const destination = resolve(directory, file.name);
  if (dirname(destination) !== directory) fail("ARTIFACT_NAME_INVALID", `unsafe artifact path ${file.name}`);
  const temporary = resolve(directory, `.${file.name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(file.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

async function writeNewArtifactDirectory(
  output: string,
  files: readonly ArtifactFile[],
): Promise<void> {
  await assertOutputDirectoryAvailable(output);
  await mkdir(output, { mode: 0o700 });
  for (const file of files) await writeAtomicFile(output, file);
  await syncDirectory(output);
  await syncDirectory(dirname(output));
}

export function createProductTruthReportArtifactWriter(input: {
  outputDirectory: string;
  plan: Pick<
    ProductTruthOperationalPlan | ProductTruthTargetedWalmartEvidencePlan,
    "runId" | "manifest" | "targetFingerprint"
  >;
  planSha256: string;
}): (report: unknown) => Promise<{ reportSha256: string; artifactIndexSha256: string }> {
  let invoked = false;
  return async (report: unknown) => {
    if (invoked) fail("ARTIFACT_WRITER_REUSED", "final report artifact writer may be called only once");
    invoked = true;
    const reportJson = renderProductTruthOperationalJson(report);
    const reportSha256 = sha256(reportJson);
    const index = {
      schemaVersion: ARTIFACT_INDEX_VERSION,
      runId: input.plan.runId,
      planSha256: input.planSha256,
      manifestSha256: input.plan.manifest.sha256,
      targetFingerprint: input.plan.targetFingerprint,
      artifacts: [
        {
          path: "report.json",
          mediaType: "application/json",
          byteLength: Buffer.byteLength(reportJson),
          sha256: reportSha256,
        },
      ],
    };
    const artifactIndexJson = renderProductTruthOperationalJson(index);
    const artifactIndexSha256 = sha256(artifactIndexJson);
    await writeNewArtifactDirectory(input.outputDirectory, [
      { name: "report.json", content: reportJson },
      { name: "report.sha256", content: `${reportSha256}\n` },
      { name: "artifact-index.json", content: artifactIndexJson },
      { name: "artifact-index.sha256", content: `${artifactIndexSha256}\n` },
    ]);
    return { reportSha256, artifactIndexSha256 };
  };
}

async function assertLocalDatabaseExists(target: DatabaseTarget): Promise<void> {
  if (target.kind !== "local" || target.clientUrl.startsWith("file::memory:")) return;
  const path = fileURLToPath(target.clientUrl);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    fail("LOCAL_DATABASE_MISSING", `local database does not exist: ${path}`, { cause: error });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail("LOCAL_DATABASE_INVALID", "local database must be a regular non-symlink file");
  }
}

async function withOperationalClient<T>(
  resolved: ResolvedCliDatabaseTarget,
  action: (db: Client) => Promise<T>,
): Promise<T> {
  await assertLocalDatabaseExists(resolved.target);
  const db = createClient({
    url: resolved.target.clientUrl,
    ...(resolved.authToken ? { authToken: resolved.authToken } : {}),
  });
  try {
    await db.execute("PRAGMA foreign_keys=ON");
    return await action(db);
  } finally {
    db.close();
  }
}

async function withReadOnlyClient<T>(
  resolved: ResolvedCliDatabaseTarget,
  action: (db: Client) => Promise<T>,
): Promise<T> {
  await assertLocalDatabaseExists(resolved.target);
  const db = createClient({
    url: resolved.target.clientUrl,
    ...(resolved.authToken ? { authToken: resolved.authToken } : {}),
  });
  try {
    await db.execute("PRAGMA foreign_keys=ON");
    await db.execute("PRAGMA query_only=ON");
    return await action(db);
  } finally {
    db.close();
  }
}

async function inspectTargetedEvidenceRuntime(input: {
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<{
  targetFingerprint: string;
  engineReleaseSha256: string;
  schemaFingerprintSha256: string;
  migrationSetSha256: string;
  canonicalMigrationsApplied: true;
}> {
  const [release, migration] = await Promise.all([
    inspectWalmartNewSkuSourceRelease(input.cwd),
    planProductTruthMigrations({
      databaseUrl: input.resolved.target.clientUrl,
      authToken: input.resolved.authToken,
      allowRemote: input.resolved.target.kind === "remote",
      cwd: input.cwd,
      now: () => new Date(input.now),
    }),
  ]);
  const canonicalMigrationsApplied = Boolean(
    migration.database?.targetFingerprint === input.resolved.target.fingerprint
    && migration.schema
    && migration.receiptLedger === "ready"
    && migration.prismaLedger === "ready"
    && migration.orderValid
    && migration.migrations.length > 0
    && migration.migrations.every((row) => row.state === "applied" && row.tracking === "tracked"),
  );
  if (!migration.schema || !canonicalMigrationsApplied) {
    fail(
      "TARGETED_EVIDENCE_CANONICAL_MIGRATIONS_REQUIRED",
      "exact schema plus fully tracked Product Truth migration set is required",
    );
  }
  return {
    targetFingerprint: input.resolved.target.fingerprint,
    engineReleaseSha256: release.engine_release_sha256,
    schemaFingerprintSha256: migration.schema.sha256,
    migrationSetSha256: migration.migrationSetSha256,
    canonicalMigrationsApplied: true,
  };
}

async function targetedHarvestStateAbsent(
  db: Client,
  donorProductId: string,
  retailerProductId: string,
): Promise<boolean> {
  const state = await getDonorHarvestState(db, donorHarvestStateId({
    donorProductId,
    source: "unwrangle:walmart",
    retailerProductId,
  }));
  return state === null;
}

async function writeConsumerReadinessArtifacts(input: {
  outputDirectory: string;
  report: ProductTruthConsumerReadinessReport;
}): Promise<{ reportSha256: string; artifactIndexSha256: string }> {
  const reportJson = renderProductTruthConsumerReadinessJson(input.report);
  const reportSha256 = sha256(reportJson);
  const index = {
    schemaVersion: READINESS_ARTIFACT_INDEX_VERSION,
    databaseTargetFingerprint: input.report.databaseTargetFingerprint,
    authoritativeManifestSha256: input.report.authoritativeManifest.sha256,
    readinessPayloadSha256: input.report.payloadSha256,
    artifacts: [
      {
        path: "readiness-report.json",
        mediaType: "application/json",
        byteLength: Buffer.byteLength(reportJson),
        sha256: reportSha256,
      },
    ],
  };
  const artifactIndexJson = renderProductTruthOperationalJson(index);
  const artifactIndexSha256 = sha256(artifactIndexJson);
  await writeNewArtifactDirectory(input.outputDirectory, [
    { name: "readiness-report.json", content: reportJson },
    { name: "readiness-report.sha256", content: `${reportSha256}\n` },
    { name: "artifact-index.json", content: artifactIndexJson },
    { name: "artifact-index.sha256", content: `${artifactIndexSha256}\n` },
  ]);
  return { reportSha256, artifactIndexSha256 };
}

async function runMatcherReplayCommand(input: {
  options: Extract<ProductTruthRunnerCliOptions, { command: "matcher-replay" }>;
  cwd: string;
}): Promise<{
  result: Record<string, unknown>;
  exitCode: number;
}> {
  const outputDirectory = resolveNewOutputDirectory(input.cwd, input.options.outputDirectory);
  await assertOutputDirectoryAvailable(outputDirectory);
  const corpusFile = await readExactRegularUtf8File(
    input.options.corpusPath,
    "matcher replay corpus",
    input.cwd,
    MANIFEST_LIMIT_BYTES,
  );
  const corpusValue = parseJson(corpusFile.text, "matcher replay corpus");
  const corpus = parseProductTruthMatcherReplayCorpus(corpusValue);
  if (corpusFile.text !== renderProductTruthOperationalJson(corpus)) {
    fail(
      "MATCHER_REPLAY_CORPUS_NOT_CANONICAL",
      "matcher replay corpus bytes must equal canonical Product Truth JSON",
    );
  }
  const report = runProductTruthMatcherReplay({
    corpus,
    requiredCaseCount: input.options.requiredCaseCount,
  });
  const reportJson = renderProductTruthMatcherReplayReportJson(report);
  const reportSha256 = sha256(reportJson);
  const index = {
    schemaVersion: MATCHER_REPLAY_ARTIFACT_INDEX_VERSION,
    corpusId: report.corpusId,
    corpusSha256: report.corpusSha256,
    sourceArtifactSha256: report.source.artifactSha256,
    matcherVersion: report.matcherVersion,
    requiredCaseCount: report.requiredCaseCount,
    certification: report.certification,
    payloadSha256: report.payloadSha256,
    artifacts: [{
      path: "report.json",
      mediaType: "application/json",
      byteLength: Buffer.byteLength(reportJson),
      sha256: reportSha256,
    }],
  };
  const indexJson = renderProductTruthOperationalJson(index);
  const artifactIndexSha256 = sha256(indexJson);
  await writeNewArtifactDirectory(outputDirectory, [
    { name: "report.json", content: reportJson },
    { name: "report.sha256", content: `${reportSha256}\n` },
    { name: "artifact-index.json", content: indexJson },
    { name: "artifact-index.sha256", content: `${artifactIndexSha256}\n` },
  ]);
  return {
    result: {
      ok: report.certification === "PASS",
      command: "matcher-replay",
      offline: true,
      databaseConnections: 0,
      databaseReads: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      modelCalls: 0,
      corpusId: report.corpusId,
      corpusSha256: report.corpusSha256,
      matcherVersion: report.matcherVersion,
      requiredCaseCount: report.requiredCaseCount,
      counts: report.counts,
      certification: report.certification,
      payloadSha256: report.payloadSha256,
      reportSha256,
      artifactIndexSha256,
      outputDirectory,
    },
    exitCode: report.certification === "PASS" ? 0 : 2,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildProductTruthTargetedPlanHandoff(input: {
  requestPath: string;
  databaseUrl: string;
  allowRemote: boolean;
  authTokenEnv?: string;
  outputDirectory: string;
}): { next_argv: string[]; next_command: string } {
  const nextArgv = [
    "npm",
    "run",
    "product-truth",
    "--",
    "plan",
    "--request", input.requestPath,
    "--url", input.databaseUrl,
    ...(input.allowRemote ? ["--allow-remote"] : []),
    ...(input.authTokenEnv ? ["--auth-token-env", input.authTokenEnv] : []),
    "--out", input.outputDirectory,
  ];
  return {
    next_argv: nextArgv,
    next_command: nextArgv.map(shellQuote).join(" "),
  };
}

export function productTruthTargetedDoctorExitCode(result: Record<string, unknown>): 0 | 2 {
  return result.ownerActionRequired === true ? 2 : 0;
}

async function buildTargetedEvidenceRequestArtifacts(input: {
  options: Extract<ProductTruthRunnerCliOptions, { command: "doctor" }> & {
    donorProductId: string;
    query: string;
    runId: string;
    expiresAt: string;
    unwrangleReserveFloor: number;
    outputDirectory: string;
    canonicalIdentityPath?: string;
  };
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<Record<string, unknown>> {
  const runtime = await inspectTargetedEvidenceRuntime({
    resolved: input.resolved,
    cwd: input.cwd,
    now: input.now,
  });
  let ownerCanonicalIdentityJson: string | null = null;
  if (input.options.canonicalIdentityPath) {
    const identityFile = await readExactRegularUtf8File(
      input.options.canonicalIdentityPath,
      "owner canonical identity",
      input.cwd,
      JSON_LIMIT_BYTES,
    );
    const identity = parseJson(identityFile.text, "owner canonical identity");
    if (JSON.stringify(identity) !== identityFile.text) {
      fail(
        "TARGETED_EVIDENCE_OWNER_IDENTITY_BYTES_INVALID",
        "owner canonical identity must be compact exact builder-order JSON without a newline",
      );
    }
    ownerCanonicalIdentityJson = identityFile.text;
  }
  const capture = await withReadOnlyClient(input.resolved, async (db) => {
    try {
      const exact = await readTargetedWalmartDonorSnapshot(db, input.options.donorProductId);
      if (ownerCanonicalIdentityJson !== null) {
        fail(
          "TARGETED_EVIDENCE_OWNER_IDENTITY_UNEXPECTED",
          "already-exact donor must not receive a bootstrap identity artifact",
        );
      }
      return { snapshot: exact, ownerTemplate: null };
    } catch {
      if (ownerCanonicalIdentityJson === null) {
        const ownerTemplate = await readTargetedWalmartLegacyIdentityTemplate(
          db,
          input.options.donorProductId,
        );
        return { snapshot: null, ownerTemplate };
      }
      const bootstrap = await readTargetedWalmartLegacyDonorSnapshot(
        db,
        input.options.donorProductId,
        ownerCanonicalIdentityJson,
      );
      return { snapshot: bootstrap, ownerTemplate: null };
    }
  });
  const output = resolveNewOutputDirectory(input.cwd, input.options.outputDirectory);
  if (capture.ownerTemplate) {
    const template = capture.ownerTemplate;
    const identity = (template.canonicalIdentity ?? {}) as Record<string, unknown>;
    const exactIdentityTemplate = JSON.stringify({
      schemaVersion: identity.schemaVersion,
      brand: identity.brand,
      productLine: identity.productLine,
      flavor: identity.flavor,
      modifiers: identity.modifiers,
      form: identity.form,
      size: identity.size,
      outerPackCount: identity.outerPackCount,
    });
    await writeNewArtifactDirectory(output, [
      {
        name: "owner-identity-review.json",
        content: renderProductTruthOperationalJson(template),
      },
      { name: "canonical-identity.template.json", content: exactIdentityTemplate },
    ]);
    return {
      ok: false,
      command: "doctor",
      mode: "TARGETED_OWNER_IDENTITY_REQUIRED",
      providerCalls: 0,
      databaseWrites: 0,
      ownerActionRequired: true,
      authenticatedOwnerIdentity: false,
      outputDirectory: output,
      ownerReviewArtifact: resolve(output, "owner-identity-review.json"),
      canonicalIdentityTemplate: resolve(output, "canonical-identity.template.json"),
      next_argv: null,
      next_command: null,
    };
  }
  const snapshot = capture.snapshot!;
  if (!await withReadOnlyClient(input.resolved, (db) => targetedHarvestStateAbsent(
    db,
    snapshot.donorProductId,
    snapshot.retailerProductId,
  ))) {
    fail(
      "TARGETED_EVIDENCE_PRIOR_HARVEST_STATE_FORBIDDEN",
      "target already owns a detail-harvest lifecycle; choose an untouched donor",
    );
  }
  const request = buildProductTruthTargetedWalmartEvidenceRequest({
    runId: input.options.runId,
    createdAt: input.now,
    expiresAt: input.options.expiresAt,
    targetFingerprint: runtime.targetFingerprint,
    engineReleaseSha256: runtime.engineReleaseSha256,
    schemaFingerprintSha256: runtime.schemaFingerprintSha256,
    migrationSetSha256: runtime.migrationSetSha256,
    query: input.options.query,
    donorSnapshot: snapshot,
    unwrangleReserveFloor: input.options.unwrangleReserveFloor,
  });
  const requestJson = renderProductTruthOperationalJson(request);
  const requestSha256 = sha256(requestJson);
  const plannedOutput = `${output}.plan`;
  await assertOutputDirectoryAvailable(plannedOutput);
  await writeNewArtifactDirectory(output, [
    { name: "request.json", content: requestJson },
    { name: "request.sha256", content: `${requestSha256}\n` },
  ]);
  const handoff = buildProductTruthTargetedPlanHandoff({
    requestPath: resolve(output, "request.json"),
    databaseUrl: input.options.databaseUrl,
    allowRemote: input.options.allowRemote,
    authTokenEnv: input.options.authTokenEnv,
    outputDirectory: plannedOutput,
  });
  return {
    ok: true,
    command: "doctor",
    mode: "TARGETED_WALMART_EVIDENCE_REQUEST_CAPTURE",
    providerCalls: 0,
    databaseWrites: 0,
    requestSha256,
    donorProductId: snapshot.donorProductId,
    donorOfferId: snapshot.donorOfferId,
    retailerProductId: snapshot.retailerProductId,
    identityMode: snapshot.identityMode,
    targetFingerprint: runtime.targetFingerprint,
    engineReleaseSha256: runtime.engineReleaseSha256,
    schemaFingerprintSha256: runtime.schemaFingerprintSha256,
    migrationSetSha256: runtime.migrationSetSha256,
    outputDirectory: output,
    ...handoff,
  };
}

async function buildOfflinePlanArtifacts(input: {
  options: Extract<ProductTruthRunnerCliOptions, { command: "plan" }>;
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<Record<string, unknown>> {
  const requestFile = await readExactRegularUtf8File(
    input.options.requestPath,
    "plan request",
    input.cwd,
    JSON_LIMIT_BYTES,
  );
  const request = parseJson(requestFile.text, "plan request");
  assertCanonicalJson(requestFile.text, request, "plan request");
  const targeted = isRecord(request)
    && request.schemaVersion === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION;
  let plan: ProductTruthOperationalPlan | ProductTruthTargetedWalmartEvidencePlan;
  if (targeted) {
    if (input.options.manifestPath) {
      usageError(
        "TARGETED_EVIDENCE_MANIFEST_FORBIDDEN",
        "targeted one-donor plan must not receive a Phase 1 listing manifest",
      );
    }
    const donorRequest = isRecord(request.donorSnapshot) ? request.donorSnapshot : null;
    const donorProductId = donorRequest?.donorProductId;
    if (typeof donorProductId !== "string" || !donorProductId) {
      fail("TARGETED_EVIDENCE_REQUEST_INVALID", "request donorProductId is missing");
    }
    const runtime = await inspectTargetedEvidenceRuntime({
      resolved: input.resolved,
      cwd: input.cwd,
      now: input.now,
    });
    const actual = await withReadOnlyClient(input.resolved, async (db) => {
      const identityMode = donorRequest?.identityMode;
      const canonicalIdentityJson = donorRequest?.canonicalIdentityJson;
      const donor = identityMode === "OWNER_ATTESTED_BOOTSTRAP"
        ? await readTargetedWalmartLegacyDonorSnapshot(
            db,
            donorProductId,
            typeof canonicalIdentityJson === "string" ? canonicalIdentityJson : "",
          )
        : await readTargetedWalmartDonorSnapshot(db, donorProductId);
      return {
        donor,
        harvestAbsent: await targetedHarvestStateAbsent(
          db,
          donor.donorProductId,
          donor.retailerProductId,
        ),
      };
    });
    plan = buildProductTruthTargetedWalmartEvidencePlan({
      request,
      actualTargetFingerprint: runtime.targetFingerprint,
      actualEngineReleaseSha256: runtime.engineReleaseSha256,
      actualSchemaFingerprintSha256: runtime.schemaFingerprintSha256,
      actualMigrationSetSha256: runtime.migrationSetSha256,
      actualDonorSnapshot: actual.donor,
      actualDetailHarvestStateAbsent: actual.harvestAbsent,
    });
  } else {
    if (!input.options.manifestPath) {
      usageError("CLI_ARGUMENT_REQUIRED", "canonical listing plan requires --manifest");
    }
    if (input.options.authTokenEnv) {
      usageError("PLAN_AUTH_TOKEN_FORBIDDEN", "offline listing plan does not accept --auth-token-env");
    }
    const manifestFile = await readCanonicalManifest(input.options.manifestPath, input.cwd);
    plan = buildProductTruthOperationalPlanFromRequest({
      request,
      manifest: manifestFile.manifest,
      manifestSha256: manifestFile.manifestSha256,
      targetFingerprint: input.resolved.target.fingerprint,
    });
  }
  const planJson = renderProductTruthOperationalJson(plan);
  const planSha256 = productTruthOperationalSha256(plan);
  if (sha256(planJson) !== planSha256) {
    fail("PLAN_HASH_INTERNAL_MISMATCH", "canonical plan digest did not reconcile");
  }
  const approvalInstructions = {
    schemaVersion: APPROVAL_INSTRUCTIONS_VERSION,
    runId: plan.runId,
    mode: plan.mode,
    requiredApprovalSchemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    requiredAction: plan.mode === "CANARY" ? "EXECUTE_CANARY" : "EXECUTE_WAVE",
    planSha256,
    targetFingerprint: plan.targetFingerprint,
    planExpiresAt: plan.expiresAt,
    executionConfirmationFormat:
      `EXECUTE_PRODUCT_TRUTH_PLAN_V1:${planSha256}:<OWNER_APPROVAL_ID>`,
    providerCeilings: plan.providerCeilings,
    sourcePolicy: plan.sourcePolicy,
    ...(targeted && (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].identityMode
      === "OWNER_ATTESTED_BOOTSTRAP" ? {
        ownerIdentityAttestationRequired: {
          statement: "By issuing the external Product Truth approval for this exact planSha256, owner attests that the canonical identity is the exact sellable variant represented by the sealed legacy donor and Walmart offer bytes.",
          donorProductId: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].donorProductId,
          donorOfferId: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].donorOfferId,
          retailerProductId: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].retailerProductId,
          normalizedProductUrl: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].normalizedProductUrl,
          canonicalVariantId: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].canonicalVariantId,
          canonicalIdentityHash: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].canonicalIdentityHash,
          legacySnapshotSha256: (plan as ProductTruthTargetedWalmartEvidencePlan).targets[0].legacySnapshot?.sha256,
          planExpiresAt: plan.expiresAt,
        },
      } : {}),
    warning: targeted
      ? "Owner approval, exact two-provider permit, fresh Unwrangle balance evidence, and exact confirmation are required. This plan permits one Oxylabs Walmart query and one Unwrangle Walmart detail call only; no OFF, clubs, fanout, publish, delist, reprice, purchase, or replay."
      : "Owner approval, fresh balance evidence, and exact execution confirmation are required; this plan authorizes no automatic publish, delist, reprice, or purchase.",
  };
  const output = resolveNewOutputDirectory(input.cwd, input.options.outputDirectory);
  await writeNewArtifactDirectory(output, [
    { name: "plan.json", content: planJson },
    { name: "plan.sha256", content: `${planSha256}\n` },
    {
      name: "approval-instructions.json",
      content: renderProductTruthOperationalJson(approvalInstructions),
    },
  ]);
  return {
    ok: true,
    command: "plan",
    offline: !targeted,
    providerCalls: 0,
    databaseConnections: targeted ? 2 : 0,
    runId: plan.runId,
    planSha256,
    target: {
      kind: input.resolved.target.kind,
      displayUrl: input.resolved.target.displayUrl,
      fingerprint: input.resolved.target.fingerprint,
    },
    lane: targeted ? "TARGETED_WALMART_EVIDENCE" : "LISTING_SCOPE",
    outputDirectory: output,
  };
}

async function buildBackfillPlanArtifacts(input: {
  options: Extract<ProductTruthRunnerCliOptions, { command: "backfill-plan" }>;
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<Record<string, unknown>> {
  const outputDirectory = resolveNewOutputDirectory(input.cwd, input.options.outputDirectory);
  await assertOutputDirectoryAvailable(outputDirectory);
  const [manifestFile, loadedMigrationBridge] = await Promise.all([
    readCanonicalManifest(input.options.manifestPath, input.cwd),
    readCanonicalMigrationBridge({
      certificationPath: input.options.migrationCertificationPath,
      certificationShaPath: input.options.migrationCertificationShaPath,
      reportPath: input.options.migrationReportPath,
      reportShaPath: input.options.migrationReportShaPath,
      cwd: input.cwd,
    }),
  ]);
  const migrationBridge = await verifyCanonicalMigrationBridge({
    bridge: loadedMigrationBridge,
    resolved: input.resolved,
    cwd: input.cwd,
    now: input.now,
  });
  const plan = await withReadOnlyClient(input.resolved, async (db) => {
    await assertDurableMigrationActivationReceipt(db, migrationBridge);
    return planProductTruthOwnerBackfill(db, {
      planId: input.options.planId,
      manifest: manifestFile.manifest,
      manifestJson: manifestFile.manifestJson,
      manifestSha256: manifestFile.manifestSha256,
      databaseTargetFingerprint: input.resolved.target.fingerprint,
      migrationCertification: migrationBridge.certification,
      createdAt: input.now,
      expiresAt: input.options.expiresAt,
    });
  });
  await writeProductTruthBackfillPlanArtifacts(outputDirectory, plan);
  return {
    ok: true,
    command: "backfill-plan",
    mode: "CONNECTED_READ_ONLY_NO_PAID_PLAN",
    providerCalls: 0,
    databaseWrites: 0,
    canonicalCostRecomputes: 0,
    target: {
      kind: input.resolved.target.kind,
      displayUrl: input.resolved.target.displayUrl,
      fingerprint: input.resolved.target.fingerprint,
    },
    planId: plan.planId,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifest.sha256,
    migrationCertificationSha256: migrationBridge.certificationSha256,
    migrationReportSha256: migrationBridge.reportSha256,
    canonicalMigrationSetSha256: migrationBridge.canonicalMigrationSetSha256,
    liveSchemaFingerprintSha256: migrationBridge.liveSchemaFingerprintSha256,
    migrationLedgers: {
      productTruth: migrationBridge.liveReceiptLedger,
      prisma: migrationBridge.livePrismaLedger,
    },
    scopeImports: plan.operations.scopeImports.length,
    reviewTasks: plan.operations.reviewTasks.length,
    outputDirectory,
  };
}

async function applyBackfillArtifacts(input: {
  options: Extract<ProductTruthRunnerCliOptions, { command: "backfill-apply" }>;
  resolved: ResolvedCliDatabaseTarget;
  cwd: string;
  now: string;
}): Promise<Record<string, unknown>> {
  const outputDirectory = resolveNewOutputDirectory(input.cwd, input.options.outputDirectory);
  await assertOutputDirectoryAvailable(outputDirectory);
  const artifacts = await loadProductTruthBackfillApplyArtifacts({
    planPath: input.options.planPath,
    planShaPath: input.options.planShaPath,
    manifestPath: input.options.manifestPath,
    approvalPath: input.options.approvalPath,
    approvalShaPath: input.options.approvalShaPath,
    targetFingerprint: input.resolved.target.fingerprint,
    cwd: input.cwd,
  });
  const report = await withOperationalClient(input.resolved, (db) =>
    applyProductTruthOwnerBackfill(db, {
      plan: artifacts.plan,
      expectedPlanSha256: artifacts.planSha256,
      manifest: artifacts.manifest,
      manifestJson: artifacts.manifestJson,
      manifestSha256: artifacts.manifestSha256,
      databaseTargetFingerprint: input.resolved.target.fingerprint,
      approval: artifacts.approval,
      expectedApprovalSha256: artifacts.approvalSha256,
      confirmation: input.options.executionConfirmation,
      appliedAt: input.now,
    }));
  const reportArtifacts = await writeProductTruthBackfillReportArtifacts(
    outputDirectory,
    report,
  );
  return {
    ok: true,
    command: "backfill-apply",
    status: report.status,
    providerCalls: 0,
    paidCalls: 0,
    canonicalCostRecomputes: 0,
    legacyTruthPromotions: 0,
    target: {
      kind: input.resolved.target.kind,
      displayUrl: input.resolved.target.displayUrl,
      fingerprint: input.resolved.target.fingerprint,
    },
    planId: report.planId,
    planSha256: report.planSha256,
    approvalId: report.approvalId,
    manifestSha256: report.manifestSha256,
    counts: report.counts,
    verification: report.verification,
    reportSha256: reportArtifacts.reportSha256,
    artifactIndexSha256: reportArtifacts.artifactIndexSha256,
    outputDirectory,
  };
}

interface OperationalRunnerModule {
  executeProductTruthOperationalRun(
    db: Client,
    input: ExecuteProductTruthOperationalRunInput,
  ): Promise<ProductTruthOperationalExecutionResult>;
}

async function loadOperationalRunner(): Promise<OperationalRunnerModule> {
  // Kept lazy so `plan`, parser tests, status, and doctor cannot load provider paths.
  const modulePath = "../src/lib/sourcing/product-truth-operational-runner";
  const loaded = await import(modulePath) as Partial<OperationalRunnerModule>;
  if (typeof loaded.executeProductTruthOperationalRun !== "function") {
    fail("OPERATIONAL_RUNNER_UNAVAILABLE", "operational runner module is missing its execution export");
  }
  return loaded as OperationalRunnerModule;
}

function publicRunSummary(
  summary: Awaited<ReturnType<typeof productTruthOperationalRunSummary>>,
) {
  return {
    runId: summary.run.runId,
    approvalId: summary.run.approvalId,
    mode: summary.run.mode,
    environment: summary.run.environment,
    status: summary.run.status,
    targetFingerprint: summary.run.targetFingerprint,
    manifestSha256: summary.run.manifestSha256,
    targetSetSha256: summary.run.targetSetSha256,
    targetCount: summary.run.targetCount,
    counts: summary.counts,
    startedAt: summary.run.startedAt,
    finishedAt: summary.run.finishedAt,
    heartbeatAt: summary.run.heartbeatAt,
    leaseExpiresAt: summary.run.leaseExpiresAt,
    reportSha256: summary.run.reportSha256,
    artifactIndexSha256: summary.run.artifactIndexSha256,
    items: summary.items.map((item) => ({
      ordinal: item.ordinal,
      listingKey: item.listingKey,
      status: item.status,
      stage: item.stage,
      attempts: item.attempts,
      queueJobId: item.queueJobId,
      lastError: item.lastError,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
  };
}

interface CliRuntime {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function errorCode(error: unknown): string {
  if (error instanceof ProductTruthRunnerCliError) return error.code;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "UNEXPECTED_ERROR";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected non-Error failure";
}

async function executeCommand(
  options: ProductTruthRunnerCliOptions,
  runtime: Required<Pick<CliRuntime, "cwd" | "env" | "now">>,
): Promise<{ result: unknown; exitCode: number }> {
  if (options.help) {
    return { result: productTruthRunnerUsage(options.command), exitCode: 0 };
  }
  if (options.command === "matcher-replay") {
    return runMatcherReplayCommand({ options, cwd: runtime.cwd });
  }
  let targetedPlan = false;
  if (options.command === "plan") {
    const requestFile = await readExactRegularUtf8File(
      options.requestPath,
      "plan request",
      runtime.cwd,
      JSON_LIMIT_BYTES,
    );
    const request = parseJson(requestFile.text, "plan request");
    targetedPlan = isRecord(request)
      && request.schemaVersion === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION;
  }
  const connect = options.command !== "plan" || targetedPlan;
  const resolved = resolveCliDatabaseTarget({
    databaseUrl: options.databaseUrl,
    allowRemote: options.allowRemote,
    authTokenEnv: options.authTokenEnv,
    connect,
    cwd: runtime.cwd,
    env: runtime.env,
  });
  if (options.command === "plan") {
    return {
      result: await buildOfflinePlanArtifacts({
        options,
        resolved,
        cwd: runtime.cwd,
        now: runtime.now(),
      }),
      exitCode: 0,
    };
  }
  if (options.command === "backfill-plan") {
    return {
      result: await buildBackfillPlanArtifacts({
        options,
        resolved,
        cwd: runtime.cwd,
        now: runtime.now(),
      }),
      exitCode: 0,
    };
  }
  if (options.command === "backfill-apply") {
    return {
      result: await applyBackfillArtifacts({
        options,
        resolved,
        cwd: runtime.cwd,
        now: runtime.now(),
      }),
      exitCode: 0,
    };
  }
  if (options.command === "doctor") {
    if (options.donorProductId) {
      const targetedDoctorResult = await buildTargetedEvidenceRequestArtifacts({
        options: options as Extract<ProductTruthRunnerCliOptions, { command: "doctor" }> & {
          donorProductId: string;
          query: string;
          runId: string;
          expiresAt: string;
          unwrangleReserveFloor: number;
          outputDirectory: string;
        },
        resolved,
        cwd: runtime.cwd,
        now: runtime.now(),
      });
      return {
        result: targetedDoctorResult,
        exitCode: productTruthTargetedDoctorExitCode(targetedDoctorResult),
      };
    }
    const result = await withOperationalClient(resolved, async (db) => {
      await assertProductTruthOperationalRunSchema(db);
      return {
        ok: true,
        command: "doctor",
        providerCalls: 0,
        target: {
          kind: resolved.target.kind,
          displayUrl: resolved.target.displayUrl,
          fingerprint: resolved.target.fingerprint,
        },
        checks: { foreignKeys: "ready", operationalSchema: "ready" },
      };
    });
    return { result, exitCode: 0 };
  }
  if (options.command === "readiness") {
    const outputDirectory = resolveNewOutputDirectory(
      runtime.cwd,
      options.outputDirectory,
    );
    await assertOutputDirectoryAvailable(outputDirectory);
    const manifestFile = await readCanonicalManifest(
      options.manifestPath,
      runtime.cwd,
    );
    const capturedAt = runtime.now();
    const report = await withReadOnlyClient(resolved, async (db) =>
      readProductTruthConsumerReadiness(db, {
        manifest: manifestFile.manifest,
        manifestJson: manifestFile.manifestJson,
        expectedManifestSha256: manifestFile.manifestSha256,
        databaseTargetFingerprint: resolved.target.fingerprint,
        capturedAt,
        asOf: options.asOf,
        maxPriceAgeMs: options.maxPriceAgeMs,
      }));
    const artifacts = await writeConsumerReadinessArtifacts({
      outputDirectory,
      report,
    });
    return {
      result: {
        ok: true,
        command: "readiness",
        mode: report.mode,
        providerCalls: 0,
        databaseWrites: 0,
        target: {
          kind: resolved.target.kind,
          displayUrl: resolved.target.displayUrl,
          fingerprint: resolved.target.fingerprint,
        },
        authoritativeManifest: report.authoritativeManifest,
        counts: report.counts,
        dataReadyConsumers: report.dataReadyConsumers,
        readinessPayloadSha256: report.payloadSha256,
        reportSha256: artifacts.reportSha256,
        artifactIndexSha256: artifacts.artifactIndexSha256,
        outputDirectory,
      },
      exitCode: 0,
    };
  }
  if (options.command === "status" || options.command === "report") {
    const result = await withOperationalClient(resolved, async (db) => {
      const summary = await productTruthOperationalRunSummary(db, options.runId);
      if (summary.run.targetFingerprint !== resolved.target.fingerprint) {
        fail("DATABASE_TARGET_FINGERPRINT_MISMATCH", "stored run belongs to a different database target");
      }
      const ledger = await readProductTruthOperationalLedger(db, options.runId);
      const targetedInspection = summary.run.planSchemaVersion
        === PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION
        ? await inspectProductTruthTargetedWalmartEvidenceRun(db, options.runId)
        : null;
      if (options.command === "status") {
        return {
          schemaVersion: STATUS_VERSION,
          target: {
            kind: resolved.target.kind,
            displayUrl: resolved.target.displayUrl,
            fingerprint: resolved.target.fingerprint,
          },
          ...publicRunSummary(summary),
          spend: ledger.totals,
          ...(targetedInspection ? { targetedEvidenceJob: targetedInspection.job } : {}),
        };
      }
      const events = await listProductTruthOperationalEvents(db, options.runId);
      return {
        schemaVersion: INSPECTION_REPORT_VERSION,
        target: {
          kind: resolved.target.kind,
          displayUrl: resolved.target.displayUrl,
          fingerprint: resolved.target.fingerprint,
        },
        run: summary.run,
        counts: summary.counts,
        items: summary.items,
        events,
        ledger,
        ...(targetedInspection ? {
          targetedEvidence: {
            target: targetedInspection.plan.targets[0],
            job: targetedInspection.job,
          },
        } : {}),
      };
    });
    return { result, exitCode: 0 };
  }

  if (options.command !== "execute" && options.command !== "resume") {
    fail("CLI_INTERNAL_COMMAND_INVALID", "unreachable command dispatch state");
  }
  const executionOptions = options as Extract<
    ProductTruthRunnerCliOptions,
    { command: "execute" | "resume" }
  >;
  const outputDirectory = resolveNewOutputDirectory(runtime.cwd, executionOptions.outputDirectory);
  await assertOutputDirectoryAvailable(outputDirectory);
  const artifacts = await loadProductTruthExecutionArtifacts({
    planPath: executionOptions.planPath,
    planShaPath: executionOptions.planShaPath,
    manifestPath: executionOptions.manifestPath,
    approvalPath: executionOptions.approvalPath,
    executionConfirmation: executionOptions.executionConfirmation,
    targetFingerprint: resolved.target.fingerprint,
    now: runtime.now(),
    cwd: runtime.cwd,
  });
  const result = artifacts.lane === "targeted_walmart_evidence"
    ? await withOperationalClient(resolved, async (db) => (
      executeProductTruthTargetedWalmartEvidence(db, {
        plan: artifacts.plan,
        planSha256: artifacts.planSha256,
        validatedApproval: artifacts.validatedApproval,
        environment: resolved.target.kind === "remote" ? "production" : "local-test",
        command: executionOptions.command,
        leaseOwner: `product-truth-targeted-cli:${process.pid}:${randomUUID()}`,
        meteredDatabase: {
          url: resolved.target.clientUrl,
          ...(resolved.authToken ? { authToken: resolved.authToken } : {}),
          targetFingerprint: resolved.target.fingerprint,
        },
        artifactWriter: createProductTruthReportArtifactWriter({
          outputDirectory,
          plan: artifacts.plan,
          planSha256: artifacts.planSha256,
        }),
        adapter: PRODUCT_TRUTH_TARGETED_WALMART_PRODUCTION_ADAPTER(async () => (
          inspectTargetedEvidenceRuntime({
            resolved,
            cwd: runtime.cwd,
            now: runtime.now(),
          })
        )),
      })
    ))
    : await (async () => {
      const runner = await loadOperationalRunner();
      return withOperationalClient(resolved, async (db) => (
        runner.executeProductTruthOperationalRun(db, {
          plan: artifacts.plan,
          validatedApproval: artifacts.validatedApproval,
          environment: resolved.target.kind === "remote" ? "production" : "local-test",
          command: executionOptions.command,
          leaseOwner: `product-truth-cli:${process.pid}:${randomUUID()}`,
          meteredDatabase: {
            url: resolved.target.clientUrl,
            ...(resolved.authToken ? { authToken: resolved.authToken } : {}),
            targetFingerprint: resolved.target.fingerprint,
          },
          artifactWriter: createProductTruthReportArtifactWriter({
            outputDirectory,
            plan: artifacts.plan,
            planSha256: artifacts.planSha256,
          }),
        })
      ));
    })();
  const status = isRecord(result) && typeof result.status === "string" ? result.status : null;
  return { result, exitCode: status === "completed" ? 0 : 2 };
}

/** Programmatic CLI entrypoint used by focused no-network tests. */
export async function runProductTruthRunnerCli(
  argv: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const stdout = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const options = parseProductTruthRunnerArguments(argv);
    const execution = await executeCommand(options, {
      cwd: runtime.cwd ?? process.cwd(),
      env: runtime.env ?? process.env,
      now: runtime.now ?? (() => new Date().toISOString()),
    });
    if (typeof execution.result === "string") stdout(`${execution.result}\n`);
    else stdout(renderProductTruthOperationalJson(execution.result));
    return execution.exitCode;
  } catch (error) {
    const code = errorCode(error);
    const exitCode = error instanceof ProductTruthRunnerCliError ? error.exitCode : 1;
    stderr(renderProductTruthOperationalJson({
      ok: false,
      error: { code, message: errorMessage(error) },
      ...(exitCode === 64 ? { usage: productTruthRunnerUsage() } : {}),
    }));
    return exitCode;
  }
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (invokedAsScript) {
  runProductTruthRunnerCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(renderProductTruthOperationalJson({
      ok: false,
      error: { code: "CLI_FATAL", message: errorMessage(error) },
    }));
    process.exitCode = 1;
  });
}
