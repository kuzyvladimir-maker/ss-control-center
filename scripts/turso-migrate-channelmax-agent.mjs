#!/usr/bin/env node

/**
 * Idempotent production Turso migration runner for the ChannelMAX bridge.
 *
 * Safe default (read-only):
 *   node scripts/turso-migrate-channelmax-agent.mjs --check
 *   node scripts/turso-migrate-channelmax-agent.mjs --dry-run
 *
 * Explicit write ceremony:
 *   node scripts/turso-migrate-channelmax-agent.mjs \
 *     --apply --confirm=CHANNELMAX_AGENT_SCHEMA_20260718
 *
 * Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Neither value is logged.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

export const APPLY_CONFIRMATION = "CHANNELMAX_AGENT_SCHEMA_20260718";

const MIGRATIONS = [
  {
    name: "20260718193000_channelmax_agent_job",
    url: new URL(
      "../prisma/migrations/20260718193000_channelmax_agent_job/migration.sql",
      import.meta.url,
    ),
  },
  {
    name: "20260718201500_channelmax_agent_managed_evidence",
    url: new URL(
      "../prisma/migrations/20260718201500_channelmax_agent_managed_evidence/migration.sql",
      import.meta.url,
    ),
  },
];

const REQUIRED_COLUMNS = {
  ChannelMaxAgentJob: [
    "id",
    "operation",
    "mutation",
    "status",
    "priority",
    "accountId",
    "payloadJson",
    "payloadSha256",
    "requestSha256",
    "mutationPlanSha256",
    "mutationPlanLock",
    "idempotencyKey",
    "requestedBy",
    "ownerApproved",
    "ownerApprovedBy",
    "ownerApprovedById",
    "ownerApprovedAt",
    "assignmentArtifactSha256",
    "approvalSubjectJson",
    "approvalSha256",
    "approvalExpiresAt",
    "approvalNonce",
    "approvalStepUpAssertionId",
    "approvalStepUpMethod",
    "approvalStepUpCeremonyId",
    "approvalStepUpVerifiedAt",
    "workerId",
    "workerActorId",
    "accountLeaseKey",
    "browserLeaseKey",
    "leaseTokenSha256",
    "leaseExpiresAt",
    "lastHeartbeatAt",
    "attempts",
    "maxAttempts",
    "mutationStartedAt",
    "mutationOutcome",
    "ambiguityReason",
    "eventSequence",
    "cancelledAt",
    "cancelledBy",
    "cancellationReason",
    "reconcilesJobId",
    "reconciliationTargetLock",
    "reconciledByJobId",
    "resultJson",
    "resultSha256",
    "error",
    "queuedAt",
    "startedAt",
    "completedAt",
    "createdAt",
    "updatedAt",
  ],
  ChannelMaxAgentEvent: [
    "id",
    "jobId",
    "sequence",
    "eventKey",
    "type",
    "source",
    "message",
    "metadataJson",
    "metadataSha256",
    "evidenceJson",
    "evidenceSha256",
    "occurredAt",
    "createdAt",
  ],
  ChannelMaxStepUpAssertion: [
    "id",
    "userId",
    "method",
    "ceremonyId",
    "verifiedAt",
    "expiresAt",
    "usedAt",
    "jobId",
    "createdAt",
  ],
  ChannelMaxAgentEvidence: [
    "id",
    "jobId",
    "kind",
    "sha256",
    "byteSize",
    "mediaType",
    "capturedAt",
    "uri",
    "content",
    "uploadedBy",
    "createdAt",
  ],
};

const REQUIRED_INDEXES = [
  "ChannelMaxAgentJob_idempotencyKey_key",
  "ChannelMaxAgentJob_approvalNonce_key",
  "ChannelMaxAgentJob_accountLeaseKey_key",
  "ChannelMaxAgentJob_browserLeaseKey_key",
  "ChannelMaxAgentJob_mutationPlanLock_key",
  "ChannelMaxAgentJob_approvalStepUpAssertionId_key",
  "ChannelMaxAgentJob_reconciliationTargetLock_key",
  "ChannelMaxAgentJob_status_priority_queuedAt_idx",
  "ChannelMaxAgentJob_leaseExpiresAt_idx",
  "ChannelMaxAgentJob_operation_status_idx",
  "ChannelMaxAgentJob_mutationPlanSha256_idx",
  "ChannelMaxAgentJob_reconcilesJobId_idx",
  "ChannelMaxAgentEvent_jobId_sequence_key",
  "ChannelMaxAgentEvent_jobId_eventKey_key",
  "ChannelMaxAgentEvent_jobId_occurredAt_idx",
  "ChannelMaxStepUpAssertion_ceremonyId_key",
  "ChannelMaxStepUpAssertion_userId_expiresAt_idx",
  "ChannelMaxStepUpAssertion_jobId_expiresAt_idx",
  "ChannelMaxAgentEvidence_jobId_kind_sha256_key",
  "ChannelMaxAgentEvidence_uri_key",
  "ChannelMaxAgentEvidence_jobId_createdAt_idx",
];

const REQUIRED_TRIGGERS = [
  "ChannelMaxAgentEvent_append_only_update",
  "ChannelMaxAgentEvent_append_only_delete",
  "ChannelMaxAgentEvidence_append_only_update",
  "ChannelMaxAgentEvidence_append_only_delete",
];

function clean(value) {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

export function parseMigrationArgs(argv) {
  const known = new Set(["--check", "--dry-run", "--apply"]);
  const modes = argv.filter((arg) => known.has(arg));
  const unknown = argv.filter(
    (arg) => !known.has(arg) && !arg.startsWith("--confirm="),
  );
  if (unknown.length > 0) {
    throw new Error("Unsupported migration argument.");
  }
  if (new Set(modes).size > 1) {
    throw new Error("Choose exactly one of --check, --dry-run, or --apply.");
  }
  const mode = modes[0] ?? "--check";
  const confirmation = argv
    .find((arg) => arg.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  if (mode === "--apply" && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(
      `--apply requires --confirm=${APPLY_CONFIRMATION}.`,
    );
  }
  if (mode !== "--apply" && confirmation) {
    throw new Error("--confirm is valid only with --apply.");
  }
  return { mode: mode.slice(2), apply: mode === "--apply" };
}

async function schemaObjects(client, type) {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_schema WHERE type = ? AND name LIKE 'ChannelMax%'",
    args: [type],
  });
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableColumns(client, table) {
  const result = await client.execute(`PRAGMA table_info("${table}")`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function hasEvidenceRestrictForeignKey(client) {
  const result = await client.execute(
    'PRAGMA foreign_key_list("ChannelMaxAgentEvidence")',
  );
  return result.rows.some(
    (row) =>
      String(row.table) === "ChannelMaxAgentJob" &&
      String(row.from) === "jobId" &&
      String(row.to) === "id" &&
      String(row.on_delete).toUpperCase() === "RESTRICT",
  );
}

export async function inspectChannelMaxSchema(client) {
  const tables = await schemaObjects(client, "table");
  const indexes = await schemaObjects(client, "index");
  const triggers = await schemaObjects(client, "trigger");
  const missingTables = Object.keys(REQUIRED_COLUMNS).filter(
    (table) => !tables.has(table),
  );
  const missingColumns = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) continue;
    const present = await tableColumns(client, table);
    for (const column of required) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  const missingIndexes = REQUIRED_INDEXES.filter((name) => !indexes.has(name));
  const missingTriggers = REQUIRED_TRIGGERS.filter(
    (name) => !triggers.has(name),
  );
  const evidenceForeignKeyValid =
    !tables.has("ChannelMaxAgentEvidence") ||
    (await hasEvidenceRestrictForeignKey(client));
  const ready =
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    missingIndexes.length === 0 &&
    missingTriggers.length === 0 &&
    evidenceForeignKeyValid;
  return {
    ready,
    missing_tables: missingTables,
    missing_columns: missingColumns,
    missing_indexes: missingIndexes,
    missing_triggers: missingTriggers,
    evidence_foreign_key_valid: evidenceForeignKeyValid,
  };
}

function idempotentCreateSql(sql) {
  return sql
    .replace(/CREATE TABLE "/g, 'CREATE TABLE IF NOT EXISTS "')
    .replace(/CREATE UNIQUE INDEX "/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
    .replace(/CREATE INDEX "/g, 'CREATE INDEX IF NOT EXISTS "')
    .replace(/CREATE TRIGGER "/g, 'CREATE TRIGGER IF NOT EXISTS "');
}

function withoutReconciliationAlter(sql) {
  return sql.replace(
    /ALTER TABLE "ChannelMaxAgentJob"\s+ADD COLUMN "reconciliationTargetLock" TEXT;\s*/,
    "",
  );
}

async function addReconciliationColumnIfMissing(client) {
  const columns = await tableColumns(client, "ChannelMaxAgentJob");
  if (columns.has("reconciliationTargetLock")) return false;
  await client.execute(
    'ALTER TABLE "ChannelMaxAgentJob" ADD COLUMN "reconciliationTargetLock" TEXT',
  );
  return true;
}

async function migrationFiles() {
  return Promise.all(
    MIGRATIONS.map(async (migration) => {
      const sql = await readFile(migration.url, "utf8");
      return {
        ...migration,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

async function hasPrismaMigrationLedger(client) {
  const ledger = await client.execute(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name='_prisma_migrations'",
  );
  return ledger.rows.length > 0;
}

async function assertMigrationLedgerCompatible(client, migrations) {
  if (!(await hasPrismaMigrationLedger(client))) return;
  for (const migration of migrations) {
    const existing = await client.execute({
      sql: 'SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ? AND rolled_back_at IS NULL',
      args: [migration.name],
    });
    if (
      existing.rows.length > 0 &&
      existing.rows.some(
        (row) => String(row.checksum) !== migration.checksum,
      )
    ) {
      throw new Error(
        `Migration ledger checksum mismatch for ${migration.name}; refusing to rewrite history.`,
      );
    }
  }
}

async function registerMigrationIfPossible(client, migration) {
  if (!(await hasPrismaMigrationLedger(client))) return;
  const existing = await client.execute({
    sql: 'SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ? AND rolled_back_at IS NULL',
    args: [migration.name],
  });
  if (existing.rows.length > 0) {
    if (
      existing.rows.some(
        (row) => String(row.checksum) !== migration.checksum,
      )
    ) {
      throw new Error(
        `Migration ledger checksum mismatch for ${migration.name}; refusing to rewrite history.`,
      );
    }
    return;
  }
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
      ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [randomUUID(), migration.checksum, migration.name],
  });
}

export async function applyChannelMaxMigrations(client) {
  const before = await inspectChannelMaxSchema(client);
  const initialTables = [
    "ChannelMaxAgentJob",
    "ChannelMaxAgentEvent",
    "ChannelMaxStepUpAssertion",
  ];
  const presentInitial = initialTables.filter(
    (table) => !before.missing_tables.includes(table),
  );
  if (presentInitial.length > 0 && presentInitial.length < initialTables.length) {
    throw new Error(
      "Partial ChannelMAX base schema detected; refusing an automatic repair.",
    );
  }
  const baseMissingColumns = before.missing_columns.filter(
    (entry) =>
      initialTables.some((table) => entry.startsWith(`${table}.`)) &&
      entry !== "ChannelMaxAgentJob.reconciliationTargetLock",
  );
  if (presentInitial.length === initialTables.length && baseMissingColumns.length) {
    throw new Error(
      `Incomplete ChannelMAX base table detected (${baseMissingColumns[0]}); refusing an automatic repair.`,
    );
  }
  const evidenceMissingColumns = before.missing_columns.filter((entry) =>
    entry.startsWith("ChannelMaxAgentEvidence."),
  );
  if (
    !before.missing_tables.includes("ChannelMaxAgentEvidence") &&
    evidenceMissingColumns.length
  ) {
    throw new Error(
      `Incomplete ChannelMAX evidence table detected (${evidenceMissingColumns[0]}); refusing an automatic repair.`,
    );
  }
  if (
    !before.missing_tables.includes("ChannelMaxAgentEvidence") &&
    !before.evidence_foreign_key_valid
  ) {
    throw new Error(
      "Incomplete ChannelMAX evidence foreign key detected; refusing an automatic repair.",
    );
  }

  const files = await migrationFiles();
  await assertMigrationLedgerCompatible(client, files);
  await client.executeMultiple(idempotentCreateSql(files[0].sql));
  await addReconciliationColumnIfMissing(client);
  await client.executeMultiple(
    idempotentCreateSql(withoutReconciliationAlter(files[1].sql)),
  );

  const verified = await inspectChannelMaxSchema(client);
  if (!verified.ready) {
    throw new Error("ChannelMAX schema verification failed after migration.");
  }
  for (const migration of files) {
    await registerMigrationIfPossible(client, migration);
  }
  return verified;
}

function describeStatus(status) {
  if (status.ready) return "READY";
  return [
    ...status.missing_tables.map((value) => `table:${value}`),
    ...status.missing_columns.map((value) => `column:${value}`),
    ...status.missing_indexes.map((value) => `index:${value}`),
    ...status.missing_triggers.map((value) => `trigger:${value}`),
    ...(!status.evidence_foreign_key_valid ? ["foreign-key:evidence-job"] : []),
  ].join(", ");
}

async function main() {
  const options = parseMigrationArgs(process.argv.slice(2));
  const url = clean(process.env.TURSO_DATABASE_URL);
  const authToken = clean(process.env.TURSO_AUTH_TOKEN);
  if (!url || !authToken) {
    throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.");
  }
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("TURSO_DATABASE_URL is invalid.");
  }
  if (!new Set(["libsql:", "https:"]).has(protocol)) {
    throw new Error("Production migration requires a remote Turso URL.");
  }

  const client = createClient({ url, authToken });
  try {
    console.log("ChannelMAX migration target: configured Turso database (redacted).");
    const before = await inspectChannelMaxSchema(client);
    console.log(`Schema check: ${describeStatus(before)}`);
    if (options.mode === "check") {
      if (!before.ready) process.exitCode = 2;
      return;
    }
    if (options.mode === "dry-run") {
      console.log(
        before.ready
          ? "Dry run: no migration changes required."
          : `Dry run: would apply ${MIGRATIONS.map((item) => item.name).join(", ")}.`,
      );
      return;
    }
    const after = await applyChannelMaxMigrations(client);
    console.log(`Migration complete: ${describeStatus(after)}.`);
  } finally {
    client.close();
  }
}

export function safeMigrationErrorMessage(error) {
  return error instanceof Error &&
    (/^Missing TURSO_/.test(error.message) ||
      /^TURSO_DATABASE_URL/.test(error.message) ||
      /^Production migration/.test(error.message) ||
      /^Unsupported migration argument/.test(error.message) ||
      /^Choose exactly/.test(error.message) ||
      /^--/.test(error.message) ||
      /^Partial ChannelMAX/.test(error.message) ||
      /^Incomplete ChannelMAX/.test(error.message) ||
      /^Migration ledger/.test(error.message) ||
      /^ChannelMAX schema verification/.test(error.message))
    ? error.message
    : "Database operation failed; no credentials were logged.";
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `ChannelMAX migration failed: ${safeMigrationErrorMessage(error)}`,
    );
    process.exitCode = 1;
  });
}
