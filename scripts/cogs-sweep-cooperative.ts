// Cooperative COGS sweep — overnight background runner that SHARES the vision box
// with another chat's run without suppressing it.
//
// How the two runs take turns: the box worker already serializes each lane (Codex
// queue, Claude queue), so requests naturally queue behind the other chat's. This
// runner adds politeness on top:
//   • cached-identity SKUs FIRST (they need no vision at all — pure retail-API work)
//   • concurrency 2 (one per usable lane via identify's round-robin), never more
//   • SS_VISION_FREE_ONLY=1 — if all free lanes are busy, the SKU is SKIPPED (no row
//     written, retried later), never a paid call and never a junk identity
//   • skip-list — an attempted SKU is not re-picked this run (no spinning on the
//     same head-of-list); when the whole list is attempted, nap 15 min and reset
//     (lanes may have recovered, e.g. Codex quota reset)
//   • adaptive backoff — busy doubles the pause (up to 5 min), success halves it;
//     8 busy in a row → yield the box 10 min to the other run
//   • CAP counts only WRITTEN results (skips are free — no retail credits burned)
//   • hard wall-clock stop after MAX_HOURS
//
//   CAP=400 npx tsx scripts/cogs-sweep-cooperative.ts
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1";

import { createClient } from "@libsql/client";
import { costOneSku, enrichPrioritySkus } from "@/lib/sourcing/cogs-engine";
import { harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { assertMeteredProviderCall } from "@/lib/sourcing/metered-call-guard";

throw new Error("LEGACY_METERED_SCRIPT_DISABLED: use the durable Product Truth queue and budget ledger");

const STORE_INDEX = Number(process.env.STORE_INDEX);
if (!Number.isSafeInteger(STORE_INDEX) || STORE_INDEX <= 0) {
  throw new Error("STORE_INDEX=<positive integer> is required; account scope is never inferred");
}

const CAP = Math.max(1, parseInt(process.env.CAP || "400", 10));
const MAX_HOURS = parseFloat(process.env.MAX_HOURS || "8");
const CONC = 2;
const PAUSE_MIN = 3_000, PAUSE_MAX = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CREDIT_FLOOR = Math.max(0, parseInt(process.env.CREDIT_FLOOR || "3000", 10));
async function unwrangleCredits(): Promise<number> {
  const KEY = (process.env.UNWRANGLE_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  assertMeteredProviderCall({ provider: "unwrangle", operation: "balance_probe" });
  return fetch(`https://data.unwrangle.com/api/getter/?platform=target_search&search=water&api_key=${KEY}`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((j: any) => Number(j?.remaining_credits ?? 0)).catch(() => Infinity);
}

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const startedAt = Date.now();
  let written = 0, real = 0, uns = 0, skipped = 0;
  let pause = PAUSE_MIN;
  let consecutiveSkips = 0;
  const attempted = new Set<string>();

  // HARD credit guard (the omission that let a run drain past the floor 2026-07-08):
  // check real Unwrangle balance before every batch; stop cleanly below CREDIT_FLOOR.
  {
    const c0 = await unwrangleCredits();
    console.log(`starting Unwrangle credits: ${c0} (floor ${CREDIT_FLOOR})`);
    if (c0 < CREDIT_FLOOR) { console.log("below credit floor — not starting"); process.exit(0); }
  }

  while (written < CAP && Date.now() - startedAt < MAX_HOURS * 3_600_000) {
    if (await unwrangleCredits() < CREDIT_FLOOR) { console.log(`Unwrangle credits below floor ${CREDIT_FLOOR} — stopping to preserve reserve`); break; }
    // Cached-identity SKUs first (no vision → immune to lane congestion), then the
    // rest by sku ASC (the hourly cron picks syncedAt DESC → rarely collide).
    const r = await db.execute({
      sql: `SELECT w.sku, (s.sku IS NOT NULL) AS hasCache
            FROM WalmartCatalogItem w
            LEFT JOIN SkuShippingData s ON s.sku = w.sku AND s.productIdentity IS NOT NULL
            LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
            WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
            ORDER BY hasCache DESC, w.sku ASC LIMIT 400`,
      args: [],
    });
    // Neighbor-chat priority list first (division-of-labor contract): SKUs the image
    // chat needs enriched next, from Setting 'enrich_priority_skus'.
    const prio = (await enrichPrioritySkus(db)).filter((s) => !attempted.has(s));
    const prioUncosted: string[] = [];
    for (const s of prio.slice(0, 30)) {
      const c = await db.execute({ sql: `SELECT 1 FROM "SkuCost" WHERE sku=? AND source='retail:batch' LIMIT 1`, args: [s] });
      if (!c.rows.length) prioUncosted.push(s);
      else {
        // Already costed but the neighbor still asked for it → its donor probably has
        // no image gallery yet. Harvest detail (full gallery) so it lands in
        // EnrichedReadySku; mark attempted so we do this once per run.
        attempted.add(s);
        try {
          const d = await db.execute({ sql: `SELECT DISTINCT sc.donorProductId AS id FROM "SkuComponent" sc JOIN "DonorProduct" dp ON dp.id=sc.donorProductId WHERE sc.sku=? AND (dp.imageUrls IS NULL OR dp.imageUrls='[]')`, args: [s] });
          for (const row of d.rows) { try { await harvestDonorDetail(db, String((row as any).id)); } catch { /* best-effort */ } }
        } catch { /* best-effort */ }
      }
    }
    const skus = [...prioUncosted, ...r.rows.map((x: any) => x.sku as string).filter((s) => s && !attempted.has(s) && !prioUncosted.includes(s))].slice(0, 30);
    if (!skus.length) {
      const anyLeft = r.rows.length > 0;
      if (!anyLeft) { console.log("no more uncosted — catalog swept, DONE"); break; }
      console.log(`all ${r.rows.length}+ visible SKUs attempted this round — napping 15 min, then retrying (lanes may be back)`);
      await sleep(900_000);
      attempted.clear();
      pause = PAUSE_MIN;
      continue;
    }

    let idx = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (true) {
        const i = idx++;
        if (i >= skus.length || written >= CAP || Date.now() - startedAt > MAX_HOURS * 3_600_000) break;
        const sku = skus[i];
        attempted.add(sku);
        try {
          const res = await costOneSku(db, { sku, channel: "walmart", storeIndex: STORE_INDEX });
          if (res.status === "costed") { written++; real++; consecutiveSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
          else if (res.status === "no-price") { written++; uns++; consecutiveSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
          else { skipped++; consecutiveSkips++; pause = Math.min(PAUSE_MAX, pause * 2); } // lanes busy → retried later
        } catch { skipped++; consecutiveSkips++; pause = Math.min(PAUSE_MAX, pause * 2); }
        if ((real + uns + skipped) % 15 === 0) console.log(`progress: costed ${real} | unsourceable ${uns} | skipped(busy) ${skipped} | pause ${(pause / 1000).toFixed(0)}s`);
        if (consecutiveSkips >= 8) { console.log("lanes busy 8x in a row — yielding 10 min to the other run"); await sleep(600_000); consecutiveSkips = 0; pause = PAUSE_MIN; }
        else await sleep(pause);
      }
    }));
  }
  console.log(`\nCOOPERATIVE SWEEP DONE. costed ${real} | unsourceable ${uns} | skipped-for-later ${skipped} | hours ${(((Date.now() - startedAt) / 3_600_000)).toFixed(1)}`);
  process.exit(0);
})();
