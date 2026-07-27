import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    // "Urgent" = unreplied buyer messages whose 24-hour Amazon response
    // deadline is within the next 4 hours (i.e. created more than 20 hours
    // ago and still NEW or ANALYZED).
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000);

    const [
      unreadMessages,
      urgentMessages,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    ] = await Promise.all([
      // "Unread" = anything the operator hasn't replied to yet. After AI
      // analysis the status flips to ANALYZED but it's still waiting for
      // a human decision, so we count both.
      prisma.buyerMessage.count({
        where: {
          direction: "incoming",
          status: { in: ["NEW", "ANALYZED"] },
        },
      }),
      prisma.buyerMessage.count({
        where: {
          direction: "incoming",
          status: { in: ["NEW", "ANALYZED"] },
          createdAt: { lt: twentyHoursAgo },
        },
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
      urgentMessages,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    });
  } catch {
    return NextResponse.json({
      unreadMessages: 0,
      urgentMessages: 0,
      activeAtoz: 0,
      activeChargebacks: 0,
      newFeedback: 0,
    });
  }
}
