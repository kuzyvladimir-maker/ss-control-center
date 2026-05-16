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
import { updateAllocationPackage } from "@/lib/veeqo/client";

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
  // When present, also push the new package dims+weight to Veeqo so the
  // next `/shipping/rates/{allocationId}?from_allocation_package=true`
  // quote uses the updated packaging — without this, Veeqo keeps
  // returning rates against its own cached package and our PackingProfile
  // edits look like they had no effect.
  allocationId?: string | number;
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

    const veeqo = await pushPackageToVeeqo({
      allocationId: body.allocationId,
      L,
      W,
      H,
      weightLbs: weight,
    });
    return NextResponse.json({
      kind: "packingProfile",
      id: profile.id,
      veeqo,
    });
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
    const veeqo = await pushPackageToVeeqo({
      allocationId: body.allocationId,
      L: body.length ?? existing.length,
      W: body.width ?? existing.width,
      H: body.height ?? existing.height,
      weightLbs: weight,
    });
    return NextResponse.json({
      kind: "skuShippingData",
      id: next.id,
      veeqo,
    });
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
  const veeqo = await pushPackageToVeeqo({
    allocationId: body.allocationId,
    L: body.length,
    W: body.width,
    H: body.height,
    weightLbs: weight,
  });
  return NextResponse.json({ kind: "skuShippingData", id: created.id, veeqo });
}

// Best-effort PUT to Veeqo's allocation_package endpoint. We treat this
// as additive: the operator's edit is already saved to our DB before
// this runs, so if Veeqo rejects the call (auth issue, allocation in a
// non-editable state, etc) we still surface the success of the local
// save and report Veeqo's outcome alongside so the UI can warn that
// rate quotes will still come back against the old packaging.
async function pushPackageToVeeqo(args: {
  allocationId: unknown;
  L: number | null | undefined;
  W: number | null | undefined;
  H: number | null | undefined;
  weightLbs: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const { allocationId, L, W, H, weightLbs } = args;
  const numericAllocId =
    typeof allocationId === "string" || typeof allocationId === "number"
      ? Number(allocationId)
      : NaN;
  if (!Number.isFinite(numericAllocId) || numericAllocId <= 0) {
    return { ok: false, reason: "no allocationId provided" };
  }
  if (
    L == null ||
    W == null ||
    H == null ||
    !Number.isFinite(Number(L)) ||
    !Number.isFinite(Number(W)) ||
    !Number.isFinite(Number(H))
  ) {
    return { ok: false, reason: "missing dimensions" };
  }
  try {
    await updateAllocationPackage(numericAllocId, {
      weightLbs,
      lengthIn: Number(L),
      widthIn: Number(W),
      heightIn: Number(H),
      saveForSimilar: true,
    });
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `[edit-package] Veeqo allocation_package push failed for allocation ${numericAllocId}:`,
      reason,
    );
    return { ok: false, reason };
  }
}
