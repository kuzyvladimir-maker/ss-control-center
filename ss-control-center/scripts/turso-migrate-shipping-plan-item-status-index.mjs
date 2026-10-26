// Turso migration: index ShippingPlanItem(status, updatedAt).
//
// Every /shipping refresh writes a draft plan, so the table holds ~150k rows
// (2026-10-26) of which ~2.5k are "bought". "Bought today" (/api/dashboard/
// summary), drive-backfill and package history filter by status and scanned
// the whole table — 20 s+, and past the 30 s client deadline during Turso's
// us-east-1 incident, holding a pool client the whole time.
//
// One plain statement, not a batch: batches run as transactions, and those
// were the thing hanging during the incident. Idempotent.

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

const client = createClient({ url: url.replace(/^libsql:\/\//, "https://"), authToken });
console.log(`→ Target: ${url.split("@")[1] || url.split("//")[1]?.split(".")[0]}`);

const t = Date.now();
await client.execute(
  `CREATE INDEX IF NOT EXISTS "ShippingPlanItem_status_updatedAt_idx" ON "ShippingPlanItem"("status", "updatedAt")`,
);
console.log(`· index ensured in ${Date.now() - t} ms`);

const plan = await client.execute(
  `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM "ShippingPlanItem" WHERE "status" = 'bought' AND "updatedAt" >= '2026-10-26'`,
);
console.log("· query plan:", plan.rows.map((r) => r.detail).join(" | "));
