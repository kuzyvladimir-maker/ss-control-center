/**
 * Customer Hub VPS agent tasks (SEND / LOOKUP) — queue, claim, complete.
 * One task = one attempt. An UNKNOWN send result is never re-queued; the
 * agent only reads the thread back (AGENTS.md §7). Tasks for store N are
 * returned only when the caller names store N, so the VPS of one Amazon
 * account never sees another account's work.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

type Msg = NonNullable<Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>>;

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function enqueueSendTask(
  m: Msg,
  opts: { approvedBy: string; cardId?: string | null; attachments?: string[] }
) {
  const body = (m.editedResponse || m.suggestedResponse || "").trim();
  if (!body) throw new Error("No reply text to send");
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
  return prisma.csTask.findMany({
    where: { storeIndex, status: "QUEUED", ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
}

export async function claimTask(taskId: string, vps: string) {
  const res = await prisma.csTask.updateMany({
    where: { id: taskId, status: "QUEUED" },
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
  const now = new Date();
  await prisma.csTask.update({
    where: { id: taskId },
    data: {
      status: outcome,
      completedAt: now,
      resultJson: JSON.stringify({ ...(opts.result || {}), screenshotUrl: opts.screenshotUrl ?? null }),
      error: opts.error ?? null,
    },
  });

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
