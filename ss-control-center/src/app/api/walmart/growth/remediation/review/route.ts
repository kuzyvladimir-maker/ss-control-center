/**
 * Walmart Growth — QC Review API (Vladimir's final-QC screen).
 *
 * GET  ?sku=&storeIndex= → the FULL generated result for a listing (title,
 *      bullets, description, main image, gallery, attributes) pulled from the
 *      persisted remediation log — so the operator sees exactly what we sent to
 *      Walmart WITHOUT waiting for Walmart's slow propagation. Plus a rough
 *      "before" (the prior remediation's image) and a short run history.
 * POST { sku, note, storeIndex } → "send back for re-do": re-enqueue the SKU for
 *      a fresh full A-to-Z pass (forceImage) carrying the operator's QC note.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CONTENT_KEYS = new Set(["productName", "shortDescription", "keyFeatures", "mainImageUrl", "productSecondaryImageURL"]);

function parseContent(changeSummary: any): any {
  try { return JSON.parse(changeSummary || "{}").content ?? null; } catch { return null; }
}
function attrsOf(content: any): Record<string, any> {
  if (!content || typeof content !== "object") return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(content)) if (!CONTENT_KEYS.has(k)) out[k] = v;
  return out;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sku = url.searchParams.get("sku");
  const storeIndex = Number(url.searchParams.get("storeIndex") || "1");
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, sku, newTitle, bulletsCount, imagesCount, descriptionLength, mainImageUrl,
            changeSummary, feedId, feedStatus, ok, notes, runAt
     FROM WalmartListingRemediation WHERE sku=? AND storeIndex=? ORDER BY runAt DESC LIMIT 6`,
    sku, storeIndex,
  )) as any[];
  if (!rows.length) return NextResponse.json({ sku, found: false });

  const latest = rows[0];
  const content = parseContent(latest.changeSummary);
  const prev = rows.slice(1).find((r) => r.mainImageUrl) || null;

  return NextResponse.json({
    sku, found: true,
    after: {
      title: content?.productName ?? latest.newTitle ?? null,
      mainImageUrl: latest.mainImageUrl ?? content?.mainImageUrl ?? null,
      gallery: Array.isArray(content?.productSecondaryImageURL) ? content.productSecondaryImageURL : [],
      bullets: Array.isArray(content?.keyFeatures) ? content.keyFeatures : [],
      description: content?.shortDescription ?? null,
      attributes: attrsOf(content),
      bulletsCount: Number(latest.bulletsCount ?? 0),
      imagesCount: Number(latest.imagesCount ?? 0),
      descriptionLength: Number(latest.descriptionLength ?? 0),
      feedStatus: latest.feedStatus, ok: !!latest.ok, runAt: latest.runAt, notes: latest.notes,
    },
    before: prev ? { mainImageUrl: prev.mainImageUrl, title: prev.newTitle, runAt: prev.runAt } : null,
    history: rows.map((r) => ({ runAt: r.runAt, feedStatus: r.feedStatus, ok: !!r.ok, mainImageUrl: r.mainImageUrl })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const sku = String(body?.sku || "").trim();
  const note = String(body?.note || "").slice(0, 500);
  const storeIndex = Number(body?.storeIndex || 1);
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  // Re-enqueue a fresh full A-to-Z pass. forceImage → always re-pick + replace the
  // main image (the worker honors result.forceImage). The QC note rides along.
  const result = JSON.stringify({
    scope: { image: true, gallery: true, title: true, bullets: true, description: true, attributes: true },
    forceImage: true, qcNote: note,
  });
  try {
    const r = await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO WalmartRemediationQueue (id, storeIndex, sku, status, requestedBy, result, error)
       VALUES (?, ?, ?, 'queued', 'qc-redo', ?, ?)`,
      randomUUID(), storeIndex, sku, result, note ? `QC redo: ${note}` : "QC redo",
    );
    return NextResponse.json({ ok: true, requeued: Number(r) > 0, sku, note: note || null });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 160) }, { status: 500 });
  }
}
