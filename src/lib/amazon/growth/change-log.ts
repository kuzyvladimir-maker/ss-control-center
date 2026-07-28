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
import { measureLift } from "./diff-in-diff";

const DAY_MS = 864e5;

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
/**
 * Control-adjusted lift (diff-in-diff) for changes whose measurement window has
 * fully elapsed. This is the HONEST outcome — it subtracts how unchanged peers
 * moved over the same window, so a market swing isn't credited to our change.
 * Runs only once the post-window has passed; needs daily history coverage.
 */
export async function measureChangesDiD(
  prisma: PrismaClient,
  storeIndex: number,
  opts: { burnInDays?: number; postDays?: number } = {},
): Promise<{ measured: number; confident: number }> {
  const burnIn = opts.burnInDays ?? 3;
  const postDays = opts.postDays ?? 14;
  // Only changes old enough that the full post-window has elapsed.
  const cutoff = new Date(Date.now() - (burnIn + postDays + 1) * DAY_MS);
  const pending = await prisma.amazonChangeLog.findMany({
    where: { storeIndex, didMeasuredAt: null, rolledBack: false, asin: { not: null }, createdAt: { lt: cutoff } },
    take: 200,
  });

  let measured = 0;
  let confident = 0;
  for (const row of pending) {
    if (!row.asin) continue;
    try {
      const lift = await measureLift(prisma, storeIndex, row.asin, row.createdAt, { burnInDays: burnIn, postDays });
      const data: Record<string, unknown> = {
        didMeasuredAt: new Date(),
        didConfidence: lift.confidence,
        didLiftConvPp: lift.liftConversionPp,
        didLiftRevPerDay: lift.liftRevenuePerDay,
        didControlN: lift.controlN,
      };
      // Refine outcome from the control-adjusted lift when we trust it.
      if (lift.confidence !== "insufficient" && lift.confidence !== "low") {
        const conv = lift.liftConversionPp ?? 0;
        const rev = lift.liftRevenuePerDay ?? 0;
        data.outcome = conv > 0.5 || rev > 0.5 ? "useful" : conv < -0.5 || rev < -0.5 ? "harmful" : "neutral";
        confident++;
      }
      await prisma.amazonChangeLog.update({ where: { id: row.id }, data });
      measured++;
    } catch {
      /* leave for the next sweep */
    }
  }
  return { measured, confident };
}

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
