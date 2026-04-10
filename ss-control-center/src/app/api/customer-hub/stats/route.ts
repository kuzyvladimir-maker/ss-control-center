import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const [unreadMessages, activeAtoz, activeChargebacks, newFeedback] =
      await Promise.all([
        prisma.buyerMessage.count({
          where: { status: "NEW", direction: "incoming" },
        }),
        prisma.atozzClaim.count({
          where: {
            status: {
              in: [
                "NEW",
                "EVIDENCE_GATHERED",
                "RESPONSE_READY",
                "SUBMITTED",
              ],
            },
          },
        }),
        prisma.atozzClaim.count({
          where: {
            claimType: "CHARGEBACK",
            status: {
              in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY"],
            },
          },
        }),
        prisma.sellerFeedback.count({
          where: { status: "NEW" },
        }),
      ]);

    return NextResponse.json({
      unreadMessages,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    });
  } catch {
    return NextResponse.json({
      unreadMessages: 0,
      activeAtoz: 0,
      activeChargebacks: 0,
      newFeedback: 0,
    });
  }
}
