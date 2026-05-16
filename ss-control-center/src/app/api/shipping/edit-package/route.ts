// POST /api/shipping/edit-package
//
// Single endpoint for the "edit weight + box" inline action on a Shipping
// Labels row. Two flavours:
//   1. Single-item order (body has `sku`)  → patches that SKU's
//      SkuShippingData row, preserving fields the operator didn't change
//      (productTitle, marketplace, category) but overwriting weight + dims
//      so future plans for that SKU pick up the new packaging immediately.
//   2. Multi-item order  (body has `signature`) → upserts a PackingProfile
//      row keyed by composition signature, same shape as
//      /api/shipping/packing-profile uses.
//
// Body:
//   {
//     sku?:        string,
//     signature?:  string,
//     description?: string,            // only used in multi-item path
//     itemCount?:  number,             // only used in multi-item path
//     totalQty?:   number,             // only used in multi-item path
//     length?:     number,
//     width?:      number,
//     height?:     number,
//     weight:      number,
//     weightFedex?: number,
//   }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface Body {
  sku?: string;
  signature?: string;
  description?: string;
  itemCount?: number;
  totalQty?: number;
  length?: number;
  width?: number;
  height?: number;
  weight?: number;
  weightFedex?: number;
  boxSize?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;

  const weight = Number(body.weight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return NextResponse.json(
      { error: "weight (positive number) is required" },
      { status: 400 },
    );
  }

  // ── Multi-item path ───────────────────────────────────────────────────
  if (body.signature && typeof body.signature === "string") {
    // Custom dimensions (L/W/H) are required for multi-item too — the
    // dialog now always sends them. boxSize echoes either a preset
    // label ("M", "12x12x6") or the synthesised "LxWxH" string for
    // free-entry sizes; either way it's stored verbatim so the
    // warehouse sees the friendly label in plan exports.
    const L = Number(body.length);
    const W = Number(body.width);
    const H = Number(body.height);
    if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) {
      return NextResponse.json(
        {
          error:
            "length, width, height (positive numbers) are required for packing profile",
        },
        { status: 400 },
      );
    }
    if (!body.boxSize || typeof body.boxSize !== "string") {
      return NextResponse.json(
        { error: "boxSize is required for multi-item packing profile" },
        { status: 400 },
      );
    }
    const profile = await prisma.packingProfile.upsert({
      where: { signature: body.signature },
      create: {
        signature: body.signature,
        description: body.description ?? "",
        boxSize: body.boxSize,
        weight,
        weightFedex: body.weightFedex ?? weight * 1.25,
        itemCount: body.itemCount ?? 1,
        totalQty: body.totalQty ?? 1,
        source: "manual",
      },
      update: {
        description: body.description ?? undefined,
        boxSize: body.boxSize,
        weight,
        weightFedex: body.weightFedex ?? weight * 1.25,
        itemCount: body.itemCount ?? undefined,
        totalQty: body.totalQty ?? undefined,
      },
    });
    return NextResponse.json({ kind: "packingProfile", id: profile.id });
  }

  // ── Single-item path ──────────────────────────────────────────────────
  if (!body.sku || typeof body.sku !== "string") {
    return NextResponse.json(
      { error: "sku or signature is required" },
      { status: 400 },
    );
  }
  const existing = await prisma.skuShippingData.findUnique({
    where: { sku: body.sku },
  });
  if (existing) {
    const next = await prisma.skuShippingData.update({
      where: { sku: body.sku },
      data: {
        // Preserve metadata fields — operator only intends to change
        // weight / box on this path.
        weight,
        weightFedex: body.weightFedex ?? weight * 1.25,
        length: body.length ?? existing.length,
        width: body.width ?? existing.width,
        height: body.height ?? existing.height,
      },
    });
    return NextResponse.json({ kind: "skuShippingData", id: next.id });
  }
  // Row doesn't exist yet — create a minimal one. Operator can fill in
  // marketplace/category later from Settings → SKU database.
  if (
    body.length == null ||
    body.width == null ||
    body.height == null
  ) {
    return NextResponse.json(
      {
        error:
          "SKU not in database yet — please provide length, width, height (in inches) along with weight.",
      },
      { status: 400 },
    );
  }
  const created = await prisma.skuShippingData.create({
    data: {
      sku: body.sku,
      productTitle: "",
      marketplace: "Amazon",
      category: "Dry",
      length: body.length,
      width: body.width,
      height: body.height,
      weight,
      weightFedex: body.weightFedex ?? weight * 1.25,
      source: "manual",
    },
  });
  return NextResponse.json({ kind: "skuShippingData", id: created.id });
}
