/**
 * Temperature class per SKU (topic 135).
 *
 *   GET  /api/shipping/temperature-class?skus=a,b,c
 *        → { classes: { sku: "FROZEN"|"CHILLED"|"DRY" } } for rows that exist.
 *
 *   POST /api/shipping/temperature-class
 *        body: { sku, class, setBy?, note?, channel? }
 *        Upserts the MANUAL class (source "manual") and appends an audit row.
 *        channel "walmart" → only DRY (frozen & chilled are forbidden there).
 *        Does NOT write a Veeqo tag — mirroring the tag is a separate, later
 *        step the owner runs after reviewing (topic 135, point 3).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isWalmartChannel, parseManualClass } from "@/lib/shipping/temp-class";
import { saveManualTempClass } from "@/lib/shipping/temp-class/save-manual";

export async function GET(request: NextRequest) {
  const skusParam = request.nextUrl.searchParams.get("skus") || "";
  const skus = skusParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (skus.length === 0) return NextResponse.json({ classes: {} });
  const rows = await prisma.skuTemperatureClass.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, class: true, source: true },
  });
  const classes: Record<string, { class: string; source: string }> = {};
  for (const r of rows) classes[r.sku] = { class: r.class, source: r.source };
  return NextResponse.json({ classes });
}

interface Body {
  sku?: string;
  class?: string;
  setBy?: string;
  note?: string;
  /** Channel of the order the class is set from — "walmart" allows Dry only. */
  channel?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const sku = String(body?.sku ?? "").trim();
  if (!sku) {
    return NextResponse.json({ error: "sku is required" }, { status: 400 });
  }
  const parsed = parseManualClass(body?.class, {
    isWalmart: isWalmartChannel(body?.channel),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { fromClass } = await saveManualTempClass({
    sku,
    klass: parsed.klass,
    setBy: body.setBy ?? null,
    note: body.note ?? null,
  });
  return NextResponse.json({ success: true, sku, class: parsed.klass, fromClass });
}
