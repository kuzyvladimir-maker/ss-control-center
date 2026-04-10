import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

export async function GET() {
  try {
    const storeCards = [];

    for (let i = 1; i <= 5; i++) {
      const creds = getStoreCredentials(i);
      const name = process.env[`STORE${i}_NAME`] || `Store ${i}`;

      if (!creds) {
        storeCards.push({
          index: i,
          name,
          channel: "Amazon",
          configured: false,
        });
        continue;
      }

      // CS cases for this store (approximate — match by store name pattern)
      const storePattern = `Store ${i}`;
      const [openCases, urgentCases, chargebacks, atozClaims, feedback] =
        await Promise.all([
          prisma.csCase.count({ where: { status: "open" } }),
          prisma.csCase.count({
            where: {
              status: "open",
              priority: { in: ["HIGH", "CRITICAL"] },
            },
          }),
          prisma.atozzClaim.count({
            where: {
              claimType: "CHARGEBACK",
              status: { in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY"] },
            },
          }),
          prisma.atozzClaim.count({
            where: {
              claimType: "A_TO_Z",
              status: { in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY", "SUBMITTED"] },
            },
          }),
          prisma.sellerFeedback.findMany({
            where: { store: storePattern },
            orderBy: { createdAt: "desc" },
            take: 100,
          }),
        ]);

      // Feedback stats
      const recentFeedback = feedback.filter(
        (f) =>
          new Date(f.createdAt) >
          new Date(Date.now() - 7 * 86400000)
      );
      const avgRating =
        feedback.length > 0
          ? feedback.reduce((s, f) => s + f.rating, 0) / feedback.length
          : null;

      // Losses from chargebacks/claims
      const losses = await prisma.atozzClaim.aggregate({
        _sum: { amountCharged: true },
        where: {
          amazonDecision: "AGAINST_US",
          decisionDate: {
            gte: new Date().toISOString().slice(0, 7) + "-01", // this month
          },
        },
      });

      // Urgent deadline (closest chargeback/claim deadline)
      const urgentClaim = await prisma.atozzClaim.findFirst({
        where: {
          status: { in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY"] },
          deadline: { not: null },
        },
        orderBy: { deadline: "asc" },
      });

      storeCards.push({
        index: i,
        name,
        channel: "Amazon",
        configured: true,
        messages: { open: i === 1 ? openCases : 0, urgent: i === 1 ? urgentCases : 0 },
        chargebacks: { pending: i === 1 ? chargebacks : 0 },
        atoz: { active: i === 1 ? atozClaims : 0 },
        feedback: {
          avgRating: avgRating ? parseFloat(avgRating.toFixed(1)) : null,
          newCount: recentFeedback.length,
        },
        lossesMtd: losses._sum.amountCharged || 0,
        urgentDeadline: urgentClaim?.deadline || null,
        urgentDaysLeft: urgentClaim?.daysUntilDeadline || null,
      });
    }

    // Walmart placeholder
    storeCards.push({
      index: 6,
      name: "Walmart",
      channel: "Walmart",
      configured: false,
    });

    // Global totals
    const totalOpen = storeCards
      .filter((s) => s.configured)
      .reduce((s, c) => s + (c.messages?.open || 0), 0);
    const totalChargebacks = storeCards
      .filter((s) => s.configured)
      .reduce((s, c) => s + (c.chargebacks?.pending || 0), 0);
    const totalAtoz = storeCards
      .filter((s) => s.configured)
      .reduce((s, c) => s + (c.atoz?.active || 0), 0);
    const totalLosses = storeCards
      .filter((s) => s.configured)
      .reduce((s, c) => s + (c.lossesMtd || 0), 0);

    return NextResponse.json({
      stores: storeCards,
      totals: {
        openCases: totalOpen,
        chargebacks: totalChargebacks,
        atozClaims: totalAtoz,
        lossesMtd: Math.round(totalLosses * 100) / 100,
      },
    });
  } catch (error) {
    console.error("Customer Hub error:", error);
    return NextResponse.json({
      stores: [],
      totals: { openCases: 0, chargebacks: 0, atozClaims: 0, lossesMtd: 0 },
    });
  }
}
