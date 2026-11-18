import { SEND_TRANSPORT_ENABLED, verifySentEvidence } from "./send-verification";
import { assertCardDecisionEvidence, assertGeneratedDecisionEvidence } from "./decision-send-gate";
import { assertSendPolicy } from "./reply-policy";
import { assertActiveCsStore, ACTIVE_CS_STORES } from "./config";
/**
 * Customer Hub VPS agent tasks (SEND / LOOKUP / INBOX_SCAN) — queue, claim, complete.
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
  opts: { approvedBy: string; cardId?: string | null; attachments?: string[]; ownerRefundAuthorized?: boolean }
) {
  assertActiveCsStore(m.storeIndex);
  if (opts.cardId) assertCardDecisionEvidence(m, await prisma.csCard.findUnique({ where: { id: opts.cardId } }));
  if (!m.editedResponse) assertGeneratedDecisionEvidence(m.caseDataJson);
  const body = (m.editedResponse || m.suggestedResponse || "").trim();
  if (!body) throw new Error("No reply text to send");
  if (!opts.approvedBy.startsWith("owner")) throw new Error("Explicit owner send instruction required");
  assertSendPolicy(body, m.orderTotal, opts.ownerRefundAuthorized);
  if (m.status === "RESOLVED") throw new Error("Case already closed in Amazon");
  if (m.responseSentAt) throw new Error(`Already sent ${m.responseSentAt.toISOString()}`);
  const idempotencyKey = `send:${m.id}:${sha(body)}`;
  const existing = await prisma.csTask.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  const unresolved=await prisma.csTask.findFirst({where:{kind:"SEND",storeIndex:m.storeIndex,amazonOrderId:m.amazonOrderId,status:{in:["QUEUED","CLAIMED","UNKNOWN","FAILED","BLOCKED"]}}});
  if(unresolved)throw Error(`Prior send ${unresolved.id} is unresolved; verify the thread before any new attempt`);
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
  if (!SEND_TRANSPORT_ENABLED || kind === "INBOX_SCAN") return [];
  assertActiveCsStore(storeIndex);
  return prisma.csTask.findMany({
    where: { storeIndex, status: "QUEUED", ...(kind ? { kind } : { kind: { notIn: ["INBOX_SCAN", ...(!SEND_TRANSPORT_ENABLED?["SEND"]:[])] } }) },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
}

export async function claimTask(taskId: string, vps: string, db=prisma) {
  const target=await db.csTask.findUniqueOrThrow({where:{id:taskId}});
  if(!SEND_TRANSPORT_ENABLED)throw Error("Execution blocked: no verified screen-only executor; work retained, no automatic retry");
  if(target.kind==="INBOX_SCAN")throw Error("Legacy inbox scanning is permanently disabled");
  const res = await db.csTask.updateMany({
    where: { id: taskId, kind: { not: "INBOX_SCAN" }, status: "QUEUED", storeIndex: { in: ACTIVE_CS_STORES } },
    data: { status: "CLAIMED", claimedBy: vps, claimedAt: new Date() },
  });
  if (res.count !== 1) throw new Error(`Task ${taskId} is not QUEUED (already claimed or finished)`);
  return db.csTask.findUnique({ where: { id: taskId } });
}

export async function completeTask(
  taskId: string,
  outcome: "DONE" | "FAILED" | "UNKNOWN",
  opts: { result?: Record<string, unknown>; screenshotUrl?: string; error?: string; vps?: string },
  db=prisma
) {
  const task = await db.csTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task ${taskId} not found`);
  if(task.kind==="SEND"&&task.status==="SENT_VERIFIED")return {ok:true,stage:"sent_verified",alreadyRecorded:true};
  if (task.status !== "CLAIMED") throw new Error(`Task ${taskId} is ${task.status}, expected CLAIMED`);
  assertActiveCsStore(task.storeIndex);
  const now = new Date();
  if (task.kind === "INBOX_SCAN") throw new Error("Chrome inbox scanning permanently disabled; await verified screen evidence");
  if(task.kind === "SEND") {
    if(outcome === "DONE")verifySentEvidence(task,opts.result,now);
    return db.$transaction(async tx=>{
      const changed=await tx.csTask.updateMany({where:{id:taskId,status:"CLAIMED"},data:{status:outcome==="DONE"?"SENT_VERIFIED":outcome,completedAt:outcome==="DONE"?now:null,resultJson:JSON.stringify(opts.result||{}),error:opts.error??null}});
      if(changed.count!==1)throw Error("Completion already recorded; no duplicate action");
      const m=await tx.buyerMessage.findUnique({where:{id:task.buyerMessageId}});
      if(m){
        if(outcome==="DONE"){
          const sentAt=new Date((opts.result!.sentVerification as {observedAt:string}).observedAt);
          await tx.buyerMessage.update({where:{id:m.id},data:{status:"SENT",responseSentAt:sentAt,responseSentVia:"VPS_SCREEN_VERIFIED",caseStage:"SENT_VERIFIED"}});
          await tx.buyerMessage.upsert({where:{id:`cs-sent:${taskId}`},update:{},create:{id:`cs-sent:${taskId}`,channel:m.channel,source:"vps_screen_verified",storeIndex:m.storeIndex,storeName:m.storeName,storeEmail:m.storeEmail,customerName:m.customerName,amazonOrderId:m.amazonOrderId,direction:"outgoing",customerMessage:JSON.parse(task.payloadJson).body,status:"SENT",responseSentAt:sentAt,responseSentVia:"VPS_SCREEN_VERIFIED"}});
          if(task.cardId)await tx.csCard.update({where:{id:task.cardId},data:{status:"SENT"}});
        } else await tx.buyerMessage.update({where:{id:m.id},data:{caseStage:"SEND_BLOCKED"}});
      }
      return {ok:true,stage:outcome==="DONE"?"sent_verified":"blocked"};
    });
  }
  await db.csTask.update({where:{id:taskId},data:{status:outcome,completedAt:now,resultJson:JSON.stringify(opts.result||{}),error:opts.error??null}});
  const m=await db.buyerMessage.findUnique({where:{id:task.buyerMessageId}});
  if(!m)return {ok:true};

  // LOOKUP: store what the agent found, then run the case again.
  let snap: Record<string, unknown> = {};
  try {
    snap = m.caseDataJson ? JSON.parse(m.caseDataJson) : {};
  } catch {
    snap = {};
  }
  snap.vpsLookup = { status: outcome, result: opts.result || {}, at: now.toISOString() };
  await db.buyerMessage.update({ where: { id: m.id }, data: { caseDataJson: JSON.stringify(snap) } });
  // The caller re-runs processCase(m.id) in the background (after()).
  return { ok: true, reprocessMessageId: m.id };
}
