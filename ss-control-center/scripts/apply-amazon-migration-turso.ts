// One-off: apply the amazon_listing_health migration to the Turso runtime DB.
// The app + scripts run against Turso (TURSO_DATABASE_URL), not dev.db, so the
// hand-authored migration SQL must be executed there too.
//
//   npx tsx scripts/apply-amazon-migration-turso.ts

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const clean = (v?: string) => v?.trim().replace(/^['"]|['"]$/g, "");

async function main() {
  const url = clean(process.env.TURSO_DATABASE_URL);
  const authToken = clean(process.env.TURSO_AUTH_TOKEN);
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set");

  const client = createClient({ url, authToken });
  const sqlPath = resolve(
    process.cwd(),
    process.argv[2] ??
      "prisma/migrations/20260614170000_amazon_listing_health/migration.sql",
  );
  const sql = readFileSync(sqlPath, "utf-8");

  // Split into statements (strip -- comments first), run each.
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Applying ${statements.length} statements to Turso…`);
  for (const stmt of statements) {
    const head = stmt.replace(/\s+/g, " ").slice(0, 70);
    try {
      await client.execute(stmt);
      console.log(`  ✓ ${head}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/already exists/i.test(msg)) {
        console.log(`  · skip (exists): ${head}`);
      } else {
        console.log(`  ✗ ${head}\n    ${msg}`);
        throw e;
      }
    }
  }

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Amazon%' ORDER BY name",
  );
  console.log("\nAmazon* tables in Turso:", tables.rows.map((r) => r.name).join(", "));
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
