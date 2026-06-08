// One-off Turso migration adding AccountHealthSnapshot.accountState.
//
// Mirrors prisma/migrations/20260519020000_add_account_state/migration.sql
// idempotently. SQLite has no IF NOT EXISTS on ALTER TABLE ADD COLUMN,
// so we wrap in try/catch and treat the duplicate-column error as
// "already applied". Safe to re-run.
//
// NOT run automatically. Run manually after the PR is merged:
//   node scripts/turso-migrate-account-state.mjs
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

async function addColumnIfMissing(table, column, ddl) {
  try {
    await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
    console.log(`  + ${table}.${column} added`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).toLowerCase();
    if (msg.includes("duplicate column") || msg.includes("already exists")) {
      console.log(`  · ${table}.${column} already present — skipping`);
      return;
    }
    throw e;
  }
}

console.log("\nAdding AccountHealthSnapshot.accountState…");
await addColumnIfMissing(
  "AccountHealthSnapshot",
  "accountState",
  `"accountState" TEXT`,
);

console.log("\n✓ accountState migration applied.");
client.close();
