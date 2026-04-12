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
  source?: "manual" | "auto_from_resolved_case";
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
