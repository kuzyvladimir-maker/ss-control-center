/**
 * Amazon Growth — change log (audit trail), wired into the core write paths.
 *
 * Every write we make to an Amazon listing — from the optimizer, the advisor,
 * or the bulk worker — calls logChange(), which records one row: what listing,
 * what field, the before→after VALUES (for rollback), the exact patch, who did
 * it, when, and the BEFORE metrics (health, conversion, opportunity, errors). A
 * later sweep calls measureChanges() to fill the AFTER metrics and classify the
 * outcome (useful / neutral / harmful). This is the before/after ledger.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { OptimizerPlan, ApplyResult } from "./optimizer";

export type ChangeSource = "optimizer" | "advisor" | "bulk" | "manual";

export interface ChangeEntry {
  storeIndex: number;
  sku: string;
  source: ChangeSource;
  changeType: string;
  field?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  patch?: unknown;
  submissionId?: string | null;
  amazonStatus?: string | null;
}

const j = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/** Record one applied change, capturing the listing's BEFORE metrics. */
export async function logChange(prisma: PrismaClient, e: ChangeEntry): Promise<void> {
  const item = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex: e.storeIndex, sku: e.sku } },
  });
  await prisma.amazonChangeLog.create({
    data: {
      storeIndex: e.storeIndex,
      sku: e.sku,
      asin: item?.asin ?? null,
      itemName: item?.itemName ?? null,
      source: e.source,
      changeType: e.changeType,
      field: e.field ?? null,
      beforeValue: j(e.beforeValue),
      afterValue: j(e.afterValue),
      patch: j(e.patch),
      submissionId: e.submissionId ?? null,
      amazonStatus: e.amazonStatus ?? null,
      beforeHealthScore: item?.healthScore ?? null,
      beforeConversion: item?.unitSessionPct ?? null,
      beforeOpportunity: item?.opportunityScore ?? null,
      beforeErrorCount: item?.errorIssueCount ?? null,
    },
  });
}

/** Log every change from an applied optimizer plan (dedupe + title-scrub). */
export async function logOptimizerChanges(
  prisma: PrismaClient,
  storeIndex: number,
  sku: string,
  plan: OptimizerPlan,
  result: ApplyResult,
  source: ChangeSource,
): Promise<void> {
  for (const c of plan.changes) {
    await logChange(prisma, {
      storeIndex,
      sku,
      source,
      changeType: c.kind,
      field: c.field,
      beforeValue: c.before,
      afterValue: c.after,
      patch: plan.patches,
      submissionId: result.submissionId,
      amazonStatus: result.status,
    });
  }
}

/**
 * Fill AFTER metrics for change-log rows whose write predates this sweep, and
 * classify the outcome. Health/errors move next sweep; conversion is the slower
 * signal (updates when the next Sales & Traffic report lands).
 */
export async function measureChanges(
  prisma: PrismaClient,
  storeIndex: number,
  sweepStartedAt: Date,
): Promise<void> {
  const pending = await prisma.amazonChangeLog.findMany({
    where: { storeIndex, afterMeasuredAt: null, createdAt: { lt: sweepStartedAt } },
  });
  for (const row of pending) {
    const item = await prisma.amazonListingHealthItem.findUnique({
      where: { amazon_health_item_dedup: { storeIndex, sku: row.sku } },
    });
    if (!item) continue;
    const healthDelta = item.healthScore != null && row.beforeHealthScore != null ? item.healthScore - row.beforeHealthScore : 0;
    const errorDelta = item.errorIssueCount != null && row.beforeErrorCount != null ? item.errorIssueCount - row.beforeErrorCount : 0;
    let outcome: "useful" | "neutral" | "harmful";
    if (healthDelta < -2 || errorDelta > 0) outcome = "harmful";
    else if (healthDelta > 2 || errorDelta < 0) outcome = "useful";
    else outcome = "neutral";
    await prisma.amazonChangeLog.update({
      where: { id: row.id },
      data: {
        afterMeasuredAt: new Date(),
        afterHealthScore: item.healthScore,
        afterConversion: item.unitSessionPct,
        afterErrorCount: item.errorIssueCount,
        outcome,
      },
    });
  }
}
