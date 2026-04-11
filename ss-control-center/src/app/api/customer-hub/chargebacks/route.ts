import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET — list Chargebacks for the Customer Hub "Chargebacks" tab.
// Chargebacks are stored alongside A-to-Z claims with claimType="CHARGEBACK".
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = { claimType: "CHARGEBACK" };
    if (status && status !== "all") where.status = status;

    const [chargebacks, total] = await Promise.all([
      prisma.atozzClaim.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.atozzClaim.count({ where }),
    ]);

    return NextResponse.json({ chargebacks, total });
  } catch (err) {
    console.error("[customer-hub/chargebacks] GET failed:", err);
    return NextResponse.json({ chargebacks: [], total: 0 });
  }
}
