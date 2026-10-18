import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { liveChannels } from "@/lib/customer-hub/live-counts";
import { syncBuyerMessagesFromGmail } from "@/lib/customer-hub/sync-messages";

// GET — list messages from DB.
// Default behaviour: only "active" (NEW + ANALYZED) incoming messages, so
// the Messages tab shows only what still needs a reply. Pass
// ?status=sent|resolved|all to override, or ?orderId=... to load the full
// conversation history for a single order (both incoming + outgoing, all
// statuses).
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const store = sp.get("store");
    const status = (sp.get("status") || "active").toLowerCase();
    const orderId = sp.get("orderId");
    const limit = parseInt(sp.get("limit") || "50");
    const offset = parseInt(sp.get("offset") || "0");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (orderId) {
      // Conversation-history mode — return everything for this order,
      // ignoring direction/status filters
      where.amazonOrderId = orderId;
    } else {
      where.direction = "incoming";
      if (store && store !== "all") where.storeIndex = parseInt(store);
      // Live channels only (same rule as the hub's "Unread" card), unless
      // the caller explicitly asks for ?channels=all.
      if (sp.get("channels") !== "all") {
        where.channel = { in: await liveChannels() };
      }

      if (status === "active") {
        where.status = { in: ["NEW", "ANALYZED"] };
      } else if (status === "sent") {
        where.status = "SENT";
      } else if (status === "resolved") {
        where.status = "RESOLVED";
      } else if (status !== "all") {
        // treat unknown values as a literal status match
        where.status = status.toUpperCase();
      }
    }

    // Sort rules:
    //  - Conversation-history mode (?orderId=…): chronological ASC so the
    //    thread reads top-to-bottom like a chat transcript.
    //  - Active view (default): oldest first, because "oldest" == closest
    //    to the 24-hour Amazon response deadline. Urgent cases surface.
    //  - Any other filter (Sent / Resolved / All): newest first.
    const orderDirection: "asc" | "desc" =
      orderId || status === "active" ? "asc" : "desc";

    const [messages, total] = await Promise.all([
      prisma.buyerMessage.findMany({
        where,
        orderBy: { createdAt: orderDirection },
        take: limit,
        skip: offset,
      }),
      prisma.buyerMessage.count({ where }),
    ]);

    return NextResponse.json({ messages, total });
  } catch (error) {
    console.error("Messages GET error:", error);
    return NextResponse.json({ messages: [], total: 0 });
  }
}

// POST — sync messages from Gmail, or save a Walmart case from screenshots.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    // Save a Walmart case analysis as a BuyerMessage row so it shows up in
    // the Messages tab alongside Amazon messages. Called by WalmartCaseModal
    // after the Claude vision analysis completes.
    if (body.action === "save_walmart") {
      const d = body.data || {};
      if (!d.suggestedResponse && !d.customerMessage) {
        return NextResponse.json(
          { error: "Walmart save requires analysis data" },
          { status: 400 }
        );
      }
      const msg = await prisma.buyerMessage.create({
        data: {
          channel: "Walmart",
          source: "screenshot",
          storeIndex: 0, // 0 = Walmart (not one of the 5 Amazon store slots)
          storeName: "Walmart",
          customerName: d.customerName || null,
          amazonOrderId: d.orderId || null,
          product: d.product || null,
          customerMessage: d.customerMessage || null,
          direction: "incoming",
          problemType: d.problemType || null,
          problemTypeName: d.problemTypeName || null,
          riskLevel: d.riskLevel || null,
          action: d.action || null,
          whoShouldPay: d.whoShouldPay || null,
          suggestedResponse: d.suggestedResponse || null,
          status: "ANALYZED",
          imageData: typeof d.imageData === "string" ? d.imageData : null,
        },
      });
      return NextResponse.json({ message: msg });
    }

    if (body.action !== "sync") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const result = await syncBuyerMessagesFromGmail();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Messages sync error:", error);
    return NextResponse.json(
      {
        synced: 0,
        errors: [error instanceof Error ? error.message : "Sync failed"],
      },
      { status: 500 }
    );
  }
}
