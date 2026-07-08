// COGS engine — the shared per-SKU costing core, used by BOTH the CLI batch runner
// (scripts/cogs-enrich-batch.ts) and the background cron (/api/cron/cogs-sweep).
//
// For ONE of our listings it: identifies the exact product (title + description +
// ALL photos, bundles decomposed), then walks the COST LADDER:
//   TIER 0  own-brand   — our own products (Starfit / Salutem Vita), manual landed cost
//   TIER 1  exact 1P    — clean first-party direct price at Walmart/Target/Sam's/Costco
//   TIER 2  line-price  — same-brand + same-size sibling (variety line, ±cents)
//   TIER 3  google      — Google Shopping market estimate (universal fallback)
// then writes SkuCost (the roll-up total) + SkuComponent (the structural bill-of-
// materials, one row per part, each linked to its donor product for full content).
//
// No SKU is ever left without a number — the ladder always resolves to something,
// and anything soft (google/low-confidence) is flagged needsReview.

import { type Client } from "@libsql/client";
import {
  identifyProduct,
  gatherAmazonInputs,
  gatherWalmartInputs,
} from "@/lib/sourcing/identify";
import { enrichTarget, harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { oxylabsGoogleShoppingSearch } from "@/lib/sourcing/oxylabs-fetch";
import { ownBrandCost } from "@/lib/sourcing/own-brand-costs";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Global cap on concurrent retailer-search groups (each enrichTarget = 1 Oxylabs +
// up to 3 Unwrangle calls). Lets us fan out SKUs × bundle-components without blowing
// the paid-API rate limits. Module-global so it's shared across all callers in a run.
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
// Resumable sweep: prefer PUBLISHED SKUs NOT yet costed by this engine (LEFT JOIN
// SkuCost source='retail:batch' IS NULL). Each run advances through the catalog; a
// re-run continues where the last left off, and flagged/no-price SKUs (no SkuCost)
// get retried — which recovers the flaky niche items on a later pass.
export async function nextUncostedWalmartSkus(db: Client, n: number): Promise<string[]> {
  const r = await db.execute({
    sql: `SELECT w.sku FROM WalmartCatalogItem w
          LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
          WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
          ORDER BY w.syncedAt DESC LIMIT ?`,
    args: [n],
  });
  return r.rows.map((x: any) => x.sku as string).filter(Boolean);
}
// How many PUBLISHED Walmart SKUs still lack a cost (sweep progress denominator).
export async function walmartSweepRemaining(db: Client): Promise<{ remaining: number; total: number }> {
  const rem = await db.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem w LEFT JOIN "SkuCost" c ON c.sku=w.sku AND c.source='retail:batch' WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL`);
  const tot = await db.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem WHERE publishedStatus='PUBLISHED'`);
  return { remaining: Number((rem.rows[0] as any)?.n || 0), total: Number((tot.rows[0] as any)?.n || 0) };
}
export async function amazonSkus(n: number): Promise<string[]> {
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
    } catch { /* enumeration skipped for this store */ }
  }
  return out.slice(0, n);
}

// --- cost readback: cheapest clean 1P DIRECT per-unit for THE identified product ---
type CostHit = { perUnit: number; retailer: string; title: string; size: string; linePrice: boolean; google?: boolean; ownBrand?: boolean; donorProductId?: string | null };

// UNIVERSAL price fallback: when no clean 1P (exact or line-price sibling) exists at
// Walmart/Target/Sam's/Costco, look the product up on Google Shopping (Oxylabs).
async function googleShoppingCost(query: string, m: { brandTok: string; tokens: string[] }): Promise<CostHit | null> {
  let offers: any[] = [];
  try { offers = (await oxylabsGoogleShoppingSearch(query)).offers; } catch { return null; }
  const bw = m.brandTok;
  const cand = offers.filter((o) => {
    const t = (o.title || "").toLowerCase();
    if (o.price == null) return false;
    if (bw && !t.includes(bw)) return false;
    return m.tokens.every((tok) => t.includes(tok));
  });
  if (!cand.length) return null;
  cand.sort((a, b) => (a.price / (a.packSizeSeen || 1)) - (b.price / (b.packSizeSeen || 1)));
  const w = cand[0];
  return { perUnit: Math.round((w.price / (w.packSizeSeen || 1)) * 100) / 100, retailer: "google", title: w.title || "", size: "", linePrice: false, google: true };
}

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
    sql: `SELECT dp.id AS dpid, dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
          FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
          WHERE o.isFirstParty=1 AND o.via IN ('direct','instacart') AND o.pricePerUnit IS NOT NULL
            AND o.updatedAt >= ?${whereTok}
          ORDER BY ${sizeSel}, o.pricePerUnit ASC LIMIT 1`,
    args,
  })).rows[0];
  if (exact) {
    let perUnit = exact.perUnit as number;
    const ua = Number(exact.ua);
    // Cross-size normalize: if the matched 1P offer is a DIFFERENT size than our unit
    // (e.g. a 56oz Coffee-mate for our 22oz), convert by $/measure — otherwise we'd book
    // the bigger jar's price as our unit cost. Flagged as an estimate when sizes differ.
    const sizeDiffers = !!(m.sizeAmount && ua && Math.abs(ua - m.sizeAmount) / m.sizeAmount > 0.05);
    // GUARD: $/measure only scales sanely within ~a factor of 4. Converting a tiny
    // single-serve (1.1oz Jif cup) to a 13oz pouch books single-serve $/oz → 6x-inflated
    // COGS ($202 vs $57 sale). Outside the band → don't trust this match at all; fall
    // to line-price (same-size only) or honest unsourceable.
    const ratio = sizeDiffers && ua ? m.sizeAmount! / ua : 1;
    if (!sizeDiffers || (ratio >= 0.25 && ratio <= 4)) {
      if (sizeDiffers) perUnit = Math.round((exact.perUnit / ua) * m.sizeAmount! * 100) / 100;
      return { perUnit, retailer: exact.retailer, title: (exact.title as string) || "", size: `${exact.ua ?? ""}${exact.um ?? ""}`, linePrice: sizeDiffers, donorProductId: (exact.dpid as string) || null };
    }
  }

  // 2) LINE-PRICE fallback: exact flavor not sold 1P, but a same-brand + same-SIZE 1P
  // sibling exists (flavors in a line are ~one price). Requires a known size.
  if (m.brandTok && m.sizeAmount != null) {
    const sib: any = (await db.execute({
      sql: `SELECT dp.id AS dpid, dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
            FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
            WHERE o.isFirstParty=1 AND o.via IN ('direct','instacart') AND o.pricePerUnit IS NOT NULL
              AND o.updatedAt >= ? AND lower(dp.title) LIKE ? AND dp.unitAmount = ?
            ORDER BY o.pricePerUnit ASC LIMIT 1`,
      args: [sinceIso, `%${m.brandTok}%`, m.sizeAmount],
    })).rows[0];
    if (sib) return { perUnit: sib.perUnit, retailer: sib.retailer, title: (sib.title as string) || "", size: `${sib.ua ?? ""}${sib.um ?? ""}`, linePrice: true, donorProductId: (sib.dpid as string) || null };
  }
  return null;
}

// Write the structural bill-of-materials for one SKU: replace all its SkuComponent
// rows with a fresh set (one per part). Idempotent per run.
async function writeComponents(db: Client, sku: string, channel: string, parts: any[]): Promise<void> {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const now = new Date().toISOString();
  await db.execute({ sql: `DELETE FROM "SkuComponent" WHERE sku=?`, args: [sku] });
  for (const p of parts) {
    const perUnit = p.perUnit != null ? round2(p.perUnit) : null;
    const lineCost = p.perUnit != null ? round2(p.perUnit * p.qty) : null;
    await db.execute({
      sql: `INSERT INTO "SkuComponent"
        (id, sku, channel, idx, product, flavor, size, qty, perUnitCost, lineCost, currency,
         retailer, matchedTitle, costMethod, donorProductId, isBundleComponent, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        `comp:${sku}:${p.idx}`, sku, channel, p.idx, (p.product || "").slice(0, 200), p.flavor ?? null,
        p.size ?? null, p.qty ?? 1, perUnit, lineCost, "USD",
        p.retailer ?? null, (p.matched ?? "").slice(0, 200) || null, p.method ?? "none",
        p.donorProductId ?? null, p.isBundleComp ? 1 : 0, now, now,
      ],
    });
  }
}

// --- the per-SKU engine ------------------------------------------------------
export type CostResult = {
  sku: string;
  status: "costed" | "no-price" | "error" | "dry" | "no-input";
  cached?: boolean;
  total?: number;
  perUnit?: number;
  packSize?: number;
  needsReview?: boolean;
  methods?: string[]; // e.g. ["own-brand"] or ["exact","google"]
  note?: string;
  error?: string;
  logs: string[]; // human-readable per-SKU trace (CLI prints; cron ignores)
  identity?: any;
  parts?: any[];
};

export type CostOptions = {
  sku: string;
  channel: string; // walmart | amazon
  minConf?: number;
  openclaw?: boolean;
  openClawRetailers?: ("bjs" | "publix" | "aldi")[];
  reidentify?: boolean;
  dry?: boolean;
};

export async function costOneSku(db: Client, opts: CostOptions): Promise<CostResult> {
  const { sku } = opts;
  const CHANNEL = (opts.channel || "walmart").toLowerCase();
  const MIN_CONF = opts.minConf ?? 0.7;
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  try {
    // CACHE: identity is stable — reuse a prior identify (skips vision + SP-API/Veeqo)
    // unless reidentify. Prices/content are always re-fetched below.
    let identity: any = null;
    let cached = false;
    if (!opts.reidentify) {
      const cx = await db.execute({ sql: `SELECT productIdentity FROM SkuShippingData WHERE sku=? LIMIT 1`, args: [sku] });
      const pj = cx.rows[0]?.productIdentity as string | undefined;
      if (pj) { try { const p = JSON.parse(pj); if (p && p.brand) { identity = { imagesUsed: 0, components: [], ...p }; cached = true; } } catch { /* re-identify */ } }
    }
    if (!identity) {
      const inputs = CHANNEL === "amazon" ? await gatherAmazonInputs(sku) : await gatherWalmartInputs(db, sku);
      if (!inputs.found) { return { sku, status: "no-input", logs: [`❌ ${sku}: no title/photos found`] }; }
      identity = await identifyProduct(inputs);
      const nowI = new Date().toISOString();
      // UPSERT so identity caches even for SKUs with no SkuShippingData row yet.
      await db.execute({
        sql: `INSERT INTO SkuShippingData (id, sku, marketplace, productIdentity, unitsInListing, baseUnitDesc, source, createdAt, updatedAt)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(sku) DO UPDATE SET
                productIdentity=excluded.productIdentity, unitsInListing=excluded.unitsInListing,
                baseUnitDesc=excluded.baseUnitDesc, updatedAt=excluded.updatedAt`,
        args: [`ssd:cogs:${sku}`, sku, CHANNEL === "amazon" ? "Amazon" : "Walmart", JSON.stringify(identity), identity.units_in_listing ?? null, identity.base_unit ?? null, "cogs-identify", nowI, nowI],
      });
    }
    const lowConf = identity.confidence < MIN_CONF;

    log(`=== ${sku} ===${cached ? "  (cached identity)" : ""}`);
    log(`  → ${identity.brand} | ${identity.product_line} | ${identity.flavor} | ${identity.size} | ${identity.container_type}`);
    log(`  base unit : ${identity.base_unit}`);
    log(`  UNITS: ${identity.units_in_listing} (${identity.unit_basis})  bundle=${identity.is_bundle}${identity.components.length ? ` [${identity.components.length} comp]` : ""}`);
    if (identity.components.length) log(`  components: ${identity.components.map((c: any) => `${c.qty}× ${c.product}${c.size ? " " + c.size : ""}`).join(" | ")}`);
    log(`  confidence: ${identity.confidence}${lowConf ? "  ⚠️ BELOW THRESHOLD → needsReview" : ""}  ${identity.notes ? "— " + identity.notes : ""}`);

    if (opts.dry) { return { sku, status: "dry", cached, logs, identity }; }

    // Targets: bundle → each component; else → single base unit. Each carries the raw
    // product/flavor/size so we can write a SkuComponent row alongside the cost.
    const targets = identity.is_bundle && identity.components.length
      ? identity.components.map((c: any, i: number) => ({
          idx: i,
          query: [c.product, c.flavor, c.size].filter(Boolean).join(" "),
          brandTok: firstToken(c.product),
          tokens: distinctiveTokens(c.product, c.flavor),
          sizeAmount: parseSizeNum(c.size),
          qty: c.qty || 1,
          label: `${c.qty}× ${c.product}`,
          product: c.product || "",
          flavor: c.flavor || null,
          size: c.size || null,
          isBundleComp: true,
        }))
      : [{
          idx: 0,
          query: [identity.brand, identity.product_line, identity.flavor, identity.size].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(" ") || identity.retail_search_query,
          brandTok: firstToken(identity.brand),
          tokens: distinctiveTokens(identity.product_line, identity.flavor),
          sizeAmount: parseSizeNum(identity.size),
          qty: identity.units_in_listing || 1,
          label: identity.base_unit || identity.retail_search_query,
          product: identity.product_line || identity.brand || identity.base_unit || "",
          flavor: identity.flavor || null,
          size: identity.size || null,
          isBundleComp: false,
        }];

    const runStart = new Date().toISOString();
    type Part = { idx: number; label: string; product: string; flavor: string | null; size: string | null; qty: number; isBundleComp: boolean; perUnit: number | null; retailer?: string; matched?: string; method: string; linePrice?: boolean; google?: boolean; ownBrand?: boolean; donorProductId?: string | null };
    const parts: Part[] = [];
    let costable = true;

    await Promise.all(targets.map(async (t: any) => {
      const base = { idx: t.idx, label: t.label, product: t.product, flavor: t.flavor, size: t.size, qty: t.qty, isBundleComp: t.isBundleComp };

      // TIER 0 — OWN-BRAND manual cost: our own products have no retail donor.
      const ob = ownBrandCost({ brand: identity.brand, text: t.query, size: t.size, units: t.qty });
      if (ob) {
        parts.push({ ...base, perUnit: ob.perUnit, retailer: "own-brand", matched: ob.label, method: "own-brand", ownBrand: true, donorProductId: null });
        log(`  · ${t.label}  →  $${ob.perUnit.toFixed(2)}/u @ own-brand  «${ob.label}»`);
        return;
      }

      const res = await enrichWithRetry(db, {
        target: t.query,
        brand: t.brandTok || null,
        zip: "33765",
        // Oxylabs owns Walmart 1P → Unwrangle only for the Walmart-miss escalation
        // (Target 1cr, Sam's/Costco 10cr). Publix/BJ's via OpenClaw→Instacart (Aldi
        // skipped — Vladimir doesn't buy there). All run ONLY on a Walmart miss now.
        unwrangleRetailers: ["target", "samsclub", "costco"],
        openClawRetailers: opts.openClawRetailers || ["publix", "bjs"],
        allowNonGrocery: true, // COGS engine costs ANY resale product (food + household)
      });
      for (const pid of res.createdProductIds.slice(0, 1)) { try { await harvestDonorDetail(db, pid); } catch { /* best-effort */ } }

      // ONLY a clean first-party price counts as cost. Google is NOT used — it returns
      // 3P/reseller prices (often our OWN STARFITSTORE resale), which is not our cost.
      // No clean 1P at any local retailer → the target is UNSOURCEABLE (honest, actionable),
      // never a fake estimate. (Vladimir's rule: can't buy it 1P/locally → don't list it.)
      const cost = await cheapestCostForTarget(db, { brandTok: t.brandTok, tokens: t.tokens, sizeAmount: t.sizeAmount }, runStart);
      if (cost == null) { costable = false; parts.push({ ...base, perUnit: null, method: "unsourceable" }); }
      else parts.push({ ...base, perUnit: cost.perUnit, retailer: cost.retailer, matched: cost.title, method: cost.google ? "google" : cost.linePrice ? "line-price" : "exact", linePrice: cost.linePrice, google: cost.google, donorProductId: cost.donorProductId ?? null });
      log(`  · ${t.label}  →  ${cost ? `$${cost.perUnit.toFixed(2)}/u @ ${cost.retailer}${cost.google ? " (google est)" : cost.linePrice ? " (line-price est)" : ""}  «${(cost.title || "").slice(0, 46)}» ${cost.size}` : "no price anywhere"}  (hit ${res.retailersHit.join(",") || "none"}, rej ${res.rejected})`);
    }));
    parts.sort((a, b) => a.idx - b.idx);

    // COGS: bundle = Σ component perUnit×qty; single = perUnit × units_in_listing.
    const now = new Date().toISOString();
    const eff = now.slice(0, 10);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    let result: CostResult;

    if (costable && parts.length) {
      const listingCost = parts.reduce((s, p) => s + (p.perUnit || 0) * p.qty, 0);
      const total = round2(listingCost);
      const perUnitStore = identity.is_bundle ? total : round2(parts[0].perUnit || 0);
      const packSize = identity.is_bundle ? identity.components.reduce((s: number, c: any) => s + c.qty, 0) : (identity.units_in_listing || 1);
      const anyLine = parts.some((p) => p.linePrice);
      const anyGoogle = parts.some((p) => p.google);
      const anyOwnBrand = parts.some((p) => p.ownBrand);
      // SANITY GUARDRAIL: we never buy above our own sale price. COGS >= sale means
      // either a bad match (flag it) or a genuinely unprofitable listing (flag it too —
      // both need human eyes). Sale price from the Buy Box report when we have it.
      let aboveSale = false;
      try {
        const bb: any = (await db.execute({ sql: `SELECT sellerItemPrice p FROM WalmartBuyBoxItem WHERE sku=? AND sellerItemPrice IS NOT NULL LIMIT 1`, args: [sku] })).rows[0];
        if (bb?.p != null && total >= Number(bb.p)) aboveSale = true;
      } catch { /* no buy-box data — skip the check */ }
      const needsReview = (lowConf || anyGoogle || aboveSale) ? 1 : 0;
      const noteParts = (identity.is_bundle
        ? `bundle: ${parts.map((p) => `${p.qty}×$${(p.perUnit || 0).toFixed(2)}`).join(" + ")}`
        : `${parts[0].retailer} $${(parts[0].perUnit || 0).toFixed(2)}/u ×${identity.units_in_listing}`) + (anyGoogle ? " [google est]" : "") + (anyLine ? " [line-price est]" : "") + (anyOwnBrand ? " [own-brand]" : "") + (aboveSale ? " [COGS>=sale — check match or margin]" : "");
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
      // Keep ONE current row per SKU — drop stale rows from earlier days so the UI /
      // economics never show an out-of-date cost alongside the fresh one.
      await db.execute({ sql: `DELETE FROM "SkuCost" WHERE sku=? AND source='retail:batch' AND effectiveDate != ?`, args: [sku, eff] });
      log(`  → COGS $${total.toFixed(2)} (listing)${identity.is_bundle ? ` = ${parts.length} components summed` : ""}${anyGoogle ? "  [google est]" : ""}${anyLine ? "  [line-price est]" : ""}${needsReview ? "  [needsReview]" : ""}`);
      result = { sku, status: "costed", cached, total, perUnit: perUnitStore, packSize, needsReview: !!needsReview, methods: Array.from(new Set(parts.map((p) => p.method))), note: noteParts, logs, identity, parts };
    } else {
      log(`  → UNSOURCEABLE: no first-party price at Walmart/Target/Publix — candidate to delist (can't buy it 1P/locally)`);
      // Write an UNSOURCEABLE marker (totalCost NULL, needsReview) instead of a fake
      // number: it's honestly "no cost", visible in /cogs, and — having a SkuCost row —
      // is skipped by the resumable sweep so we don't re-probe it forever. Coverage
      // counts require totalCost IS NOT NULL, so it never inflates "costed".
      await db.execute({
        sql: `INSERT INTO "SkuCost" (id, sku, effectiveDate, totalCost, costPerUnit, packSize, includesPackaging, currency, source, confidence, needsReview, notes, createdAt, updatedAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(sku, source, effectiveDate) DO UPDATE SET totalCost=NULL, costPerUnit=NULL, needsReview=1, notes=excluded.notes, updatedAt=excluded.updatedAt`,
        args: [`retail:${sku}:batch:${eff}`, sku, eff, null, null, null, 0, "USD", "retail:batch", identity.confidence ?? null, 1, "UNSOURCEABLE: no first-party price at Walmart/Target/Publix — candidate to delist", now, now],
      });
      await db.execute({ sql: `DELETE FROM "SkuCost" WHERE sku=? AND source='retail:batch' AND effectiveDate != ?`, args: [sku, eff] });
      result = { sku, status: "no-price", cached, logs, identity, parts };
    }

    // Structural bill-of-materials (always written, even when a component had no price).
    await writeComponents(db, sku, CHANNEL, parts);
    return result;
  } catch (e: any) {
    return { sku, status: "error", error: String(e?.message).slice(0, 200), logs: [`💥 ${sku}: ${String(e?.message).slice(0, 120)}`] };
  }
}
