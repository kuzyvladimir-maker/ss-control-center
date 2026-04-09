import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET — list adjustments with filters
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const channel = sp.get("channel");
  const sku = sp.get("sku");
  const reviewed = sp.get("reviewed");
  const days = parseInt(sp.get("days") || "30");
  const limit = parseInt(sp.get("limit") || "100");

  const where: Record<string, unknown> = {};
  if (channel) where.channel = channel;
  if (sku) where.sku = sku;
  if (reviewed === "true") where.reviewed = true;
  if (reviewed === "false") where.reviewed = false;

  const since = new Date();
  since.setDate(since.getDate() - days);
  where.createdAt = { gte: since };

  const [adjustments, total] = await Promise.all([
    prisma.shippingAdjustment.findMany({
      where,
      orderBy: { adjustmentDate: "desc" },
      take: limit,
    }),
    prisma.shippingAdjustment.count({ where }),
  ]);

  return NextResponse.json({ adjustments, total });
}

// POST — manually add an adjustment
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const adjustment = await prisma.shippingAdjustment.create({
      data: {
        externalId: body.externalId || `manual-${Date.now()}`,
        channel: body.channel || "Amazon",
        orderId: body.orderId,
        amazonOrderId: body.amazonOrderId,
        walmartOrderId: body.walmartOrderId,
        adjustmentDate: body.adjustmentDate || new Date().toISOString().split("T")[0],
        adjustmentType: body.adjustmentType || "CarrierAdjustment",
        adjustmentAmount: body.adjustmentAmount,
        adjustmentReason: body.adjustmentReason,
        sku: body.sku,
        productName: body.productName,
        carrier: body.carrier,
        service: body.service,
        declaredWeightLbs: body.declaredWeightLbs,
        declaredDimL: body.declaredDimL,
        declaredDimW: body.declaredDimW,
        declaredDimH: body.declaredDimH,
        originalLabelCost: body.originalLabelCost,
        adjustedWeightLbs: body.adjustedWeightLbs,
        adjustedDimL: body.adjustedDimL,
        adjustedDimW: body.adjustedDimW,
        adjustedDimH: body.adjustedDimH,
        notes: body.notes,
      },
    });

    // Update SKU adjustment profile
    if (body.sku) {
      await updateSkuAdjustmentProfile(body.sku);
    }

    return NextResponse.json(adjustment);
  } catch (error) {
    console.error("Create adjustment error:", error);
    return NextResponse.json(
      { error: "Failed to create adjustment" },
      { status: 500 }
    );
  }
}

async function updateSkuAdjustmentProfile(sku: string) {
  const adjustments = await prisma.shippingAdjustment.findMany({
    where: { sku },
  });

  if (adjustments.length === 0) return;

  const totalAmount = adjustments.reduce((s, a) => s + a.adjustmentAmount, 0);
  const avgAmount = totalAmount / adjustments.length;

  // Most common type
  const typeCounts: Record<string, number> = {};
  for (const a of adjustments) {
    typeCounts[a.adjustmentType] = (typeCounts[a.adjustmentType] || 0) + 1;
  }
  const mostCommonType =
    Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Suggested weight from adjusted data
  const adjustedWeights = adjustments
    .map((a) => a.adjustedWeightLbs)
    .filter((w): w is number => w !== null);
  const suggestedWeight =
    adjustedWeights.length > 0
      ? adjustedWeights.reduce((s, w) => s + w, 0) / adjustedWeights.length
      : null;

  // Channel where more frequent
  const channelCounts: Record<string, number> = {};
  for (const a of adjustments) {
    channelCounts[a.channel] = (channelCounts[a.channel] || 0) + 1;
  }
  const channel =
    Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const last = adjustments.sort(
    (a, b) => b.adjustmentDate.localeCompare(a.adjustmentDate)
  )[0];

  await prisma.skuAdjustmentProfile.upsert({
    where: { sku },
    create: {
      sku,
      productName: last?.productName,
      totalAdjustments: adjustments.length,
      totalAmountLost: totalAmount,
      avgAdjustmentAmount: avgAmount,
      mostCommonType,
      needsSkuDbUpdate: adjustments.length >= 3,
      suggestedWeight,
      lastAdjustmentDate: last?.adjustmentDate,
      channel,
    },
    update: {
      productName: last?.productName || undefined,
      totalAdjustments: adjustments.length,
      totalAmountLost: totalAmount,
      avgAdjustmentAmount: avgAmount,
      mostCommonType,
      needsSkuDbUpdate: adjustments.length >= 3,
      suggestedWeight,
      lastAdjustmentDate: last?.adjustmentDate,
      channel,
    },
  });
}
