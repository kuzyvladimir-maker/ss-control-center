// Walmart multipack fix — LIVE publish for ONE sku (BODYARMOR by default).
//
//   npx tsx scripts/walmart-multipack-golive.ts FaisalX-2272 --submit
//
// Without --submit it only prints the payload (dry). With --submit it POSTs
// the MP_ITEM update feed, polls until terminal, prints ingestion result,
// then re-GETs the item to confirm price/UPC/productType/published intact.
//
// SAFE: a feed that fails ingestion does NOT change the live listing — only a
// SUCCESS-ingested item is updated. So an imperfect schema is non-destructive.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { getWalmartClient } from "../src/lib/walmart/client";
import { composeTiledMainImage, renderBadgeImage, fetchImageBuffer, highResImageUrl } from "../src/lib/walmart/multipack/composite";
import { rewriteMultipackContent, inferUnitNoun } from "../src/lib/walmart/multipack/content";
import { uploadToR2, multipackImageKey } from "../src/lib/walmart/multipack/r2";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Date.now().toString().slice(-5);

async function getCatalogContent(client: any, upc: string) {
  const s: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
  const it = s?.items?.[0];
  return it ? { brand: it.brand, productType: it.productType, description: it.description, title: it.title } : null;
}

async function loadCandidate(sku: string) {
  const w = await db.execute({
    sql: `SELECT w.title AS wtitle, w.itemId, COALESCE(s.unitsInListing,c.packSize) AS pack
          FROM WalmartCatalogItem w
          LEFT JOIN SkuShippingData s ON s.sku=w.sku
          LEFT JOIN SkuCost c ON c.sku=w.sku
          WHERE w.sku=? LIMIT 1`,
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
  return { sku, walmartTitle: wr.wtitle ?? sku, packCount: Number(wr.pack) || 2, baseImageUrl: highResImageUrl(raw) };
}

function buildMpItem(args: {
  sku: string; upc: string; brand: string; productType: string;
  productName: string; shortDescription: string; keyFeatures: string[];
  mainImageUrl: string; secondaryImageUrls: string[];
}) {
  // Built to the authoritative MP_MAINTENANCE 5.0 spec (POST /v3/items/spec):
  //  - Header requires ONLY businessUnit(enum WALMART_US)/locale/version.
  //    sellingChannel/subset/mart are NOT valid header fields.
  //  - Orderable requires only sku + productIdentifiers.
  //  - Visible[productType] has no required fields → partial update of just
  //    the fields we change. productSecondaryImageURL minItems=1 here (the
  //    >=4 rule is MP_ITEM full-setup only), so the badge can ride along.
  const visible: Record<string, unknown> = {
    productName: args.productName,
    brand: args.brand,
    shortDescription: args.shortDescription,
    keyFeatures: args.keyFeatures,
    mainImageUrl: args.mainImageUrl,
  };
  if (args.secondaryImageUrls.length >= 1) {
    visible.productSecondaryImageURL = args.secondaryImageUrls;
  }
  return {
    MPItemFeedHeader: {
      businessUnit: "WALMART_US",
      locale: "en",
      version: "5.0.20260330-14_47_14-api",
    },
    MPItem: [
      {
        Orderable: {
          sku: args.sku,
          productIdentifiers: { productIdType: "UPC", productId: args.upc },
        },
        Visible: { [args.productType]: visible },
      },
    ],
  };
}

async function poll(client: any, feedId: string) {
  for (let i = 0; i < 30; i++) {
    const res = await client.requestRaw("GET", `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: "true" } });
    const b: any = res.body;
    const st = b?.feedStatus;
    process.stdout.write(`  poll ${i}: ${st} (recv=${b?.itemsReceived} ok=${b?.itemsSucceeded} fail=${b?.itemsFailed} proc=${b?.itemsProcessing})\n`);
    if (st === "PROCESSED" || st === "ERROR") return b;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function main() {
  const sku = process.argv[2] || "FaisalX-2272";
  const submit = process.argv.includes("--submit");
  const client = getWalmartClient(1);

  // current live item
  const itemRes: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
  const cur = itemRes?.ItemResponse?.[0];
  if (!cur) { console.log("item not found"); return; }
  const upc = cur.upc;
  const price = cur.price?.amount ?? 0;
  console.log(`Live: ${cur.productName}\n  upc=${upc} price=$${price} productType=${cur.productType} status=${cur.publishedStatus}`);

  const cat = await getCatalogContent(client, upc);
  const brand = cat?.brand || cur.productName.split(" ")[0];
  const productType = cur.productType;

  const cand = await loadCandidate(sku);
  if (!cand) { console.log("no donor candidate"); return; }
  const noun = inferUnitNoun(cand.walmartTitle);
  const content = rewriteMultipackContent(cand.walmartTitle, cand.packCount, { noun });

  const base = await fetchImageBuffer(cand.baseImageUrl);
  const main = await composeTiledMainImage(base, cand.packCount);
  const badge = await renderBadgeImage(base, cand.packCount, { noun });
  const mainUrl = await uploadToR2(main, multipackImageKey(sku, "main", STAMP));
  const badgeUrl = await uploadToR2(badge, multipackImageKey(sku, "badge", STAMP));
  console.log(`  main=${mainUrl}\n  badge=${badgeUrl}`);

  const feedType = process.env.FEED_TYPE || "MP_MAINTENANCE";
  const payload = buildMpItem({
    sku, upc, brand, productType,
    productName: content.title,
    shortDescription: content.description,
    keyFeatures: content.bullets,
    mainImageUrl: mainUrl, secondaryImageUrls: [badgeUrl],
  });
  console.log(`\nfeedType=${feedType}\nPAYLOAD:\n` + JSON.stringify(payload, null, 2));

  if (!submit) { console.log("\n(dry — pass --submit to POST the feed)"); return; }

  console.log(`\nSubmitting ${feedType} feed…`);
  const resp: any = (await client.requestRaw("POST", "/feeds", { params: { feedType }, body: payload }));
  console.log("POST status:", resp.status, JSON.stringify(resp.body).slice(0, 400));
  const feedId = resp.body?.feedId;
  if (!feedId) { console.log("no feedId — aborting"); return; }
  console.log("feedId:", feedId);

  const final = await poll(client, feedId);
  if (final) {
    const items = final?.itemDetails?.itemIngestionStatus ?? [];
    for (const it of items) {
      console.log(`\n  item ${it.sku}: ${it.ingestionStatus}`);
      const errs = it.ingestionErrors?.ingestionError ?? [];
      for (const e of errs) console.log(`    [${e.type}] ${e.code}: ${e.description}`);
    }
  }

  // confirm live item intact
  const after: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
  const a = after?.ItemResponse?.[0];
  console.log(`\nAFTER: ${a?.productName}\n  price=$${a?.price?.amount} status=${a?.publishedStatus} lifecycle=${a?.lifecycleStatus}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
