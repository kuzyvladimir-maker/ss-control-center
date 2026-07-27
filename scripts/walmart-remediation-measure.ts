// Fill in the AFTER-metrics for logged remediations once a newer listing-quality
// sweep has landed, and print the delta (score / conversion / page views / GMV).
// Run this a couple weeks after a remediation, AFTER walmart-lq-sync.ts.
//
//   npx tsx scripts/walmart-remediation-measure.ts          # default: changes >=24h old
//   npx tsx scripts/walmart-remediation-measure.ts 0        # measure regardless of age

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { measureAfter } from "../src/lib/walmart/multipack/analytics";

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

function d(a: any, b: any) { return a != null && b != null ? (Number(a) - Number(b)).toFixed(2) : "—"; }

async function main() {
  const minAgeHours = process.argv[2] != null ? Number(process.argv[2]) : 24;
  const updated = await measureAfter(db, { minAgeHours });
  console.log(`measure-after: filled ${updated} remediation(s)\n`);

  const rows = await db.execute(
    `SELECT sku, runAt, beforeLqScore, afterLqScore, beforeContentScore, afterContentScore,
            beforeConversionRate30d, afterConversionRate30d, beforePageViews30d, afterPageViews30d,
            beforeGmv30d, afterGmv30d, afterCapturedAt
     FROM WalmartListingRemediation ORDER BY runAt DESC LIMIT 50`
  );
  console.log("SKU | LQΔ | contentΔ | convΔ | viewsΔ | gmvΔ | measured");
  for (const r of rows.rows as any[]) {
    console.log(
      `${r.sku} | ${d(r.afterLqScore, r.beforeLqScore)} | ${d(r.afterContentScore, r.beforeContentScore)} | ` +
      `${d(r.afterConversionRate30d, r.beforeConversionRate30d)} | ${d(r.afterPageViews30d, r.beforePageViews30d)} | ` +
      `${d(r.afterGmv30d, r.beforeGmv30d)} | ${r.afterCapturedAt || "pending"}`
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
