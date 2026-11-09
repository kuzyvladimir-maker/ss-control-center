/**
 * When is a buyer message answered? Only by a reply sent AFTER it.
 *
 * Owner, topic 42, 2026-11-01: brenda's 31.10 follow-up (114-2471869-1927461)
 * was closed as "answered in Seller Central" 3 s after its card was built —
 * the confirmation sweep took our 26.10 reply confirmation for the same order
 * (7-day window) without comparing times. Kept free of cs-pipeline imports so
 * the task queue (cs-tasks.ts) can use it without an import cycle.
 */
import { prisma } from "@/lib/prisma";
import { replyAnswers } from "./inbox-rules";

const OPEN_STATUS = ["NEW", "ANALYZED"];

/**
 * Close every still-open incoming message of the order that a reply sent at
 * `sentAt` answers (one Seller Central reply answers the whole thread), and
 * supersede their open cards. Messages that arrived after the reply stay open.
 */
export async function closeAnsweredByReply(
  storeIndex: number,
  orderId: string,
  sentAt: Date,
  via: "SELLER_CENTRAL" | "VPS_AGENT",
  opts: { exceptId?: string; skip?: (messageId: string) => Promise<boolean> } = {}
): Promise<string[]> {
  const open = await prisma.buyerMessage.findMany({
    where: {
      storeIndex,
      amazonOrderId: orderId,
      direction: "incoming",
      status: { in: OPEN_STATUS },
      responseSentAt: null,
      ...(opts.exceptId ? { id: { not: opts.exceptId } } : {}),
    },
    select: { id: true, receivedAt: true, createdAt: true },
  });
  const closed: string[] = [];
  for (const m of open) {
    if (!replyAnswers(m.receivedAt || m.createdAt, sentAt)) continue;
    if (opts.skip && (await opts.skip(m.id))) continue;
    await prisma.$transaction(async (tx) => {
    if (await tx.csTask.findFirst({ where: { buyerMessageId: m.id, kind: "SEND", status: "CLAIMED" } })) return;
    await tx.buyerMessage.update({
      where: { id: m.id },
      data: { status: "SENT", responseSentVia: via, responseSentAt: sentAt, caseStage: "SENT", resolution: `Ответ продавца; source=${via}; sentAt=${sentAt.toISOString()}` },
    });
    await tx.csCard.updateMany({
      where: { buyerMessageId: m.id, status: { in: ["PENDING", "PUBLISHED", "WRONG", "REWORK", "APPROVED", "SEND_FAILED"] } },
      data: { status: "SENT", ownerComment: `Ответ продавца; source=${via}; sentAt=${sentAt.toISOString()}` },
    });
    await tx.csTask.updateMany({ where: { buyerMessageId: m.id, status: "QUEUED" }, data: { status: "CANCELLED", error: `Already answered via ${via} at ${sentAt.toISOString()}` } });
    closed.push(m.id);
    });
  }
  return closed;
}
