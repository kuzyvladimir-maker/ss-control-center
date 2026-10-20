// Turso migration: Customer Hub VPS tasks, approval cards, owner corrections.
//
// Только добавление: две колонки в BuyerMessage, три новые таблицы и индексы.
// Идемпотентен: колонки через PRAGMA table_info, таблицы IF NOT EXISTS.
// SQL берётся из prisma/migrations/20261020170000_customer_hub_cards_tasks.
//
//   node scripts/turso-migrate-customer-hub-cards.mjs [--dry-run]

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
  "prisma/migrations/20261020170000_customer_hub_cards_tasks/migration.sql",
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

const info = await exec(`PRAGMA table_info("BuyerMessage")`);
const existing = new Set(info.rows.map((r) => String(r.name)));
let done = 0;
for (const stmt of sql) {
  const col = /ADD COLUMN "(\w+)"/.exec(stmt)?.[1];
  if (col && existing.has(col)) {
    console.log(`· ${col} — уже есть`);
    continue;
  }
  if (dryRun) {
    console.log(`[dry-run] ${stmt.split("\n")[0]}`);
    continue;
  }
  await exec(stmt);
  await sleep(200);
  done++;
}
console.log(`${dryRun ? "[dry-run] " : "✓ "}выполнено ${done} из ${sql.length}`);
client.close();
