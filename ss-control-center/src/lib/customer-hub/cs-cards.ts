/**
 * Telegram approval cards for Customer Hub (topic 42). The hub writes cards;
 * Jackie publishes them with inline buttons and relays the owner's press and
 * comment back through cardAction(). Owner corrections are stored append-only
 * in CsOwnerRule and injected into every later analysis.
 */
import { prisma } from "@/lib/prisma";
import { enqueueSendTask } from "./cs-tasks";
import { saveToKnowledgeBase } from "./knowledge-base";

export async function pendingCards(limit = 10) {
  const rows = await prisma.csCard.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map((r) => JSON.parse(r.cardJson));
}

export async function markPublished(cardId: string, telegramMessageId: string) {
  const res = await prisma.csCard.updateMany({
    where: { id: cardId, status: "PENDING" },
    data: { status: "PUBLISHED", telegramMessageId, publishedAt: new Date() },
  });
  if (res.count !== 1) throw new Error(`Card ${cardId} is not PENDING`);
  return { ok: true };
}

export const ASK_COMMENT_RU =
  "Что именно не так и как бы вы ответили? Ответьте на карточку голосом или текстом — я сохраню это как правило и пересоберу ответ.";

export interface CardActionResult {
  ok: boolean;
  /** approve → the queued SEND task. */
  taskId?: string;
  /** wrong/rework without a comment → ask the owner this, then call again with the comment. */
  askOwnerRu?: string;
  /** wrong/rework with a comment → re-run processCase(messageId) in the background. */
  reprocessMessageId?: string;
  ownerInstruction?: string;
}

export async function cardAction(
  cardId: string,
  action: "approve" | "wrong" | "rework",
  comment: string | null,
  actor: string
): Promise<CardActionResult> {
  const card = await prisma.csCard.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Card ${cardId} not found`);
  if (!["PENDING", "PUBLISHED", "WRONG", "REWORK"].includes(card.status))
    throw new Error(`Card ${cardId} is ${card.status} — act on the latest version`);
  const m = await prisma.buyerMessage.findUnique({ where: { id: card.buyerMessageId } });
  if (!m) throw new Error("Buyer message not found");

  if (action === "approve") {
    const task = await enqueueSendTask(m, { approvedBy: `owner via ${actor}`, cardId });
    await prisma.csCard.update({
      where: { id: cardId },
      data: { status: "APPROVED", decision: "approve", decidedAt: new Date(), ownerComment: comment },
    });
    // An approved draft is a confirmed owner example for later cases.
    const reply = (m.editedResponse || m.suggestedResponse || "").trim();
    if (reply && m.customerMessage) {
      await saveToKnowledgeBase({
        problemType: m.problemType || "T18",
        scenario: `Owner-approved reply (${new Date().toISOString().slice(0, 10)}): ${m.ownerBrief?.split("\n")[0]?.slice(0, 200) || m.problemTypeName || ""}`,
        customerSaid: m.customerMessage.slice(0, 2000),
        productType: m.productType,
        correctAction: m.action || "info",
        correctResponse: reply,
        reasoning: "Approved by the owner from the Telegram card without changes.",
        // Not "orderId:" — case-data.ts reads orderId-tagged owner_edit rows as
        // replies already sent on that order.
        tags: `card:${cardId},ord:${m.amazonOrderId}`,
        source: "owner_edit",
        channel: m.channel === "Walmart" ? "Walmart" : "Amazon",
      });
    }
    return { ok: true, taskId: task.id };
  }

  const text = (comment || "").trim();
  await prisma.csCard.update({
    where: { id: cardId },
    data: {
      status: action === "wrong" ? "WRONG" : "REWORK",
      decision: action,
      decidedAt: new Date(),
      ownerComment: text || null,
    },
  });
  if (!text) return { ok: true, askOwnerRu: ASK_COMMENT_RU };

  await prisma.csOwnerRule.create({
    data: {
      text,
      problemType: m.problemType,
      cardId,
      kind: action === "wrong" ? "correction" : "rework",
    },
  });
  return { ok: true, reprocessMessageId: m.id, ownerInstruction: text };
}
