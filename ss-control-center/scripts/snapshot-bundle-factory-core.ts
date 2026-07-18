/**
 * Immutable, read-only snapshot of every table touched by the Bundle Factory
 * core-integrity migration. This is a targeted rollback/audit artifact, not a
 * marketplace export. It performs no writes outside the local output file.
 */

import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const TABLES = [
  "GenerationJob",
  "BundleDraft",
  "MasterBundle",
  "ChannelSKU",
] as const;

function clean(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

function stamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function readAllRows(client: Client, table: string): Promise<Record<string, unknown>[]> {
  const countResult = await client.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
  const count = Number(countResult.rows[0]?.count ?? 0);
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < count; offset += 500) {
    const result = await client.execute(
      `SELECT * FROM "${table}" ORDER BY rowid LIMIT 500 OFFSET ${offset}`,
    );
    rows.push(...result.rows.map((row) => ({ ...row })));
  }
  if (rows.length !== count) {
    throw new Error(`${table} changed during snapshot: expected ${count}, read ${rows.length}`);
  }
  return rows;
}

async function main(): Promise<void> {
  const url = clean(process.env.TURSO_DATABASE_URL) ?? clean(process.env.DATABASE_URL);
  const authToken = clean(process.env.TURSO_AUTH_TOKEN);
  if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");

  const client = createClient({ url, authToken });
  const started = new Date();
  try {
    const tables: Record<string, unknown> = {};
    for (const table of TABLES) {
      const [ddl, columns, indexes, rows] = await Promise.all([
        client.execute({
          sql: "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name=? ORDER BY type, name",
          args: [table],
        }),
        client.execute(`PRAGMA table_info("${table}")`),
        client.execute(`PRAGMA index_list("${table}")`),
        readAllRows(client, table),
      ]);
      tables[table] = {
        row_count: rows.length,
        ddl: ddl.rows.map((row) => ({ ...row })),
        columns: columns.rows.map((row) => ({ ...row })),
        indexes: indexes.rows.map((row) => ({ ...row })),
        rows,
      };
    }

    const body = {
      schema_version: "bundle-factory-core-snapshot/v1.0",
      immutable: true,
      external_mutations: false,
      started_at: started.toISOString(),
      completed_at: new Date().toISOString(),
      tables,
    };
    const canonical = JSON.stringify(body);
    const payload = {
      ...body,
      sha256: createHash("sha256").update(canonical).digest("hex"),
    };
    const outputDir = path.resolve("data/audits");
    await mkdir(outputDir, { recursive: true });
    const output = path.join(
      outputDir,
      `bundle-factory-core-pre-migration-${stamp(started)}.json`,
    );
    const handle = await open(output, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    console.log(`Immutable snapshot: ${output}`);
    console.log(`SHA-256: ${payload.sha256}`);
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(tables).map(([name, value]) => [
            name,
            (value as { row_count: number }).row_count,
          ]),
        ),
        null,
        2,
      ),
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
