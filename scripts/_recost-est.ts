import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1";
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  // Re-cost only the ESTIMATE/flagged class with the v4 engine.
  const r = await db.execute(`SELECT DISTINCT c.sku FROM "SkuCost" c LEFT JOIN "SkuComponent" sc ON sc.sku=c.sku
    WHERE c.source='retail:batch' AND c.totalCost IS NOT NULL AND (c.needsReview=1 OR sc.costMethod IN ('line-price')) ORDER BY c.sku`);
  const skus = r.rows.map((x: any) => x.sku as string).filter(Boolean);
  console.log(`RE-COST ${skus.length} estimate/flagged rows on v4`);
  let idx = 0, done = 0, real = 0, uns = 0, err = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      try { const res = await costOneSku(db, { sku: skus[i], channel: "walmart" }); done++; if (res.status === "costed") real++; else if (res.status === "no-price") uns++; else err++; }
      catch { done++; err++; }
      if (done % 25 === 0) console.log(`progress ${done}/${skus.length} | real ${real} | uns ${uns} | err ${err}`);
    }
  }));
  console.log(`\nDONE. ${done} | real ${real} | unsourceable ${uns} | err ${err}`);
  process.exit(0);
})();
