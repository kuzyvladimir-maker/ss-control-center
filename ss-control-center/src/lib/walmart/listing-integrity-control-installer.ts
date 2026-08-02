import { createHash, randomUUID } from "node:crypto";

export const WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_NAME =
  "20260801172000_walmart_listing_integrity_control_plane_stage_a" as const;

const REQUIRED_OBJECTS = Object.freeze([
  "WalmartListingIntegrityControlRun",
  "WalmartListingIntegrityControlItem",
  "WalmartListingIntegrityControlEvent",
  "WalmartListingIntegrityControlArtifact",
  "WalmartListingIntegrityControlRun_single_active_key",
  "WalmartListingIntegrityControlItem_transition_guard",
  "WalmartListingIntegrityControlItem_revision_guard",
  "WalmartListingIntegrityControlItem_strict_sequence_guard",
  "WalmartListingIntegrityControlItem_single_apply_insert_guard",
  "WalmartListingIntegrityControlItem_single_apply_update_guard",
  "WalmartListingIntegrityControlEvent_chain_guard",
  "WalmartListingIntegrityControlEvent_update_guard",
  "WalmartListingIntegrityControlEvent_delete_guard",
  "WalmartListingIntegrityControlArtifact_update_guard",
  "WalmartListingIntegrityControlArtifact_delete_guard",
]);

interface SqlResult {
  rows: Array<Record<string, unknown>>;
}

export interface WalmartListingIntegrityMigrationClient {
  execute(statement: string | { sql: string; args: unknown[] }): Promise<SqlResult>;
  executeMultiple(sql: string): Promise<unknown>;
}

export interface WalmartListingIntegrityControlMigrationInspection {
  status: "NOT_INSTALLED" | "INSTALLED" | "PARTIAL_FAIL_CLOSED";
  migration_name: typeof WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_NAME;
  migration_sha256: string;
  present_objects: string[];
  missing_objects: string[];
  migration_record_present: boolean;
  migration_record_checksum_matches: boolean;
  runtime_stage_after_install: "OFF";
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertExactStageAMigration(sql: string) {
  const requiredSnippets = [
    "CREATE TABLE \"WalmartListingIntegrityControlRun\"",
    "CREATE TABLE \"WalmartListingIntegrityControlItem\"",
    "CREATE TABLE \"WalmartListingIntegrityControlEvent\"",
    "CREATE TABLE \"WalmartListingIntegrityControlArtifact\"",
    "CHECK (\"runtimeStage\" = 'OFF')",
    "WalmartListingIntegrityControlRun_single_active_key",
    "WalmartListingIntegrityControlItem_single_apply_update_guard",
    "WalmartListingIntegrityControlEvent_chain_guard",
  ];
  if (requiredSnippets.some((snippet) => !sql.includes(snippet))
    || /\bDROP\s+(?:TABLE|INDEX|TRIGGER)\b/iu.test(sql)
    || /\bDELETE\s+FROM\b/iu.test(sql)
    || /\bINSERT\s+INTO\b/iu.test(sql)) {
    throw new Error(
      "WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_INVALID: exact additive Stage A SQL required",
    );
  }
}

export async function inspectWalmartListingIntegrityControlMigration(input: {
  client: WalmartListingIntegrityMigrationClient;
  migration_sql: string;
}): Promise<WalmartListingIntegrityControlMigrationInspection> {
  assertExactStageAMigration(input.migration_sql);
  const migrationSha256 = sha256(input.migration_sql);
  const objects = await input.client.execute({
    sql: `SELECT name FROM sqlite_schema WHERE name IN (${REQUIRED_OBJECTS.map(() => "?").join(",")})`,
    args: [...REQUIRED_OBJECTS],
  });
  const presentObjects = objects.rows.map((row) => String(row.name)).sort();
  const present = new Set(presentObjects);
  const missingObjects = REQUIRED_OBJECTS.filter((name) => !present.has(name));
  const records = await input.client.execute({
    sql: "SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=?",
    args: [WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_NAME],
  });
  const migrationRecordPresent = records.rows.length === 1
    && records.rows[0]?.finished_at !== null
    && records.rows[0]?.rolled_back_at === null;
  const checksumMatches = migrationRecordPresent
    && records.rows[0]?.checksum === migrationSha256;
  const installed = missingObjects.length === 0
    && migrationRecordPresent && checksumMatches;
  const empty = presentObjects.length === 0 && records.rows.length === 0;
  return {
    status: installed ? "INSTALLED" : empty ? "NOT_INSTALLED" : "PARTIAL_FAIL_CLOSED",
    migration_name: WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_NAME,
    migration_sha256: migrationSha256,
    present_objects: presentObjects,
    missing_objects: [...missingObjects],
    migration_record_present: migrationRecordPresent,
    migration_record_checksum_matches: Boolean(checksumMatches),
    runtime_stage_after_install: "OFF",
  };
}

export async function installWalmartListingIntegrityControlMigration(input: {
  client: WalmartListingIntegrityMigrationClient;
  migration_sql: string;
  now: string;
}) {
  const before = await inspectWalmartListingIntegrityControlMigration(input);
  if (before.status === "INSTALLED") {
    return { status: "ALREADY_INSTALLED" as const, before, after: before, database_writes: 0 as const };
  }
  if (before.status !== "NOT_INSTALLED") {
    throw new Error(
      "WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_PARTIAL: refusing to repair or overwrite partial schema",
    );
  }
  const parsed = new Date(input.now);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input.now) {
    throw new Error("WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_INVALID: canonical now required");
  }
  const id = randomUUID();
  const recordSql = `INSERT INTO "_prisma_migrations" (
    id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
  ) VALUES (
    ${sqlLiteral(id)},${sqlLiteral(before.migration_sha256)},${sqlLiteral(input.now)},
    ${sqlLiteral(WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_NAME)},NULL,NULL,
    ${sqlLiteral(input.now)},1
  );`;
  await input.client.executeMultiple(
    `BEGIN IMMEDIATE;\n${input.migration_sql}\n${recordSql}\nCOMMIT;`,
  );
  const after = await inspectWalmartListingIntegrityControlMigration(input);
  if (after.status !== "INSTALLED") {
    throw new Error(
      "WALMART_LISTING_INTEGRITY_CONTROL_MIGRATION_VERIFY_FAILED: post-install schema is not exact",
    );
  }
  return {
    status: "INSTALLED_DEFAULT_OFF" as const,
    before,
    after,
    database_writes: 1 as const,
    walmart_reads: 0 as const,
    walmart_writes: 0 as const,
  };
}
