import { NextResponse } from "next/server";
import { mailInbox } from "@/lib/customer-hub/mail-inbox";
import { prisma } from "@/lib/prisma";
import {
  activeClaimsWhere,
} from "@/lib/customer-hub/live-counts";

export async function GET() {
  try {
    const [
      inbox,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    ] = await Promise.all([
      mailInbox(),
      // A-to-Z only (chargebacks have their own card) — was counting both.
      prisma.atozzClaim.count({ where: activeClaimsWhere("A_TO_Z") }),
      prisma.atozzClaim.count({ where: activeClaimsWhere("CHARGEBACK") }),
      prisma.sellerFeedback.count({
        where: { status: "NEW" },
      }),
    ]);

    return NextResponse.json({
      unreadMessages: inbox.stale ? null : inbox.items.length,
      urgentMessages: null,
      mailSource: inbox,
      activeAtoz,
      activeChargebacks,
      newFeedback,
    });
  } catch {
    return NextResponse.json({
      unreadMessages: null,
      urgentMessages: null,
      activeAtoz: 0,
      activeChargebacks: 0,
      newFeedback: 0,
    });
  }
}
