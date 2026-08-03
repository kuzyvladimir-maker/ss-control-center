// Turso migration: restore the MarketplaceSubmissionAttempt guard triggers.
//
// Migration 20260803120000 rebuilt the table (RENAME → CREATE → DROP old) to
// lift the two-row cap. SQLite triggers follow the table through the rename and
// die with the DROP; that migration never recreated them, so all five guards
// were lost and the runtime doctor refused every publish afterwards.
//
// This restores them and scopes the pilot cap to the pilot lane. Idempotent:
// each trigger is dropped if present, then created. Verifies afterwards against
// the exact object list the runtime doctor checks.
//
// Mirrors prisma/migrations/20260803200000_restore_submission_attempt_guards.

import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = join(
  APP_ROOT,
  "prisma/migrations/20260803200000_restore_submission_attempt_guards/migration.sql",
);

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

function fromEnvFile(key) {
  const file = join(APP_ROOT, ".env.local");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === key) return clean(trimmed.slice(eq + 1));
  }
  return undefined;
}

const url = clean(process.env.TURSO_DATABASE_URL) ?? fromEnvFile("TURSO_DATABASE_URL");
const authToken = clean(process.env.TURSO_AUTH_TOKEN) ?? fromEnvFile("TURSO_AUTH_TOKEN");
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

/**
 * Split the migration into statements. Trigger bodies contain semicolons, so a
 * naive split on ";" would tear them in half — track BEGIN…END instead.
 */
function splitStatements(sql) {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = [];
  let current = "";
  let inTrigger = false;
  for (const rawLine of withoutComments.split("\n")) {
    const line = rawLine;
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("CREATE TRIGGER")) inTrigger = true;
    current += line + "\n";
    const trimmed = line.trim();
    if (inTrigger) {
      if (/^END\s*;?$/i.test(trimmed)) {
        statements.push(current.trim().replace(/;$/, ""));
        current = "";
        inTrigger = false;
      }
      continue;
    }
    if (trimmed.endsWith(";")) {
      const statement = current.trim().replace(/;$/, "");
      if (statement) statements.push(statement);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail.replace(/;$/, ""));
  return statements.filter(Boolean);
}

const statements = splitStatements(readFileSync(MIGRATION, "utf8"));
console.log(`· ${statements.length} statements parsed from the migration`);

for (const statement of statements) {
  const label = statement.split("\n")[0].slice(0, 72);
  await client.execute(statement);
  console.log(`· ok: ${label}`);
}

// The doctor's exact object list. Proving the migration means proving what the
// runtime will actually look for, not what this script happened to create.
const REQUIRED = [
  "MarketplaceSubmissionAttempt_active_key_key",
  "MarketplaceSubmissionAttempt_idempotency_key_key",
  "MarketplaceSubmissionAttempt_pilot_permit_sha256_key",
  "MarketplaceSubmissionAttempt_pilot_permit_id_key",
  "MarketplaceSubmissionAttempt_owner_signature_sha256_key",
  "MarketplaceSubmissionAttempt_pilot_slot_key",
  "UPCPool_reserved_for_id_key",
  "MarketplaceSubmissionAttempt_active_insert_guard",
  "MarketplaceSubmissionAttempt_active_update_guard",
  "MarketplaceSubmissionAttempt_identity_immutable",
  "MarketplaceSubmissionAttempt_no_delete",
  "MarketplaceSubmissionAttempt_pilot_global_cap",
  "WalmartBuyerPublicationEvidence_attempt_sku_guard",
  "WalmartBuyerPublicationEvidence_no_update",
  "WalmartBuyerPublicationEvidence_no_delete",
];

const found = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE name IN (${REQUIRED.map(() => "?").join(",")})`,
  args: REQUIRED,
});
const present = new Set(found.rows.map((row) => row.name));
const missing = REQUIRED.filter((name) => !present.has(name));

if (missing.length > 0) {
  console.error(`✗ still missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`✓ all ${REQUIRED.length} lifecycle objects present`);
process.exit(0);
