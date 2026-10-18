import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  activeClaimsWhere,
  liveChannels,
  unreadMessagesWhere,
} from "@/lib/customer-hub/live-counts";

export async function GET() {
  try {
    // "Urgent" = unreplied buyer messages whose 24-hour Amazon response
    // deadline is within the next 4 hours (i.e. created more than 20 hours
    // ago and still NEW or ANALYZED).
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000);
    // Shared definitions with the Dashboard tile + sidebar badge — see
    // src/lib/customer-hub/live-counts.ts.
    const channels = await liveChannels();

    const [
      unreadMessages,
      urgentMessages,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    ] = await Promise.all([
      // "Unread" = anything the operator hasn't replied to yet. After AI
      // analysis the status flips to ANALYZED but it's still waiting for
      // a human decision, so we count both. Live channels only.
      prisma.buyerMessage.count({ where: unreadMessagesWhere(channels) }),
      prisma.buyerMessage.count({
        where: {
          ...unreadMessagesWhere(channels),
          createdAt: { lt: twentyHoursAgo },
        },
      }),
      // A-to-Z only (chargebacks have their own card) — was counting both.
      prisma.atozzClaim.count({ where: activeClaimsWhere("A_TO_Z") }),
      prisma.atozzClaim.count({ where: activeClaimsWhere("CHARGEBACK") }),
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
