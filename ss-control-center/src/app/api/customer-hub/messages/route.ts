import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getConnectedGmailAccounts,
  searchMessages,
  readMessage,
  readThread,
  loadEmailToStoreMap,
} from "@/lib/gmail-api";
import { parseAmazonBuyerEmail } from "@/lib/customer-hub/gmail-parser";
import { enrichMessage } from "@/lib/customer-hub/message-enricher";
import { analyzeMessage } from "@/lib/customer-hub/message-analyzer";
import { seedKnowledgeBase } from "@/lib/customer-hub/knowledge-base";

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

    // Seed the knowledge base on first sync run (idempotent — exits
    // early if any KB entries already exist).
    try {
      await seedKnowledgeBase();
    } catch (e) {
      console.warn(
        "[Sync] seedKnowledgeBase failed:",
        e instanceof Error ? e.message : String(e)
      );
    }

    // Preload email→store mapping once from Setting table so
    // parseAmazonBuyerEmail doesn't hit the DB for every message.
    const emailToStoreMap = await loadEmailToStoreMap();

    let totalSynced = 0;
    let confirmationsSynced = 0;
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
            const parsed = parseAmazonBuyerEmail(fullMsg, emailToStoreMap);
            if (!parsed) continue; // Not a buyer message

            // Thread-size heuristic for "already handled". When the seller
            // replies via Amazon Seller Central, Amazon sends a
            // confirmation email to the seller Gmail which lands in the
            // same thread. If the thread has more than 1 message, the
            // case is likely already resolved — mark it accordingly so
            // it stays out of the Active queue.
            let autoResolved = false;
            if (parsed.gmailThreadId) {
              try {
                const thread = await readThread(
                  account.refreshToken,
                  parsed.gmailThreadId
                );
                const threadMsgCount = thread.messages?.length || 1;
                if (threadMsgCount > 1) {
                  autoResolved = true;
                  console.log(
                    `[Sync] Thread ${parsed.gmailThreadId} has ${threadMsgCount} messages — auto-marking as RESOLVED`
                  );
                }
              } catch (threadErr) {
                console.warn(
                  "[Sync] Thread lookup failed:",
                  threadErr instanceof Error
                    ? threadErr.message
                    : String(threadErr)
                );
              }
            }

            // Enrich with SP-API + Veeqo
            const enriched = await enrichMessage(parsed);

            // Save to DB
            const saved = await prisma.buyerMessage.create({
              data: {
                gmailMessageId: enriched.gmailMessageId,
                gmailThreadId: enriched.gmailThreadId,
                receivedAt: enriched.receivedAt,
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
                requestedShippingService: enriched.requestedShippingService,
                actualShippingService: enriched.actualShippingService,
                shippingMismatch: enriched.shippingMismatch,
                carrierEstimatedDelivery: enriched.carrierEstimatedDelivery,
                boughtThroughVeeqo: enriched.boughtThroughVeeqo,
                claimsProtected: enriched.claimsProtected,
                shippedOnTime: enriched.shippedOnTime,
                direction: "incoming",
                customerMessage: enriched.customerMessage,
                status: autoResolved ? "RESOLVED" : "NEW",
                resolution: autoResolved
                  ? "auto_resolved_gmail_thread"
                  : null,
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

            // Skip Claude analysis for auto-resolved messages — there's
            // nothing to draft a response for, and it saves an API call.
            if (autoResolved) {
              totalSynced++;
              continue;
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
                requestedShippingService: enriched.requestedShippingService,
                actualShippingService: enriched.actualShippingService,
                shippingMismatch: enriched.shippingMismatch,
                carrierEstimatedDelivery: enriched.carrierEstimatedDelivery,
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
                  reasoning: analysis.reasoning,
                  category: analysis.problemType,
                  categoryName: analysis.problemTypeName,
                  priority: analysis.riskLevel,
                  status: "ANALYZED",
                  factCheckJson: JSON.stringify(analysis.factCheck),
                },
              });
            } catch (aiErr) {
              console.warn(`[Sync] AI analysis failed for ${saved.id}:`, aiErr);
            }

            totalSynced++;
          } catch (msgErr) {
            // Log full error with stack to dev console, but return only a
            // short first-line summary to the UI so we don't dump a Prisma
            // error's full data payload into the sync result toast.
            console.error(`[Sync] Message ${msgId} failed:`, msgErr);
            const fullMsg =
              msgErr instanceof Error ? msgErr.message : String(msgErr);
            const shortMsg = fullMsg.split("\n")[0].slice(0, 200);
            errors.push(`Message ${msgId}: ${shortMsg}`);
          }
        }

        // =============================================================
        // Confirmation sweep — detect replies sent via Seller Central
        // =============================================================
        // Amazon Seller Central's "Confirmation Notifications" setting
        // emails the seller when a buyer response is successfully
        // delivered. If enabled, those confirmation emails land in this
        // Gmail account and we can use them to auto-flip the original
        // BuyerMessage to SENT without the operator clicking anything.
        //
        // Heuristic: search for emails whose subject contains any of
        // "Your response", "message sent", "confirmation" sent to this
        // account in the last 2 days, extract the Amazon Order ID via
        // regex, then mark any matching NEW/ANALYZED BuyerMessage as
        // SENT with responseSentVia=SELLER_CENTRAL.
        try {
          const confirmationQuery = `to:${account.email} (subject:"Your response" OR subject:"message sent" OR subject:"confirmation") newer_than:2d`;
          const confirmations = await searchMessages(
            account.refreshToken,
            confirmationQuery,
            30
          );
          for (const cm of confirmations) {
            const cmId = cm.id;
            if (!cmId) continue;
            try {
              const fullCm = await readMessage(account.refreshToken, cmId);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const headers: any[] = fullCm.payload?.headers || [];
              const subject =
                headers.find(
                  (h) => h?.name?.toLowerCase() === "subject"
                )?.value || "";
              const snippet = fullCm.snippet || "";
              const orderMatch =
                subject.match(/(\d{3}-\d{7}-\d{7})/) ||
                snippet.match(/(\d{3}-\d{7}-\d{7})/);
              if (!orderMatch) continue;
              const orderId = orderMatch[1];

              // Parse confirmation email date for responseSentAt
              const dateHeader =
                headers.find((h) => h?.name?.toLowerCase() === "date")
                  ?.value || null;
              let sentAt = new Date();
              if (dateHeader) {
                const parsed = new Date(dateHeader);
                if (!Number.isNaN(parsed.getTime())) sentAt = parsed;
              } else if (fullCm.internalDate) {
                sentAt = new Date(parseInt(fullCm.internalDate));
              }

              const target = await prisma.buyerMessage.findFirst({
                where: {
                  amazonOrderId: orderId,
                  direction: "incoming",
                  status: { in: ["NEW", "ANALYZED"] },
                },
                orderBy: { createdAt: "desc" },
              });

              if (target) {
                await prisma.buyerMessage.update({
                  where: { id: target.id },
                  data: {
                    status: "SENT",
                    responseSentVia: "SELLER_CENTRAL",
                    responseSentAt: sentAt,
                  },
                });
                confirmationsSynced++;
                console.log(
                  "[Sync] Confirmation detected for order:",
                  orderId,
                  "-> marked",
                  target.id,
                  "as SENT"
                );
              }
            } catch (cmErr) {
              console.warn(
                "[Sync] Confirmation email read failed:",
                cmErr instanceof Error ? cmErr.message : String(cmErr)
              );
            }
          }
        } catch (confErr) {
          console.warn(
            "[Sync] Confirmation sweep failed for",
            account.email,
            confErr instanceof Error ? confErr.message : String(confErr)
          );
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
      confirmations: confirmationsSynced,
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
