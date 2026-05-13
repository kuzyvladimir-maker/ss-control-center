/**
 * /api/shipping/packing-profile
 *
 * POST  — upsert a profile keyed by composition signature. Body:
 *   {
 *     signature: string,            // "SKU1:QTY1|SKU2:QTY2|..."
 *     description: string,
 *     boxSize: string,
 *     weight: number,
 *     weightFedex?: number,
 *     itemCount: number,
 *     totalQty: number,
 *   }
 *
 * GET   — `?signature=…` look up a single profile (for the UI modal /
 *         debugging). Returns 404 when missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const sig = request.nextUrl.searchParams.get("signature");
  if (!sig) {
    return NextResponse.json(
      { error: "signature query param required" },
      { status: 400 }
    );
  }
  const profile = await prisma.packingProfile.findUnique({
    where: { signature: sig },
  });
  if (!profile) {
    return NextResponse.json({ found: false }, { status: 404 });
  }
  return NextResponse.json({ found: true, profile });
}

interface PostBody {
  signature?: string;
  description?: string;
  boxSize?: string;
  weight?: number;
  weightFedex?: number;
  itemCount?: number;
  totalQty?: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const signature = body.signature?.trim();
  const boxSize = body.boxSize?.trim();
  const weight = Number(body.weight);
  if (!signature || !boxSize || !Number.isFinite(weight) || weight <= 0) {
    return NextResponse.json(
      { error: "signature, boxSize, and weight (>0) are required" },
      { status: 400 }
    );
  }
  const weightFedex =
    body.weightFedex != null && Number.isFinite(Number(body.weightFedex))
      ? Number(body.weightFedex)
      : null;

  const profile = await prisma.packingProfile.upsert({
    where: { signature },
    create: {
      signature,
      description: body.description ?? null,
      boxSize,
      weight,
      weightFedex,
      itemCount: Math.max(1, Number(body.itemCount) || 1),
      totalQty: Math.max(1, Number(body.totalQty) || 1),
      source: "manual",
    },
    update: {
      description: body.description ?? null,
      boxSize,
      weight,
      weightFedex,
      itemCount: Math.max(1, Number(body.itemCount) || 1),
      totalQty: Math.max(1, Number(body.totalQty) || 1),
    },
  });

  return NextResponse.json({ success: true, profile });
}
