import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1"; // identities are cached; never block on vision
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const r = await db.execute(`SELECT DISTINCT sku FROM "SkuCost" WHERE source='retail:batch' ORDER BY sku ASC`);
  const skus = r.rows.map((x: any) => x.sku as string).filter(Boolean);
  console.log(`RE-COST ALL ${skus.length} rows on the strict engine`);
  let idx = 0, done = 0, real = 0, uns = 0, err = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      try {
        const res = await costOneSku(db, { sku: skus[i], channel: "walmart" });
        done++;
        if (res.status === "costed") real++; else if (res.status === "no-price") uns++; else err++;
      } catch { done++; err++; }
      if (done % 25 === 0) console.log(`progress ${done}/${skus.length} | real ${real} | unsourceable ${uns} | err ${err}`);
    }
  }));
  console.log(`\nRE-COST DONE. ${done} processed | real ${real} | unsourceable ${uns} | err ${err}`);
  process.exit(0);
})();
