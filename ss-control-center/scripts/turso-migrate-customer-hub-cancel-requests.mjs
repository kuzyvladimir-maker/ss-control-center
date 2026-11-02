// Turso migration: Customer Hub — Amazon buyer cancellation notices.
//
// Только добавление: одна новая таблица AmazonCancelRequest и индексы.
// Идемпотентен: CREATE … IF NOT EXISTS.
// SQL берётся из prisma/migrations/20261102041500_customer_hub_cancel_requests.
//
//   node scripts/turso-migrate-customer-hub-cancel-requests.mjs [--dry-run]

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const fileEnv = {};
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) fileEnv[m[1]] = clean(m[2]);
  }
} catch {
  // переменные уже в окружении
}
const url = clean(process.env.TURSO_DATABASE_URL) || fileEnv.TURSO_DATABASE_URL;
const authToken = clean(process.env.TURSO_AUTH_TOKEN) || fileEnv.TURSO_AUTH_TOKEN;
const dryRun = process.argv.includes("--dry-run");
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}
const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const sql = readFileSync(
  "prisma/migrations/20261102041500_customer_hub_cancel_requests/migration.sql",
  "utf8"
)
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function exec(stmt, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await client.execute({ sql: stmt });
    } catch (e) {
      const transient = String(e?.message || "").includes("502") || e?.code === "SERVER_ERROR";
      if (!transient || i === attempts) throw e;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}

let done = 0;
for (const stmt of sql) {
  if (dryRun) {
    console.log(`[dry-run] ${stmt.split("\n")[0]}`);
    continue;
  }
  await exec(stmt);
  await sleep(200);
  done++;
}
const check = await exec(`PRAGMA table_info("AmazonCancelRequest")`);
console.log(`${dryRun ? "[dry-run] " : "✓ "}выполнено ${done} из ${sql.length}; колонок в таблице: ${check.rows.length}`);
client.close();
