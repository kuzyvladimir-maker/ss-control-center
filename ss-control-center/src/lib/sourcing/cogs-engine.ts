// COGS engine — the shared per-SKU costing core, used by BOTH the CLI batch runner
// (scripts/cogs-enrich-batch.ts) and the background cron (/api/cron/cogs-sweep).
//
// For ONE of our listings it: identifies the exact product (title + description +
// ALL photos, bundles decomposed), then walks the COST LADDER:
//   TIER 0  own-brand   — our own products (Starfit / Salutem Vita), manual landed cost
//   TIER 1  exact 1P    — clean first-party direct price at Walmart/Target/Sam's/Costco
//   TIER 1b cross-size  — same product, 0.25x-4x size, converted by $/measure (est)
//   TIER 2  line-price  — same-brand + same-size sibling (variety line, ±cents)
//   (no Google tier: 3P reseller prices are not our cost — first-party or UNSOURCEABLE)
// then writes SkuCost (the roll-up total) + SkuComponent (the structural bill-of-
// materials, one row per part, each linked to its donor product for full content).
//
// Every estimate (cross-size / line-price / COGS>=sale / low-confidence) is flagged
// needsReview; no clean 1P anywhere → honest UNSOURCEABLE marker (delist candidate).

import { type Client } from "@libsql/client";
import {
  identifyProduct,
  gatherAmazonInputs,
  gatherWalmartInputs,
} from "@/lib/sourcing/identify";
import { enrichTarget, harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
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
// PRIORITY QUEUE (division-of-labor contract, 2026-07-08): the image/content chat
// consumes enriched SKUs and never identifies/searches itself. When it needs specific
// SKUs next, it writes them to Setting key 'enrich_priority_skus' (JSON array) and
// every enrichment driver here serves those FIRST.
export async function enrichPrioritySkus(db: Client): Promise<string[]> {
  try {
    const r = await db.execute(`SELECT value FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`);
    const v = JSON.parse(String((r.rows[0] as any)?.value || "[]"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch { return []; }
}

export async function nextUncostedWalmartSkus(db: Client, n: number): Promise<string[]> {
  // Neighbor-chat priority list first (only those still uncosted).
  const out: string[] = [];
  for (const sku of await enrichPrioritySkus(db)) {
    if (out.length >= n) break;
    const c = await db.execute({ sql: `SELECT 1 FROM "SkuCost" WHERE sku=? AND source='retail:batch' LIMIT 1`, args: [sku] });
    if (!c.rows.length) out.push(sku);
  }
  if (out.length < n) {
    const r = await db.execute({
      sql: `SELECT w.sku FROM WalmartCatalogItem w
            LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
            WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
            ORDER BY w.syncedAt DESC LIMIT ?`,
      args: [n],
    });
    for (const x of r.rows) { const s = (x as any).sku as string; if (s && !out.includes(s)) out.push(s); if (out.length >= n) break; }
  }
  return out;
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

// (Google Shopping as a COST source was removed: it returns 3P resellers — often our
// own STARFITSTORE resale — never a shelf price. First-party or UNSOURCEABLE.)

// Brand as tokens: up to 2 significant words ("Pasta Zara" → ["pasta","zara"]), all
// required in a match. A single first-token let cross-brand matches through (audit).
function brandTokens(...parts: (string | undefined)[]): string[] {
  const words = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  return words.filter((w) => w.length > 2 && !FILLER.has(w)).slice(0, 2);
}

// FORM/CATEGORY guard for sibling matches: a donor that introduces a form the target
// never mentioned is a DIFFERENT product category — Dove Promises candy must not be
// priced off Dove ICE-CREAM bars just because brand+size matched (audit error).
const FORM_MARKERS = ["frozen", "ice cream", "dessert", "gelato", "sorbet", "popsicle", "drink mix", "powder", "liquid", "k-cup", "pods", "dog", "cat", "shampoo", "detergent"];
function formMismatch(ourText: string, donorTitle: string): boolean {
  const a = ourText.toLowerCase(), b = (donorTitle || "").toLowerCase();
  return FORM_MARKERS.some((mk) => b.includes(mk) && !a.includes(mk));
}

async function cheapestCostForTarget(
  db: Client,
  m: { brandToks: string[]; tokens: string[]; sizeAmount: number | null; ourText: string },
  sinceIso: string,
): Promise<CostHit | null> {
  if (!m.brandToks.length && !m.tokens.length) return null;
  // Brand as a PHRASE: every significant brand word must appear. A single first-token
  // ("pasta" from "Pasta Zara") let Target's "Good & Gather Pasta" match cross-brand —
  // a confirmed audit error class.
  const like: string[] = [];
  const baseArgs: any[] = [sinceIso];
  for (const b of m.brandToks) { like.push("lower(dp.title) LIKE ?"); baseArgs.push(`%${b}%`); }
  for (const t of m.tokens) { like.push("lower(dp.title) LIKE ?"); baseArgs.push(`%${t}%`); }
  const whereTok = like.length ? " AND " + like.join(" AND ") : "";
  // Shared row shape. OOS offers excluded — Walmart/Target swap in 3P/clearance prices
  // exactly when the 1P card is out of stock (audit: $3.97 pack recorded off an OOS card).
  const SELECT = `SELECT dp.id AS dpid, dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
          FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
          WHERE o.isFirstParty=1 AND o.via IN ('direct','instacart') AND o.pricePerUnit IS NOT NULL
            AND (o.inStock IS NULL OR o.inStock=1)
            AND o.updatedAt >= ?`;
  // Every pick takes the top 5 and drops form-mismatched donors (see FORM_MARKERS).
  const pickOk = (rows: any[]): any => rows.find((r) => !formMismatch(m.ourText, r.title));
  const pick = async (sizeClause: string, extraArgs: any[], order = "o.pricePerUnit ASC"): Promise<any> =>
    pickOk((await db.execute({ sql: `${SELECT}${whereTok}${sizeClause} ORDER BY ${order} LIMIT 5`, args: [...baseArgs, ...extraArgs] })).rows as any[]);
  const hit = (r: any, est: boolean, perUnit?: number): CostHit => ({
    perUnit: perUnit ?? (r.perUnit as number), retailer: r.retailer, title: (r.title as string) || "",
    size: `${r.ua ?? ""}${r.um ?? ""}`, linePrice: est, donorProductId: (r.dpid as string) || null,
  });

  if (m.sizeAmount != null) {
    // TIER 1 — EXACT-STRICT: same product AND same size (±10%). The only "clean" class.
    const strict = await pick(` AND dp.unitAmount BETWEEN ? AND ?`, [m.sizeAmount * 0.9, m.sizeAmount * 1.1]);
    if (strict) return hit(strict, false);

    // TIER 2 — CROSS-SIZE estimate: same product, size within 0.25x–4x, converted by
    // $/measure, CLOSEST size first (not cheapest — a 5x jumbo's $/oz misleads).
    const cs = await pick(` AND dp.unitAmount BETWEEN ? AND ?`, [m.sizeAmount / 4, m.sizeAmount * 4], `ABS(dp.unitAmount - ${Number(m.sizeAmount)}) ASC, o.pricePerUnit ASC`);
    if (cs && Number(cs.ua)) {
      const perUnit = Math.round((cs.perUnit / Number(cs.ua)) * m.sizeAmount * 100) / 100;
      return hit(cs, true, perUnit);
    }

    // TIER 3 — LINE-PRICE sibling: same brand (phrase) + SAME size, different flavor,
    // AND sharing ≥1 product-line token — a sibling is a FLAVOR variant of the same
    // line, not any same-brand can (audit: Del Monte canned PEAS priced Del Monte
    // canned FRUIT — different line, different price tier).
    const sharesLine = (r: any) => !m.tokens.length || m.tokens.some((t) => String(r.title || "").toLowerCase().includes(t));
    if (m.brandToks.length) {
      const brandLike = m.brandToks.map(() => "lower(dp.title) LIKE ?").join(" AND ");
      const sib = ((rows: any[]) => rows.find((r) => !formMismatch(m.ourText, r.title) && sharesLine(r)))((await db.execute({
        sql: `SELECT dp.id AS dpid, dp.title AS title, o.retailer AS retailer, o.pricePerUnit AS perUnit, dp.unitAmount AS ua, dp.unitMeasure AS um
              FROM "DonorOffer" o JOIN "DonorProduct" dp ON dp.id = o.donorProductId
              WHERE o.isFirstParty=1 AND o.via IN ('direct','instacart') AND o.pricePerUnit IS NOT NULL
                AND (o.inStock IS NULL OR o.inStock=1)
                AND o.updatedAt >= ? AND ${brandLike} AND dp.unitAmount BETWEEN ? AND ?
              ORDER BY o.pricePerUnit ASC LIMIT 5`,
        args: [sinceIso, ...m.brandToks.map((b) => `%${b}%`), m.sizeAmount * 0.9, m.sizeAmount * 1.1],
      })).rows as any[]);
      if (sib) return hit(sib, true);
    }
    return null;
  }

  // Our size UNKNOWN — can't verify size compatibility, so any match is an ESTIMATE.
  const any = await pick("", []);
  return any ? hit(any, true) : null;
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
          brandToks: brandTokens(c.product),
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
          brandToks: brandTokens(identity.brand),
          tokens: distinctiveTokens(identity.product_line, identity.flavor),
          sizeAmount: parseSizeNum(identity.size),
          qty: identity.units_in_listing || 1,
          label: identity.base_unit || identity.retail_search_query,
          product: identity.product_line || identity.brand || identity.base_unit || "",
          flavor: identity.flavor || null,
          size: identity.size || null,
          isBundleComp: false,
        }];

    // Cost readback window: accept 1P offers refreshed within 7 DAYS, not just this
    // run. Retailer search is flaky day-to-day — the exact product often already sits
    // in the donor DB from a prior run (audit: Hormel $2.48, Nissin $0.50 were there
    // but filtered out by the this-run-only window), and a week-old shelf price is
    // still the shelf price.
    const runStart = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 48h: stale/poisoned captures age out fast
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
        // (Target 1cr, Sam's/Costco 10cr). Publix via OpenClaw browser (Aldi skipped —
        // Vladimir doesn't buy there). All run ONLY on a Walmart miss now.
        // ⛔ BJ'S DISABLED 2026-07-07: bjs.com's Akamai anti-bot tripped ("Access
        // Denied") after our sweep hammered /search — Vladimir's order. Do NOT
        // re-enable without a slow rate-limit + his explicit OK.
        // SS_SKIP_CLUBS=1 drops Sam's/Costco (10cr each) — the credit drain, mostly on
        // items that still end unsourceable. Club-only tail becomes a targeted pass.
        unwrangleRetailers: process.env.SS_SKIP_CLUBS === "1" ? ["target"] : ["target", "samsclub", "costco"],
        openClawRetailers: opts.openClawRetailers || ["publix"],
        allowNonGrocery: true, // COGS engine costs ANY resale product (food + household)
      });
      for (const pid of res.createdProductIds.slice(0, 1)) { try { await harvestDonorDetail(db, pid); } catch { /* best-effort */ } }

      // ONLY a clean first-party price counts as cost. Google is NOT used — it returns
      // 3P/reseller prices (often our OWN STARFITSTORE resale), which is not our cost.
      // No clean 1P at any local retailer → the target is UNSOURCEABLE (honest, actionable),
      // never a fake estimate. (Vladimir's rule: can't buy it 1P/locally → don't list it.)
      const cost = await cheapestCostForTarget(db, { brandToks: t.brandToks?.length ? t.brandToks : (t.brandTok ? [t.brandTok] : []), tokens: t.tokens, sizeAmount: t.sizeAmount, ourText: `${t.query} ${identity.container_type || ""}` }, runStart);
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
      // TRUTH POLICY: only exact-strict 1P rows are "clean". EVERY estimate (cross-size /
      // line-price / size-unknown) is needsReview — audits #2/#3 showed the estimate
      // classes carry 25-35% error and must never be presented as fact.
      const needsReview = (lowConf || anyGoogle || aboveSale || anyLine) ? 1 : 0;
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
        // [bjs-pending] — BJ's is temporarily disabled (Akamai block 2026-07-07), so
        // these misses never got their BJ's shot. When BJ's cools down, re-run JUST
        // this pool: SELECT sku FROM SkuCost WHERE notes LIKE '%bjs-pending%'.
        args: [`retail:${sku}:batch:${eff}`, sku, eff, null, null, null, 0, "USD", "retail:batch", identity.confidence ?? null, 1, "UNSOURCEABLE: no 1P at Walmart/Target/Publix [bjs-pending: retry when BJ's cools]", now, now],
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
