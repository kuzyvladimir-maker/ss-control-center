// Turso migration: реестр споров по shipping adjustments.
//
// Только добавление: ADD COLUMN, CREATE TABLE, CREATE INDEX. Таблица не
// пересоздаётся, ни одна колонка не удаляется — старые adjusted* остаются на
// месте под прежней ручкой dispute-pack.
//
// Идемпотентен: перед каждым ADD COLUMN смотрит PRAGMA table_info, поэтому
// повторный прогон ничего не ломает и ничего не дублирует.
//
//   node scripts/turso-migrate-adjustments-dispute-registry.mjs
//   node scripts/turso-migrate-adjustments-dispute-registry.mjs --dry-run

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

// .env этого репо содержит значения с пробелами и спецсимволами, которые
// ломают `set -a && . ./.env` в шелле — читаем файл сами.
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
  ["enteredDimL", "REAL"],
  ["enteredDimW", "REAL"],
  ["enteredDimH", "REAL"],
  ["enteredDimUnit", "TEXT"],
  ["enteredWeight", "REAL"],
  ["enteredWeightUnit", "TEXT"],
  ["auditedDimL", "REAL"],
  ["auditedDimW", "REAL"],
  ["auditedDimH", "REAL"],
  ["auditedDimUnit", "TEXT"],
  ["auditedWeight", "REAL"],
  ["auditedWeightUnit", "TEXT"],
  ["auditSource", "TEXT"],
  ["auditCapturedAt", "DATETIME"],
  ["chargeBreakdown", "TEXT"],
  ["amountAlreadyPaid", "REAL"],
  ["totalChargeFromCarrier", "REAL"],
  ["transactionTotal", "REAL"],
  ["financialEventId", "TEXT"],
  ["transactionDetailsUrl", "TEXT"],
  ["disputeClass", "TEXT"],
  ["disputeStatus", "TEXT DEFAULT 'NONE'"],
  ["amountRecovered", "REAL DEFAULT 0"],
  ["lastDisputeEventAt", "DATETIME"],
];

const STATEMENTS_AFTER = [
  `CREATE INDEX IF NOT EXISTS "ShippingAdjustment_storeId_disputeClass_idx" ON "ShippingAdjustment"("storeId", "disputeClass")`,
  `CREATE INDEX IF NOT EXISTS "ShippingAdjustment_trackingNumber_idx" ON "ShippingAdjustment"("trackingNumber")`,
  `CREATE INDEX IF NOT EXISTS "ShippingAdjustment_disputeStatus_idx" ON "ShippingAdjustment"("disputeStatus")`,
  `CREATE TABLE IF NOT EXISTS "AdjustmentDisputeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adjustmentId" TEXT NOT NULL,
    "eventDate" TEXT NOT NULL,
    "eventAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "caseId" TEXT,
    "storeId" TEXT,
    "amountInDispute" REAL,
    "amountRefunded" REAL,
    "summary" TEXT,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    CONSTRAINT "AdjustmentDisputeEvent_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "ShippingAdjustment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_adjustmentId_eventDate_idx" ON "AdjustmentDisputeEvent"("adjustmentId", "eventDate")`,
  `CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_caseId_idx" ON "AdjustmentDisputeEvent"("caseId")`,
  `CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_eventType_idx" ON "AdjustmentDisputeEvent"("eventType")`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turso отдаёт 502 на серии DDL подряд (поймано 21.09.2026 — прогон падал
 * после восьмой ALTER). Операции идемпотентны и мелкие, поэтому повторяем
 * с нарастающей паузой, а между DDL держим передышку.
 */
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

const info = await exec(`PRAGMA table_info("ShippingAdjustment")`);
const existing = new Set(info.rows.map((r) => String(r.name)));

let added = 0;
for (const [name, type] of NEW_COLUMNS) {
  if (existing.has(name)) {
    console.log(`· ${name} — уже есть`);
    continue;
  }
  const sql = `ALTER TABLE "ShippingAdjustment" ADD COLUMN "${name}" ${type}`;
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

if (!dryRun) {
  const check = await exec(`PRAGMA table_info("AdjustmentDisputeEvent")`);
  console.log(
    `✓ готово: колонок добавлено ${added}, AdjustmentDisputeEvent колонок ${check.rows.length}`
  );
} else {
  console.log(`[dry-run] колонок к добавлению: ${added}`);
}

client.close();
