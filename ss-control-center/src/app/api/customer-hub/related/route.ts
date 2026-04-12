import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/customer-hub/related?orderId={amazonOrderId}
 *
 * Returns all related items across the three tabs for a given order:
 *   - BuyerMessages (incoming + outgoing)
 *   - AtozzClaims (A-to-Z + chargebacks)
 *   - SellerFeedback
 *
 * Used by MessageDetail, AtozDetail, and FeedbackDetail to show
 * "Related: 2 messages, 1 A-to-Z claim" links that cross-navigate
 * between tabs.
 */
export async function GET(request: NextRequest) {
  try {
    const orderId = request.nextUrl.searchParams.get("orderId");
    if (!orderId) {
      return NextResponse.json(
        { error: "orderId query param required" },
        { status: 400 }
      );
    }

    const [messages, claims, feedback] = await Promise.all([
      prisma.buyerMessage.findMany({
        where: { amazonOrderId: orderId },
        select: {
          id: true,
          direction: true,
          customerName: true,
          problemType: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.atozzClaim.findMany({
        where: { amazonOrderId: orderId },
        select: {
          id: true,
          claimType: true,
          claimReason: true,
          amount: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.sellerFeedback.findMany({
        where: {
          OR: [
            { amazonOrderId: orderId },
            { orderId: orderId },
          ],
        },
        select: {
          id: true,
          rating: true,
          comments: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return NextResponse.json({ messages, claims, feedback });
  } catch (err) {
    console.error("[customer-hub/related] GET failed:", err);
    return NextResponse.json(
      { messages: [], claims: [], feedback: [] },
      { status: 500 }
    );
  }
}
