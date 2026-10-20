/**
 * Customer Hub case pipeline (owner design, 2026-10-20 — topic 42):
 *
 *   collect minimum data (case-data.ts, source chains)
 *     → missing & Seller Central can help → LOOKUP task for the account VPS
 *     → still missing after that          → card to the owner with a Russian
 *                                            "searched / where / missing" note
 *     → complete                          → analysis with verified facts and
 *                                            owner corrections → card
 *   card (Telegram topic 42, published by Jackie)
 *     approve → SEND task for the account VPS (Seller Central Buyer-Seller
 *               Messaging) → agent reports DONE / FAILED / UNKNOWN
 *     wrong / rework + owner comment → CsOwnerRule (append-only) → new card
 *
 * Nothing here talks to a buyer. Sending happens only on the VPS, only for an
 * owner-approved card (or an autopilot-approved one once the owner turns the
 * autopilot on). docs/wiki/customer-hub-vps-send.md
 */
import { prisma } from "@/lib/prisma";
import { analyzeMessage, type AnalysisInput } from "./message-analyzer";
import { translateText } from "./translator";
import { collectCaseData, type ThreadEntry } from "./case-data";
import {
  MINIMUM,
  exhaustedNoteRu,
  factsForPrompt,
  missingKeys,
  nextStep,
  type CaseDataSnapshot,
} from "./case-data-gate";
import { runAutosend } from "./autosend-runner";
export { enqueueSendTask } from "./cs-tasks";

type Msg = NonNullable<Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>>;

function parseSnapshot(json: string | null): CaseDataSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CaseDataSnapshot;
  } catch {
    return null;
  }
}

function analysisInput(m: Msg, history: ThreadEntry[], caseFacts: string, extra?: string): AnalysisInput {
  let events: AnalysisInput["trackingEvents"] = [];
  try {
    events = m.trackingEvents ? JSON.parse(m.trackingEvents) : [];
  } catch {
    events = [];
  }
  return {
    customerMessage: m.customerMessage || "",
    customerName: m.customerName,
    language: m.language,
    storeName: m.storeName,
    channel: m.channel === "Walmart" ? "Walmart" : "Amazon",
    amazonOrderId: m.amazonOrderId,
    orderDate: m.orderDate,
    orderTotal: m.orderTotal,
    product: m.product,
    productType: m.productType,
    carrier: m.carrier,
    service: m.service,
    trackingNumber: m.trackingNumber,
    trackingStatus: m.trackingStatus,
    shipDate: m.shipDate,
    promisedEdd: m.promisedEdd,
    actualDelivery: m.actualDelivery,
    daysInTransit: m.daysInTransit,
    daysLate: m.daysLate,
    requestedShippingService: m.requestedShippingService,
    actualShippingService: m.actualShippingService,
    shippingMismatch: m.shippingMismatch,
    carrierEstimatedDelivery: m.carrierEstimatedDelivery,
    trackingEvents: events,
    boughtThroughVeeqo: m.boughtThroughVeeqo,
    claimsProtected: m.claimsProtected,
    shippedOnTime: m.shippedOnTime,
    messageNumber: history.filter((h) => h.who !== "us").length + 1,
    conversationHistory: history.map((h) => ({
      date: h.at.slice(0, 10),
      direction: h.who === "us" ? "outgoing" : "incoming",
      text: h.text,
      action: null,
    })),
    hasAtozClaim: false,
    hasNegativeFeedback: false,
    caseFacts,
    extraInstruction: extra,
  } as AnalysisInput;
}

// ── Tasks ─────────────────────────────────────────────────────────────

async function enqueueLookupTask(m: Msg, snap: CaseDataSnapshot) {
  const need = missingKeys(snap);
  const idempotencyKey = `lookup:${m.id}:${need.join(",")}`;
  const existing = await prisma.csTask.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  return prisma.csTask.create({
    data: {
      kind: "LOOKUP",
      storeIndex: m.storeIndex,
      amazonOrderId: m.amazonOrderId,
      buyerMessageId: m.id,
      payloadJson: JSON.stringify({
        need,
        needRu: need.map((k) => `${k}: ${MINIMUM[k].labelRu}`),
        instructionsRu:
          "ТОЛЬКО ЧТЕНИЕ. Seller Central на VPS этого аккаунта → заказ по номеру. Найти перечисленные данные (страница заказа: статус, состав, сумма, Ship by / Deliver by, трекинг; Buyer-Seller Messaging: вся переписка; возвраты/претензии). Ничего не нажимать, кроме навигации. Вернуть result как {\"M6\": \"текст найденного\", …} по ключам.",
      }),
      idempotencyKey,
    },
  });
}

// ── Cards ─────────────────────────────────────────────────────────────

function deadlineRu(m: Msg): string {
  const received = m.receivedAt || m.createdAt;
  const due = new Date(received.getTime() + 24 * 3600_000);
  const left = Math.round((due.getTime() - Date.now()) / 3600_000);
  const fmt = due.toLocaleString("ru-RU", { timeZone: "America/New_York", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return left > 0 ? `ответить до ${fmt} ET (осталось ~${left} ч)` : `срок ответа прошёл ${fmt} ET`;
}

export function renderCardTextRu(c: CardPayload): string {
  const parts = [
    `🟦 Customer Service · ${c.store} · заказ ${c.orderId || "—"} · v${c.version}`,
    `⏱ ${c.deadlineRu}`,
    "",
    `Клиент: ${c.clientRu}`,
  ];
  if (c.historyRu) parts.push("", `История:\n${c.historyRu}`);
  parts.push("", `Данные:\n${c.dataRu.map((d) => `• ${d}`).join("\n")}`);
  if (c.missingRu) parts.push("", `⚠️ Не нашли, нужно ваше решение:\n${c.missingRu}`);
  parts.push("", `Решение движка:\n${c.decisionRu}`);
  parts.push("", `Текст покупателю (уйдёт по-английски):\n${c.draftEn}`);
  if (c.attachments.length) parts.push("", `Вложения: ${c.attachments.join(", ")}`);
  return parts.join("\n");
}

export interface CardPayload {
  cardId: string;
  version: number;
  buyerMessageId: string;
  store: string;
  storeIndex: number;
  orderId: string | null;
  deadlineRu: string;
  clientRu: string;
  clientOriginal: string;
  historyRu: string | null;
  dataRu: string[];
  missingRu: string | null;
  decisionRu: string;
  draftEn: string;
  attachments: string[];
  buttons: Array<{ action: "approve" | "wrong" | "rework"; label: string; callbackData: string }>;
  textRu: string;
}

async function createCard(
  m: Msg,
  snap: CaseDataSnapshot,
  a: { clientGistRu?: string | null; historyRu?: string | null; ownerBriefRu?: string | null } | null,
  missingRu: string | null
) {
  const prev = await prisma.csCard.findMany({
    where: { buyerMessageId: m.id },
    orderBy: { version: "desc" },
    take: 1,
  });
  const version = (prev[0]?.version ?? 0) + 1;
  await prisma.csCard.updateMany({
    where: { buyerMessageId: m.id, status: { in: ["PENDING", "PUBLISHED", "WRONG", "REWORK"] } },
    data: { status: "SUPERSEDED" },
  });
  const original = (m.customerMessage || "").replace(/\s*View Message\s*$/i, "").trim();
  const clientRu =
    a?.clientGistRu ||
    m.customerMessageRu ||
    (await translateText(original.slice(0, 1500), "en-ru").catch(() => null)) ||
    original.slice(0, 300);
  const card = await prisma.csCard.create({
    data: { buyerMessageId: m.id, version, cardJson: "{}" },
  });
  const payload: CardPayload = {
    cardId: card.id,
    version,
    buyerMessageId: m.id,
    store: m.storeName,
    storeIndex: m.storeIndex,
    orderId: m.amazonOrderId,
    deadlineRu: deadlineRu(m),
    clientRu,
    clientOriginal: original,
    historyRu: a?.historyRu || null,
    dataRu: snap.items.filter((i) => i.present && i.factRu).map((i) => i.factRu),
    missingRu,
    decisionRu: a?.ownerBriefRu || (missingRu ? "Решения нет: не хватает данных (см. выше)." : "—"),
    draftEn: (m.editedResponse || m.suggestedResponse || "").trim(),
    attachments: [],
    buttons: [
      { action: "approve", label: "Утвердить и отправить", callbackData: `cs:${card.id}:approve` },
      { action: "wrong", label: "Не так", callbackData: `cs:${card.id}:wrong` },
      { action: "rework", label: "Доработать", callbackData: `cs:${card.id}:rework` },
    ],
    textRu: "",
  };
  payload.textRu = renderCardTextRu(payload);
  await prisma.csCard.update({ where: { id: card.id }, data: { cardJson: JSON.stringify(payload) } });
  await prisma.buyerMessage.update({ where: { id: m.id }, data: { caseStage: "CARD_PENDING" } });
  return card.id;
}

// ── Main entry ────────────────────────────────────────────────────────

export interface ProcessResult {
  stage: string;
  cardId?: string;
  lookupTaskId?: string;
  missing?: string[];
}

export async function processCase(
  messageId: string,
  opts: { ownerInstruction?: string } = {}
): Promise<ProcessResult> {
  let m = await prisma.buyerMessage.findUnique({ where: { id: messageId } });
  if (!m || m.direction !== "incoming") return { stage: "SKIPPED" };
  if (m.responseSentAt) return { stage: "SENT" };

  const prevSnap = parseSnapshot(m.caseDataJson);
  const { snapshot, thread, patch } = await collectCaseData(m, prevSnap);
  m = await prisma.buyerMessage.update({
    where: { id: m.id },
    data: { ...patch, caseDataJson: JSON.stringify(snapshot), caseStage: "COLLECTING" },
  });

  const step = nextStep(snapshot);
  if (step === "VPS_LOOKUP") {
    const task = await enqueueLookupTask(m, snapshot);
    snapshot.vpsLookup = { status: task.status, at: new Date().toISOString() };
    await prisma.buyerMessage.update({
      where: { id: m.id },
      data: { caseDataJson: JSON.stringify(snapshot), caseStage: "WAITING_VPS_LOOKUP" },
    });
    return { stage: "WAITING_VPS_LOOKUP", lookupTaskId: task.id, missing: missingKeys(snapshot) };
  }

  const missingRu = step === "OWNER" ? exhaustedNoteRu(snapshot) : null;
  const a = await analyzeMessage(
    analysisInput(
      m,
      thread,
      factsForPrompt(snapshot),
      [
        missingRu
          ? "Some minimum case data could not be found (see CASE DATA). Do not make a final money decision; draft a safe reply and say in ownerBriefRu what is missing."
          : null,
        opts.ownerInstruction ? `OWNER'S CORRECTION FOR THIS CASE (follow it): ${opts.ownerInstruction}` : null,
      ]
        .filter(Boolean)
        .join("\n") || undefined
    )
  );
  const suggestedRu = a.suggestedResponse
    ? await translateText(a.suggestedResponse, "en-ru").catch(() => null)
    : null;
  m = await prisma.buyerMessage.update({
    where: { id: m.id },
    data: {
      problemType: a.problemType,
      problemTypeName: a.problemTypeName,
      riskLevel: a.riskLevel,
      action: a.action,
      secondaryAction: a.secondaryAction,
      whoShouldPay: a.whoShouldPay,
      internalAction: a.internalAction,
      foodSafetyRisk: a.foodSafetyRisk,
      atozRisk: a.atozRisk,
      suggestedResponse: a.suggestedResponse,
      suggestedResponseRu: suggestedRu,
      // A fresh draft replaces an older manual edit only when the owner
      // asked for a rework.
      editedResponse: opts.ownerInstruction ? null : undefined,
      supplierReorderNote: a.supplierReorderNote,
      reasoning: a.reasoning,
      ownerBrief: a.ownerBriefRu ?? null,
      category: a.problemType,
      categoryName: a.problemTypeName,
      priority: a.riskLevel,
      status: "ANALYZED",
      factCheckJson: JSON.stringify(a.factCheck),
    },
  });

  try {
    await runAutosend(m.id, { kbTopScore: a.kbTopScore, isFallback: a.isFallback, neverSend: Boolean(missingRu) });
  } catch (e) {
    console.warn("[cs-pipeline] autosend verdict failed:", e);
  }

  const cardId = await createCard(m, snapshot, a, missingRu);
  return { stage: step === "OWNER" ? "NEEDS_OWNER_DATA" : "CARD_PENDING", cardId, missing: missingKeys(snapshot) };
}
