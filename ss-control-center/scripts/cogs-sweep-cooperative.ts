// Cooperative COGS sweep — overnight background runner that SHARES the vision box
// with another chat's run without suppressing it.
//
// How the two runs take turns: the box worker already serializes each lane (Codex
// queue, Claude queue), so requests naturally queue behind the other chat's. This
// runner adds politeness on top:
//   • concurrency 2 (one per usable lane via identify's round-robin), never more
//   • SS_VISION_FREE_ONLY=1 — if all free lanes are busy, the SKU is SKIPPED (no row
//     written, retried later), never a paid call and never a junk identity
//   • adaptive backoff — a failure/slow call doubles the pause (box is busy → back
//     off), a success halves it (box is free → speed up)
//   • nightly CAP protects paid retail credits (Oxylabs/Unwrangle)
//
//   CAP=450 npx tsx scripts/cogs-sweep-cooperative.ts
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1";

import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";

const CAP = Math.max(1, parseInt(process.env.CAP || "450", 10));
const CONC = 2;
const PAUSE_MIN = 3_000, PAUSE_MAX = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  let total = 0, real = 0, uns = 0, skipped = 0;
  let pause = PAUSE_MIN;
  let consecutiveSkips = 0;

  while (total < CAP) {
    // sku ASC ordering (the hourly cron picks syncedAt DESC) → the two rarely collide.
    const r = await db.execute({
      sql: `SELECT w.sku FROM WalmartCatalogItem w
            LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
            WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
            ORDER BY w.sku ASC LIMIT 30`,
      args: [],
    });
    const skus = r.rows.map((x: any) => x.sku as string).filter(Boolean);
    if (!skus.length) { console.log("no more uncosted — catalog swept, DONE"); break; }

    let idx = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (true) {
        const i = idx++;
        if (i >= skus.length || total >= CAP) break;
        try {
          const res = await costOneSku(db, { sku: skus[i], channel: "walmart" });
          total++;
          if (res.status === "costed") { real++; consecutiveSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
          else if (res.status === "no-price") { uns++; consecutiveSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
          else { // error = vision lanes busy → back off, SKU will be retried later
            skipped++; consecutiveSkips++;
            pause = Math.min(PAUSE_MAX, pause * 2);
          }
        } catch { total++; skipped++; consecutiveSkips++; pause = Math.min(PAUSE_MAX, pause * 2); }
        if ((real + uns + skipped) % 15 === 0) console.log(`progress: costed ${real} | unsourceable ${uns} | skipped(busy) ${skipped} | pause ${(pause / 1000).toFixed(0)}s`);
        // Long streak of busy lanes = the other chat is hammering → step aside 10 min.
        if (consecutiveSkips >= 8) { console.log("lanes busy 8x in a row — yielding 10 min to the other run"); await sleep(600_000); consecutiveSkips = 0; pause = PAUSE_MIN; }
        else await sleep(pause);
      }
    }));
  }
  console.log(`\nCOOPERATIVE SWEEP DONE. costed ${real} | unsourceable ${uns} | skipped-for-later ${skipped}`);
  process.exit(0);
})();
