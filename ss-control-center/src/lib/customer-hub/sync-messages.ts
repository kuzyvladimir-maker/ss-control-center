/**
 * Gmail → Customer Hub ingest: pulls Amazon buyer messages from every
 * connected seller mailbox, enriches + AI-analyses new ones, then runs the
 * confirmation sweep and the stale re-check.
 *
 * Extracted from POST /api/customer-hub/messages {action:"sync"} on
 * 2026-10-18 so a cron can run it. Until then ingest only happened when
 * someone pressed Sync in the hub — the last press was 2026-05-30, and 100+
 * buyer emails since then never reached the hub.
 */
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
import { translateText } from "@/lib/customer-hub/translator";
import { seedKnowledgeBase } from "@/lib/customer-hub/knowledge-base";
import { answeredAfter } from "@/lib/customer-hub/thread-state";
import { runAutosend } from "@/lib/customer-hub/autosend-runner";

export interface SyncBuyerMessagesResult {
  synced: number;
  /** New messages left for the next run because budgetMs ran out. */
  deferred?: number;
  confirmations: number;
  autoResolved: number;
  accounts: number;
  errors?: string[];
}

export async function syncBuyerMessagesFromGmail(
  opts: {
    /** Gmail `newer_than:` window for new buyer messages. Default 2d. */
    window?: string;
    /** Restrict to these mailbox slots (e.g. active Amazon stores). */
    storeIndexes?: number[];
    /**
     * Stop picking up NEW messages after this many ms (each one costs ~50s
     * of enrichment + AI analysis). Leftovers are deduped by gmailMessageId
     * and picked up by the next run, so a backlog never kills the function
     * mid-write at the platform timeout.
     */
    budgetMs?: number;
  } = {}
): Promise<SyncBuyerMessagesResult> {
    let accounts: Awaited<ReturnType<typeof getConnectedGmailAccounts>> = [];
    try {
      accounts = await getConnectedGmailAccounts();
    } catch {
      accounts = [];
    }

    if (opts.storeIndexes) {
      const allow = new Set(opts.storeIndexes);
      accounts = accounts.filter((acc) => allow.has(acc.storeIndex));
    }

    if (accounts.length === 0) {
      return {
        synced: 0,
        confirmations: 0,
        autoResolved: 0,
        accounts: 0,
        errors: [
          "No Gmail accounts connected. Go to Settings to connect Gmail.",
        ],
      };
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

    const startedAt = Date.now();
    let deferred = 0;
    let totalSynced = 0;
    let confirmationsSynced = 0;
    let autoResolvedStale = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      try {
        // Search for buyer messages from last 2 days
        const query = `from:marketplace.amazon.com to:${account.email} newer_than:${opts.window ?? "2d"}`;
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
          if (opts.budgetMs && Date.now() - startedAt > opts.budgetMs) {
            deferred++;
            continue;
          }

          try {
            // Read full message
            const fullMsg = await readMessage(account.refreshToken, msgId);

            // Parse
            const parsed = parseAmazonBuyerEmail(fullMsg, emailToStoreMap);
            if (!parsed) continue; // Not a buyer message

            // "Already handled" check: only a reply from US after this
            // buyer email counts (thread-state.ts). A buyer follow-up in the
            // same thread used to close the case as RESOLVED.
            let autoResolved = false;
            if (parsed.gmailThreadId) {
              try {
                const thread = await readThread(
                  account.refreshToken,
                  parsed.gmailThreadId
                );
                if (answeredAfter(thread.messages, msgId, account.email)) {
                  autoResolved = true;
                  console.log(
                    `[Sync] Thread ${parsed.gmailThreadId} already has our reply — auto-marking as RESOLVED`
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
                trackingEvents: enriched.trackingEvents
                  ? JSON.stringify(enriched.trackingEvents)
                  : null,
                boughtThroughVeeqo: enriched.boughtThroughVeeqo,
                claimsProtected: enriched.claimsProtected,
                shippedOnTime: enriched.shippedOnTime,
                direction: "incoming",
                customerMessage: enriched.customerMessage,
                customerMessageRu: enriched.customerMessage
                  ? await translateText(
                      enriched.customerMessage,
                      "en-ru"
                    ).catch(() => null)
                  : null,
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
                channel: "Amazon",
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
                trackingEvents: enriched.trackingEvents,
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

              const suggestedRu = analysis.suggestedResponse
                ? await translateText(
                    analysis.suggestedResponse,
                    "en-ru"
                  ).catch(() => null)
                : null;

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
                  suggestedResponseRu: suggestedRu,
                  supplierReorderNote: analysis.supplierReorderNote,
                  reasoning: analysis.reasoning,
                  ownerBrief: analysis.ownerBriefRu ?? null,
                  category: analysis.problemType,
                  categoryName: analysis.problemTypeName,
                  priority: analysis.riskLevel,
                  status: "ANALYZED",
                  factCheckJson: JSON.stringify(analysis.factCheck),
                },
              });

              // Auto-send policy: shadow by default (verdict only), sends
              // only when the owner switched customer_hub_autosend = on.
              try {
                await runAutosend(saved.id, {
                  kbTopScore: analysis.kbTopScore,
                  isFallback: analysis.isFallback,
                });
              } catch (autoErr) {
                console.warn(
                  `[Sync] Autosend evaluation failed for ${saved.id}:`,
                  autoErr instanceof Error ? autoErr.message : String(autoErr)
                );
              }
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
        // delivered. The confirmation comes from donotreply@amazon.com
        // with subject like "Your e-mail to {CustomerName}" and body
        // containing "Order ID: 113-XXXXXXX-XXXXXXX" followed by a copy
        // of the seller's message between "Begin message" / "End message"
        // markers.
        //
        // We pull those emails, extract the Order ID via regex, then
        // mark any matching NEW/ANALYZED BuyerMessage as SENT with
        // responseSentVia=SELLER_CENTRAL.
        //
        // Old filter used subject patterns like "Your response" /
        // "message sent" / "confirmation" — none of those match Amazon's
        // actual subject format (verified from a real confirmation email
        // 2026-04-11). Real pattern: subject starts with "Your e-mail to".
        // Sender filter + 7-day window catches cases where sync runs
        // less frequently than every 2 days.
        try {
          const confirmationQuery = `from:donotreply@amazon.com to:${account.email} subject:"Your e-mail to" newer_than:7d`;
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

        // =============================================================
        // Stale ANALYZED re-check — close out cases we already replied to
        // =============================================================
        // The first-sync thread heuristic + confirmation sweep above only
        // catch responses delivered while syncing. Anything we reply to
        // via Seller Central later (without Confirmation Notifications
        // enabled) leaves the BuyerMessage stuck at ANALYZED forever and
        // it visibly rots as OVERDUE in the UI.
        //
        // This pass walks every ANALYZED message for the current account
        // older than 6 hours and re-fetches its Gmail thread. It is
        // auto-resolved only when the thread now holds a reply from US
        // after the buyer's email (thread-state.ts) — a buyer follow-up
        // alone no longer closes the case (bug until 2026-10-19). The 6h
        // floor avoids racing against fresh syncs.
        try {
          const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
          const stale = await prisma.buyerMessage.findMany({
            where: {
              storeIndex: account.storeIndex,
              status: { in: ["NEW", "ANALYZED"] },
              direction: "incoming",
              gmailThreadId: { not: null },
              receivedAt: { lt: sixHoursAgo },
            },
            select: {
              id: true,
              gmailMessageId: true,
              gmailThreadId: true,
              amazonOrderId: true,
            },
            take: 100,
          });

          for (const sm of stale) {
            if (!sm.gmailThreadId) continue;
            try {
              const thread = await readThread(
                account.refreshToken,
                sm.gmailThreadId
              );
              if (
                sm.gmailMessageId &&
                answeredAfter(thread.messages, sm.gmailMessageId, account.email)
              ) {
                await prisma.buyerMessage.update({
                  where: { id: sm.id },
                  data: {
                    status: "RESOLVED",
                    resolution: "auto_resolved_our_reply_in_thread",
                  },
                });
                autoResolvedStale++;
                console.log(
                  `[Sync] Stale re-check: ${sm.id} (thread ${sm.gmailThreadId}) has our reply → RESOLVED`
                );
              }
            } catch (recheckErr) {
              console.warn(
                "[Sync] Stale re-check thread fetch failed for",
                sm.id,
                recheckErr instanceof Error
                  ? recheckErr.message
                  : String(recheckErr)
              );
            }
          }
        } catch (staleErr) {
          console.warn(
            "[Sync] Stale ANALYZED re-check failed for",
            account.email,
            staleErr instanceof Error ? staleErr.message : String(staleErr)
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

    return {
      synced: totalSynced,
      deferred,
      confirmations: confirmationsSynced,
      autoResolved: autoResolvedStale,
      accounts: accounts.length,
      errors: errors.length > 0 ? errors : undefined,
    };
}
