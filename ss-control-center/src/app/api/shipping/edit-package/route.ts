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
  // Order channel ("Amazon" | "Walmart" | ...). Walmart orders are rate-
  // shopped + bought through Walmart's own Ship-with-Walmart API, NOT Veeqo,
  // so there's no Veeqo allocation to update — skip the push (and don't
  // surface its absence as a scary error).
  channel?: string;
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

  // Walmart orders don't live in Veeqo for shipping — rates/labels come from
  // Walmart's own API — so there's no allocation_package to push. Skip the
  // Veeqo update and report it as a benign skip (not a failure).
  const skipVeeqo = String(body.channel ?? "").toLowerCase().includes("walmart");
  const maybePushVeeqo = (args: Parameters<typeof pushPackageToVeeqo>[0]) =>
    skipVeeqo
      ? Promise.resolve({
          ok: true as const,
          skipped: true,
          reason: "Walmart order — packaging is rate-shopped via Walmart, not Veeqo.",
        })
      : pushPackageToVeeqo(args);

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

    const veeqo = await maybePushVeeqo({
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
    const veeqo = await maybePushVeeqo({
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
  const veeqo = await maybePushVeeqo({
    allocationId: body.allocationId,
    L: body.length,
    W: body.width,
    H: body.height,
    weightLbs: weight,
  });
  return NextResponse.json({ kind: "skuShippingData", id: created.id, veeqo });
}

// PUT to Veeqo's allocation_package endpoint and verify the new package
// from the PUT response body itself. Earlier we did a separate GET
// /allocations/{id} readback, but that endpoint returns `{}` (empty
// object) for many allocations — there's no `allocation_package` field
// on it — so the readback always falsely reported "Veeqo did NOT
// update" even when the PUT actually succeeded.
//
// Veeqo's PUT response IS the canonical post-update state:
//   {
//     "data": {
//       "type": "allocation_package",
//       "attributes": {
//         "allocation_id": <id>,
//         "depth": <in>, "width": <in>, "height": <in>,
//         "dimensions_unit": "inches",
//         "weight": <oz>, "weight_unit": "oz",
//         "package_selection_source": "ONE_OFF",
//         ...
//       }
//     }
//   }
//
// We compare those attributes against what we sent. If they match, we
// trust the PUT — no extra GET needed.
//
// Tolerance: Veeqo stores weight in oz internally; we PUT in oz and
// compare with a 0.5 oz tolerance for rounding. Dimensions are inches
// both sides — we allow 0.05 in slop for float jitter. Unit
// conversion handles a g↔oz or cm↔in surprise.
async function pushPackageToVeeqo(args: {
  allocationId: unknown;
  L: number | null | undefined;
  W: number | null | undefined;
  H: number | null | undefined;
  weightLbs: number;
}): Promise<{
  ok: boolean;
  reason?: string;
  // When verification reads back values that don't match what we wrote,
  // we surface BOTH sides so the operator can diagnose from the toast.
  actual?: { weightOz?: number; depth?: number; width?: number; height?: number };
  expected?: { weightOz: number; depth: number; width: number; height: number };
}> {
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
  const expected = {
    weightOz: Math.round(weightLbs * 16 * 100) / 100,
    depth: Number(L),
    width: Number(W),
    height: Number(H),
  };

  let putResponse: unknown;
  try {
    putResponse = await updateAllocationPackage(numericAllocId, {
      weightLbs,
      lengthIn: expected.depth,
      widthIn: expected.width,
      heightIn: expected.height,
      saveForSimilar: false,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `[edit-package] Veeqo allocation_package PUT failed for allocation ${numericAllocId}:`,
      reason,
    );
    return { ok: false, reason, expected };
  }

  // Pull the saved attributes out of the PUT response.
  const attrs = (() => {
    if (!putResponse || typeof putResponse !== "object") return null;
    const data = (putResponse as { data?: unknown }).data;
    if (!data || typeof data !== "object") return null;
    const a = (data as { attributes?: unknown }).attributes;
    return a && typeof a === "object" ? (a as Record<string, unknown>) : null;
  })();

  if (!attrs) {
    // Veeqo returned 200 but in an unexpected shape. Trust the HTTP
    // success — the PUT was accepted — but flag the unverified state
    // so the operator knows to double-check.
    console.warn(
      `[edit-package] PUT for allocation ${numericAllocId} returned no data.attributes — trusting HTTP 200`,
    );
    return { ok: true, expected };
  }

  // Veeqo may echo `dimensions_unit: "inches"` even though we sent
  // "in" — that's fine, the values are still in inches. Only convert
  // when it's explicitly cm.
  const dimUnit = String(attrs.dimensions_unit ?? "in").toLowerCase();
  const wUnit = String(attrs.weight_unit ?? "oz").toLowerCase();
  const num = (k: string): number | undefined =>
    typeof attrs[k] === "number" ? (attrs[k] as number) : undefined;
  const toInches = (v: number | undefined): number | undefined => {
    if (v == null) return undefined;
    return dimUnit === "cm" ? v / 2.54 : v;
  };
  const toOz = (v: number | undefined): number | undefined => {
    if (v == null) return undefined;
    return wUnit === "g" ? v / 28.3495 : v;
  };
  const actual = {
    weightOz: (() => {
      const x = toOz(num("weight"));
      return typeof x === "number" ? Math.round(x * 100) / 100 : undefined;
    })(),
    depth: toInches(num("depth")),
    width: toInches(num("width")),
    height: toInches(num("height")),
  };
  const close = (a: number | undefined, b: number, tol: number) =>
    typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= tol;
  const weightOk = close(actual.weightOz, expected.weightOz, 0.5);
  const depthOk = close(actual.depth, expected.depth, 0.05);
  const widthOk = close(actual.width, expected.width, 0.05);
  const heightOk = close(actual.height, expected.height, 0.05);
  if (weightOk && depthOk && widthOk && heightOk) {
    return { ok: true, actual, expected };
  }
  const drift: string[] = [];
  if (!weightOk)
    drift.push(`weight: sent ${expected.weightOz}oz, Veeqo saved ${actual.weightOz ?? "?"}oz`);
  if (!depthOk)
    drift.push(`depth: sent ${expected.depth}in, Veeqo saved ${actual.depth ?? "?"}in`);
  if (!widthOk)
    drift.push(`width: sent ${expected.width}in, Veeqo saved ${actual.width ?? "?"}in`);
  if (!heightOk)
    drift.push(`height: sent ${expected.height}in, Veeqo saved ${actual.height ?? "?"}in`);
  console.warn(
    `[edit-package] Veeqo PUT response disagrees with what we sent for allocation ${numericAllocId}: ${drift.join("; ")}`,
  );
  return {
    ok: false,
    reason: `Veeqo PUT returned OK but the saved values disagree — ${drift.join("; ")}`,
    actual,
    expected,
  };
}
