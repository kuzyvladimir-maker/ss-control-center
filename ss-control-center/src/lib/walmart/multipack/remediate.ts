// Shared per-SKU multipack remediation: build the corrected listing (tiled main
// image showing N units + badge + donor gallery + Claude-polished copy) and
// submit it to Walmart as a partial MP_MAINTENANCE feed. Used by BOTH the CLI
// batch script and the serverless cron worker so there is ONE pipeline.
//
// The pipeline is SCOPE-AWARE: the Builder's "what to change" checkboxes
// (image/gallery/title/bullets/description) decide which fields the partial feed
// touches. Price, UPC, brand and productType are never changed.

import type { Client } from "@libsql/client";
import { composeTiledMainImage, renderBadgeImage, fetchImageBuffer, highResImageUrl } from "./composite";
import { buildMultipackListing, inferUnitNoun, quantityLeadSentence, scrubBrandVoice } from "./content";
import { uploadToR2, multipackImageKey } from "./r2";
import { fetchDonorDetail } from "./donor";
import { polishListingCopy } from "./polish";
import { validateListingContent } from "./guidelines";

export const SPEC_VERSION = "5.0.20260330-14_47_14-api";
const DONOR_IMAGE_CAP = 6;

export interface RemediateScope { image?: boolean; gallery?: boolean; title?: boolean; bullets?: boolean; description?: boolean; attributes?: boolean; }
const ALL_SCOPE: RemediateScope = { image: true, gallery: true, title: true, bullets: true, description: true, attributes: false };

export interface RemediateResult {
  status: "SUBMITTED" | "POST_FAILED" | "SKIP" | "DRY" | "ERROR";
  feedId: string | null; url: string; title: string | null; detail: string;
  packCount: number; noun: string; meta: RemediateMeta | null;
}
export interface RemediateMeta {
  wpid: string | null; upc: string; packCount: number; newTitle: string | null;
  bulletsCount: number; imagesCount: number; descriptionLength: number;
  mainImageUrl: string | null; usedAiPolish: boolean; contentIssues: string[]; gaps: any[];
}

/** Known CONTENT gaps for this SKU from the listing-quality mirror (closed loop). */
async function itemContentIssues(db: Client, sku: string): Promise<string[]> {
  try {
    const r = await db.execute({ sql: `SELECT issuesSummary FROM WalmartListingQualityItem WHERE sku=? LIMIT 1`, args: [sku] });
    const raw = (r.rows[0] as any)?.issuesSummary;
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: any) => x && x.component === "content")
      .map((x: any) => `${x.title}${x.detail && x.detail !== x.title ? ` — ${x.detail}` : ""}`)
      .filter(Boolean).slice(0, 12);
  } catch { return []; }
}

/** Pack count + clean donor photo. Pack resolution mirrors the optimizer's
 *  packExpr EXACTLY (SkuShippingData → SkuCost → titlePackCount) so the pipeline
 *  treats the same listings as multipacks that the UI surfaced as multipacks. */
async function loadCandidate(db: Client, sku: string, liveTitle: string, storeIndex = 1) {
  const p = await db.execute({
    sql: `SELECT COALESCE(s.unitsInListing, c.packSize, cat.titlePackCount) AS pack
          FROM (SELECT ? AS sku) k
          LEFT JOIN SkuShippingData s ON s.sku=k.sku
          LEFT JOIN SkuCost c ON c.sku=k.sku
          LEFT JOIN WalmartCatalogItem cat ON cat.sku=k.sku AND cat.storeIndex=?
          LIMIT 1`,
    args: [sku, storeIndex],
  });
  const pack = Number((p.rows[0] as any)?.pack) || 0;
  if (pack < 2) return null;
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

/** Resolve the buyer-facing walmart.com URL for the pack variant. */
async function buyerUrl(client: any, upc: string, packCount: number): Promise<string> {
  try {
    const s: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
    const items = s?.items ?? [];
    const match = items.find((it: any) => new RegExp(`pack of ${packCount}\\b`, "i").test(it.title || "")) || items[0];
    return match ? `https://www.walmart.com/ip/${match.itemId}` : "(url pending)";
  } catch { return "(url pending)"; }
}

/**
 * Build + submit one SKU. Returns the feedId (poll separately) and a meta blob
 * for analytics logging. Honors `scope`; defaults to the full set (parity with
 * the original 5-listing pipeline).
 */
export async function buildAndSubmitOne(
  db: Client, client: any, sku: string,
  opts: { scope?: RemediateScope | null; dry?: boolean; stamp: string },
): Promise<RemediateResult> {
  const scope: RemediateScope = opts.scope && Object.values(opts.scope).some(Boolean) ? opts.scope : ALL_SCOPE;
  const stamp = opts.stamp;
  const blank: RemediateResult = { status: "SKIP", feedId: null, url: "—", title: null, detail: "", packCount: 0, noun: "", meta: null };

  const itemRes: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
  const cur = itemRes?.ItemResponse?.[0];
  if (!cur) return { ...blank, detail: "not found on Walmart" };
  const upc = cur.upc, productType = cur.productType;
  const cand = await loadCandidate(db, sku, cur.productName || "");
  if (!cand) return { ...blank, detail: "no donor photo/pack" };
  const noun = inferUnitNoun(cand.walmartTitle);

  const sc: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
  const brand = sc?.items?.[0]?.brand || cand.walmartTitle.split(" ")[0];

  // Donor gallery + real bullets/description (only needed for content/gallery).
  const needDonor = !!(scope.bullets || scope.description || scope.gallery);
  const donor = needDonor && cand.itemId ? await fetchDonorDetail(cand.itemId) : null;
  const content = buildMultipackListing(cand.walmartTitle, cand.packCount, { noun, donorBullets: donor?.bullets, donorDescription: donor?.description });
  const contentIssues = await itemContentIssues(db, sku);
  const polished = (donor && (donor.bullets.length || donor.description))
    ? await polishListingCopy({ productName: content.title.replace(/\s*—.*$/, ""), donorBullets: donor.bullets, donorDescription: donor.description, contentIssues })
    : null;
  if (polished) {
    content.keyFeatures = polished.keyFeatures.map(scrubBrandVoice).filter(Boolean);
    content.description = `${quantityLeadSentence(cand.packCount, noun)}\n\n${polished.description}`;
  }

  // Images: tiled main (scope.image) + badge (scope.gallery) + donor gallery.
  let mainUrl: string | null = null;
  const secondaryImageUrls: string[] = [];
  if (scope.image || scope.gallery) {
    const base = await fetchImageBuffer(cand.baseImageUrl);
    if (scope.image) {
      const main = await composeTiledMainImage(base, cand.packCount);
      mainUrl = await uploadToR2(main, multipackImageKey(sku, "main", stamp));
    }
    if (scope.gallery) {
      const badge = await renderBadgeImage(base, cand.packCount, { noun });
      const badgeUrl = await uploadToR2(badge, multipackImageKey(sku, "badge", stamp));
      const donorImgs = (donor?.images ?? []).slice(0, DONOR_IMAGE_CAP);
      secondaryImageUrls.push(badgeUrl, ...donorImgs);
    }
  }

  // Scope-aware Visible block — only the chosen fields are sent. Brand is always
  // included (the productType block requires it); it is never changed.
  const visible: Record<string, any> = { brand };
  if (scope.title) visible.productName = content.title;
  if (scope.description) visible.shortDescription = content.description;
  if (scope.bullets) visible.keyFeatures = content.keyFeatures;
  if (mainUrl) visible.mainImageUrl = mainUrl;
  if (secondaryImageUrls.length) visible.productSecondaryImageURL = secondaryImageUrls;

  const payload = {
    MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
    MPItem: [{ Orderable: { sku, productIdentifiers: { productIdType: "UPC", productId: upc } }, Visible: { [productType]: visible } }],
  };

  const imagesCount = (mainUrl ? 1 : 0) + secondaryImageUrls.length;
  if (opts.dry) {
    return { status: "DRY", feedId: null, url: "(dry)", title: content.title, detail: `${imagesCount} imgs, ${content.keyFeatures.length} bullets`, packCount: cand.packCount, noun, meta: null };
  }

  const gaps = validateListingContent({ title: content.title, keyFeatures: content.keyFeatures, description: content.description, imageCount: imagesCount });
  const resp: any = await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload });
  const feedId = resp.body?.feedId ?? null;
  const url = await buyerUrl(client, upc, cand.packCount);
  const meta: RemediateMeta = {
    wpid: cur.wpid ?? null, upc, packCount: cand.packCount, newTitle: scope.title ? content.title : null,
    bulletsCount: scope.bullets ? content.keyFeatures.length : 0, imagesCount,
    descriptionLength: scope.description ? content.description.length : 0,
    mainImageUrl: mainUrl, usedAiPolish: !!polished, contentIssues, gaps,
  };
  return {
    status: feedId ? "SUBMITTED" : "POST_FAILED", feedId, url, title: content.title,
    detail: feedId ? "" : JSON.stringify(resp.body).slice(0, 160), packCount: cand.packCount, noun, meta,
  };
}

/** Check one feed's terminal status. Returns null while still processing. */
export async function checkFeed(client: any, feedId: string): Promise<{ status: "PROCESSED" | "ERROR"; ok: boolean; detail: string } | null> {
  const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: "true" } })).body;
  const st = d?.feedStatus;
  if (st !== "PROCESSED" && st !== "ERROR") return null;
  let detail = `ok=${d.itemsSucceeded} fail=${d.itemsFailed}`;
  const errs = d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError ?? [];
  if (errs.length) detail += " — " + errs.map((e: any) => e.field).join(", ");
  const ok = st === "PROCESSED" && Number(d.itemsFailed) === 0 && Number(d.itemsSucceeded) > 0;
  return { status: st, ok, detail };
}
