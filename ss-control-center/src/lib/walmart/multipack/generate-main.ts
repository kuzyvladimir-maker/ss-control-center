// Manual generation lever (Vladimir 2026-06-30): produce an AI main image
// (gpt-image-2 via the free Codex worker) for one SKU, for the case where the
// deterministic cutout+tile can't yield a good main (e.g. no clean donor front).
// This is OPT-IN per listing — NOT the default engine (cutout is, ~270× faster).
// It returns a PREVIEW url and publishes NOTHING; the caller decides to apply it.

import type { Client } from "@libsql/client";
import { generateImagePngViaCodex } from "../../image-gen/codex-worker";
import { pickBestFront } from "../../sourcing/vision";
import { uploadToR2, multipackImageKey } from "./r2";

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

async function pool(db: Client, sku: string): Promise<string[]> {
  const r = await db.execute({ sql: `SELECT imageUrls FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != ''`, args: [sku] });
  const set = new Set<string>();
  for (const row of r.rows as any[]) { try { for (const u of JSON.parse((row as any).imageUrls || "[]")) if (typeof u === "string" && u.startsWith("http")) set.add(u.split("?")[0]); } catch {} }
  return [...set];
}

export interface GenerateMainResult {
  previewUrl: string | null;
  pack: number;
  usedReference: boolean;
  error?: string;
}

/** Generate an N-unit AI main image for `sku`. Uses the best real donor front as
 *  a visual reference when one exists (better label fidelity); falls back to
 *  title-only generation otherwise. Returns a preview URL — does NOT publish. */
export async function generateMainForSku(
  db: Client, sku: string, opts: { title?: string; storeIndex?: number; stamp: string },
): Promise<GenerateMainResult> {
  const storeIndex = opts.storeIndex ?? 1;
  const pack = await resolvePack(db, sku, storeIndex);
  if (pack < 2) return { previewUrl: null, pack, usedReference: false, error: "not a multipack (pack < 2)" };

  const imgs = await pool(db, sku);
  const best = imgs.length ? await pickBestFront(imgs) : null;
  const title = String(opts.title || "").replace(/\s*\(pack of \d+\)/i, "").trim();

  const prompt =
    `Professional e-commerce product photo on a pure white background (RGB 255,255,255). ` +
    `Show EXACTLY ${pack} identical units of this exact retail product${title ? ` — ${title}` : ""}, ` +
    `arranged in a clean grid, every unit UPRIGHT and front-facing with its REAL brand label clearly visible and readable. ` +
    `Reproduce the packaging${best ? " in the reference image" : ""} faithfully; do NOT invent, translate, or alter any text or logos. ` +
    `The ${pack} packages together fill about 95% of the square frame, as large as possible. ` +
    `No people, no props, no prepared food, no serving dishes, no nutrition panels, no added text or graphics.`;

  const gen = await generateImagePngViaCodex({
    prompt, size: "2000x2000",
    referenceUrls: best ? [best.url] : undefined,
    timeoutMs: 240_000,
  });
  if (!gen.png) return { previewUrl: null, pack, usedReference: !!best, error: gen.error || (gen.not_configured ? "image worker not configured" : "generation failed") };

  try {
    const url = await uploadToR2(gen.png, multipackImageKey(sku, "main", `ai-${opts.stamp}`));
    return { previewUrl: url, pack, usedReference: !!best };
  } catch (e: any) {
    return { previewUrl: null, pack, usedReference: !!best, error: `R2 upload failed: ${String(e?.message || e).slice(0, 80)}` };
  }
}
