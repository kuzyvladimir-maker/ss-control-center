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
import { buildMultipackListing, inferUnitNoun, quantityLeadSentence, scrubBrandVoice } from "../src/lib/walmart/multipack/content";
import { uploadToR2, multipackImageKey } from "../src/lib/walmart/multipack/r2";
import { fetchDonorDetail } from "../src/lib/walmart/multipack/donor";
import { polishListingCopy } from "../src/lib/walmart/multipack/polish";
import { validateListingContent } from "../src/lib/walmart/multipack/guidelines";
import { logRemediation } from "../src/lib/walmart/multipack/analytics";

const DONOR_IMAGE_CAP = 6; // total images = generated main + badge + up to this many real donor images

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const SPEC_VERSION = "5.0.20260330-14_47_14-api";
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Date.now().toString().slice(-5);
const OUT = join(process.cwd(), "..", "preview-multipack");

interface Job { sku: string; packCount: number; noun: string; feedId: string | null; url: string; title: string; status: string; detail: string; meta?: any; }

/** Known content gaps for this SKU from the listing-quality mirror (closed loop). */
async function itemContentIssues(sku: string): Promise<string[]> {
  try {
    const r = await db.execute({ sql: `SELECT issuesSummary FROM WalmartListingQualityItem WHERE sku=? LIMIT 1`, args: [sku] });
    const raw = (r.rows[0] as any)?.issuesSummary;
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    // Only CONTENT issues are fixable via our copy/images; skip shipping/reviews.
    return parsed
      .filter((x: any) => x && x.component === "content")
      .map((x: any) => `${x.title}${x.detail && x.detail !== x.title ? ` — ${x.detail}` : ""}`)
      .filter(Boolean)
      .slice(0, 12);
  } catch { return []; }
}

async function loadCandidate(sku: string, liveTitle: string) {
  // Pack count straight from our SKU tables — do NOT depend on the
  // WalmartCatalogItem mirror (nightly sync can drop rows). Title comes from the
  // live Walmart item passed in by the caller.
  const p = await db.execute({
    sql: `SELECT COALESCE(s.unitsInListing, c.packSize) AS pack
          FROM (SELECT ? AS sku) k
          LEFT JOIN SkuShippingData s ON s.sku=k.sku
          LEFT JOIN SkuCost c ON c.sku=k.sku LIMIT 1`,
    args: [sku],
  });
  const pack = Number((p.rows[0] as any)?.pack) || 0;
  if (pack < 2) return null; // not a multipack
  const r = await db.execute({
    sql: `SELECT imageUrls, retailerProductId FROM RetailPrice
          WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != '' AND sourceApi='bluecart'
          ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`,
    args: [sku],
  });
  const rr = r.rows[0] as any;
  if (!rr) return null;
  let imgs: string[] = [];
  try { imgs = JSON.parse(rr.imageUrls); } catch { imgs = [rr.imageUrls]; }
  const raw = imgs.find((u) => typeof u === "string" && u.startsWith("http")) ?? "";
  if (!raw) return null;
  return { sku, walmartTitle: liveTitle || sku, packCount: pack, baseImageUrl: highResImageUrl(raw), itemId: String(rr.retailerProductId || "") };
}

function buildPayload(a: { sku: string; upc: string; brand: string; productType: string; productName: string; shortDescription: string; keyFeatures: string[]; mainImageUrl: string; secondaryImageUrls: string[]; }) {
  return {
    MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
    MPItem: [{
      Orderable: { sku: a.sku, productIdentifiers: { productIdType: "UPC", productId: a.upc } },
      Visible: { [a.productType]: {
        productName: a.productName, brand: a.brand, shortDescription: a.shortDescription,
        keyFeatures: a.keyFeatures, mainImageUrl: a.mainImageUrl,
        productSecondaryImageURL: a.secondaryImageUrls,
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
  const DRY = process.argv.includes("--dry");
  const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
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
      const cand = await loadCandidate(sku, cur.productName || "");
      if (!cand) { jobs.push({ sku, packCount: 0, noun: "", feedId: null, url: "—", title: "—", status: "SKIP", detail: "no donor photo/pack" }); continue; }
      const noun = inferUnitNoun(cand.walmartTitle);
      const sc: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
      const brand = sc?.items?.[0]?.brand || cand.walmartTitle.split(" ")[0];

      // Pull the donor's full gallery + real bullets/description (BlueCart detail).
      const donor = cand.itemId ? await fetchDonorDetail(cand.itemId) : null;
      // Deterministic build is the fallback; Claude polish is the primary path.
      const content = buildMultipackListing(cand.walmartTitle, cand.packCount, {
        noun, donorBullets: donor?.bullets, donorDescription: donor?.description,
      });
      const contentIssues = await itemContentIssues(sku); // closed loop: known gaps
      const polished = (donor && (donor.bullets.length || donor.description))
        ? await polishListingCopy({ productName: content.title.replace(/\s*—.*$/, ""), donorBullets: donor.bullets, donorDescription: donor.description, contentIssues })
        : null;
      if (polished) {
        content.keyFeatures = polished.keyFeatures.map(scrubBrandVoice).filter(Boolean);
        content.description = `${quantityLeadSentence(cand.packCount, noun)}\n\n${polished.description}`;
      }

      // Tiling/badge source = the CLEAN white-bg primary (RetailPrice search
      // main_image). Donor detail's image[0] is often a pink infographic/lifestyle
      // shot — unusable for tiling — so those ride along only as secondaries.
      const base = await fetchImageBuffer(cand.baseImageUrl);
      const main = await composeTiledMainImage(base, cand.packCount);
      const badge = await renderBadgeImage(base, cand.packCount, { noun });
      const mainUrl = await uploadToR2(main, multipackImageKey(sku, "main", STAMP));
      const badgeUrl = await uploadToR2(badge, multipackImageKey(sku, "badge", STAMP));

      // Real donor gallery images ride along directly (walmartimages.com CDN is
      // Walmart-fetchable) — order: badge, then real product photos.
      const donorImgs = (donor?.images ?? []).slice(0, DONOR_IMAGE_CAP);
      const secondaryImageUrls = [badgeUrl, ...donorImgs];

      const payload = buildPayload({ sku, upc, brand, productType, productName: content.title, shortDescription: content.description, keyFeatures: content.keyFeatures, mainImageUrl: mainUrl, secondaryImageUrls });
      console.log(`\n▶ ${sku}: images=${1 + secondaryImageUrls.length} (main+badge+${donorImgs.length} donor) bullets=${content.keyFeatures.length}`);
      if (DRY) {
        console.log(`  TITLE: ${content.title}`);
        console.log(`  MAIN:  ${mainUrl}`);
        console.log(`  IMGS:  ${secondaryImageUrls.join("\n         ")}`);
        console.log(`  BULLETS:\n   - ${content.keyFeatures.join("\n   - ")}`);
        console.log(`  DESCRIPTION:\n   ${content.description.replace(/\n/g, "\n   ")}`);
        jobs.push({ sku, packCount: cand.packCount, noun, feedId: null, url: "(dry)", title: content.title, status: "DRY", detail: `${1 + secondaryImageUrls.length} imgs, ${content.keyFeatures.length} bullets` });
        continue;
      }
      const gaps = validateListingContent({ title: content.title, keyFeatures: content.keyFeatures, description: content.description, imageCount: 1 + secondaryImageUrls.length });
      const resp: any = await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload });
      const feedId = resp.body?.feedId ?? null;
      const url = await buyerUrl(client, upc, cand.packCount);
      const meta = {
        wpid: cur.wpid, upc, packCount: cand.packCount, newTitle: content.title,
        bulletsCount: content.keyFeatures.length, imagesCount: 1 + secondaryImageUrls.length,
        descriptionLength: content.description.length, mainImageUrl: mainUrl, usedAiPolish: !!polished,
        contentIssues, gaps,
      };
      jobs.push({ sku, packCount: cand.packCount, noun, feedId, url, title: content.title, status: feedId ? "SUBMITTED" : "POST_FAILED", detail: feedId ? "" : JSON.stringify(resp.body).slice(0, 120), meta });
      console.log(`${sku}: feedId=${feedId} url=${url}${gaps.length ? ` | gaps: ${gaps.map((g:any)=>g.issue).join("; ")}` : " | no content gaps"}`);
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
          (j as any).ingestOk = st === "PROCESSED" && Number(d.itemsFailed) === 0 && Number(d.itemsSucceeded) > 0;
          const errs = d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError ?? [];
          if (errs.length) j.detail += " — " + errs.map((e: any) => e.field).join(", ");
        }
      } catch { /* keep polling */ }
    }
    console.log(`round ${round}: pending=${pending().length}`);
  }

  // Phase 2.5 — log each remediation with before-metrics (analytics foundation)
  for (const j of jobs) {
    if (!j.meta || !j.feedId) continue;
    try {
      await logRemediation(db, {
        sku: j.sku, wpid: j.meta.wpid, upc: j.meta.upc, buyerItemId: (j.url.match(/ip\/(\d+)/) || [])[1] || null,
        changeType: "multipack", feedId: j.feedId, feedType: "MP_MAINTENANCE", feedStatus: j.status,
        ok: !!(j as any).ingestOk, packCount: j.meta.packCount, newTitle: j.meta.newTitle, titleChanged: true,
        bulletsCount: j.meta.bulletsCount, imagesCount: j.meta.imagesCount, descriptionLength: j.meta.descriptionLength,
        mainImageUrl: j.meta.mainImageUrl, usedAiPolish: j.meta.usedAiPolish,
        changeSummary: { contentIssues: j.meta.contentIssues, gaps: j.meta.gaps },
        notes: j.meta.gaps?.length ? `content gaps: ${j.meta.gaps.map((g: any) => g.issue).join("; ")}` : "no content gaps",
      });
      console.log(`logged remediation: ${j.sku}`);
    } catch (e: any) { console.log(`log failed ${j.sku}: ${e?.message}`); }
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
