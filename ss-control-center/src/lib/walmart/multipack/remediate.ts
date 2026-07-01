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
import { polishListingCopy } from "./polish";
import { validateListingContent } from "./guidelines";
import { ensureDonorImage, fetchAndStoreDetail } from "../../sourcing/enrich";
import { pickBestFront, mainImageAcceptable, verifyMainImage } from "../../sourcing/vision";
import { logRemediation } from "./analytics";
import { buildFoodAttributes } from "./attributes";

export const SPEC_VERSION = "5.0.20260330-14_47_14-api";
const DONOR_IMAGE_CAP = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RemediateScope { image?: boolean; gallery?: boolean; title?: boolean; bullets?: boolean; description?: boolean; attributes?: boolean; }
const ALL_SCOPE: RemediateScope = { image: true, gallery: true, title: true, bullets: true, description: true, attributes: true };

export interface RemediateResult {
  status: "SUBMITTED" | "POST_FAILED" | "SKIP" | "DRY" | "ERROR" | "BUILT";
  feedId: string | null; url: string; title: string | null; detail: string;
  packCount: number; noun: string; meta: RemediateMeta | null;
  // Populated only when opts.buildOnly — the ready-to-submit MPItem entry + its
  // productType + upc, so a batch driver can pack many SKUs into ONE feed (the
  // fix for Walmart's per-feed REQUEST_THRESHOLD_VIOLATED throttle).
  mpItem?: Record<string, any> | null;
  productType?: string | null;
  upc?: string | null;
}
export interface RemediateMeta {
  wpid: string | null; upc: string; packCount: number; newTitle: string | null;
  bulletsCount: number; imagesCount: number; descriptionLength: number;
  mainImageUrl: string | null; usedAiPolish: boolean; contentIssues: string[]; gaps: any[];
  attributesCount?: number;
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

/** Pack size, mirroring the optimizer's packExpr EXACTLY (SkuShippingData →
 *  SkuCost → WalmartCatalogItem.titlePackCount → WalmartListingQualityItem.titlePackCount).
 *  The last fallback is the one that's actually populated catalog-wide — without
 *  it pack resolves to 0 for almost every SKU and the worker SKIPs them. 0 if unknown. */
async function resolvePack(db: Client, sku: string, storeIndex = 1): Promise<number> {
  const p = await db.execute({
    sql: `SELECT COALESCE(
            (SELECT unitsInListing FROM SkuShippingData WHERE sku=? LIMIT 1),
            (SELECT packSize FROM SkuCost WHERE sku=? LIMIT 1),
            (SELECT titlePackCount FROM WalmartCatalogItem WHERE sku=? AND storeIndex=? LIMIT 1),
            (SELECT titlePackCount FROM WalmartListingQualityItem WHERE sku=? AND storeIndex=? LIMIT 1)
          ) AS pack`,
    args: [sku, sku, sku, storeIndex, sku, storeIndex],
  });
  return Number((p.rows[0] as any)?.pack) || 0;
}

/** Pack count + clean donor photo. Pack resolution mirrors the optimizer's
 *  packExpr EXACTLY (SkuShippingData → SkuCost → catalog titlePackCount →
 *  listing-quality titlePackCount) so the pipeline treats the same listings as
 *  multipacks that the UI surfaced as multipacks. The quality-item fallback is the
 *  populated one (catalog titlePackCount is NULL catalog-wide). */
async function loadCandidate(db: Client, sku: string, liveTitle: string, storeIndex = 1) {
  const p = await db.execute({
    sql: `SELECT COALESCE(s.unitsInListing, c.packSize, cat.titlePackCount, q.titlePackCount) AS pack
          FROM (SELECT ? AS sku) k
          LEFT JOIN SkuShippingData s ON s.sku=k.sku
          LEFT JOIN SkuCost c ON c.sku=k.sku
          LEFT JOIN WalmartCatalogItem cat ON cat.sku=k.sku AND cat.storeIndex=?
          LEFT JOIN WalmartListingQualityItem q ON q.sku=k.sku AND q.storeIndex=?
          LIMIT 1`,
    args: [sku, storeIndex, storeIndex],
  });
  const pack = Number((p.rows[0] as any)?.pack) || 0;
  if (pack < 2) return null;
  const r = await db.execute({
    sql: `SELECT imageUrls, retailerProductId FROM RetailPrice
          WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != ''
          ORDER BY (CASE WHEN sourceApi='bluecart' THEN 0 ELSE 1 END),
                   (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`,
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
  opts: { scope?: RemediateScope | null; dry?: boolean; stamp: string; enrich?: boolean; storeIndex?: number; forceImage?: boolean; buildOnly?: boolean },
): Promise<RemediateResult> {
  const scope: RemediateScope = opts.scope && Object.values(opts.scope).some(Boolean) ? opts.scope : ALL_SCOPE;
  const stamp = opts.stamp;
  const storeIndex = opts.storeIndex ?? 1;
  const blank: RemediateResult = { status: "SKIP", feedId: null, url: "—", title: null, detail: "", packCount: 0, noun: "", meta: null };

  const itemRes: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
  const cur = itemRes?.ItemResponse?.[0];
  if (!cur) return { ...blank, detail: "not found on Walmart" };
  const upc = cur.upc, productType = cur.productType;

  // Resolve pack FIRST (so we never spend an enrichment credit on a non-multipack).
  const pack0 = await resolvePack(db, sku, storeIndex);
  if (pack0 < 2) return { ...blank, detail: "not a multipack (pack < 2)" };

  // On-demand enrichment: if the catalog has no donor photo, ask the Sourcing
  // Engine to fetch+persist one (BlueCart, 1 credit). Disabled via enrich:false
  // when the budget guard trips.
  let enrichNote = "";
  if (opts.enrich !== false) {
    try { const e = await ensureDonorImage(db, { sku, upc, title: cur.productName }); if (!e.alreadyHad && !e.found) enrichNote = e.reason || "enrich found nothing"; }
    catch (e: any) { enrichNote = `enrich error: ${e?.message?.slice(0, 60)}`; }
  }

  const cand = await loadCandidate(db, sku, cur.productName || "", storeIndex);
  if (!cand) return { ...blank, detail: `no donor photo${enrichNote ? ` (${enrichNote})` : ""}` };
  const noun = inferUnitNoun(cand.walmartTitle);

  // ALWAYS capture the full BlueCart detail (gallery, bullets, description, specs,
  // ingredients, raw) into our catalog — even on image-only runs. We're building a
  // knowledge base; the returned data also feeds the listing when scope needs it.
  const donor = cand.itemId ? await fetchAndStoreDetail(db, sku, cand.itemId) : null;
  const content = buildMultipackListing(cand.walmartTitle, cand.packCount, { noun, donorBullets: donor?.bullets, donorDescription: donor?.description });
  const contentIssues = await itemContentIssues(db, sku);
  // Claude polish ONLY when we're actually sending content fields (title/desc/
  // bullets). Image-only runs skip it — no Anthropic spend.
  const wantContent = !!(scope.title || scope.description || scope.bullets);
  // A-to-Z GUARANTEE (Vladimir's hard rule): NEVER leave a listing bare. Even when
  // the donor detail came back empty (no BlueCart itemId, Target-only fallback, or
  // a failed detail call), we STILL ask Claude to write factual bullets +
  // description from the product name + pack. A title-only listing is fine copy;
  // an empty one is the "ужасный листинг" we were told to eliminate.
  const polished = wantContent
    ? await polishListingCopy({ productName: content.title.replace(/\s*—.*$/, ""), donorBullets: donor?.bullets ?? [], donorDescription: donor?.description ?? "", contentIssues })
    : null;
  if (polished) {
    content.keyFeatures = polished.keyFeatures.map(scrubBrandVoice).filter(Boolean);
    content.description = `${quantityLeadSentence(cand.packCount, noun)}\n\n${polished.description}`;
  }

  // Main image — VISION-GUARDED. Wave 1 tiled whatever came first (often the
  // nutrition/back/lifestyle/promo shot → ugly). Now: (1) a vision model PICKS
  // the cleanest front-on-white photo from the candidate pool; (2) we tile it;
  // (3) the vision model VERIFIES the tile before we publish. If no clean front
  // exists, or the tile fails verification, we DO NOT touch the main image
  // (do-no-harm) and record why.
  let mainUrl: string | null = null;
  let imageNote = "";
  const secondaryImageUrls: string[] = [];

  // Candidate image pool, built ONCE = the full donor detail gallery + EVERY image
  // captured for this SKU across all offers + the base. Used for BOTH the main
  // selector AND the secondary gallery, so a thin-donor SKU still gets photos.
  const poolSet = new Set<string>((donor?.images ?? []).filter(Boolean).map((u) => u.split("?")[0]));
  try {
    const rps = await db.execute({ sql: `SELECT imageUrls FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL`, args: [sku] });
    for (const row of rps.rows as any[]) { try { const arr = JSON.parse((row as any).imageUrls || "[]"); for (const u of arr) if (typeof u === "string" && u.startsWith("http")) poolSet.add(u.split("?")[0]); } catch {} }
  } catch {}
  if (cand.baseImageUrl) poolSet.add(cand.baseImageUrl.split("?")[0]);
  const pool = Array.from(poolSet);

  if (scope.image) {
    // STRONG selector (Sonnet): pick the best UPRIGHT SINGLE-UNIT FRONT, rejecting
    // back/barcode, nutrition, infographic, lifestyle/serving, and loaves lying on
    // their end (Wave 1's weak Haiku picker tiled those → torец/back/serving mains).
    const best = await pickBestFront(pool, { listingTitle: cur.productName || cand.walmartTitle, preferUrl: cand.baseImageUrl });
    if (!best) {
      imageNote = "no upright product-front in source — left unchanged (needs enrich/manual)";
    } else {
      // KEEP/REPLACE (Vladimir): don't churn a listing whose current main is
      // ALREADY an upright-front grid; only replace lying/back/serving/etc. The
      // "current" main is our last published tile for this SKU.
      // KEEP only avoids churning a genuinely-good current main. On an explicit
      // RE-FIX (forceImage) we ALWAYS replace — mainImageAcceptable only checks
      // "is it product fronts", NOT right flavor / white bg, so it would wrongly
      // keep a pre-fix wrong-flavor/orange tile from an earlier image-only run.
      let keep = false;
      if (!opts.forceImage) {
        try {
          const r = await db.execute({ sql: `SELECT mainImageUrl FROM WalmartListingRemediation WHERE sku=? AND storeIndex=? AND ok=1 AND mainImageUrl IS NOT NULL AND mainImageUrl != '' ORDER BY runAt DESC LIMIT 1`, args: [sku, storeIndex] });
          const curMain = (r.rows[0] as any)?.mainImageUrl as string | undefined;
          if (curMain) {
            const acc = await mainImageAcceptable(curMain, cand.packCount);
            if (acc.good) { keep = true; imageNote = "current main already an upright-front grid — kept"; }
          }
        } catch {}
      }
      if (!keep) {
        // Tile the chosen front and VERIFY before publishing (do-no-harm gate).
        const base = await fetchImageBuffer(highResImageUrl(best.url));
        const main = await composeTiledMainImage(base, cand.packCount);
        const candidateUrl = await uploadToR2(main, multipackImageKey(sku, "main", stamp));
        const v = await verifyMainImage(candidateUrl, cand.packCount);
        if (v.ok) mainUrl = candidateUrl;
        else imageNote = `new tile rejected by verify (${v.kind}) — left unchanged`;
      }
    }
  }
  if (scope.gallery) {
    // Gallery = the product's OTHER photos (single-unit shot, nutrition panel,
    // ingredients, lifestyle). Broadened from donor.images to the FULL pool so a
    // SKU whose BlueCart DETAIL came back thin still shows secondary photos —
    // donor-detail images first (best quality/order), then any other captured.
    const ordered = [...(donor?.images ?? []).map((u) => u.split("?")[0]), ...pool];
    const seen = new Set<string>();
    for (const u of ordered) {
      if (!u || seen.has(u)) continue;
      seen.add(u); secondaryImageUrls.push(u);
      if (secondaryImageUrls.length >= DONOR_IMAGE_CAP) break;
    }
  }

  // Scope-aware Visible block — only the chosen fields are sent. We deliberately
  // do NOT send `brand`: it's a catalog-identity field we never change, and
  // sending it triggers Walmart's ERR_EXT_DATA_0101119 ("Product ID exists with
  // different details") conflict (the "QARTH" failures) when our value differs
  // from the shared catalog. Omitting it lets the image/content update apply.
  const visible: Record<string, any> = {};
  if (scope.title) visible.productName = content.title;
  if (scope.description) visible.shortDescription = content.description;
  if (scope.bullets) visible.keyFeatures = content.keyFeatures;
  if (mainUrl) visible.mainImageUrl = mainUrl;
  if (secondaryImageUrls.length) visible.productSecondaryImageURL = secondaryImageUrls;

  // ATTRIBUTES (Walmart MP_ITEM 5.0) — the quantity trio (multipackQuantity /
  // countPerPack / count) is the data-level fix for the "ordered 1, got N"
  // confusion; the rest (manufacturer/ingredients/allergens/netContent/flavor)
  // come from Walmart-sourced donor data and lift the listing-quality score.
  let attributesFilled: string[] = [];
  if (scope.attributes) {
    try {
      const { attrs, filled } = await buildFoodAttributes(db, sku, cand.packCount);
      Object.assign(visible, attrs);
      attributesFilled = filled;
    } catch { /* attributes are best-effort */ }
  }

  // Nothing safe to send (image-only run but no clean image found) → SKIP, don't
  // submit an empty feed. Flagged so it shows up as "needs a better photo".
  if (Object.keys(visible).length === 0) {
    return { ...blank, detail: imageNote || "nothing to update" };
  }

  const payload = {
    MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
    MPItem: [{ Orderable: { sku, productIdentifiers: { productIdType: "UPC", productId: upc } }, Visible: { [productType]: visible } }],
  };

  const imagesCount = (mainUrl ? 1 : 0) + secondaryImageUrls.length;
  if (opts.dry) {
    return { status: "DRY", feedId: null, url: "(dry)", title: content.title, detail: `${imagesCount} imgs, ${content.keyFeatures.length} bullets`, packCount: cand.packCount, noun, meta: null };
  }

  const gaps = validateListingContent({ title: content.title, keyFeatures: content.keyFeatures, description: content.description, imageCount: imagesCount });
  const buildMeta: RemediateMeta = {
    wpid: cur.wpid ?? null, upc, packCount: cand.packCount, newTitle: scope.title ? content.title : null,
    bulletsCount: scope.bullets ? content.keyFeatures.length : 0, imagesCount,
    descriptionLength: scope.description ? content.description.length : 0,
    mainImageUrl: mainUrl, usedAiPolish: !!polished, contentIssues, gaps,
    attributesCount: attributesFilled.length,
  };

  // BUILD-ONLY: everything is composed and validated but NOT submitted. Return the
  // single MPItem entry so a batch driver can pack many into ONE MP_MAINTENANCE
  // feed — this is what sidesteps Walmart's per-feed REQUEST_THRESHOLD_VIOLATED.
  if (opts.buildOnly) {
    return {
      status: "BUILT", feedId: null, url: "(built)", title: content.title, detail: "",
      packCount: cand.packCount, noun, meta: buildMeta,
      mpItem: payload.MPItem[0], productType, upc,
    };
  }

  const resp: any = await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload });
  const feedId = resp.body?.feedId ?? null;
  const url = await buyerUrl(client, upc, cand.packCount);
  return {
    status: feedId ? "SUBMITTED" : "POST_FAILED", feedId, url, title: content.title,
    detail: feedId ? "" : JSON.stringify(resp.body).slice(0, 160), packCount: cand.packCount, noun, meta: buildMeta,
    // Expose the sent item so the caller (worker) can persist the generated
    // content for the QC review screen, same as the batch driver.
    mpItem: payload.MPItem[0], productType, upc,
  };
}

// ————————————————————————————————————————————————————————————————————————
// SELF-CHECKING BATCH DRIVER
// Fixes two failure modes of the naïve one-feed-per-SKU loop:
//   1) Walmart REQUEST_THRESHOLD_VIOLATED — dozens of individual feeds trip the
//      per-feed rate limit. We instead pack many SKUs into ONE MP_MAINTENANCE
//      feed (Walmart's MPItem array is built for this) → a handful of feeds.
//   2) Silent waste — a broken pipeline (bad key, vision down, empty donors)
//      would burn credits + feed quota over 1000s of SKUs before anyone noticed.
//      We run a CANARY: build the first few, check they came out FULL A-to-Z,
//      and ABORT the whole run if the success rate is too low.
// ————————————————————————————————————————————————————————————————————————

/**
 * Grade a built listing.
 *  - `textOk`  : ≥5 bullets AND a real (≥500-char) description. This is the
 *                PIPELINE-health signal (enrich → polish → build worked). The
 *                canary gates on this, so a handful of genuinely hard-photo SKUs
 *                don't falsely abort an otherwise-healthy run.
 *  - `imageOk` : a fresh main image was produced.
 *  - `full`    : A-to-Z ideal = textOk AND imageOk. Used by the review gallery/QC
 *                to flag "needs a better photo" items.
 */
export function assessRemediation(meta: RemediateMeta | null): { full: boolean; textOk: boolean; imageOk: boolean; galleryOk: boolean; reasons: string[] } {
  if (!meta) return { full: false, textOk: false, imageOk: false, galleryOk: false, reasons: ["no build meta"] };
  const reasons: string[] = [];
  // imageOk = the MAIN photo specifically (the tiled N-unit shot). A listing with
  // gallery images but NO main is NOT ok — earlier grading wrongly counted gallery
  // toward the image, badging main-less listings "A-to-Z ✓" (Vladimir caught it).
  const mainOk = !!meta.mainImageUrl;
  const galleryCount = Math.max(0, (meta.imagesCount ?? 0) - (mainOk ? 1 : 0));
  const galleryOk = galleryCount >= 2;
  const bulletsOk = (meta.bulletsCount ?? 0) >= 5;
  const descOk = (meta.descriptionLength ?? 0) >= 500;
  if (!mainOk) reasons.push("no MAIN photo (needs generation / manual)");
  if (!galleryOk) reasons.push(`thin gallery (${galleryCount} extra photos)`);
  if (!bulletsOk) reasons.push(`only ${meta.bulletsCount ?? 0} bullets`);
  if (!descOk) reasons.push(`thin description (${meta.descriptionLength ?? 0} chars)`);
  const textOk = bulletsOk && descOk;
  // full A-to-Z ideal (Vladimir's standard) = main photo + gallery + text.
  return { full: mainOk && galleryOk && textOk, textOk, imageOk: mainOk, galleryOk, reasons };
}

/** POST one feed carrying MANY MPItem entries, retrying ONLY on Walmart's
 *  throttle with exponential backoff (60s, 120s, …). Non-throttle errors return
 *  immediately (they won't fix themselves). Exported so the serverless queue
 *  worker can pack a whole tick's SKUs into ONE feed instead of one-per-SKU. */
export async function submitFeedBatch(client: any, mpItems: Record<string, any>[], tries = 5): Promise<{ feedId: string | null; error?: string }> {
  const payload = { MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION }, MPItem: mpItems };
  const throttled = (s: string) => /REQUEST_THRESHOLD_VIOLATED|TOO_MANY_REQUESTS|throttl|\b429\b/i.test(s);
  let lastErr = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const resp: any = await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload });
      const feedId = resp.body?.feedId ?? null;
      if (feedId) return { feedId };
      lastErr = JSON.stringify(resp.body || {}).slice(0, 200);
      if (!throttled(lastErr)) return { feedId: null, error: lastErr };
    } catch (e: any) {
      lastErr = String(e?.message || e).slice(0, 200);
      if (!throttled(lastErr)) return { feedId: null, error: lastErr };
    }
    if (attempt < tries - 1) await sleep(60000 * (attempt + 1));
  }
  return { feedId: null, error: `throttled after ${tries} tries: ${lastErr}` };
}

export interface BatchProgress {
  phase: "build" | "canary" | "submit" | "done" | "abort";
  i?: number; total?: number; sku?: string; status?: string; full?: boolean;
  note?: string; fullRate?: number; submitted?: number; failed?: number;
}
export type BuiltResult = RemediateResult & { sku: string; full: boolean };
export interface BatchOutcome {
  aborted: boolean; abortReason?: string;
  results: BuiltResult[]; submitted: number; failed: number; built: number; skipped: number;
  canaryFullRate: number;
}
export interface BatchOptions {
  scope?: RemediateScope | null; stamp: string; enrich?: boolean; storeIndex?: number; forceImage?: boolean;
  batchSize?: number;        // MPItems per feed (default 15)
  canarySize?: number;       // first-N health sample (default 6)
  minFullRate?: number;      // abort build if canary full-rate below this (default 0.5)
  batchSpacingMs?: number;   // pause between feed POSTs (default 20000)
  log?: boolean;             // write WalmartListingRemediation rows (default true)
  onProgress?: (ev: BatchProgress) => void;
}

/**
 * Build every SKU (buildOnly — no submit), health-check a canary sample, then
 * submit in batched feeds with throttle-retry. This is the ONE entry point for
 * multi-SKU remediation (CLI re-runs, the full-catalog sweep, and the QC console
 * "Run" button) so the self-check lives in exactly one place.
 */
export async function buildAndSubmitMany(db: Client, client: any, skus: string[], opts: BatchOptions): Promise<BatchOutcome> {
  const batchSize = opts.batchSize ?? 15;
  const canarySize = Math.min(opts.canarySize ?? 6, skus.length);
  const minFullRate = opts.minFullRate ?? 0.5;
  const spacing = opts.batchSpacingMs ?? 20000;
  const storeIndex = opts.storeIndex ?? 1;
  const emit = (ev: BatchProgress) => { try { opts.onProgress?.(ev); } catch { /* progress must never break the run */ } };

  // ---- Phase 1: BUILD (with canary health-gate) ----
  const built: BuiltResult[] = [];
  let canaryHealthy = 0, canaryDone = 0, canaryRate = 1;
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    let r: RemediateResult;
    try {
      r = await buildAndSubmitOne(db, client, sku, {
        scope: opts.scope, stamp: opts.stamp, enrich: opts.enrich, storeIndex, forceImage: opts.forceImage, buildOnly: true,
      });
    } catch (e: any) {
      r = { status: "ERROR", feedId: null, url: "—", title: null, detail: String(e?.message || e).slice(0, 140), packCount: 0, noun: "", meta: null };
    }
    const a = assessRemediation(r.meta);
    const full = r.status === "BUILT" && a.full;
    const textOk = r.status === "BUILT" && a.textOk;
    built.push({ ...r, sku, full });
    emit({ phase: "build", i: i + 1, total: skus.length, sku, status: r.status, full, note: full ? "FULL" : a.reasons.join("; ") });

    // Canary gates on PIPELINE HEALTH (text produced), not on the ideal — a few
    // hard-photo SKUs must not abort a healthy run; a systemic break (no text at
    // all) must.
    if (i + 1 <= canarySize) { canaryDone++; if (textOk) canaryHealthy++; }
    if (i + 1 === canarySize && canaryDone > 0) {
      canaryRate = canaryHealthy / canaryDone;
      emit({ phase: "canary", i: canaryDone, total: canarySize, fullRate: canaryRate });
      if (canaryRate < minFullRate) {
        emit({ phase: "abort", fullRate: canaryRate, note: "canary below threshold — nothing submitted" });
        return {
          aborted: true,
          abortReason: `canary healthy-rate ${(canaryRate * 100).toFixed(0)}% < ${(minFullRate * 100).toFixed(0)}% over first ${canaryDone} SKUs (pipeline not producing content) — stopped before wasting credits/quota on the remaining ${skus.length - canaryDone}`,
          results: built, submitted: 0, failed: 0,
          built: built.filter((b) => b.status === "BUILT").length,
          skipped: built.filter((b) => b.status !== "BUILT").length,
          canaryFullRate: canaryRate,
        };
      }
    }
  }

  // ---- Phase 2: SUBMIT in batched feeds (throttle-safe) ----
  const submittable = built.filter((b) => b.status === "BUILT" && b.mpItem);
  let submitted = 0, failed = 0;
  for (let off = 0; off < submittable.length; off += batchSize) {
    const chunk = submittable.slice(off, off + batchSize);
    const feed = await submitFeedBatch(client, chunk.map((c) => c.mpItem as Record<string, any>));
    for (const c of chunk) {
      if (feed.feedId) { c.status = "SUBMITTED"; c.feedId = feed.feedId; submitted++; }
      else { c.status = "POST_FAILED"; c.detail = feed.error || "batch feed failed"; failed++; }
    }
    emit({ phase: "submit", i: Math.min(off + batchSize, submittable.length), total: submittable.length, submitted, failed, note: feed.feedId || feed.error });
    if (opts.log !== false) {
      for (const c of chunk) {
        try {
          // Persist the full generated Visible block (title/bullets/description/
          // gallery/attributes) so the in-module QC screen can show before/after
          // WITHOUT Walmart's propagation lag (the whole point of the review UI).
          const vis = c.mpItem?.Visible ? Object.values(c.mpItem.Visible)[0] : null;
          await logRemediation(db, {
            sku: c.sku, storeIndex, wpid: c.meta?.wpid ?? null, upc: c.upc ?? c.meta?.upc ?? null,
            feedId: c.feedId, feedType: "MP_MAINTENANCE", feedStatus: c.feedId ? "SUBMITTED" : "POST_FAILED", ok: c.status === "SUBMITTED",
            packCount: c.packCount, newTitle: c.meta?.newTitle ?? undefined, titleChanged: !!c.meta?.newTitle,
            bulletsCount: c.meta?.bulletsCount, imagesCount: c.meta?.imagesCount, descriptionLength: c.meta?.descriptionLength,
            mainImageUrl: c.meta?.mainImageUrl ?? undefined, usedAiPolish: c.meta?.usedAiPolish,
            changeSummary: { batch: true, full: c.full, attributesCount: c.meta?.attributesCount ?? 0, content: vis },
            notes: c.full ? "A-to-Z (full donor)" : "A-to-Z (thin donor — title-based copy)",
          });
        } catch { /* logging must never break the run */ }
      }
    }
    if (off + batchSize < submittable.length) await sleep(spacing);
  }

  emit({ phase: "done", total: skus.length, submitted, failed });
  return {
    aborted: false, results: built, submitted, failed, built: submittable.length,
    skipped: built.filter((b) => b.status !== "SUBMITTED" && b.status !== "POST_FAILED").length,
    canaryFullRate: canaryRate,
  };
}

/** Publish ONLY a main image for a SKU (used by the manual generation lever's
 *  "apply" step). Reuses the MP_MAINTENANCE partial-feed path — touches nothing
 *  but mainImageUrl. Returns the feedId (poll with checkFeed). */
export async function submitMainImageOnly(client: any, sku: string, mainImageUrl: string): Promise<{ feedId: string | null; error?: string }> {
  const itemRes: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body;
  const cur = itemRes?.ItemResponse?.[0];
  if (!cur) return { feedId: null, error: "not found on Walmart" };
  const payload = {
    MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
    MPItem: [{ Orderable: { sku, productIdentifiers: { productIdType: "UPC", productId: cur.upc } }, Visible: { [cur.productType]: { mainImageUrl } } }],
  };
  const resp: any = (await client.requestRaw("POST", "/feeds", { params: { feedType: "MP_MAINTENANCE" }, body: payload })).body;
  return { feedId: resp?.feedId ?? null, error: resp?.feedId ? undefined : JSON.stringify(resp).slice(0, 160) };
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

/** Per-item feed result. checkFeed only reads item[0]; this returns EVERY item's
 *  sku + status + errors — needed to finalize a BATCHED feed per-SKU (half our
 *  cards are QARTH-locked, so a batch feed is always mixed) and to see exactly
 *  which attribute each item rejected. Returns null while still processing. */
export async function checkFeedItems(client: any, feedId: string): Promise<{ status: "PROCESSED" | "ERROR"; items: Array<{ sku: string; ok: boolean; ingestionStatus: string; errorFields: string[]; errors: string[] }> } | null> {
  const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: "true" } })).body;
  const st = d?.feedStatus;
  if (st !== "PROCESSED" && st !== "ERROR") return null;
  const arr = d?.itemDetails?.itemIngestionStatus ?? [];
  const items = (Array.isArray(arr) ? arr : []).map((it: any) => {
    const errs = it?.ingestionErrors?.ingestionError ?? [];
    return {
      sku: it?.sku || it?.martItemId || "?",
      ingestionStatus: it?.ingestionStatus || "?",
      ok: it?.ingestionStatus === "SUCCESS",
      errorFields: errs.map((e: any) => String(e?.field || e?.type || "")).filter(Boolean),
      errors: errs.map((e: any) => `${e?.field || e?.type || "?"}: ${String(e?.description || "").slice(0, 90)}`),
    };
  });
  return { status: st, items };
}
