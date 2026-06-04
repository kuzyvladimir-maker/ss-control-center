// Turso migration: ProductTitleCache table.
//
// Idempotent — CREATE TABLE IF NOT EXISTS, then CREATE UNIQUE INDEX IF NOT
// EXISTS. Safe to re-run.

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

await client.execute({
  sql: `CREATE TABLE IF NOT EXISTS "ProductTitleCache" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "rawTitle" TEXT NOT NULL,
          "cleanTitle" TEXT NOT NULL,
          "source" TEXT NOT NULL DEFAULT 'ai',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        )`,
  args: [],
});
console.log("✓ table ProductTitleCache");

await client.execute({
  sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ProductTitleCache_rawTitle_key"
        ON "ProductTitleCache"("rawTitle")`,
  args: [],
});
console.log("✓ unique index on rawTitle");

await client.close();
console.log("Done.");
