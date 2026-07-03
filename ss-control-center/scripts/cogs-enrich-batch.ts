// COGS enrichment BATCH runner (Vladimir "Variant A").
//
// For N of OUR listings on a channel, per SKU:
//   1. IDENTIFY   — title + description + bullets + ALL photos → exact product
//                   (bundles/kits/gift-sets decomposed into components).  [identify.ts]
//   2. GATE       — if identify confidence < threshold → flag needsReview.
//   3. SOURCE     — for each target (base unit, or every bundle component) search the
//                   live retailers (Unwrangle Walmart/Target/Sam's/Costco + OpenClaw
//                   BJ's/Publix/Aldi) with the junk/first-party gates, and harvest full
//                   content + ALL photos into the donor DB.               [donor-catalog.ts]
//   4. COST       — cheapest clean first-party DIRECT per-unit price per target;
//                   for a bundle, SUM component costs × qty.
//   5. WRITE      — SkuCost keyed by our SKU (+ identity onto SkuShippingData).
//
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 10
//   npx tsx scripts/cogs-enrich-batch.ts --channel amazon  --limit 10
//   npx tsx scripts/cogs-enrich-batch.ts SKU1 SKU2 ...              # explicit SKUs
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 3 --dry   # identify only, no paid search
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 10 --confidence 0.75

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient, type Client } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  identifyProduct,
  gatherAmazonInputs,
  gatherWalmartInputs,
  type ProductIdentity,
} from "@/lib/sourcing/identify";
import { enrichTarget, harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { openClawEnabled } from "@/lib/sourcing/openclaw-fetch";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["channel", "limit", "confidence", "concurrency"]);
const getArg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positional.push(a);
}
const CHANNEL = getArg("channel", "walmart").toLowerCase(); // walmart | amazon
const LIMIT = parseInt(getArg("limit", "10"), 10);
const MIN_CONF = parseFloat(getArg("confidence", "0.7"));
const DRY = argv.includes("--dry");
const REIDENTIFY = argv.includes("--reidentify"); // force re-identify even if cached

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Global cap on concurrent retailer-search groups (each enrichTarget = 1 Oxylabs +
// up to 3 Unwrangle calls). Lets us fan out SKUs × bundle-components without blowing
// the paid-API rate limits.
function makeSemaphore(max: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return {
    async acquire() { while (active >= max) await new Promise<void>((r) => q.push(r)); active++; },
    release() { active--; const n = q.shift(); if (n) n(); },
  };
}
const SEARCH_SEM = makeSemaphore(6);

// Retry enrichTarget once on a transient blip (Oxylabs/Unwrangle 5xx), under the
// global concurrency cap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichWithRetry(db: Client, opts: any, tries = 2): Promise<any> {
  await SEARCH_SEM.acquire();
  try {
    for (let i = 0; i < tries; i++) {
      try { return await enrichTarget(db, opts); }
      catch (e) { if (i === tries - 1) throw e; await sleep(1500); }
    }
  } finally { SEARCH_SEM.release(); }
}
const firstToken = (s?: string) => (s || "").trim().toLowerCase().split(/\s+/)[0] || "";

const FILLER = new Set(["the", "and", "with", "for", "of", "a", "an", "size", "oz", "lb", "lbs", "fl", "ml", "g", "kg", "ct", "count", "pack", "pk", "box", "boxes", "can", "cans", "bag", "bags", "cup", "cups", "pouch", "jar", "bottle", "loaf", "loaves", "tray", "case", "each", "variety", "original", "classic", "brand", "new"]);
// Distinctive lowercased words from the product line/flavor (or a component name) —
// used to pin the cost readback to the EXACT product, not just its brand.
function distinctiveTokens(...parts: (string | undefined)[]): string[] {
  const words = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  const out: string[] = []; const seen = new Set<string>();
  for (const w of words) { if (w.length < 3 || FILLER.has(w) || /^\d+$/.test(w) || seen.has(w)) continue; seen.add(w); out.push(w); }
  return out.slice(0, 3);
}
function parseSizeNum(size?: string | null): number | null {
  const m = String(size || "").match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// --- SKU enumeration --------------------------------------------------------
async function walmartSkus(db: Client, n: number): Promise<string[]> {
  // Resumable sweep: prefer PUBLISHED SKUs NOT yet costed by this engine (LEFT JOIN
  // SkuCost source='retail:batch' IS NULL). Each run advances through the catalog; a
  // re-run continues where the last left off, and flagged/no-price SKUs (no SkuCost)
  // get retried — which recovers the flaky niche items on a later pass.
  const r = await db.execute({
    sql: `SELECT w.sku FROM WalmartCatalogItem w
          LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
          WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
          ORDER BY w.syncedAt DESC LIMIT ?`,
    args: [n],
  });
  return r.rows.map((x: any) => x.sku as string).filter(Boolean);
}
async function amazonSkus(n: number): Promise<string[]> {
  const out: string[] = [];
  for (const store of [1, 3]) {
    if (out.length >= n) break;
    try {
      const sellerId = await getMerchantToken(store);
      let token: string | undefined;
      do {
        const page = await listSkus(store, sellerId, { pageSize: 20, includedData: ["summaries"], pageToken: token });
        for (const it of page.items) { if (it.sku) out.push(it.sku); if (out.length >= n) break; }
        token = page.pagination?.nextToken;
        await sleep(250);
      } while (token && out.length < n);
    } catch (e: any) {
      console.log(`  (store${store} enumeration skipped: ${String(e?.message).slice(0, 50)})`);
    }
  }
  return out.slice(0, n);
}

// --- cost readback: cheapest clean 1P DIRECT per-unit for THE identified product ---
// Matched on brand + distinctive line/flavor tokens (+ size preference), among offers
// sourced THIS run. Tight matching is what stops "Green Giant Sweet Peas" being priced
// off "Happy Harvest Green Beans", or a 17oz box off a 3oz box.
type CostHit = { perUnit: number; retailer: string; title: string; size: string; linePrice: boolean };
async function cheapestCostForTarget(
  db: Client,
  m: { brandTok: string; tokens: string[]; sizeAmount: number | null },
  sinceIso: string,
): Promise<CostHit | null> {
  if (!m.brandTok && !m.tokens.length) return null;
  // 1) EXACT: brand + all distinctive line/flavor tokens (+ size preference).
  const like: string[] = [];
  const args: any[] = [sinceIso];
  if (m.brandTok) { like.push("lower(dp.title) LIKE ?"); args.push(`%${m.brandTok}%`); }
  for (const t of m.tokens) { like.push("lower(dp.title) LIKE ?"); args.push(`%${t}%`); }
  const whereTok = like.length ? " AND " + like.join(" AND ") : "";
  const sizeSel = m.sizeAmount != null ? "CASE WHEN dp.unitAmount = ? THEN 0 ELSE 1 END" : "NULL";
  if (m.sizeAmount != null) args.push(m.sizeAmount);
  const exact: any = (await db.execute({
    sql: `SELECT dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
          FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
          WHERE o.isFirstParty=1 AND o.via='direct' AND o.pricePerUnit IS NOT NULL
            AND o.updatedAt >= ?${whereTok}
          ORDER BY ${sizeSel}, o.pricePerUnit ASC LIMIT 1`,
    args,
  })).rows[0];
  if (exact) return { perUnit: exact.perUnit, retailer: exact.retailer, title: (exact.title as string) || "", size: `${exact.ua ?? ""}${exact.um ?? ""}`, linePrice: false };

  // 2) LINE-PRICE fallback: the exact flavor isn't sold 1P, but a same-brand + same-SIZE
  // 1P sibling exists (flavors in a line are ~one price, ±cents). Requires a known size
  // to stay honest. Solves Klass/Hormel-style variety bundles. Flagged as an estimate.
  if (m.brandTok && m.sizeAmount != null) {
    const sib: any = (await db.execute({
      sql: `SELECT dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
            FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
            WHERE o.isFirstParty=1 AND o.via='direct' AND o.pricePerUnit IS NOT NULL
              AND o.updatedAt >= ? AND lower(dp.title) LIKE ? AND dp.unitAmount = ?
            ORDER BY o.pricePerUnit ASC LIMIT 1`,
      args: [sinceIso, `%${m.brandTok}%`, m.sizeAmount],
    })).rows[0];
    if (sib) return { perUnit: sib.perUnit, retailer: sib.retailer, title: (sib.title as string) || "", size: `${sib.ua ?? ""}${sib.um ?? ""}`, linePrice: true };
  }
  return null;
}

// --- main -------------------------------------------------------------------
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  // Paid APIs (Unwrangle: Walmart/Target/Sam's/Costco) are the default source. The
  // OpenClaw browser box (member-gated BJ's/Publix/Aldi) is OFF unless --openclaw is
  // passed — so a normal run never depends on the iMac being awake.
  const openclaw = argv.includes("--openclaw") && openClawEnabled();

  let skus = positional.length ? positional : CHANNEL === "amazon" ? await amazonSkus(LIMIT) : await walmartSkus(db, LIMIT);
  skus = skus.slice(0, positional.length ? skus.length : LIMIT);

  console.log(`\n=== COGS batch — channel=${CHANNEL} · ${skus.length} SKU · confidence≥${MIN_CONF} · openclaw=${openclaw ? "on" : "off"}${DRY ? " · DRY (identify only)" : ""} ===`);

  const snapshot: any[] = [];
  let costed = 0, review = 0, noPrice = 0;
  const CONCURRENCY = Math.max(1, parseInt(getArg("concurrency", "4"), 10));
  let _idx = 0;

  async function processSku(sku: string) {
    try {
      // CACHE: a product's IDENTITY is stable — reuse a prior identify (skips the
      // vision call AND the SP-API/Veeqo fetch) unless --reidentify. Prices/content are
      // always re-fetched below, so the cost data stays fresh; only identity is cached.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let identity: any = null;
      let cached = false;
      if (!REIDENTIFY) {
        const cx = await db.execute({ sql: `SELECT productIdentity FROM SkuShippingData WHERE sku=? LIMIT 1`, args: [sku] });
        const pj = cx.rows[0]?.productIdentity as string | undefined;
        if (pj) { try { const p = JSON.parse(pj); if (p && p.brand) { identity = { imagesUsed: 0, components: [], ...p }; cached = true; } } catch { /* fall through to re-identify */ } }
      }
      if (!identity) {
        const inputs = CHANNEL === "amazon" ? await gatherAmazonInputs(sku) : await gatherWalmartInputs(db, sku);
        if (!inputs.found) { console.log(`\n❌ ${sku}: no title/photos found`); return; }
        identity = await identifyProduct(inputs);
        const nowI = new Date().toISOString();
        await db.execute({
          sql: `UPDATE SkuShippingData SET productIdentity=?, unitsInListing=?, baseUnitDesc=?, updatedAt=? WHERE sku=?`,
          args: [JSON.stringify(identity), identity.units_in_listing ?? null, identity.base_unit ?? null, nowI, sku],
        });
      }
      const lowConf = identity.confidence < MIN_CONF;

      console.log(`\n=== ${sku} ===${cached ? "  (cached identity)" : ""}`);
      console.log(`  → ${identity.brand} | ${identity.product_line} | ${identity.flavor} | ${identity.size} | ${identity.container_type}`);
      console.log(`  base unit : ${identity.base_unit}`);
      console.log(`  UNITS: ${identity.units_in_listing} (${identity.unit_basis})  bundle=${identity.is_bundle}${identity.components.length ? ` [${identity.components.length} comp]` : ""}`);
      if (identity.components.length) console.log(`  components: ${identity.components.map((c: any) => `${c.qty}× ${c.product}${c.size ? " " + c.size : ""}`).join(" | ")}`);
      console.log(`  confidence: ${identity.confidence}${lowConf ? "  ⚠️ BELOW THRESHOLD → needsReview" : ""}  ${identity.notes ? "— " + identity.notes : ""}`);

      if (DRY) { snapshot.push({ sku, identity, dry: true }); return; }

      // Targets: bundle → each component; else → single base unit.
      const targets = identity.is_bundle && identity.components.length
        ? identity.components.map((c: any) => ({
            query: [c.product, c.flavor, c.size].filter(Boolean).join(" "),
            brandTok: firstToken(c.product),
            tokens: distinctiveTokens(c.product, c.flavor),
            sizeAmount: parseSizeNum(c.size),
            qty: c.qty,
            label: `${c.qty}× ${c.product}`,
          }))
        : [{
            // Clean structured query (brand + line + flavor + size), deduped — reads
            // better on the retailer search than a verbose base_unit sentence.
            query: [identity.brand, identity.product_line, identity.flavor, identity.size].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(" ") || identity.retail_search_query,
            brandTok: firstToken(identity.brand),
            tokens: distinctiveTokens(identity.product_line, identity.flavor),
            sizeAmount: parseSizeNum(identity.size),
            qty: identity.units_in_listing || 1,
            label: identity.base_unit || identity.retail_search_query,
          }];

      const runStart = new Date().toISOString();
      const parts: { label: string; qty: number; perUnit: number | null; retailer?: string; matched?: string; linePrice?: boolean }[] = [];
      let costable = true;

      await Promise.all(targets.map(async (t) => {
        const res = await enrichWithRetry(db, {
          target: t.query,
          brand: t.brandTok || null,
          zip: "33765",
          unwrangleRetailers: ["walmart", "target", "samsclub", "costco"],
          openClawRetailers: openclaw ? ["bjs", "publix", "aldi"] : [],
          allowNonGrocery: true, // COGS engine costs ANY resale product (food + household)
        });
        // Light harvest of the first fresh product for immediate content; the full
        // gallery/nutrition harvest of every product is done by the reference-harvest cron.
        for (const pid of res.createdProductIds.slice(0, 1)) { try { await harvestDonorDetail(db, pid); } catch { /* best-effort */ } }

        const cost = await cheapestCostForTarget(db, { brandTok: t.brandTok, tokens: t.tokens, sizeAmount: t.sizeAmount }, runStart);
        if (cost == null) { costable = false; parts.push({ label: t.label, qty: t.qty, perUnit: null }); }
        else parts.push({ label: t.label, qty: t.qty, perUnit: cost.perUnit, retailer: cost.retailer, matched: cost.title, linePrice: cost.linePrice });
        console.log(`  · ${t.label}  →  ${cost ? `$${cost.perUnit.toFixed(2)}/u @ ${cost.retailer}${cost.linePrice ? " (line-price est)" : ""}  «${(cost.title || "").slice(0, 46)}» ${cost.size}` : "no clean 1P match"}  (hit ${res.retailersHit.join(",") || "none"}, rej ${res.rejected})`);
      }));

      // COGS: bundle = Σ component perUnit×qty; single = perUnit × units_in_listing.
      const now = new Date().toISOString();
      const eff = now.slice(0, 10);
      if (costable && parts.length) {
        const listingCost = parts.reduce((s, p) => s + (p.perUnit || 0) * p.qty, 0);
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const total = round2(listingCost);
        const perUnitStore = identity.is_bundle ? total : round2(parts[0].perUnit || 0);
        const packSize = identity.is_bundle ? identity.components.reduce((s: number, c: any) => s + c.qty, 0) : (identity.units_in_listing || 1);
        const anyLine = parts.some((p) => p.linePrice);
        const needsReview = lowConf ? 1 : 0;
        const noteParts = (identity.is_bundle
          ? `bundle: ${parts.map((p) => `${p.qty}×$${(p.perUnit || 0).toFixed(2)}`).join(" + ")}`
          : `${parts[0].retailer} $${(parts[0].perUnit || 0).toFixed(2)}/u ×${identity.units_in_listing}`) + (anyLine ? " [line-price est]" : "");
        await db.execute({
          sql: `INSERT INTO "SkuCost"
            (id, sku, effectiveDate, productCost, totalCost, costPerUnit, packSize, includesPackaging,
             currency, source, confidence, needsReview, notes, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(sku, source, effectiveDate) DO UPDATE SET
              productCost=excluded.productCost, totalCost=excluded.totalCost, costPerUnit=excluded.costPerUnit,
              packSize=excluded.packSize, confidence=excluded.confidence, needsReview=excluded.needsReview,
              notes=excluded.notes, updatedAt=excluded.updatedAt`,
          args: [
            `retail:${sku}:batch:${eff}`, sku, eff, total, total, perUnitStore, packSize, 0,
            "USD", "retail:batch", identity.confidence ?? null, needsReview, noteParts.slice(0, 180), now, now,
          ],
        });
        costed++; if (needsReview) review++;
        console.log(`  → COGS $${total.toFixed(2)} (listing)${identity.is_bundle ? ` = ${parts.length} components summed` : ""}${anyLine ? "  [line-price est]" : ""}${needsReview ? "  [needsReview: low confidence]" : ""}`);
      } else {
        noPrice++;
        console.log(`  → NO clean COGS (some target lacked a 1P price) — flagged for review`);
      }

      snapshot.push({ sku, identity, parts, costable, lowConf });
    } catch (e: any) {
      console.log(`\n💥 ${sku}: ${String(e?.message).slice(0, 120)}`);
    }
  }

  // Concurrency pool: process CONCURRENCY SKUs at once (each SKU's retailer calls stay
  // sequential, but N SKUs overlap → ~N× throughput). SkuCost is written per-SKU so a
  // kill mid-run keeps progress; the resumable query skips already-costed SKUs.
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, async () => {
    while (true) {
      const i = _idx++;
      if (i >= skus.length) break;
      await processSku(skus[i]);
    }
  }));

  mkdirSync("../docs/sourcing", { recursive: true });
  const out = `../docs/sourcing/batch-${CHANNEL}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Done. ${skus.length} SKU · costed ${costed} (of those ${review} low-confidence review) · no-price ${noPrice}${DRY ? " · DRY" : ""}`);
  console.log(`   snapshot → ${out}`);
})();
