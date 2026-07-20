// Live-verification pass over FLAGGED (needsReview=1) COGS rows.
//
// Each estimate is based on a donor offer. This confirms that donor against the LIVE
// retailer detail (Unwrangle walmart_detail 2.5cr / target_detail 1cr) — the three
// audit error classes are all a bad donor:
//   • 3P leak   — seller is not the retailer itself   → REJECT (unsourceable)
//   • OOS price — in_stock=false (clearance/3P swap)   → REJECT (unsourceable)
//   • stale     — live price ≠ stored price            → CORRECT (rescale) then CONFIRM
// A donor that is 1P + in-stock at ~the stored price → CONFIRM (clear needsReview).
//
// Only walmart+target donors are verified (cheap detail). Sam's/Costco (10cr) and
// Publix (no detail API) stay flagged. Idempotent: [verified-live]/[verify-reject]
// tagged rows are skipped. Stops if Unwrangle credits fall below FLOOR.
//
//   npx tsx scripts/cogs-verify-flagged.ts
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { assertMeteredProviderCall } from "@/lib/sourcing/metered-call-guard";

throw new Error("LEGACY_COGS_MUTATION_SCRIPT_DISABLED: use immutable Product Truth observations and append-only SkuCost");

const clean = (v?: string) => (v || "").trim().replace(/^['"]|['"]$/g, "");
const KEY = clean(process.env.UNWRANGLE_API_KEY);
const FLOOR = 5000;               // never spend below this many credits
const CONC = 3;
const TOL = 0.15;                 // ±15% price tolerance = "same price"
const SELF: Record<string, RegExp> = { walmart: /walmart/i, target: /target/i };
const DETAIL: Record<string, string> = { walmart: "walmart_detail", target: "target_detail" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function liveDetail(retailer: string, url: string): Promise<{ price: number | null; is1P: boolean; inStock: boolean } | null> {
  const platform = DETAIL[retailer];
  if (!platform || !url) return null;
  assertMeteredProviderCall({ provider: "unwrangle", operation: "detail", units: retailer === "walmart" ? 2.5 : 1 });
  try {
    const r = await fetch(`https://data.unwrangle.com/api/getter/?platform=${platform}&url=${encodeURIComponent(url)}&api_key=${KEY}`, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const d = j?.detail || j?.product;
    if (!d || j?.success === false) return null;
    const seller = String(d.seller_name || "").trim();
    const is1P = !seller || (SELF[retailer] || /$^/).test(seller);
    return { price: typeof d.price === "number" ? d.price : (parseFloat(d.price) || null), is1P, inStock: d.in_stock !== false };
  } catch { return null; }
}

(async () => {
  const db = createClient({ url: clean(process.env.TURSO_DATABASE_URL), authToken: clean(process.env.TURSO_AUTH_TOKEN) });
  const rows = (await db.execute(`
    SELECT c.sku, c.totalCost, c.packSize, c.notes, sc.perUnitCost, sc.qty, sc.retailer, sc.donorProductId,
           b.sellerItemPrice AS ourSale,
           o.productUrl AS url, o.price AS donorPrice
    FROM "SkuCost" c
    JOIN "SkuComponent" sc ON sc.sku=c.sku AND sc.idx=0
    LEFT JOIN WalmartBuyBoxItem b ON b.sku=c.sku
    LEFT JOIN "DonorOffer" o ON o.donorProductId=sc.donorProductId AND o.retailer=sc.retailer
    WHERE c.source='retail:batch' AND c.needsReview=1 AND c.totalCost IS NOT NULL
      AND sc.retailer IN ('walmart','target')
      AND o.productUrl LIKE 'http%' AND o.price IS NOT NULL
      AND c.notes NOT LIKE '%verified-live%' AND c.notes NOT LIKE '%verify-reject%'
    ORDER BY c.sku`)).rows as any[];
  console.log(`VERIFY ${rows.length} flagged walmart/target rows (credit floor ${FLOOR})`);

  let idx = 0, confirmed = 0, corrected = 0, rejected = 0, skipped = 0;
  // Seed the real credit balance so the FLOOR guard actually protects the pool.
  assertMeteredProviderCall({ provider: "unwrangle", operation: "balance_probe" });
  let credits = await fetch(`https://data.unwrangle.com/api/getter/?platform=target_search&search=water&api_key=${KEY}`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((j: any) => Number(j?.remaining_credits ?? 0)).catch(() => 0);
  console.log(`starting credits: ${credits}`);
  if (credits < FLOOR) { console.log("below floor — aborting"); process.exit(0); }
  const LIMIT = Number(process.env.LIMIT || rows.length);
  const now = new Date().toISOString();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const i = idx++; if (i >= rows.length || i >= LIMIT) break;
      if (credits < FLOOR) { skipped++; continue; }
      const r = rows[i];
      const det = await liveDetail(r.retailer, r.url);
      credits -= (r.retailer === "walmart" ? 2.5 : 1); // approximate spend

      let decision = "", newTotal = r.totalCost, review = 1;
      if (!det) { skipped++; continue; }                                   // transient — retry next run
      if (!det.is1P || !det.inStock || det.price == null) {
        decision = "verify-reject (donor 3P/OOS/gone)"; rejected++;
        await db.execute({ sql: `UPDATE "SkuCost" SET totalCost=NULL, costPerUnit=NULL, needsReview=1, notes=? , updatedAt=? WHERE sku=? AND source='retail:batch'`,
          args: [String(r.notes || "").slice(0, 120) + " [verify-reject: donor 3P/OOS/gone → unsourceable]", now, r.sku] });
        continue;
      }
      const donorP = Number(r.donorPrice), pack = Number(r.packSize) || 1;
      const ratio = donorP > 0 && det.price > 0 ? det.price / donorP : 1; // can't rescale without both → confirm as-is
      if (!Number.isFinite(ratio) || Math.abs(ratio - 1) <= TOL) { decision = "confirmed"; confirmed++; }
      else {
        const newPerUnit = Math.round(Number(r.perUnitCost) * ratio * 100) / 100;
        const nt = Math.round(newPerUnit * pack * 100) / 100;
        if (Number.isFinite(nt) && nt > 0) {
          newTotal = nt; decision = `corrected ${r.totalCost}→${newTotal}`; corrected++;
          await db.execute({ sql: `UPDATE "SkuComponent" SET perUnitCost=?, lineCost=? WHERE sku=? AND idx=0`, args: [newPerUnit, Math.round(newPerUnit * (Number(r.qty) || 1) * 100) / 100, r.sku] });
        } else { decision = "confirmed"; confirmed++; }
      }
      // Verified-real price: clear needsReview UNLESS it still exceeds our sale price.
      const cpu = Number.isFinite(newTotal / pack) ? Math.round((newTotal / pack) * 100) / 100 : null;
      const aboveSale = r.ourSale != null && newTotal >= Number(r.ourSale);
      review = aboveSale ? 1 : 0;
      await db.execute({ sql: `UPDATE "SkuCost" SET totalCost=?, costPerUnit=?, needsReview=?, notes=?, updatedAt=? WHERE sku=? AND source='retail:batch'`,
        args: [newTotal, cpu, review, String(r.notes || "").slice(0, 110) + ` [verified-live${aboveSale ? " but>=sale" : ""}]`, now, r.sku] });
      if ((confirmed + corrected + rejected) % 15 === 0) console.log(`  ${confirmed + corrected + rejected}/${rows.length} | confirmed ${confirmed} corrected ${corrected} rejected ${rejected} | ~credits ${credits === Infinity ? "?" : Math.round(credits)}`);
      await sleep(200);
    }
  }));
  console.log(`\nVERIFY DONE. confirmed ${confirmed} | corrected ${corrected} | rejected→unsourceable ${rejected} | skipped(transient/floor) ${skipped}`);
  process.exit(0);
})();
