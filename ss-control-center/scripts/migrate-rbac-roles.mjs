// RBAC roles migration — creates the `Role` table and seeds the two built-in
// system roles. Idempotent: safe to run repeatedly and on every target.
//
//   node -r dotenv/config scripts/migrate-rbac-roles.mjs
//
// Applies to EVERY database it can reach:
//   • Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)  ← what the app uses
//   • the local Prisma CLI db (prisma/dev.db)
//   • the local runtime file db (./dev.db)
// so dev and prod stay consistent regardless of which one is live.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

// Built-in roles. `member` is seeded with EVERY grantable module so existing
// non-admin users keep seeing everything after this ships — the admin then
// tightens access by creating narrower custom roles. Mirrors
// GRANTABLE_MODULE_KEYS in src/lib/rbac/modules.ts (keep in sync).
const GRANTABLE = [
  "analytics",
  "account-health",
  "procurement",
  "shipping",
  "customer-hub",
  "frozen-analytics",
  "adjustments",
  "bundle-factory",
  "reference-catalog",
  "finance",
  "economics",
  "walmart-growth",
  "amazon-growth",
  "amazon-aplus",
];

const SEED_ROLES = [
  { key: "admin", name: "Administrator", modules: [], isSystem: 1 },
  { key: "member", name: "Member", modules: GRANTABLE, isSystem: 1 },
];

async function applyTo(label, client) {
  console.log(`\n→ ${label}`);

  // 1. Create table (idempotent).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS "Role" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "key" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "modules" TEXT NOT NULL DEFAULT '[]',
      "isSystem" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Role_key_key" ON "Role"("key")`
  );
  console.log("  · table + unique index ready");

  // 2. Seed system roles — leave existing rows untouched (ON CONFLICT DO NOTHING).
  for (const r of SEED_ROLES) {
    await client.execute({
      sql: `INSERT INTO "Role" ("id","key","name","modules","isSystem","createdAt","updatedAt")
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT("key") DO NOTHING`,
      args: [crypto.randomUUID(), r.key, r.name, JSON.stringify(r.modules), r.isSystem],
    });
  }
  const count = await client.execute(`SELECT COUNT(*) AS n FROM "Role"`);
  console.log(`  · seeded system roles (total roles now: ${count.rows[0]?.n})`);

  // 3. Register in Prisma's bookkeeping so `migrate deploy` won't re-apply.
  try {
    await client.execute({
      sql: `INSERT INTO "_prisma_migrations"
              ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
            VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
      args: [crypto.randomUUID(), "rbac-roles-applied", "20260621000000_rbac_roles"],
    });
    console.log("  · registered in _prisma_migrations");
  } catch (e) {
    console.log(`  · _prisma_migrations skipped (${e instanceof Error ? e.message : e})`);
  }

  client.close();
}

const targets = [];

const tursoUrl = clean(process.env.TURSO_DATABASE_URL);
const tursoToken = clean(process.env.TURSO_AUTH_TOKEN);
if (tursoUrl && tursoToken) {
  targets.push([
    `Turso (${tursoUrl.split("@")[1] || tursoUrl})`,
    createClient({ url: tursoUrl, authToken: tursoToken }),
  ]);
}

// Local files — only if they already exist (don't create stray dbs).
import { existsSync } from "fs";
import { resolve } from "path";
for (const rel of ["dev.db", "prisma/dev.db"]) {
  const p = resolve(process.cwd(), rel);
  if (existsSync(p)) {
    targets.push([`file ${rel}`, createClient({ url: `file:${p}` })]);
  }
}

if (targets.length === 0) {
  console.error("No database targets found (no Turso env, no local dev.db).");
  process.exit(1);
}

for (const [label, client] of targets) {
  await applyTo(label, client);
}
console.log("\n✓ RBAC roles migration complete.");
