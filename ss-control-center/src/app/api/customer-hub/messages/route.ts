import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getConnectedGmailAccounts,
  searchMessages,
  readMessage,
} from "@/lib/gmail-api";
import { parseAmazonBuyerEmail } from "@/lib/customer-hub/gmail-parser";
import { enrichMessage } from "@/lib/customer-hub/message-enricher";
import { analyzeMessage } from "@/lib/customer-hub/message-analyzer";

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

    const [messages, total] = await Promise.all([
      prisma.buyerMessage.findMany({
        where,
        orderBy: { createdAt: orderId ? "asc" : "desc" },
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

    let accounts: Awaited<ReturnType<typeof getConnectedGmailAccounts>> = [];
    try {
      accounts = await getConnectedGmailAccounts();
    } catch {
      accounts = [];
    }

    if (accounts.length === 0) {
      return NextResponse.json({
        synced: 0,
        errors: [
          "No Gmail accounts connected. Go to Settings to connect Gmail.",
        ],
      });
    }

    let totalSynced = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      try {
        // Search for buyer messages from last 2 days
        const query = `from:marketplace.amazon.com to:${account.email} newer_than:2d`;
        const messageList = await searchMessages(
          account.refreshToken,
          query,
          30
        );

        // Bulk-check which messages are already in DB (avoid N+1 queries)
        const incomingIds = messageList
          .map((m) => m.id)
          .filter((id): id is string => Boolean(id));
        const existing = await prisma.buyerMessage.findMany({
          where: { gmailMessageId: { in: incomingIds } },
          select: { gmailMessageId: true },
        });
        const existingIds = new Set(existing.map((e) => e.gmailMessageId));

        for (const msg of messageList) {
          const msgId = msg.id;
          if (!msgId) continue;
          if (existingIds.has(msgId)) continue;

          try {
            // Read full message
            const fullMsg = await readMessage(account.refreshToken, msgId);

            // Parse
            const parsed = parseAmazonBuyerEmail(fullMsg);
            if (!parsed) continue; // Not a buyer message

            // Enrich with SP-API + Veeqo
            const enriched = await enrichMessage(parsed);

            // Save to DB
            const saved = await prisma.buyerMessage.create({
              data: {
                gmailMessageId: enriched.gmailMessageId,
                gmailThreadId: enriched.gmailThreadId,
                channel: "Amazon",
                source: "gmail",
                storeIndex: enriched.storeIndex,
                storeName: enriched.storeName,
                storeEmail: enriched.storeEmail,
                customerName: enriched.customerName,
                customerEmail: enriched.customerEmail,
                language: enriched.language,
                amazonOrderId: enriched.amazonOrderId,
                orderDate: enriched.orderDate,
                orderTotal: enriched.orderTotal,
                product: enriched.product,
                asin: enriched.asin,
                productType: enriched.productType,
                quantity: enriched.quantity,
                carrier: enriched.carrier,
                service: enriched.service,
                trackingNumber: enriched.trackingNumber,
                shipDate: enriched.shipDate,
                promisedEdd: enriched.promisedEdd,
                actualDelivery: enriched.actualDelivery,
                trackingStatus: enriched.trackingStatus,
                daysInTransit: enriched.daysInTransit,
                daysLate: enriched.daysLate,
                boughtThroughVeeqo: enriched.boughtThroughVeeqo,
                claimsProtected: enriched.claimsProtected,
                shippedOnTime: enriched.shippedOnTime,
                direction: "incoming",
                customerMessage: enriched.customerMessage,
                status: "NEW",
              },
            });

            // Repeat-complaint escalation: if the same customer has already
            // written to us about this order, bump the priority and mark the
            // problem type as T20 (Repeat complaint). This runs BEFORE Claude
            // analysis so the AI sees the escalated context.
            if (enriched.amazonOrderId) {
              const previousCount = await prisma.buyerMessage.count({
                where: {
                  amazonOrderId: enriched.amazonOrderId,
                  direction: "incoming",
                  id: { not: saved.id },
                },
              });
              if (previousCount > 0) {
                const escalatedPriority =
                  previousCount >= 2 ? "CRITICAL" : "HIGH";
                await prisma.buyerMessage.update({
                  where: { id: saved.id },
                  data: {
                    priority: escalatedPriority,
                    riskLevel: escalatedPriority,
                    problemType: previousCount >= 2 ? "T20" : undefined,
                    problemTypeName:
                      previousCount >= 2
                        ? "Repeat complaint (3+ messages)"
                        : undefined,
                  },
                });
              }
            }

            // Auto-analyze with Claude (non-blocking — don't fail sync if AI is down)
            try {
              // Get history for this order
              const history = enriched.amazonOrderId
                ? await prisma.buyerMessage.findMany({
                    where: { amazonOrderId: enriched.amazonOrderId, id: { not: saved.id } },
                    orderBy: { createdAt: "asc" },
                  })
                : [];

              const analysis = await analyzeMessage({
                customerMessage: enriched.customerMessage,
                customerName: enriched.customerName,
                language: enriched.language,
                storeName: enriched.storeName,
                amazonOrderId: enriched.amazonOrderId,
                orderDate: enriched.orderDate,
                orderTotal: enriched.orderTotal,
                product: enriched.product,
                productType: enriched.productType,
                carrier: enriched.carrier,
                service: enriched.service,
                trackingNumber: enriched.trackingNumber,
                trackingStatus: enriched.trackingStatus,
                shipDate: enriched.shipDate,
                promisedEdd: enriched.promisedEdd,
                actualDelivery: enriched.actualDelivery,
                daysInTransit: enriched.daysInTransit,
                daysLate: enriched.daysLate,
                boughtThroughVeeqo: enriched.boughtThroughVeeqo,
                claimsProtected: enriched.claimsProtected,
                shippedOnTime: enriched.shippedOnTime,
                messageNumber: history.length + 1,
                conversationHistory: history.map((h) => ({
                  date: h.createdAt.toISOString().split("T")[0],
                  direction: h.direction,
                  text: h.customerMessage || h.suggestedResponse || "",
                  action: h.action,
                })),
                hasAtozClaim: false,
                hasNegativeFeedback: false,
              });

              await prisma.buyerMessage.update({
                where: { id: saved.id },
                data: {
                  problemType: analysis.problemType,
                  problemTypeName: analysis.problemTypeName,
                  riskLevel: analysis.riskLevel,
                  action: analysis.action,
                  secondaryAction: analysis.secondaryAction,
                  whoShouldPay: analysis.whoShouldPay,
                  internalAction: analysis.internalAction,
                  foodSafetyRisk: analysis.foodSafetyRisk,
                  atozRisk: analysis.atozRisk,
                  suggestedResponse: analysis.suggestedResponse,
                  category: analysis.problemType,
                  categoryName: analysis.problemTypeName,
                  priority: analysis.riskLevel,
                  status: "ANALYZED",
                },
              });
            } catch (aiErr) {
              console.warn(`[Sync] AI analysis failed for ${saved.id}:`, aiErr);
            }

            totalSynced++;
          } catch (msgErr) {
            console.error(`[Sync] Message ${msgId} failed:`, msgErr);
            errors.push(
              `Message ${msgId}: ${msgErr instanceof Error ? msgErr.message : "unknown"}`
            );
          }
        }
      } catch (acctErr) {
        console.error(
          `[Sync] Account ${account.email} failed:`,
          acctErr
        );
        errors.push(
          `Account ${account.email}: ${acctErr instanceof Error ? acctErr.message : "unknown"}`
        );
      }
    }

    return NextResponse.json({
      synced: totalSynced,
      accounts: accounts.length,
      errors: errors.length > 0 ? errors : undefined,
    });
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
