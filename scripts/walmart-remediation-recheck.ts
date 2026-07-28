// Re-poll the feeds behind logged remediations and correct ok/feedStatus once
// Walmart finishes publishing (its publish step can lag 1-2h after submit, longer
// than the batch's in-run poll). Run a few times after a batch, or on a cron.
//
//   npx tsx scripts/walmart-remediation-recheck.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { getWalmartClient } from "../src/lib/walmart/client";

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  const client = getWalmartClient(1);
  const rows = await db.execute(
    `SELECT id, sku, feedId, feedStatus, ok FROM WalmartListingRemediation
       WHERE feedId IS NOT NULL AND (ok=0 OR feedStatus NOT IN ('PROCESSED'))
       ORDER BY runAt DESC LIMIT 100`,
  );
  let updated = 0;
  for (const r of rows.rows as any[]) {
    try {
      const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(r.feedId)}`, { params: { includeDetails: "true" } })).body;
      const st = d?.feedStatus;
      if (st !== "PROCESSED" && st !== "ERROR") { console.log(`${r.sku}: still ${st}`); continue; }
      const ok = st === "PROCESSED" && Number(d.itemsFailed) === 0 && Number(d.itemsSucceeded) > 0;
      await db.execute({ sql: `UPDATE WalmartListingRemediation SET ok=?, feedStatus=? WHERE id=?`, args: [ok ? 1 : 0, st, r.id] });
      console.log(`${r.sku}: ${st} ok=${ok} (updated)`);
      updated++;
    } catch (e: any) { console.log(`${r.sku}: recheck err ${e?.message?.slice(0, 80)}`); }
  }
  console.log(`\nupdated ${updated} remediation row(s)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
