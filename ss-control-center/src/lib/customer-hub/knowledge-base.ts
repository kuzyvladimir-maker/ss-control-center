/**
 * Customer Hub Knowledge Base
 *
 * Stores resolved support cases so the Decision Engine can look up
 * similar past situations before generating a new response. Primary
 * seed entries cover the T21 shipping-mismatch pattern that audit
 * flagged — we don't want Claude/OpenAI inventing "we couldn't buy
 * Next Day" responses.
 */

import { prisma } from "@/lib/prisma";
import { predictProblemTypes, rankKnowledgeBase } from "./kb-retrieval";
import { REFUND_ACTIONS, refundBasis } from "./refund-rule";

export interface KnowledgeBaseEntryInput {
  problemType: string;
  scenario: string;
  customerSaid: string;
  trackingStatus?: string | null;
  shippingMismatch?: boolean;
  productType?: string | null;
  correctAction: string;
  correctResponse: string;
  reasoning: string;
  whoShouldPay?: string | null;
  outcome?: "positive" | "negative" | "neutral" | null;
  tags?: string | null;
  /** owner_chatgpt = imported from Vladimir's ChatGPT history;
   *  owner_edit = a draft the owner edited before sending. */
  source?: "manual" | "auto_from_resolved_case" | "owner_chatgpt" | "owner_edit";
  channel?: "Amazon" | "Walmart";
}

/**
 * Find similar past cases. Matches by exact problemType (if provided)
 * and/or substring match on the scenario text. Returns most-recent
 * entries first.
 */
export async function findSimilarCases(
  problemType?: string | null,
  scenarioSubstring?: string | null,
  limit = 3
) {
  const filters: Array<Record<string, unknown>> = [];
  if (problemType) filters.push({ problemType });
  if (scenarioSubstring) {
    const snippet = scenarioSubstring.slice(0, 100);
    filters.push({ scenario: { contains: snippet } });
  }
  if (filters.length === 0) return [];

  return prisma.knowledgeBaseEntry.findMany({
    where: { OR: filters },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * KB lookup used by the analyzer (2026-10-19). Predicts likely T-types from
 * the buyer text, loads every row of those types (plus T21 on a shipping
 * mismatch), and ranks them in memory — see kb-retrieval.ts. When nothing is
 * predicted we rank the whole channel's KB by text overlap alone; it is a few
 * hundred rows at most.
 */
export async function findRelevantCases(
  input: {
    customerMessage: string | null | undefined;
    productType?: string | null;
    channel?: string | null;
    shippingMismatch?: boolean;
  },
  limit = 4
) {
  const predicted = predictProblemTypes(input.customerMessage, {
    shippingMismatch: input.shippingMismatch,
  });
  const types = predicted.map((p) => p.problemType);
  const rows = await prisma.knowledgeBaseEntry.findMany({
    where: types.length > 0 ? { problemType: { in: types } } : {},
    take: 500,
  });
  // Owner REFUND RULE (2026-10-27): older examples that refunded without an
  // our-fault basis (dislike, "too long", "half my money back") are kept in
  // the table but never shown to the model again.
  const usable = rows.filter(
    (r) => !REFUND_ACTIONS.has(r.correctAction) || refundBasis({ customerMessage: r.customerSaid }).allowed
  );
  const ranked = rankKnowledgeBase(
    usable,
    {
      customerMessage: input.customerMessage,
      productType: input.productType,
      channel: input.channel,
      predicted,
    },
    limit
  );
  return {
    predicted,
    cases: ranked.map((r) => r.row),
    topScore: ranked[0]?.score ?? 0,
  };
}

/** Setting key holding the owner's tone guide, distilled from his history. */
export const VOICE_GUIDE_KEY = "customer_hub_voice_guide";

export async function loadVoiceGuide(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: VOICE_GUIDE_KEY } });
  return row?.value?.trim() || null;
}

export async function saveToKnowledgeBase(data: KnowledgeBaseEntryInput) {
  return prisma.knowledgeBaseEntry.create({
    data: {
      problemType: data.problemType,
      scenario: data.scenario,
      customerSaid: data.customerSaid,
      trackingStatus: data.trackingStatus || null,
      shippingMismatch: data.shippingMismatch ?? false,
      productType: data.productType || null,
      correctAction: data.correctAction,
      correctResponse: data.correctResponse,
      reasoning: data.reasoning,
      whoShouldPay: data.whoShouldPay || null,
      outcome: data.outcome || null,
      tags: data.tags || null,
      source: data.source || "manual",
      channel: data.channel || "Amazon",
    },
  });
}

/**
 * The comprehensive 40-case seed lives in seed-knowledge-base.ts and is
 * re-exported here to keep existing callers (sync route, tests) working.
 * See seed-knowledge-base.ts for the entries and the force-reseed option.
 */
export { seedKnowledgeBase } from "./seed-knowledge-base";
