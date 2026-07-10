// Re-cost the whole UNSOURCEABLE pool after the frozen fix stack (FORM_MARKERS,
// TIER-4 size-unknown donor, escalation-hit alignment). Many were false negatives.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1";
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
const CONC = 3, CREDIT_FLOOR = Math.max(0, parseInt(process.env.CREDIT_FLOOR || "5000", 10));
async function credits(): Promise<number> {
  const K = (process.env.UNWRANGLE_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  return fetch(`https://data.unwrangle.com/api/getter/?platform=target_search&search=water&api_key=${K}`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((j: any) => Number(j?.remaining_credits ?? 0)).catch(() => Infinity);
}
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const c0 = await credits(); console.log(`credits ${c0} (floor ${CREDIT_FLOOR})`);
  if (c0 < CREDIT_FLOOR) { console.log("below floor"); process.exit(0); }
  const rows = (await db.execute(`SELECT sku FROM "SkuCost" WHERE source='retail:batch' AND totalCost IS NULL ORDER BY sku`)).rows as any[];
  const skus = rows.map((r) => r.sku as string);
  console.log(`RE-COST ${skus.length} unsourceable SKUs (frozen fix)`);
  let idx = 0, done = 0, revived = 0, still = 0, err = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      if (i % 40 === 0 && (await credits()) < CREDIT_FLOOR) { console.log("credit floor — stop"); break; }
      // channel: Walmart mirror knows its SKUs; else Amazon.
      const isW = (await db.execute({ sql: `SELECT 1 FROM WalmartCatalogItem WHERE sku=? LIMIT 1`, args: [skus[i]] })).rows.length > 0;
      try {
        const r: any = await costOneSku(db, { sku: skus[i], channel: isW ? "walmart" : "amazon" });
        done++;
        if (r.status === "costed") { revived++; console.log(`  ✅ ${skus[i]}: $${r.total} [${(r.methods || []).join(",")}]`); }
        else if (r.status === "no-price") still++; else err++;
      } catch { done++; err++; }
      if (done % 25 === 0) console.log(`progress ${done}/${skus.length} | ОЖИЛО ${revived} | всё ещё unsourceable ${still} | err ${err}`);
    }
  }));
  console.log(`\nDONE. processed ${done} | ОЖИЛО ${revived} | still unsourceable ${still} | err ${err}`);
  process.exit(0);
})();
