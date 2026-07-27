import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/customer-hub/chargebacks
// Thin wrapper over the AtozzClaim table, filtered to claimType=CHARGEBACK.
// Returns the same `{ claims, total }` shape as /api/customer-hub/atoz so
// the two tabs can share the AtozDetail component.
export async function GET() {
  try {
    const [claims, total] = await Promise.all([
      prisma.atozzClaim.findMany({
        where: { claimType: "CHARGEBACK" },
        orderBy: { createdAt: "desc" },
      }),
      prisma.atozzClaim.count({ where: { claimType: "CHARGEBACK" } }),
    ]);
    return NextResponse.json({ claims, total });
  } catch (err) {
    console.error("[customer-hub/chargebacks] GET failed:", err);
    return NextResponse.json({ claims: [], total: 0 });
  }
}
