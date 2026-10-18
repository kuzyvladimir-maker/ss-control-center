/**
 * Single definition of the Customer Hub headline counts, shared by
 * /api/customer-hub/stats (the hub's own cards), /api/dashboard/summary
 * (Dashboard "Cases open" tile + A-to-Z chip) and therefore the sidebar
 * badge. Before 2026-10-18 the three used three different definitions and
 * never agreed (dashboard 3, hub 300+, sidebar 3).
 *
 * "Live channel" = a channel with at least one ACTIVE Store row. While the
 * Walmart store is switched off, its 300+ August messages are history, not
 * a queue.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const ACTIVE_CLAIM_STATUSES = [
  "NEW",
  "EVIDENCE_GATHERED",
  "RESPONSE_READY",
  "SUBMITTED",
];

// Amazon decides an A-to-Z claim within weeks. Claims still parked in an
// in-flight status after 60 days are abandoned workflow state (15 rows from
// 2026-04-12 sat in EVIDENCE_GATHERED), not live claims.
export const CLAIM_LIVE_DAYS = 60;

export async function liveChannels(): Promise<string[]> {
  const rows = await prisma.store.findMany({
    where: { active: true },
    select: { channel: true },
    distinct: ["channel"],
  });
  return rows.map((r) => r.channel);
}

/** Incoming buyer messages still waiting on us (NEW or AI-ANALYZED). */
export function unreadMessagesWhere(channels: string[]): Prisma.BuyerMessageWhereInput {
  return {
    direction: "incoming",
    status: { in: ["NEW", "ANALYZED"] },
    channel: { in: channels },
  };
}

/** In-flight claims of one type opened within CLAIM_LIVE_DAYS. */
export function activeClaimsWhere(
  claimType: "A_TO_Z" | "CHARGEBACK",
  extra: Prisma.AtozzClaimWhereInput = {}
): Prisma.AtozzClaimWhereInput {
  return {
    claimType,
    status: { in: ACTIVE_CLAIM_STATUSES },
    createdAt: { gte: new Date(Date.now() - CLAIM_LIVE_DAYS * 86400000) },
    ...extra,
  };
}
