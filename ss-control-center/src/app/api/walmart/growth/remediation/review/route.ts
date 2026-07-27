/**
 * Walmart Growth — QC Review API (Vladimir's final-QC screen).
 *
 * GET  ?sku=&storeIndex= → the FULL generated result for a listing (title,
 *      bullets, description, main image, gallery, attributes) pulled from the
 *      persisted remediation log — so the operator sees exactly what we sent to
 *      Walmart WITHOUT waiting for Walmart's slow propagation. Plus a rough
 *      "before" (the prior remediation's image) and a short run history.
 * POST is permanently retired. The former handler re-enqueued an unconstrained
 * full A-to-Z mutation through the legacy WalmartRemediationQueue.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CONTENT_KEYS = new Set(["productName", "shortDescription", "keyFeatures", "mainImageUrl", "productSecondaryImageURL"]);
type JsonRecord = Record<string, unknown>;

function parseContent(changeSummary: unknown): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(typeof changeSummary === "string" ? changeSummary : "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const content = (parsed as JsonRecord).content;
    return content && typeof content === "object" && !Array.isArray(content)
      ? content as JsonRecord
      : null;
  } catch {
    return null;
  }
}
function attrsOf(content: unknown): JsonRecord {
  if (!content || typeof content !== "object") return {};
  const out: JsonRecord = {};
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
  )) as JsonRecord[];
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

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: "LEGACY_WALMART_QC_REQUEUE_RETIRED",
      reason:
        "Legacy full A-to-Z requeue is disabled. Use the frozen one-SKU Listing Integrity operator.",
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
