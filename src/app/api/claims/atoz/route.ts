import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { determineDefenseStrategy } from "@/lib/claims/strategy";

// GET — list claims with filters
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const status = sp.get("status");
  const claimType = sp.get("type");
  const limit = parseInt(sp.get("limit") || "50");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (claimType) where.claimType = claimType;

  const [claims, total] = await Promise.all([
    prisma.atozzClaim.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.atozzClaim.count({ where }),
  ]);

  return NextResponse.json({ claims, total });
}

// POST — create a new claim (manual entry)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Determine strategy if evidence provided
    let strategy = null;
    if (body.shippedOnTime !== undefined || body.claimsProtectedBadge !== undefined) {
      strategy = determineDefenseStrategy({
        claimsProtected: body.claimsProtectedBadge ?? null,
        shippedOnTime: body.shippedOnTime ?? null,
        trackingStatus: body.trackingStatus ?? null,
        deliveredDate: body.deliveredDate ?? null,
        claimType: body.claimType || "A_TO_Z",
      });
    }

    const claim = await prisma.atozzClaim.create({
      data: {
        amazonOrderId: body.amazonOrderId,
        claimType: body.claimType || "A_TO_Z",
        claimReason: body.claimReason,
        amount: body.amount,
        deadline: body.deadline,
        daysUntilDeadline: body.deadline
          ? Math.ceil(
              (new Date(body.deadline).getTime() - Date.now()) /
                (1000 * 60 * 60 * 24)
            )
          : null,
        trackingNumber: body.trackingNumber,
        carrier: body.carrier,
        shipDate: body.shipDate,
        firstScanDate: body.firstScanDate,
        deliveredDate: body.deliveredDate,
        shippedOnTime: body.shippedOnTime,
        claimsProtectedBadge: body.claimsProtectedBadge,
        strategyType: strategy?.type,
        strategyConfidence: strategy?.confidence,
        vladimirNotes: body.notes,
        csCaseId: body.csCaseId,
        status: strategy ? "EVIDENCE_GATHERED" : "NEW",
      },
    });

    return NextResponse.json(claim);
  } catch (error) {
    console.error("Create claim error:", error);
    return NextResponse.json(
      { error: "Failed to create claim" },
      { status: 500 }
    );
  }
}
