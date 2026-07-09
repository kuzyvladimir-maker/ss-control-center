// Amazon COGS sweep — same truth-engine + politeness as the Walmart cooperative sweep.
// NOTE: an Amazon LISTING is still costed from RETAIL (Walmart→Target→Publix→clubs), so
// this spends Unwrangle exactly like Walmart. Oxylabs only makes the Amazon *product
// data* free (identify inputs), not the retail sourcing.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
process.env.SS_VISION_FREE_ONLY = "1";
import { createClient } from "@libsql/client";
import { costOneSku, amazonSkus } from "@/lib/sourcing/cogs-engine";

const CAP = Math.max(1, parseInt(process.env.CAP || "600", 10));
const MAX_HOURS = parseFloat(process.env.MAX_HOURS || "10");
const CREDIT_FLOOR = Math.max(0, parseInt(process.env.CREDIT_FLOOR || "5000", 10));
const CONC = 2, PAUSE_MIN = 3_000, PAUSE_MAX = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function credits(): Promise<number> {
  const K = (process.env.UNWRANGLE_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  return fetch(`https://data.unwrangle.com/api/getter/?platform=target_search&search=water&api_key=${K}`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((j: any) => Number(j?.remaining_credits ?? 0)).catch(() => Infinity);
}

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const startedAt = Date.now();
  const c0 = await credits();
  console.log(`AMAZON sweep — starting credits ${c0} (floor ${CREDIT_FLOOR})`);
  if (c0 < CREDIT_FLOOR) { console.log("below floor — not starting"); process.exit(0); }

  console.log("enumerating Amazon SKUs (SP-API stores 1,3)…");
  const all = await amazonSkus(Number(process.env.ENUM || 2000));
  console.log(`enumerated ${all.length}`);
  // Skip ones already costed by this engine.
  const todo: string[] = [];
  for (const s of all) {
    const r = await db.execute({ sql: `SELECT 1 FROM "SkuCost" WHERE sku=? AND source='retail:batch' LIMIT 1`, args: [s] });
    if (!r.rows.length) todo.push(s);
  }
  console.log(`uncosted Amazon SKUs: ${todo.length}`);

  let idx = 0, written = 0, real = 0, uns = 0, skipped = 0, pause = PAUSE_MIN, consecSkips = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const i = idx++;
      if (i >= todo.length || written >= CAP || Date.now() - startedAt > MAX_HOURS * 3_600_000) break;
      if (i % 30 === 0 && (await credits()) < CREDIT_FLOOR) { console.log("credit floor — stopping"); break; }
      try {
        const res = await costOneSku(db, { sku: todo[i], channel: "amazon" });
        if (res.status === "costed") { written++; real++; consecSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
        else if (res.status === "no-price") { written++; uns++; consecSkips = 0; pause = Math.max(PAUSE_MIN, pause / 2); }
        else { skipped++; consecSkips++; pause = Math.min(PAUSE_MAX, pause * 2); }
      } catch { skipped++; consecSkips++; pause = Math.min(PAUSE_MAX, pause * 2); }
      if ((real + uns + skipped) % 15 === 0) console.log(`progress: costed ${real} | unsourceable ${uns} | skipped(busy) ${skipped} | pause ${(pause / 1000).toFixed(0)}s`);
      if (consecSkips >= 8) { console.log("lanes busy 8x — yielding 10 min"); await sleep(600_000); consecSkips = 0; pause = PAUSE_MIN; }
      else await sleep(pause);
    }
  }));
  console.log(`\nAMAZON SWEEP DONE. costed ${real} | unsourceable ${uns} | skipped ${skipped} | hours ${((Date.now() - startedAt) / 3_600_000).toFixed(1)}`);
  process.exit(0);
})();
