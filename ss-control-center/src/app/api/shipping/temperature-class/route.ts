/**
 * Temperature class per SKU (topic 135).
 *
 *   GET  /api/shipping/temperature-class?skus=a,b,c
 *        → { classes: { sku: "FROZEN"|"CHILLED"|"DRY" } } for rows that exist.
 *
 *   POST /api/shipping/temperature-class
 *        body: { sku, class, setBy?, note? }
 *        Upserts the MANUAL class (source "manual") and appends an audit row.
 *        Does NOT write a Veeqo tag — mirroring the tag is a separate, later
 *        step the owner runs after reviewing (topic 135, point 3).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isTempClass } from "@/lib/shipping/temp-class";

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
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const sku = String(body?.sku ?? "").trim();
  const klass = String(body?.class ?? "").trim().toUpperCase();
  if (!sku) {
    return NextResponse.json({ error: "sku is required" }, { status: 400 });
  }
  if (!isTempClass(klass)) {
    return NextResponse.json(
      { error: 'class must be "FROZEN", "CHILLED" or "DRY"' },
      { status: 400 },
    );
  }

  const existing = await prisma.skuTemperatureClass.findUnique({
    where: { sku },
    select: { class: true },
  });
  const fromClass = existing?.class ?? null;

  if (fromClass !== klass) {
    await prisma.skuTemperatureClass.upsert({
      where: { sku },
      create: {
        sku,
        class: klass,
        source: "manual",
        setBy: body.setBy ?? null,
        note: body.note ?? null,
      },
      update: {
        class: klass,
        source: "manual",
        setBy: body.setBy ?? null,
        note: body.note ?? null,
      },
    });
    await prisma.skuTemperatureClassChange.create({
      data: {
        sku,
        fromClass,
        toClass: klass,
        source: "manual",
        setBy: body.setBy ?? null,
      },
    });
  }

  return NextResponse.json({ success: true, sku, class: klass, fromClass });
}
