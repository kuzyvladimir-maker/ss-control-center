// Walmart multipack fix — BATCH live publish via MP_MAINTENANCE (spec-correct).
//
//   npx tsx scripts/walmart-multipack-batch.ts SKU1 SKU2 ...
//
// Phase 1: for each SKU generate tiled main + badge, upload to R2, submit an
//   MP_MAINTENANCE feed (header businessUnit=WALMART_US/locale/version; partial
//   Visible update of productName + description + keyFeatures + mainImageUrl +
//   one secondary badge image). Collect feedIds.
// Phase 2: poll all feeds together until terminal (or ~3h cap).
// Phase 3: write ../preview-multipack/BATCH-REPORT.md with status + walmart URL.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getWalmartClient } from "../src/lib/walmart/client";
import { composeTiledMainImage, renderBadgeImage, fetchImageBuffer, highResImageUrl } from "../src/lib/walmart/multipack/composite";
import { rewriteMultipackContent, inferUnitNoun } from "../src/lib/walmart/multipack/content";
import { uploadToR2, multipackImageKey } from "../src/lib/walmart/multipack/r2";

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const SPEC_VERSION = "5.0.20260330-14_47_14-api";
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Date.now().toString().slice(-5);
const OUT = join(process.cwd(), "..", "preview-multipack");

interface Job { sku: string; packCount: number; noun: string; feedId: string | null; url: string; title: string; status: string; detail: string; }

async function loadCandidate(sku: string) {
  const w = await db.execute({
    sql: `SELECT w.title AS wtitle, COALESCE(s.unitsInListing,c.packSize) AS pack
          FROM WalmartCatalogItem w
          LEFT JOIN SkuShippingData s ON s.sku=w.sku
          LEFT JOIN SkuCost c ON c.sku=w.sku WHERE w.sku=? LIMIT 1`,
    args: [sku],
  });
  const wr = w.rows[0] as any;
  if (!wr) return null;
  const r = await db.execute({
    sql: `SELECT imageUrls FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != ''
          ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`,
    args: [sku],
  });
  const rr = r.rows[0] as any;
  if (!rr) return null;
  let imgs: string[] = [];
  try { imgs = JSON.parse(rr.imageUrls); } catch { imgs = [rr.imageUrls]; }
  const raw = imgs.find((u) => typeof u === "string" && u.startsWith("http")) ?? "";
  if (!raw) return null;
  return { sku, walmartTitle: wr.wtitle ?? sku, packCount: Number(wr.pack) || 2, baseImageUrl: highResImageUrl(raw) };
}

function buildPayload(a: { sku: string; upc: string; brand: string; productType: string; productName: string; shortDescription: string; keyFeatures: string[]; mainImageUrl: string; secondaryImageUrl: string; }) {
  return {
    MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
    MPItem: [{
      Orderable: { sku: a.sku, productIdentifiers: { productIdType: "UPC", productId: a.upc } },
      Visible: { [a.productType]: {
        productName: a.productName, brand: a.brand, shortDescription: a.shortDescription,
        keyFeatures: a.keyFeatures, mainImageUrl: a.mainImageUrl,
        productSecondaryImageURL: [a.secondaryImageUrl],
      } },
    }],
  };
}

async function buyerUrl(client: any, upc: string, packCount: number): Promise<string> {
  try {
    const s: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
    const items = s?.items ?? [];
    const match = items.find((it: any) => new RegExp(`pack of ${packCount}\\b`, "i").test(it.title || "")) || items[0];
    return match ? `https://www.walmart.com/ip/${match.itemId}` : "(url pending)";
  } catch { return "(url pending)"; }
}

async function main() {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.log("pass SKUs"); return; }
  mkdirSync(OUT, { recursive: true });
  const client = getWalmartClient(1);
  const jobs: Job[] = [];

  // Phase 1 — generate, upload, submit
  for (const sku of skus) {
    try {
      const itemRes: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
      const cur = itemRes?.ItemResponse?.[0];
      if (!cur) { jobs.push({ sku, packCount: 0, noun: "", feedId: null, url: "—", title: "—", status: "SKIP", detail: "not found on Walmart" }); continue; }
      const upc = cur.upc, productType = cur.productType;
      const cand = await loadCandidate(sku);
      if (!cand) { jobs.push({ sku, packCount: 0, noun: "", feedId: null, url: "—", title: "—", status: "SKIP", detail: "no donor photo/pack" }); continue; }
      const noun = inferUnitNoun(cand.walmartTitle);
      const content = rewriteMultipackContent(cand.walmartTitle, cand.packCount, { noun });
      const sc: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
      const brand = sc?.items?.[0]?.brand || cand.walmartTitle.split(" ")[0];

      const base = await fetchImageBuffer(cand.baseImageUrl);
      const main = await composeTiledMainImage(base, cand.packCount);
      const badge = await renderBadgeImage(base, cand.packCount, { noun });
      const mainUrl = await uploadToR2(main, multipackImageKey(sku, "main", STAMP));
      const badgeUrl = await uploadToR2(badge, multipackImageKey(sku, "badge", STAMP));

      const payload = buildPayload({ sku, upc, brand, productType, productName: content.title, shortDescription: content.description, keyFeatures: content.bullets, mainImageUrl: mainUrl, secondaryImageUrl: badgeUrl });
      const resp: any = await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload });
      const feedId = resp.body?.feedId ?? null;
      const url = await buyerUrl(client, upc, cand.packCount);
      jobs.push({ sku, packCount: cand.packCount, noun, feedId, url, title: content.title, status: feedId ? "SUBMITTED" : "POST_FAILED", detail: feedId ? "" : JSON.stringify(resp.body).slice(0, 120) });
      console.log(`${sku}: feedId=${feedId} url=${url}`);
    } catch (e: any) {
      jobs.push({ sku, packCount: 0, noun: "", feedId: null, url: "—", title: "—", status: "ERROR", detail: e?.message?.slice(0, 100) });
      console.log(`${sku}: EXCEPTION ${e?.message}`);
    }
  }

  // Phase 2 — poll all submitted feeds together (~3h cap)
  const pending = () => jobs.filter((j) => j.feedId && j.status !== "PROCESSED" && j.status !== "ERROR");
  for (let round = 0; round < 60 && pending().length; round++) {
    await new Promise((r) => setTimeout(r, 30000));
    for (const j of pending()) {
      try {
        const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(j.feedId!)}`, { params: { includeDetails: "true" } })).body;
        const st = d?.feedStatus;
        if (st === "PROCESSED" || st === "ERROR") {
          j.status = st;
          j.detail = `ok=${d.itemsSucceeded} fail=${d.itemsFailed}`;
          const errs = d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError ?? [];
          if (errs.length) j.detail += " — " + errs.map((e: any) => e.field).join(", ");
        }
      } catch { /* keep polling */ }
    }
    console.log(`round ${round}: pending=${pending().length}`);
  }

  // Phase 3 — report
  const rows = jobs.map((j) => `| ${j.sku} | ${j.packCount ? j.packCount + "× " + j.noun : "—"} | ${j.status} ${j.detail} | ${j.url} |`).join("\n");
  const report = `# Walmart multipack — batch report (${STAMP})\n\n` +
    `Feed: MP_MAINTENANCE, spec ${SPEC_VERSION}. ok=1 fail=0 = update accepted into catalog; ` +
    `storefront image/title propagates over the following minutes-to-hours.\n\n` +
    `| SKU | Pack | Feed result | walmart.com |\n|---|---|---|---|\n${rows}\n`;
  writeFileSync(join(OUT, "BATCH-REPORT.md"), report);
  console.log("\n" + report);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
