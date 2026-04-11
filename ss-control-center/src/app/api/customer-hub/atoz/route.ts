import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/customer-hub/atoz
// Lists claims from the AtozzClaim table. `type` query param selects which
// kind of claim to return (A_TO_Z by default); the /chargebacks route calls
// this same table with type=CHARGEBACK.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const type = sp.get("type") || "A_TO_Z";
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = { claimType: type };
    if (status && status !== "all") where.status = status;

    const [claims, total] = await Promise.all([
      prisma.atozzClaim.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.atozzClaim.count({ where }),
    ]);

    return NextResponse.json({ claims, total });
  } catch (err) {
    console.error("[customer-hub/atoz] GET failed:", err);
    return NextResponse.json({ claims: [], total: 0 });
  }
}
