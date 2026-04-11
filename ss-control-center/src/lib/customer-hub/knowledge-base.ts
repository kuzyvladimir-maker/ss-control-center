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
    },
  });
}

/**
 * Seed canonical entries on first run. Idempotent — exits early if the
 * table already has any rows. Called opportunistically by the sync route
 * so the KB is populated the first time the operator syncs Gmail.
 */
export async function seedKnowledgeBase(): Promise<void> {
  const existing = await prisma.knowledgeBaseEntry.count();
  if (existing > 0) return;

  await prisma.knowledgeBaseEntry.create({
    data: {
      problemType: "T21",
      scenario:
        "Customer paid for Next Day shipping but order was shipped via UPS Ground due to carrier unavailability",
      customerSaid:
        "I paid an additional $62 to get it the next day, now it says April 15, I want to cancel",
      trackingStatus: "in_transit",
      shippingMismatch: true,
      productType: "Dry",
      correctAction: "deny_cancel_redirect_return",
      correctResponse:
        "Dear {name},\n\nThank you for your message.\n\nI understand your concern regarding the delivery timing. Your order was processed and shipped promptly using the fastest available shipping option at the time.\n\nAt this stage, the package is already in transit with UPS and is currently scheduled for delivery on {carrier_estimated_delivery}. Unfortunately, once an order has been shipped, we are unable to cancel it.\n\nWe recommend waiting for delivery. If the item is no longer needed upon arrival, you can request a return or refund through your Amazon account.\n\nIf you need any assistance with that process, please feel free to reach out.\n\nBest regards,\n{store}",
      reasoning:
        'Seller shipped with different service than requested. Cannot admit mismatch directly (A-to-Z risk). Cannot cancel shipped order. Customer should wait for delivery then use Amazon return process. Do NOT say "we could not purchase Next Day" — say "fastest available option".',
      whoShouldPay: "us",
      outcome: "neutral",
      tags: "shipping_mismatch,next_day,ground,cancel_request,in_transit",
      source: "manual",
    },
  });

  console.log("[KnowledgeBase] Seeded initial entries");
}
