import { nextStep, type CaseDataSnapshot } from "./case-data-gate";
import { assertSendPolicy } from "./reply-policy";
import { assertActiveCsStore, ACTIVE_CS_STORES } from "./config";
import { validateInboxScan } from "./inbox-rules";
/**
 * Customer Hub VPS agent tasks (SEND / LOOKUP / INBOX_SCAN) — queue, claim, complete.
 * One task = one attempt. An UNKNOWN send result is never re-queued; the
 * agent only reads the thread back (AGENTS.md §7). Tasks for store N are
 * returned only when the caller names store N, so the VPS of one Amazon
 * account never sees another account's work.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { closeAnsweredByReply } from "./answered";

type Msg = NonNullable<Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>>;

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function enqueueSendTask(
  m: Msg,
  opts: { approvedBy: string; cardId?: string | null; attachments?: string[]; ownerRefundAuthorized?: boolean }
) {
  assertActiveCsStore(m.storeIndex);
  if (opts.cardId) {
    const card = await prisma.csCard.findUnique({ where: { id: opts.cardId } });
    if (!card || card.buyerMessageId !== m.id || !["PENDING", "PUBLISHED", "WRONG", "REWORK", "APPROVED"].includes(card.status)) throw new Error("Card is no longer actionable");
    const payload = JSON.parse(card.cardJson);
    if (payload.missingRu || payload.kind === "info" || !payload.draftEn) throw new Error("Card has no verified decision to send");
    if (payload.draftSource !== "owner_verbatim") {
      const snapshot = m.caseDataJson ? JSON.parse(m.caseDataJson) as CaseDataSnapshot : null;
      if (!snapshot?.decision?.ready || nextStep(snapshot) !== "READY" || Date.now() - Date.parse(snapshot.collectedAt) > 2 * 3600_000) throw new Error("Recollect facts before approving this card");
    }
  }
  if (!m.editedResponse) {
    const snapshot = m.caseDataJson ? JSON.parse(m.caseDataJson) as CaseDataSnapshot : null;
    if (!snapshot?.decision?.ready || nextStep(snapshot) !== "READY" || !Number.isFinite(Date.parse(snapshot.collectedAt)) || Date.now() - Date.parse(snapshot.collectedAt) > 2 * 3600_000) throw new Error("Generated replies require fresh verified decision facts");
  }
  const body = (m.editedResponse || m.suggestedResponse || "").trim();
  if (!body) throw new Error("No reply text to send");
  if (!opts.approvedBy.startsWith("owner")) throw new Error("Explicit owner send instruction required");
  assertSendPolicy(body, m.orderTotal, opts.ownerRefundAuthorized);
  if (m.status === "RESOLVED") throw new Error("Case already closed in Amazon");
  if (m.responseSentAt) throw new Error(`Already sent ${m.responseSentAt.toISOString()}`);
  const idempotencyKey = `send:${m.id}:${sha(body)}`;
  const existing = await prisma.csTask.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  const task = await prisma.csTask.create({
    data: {
      kind: "SEND",
      storeIndex: m.storeIndex,
      amazonOrderId: m.amazonOrderId,
      buyerMessageId: m.id,
      cardId: opts.cardId ?? null,
      payloadJson: JSON.stringify({
        body,
        attachments: opts.attachments || [],
        buyerName: m.customerName,
        instructionsRu:
          "Открыть Seller Central ТОЛЬКО на VPS этого аккаунта → Buyer-Seller Messaging → найти заказ по номеру. Сверить номер заказа и имя покупателя; убедиться, что после последнего сообщения покупателя нашего ответа ещё нет. Вставить текст как есть, приложить файлы, Send, скриншот отправленного сообщения. Если результат неясен — НЕ отправлять повторно, только проверить переписку.",
      }),
      idempotencyKey,
      approvedBy: opts.approvedBy,
      approvedAt: new Date(),
    },
  });
  await prisma.buyerMessage.update({ where: { id: m.id }, data: { caseStage: "QUEUED_SEND" } });
  return task;
}

export async function listTasks(storeIndex: number, kind?: string) {
  assertActiveCsStore(storeIndex);
  return prisma.csTask.findMany({
    where: { storeIndex, status: kind === "INBOX_SCAN" ? { in: ["QUEUED", "CLAIMED"] } : "QUEUED", ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
}

export async function claimTask(taskId: string, vps: string) {
  const res = await prisma.csTask.updateMany({
    where: { id: taskId, status: "QUEUED", storeIndex: { in: ACTIVE_CS_STORES } },
    data: { status: "CLAIMED", claimedBy: vps, claimedAt: new Date() },
  });
  if (res.count !== 1) throw new Error(`Task ${taskId} is not QUEUED (already claimed or finished)`);
  return prisma.csTask.findUnique({ where: { id: taskId } });
}

export async function completeTask(
  taskId: string,
  outcome: "DONE" | "FAILED" | "UNKNOWN",
  opts: { result?: Record<string, unknown>; screenshotUrl?: string; error?: string; vps?: string }
) {
  const task = await prisma.csTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "CLAIMED") throw new Error(`Task ${taskId} is ${task.status}, expected CLAIMED`);
  assertActiveCsStore(task.storeIndex);
  const now = new Date();
  if (task.kind === "INBOX_SCAN" && outcome === "DONE") validateInboxScan(opts.result, now);
  await prisma.csTask.update({
    where: { id: taskId },
    data: {
      status: outcome,
      completedAt: now,
      resultJson: JSON.stringify({ ...(opts.result || {}), screenshotUrl: opts.screenshotUrl ?? null }),
      error: opts.error ?? null,
    },
  });

  // Seller Central inbox scan (inbox-watch.ts): the caller reconciles the hub
  // against it in the background.
  if (task.kind === "INBOX_SCAN") return { ok: true, reconcile: outcome === "DONE" };

  const m = await prisma.buyerMessage.findUnique({ where: { id: task.buyerMessageId } });
  if (!m) return { ok: true };

  if (task.kind === "SEND") {
    const body = (JSON.parse(task.payloadJson) as { body: string }).body;
    if (outcome === "DONE") {
      await prisma.buyerMessage.update({
        where: { id: m.id },
        data: { status: "SENT", responseSentAt: now, responseSentVia: "VPS_AGENT", caseStage: "SENT" },
      });
      await prisma.buyerMessage.create({
        data: {
          channel: m.channel,
          source: "vps_agent",
          storeIndex: m.storeIndex,
          storeName: m.storeName,
          storeEmail: m.storeEmail,
          customerName: m.customerName,
          amazonOrderId: m.amazonOrderId,
          product: m.product,
          direction: "outgoing",
          customerMessage: body,
          status: "SENT",
          responseSentAt: now,
          responseSentVia: "VPS_AGENT",
          action: m.action,
          problemType: m.problemType,
          problemTypeName: m.problemTypeName,
          riskLevel: m.riskLevel,
        },
      });
      if (task.cardId) await prisma.csCard.update({ where: { id: task.cardId }, data: { status: "SENT" } });
      // One Seller Central reply answers the whole thread: earlier buyer
      // messages of this order that are still open are answered too.
      if (m.amazonOrderId)
        await closeAnsweredByReply(m.storeIndex, m.amazonOrderId, now, "VPS_AGENT", { exceptId: m.id });
    } else {
      await prisma.buyerMessage.update({
        where: { id: m.id },
        data: { caseStage: outcome === "FAILED" ? "SEND_FAILED" : "SEND_UNKNOWN" },
      });
      if (task.cardId) await prisma.csCard.update({ where: { id: task.cardId }, data: { status: "SEND_FAILED" } });
    }
    return { ok: true, stage: outcome === "DONE" ? "SENT" : outcome };
  }

  // LOOKUP: store what the agent found, then run the case again.
  let snap: Record<string, unknown> = {};
  try {
    snap = m.caseDataJson ? JSON.parse(m.caseDataJson) : {};
  } catch {
    snap = {};
  }
  snap.vpsLookup = { status: outcome, result: opts.result || {}, at: now.toISOString() };
  await prisma.buyerMessage.update({ where: { id: m.id }, data: { caseDataJson: JSON.stringify(snap) } });
  // The caller re-runs processCase(m.id) in the background (after()).
  return { ok: true, reprocessMessageId: m.id };
}
