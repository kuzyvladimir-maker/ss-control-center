import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET — list A-to-Z claims for the Customer Hub "A-to-Z" tab.
// Pulls straight from the AtozzClaim table that /api/claims/atoz also uses.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = { claimType: "A_TO_Z" };
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
