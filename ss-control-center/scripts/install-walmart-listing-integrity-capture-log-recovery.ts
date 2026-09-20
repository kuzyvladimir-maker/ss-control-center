#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { createClient } from "@libsql/client";

const NAME = "20260801235000_walmart_listing_integrity_capture_log_recovery";
const MIGRATION = resolve(process.cwd(), `prisma/migrations/${NAME}/migration.sql`);
const TRIGGERS = [
  "WalmartListingIntegrityControlItem_terminal_guard",
  "WalmartListingIntegrityControlItem_transition_guard",
];

function fail(message: string): never {
  throw new Error(`WALMART_CAPTURE_LOG_RECOVERY_MIGRATION_INVALID: ${message}`);
}

function clean(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/gu, "") || undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function args(argv: string[]) {
  const command = argv[0];
  if (command !== "inspect" && command !== "apply") fail("command must be inspect or apply");
  const values = new Map<string, string>();
  for (const token of argv.slice(1)) {
    if (!token.startsWith("--") || !token.includes("=")) fail("flags must be --name=value");
    const [key, ...rest] = token.slice(2).split("=");
    if (!key || values.has(key)) fail("flag is invalid or repeated");
    values.set(key, rest.join("="));
  }
  const allowed = new Set(["expect-sha256", "output"]);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    fail("exact --expect-sha256 and --output are required");
  }
  const expected = values.get("expect-sha256")!;
  const output = values.get("output")!;
  if (!/^[a-f0-9]{64}$/u.test(expected)) fail("expect-sha256 must be lowercase SHA-256");
  if (!isAbsolute(output) || resolve(output) !== output) fail("output must be absolute normalized path");
  return { command, expected, output } as const;
}

async function inspect(client: ReturnType<typeof createClient>, expected: string) {
  const sql = await readFile(MIGRATION, "utf8");
  const migrationSha = sha256(sql);
  if (migrationSha !== expected
    || !sql.includes("CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY")
    || !sql.includes("codex-owner-recovery")
    || !sql.includes("OLD.\"state\"='QUARANTINED_SOURCE_REQUIRED'")
    || /DROP\s+TABLE|DELETE\s+FROM/iu.test(sql)) {
    fail("migration bytes or narrow recovery contract differ");
  }
  const objects = await client.execute({
    sql: "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN (?,?)",
    args: TRIGGERS,
  });
  if (objects.rows.length !== 2) fail("Stage A terminal/transition triggers are absent");
  const record = await client.execute({
    sql: "SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=?",
    args: [NAME],
  });
  if (record.rows.length > 1) fail("migration record is duplicated");
  const triggerReady = objects.rows.every((row) => (
    String(row.sql).includes("CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY")
    && String(row.sql).includes("codex-owner-recovery")
  ));
  const recordReady = record.rows.length === 1
    && record.rows[0]?.checksum === migrationSha
    && record.rows[0]?.finished_at !== null
    && record.rows[0]?.rolled_back_at === null;
  if (triggerReady !== recordReady) fail("trigger bytes and migration ledger disagree");
  return {
    sql,
    migration_sha256: migrationSha,
    status: triggerReady && recordReady ? "INSTALLED" as const : "READY_TO_INSTALL" as const,
    trigger_names: objects.rows.map((row) => String(row.name)).sort(),
    migration_record_present: recordReady,
  };
}

async function main() {
  const input = args(process.argv.slice(2));
  const url = clean(process.env.TURSO_DATABASE_URL) ?? clean(process.env.DATABASE_URL);
  const authToken = clean(process.env.TURSO_AUTH_TOKEN);
  if (!url || (url.startsWith("libsql:") && !authToken)) fail("exact database credentials are absent");
  const client = createClient({ url, authToken });
  try {
    const before = await inspect(client, input.expected);
    let writes = 0;
    if (input.command === "apply" && before.status === "READY_TO_INSTALL") {
      const now = new Date().toISOString();
      const record = `INSERT INTO _prisma_migrations (
        id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
      ) VALUES (
        ${literal(randomUUID())},${literal(before.migration_sha256)},${literal(now)},
        ${literal(NAME)},NULL,NULL,${literal(now)},1
      );`;
      await client.executeMultiple(`BEGIN IMMEDIATE;\n${before.sql}\n${record}\nCOMMIT;`);
      writes = 1;
    }
    const after = await inspect(client, input.expected);
    if (input.command === "apply" && after.status !== "INSTALLED") fail("post-install verification failed");
    const result = {
      schema_version: "walmart-listing-integrity-capture-log-recovery-migration/v1",
      command: input.command,
      before: { ...before, sql: undefined },
      after: { ...after, sql: undefined },
      database_writes: writes,
      walmart_writes: 0,
    };
    await mkdir(dirname(input.output), { recursive: true, mode: 0o700 });
    await writeFile(input.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
