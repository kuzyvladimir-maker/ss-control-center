// Force re-enrich the neighbor's priority queue (enrich_priority_skus) — even if already
// costed — so their donors refresh (full OFF harvest + latest engine) and reappear in
// EnrichedReadySku. Banner-donor SKUs get a fresh detail pass.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const p = (await db.execute(`SELECT value FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`)).rows[0];
  let skus: string[] = []; try { skus = JSON.parse(String((p as any)?.value || "[]")); } catch { /* */ }
  console.log(`RE-ENRICH ${skus.length} priority SKUs (force, full OFF harvest)`);
  let idx = 0, done = 0, ok = 0, uns = 0, err = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      try { const r = await costOneSku(db, { sku: skus[i], channel: "walmart", reidentify: false }); done++; if (r.status === "costed") ok++; else if (r.status === "no-price") uns++; else err++; }
      catch { done++; err++; }
      if (done % 20 === 0) console.log(`  ${done}/${skus.length} | costed ${ok} | unsourceable ${uns} | err ${err}`);
    }
  }));
  console.log(`\nDONE. ${done} | costed ${ok} | unsourceable ${uns} | err ${err}`);
  process.exit(0);
})();
