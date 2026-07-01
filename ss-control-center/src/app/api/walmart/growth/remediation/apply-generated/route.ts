/**
 * POST /api/walmart/growth/remediation/apply-generated  { sku, imageUrl }
 *
 * Publish an operator-APPROVED generated main image to Walmart (the "apply" step
 * of the manual generation lever). Submits an MP_MAINTENANCE partial feed that
 * touches only mainImageUrl. Returns the feedId.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalmartClient } from "@/lib/walmart/client";
import { submitMainImageOnly } from "@/lib/walmart/multipack/remediate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let sku = "", imageUrl = "";
  try { const b = await request.json(); sku = String(b?.sku || "").trim(); imageUrl = String(b?.imageUrl || "").trim(); } catch {}
  if (!sku || !imageUrl) return NextResponse.json({ error: "sku and imageUrl required" }, { status: 400 });
  if (!/^https?:\/\//.test(imageUrl)) return NextResponse.json({ error: "imageUrl must be an absolute URL" }, { status: 400 });

  const storeIndex = Number(new URL(request.url).searchParams.get("storeIndex") || 1);
  try {
    const client = getWalmartClient(storeIndex);
    const r = await submitMainImageOnly(client, sku, imageUrl);
    if (!r.feedId) return NextResponse.json({ ok: false, ...r }, { status: 200 });
    return NextResponse.json({ ok: true, feedId: r.feedId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
