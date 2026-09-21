// Turso migration: источник подачи в истории урегулирования.
//
// Добавляет AdjustmentDisputeEvent.submittedFromStore / submittedFromVps и
// индекс по кабинету подачи. Только ADD COLUMN и CREATE INDEX — ничего не
// удаляется и не пересоздаётся.
//
// Идемпотентен: колонки проверяются через PRAGMA table_info.
//
//   node scripts/turso-migrate-adjustments-submission-origin.mjs
//   node scripts/turso-migrate-adjustments-submission-origin.mjs --dry-run

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

function loadEnvFile(path = ".env") {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) out[m[1]] = clean(m[2]);
    }
  } catch {
    // нет файла — значит переменные уже в окружении
  }
  return out;
}

const fileEnv = loadEnvFile();
const url = clean(process.env.TURSO_DATABASE_URL) || fileEnv.TURSO_DATABASE_URL;
const authToken = clean(process.env.TURSO_AUTH_TOKEN) || fileEnv.TURSO_AUTH_TOKEN;
const dryRun = process.argv.includes("--dry-run");

if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const NEW_COLUMNS = [
  ["submittedFromStore", "TEXT"],
  ["submittedFromVps", "TEXT"],
];

const STATEMENTS_AFTER = [
  `CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_submittedFromStore_idx" ON "AdjustmentDisputeEvent"("submittedFromStore")`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turso отдаёт 502 на серии DDL — повторяем с нарастающей паузой. */
async function exec(sql, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await client.execute({ sql });
    } catch (e) {
      const transient = String(e?.message || "").includes("502") || e?.code === "SERVER_ERROR";
      if (!transient || i === attempts) throw e;
      const wait = 1000 * 2 ** (i - 1);
      console.log(`  ↻ 502, жду ${wait}ms и повторяю (${i}/${attempts - 1})`);
      await sleep(wait);
    }
  }
}

const info = await exec(`PRAGMA table_info("AdjustmentDisputeEvent")`);
const existing = new Set(info.rows.map((r) => String(r.name)));

let added = 0;
for (const [name, type] of NEW_COLUMNS) {
  if (existing.has(name)) {
    console.log(`· ${name} — уже есть`);
    continue;
  }
  const sql = `ALTER TABLE "AdjustmentDisputeEvent" ADD COLUMN "${name}" ${type}`;
  if (dryRun) {
    console.log(`[dry-run] ${sql}`);
  } else {
    await exec(sql);
    await sleep(250);
    console.log(`+ ${name}`);
  }
  added++;
}

for (const sql of STATEMENTS_AFTER) {
  if (dryRun) {
    console.log(`[dry-run] ${sql.split("\n")[0]}…`);
    continue;
  }
  await exec(sql);
  await sleep(250);
}

const check = await exec(`PRAGMA table_info("AdjustmentDisputeEvent")`);
console.log(
  `${dryRun ? "[dry-run] " : "✓ "}колонок добавлено ${added}, всего в AdjustmentDisputeEvent ${check.rows.length}`
);

client.close();
