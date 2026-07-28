import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createClient,
  type Client,
  type InStatement,
  type ResultSet,
  type Transaction,
} from "@libsql/client";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const MIGRATION_NAME = "20260719003000_walmart_publish_lifecycle_safety";
const DEFAULT_MIGRATION_PATH = resolve(
  PROJECT_ROOT,
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql",
);

const PLAN_VERSION = "walmart-new-sku-schema-activation-plan/3" as const;
const APPROVAL_VERSION = "walmart-new-sku-schema-activation-approval/3" as const;
const REPORT_VERSION = "walmart-new-sku-schema-activation-report/3" as const;
const PREFLIGHT_VERSION = "walmart-new-sku-schema-activation-preflight/3" as const;
const CONFIRMATION_PREFIX = "APPLY_WALMART_NEW_SKU_SCHEMA_ACTIVATION_V3";

const RECEIPT_TABLE = "WalmartNewSkuSchemaActivationReceipt";
const RECEIPT_UPDATE_GUARD = "WalmartNewSkuSchemaActivationReceipt_no_update";
const RECEIPT_DELETE_GUARD = "WalmartNewSkuSchemaActivationReceipt_no_delete";

const REQUIRED_PRISMA_HISTORY_COLUMNS = [
  "id",
  "checksum",
  "finished_at",
  "migration_name",
  "logs",
  "rolled_back_at",
  "started_at",
  "applied_steps_count",
] as const;

const REQUIRED_MIGRATION_TABLES = [
  "MarketplaceSubmissionAttempt",
  "WalmartBuyerPublicationEvidence",
] as const;

const REQUIRED_MIGRATION_INDEXES = [
  "UPCPool_reserved_for_id_key",
  "MarketplaceSubmissionAttempt_idempotency_key_key",
  "MarketplaceSubmissionAttempt_active_key_key",
  "MarketplaceSubmissionAttempt_claim_token_key",
  "MarketplaceSubmissionAttempt_pilot_permit_sha256_key",
  "MarketplaceSubmissionAttempt_pilot_permit_id_key",
  "MarketplaceSubmissionAttempt_owner_signature_sha256_key",
  "MarketplaceSubmissionAttempt_pilot_slot_key",
  "MarketplaceSubmissionAttempt_channel_sku_id_state_idx",
  "MarketplaceSubmissionAttempt_state_retry_after_idx",
  "MarketplaceSubmissionAttempt_marketplace_submission_id_idx",
  "WalmartBuyerPublicationEvidence_evidence_hash_key",
  "WalmartBuyerPublicationEvidence_channel_sku_id_captured_at_idx",
  "WalmartBuyerPublicationEvidence_submission_attempt_id_captured_at_idx",
  "WalmartBuyerPublicationEvidence_sku_item_captured_at_idx",
] as const;

const REQUIRED_MIGRATION_TRIGGERS = [
  "MarketplaceSubmissionAttempt_active_insert_guard",
  "MarketplaceSubmissionAttempt_active_update_guard",
  "MarketplaceSubmissionAttempt_identity_immutable",
  "MarketplaceSubmissionAttempt_no_delete",
  "MarketplaceSubmissionAttempt_pilot_global_cap",
  "WalmartBuyerPublicationEvidence_attempt_sku_guard",
  "WalmartBuyerPublicationEvidence_no_update",
  "WalmartBuyerPublicationEvidence_no_delete",
] as const;

const REQUIRED_MIGRATION_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  MarketplaceSubmissionAttempt: [
    "id",
    "channel_sku_id",
    "marketplace",
    "idempotency_key",
    "active_key",
    "pilot_permit_sha256",
    "pilot_permit_id",
    "owner_key_id",
    "owner_signature_sha256",
    "pilot_slot",
    "pilot_approval_sha256",
    "certification_sha256",
    "seller_account_fingerprint_sha256",
    "payload_hash",
    "claim_token",
    "state",
    "request_count",
    "recovery_count",
    "marketplace_submission_id",
    "marketplace_disposition",
    "error_json",
    "claimed_at",
    "requested_at",
    "accepted_at",
    "terminal_at",
    "retry_after",
    "created_at",
    "updated_at",
  ],
  WalmartBuyerPublicationEvidence: [
    "id",
    "channel_sku_id",
    "submission_attempt_id",
    "sku",
    "walmart_item_id",
    "source_url",
    "source_kind",
    "captured_at",
    "exact_sku_match",
    "exact_item_id_match",
    "published",
    "buyable",
    "evidence_hash",
    "raw_evidence",
    "created_at",
  ],
} as const;

export const WALMART_SCHEMA_ACTIVATION_CLAIMS = Object.freeze({
  schemaOnly: true,
  performsBackfill: false,
  callsProviderApis: false,
  callsWalmartApis: false,
  publishesListings: false,
  delistsListings: false,
  repricesListings: false,
  purchasesInventory: false,
});

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface SqlExecutor {
  execute(statement: InStatement): Promise<ResultSet>;
}

interface DatabaseTarget {
  kind: "local" | "remote";
  clientUrl: string;
  displayUrl: string;
  fingerprint: string;
}

interface MigrationContract {
  path: string;
  relativePath: string;
  name: typeof MIGRATION_NAME;
  sha256: string;
  sql: string;
  tables: string[];
  indexes: string[];
  triggers: string[];
  columns: Record<string, string[]>;
}

interface CanonicalSchemaSnapshot {
  contractVersion: "sqlite-schema-snapshot/1";
  objects: Array<Record<string, JsonValue>>;
  tables: Array<{
    name: string;
    columns: Array<Record<string, JsonValue>>;
    foreignKeys: Array<Record<string, JsonValue>>;
    indexes: Array<{
      metadata: Record<string, JsonValue>;
      columns: Array<Record<string, JsonValue>>;
    }>;
  }>;
}

export interface WalmartSchemaActivationPreflight {
  contractVersion: typeof PREFLIGHT_VERSION;
  targetFingerprint: string;
  migrationName: typeof MIGRATION_NAME;
  migrationSha256: string;
  schemaSha256: string;
  duplicateNonNullUpcReservationCount: number | null;
  prerequisites: {
    required: string[];
    missing: string[];
  };
  artifacts: {
    state: "pending" | "partial" | "applied";
    expected: string[];
    present: string[];
    missing: string[];
  };
  prismaHistory: {
    state: "absent" | "clear" | "existing" | "incompatible";
    schemaMissing: string[];
    matchingRows: Array<Record<string, JsonValue>>;
  };
  activationReceipt: {
    state: "absent" | "ledger_only" | "existing" | "invalid";
    schemaMissing: string[];
    matchingRows: Array<Record<string, JsonValue>>;
  };
  eligibleForApply: boolean;
  blockers: string[];
}

export interface WalmartSchemaActivationPlan {
  contractVersion: typeof PLAN_VERSION;
  command: "plan";
  createdAt: string;
  expiresAt: string;
  environment: string;
  database: {
    kind: "local" | "remote";
    displayUrl: string;
    targetFingerprint: string;
    authTokenEnvName: string | null;
  };
  migration: {
    name: typeof MIGRATION_NAME;
    relativePath: string;
    sha256: string;
    tables: string[];
    indexes: string[];
    triggers: string[];
    columns: Record<string, string[]>;
  };
  schemaSha256: string;
  preflightSha256: string;
  preflight: WalmartSchemaActivationPreflight;
  claims: typeof WALMART_SCHEMA_ACTIVATION_CLAIMS;
  eligibleForApply: boolean;
  blockers: string[];
}

export interface WalmartSchemaActivationApproval {
  contractVersion: typeof APPROVAL_VERSION;
  decision: "APPROVE";
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  planSha256: string;
  migrationSha256: string;
  targetFingerprint: string;
  schemaSha256: string;
  preflightSha256: string;
  environment: string;
  claims: typeof WALMART_SCHEMA_ACTIVATION_CLAIMS;
}

export interface WalmartSchemaActivationReport {
  contractVersion: typeof REPORT_VERSION;
  status: "applied";
  appliedAt: string;
  environment: string;
  targetFingerprint: string;
  planSha256: string;
  approvalSha256: string;
  migrationName: typeof MIGRATION_NAME;
  migrationSha256: string;
  preflightSha256: string;
  schemaSha256Before: string;
  schemaSha256After: string;
  prismaMigrationId: string;
  receiptId: string;
  claims: typeof WALMART_SCHEMA_ACTIVATION_CLAIMS;
}

export class WalmartSchemaActivationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartSchemaActivationError";
    this.code = code;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value as JsonPrimitive;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WalmartSchemaActivationError("CANONICAL_JSON_INVALID", "non-finite number");
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = jsonValue(child);
    }
    return output;
  }
  throw new WalmartSchemaActivationError(
    "CANONICAL_JSON_INVALID",
    `unsupported value type ${typeof value}`,
  );
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(jsonValue(value), null, 2)}\n`;
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowToCanonicalRecord(row: Record<string, unknown>): Record<string, JsonValue> {
  return jsonValue(row) as Record<string, JsonValue>;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*(?:\n|$)/g, "\n");
}

function allSqlNames(sql: string, pattern: RegExp): string[] {
  return Array.from(sql.matchAll(pattern), (match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value))
    .sort();
}

function createTableColumns(sql: string): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  const pattern = /CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1] ?? match[2];
    if (!table || match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let close = -1;
    for (let index = open; index < sql.length; index += 1) {
      const character = sql[index];
      const next = sql[index + 1];
      if (quote) {
        if (character === quote && next === quote) index += 1;
        else if (character === quote) quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) {
      throw new WalmartSchemaActivationError(
        "MIGRATION_SQL_PARSE_FAILED",
        `${table} has an unclosed CREATE TABLE body`,
      );
    }
    const body = sql.slice(open + 1, close);
    const segments: string[] = [];
    let start = 0;
    depth = 0;
    quote = null;
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index];
      const next = body[index + 1];
      if (quote) {
        if (character === quote && next === quote) index += 1;
        else if (character === quote) quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        segments.push(body.slice(start, index));
        start = index + 1;
      }
    }
    segments.push(body.slice(start));
    output[table] = segments.flatMap((segment) => {
      const column = segment.trim().match(/^"([^"]+)"/)?.[1];
      return column ? [column] : [];
    }).sort();
  }
  return output;
}

function assertContainsEvery(
  category: string,
  actual: readonly string[],
  required: readonly string[],
): void {
  const actualSet = new Set(actual);
  const missing = required.filter((value) => !actualSet.has(value));
  if (missing.length > 0) {
    throw new WalmartSchemaActivationError(
      "MIGRATION_CONTRACT_INCOMPLETE",
      `${category} missing from migration SQL: ${missing.join(", ")}`,
    );
  }
}

async function loadMigration(path = DEFAULT_MIGRATION_PATH): Promise<MigrationContract> {
  const absolutePath = resolve(path);
  let sql: string;
  try {
    sql = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new WalmartSchemaActivationError(
      "MIGRATION_FILE_UNREADABLE",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!sql.trim()) {
    throw new WalmartSchemaActivationError("MIGRATION_FILE_EMPTY", absolutePath);
  }
  const executable = stripSqlComments(sql);
  const forbidden = executable.match(
    /\b(?:DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH|COMMIT|ROLLBACK)\b|\bBEGIN\s+(?:TRANSACTION|IMMEDIATE|EXCLUSIVE|DEFERRED)\b|\b(?:INSERT|REPLACE)\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+SET\b/i,
  );
  if (forbidden) {
    throw new WalmartSchemaActivationError(
      "MIGRATION_SQL_FORBIDDEN",
      `schema-only migration contains forbidden keyword ${forbidden[0]}`,
    );
  }
  if (/\bIF\s+NOT\s+EXISTS\b/i.test(executable)) {
    throw new WalmartSchemaActivationError(
      "MIGRATION_IDEMPOTENT_DDL_FORBIDDEN",
      "migration must expose collisions instead of hiding them",
    );
  }

  const tables = allSqlNames(
    executable,
    /CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const indexes = allSqlNames(
    executable,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const triggers = allSqlNames(
    executable,
    /CREATE\s+TRIGGER\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  );
  const columns = createTableColumns(executable);

  assertContainsEvery("tables", tables, REQUIRED_MIGRATION_TABLES);
  assertContainsEvery("indexes", indexes, REQUIRED_MIGRATION_INDEXES);
  assertContainsEvery("triggers", triggers, REQUIRED_MIGRATION_TRIGGERS);
  for (const [table, required] of Object.entries(REQUIRED_MIGRATION_COLUMNS)) {
    assertContainsEvery(`${table} columns`, columns[table] ?? [], required);
  }

  return {
    path: absolutePath,
    relativePath: "prisma/migrations/20260719003000_walmart_publish_lifecycle_safety/migration.sql",
    name: MIGRATION_NAME,
    sha256: sha256(sql),
    sql,
    tables,
    indexes,
    triggers,
    columns,
  };
}

function normalizeLocalFileUrl(rawUrl: string, cwd: string): string {
  if (rawUrl === "file::memory:" || rawUrl.startsWith("file::memory:?")) {
    throw new WalmartSchemaActivationError(
      "DATABASE_MEMORY_TARGET_FORBIDDEN",
      "schema activation requires a durable database target",
    );
  }
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath) {
    throw new WalmartSchemaActivationError("DATABASE_URL_INVALID", "file URL has no path");
  }
  if (rawPath.startsWith("//")) return new URL(rawUrl).href;
  return pathToFileURL(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)).href;
}

export function resolveWalmartSchemaActivationTarget(
  databaseUrl: string,
  cwd = process.cwd(),
): DatabaseTarget {
  const trimmed = databaseUrl.trim();
  if (!trimmed) {
    throw new WalmartSchemaActivationError(
      "DATABASE_URL_REQUIRED",
      "an explicit --url is required",
    );
  }
  let kind: DatabaseTarget["kind"];
  let clientUrl: string;
  if (trimmed.startsWith("file:")) {
    kind = "local";
    clientUrl = normalizeLocalFileUrl(trimmed, cwd);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new WalmartSchemaActivationError(
        "DATABASE_URL_INVALID",
        "database URL must be an explicit file: or libSQL-compatible URL",
      );
    }
    if (!["libsql:", "https:", "http:", "ws:", "wss:"].includes(parsed.protocol)) {
      throw new WalmartSchemaActivationError(
        "DATABASE_URL_SCHEME_FORBIDDEN",
        `unsupported database URL scheme ${parsed.protocol}`,
      );
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new WalmartSchemaActivationError(
        "DATABASE_URL_SECRET_OR_QUERY_FORBIDDEN",
        "credentials, query parameters and fragments are forbidden in --url",
      );
    }
    kind = "remote";
    clientUrl = parsed.href;
  }
  return {
    kind,
    clientUrl,
    displayUrl: clientUrl,
    fingerprint: canonicalSha256({ kind, clientUrl }),
  };
}

function assertEnvironment(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new WalmartSchemaActivationError(
      "ENVIRONMENT_INVALID",
      "environment must be 1-64 lowercase letters, digits, underscore or hyphen",
    );
  }
}

function resolveAuthToken(input: {
  target: DatabaseTarget;
  allowRemote?: boolean;
  authTokenEnvName?: string;
  env?: NodeJS.ProcessEnv;
}): { authToken?: string; authTokenEnvName: string | null } {
  if (input.target.kind === "local") {
    if (input.allowRemote || input.authTokenEnvName) {
      throw new WalmartSchemaActivationError(
        "LOCAL_DATABASE_REMOTE_FLAGS_FORBIDDEN",
        "local targets must not use remote authorization flags",
      );
    }
    return { authTokenEnvName: null };
  }
  if (input.allowRemote !== true) {
    throw new WalmartSchemaActivationError(
      "REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG",
      "remote inspection/apply requires --allow-remote",
    );
  }
  const envName = input.authTokenEnvName ?? "";
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(envName)) {
    throw new WalmartSchemaActivationError(
      "REMOTE_AUTH_TOKEN_ENV_REQUIRED",
      "remote inspection/apply requires a named --auth-token-env",
    );
  }
  const authToken = (input.env ?? process.env)[envName];
  if (!authToken?.trim()) {
    throw new WalmartSchemaActivationError(
      "REMOTE_AUTH_TOKEN_ENV_EMPTY",
      `the named auth token environment variable ${envName} is empty or absent`,
    );
  }
  return { authToken, authTokenEnvName: envName };
}

function createDatabaseClient(
  target: DatabaseTarget,
  authorization: { authToken?: string },
): Client {
  return createClient({
    url: target.clientUrl,
    ...(authorization.authToken ? { authToken: authorization.authToken } : {}),
  });
}

async function queryCanonicalRows(
  executor: SqlExecutor,
  statement: InStatement,
): Promise<Array<Record<string, JsonValue>>> {
  const result = await executor.execute(statement);
  return result.rows.map((row) => rowToCanonicalRecord(row));
}

async function captureSchema(executor: SqlExecutor): Promise<CanonicalSchemaSnapshot> {
  const objects = await queryCanonicalRows(
    executor,
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     ORDER BY type, name, tbl_name`,
  );
  const tableNames = objects
    .filter((row) => row.type === "table")
    .map((row) => String(row.name))
    .sort();
  const tables: CanonicalSchemaSnapshot["tables"] = [];
  for (const name of tableNames) {
    const columns = await queryCanonicalRows(
      executor,
      `PRAGMA table_xinfo(${quoteIdentifier(name)})`,
    );
    const foreignKeys = await queryCanonicalRows(
      executor,
      `PRAGMA foreign_key_list(${quoteIdentifier(name)})`,
    );
    const indexRows = await queryCanonicalRows(
      executor,
      `PRAGMA index_list(${quoteIdentifier(name)})`,
    );
    const indexes: CanonicalSchemaSnapshot["tables"][number]["indexes"] = [];
    for (const metadata of indexRows.sort((left, right) =>
      String(left.name).localeCompare(String(right.name)))) {
      indexes.push({
        metadata,
        columns: await queryCanonicalRows(
          executor,
          `PRAGMA index_xinfo(${quoteIdentifier(String(metadata.name))})`,
        ),
      });
    }
    tables.push({ name, columns, foreignKeys, indexes });
  }
  return { contractVersion: "sqlite-schema-snapshot/1", objects, tables };
}

function schemaInventory(snapshot: CanonicalSchemaSnapshot): {
  tables: Set<string>;
  indexes: Set<string>;
  triggers: Set<string>;
  columns: Map<string, Set<string>>;
} {
  const tables = new Set<string>();
  const indexes = new Set<string>();
  const triggers = new Set<string>();
  for (const object of snapshot.objects) {
    const type = String(object.type);
    const name = String(object.name);
    if (type === "table") tables.add(name);
    else if (type === "index") indexes.add(name);
    else if (type === "trigger") triggers.add(name);
  }
  const columns = new Map<string, Set<string>>();
  for (const table of snapshot.tables) {
    columns.set(table.name, new Set(table.columns.map((row) => String(row.name))));
  }
  return { tables, indexes, triggers, columns };
}

function migrationArtifacts(migration: MigrationContract): string[] {
  return [
    ...migration.tables.map((name) => `table:${name}`),
    ...migration.indexes.map((name) => `index:${name}`),
    ...migration.triggers.map((name) => `trigger:${name}`),
    ...Object.entries(migration.columns).flatMap(([table, columns]) =>
      columns.map((column) => `column:${table}.${column}`)),
  ].sort();
}

function artifactIsPresent(
  inventory: ReturnType<typeof schemaInventory>,
  artifact: string,
): boolean {
  const [kind, value] = artifact.split(":", 2);
  if (kind === "table") return inventory.tables.has(value);
  if (kind === "index") return inventory.indexes.has(value);
  if (kind === "trigger") return inventory.triggers.has(value);
  if (kind === "column") {
    const separator = value.indexOf(".");
    return inventory.columns.get(value.slice(0, separator))?.has(value.slice(separator + 1)) === true;
  }
  return false;
}

function requiredPrerequisites(): string[] {
  return [
    "table:UPCPool",
    "column:UPCPool.id",
    "column:UPCPool.reserved_for_id",
    "table:ChannelSKU",
    "column:ChannelSKU.id",
    "table:_prisma_migrations",
    ...REQUIRED_PRISMA_HISTORY_COLUMNS.map((column) =>
      `column:_prisma_migrations.${column}`),
  ].sort();
}

async function inspectPreflight(input: {
  executor: SqlExecutor;
  migration: MigrationContract;
  target: DatabaseTarget;
}): Promise<{
  schema: CanonicalSchemaSnapshot;
  schemaSha256: string;
  preflight: WalmartSchemaActivationPreflight;
  preflightSha256: string;
}> {
  const schema = await captureSchema(input.executor);
  const schemaSha256 = canonicalSha256(schema);
  const inventory = schemaInventory(schema);
  const required = requiredPrerequisites();
  const missingPrerequisites = required.filter((artifact) =>
    !artifactIsPresent(inventory, artifact));
  let duplicateNonNullUpcReservationCount: number | null = null;
  if (
    inventory.tables.has("UPCPool")
    && inventory.columns.get("UPCPool")?.has("reserved_for_id")
  ) {
    const result = await input.executor.execute(
      `SELECT COUNT(*) AS duplicate_groups
       FROM (
         SELECT "reserved_for_id"
         FROM "UPCPool"
         WHERE "reserved_for_id" IS NOT NULL
         GROUP BY "reserved_for_id"
         HAVING COUNT(*) > 1
       )`,
    );
    duplicateNonNullUpcReservationCount = Number(result.rows[0]?.duplicate_groups ?? 0);
  }

  const expected = migrationArtifacts(input.migration);
  const present = expected.filter((artifact) => artifactIsPresent(inventory, artifact));
  const missing = expected.filter((artifact) => !artifactIsPresent(inventory, artifact));
  const artifactState = present.length === 0
    ? "pending"
    : missing.length === 0
      ? "applied"
      : "partial";

  const prismaSchemaMissing = required
    .filter((artifact) => artifact.startsWith("table:_prisma_migrations")
      || artifact.startsWith("column:_prisma_migrations"))
    .filter((artifact) => !artifactIsPresent(inventory, artifact));
  let prismaRows: Array<Record<string, JsonValue>> = [];
  if (prismaSchemaMissing.length === 0) {
    prismaRows = await queryCanonicalRows(input.executor, {
      sql: `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at,
                   started_at, applied_steps_count
            FROM "_prisma_migrations"
            WHERE migration_name = ?
            ORDER BY started_at, id`,
      args: [MIGRATION_NAME],
    });
  }
  let prismaState: WalmartSchemaActivationPreflight["prismaHistory"]["state"];
  if (prismaSchemaMissing.length > 0) prismaState = "incompatible";
  else if (prismaRows.length === 0) prismaState = "clear";
  else {
    const compatible = prismaRows.some((row) =>
      row.checksum === input.migration.sha256
      && row.finished_at !== null
      && row.rolled_back_at === null
      && Number(row.applied_steps_count) === 1);
    prismaState = compatible ? "existing" : "incompatible";
  }

  const receiptArtifacts = [
    `table:${RECEIPT_TABLE}`,
    `trigger:${RECEIPT_UPDATE_GUARD}`,
    `trigger:${RECEIPT_DELETE_GUARD}`,
    ...[
      "id",
      "migration_name",
      "migration_sha256",
      "plan_sha256",
      "approval_sha256",
      "preflight_sha256",
      "target_fingerprint",
      "environment",
      "post_schema_sha256",
      "activated_at",
    ].map((column) => `column:${RECEIPT_TABLE}.${column}`),
  ];
  const receiptPresent = receiptArtifacts.filter((artifact) =>
    artifactIsPresent(inventory, artifact));
  const receiptMissing = receiptArtifacts.filter((artifact) =>
    !artifactIsPresent(inventory, artifact));
  let receiptRows: Array<Record<string, JsonValue>> = [];
  let receiptState: WalmartSchemaActivationPreflight["activationReceipt"]["state"];
  if (receiptPresent.length === 0) receiptState = "absent";
  else if (receiptMissing.length > 0) receiptState = "invalid";
  else {
    receiptRows = await queryCanonicalRows(input.executor, {
      sql: `SELECT id, migration_name, migration_sha256, plan_sha256, approval_sha256,
                   preflight_sha256, target_fingerprint, environment,
                   post_schema_sha256, activated_at
            FROM ${quoteIdentifier(RECEIPT_TABLE)}
            WHERE migration_name = ?
            ORDER BY activated_at, id`,
      args: [MIGRATION_NAME],
    });
    receiptState = receiptRows.length > 0 ? "existing" : "ledger_only";
  }

  const blockers: string[] = [];
  if (missingPrerequisites.length > 0) {
    blockers.push(`MISSING_PREREQUISITES:${missingPrerequisites.join(",")}`);
  }
  if (duplicateNonNullUpcReservationCount === null) {
    blockers.push("UPC_DUPLICATE_COUNT_UNAVAILABLE");
  } else if (duplicateNonNullUpcReservationCount > 0) {
    blockers.push(`DUPLICATE_UPC_RESERVATIONS:${duplicateNonNullUpcReservationCount}`);
  }
  if (artifactState === "partial") blockers.push("MIGRATION_ARTIFACTS_PARTIAL");
  if (artifactState === "applied" && (prismaState !== "existing" || receiptState !== "existing")) {
    blockers.push("MIGRATION_ARTIFACTS_UNTRACKED_APPLIED");
  }
  if (artifactState === "pending" && prismaState !== "clear") {
    blockers.push(`PRISMA_HISTORY_NOT_CLEAR:${prismaState}`);
  }
  if (artifactState === "pending" && receiptState !== "absent") {
    blockers.push(`ACTIVATION_RECEIPT_NOT_CLEAR:${receiptState}`);
  }
  if (artifactState === "applied" && prismaState === "existing" && receiptState === "existing") {
    blockers.push("MIGRATION_ALREADY_ACTIVATED");
  }
  if (artifactState === "partial" || artifactState === "pending") {
    if (prismaState === "existing") blockers.push("PRISMA_HISTORY_WITHOUT_COMPLETE_ACTIVATION");
    if (receiptState === "existing") blockers.push("RECEIPT_WITHOUT_COMPLETE_ACTIVATION");
  }
  if (prismaState === "incompatible") blockers.push("PRISMA_HISTORY_INCOMPATIBLE");
  if (receiptState === "invalid" || receiptState === "ledger_only") {
    blockers.push(`ACTIVATION_RECEIPT_INCOMPATIBLE:${receiptState}`);
  }

  const preflight: WalmartSchemaActivationPreflight = {
    contractVersion: PREFLIGHT_VERSION,
    targetFingerprint: input.target.fingerprint,
    migrationName: MIGRATION_NAME,
    migrationSha256: input.migration.sha256,
    schemaSha256,
    duplicateNonNullUpcReservationCount,
    prerequisites: { required, missing: missingPrerequisites },
    artifacts: {
      state: artifactState,
      expected,
      present,
      missing,
    },
    prismaHistory: {
      state: prismaState,
      schemaMissing: prismaSchemaMissing,
      matchingRows: prismaRows,
    },
    activationReceipt: {
      state: receiptState,
      schemaMissing: receiptMissing,
      matchingRows: receiptRows,
    },
    eligibleForApply: blockers.length === 0 && artifactState === "pending",
    blockers,
  };
  return {
    schema,
    schemaSha256,
    preflight,
    preflightSha256: canonicalSha256(preflight),
  };
}

function parseInstant(label: string, value: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new WalmartSchemaActivationError(
      "TIMESTAMP_INVALID",
      `${label} must be an exact ISO-8601 UTC timestamp`,
    );
  }
  return instant;
}

function assertPlanWindow(createdAt: string, expiresAt: string, now: Date): void {
  const created = parseInstant("createdAt", createdAt);
  const expires = parseInstant("expiresAt", expiresAt);
  if (expires <= created) {
    throw new WalmartSchemaActivationError("PLAN_EXPIRY_INVALID", "expiresAt must follow createdAt");
  }
  if (expires - created > 24 * 60 * 60 * 1_000) {
    throw new WalmartSchemaActivationError(
      "PLAN_EXPIRY_TOO_LONG",
      "schema activation plans may be valid for at most 24 hours",
    );
  }
  if (expires <= now.getTime()) {
    throw new WalmartSchemaActivationError("PLAN_EXPIRED", "schema activation plan has expired");
  }
}

async function assertNewAbsoluteOutputDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WalmartSchemaActivationError(
      "OUTPUT_DIRECTORY_MUST_BE_ABSOLUTE",
      "--out must be an absolute path",
    );
  }
  const output = resolve(path);
  const parent = dirname(output);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch {
    throw new WalmartSchemaActivationError(
      "OUTPUT_PARENT_MISSING",
      `output parent does not exist: ${parent}`,
    );
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new WalmartSchemaActivationError(
      "OUTPUT_PARENT_UNSAFE",
      "output parent must be a real directory, not a symlink",
    );
  }
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    throw new WalmartSchemaActivationError(
      "OUTPUT_DIRECTORY_NOT_NEW",
      error instanceof Error ? error.message : String(error),
    );
  }
  return output;
}

async function writeExclusive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function approvalTemplate(
  plan: WalmartSchemaActivationPlan,
  planSha256: string,
): Record<string, JsonValue> {
  return {
    contractVersion: APPROVAL_VERSION,
    decision: "REPLACE_WITH_APPROVE",
    approvalId: "REPLACE_WITH_OWNER_APPROVAL_ID",
    approvedBy: "REPLACE_WITH_OWNER_IDENTITY",
    approvedAt: "REPLACE_WITH_ISO_UTC_TIMESTAMP",
    expiresAt: plan.expiresAt,
    planSha256,
    migrationSha256: plan.migration.sha256,
    targetFingerprint: plan.database.targetFingerprint,
    schemaSha256: plan.schemaSha256,
    preflightSha256: plan.preflightSha256,
    environment: plan.environment,
    claims: WALMART_SCHEMA_ACTIVATION_CLAIMS,
    instructions: "Copy this template to a separate file; do not edit files in the sealed plan directory.",
  };
}

export async function planWalmartNewSkuSchemaActivation(options: {
  databaseUrl: string;
  environment: string;
  expiresAt: string;
  outputDirectory: string;
  allowRemote?: boolean;
  authTokenEnvName?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  migrationPath?: string;
}): Promise<{
  plan: WalmartSchemaActivationPlan;
  planSha256: string;
  outputDirectory: string;
}> {
  assertEnvironment(options.environment);
  const now = options.now?.() ?? new Date();
  const createdAt = now.toISOString();
  assertPlanWindow(createdAt, options.expiresAt, now);
  const target = resolveWalmartSchemaActivationTarget(options.databaseUrl, options.cwd);
  const authorization = resolveAuthToken({
    target,
    allowRemote: options.allowRemote,
    authTokenEnvName: options.authTokenEnvName,
    env: options.env,
  });
  const migration = await loadMigration(options.migrationPath);
  const client = createDatabaseClient(target, authorization);
  let inspection: Awaited<ReturnType<typeof inspectPreflight>>;
  try {
    inspection = await inspectPreflight({ executor: client, migration, target });
  } finally {
    client.close();
  }
  const plan: WalmartSchemaActivationPlan = {
    contractVersion: PLAN_VERSION,
    command: "plan",
    createdAt,
    expiresAt: options.expiresAt,
    environment: options.environment,
    database: {
      kind: target.kind,
      displayUrl: target.displayUrl,
      targetFingerprint: target.fingerprint,
      authTokenEnvName: authorization.authTokenEnvName,
    },
    migration: {
      name: migration.name,
      relativePath: migration.relativePath,
      sha256: migration.sha256,
      tables: migration.tables,
      indexes: migration.indexes,
      triggers: migration.triggers,
      columns: migration.columns,
    },
    schemaSha256: inspection.schemaSha256,
    preflightSha256: inspection.preflightSha256,
    preflight: inspection.preflight,
    claims: WALMART_SCHEMA_ACTIVATION_CLAIMS,
    eligibleForApply: inspection.preflight.eligibleForApply,
    blockers: inspection.preflight.blockers,
  };
  const planBytes = canonicalJson(plan);
  const planSha256 = sha256(planBytes);
  const outputDirectory = await assertNewAbsoluteOutputDirectory(options.outputDirectory);
  await writeExclusive(resolve(outputDirectory, "plan.json"), planBytes);
  await writeExclusive(resolve(outputDirectory, "plan.sha256"), `${planSha256}\n`);
  await writeExclusive(
    resolve(outputDirectory, "owner-approval.template.json"),
    canonicalJson(approvalTemplate(plan, planSha256)),
  );
  return { plan, planSha256, outputDirectory };
}

async function readCanonicalJsonArtifact<T>(path: string, label: string): Promise<{
  value: T;
  bytes: string;
  sha256: string;
}> {
  const bytes = await readFile(path, "utf8");
  if (Buffer.byteLength(bytes) > 1024 * 1024) {
    throw new WalmartSchemaActivationError("ARTIFACT_TOO_LARGE", `${label} exceeds 1 MiB`);
  }
  let value: T;
  try {
    value = JSON.parse(bytes) as T;
  } catch (error) {
    throw new WalmartSchemaActivationError(
      "ARTIFACT_JSON_INVALID",
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(value) !== bytes) {
    throw new WalmartSchemaActivationError(
      "ARTIFACT_NOT_CANONICAL",
      `${label} bytes are not canonical JSON`,
    );
  }
  return { value, bytes, sha256: sha256(bytes) };
}

function assertExactClaims(value: unknown, label: string): void {
  if (canonicalJson(value) !== canonicalJson(WALMART_SCHEMA_ACTIVATION_CLAIMS)) {
    throw new WalmartSchemaActivationError(
      "NO_MUTATION_CLAIMS_MISMATCH",
      `${label} must retain every schema-only/no-action claim`,
    );
  }
}

function assertHash(label: string, value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new WalmartSchemaActivationError("HASH_INVALID", `${label} must be lowercase SHA-256`);
  }
}

function assertOwnerIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new WalmartSchemaActivationError(
      "OWNER_IDENTIFIER_INVALID",
      `${label} must use 1-128 safe identifier characters`,
    );
  }
}

export function buildWalmartSchemaActivationConfirmation(input: {
  planSha256: string;
  approvalSha256: string;
  targetFingerprint: string;
  environment: string;
}): string {
  assertHash("planSha256", input.planSha256);
  assertHash("approvalSha256", input.approvalSha256);
  assertHash("targetFingerprint", input.targetFingerprint);
  assertEnvironment(input.environment);
  return [
    CONFIRMATION_PREFIX,
    input.planSha256,
    input.approvalSha256,
    input.targetFingerprint,
    input.environment,
  ].join(":");
}

function validatePlan(
  plan: WalmartSchemaActivationPlan,
  planSha256: string,
  target: DatabaseTarget,
  environment: string,
  authTokenEnvName: string | null,
  now: Date,
): void {
  if (plan.contractVersion !== PLAN_VERSION || plan.command !== "plan") {
    throw new WalmartSchemaActivationError("PLAN_CONTRACT_INVALID", "unexpected plan contract");
  }
  assertPlanWindow(plan.createdAt, plan.expiresAt, now);
  assertExactClaims(plan.claims, "plan");
  if (!plan.eligibleForApply || !plan.preflight.eligibleForApply || plan.blockers.length > 0) {
    throw new WalmartSchemaActivationError(
      "PLAN_NOT_ELIGIBLE",
      plan.blockers.join("; ") || "preflight did not authorize apply",
    );
  }
  if (plan.database.targetFingerprint !== target.fingerprint) {
    throw new WalmartSchemaActivationError("TARGET_FINGERPRINT_MISMATCH", "plan target differs");
  }
  if (plan.database.kind !== target.kind || plan.database.displayUrl !== target.displayUrl) {
    throw new WalmartSchemaActivationError("TARGET_IDENTITY_MISMATCH", "plan URL differs");
  }
  if (plan.environment !== environment) {
    throw new WalmartSchemaActivationError("ENVIRONMENT_MISMATCH", "plan environment differs");
  }
  if (plan.database.authTokenEnvName !== authTokenEnvName) {
    throw new WalmartSchemaActivationError(
      "AUTH_TOKEN_ENV_MISMATCH",
      "apply must use the exact named token environment from plan",
    );
  }
  assertHash("planSha256", planSha256);
  if (plan.migration.name !== MIGRATION_NAME) {
    throw new WalmartSchemaActivationError("MIGRATION_NAME_MISMATCH", plan.migration.name);
  }
  if (canonicalSha256(plan.preflight) !== plan.preflightSha256) {
    throw new WalmartSchemaActivationError("PLAN_PREFLIGHT_HASH_MISMATCH", "embedded preflight drift");
  }
  if (plan.preflight.schemaSha256 !== plan.schemaSha256) {
    throw new WalmartSchemaActivationError("PLAN_SCHEMA_HASH_MISMATCH", "embedded schema drift");
  }
}

function validateApproval(input: {
  approval: WalmartSchemaActivationApproval;
  approvalSha256: string;
  plan: WalmartSchemaActivationPlan;
  planSha256: string;
  now: Date;
}): void {
  const { approval, plan } = input;
  if (approval.contractVersion !== APPROVAL_VERSION || approval.decision !== "APPROVE") {
    throw new WalmartSchemaActivationError(
      "OWNER_APPROVAL_DECISION_INVALID",
      "owner approval must explicitly say APPROVE under the V2 contract",
    );
  }
  assertOwnerIdentifier("approvalId", approval.approvalId);
  assertOwnerIdentifier("approvedBy", approval.approvedBy);
  const approvedAt = parseInstant("approvedAt", approval.approvedAt);
  const approvalExpires = parseInstant("approval expiresAt", approval.expiresAt);
  const planCreated = parseInstant("plan createdAt", plan.createdAt);
  const planExpires = parseInstant("plan expiresAt", plan.expiresAt);
  if (approvedAt < planCreated || approvedAt > input.now.getTime() + 5 * 60 * 1_000) {
    throw new WalmartSchemaActivationError(
      "OWNER_APPROVAL_TIME_INVALID",
      "approval must follow plan creation and cannot be materially future-dated",
    );
  }
  if (approvalExpires <= input.now.getTime() || approvalExpires > planExpires) {
    throw new WalmartSchemaActivationError(
      "OWNER_APPROVAL_EXPIRED_OR_TOO_LONG",
      "approval must be current and cannot outlive the plan",
    );
  }
  const exactBindings: Array<[string, string, string]> = [
    ["planSha256", approval.planSha256, input.planSha256],
    ["migrationSha256", approval.migrationSha256, plan.migration.sha256],
    ["targetFingerprint", approval.targetFingerprint, plan.database.targetFingerprint],
    ["schemaSha256", approval.schemaSha256, plan.schemaSha256],
    ["preflightSha256", approval.preflightSha256, plan.preflightSha256],
    ["environment", approval.environment, plan.environment],
  ];
  const mismatches = exactBindings.filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    throw new WalmartSchemaActivationError(
      "OWNER_APPROVAL_BINDING_MISMATCH",
      mismatches.map(([label]) => label).join(", "),
    );
  }
  assertExactClaims(approval.claims, "approval");
  assertHash("approvalSha256", input.approvalSha256);
}

const RECEIPT_SCHEMA_SQL = `
CREATE TABLE "${RECEIPT_TABLE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "migration_name" TEXT NOT NULL UNIQUE,
  "migration_sha256" TEXT NOT NULL CHECK (length("migration_sha256") = 64),
  "plan_sha256" TEXT NOT NULL CHECK (length("plan_sha256") = 64),
  "approval_sha256" TEXT NOT NULL CHECK (length("approval_sha256") = 64),
  "preflight_sha256" TEXT NOT NULL CHECK (length("preflight_sha256") = 64),
  "target_fingerprint" TEXT NOT NULL CHECK (length("target_fingerprint") = 64),
  "environment" TEXT NOT NULL,
  "post_schema_sha256" TEXT NOT NULL CHECK (length("post_schema_sha256") = 64),
  "activated_at" DATETIME NOT NULL
);
CREATE TRIGGER "${RECEIPT_UPDATE_GUARD}"
BEFORE UPDATE ON "${RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'WALMART_SCHEMA_ACTIVATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER "${RECEIPT_DELETE_GUARD}"
BEFORE DELETE ON "${RECEIPT_TABLE}"
BEGIN
  SELECT RAISE(ABORT, 'WALMART_SCHEMA_ACTIVATION_RECEIPT_IMMUTABLE');
END;
`;

async function verifyMigrationArtifacts(
  executor: SqlExecutor,
  migration: MigrationContract,
): Promise<void> {
  const inventory = schemaInventory(await captureSchema(executor));
  const missing = migrationArtifacts(migration).filter((artifact) =>
    !artifactIsPresent(inventory, artifact));
  if (missing.length > 0) {
    throw new WalmartSchemaActivationError(
      "MIGRATION_POSTCONDITION_FAILED",
      `missing artifacts: ${missing.join(", ")}`,
    );
  }
}

async function verifyHistoryAndReceipt(input: {
  executor: SqlExecutor;
  prismaMigrationId: string;
  receiptId: string;
  migration: MigrationContract;
  planSha256: string;
  approvalSha256: string;
}): Promise<void> {
  const history = await input.executor.execute({
    sql: `SELECT id, checksum, finished_at, rolled_back_at, applied_steps_count
          FROM "_prisma_migrations" WHERE migration_name = ?`,
    args: [MIGRATION_NAME],
  });
  if (history.rows.length !== 1) {
    throw new WalmartSchemaActivationError(
      "PRISMA_HISTORY_REGISTRATION_FAILED",
      `expected one migration row, found ${history.rows.length}`,
    );
  }
  const historyRow = history.rows[0];
  if (
    String(historyRow.id) !== input.prismaMigrationId
    || String(historyRow.checksum) !== input.migration.sha256
    || historyRow.finished_at === null
    || historyRow.rolled_back_at !== null
    || Number(historyRow.applied_steps_count) !== 1
  ) {
    throw new WalmartSchemaActivationError(
      "PRISMA_HISTORY_REGISTRATION_FAILED",
      "registered migration row is not Prisma-compatible",
    );
  }
  const receipt = await input.executor.execute({
    sql: `SELECT id, migration_sha256, plan_sha256, approval_sha256
          FROM ${quoteIdentifier(RECEIPT_TABLE)} WHERE migration_name = ?`,
    args: [MIGRATION_NAME],
  });
  const receiptRow = receipt.rows[0];
  if (
    receipt.rows.length !== 1
    || String(receiptRow?.id) !== input.receiptId
    || String(receiptRow?.migration_sha256) !== input.migration.sha256
    || String(receiptRow?.plan_sha256) !== input.planSha256
    || String(receiptRow?.approval_sha256) !== input.approvalSha256
  ) {
    throw new WalmartSchemaActivationError(
      "ACTIVATION_RECEIPT_REGISTRATION_FAILED",
      "immutable receipt does not match the sealed activation",
    );
  }
}

export async function applyWalmartNewSkuSchemaActivation(options: {
  planPath: string;
  planShaPath: string;
  approvalPath: string;
  confirmation: string;
  databaseUrl: string;
  environment: string;
  outputDirectory: string;
  allowRemote?: boolean;
  authTokenEnvName?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  migrationPath?: string;
  testHooks?: {
    afterMigrationSql?: (transaction: Transaction) => Promise<void>;
  };
}): Promise<{
  report: WalmartSchemaActivationReport;
  reportSha256: string;
  outputDirectory: string;
}> {
  assertEnvironment(options.environment);
  const target = resolveWalmartSchemaActivationTarget(options.databaseUrl, options.cwd);
  const authorization = resolveAuthToken({
    target,
    allowRemote: options.allowRemote,
    authTokenEnvName: options.authTokenEnvName,
    env: options.env,
  });
  const planPath = resolve(options.planPath);
  const planShaPath = resolve(options.planShaPath);
  if (dirname(planPath) !== dirname(planShaPath)
      || planPath !== resolve(dirname(planPath), "plan.json")
      || planShaPath !== resolve(dirname(planPath), "plan.sha256")) {
    throw new WalmartSchemaActivationError(
      "PLAN_ARTIFACT_PAIR_INVALID",
      "plan and sidecar must be the exact sibling plan.json/plan.sha256 pair",
    );
  }
  if (dirname(resolve(options.approvalPath)) === dirname(planPath)) {
    throw new WalmartSchemaActivationError(
      "OWNER_APPROVAL_NOT_SEPARATE",
      "owner approval must be a separately supplied artifact outside the sealed plan directory",
    );
  }
  const outerPlanArtifact = await readCanonicalJsonArtifact<WalmartSchemaActivationPlan>(
    planPath,
    "plan.json",
  );
  const sidecar = await readFile(planShaPath, "utf8");
  if (sidecar !== `${outerPlanArtifact.sha256}\n`) {
    throw new WalmartSchemaActivationError(
      "PLAN_SHA_SIDECAR_MISMATCH",
      "plan.sha256 does not match exact canonical plan bytes",
    );
  }
  const outerApprovalArtifact = await readCanonicalJsonArtifact<WalmartSchemaActivationApproval>(
    resolve(options.approvalPath),
    "owner approval",
  );
  const outerNow = options.now?.() ?? new Date();
  validatePlan(
    outerPlanArtifact.value,
    outerPlanArtifact.sha256,
    target,
    options.environment,
    authorization.authTokenEnvName,
    outerNow,
  );
  validateApproval({
    approval: outerApprovalArtifact.value,
    approvalSha256: outerApprovalArtifact.sha256,
    plan: outerPlanArtifact.value,
    planSha256: outerPlanArtifact.sha256,
    now: outerNow,
  });
  const expectedConfirmation = buildWalmartSchemaActivationConfirmation({
    planSha256: outerPlanArtifact.sha256,
    approvalSha256: outerApprovalArtifact.sha256,
    targetFingerprint: target.fingerprint,
    environment: options.environment,
  });
  if (options.confirmation !== expectedConfirmation) {
    throw new WalmartSchemaActivationError(
      "V3_CONFIRMATION_MISMATCH",
      "confirmation does not bind the exact plan, approval, target and environment",
    );
  }

  const outputDirectory = await assertNewAbsoluteOutputDirectory(options.outputDirectory);
  const client = createDatabaseClient(target, authorization);
  let report: WalmartSchemaActivationReport;
  try {
    const transaction = await client.transaction("write");
    try {
      const innerNow = options.now?.() ?? new Date();
      const innerPlanArtifact = await readCanonicalJsonArtifact<WalmartSchemaActivationPlan>(
        planPath,
        "plan.json",
      );
      const innerSidecar = await readFile(planShaPath, "utf8");
      const innerApprovalArtifact = await readCanonicalJsonArtifact<WalmartSchemaActivationApproval>(
        resolve(options.approvalPath),
        "owner approval",
      );
      if (
        innerPlanArtifact.sha256 !== outerPlanArtifact.sha256
        || innerPlanArtifact.bytes !== outerPlanArtifact.bytes
        || innerSidecar !== `${innerPlanArtifact.sha256}\n`
        || innerApprovalArtifact.sha256 !== outerApprovalArtifact.sha256
        || innerApprovalArtifact.bytes !== outerApprovalArtifact.bytes
      ) {
        throw new WalmartSchemaActivationError(
          "ARTIFACT_TOCTOU_DETECTED",
          "sealed artifacts changed after initial validation",
        );
      }
      validatePlan(
        innerPlanArtifact.value,
        innerPlanArtifact.sha256,
        target,
        options.environment,
        authorization.authTokenEnvName,
        innerNow,
      );
      validateApproval({
        approval: innerApprovalArtifact.value,
        approvalSha256: innerApprovalArtifact.sha256,
        plan: innerPlanArtifact.value,
        planSha256: innerPlanArtifact.sha256,
        now: innerNow,
      });

      const migration = await loadMigration(options.migrationPath);
      const reboundTarget = resolveWalmartSchemaActivationTarget(options.databaseUrl, options.cwd);
      if (
        migration.sha256 !== innerPlanArtifact.value.migration.sha256
        || reboundTarget.fingerprint !== innerPlanArtifact.value.database.targetFingerprint
        || reboundTarget.clientUrl !== target.clientUrl
      ) {
        throw new WalmartSchemaActivationError(
          "MIGRATION_OR_TARGET_DRIFT",
          "migration bytes or exact database target changed after owner approval",
        );
      }
      const current = await inspectPreflight({ executor: transaction, migration, target: reboundTarget });
      if ((current.preflight.duplicateNonNullUpcReservationCount ?? 0) > 0) {
        throw new WalmartSchemaActivationError(
          "DUPLICATE_UPC_RESERVATIONS",
          String(current.preflight.duplicateNonNullUpcReservationCount),
        );
      }
      if (
        current.schemaSha256 !== innerPlanArtifact.value.schemaSha256
        || current.preflightSha256 !== innerPlanArtifact.value.preflightSha256
      ) {
        throw new WalmartSchemaActivationError(
          "SCHEMA_PREFLIGHT_DRIFT",
          "schema or safety preflight changed after sealed plan creation",
        );
      }
      if (!current.preflight.eligibleForApply || current.preflight.artifacts.state !== "pending") {
        throw new WalmartSchemaActivationError(
          "APPLY_PREFLIGHT_BLOCKED",
          current.preflight.blockers.join("; ") || current.preflight.artifacts.state,
        );
      }

      await transaction.executeMultiple(migration.sql);
      await verifyMigrationArtifacts(transaction, migration);
      if (options.testHooks?.afterMigrationSql) {
        await options.testHooks.afterMigrationSql(transaction);
      }
      await transaction.executeMultiple(RECEIPT_SCHEMA_SQL);
      const schemaAfter = await captureSchema(transaction);
      const schemaSha256After = canonicalSha256(schemaAfter);
      const appliedAt = innerNow.toISOString();
      const receiptId = randomUUID();
      const prismaMigrationId = randomUUID();
      await transaction.execute({
        sql: `INSERT INTO ${quoteIdentifier(RECEIPT_TABLE)} (
                id, migration_name, migration_sha256, plan_sha256, approval_sha256,
                preflight_sha256, target_fingerprint, environment,
                post_schema_sha256, activated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          receiptId,
          MIGRATION_NAME,
          migration.sha256,
          innerPlanArtifact.sha256,
          innerApprovalArtifact.sha256,
          current.preflightSha256,
          reboundTarget.fingerprint,
          options.environment,
          schemaSha256After,
          appliedAt,
        ],
      });
      await transaction.execute({
        sql: `INSERT INTO "_prisma_migrations" (
                id, checksum, finished_at, migration_name, logs,
                rolled_back_at, started_at, applied_steps_count
              ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
        args: [prismaMigrationId, migration.sha256, appliedAt, MIGRATION_NAME, appliedAt],
      });
      await verifyMigrationArtifacts(transaction, migration);
      await verifyHistoryAndReceipt({
        executor: transaction,
        prismaMigrationId,
        receiptId,
        migration,
        planSha256: innerPlanArtifact.sha256,
        approvalSha256: innerApprovalArtifact.sha256,
      });
      report = {
        contractVersion: REPORT_VERSION,
        status: "applied",
        appliedAt,
        environment: options.environment,
        targetFingerprint: reboundTarget.fingerprint,
        planSha256: innerPlanArtifact.sha256,
        approvalSha256: innerApprovalArtifact.sha256,
        migrationName: MIGRATION_NAME,
        migrationSha256: migration.sha256,
        preflightSha256: current.preflightSha256,
        schemaSha256Before: current.schemaSha256,
        schemaSha256After,
        prismaMigrationId,
        receiptId,
        claims: WALMART_SCHEMA_ACTIVATION_CLAIMS,
      };
      await transaction.commit();
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    } finally {
      if (!transaction.closed) transaction.close();
    }
  } finally {
    client.close();
  }

  const reportBytes = canonicalJson(report);
  const reportSha256 = sha256(reportBytes);
  await writeExclusive(resolve(outputDirectory, "report.json"), reportBytes);
  await writeExclusive(resolve(outputDirectory, "report.sha256"), `${reportSha256}\n`);
  return { report, reportSha256, outputDirectory };
}

type CliOptions = {
  command?: "plan" | "apply";
  databaseUrl?: string;
  environment?: string;
  expiresAt?: string;
  outputDirectory?: string;
  allowRemote: boolean;
  authTokenEnvName?: string;
  planPath?: string;
  planShaPath?: string;
  approvalPath?: string;
  confirmation?: string;
  help: boolean;
};

export function parseWalmartSchemaActivationCli(argv: readonly string[]): CliOptions {
  const result: CliOptions = { allowRemote: false, help: false };
  if (argv[0] === "plan" || argv[0] === "apply") result.command = argv[0];
  else if (argv[0] === "--help" || argv[0] === "-h") return { ...result, help: true };
  else {
    throw new WalmartSchemaActivationError(
      "CLI_COMMAND_REQUIRED",
      "first argument must be plan or apply",
    );
  }
  const values = new Map<string, keyof CliOptions>([
    ["--url", "databaseUrl"],
    ["--environment", "environment"],
    ["--expires-at", "expiresAt"],
    ["--out", "outputDirectory"],
    ["--auth-token-env", "authTokenEnvName"],
    ["--plan", "planPath"],
    ["--plan-sha", "planShaPath"],
    ["--approval", "approvalPath"],
    ["--confirm", "confirmation"],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-remote") result.allowRemote = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else {
      const separator = argument.indexOf("=");
      const flag = separator < 0 ? argument : argument.slice(0, separator);
      const property = values.get(flag);
      if (!property) {
        throw new WalmartSchemaActivationError("CLI_ARGUMENT_UNKNOWN", `unknown ${argument}`);
      }
      const value = separator < 0 ? argv[index + 1] : argument.slice(separator + 1);
      if (separator < 0) index += 1;
      if (!value || value.startsWith("--")) {
        throw new WalmartSchemaActivationError(
          "CLI_ARGUMENT_VALUE_REQUIRED",
          `${flag} requires a value`,
        );
      }
      (result as Record<string, unknown>)[property] = value;
    }
  }
  return result;
}

function requireCliValue(options: CliOptions, property: keyof CliOptions, flag: string): string {
  const value = options[property];
  if (typeof value !== "string" || !value) {
    throw new WalmartSchemaActivationError("CLI_ARGUMENT_REQUIRED", `${flag} is required`);
  }
  return value;
}

export function walmartNewSkuSchemaActivationUsage(): string {
  return [
    "Walmart new-SKU lifecycle schema activation (owner/Codex only)",
    "",
    "Read-only database plan:",
    "  npm run walmart:new-sku:schema -- plan --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --expires-at 2026-07-19T04:00:00.000Z",
    "    --out /ABSOLUTE/new-plan-directory",
    "",
    "Sealed apply:",
    "  npm run walmart:new-sku:schema -- apply --plan /ABSOLUTE/plan/plan.json",
    "    --plan-sha /ABSOLUTE/plan/plan.sha256 --approval /ABSOLUTE/owner-approval.json",
    "    --confirm EXACT_V3_CONFIRMATION --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --out /ABSOLUTE/new-report-directory",
    "",
    "Remote plan/apply also require --allow-remote --auth-token-env NAME.",
    "Raw auth tokens are never accepted. This command performs schema work only.",
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseWalmartSchemaActivationCli(argv);
  if (options.help) {
    console.log(walmartNewSkuSchemaActivationUsage());
    return;
  }
  const databaseUrl = requireCliValue(options, "databaseUrl", "--url");
  const environment = requireCliValue(options, "environment", "--environment");
  const outputDirectory = requireCliValue(options, "outputDirectory", "--out");
  if (options.command === "plan") {
    const result = await planWalmartNewSkuSchemaActivation({
      databaseUrl,
      environment,
      expiresAt: requireCliValue(options, "expiresAt", "--expires-at"),
      outputDirectory,
      allowRemote: options.allowRemote,
      authTokenEnvName: options.authTokenEnvName,
    });
    console.log(canonicalJson({
      status: "planned",
      eligibleForApply: result.plan.eligibleForApply,
      blockers: result.plan.blockers,
      planSha256: result.planSha256,
      outputDirectory: result.outputDirectory,
    }).trimEnd());
    return;
  }
  const result = await applyWalmartNewSkuSchemaActivation({
    planPath: requireCliValue(options, "planPath", "--plan"),
    planShaPath: requireCliValue(options, "planShaPath", "--plan-sha"),
    approvalPath: requireCliValue(options, "approvalPath", "--approval"),
    confirmation: requireCliValue(options, "confirmation", "--confirm"),
    databaseUrl,
    environment,
    outputDirectory,
    allowRemote: options.allowRemote,
    authTokenEnvName: options.authTokenEnvName,
  });
  console.log(canonicalJson({
    status: result.report.status,
    reportSha256: result.reportSha256,
    outputDirectory: result.outputDirectory,
  }).trimEnd());
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof WalmartSchemaActivationError ? 64 : 1;
  });
}
