/**
 * Account Health v2 orchestrator — wraps the async Reports API flow
 * (requestReport → poll → download → parse → write snapshot) and splits
 * the work into two cheap phases so each fits inside a 10-second Vercel
 * Hobby function:
 *
 *   Phase 1 (request)
 *     - For every configured Amazon store, POST a fresh
 *       GET_V2_SELLER_PERFORMANCE_REPORT request.
 *     - Persist reportId in `ReportSyncJob` (status="requested").
 *     - Returns immediately. Each store costs ~one SP-API call.
 *
 *   Phase 2 (poll/download/parse)
 *     - Walk every open job (status in {requested, processing,
 *       downloading}). For each:
 *         - hit /reports/{id} for status; advance to "processing" if not
 *           done yet.
 *         - if DONE: download document, parse via parseSellerPerformance-
 *           Report, write the AccountHealthSnapshot + Policy categories,
 *           run the critical alerts evaluator. Mark job done.
 *         - if FATAL/CANCELLED or older than 30 min: mark error.
 *     - Idempotent; safe to call repeatedly. The UI polls this every 15s
 *       after a Refresh, and a daily cron also runs it.
 */

import { prisma } from "@/lib/prisma";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import {
  requestReport,
  getReportStatus,
  downloadReportDocument,
  parseSellerPerformanceReport,
  type ParsedReport,
} from "@/lib/amazon-sp-api/seller-performance-report";
import { evaluateCriticalAlerts } from "@/lib/account-health/critical-alert-evaluator";

const REPORT_TYPE = "GET_V2_SELLER_PERFORMANCE_REPORT";
// Jobs older than this without completing get marked as failed so the
// UI doesn't poll forever. Amazon usually finishes in <2 min; 30 min is
// a generous ceiling.
const JOB_EXPIRY_MS = 30 * 60 * 1000;

export interface RequestPhaseResult {
  storeIndex: number;
  storeId: string;
  success: boolean;
  reportId?: string;
  error?: string;
}

export interface PollPhaseResult {
  jobId: string;
  storeId: string;
  status: string; // requested | processing | done | error
  snapshotId?: string;
  alertsCreated?: number;
  error?: string;
}

/**
 * Phase 1 — kick off a fresh report for every Amazon store that has
 * SP-API credentials configured. Each call is one POST to /reports.
 */
export async function requestReportsForAllStores(): Promise<RequestPhaseResult[]> {
  const results: RequestPhaseResult[] = [];
  for (let i = 1; i <= 5; i++) {
    if (!getStoreCredentials(i)) continue;
    const storeId = `store${i}`;
    try {
      const reportId = await requestReport(i);
      await prisma.reportSyncJob.create({
        data: {
          storeId,
          reportType: REPORT_TYPE,
          amazonReportId: reportId,
          status: "requested",
        },
      });
      results.push({ storeIndex: i, storeId, success: true, reportId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Persist a failed-from-start job row so the UI can show *why* it
      // didn't even request a report (auth failure, throttle, etc).
      await prisma.reportSyncJob.create({
        data: {
          storeId,
          reportType: REPORT_TYPE,
          status: "error",
          error: msg.slice(0, 500),
          completedAt: new Date(),
        },
      });
      results.push({ storeIndex: i, storeId, success: false, error: msg });
    }
  }
  return results;
}

/**
 * Phase 2 — walk every open job (request/processing/downloading) and
 * push it forward. Returns one entry per job processed. Safe to call
 * concurrently; we don't take a DB lock — at worst two concurrent
 * pollers do the same parse twice and the second one overwrites the
 * snapshot with identical data.
 */
export async function pollOpenJobs(): Promise<PollPhaseResult[]> {
  const open = await prisma.reportSyncJob.findMany({
    where: {
      reportType: REPORT_TYPE,
      status: { in: ["requested", "processing", "downloading"] },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  const out: PollPhaseResult[] = [];
  for (const job of open) {
    out.push(await advanceJob(job));
  }
  return out;
}

async function advanceJob(job: {
  id: string;
  storeId: string;
  amazonReportId: string | null;
  amazonDocumentId: string | null;
  status: string;
  createdAt: Date;
}): Promise<PollPhaseResult> {
  const storeIndex = parseInt(job.storeId.replace("store", ""), 10);

  // Sanity: if a job has lingered for too long without completing, mark
  // it failed so the UI stops polling.
  if (Date.now() - job.createdAt.getTime() > JOB_EXPIRY_MS) {
    await prisma.reportSyncJob.update({
      where: { id: job.id },
      data: {
        status: "error",
        error: "Report did not complete within 30 minutes",
        completedAt: new Date(),
      },
    });
    return {
      jobId: job.id,
      storeId: job.storeId,
      status: "error",
      error: "expired",
    };
  }

  if (!job.amazonReportId) {
    await prisma.reportSyncJob.update({
      where: { id: job.id },
      data: { status: "error", error: "Missing amazonReportId", completedAt: new Date() },
    });
    return { jobId: job.id, storeId: job.storeId, status: "error", error: "no report id" };
  }

  try {
    const s = await getReportStatus(storeIndex, job.amazonReportId);

    if (s.status === "IN_QUEUE" || s.status === "IN_PROGRESS") {
      // Promote to "processing" so the UI knows progress is being made.
      if (job.status !== "processing") {
        await prisma.reportSyncJob.update({
          where: { id: job.id },
          data: { status: "processing" },
        });
      }
      return { jobId: job.id, storeId: job.storeId, status: "processing" };
    }
    if (s.status === "CANCELLED" || s.status === "FATAL") {
      await prisma.reportSyncJob.update({
        where: { id: job.id },
        data: {
          status: "error",
          error: `Report ${s.status}`,
          completedAt: new Date(),
        },
      });
      return {
        jobId: job.id,
        storeId: job.storeId,
        status: "error",
        error: s.status,
      };
    }
    // DONE — download + parse + write.
    if (!s.reportDocumentId) {
      throw new Error("DONE but no reportDocumentId");
    }
    await prisma.reportSyncJob.update({
      where: { id: job.id },
      data: {
        status: "downloading",
        amazonDocumentId: s.reportDocumentId,
      },
    });

    const raw = await downloadReportDocument(storeIndex, s.reportDocumentId);
    const parsed = parseSellerPerformanceReport(raw);

    const result = await persistSnapshot(storeIndex, parsed);

    await prisma.reportSyncJob.update({
      where: { id: job.id },
      data: { status: "done", completedAt: new Date() },
    });

    return {
      jobId: job.id,
      storeId: job.storeId,
      status: "done",
      snapshotId: result.snapshotId,
      alertsCreated: result.alertsCreated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.reportSyncJob.update({
      where: { id: job.id },
      data: { status: "error", error: msg.slice(0, 500), completedAt: new Date() },
    });
    return {
      jobId: job.id,
      storeId: job.storeId,
      status: "error",
      error: msg,
    };
  }
}

async function persistSnapshot(
  storeIndex: number,
  p: ParsedReport
): Promise<{ snapshotId: string; alertsCreated: number }> {
  const storeId = `store${storeIndex}`;

  // Map our deactivation zones to the overall "status" string the legacy
  // UI / dashboard summary uses (healthy | warning | critical).
  const status =
    p.accountHealthRatingStatus === "AT_RISK_OF_DEACTIVATION"
      ? "critical"
      : p.accountHealthRatingStatus === "AT_RISK"
        ? "warning"
        : (p.policyCategories.some((c) => c.status === "CRITICAL") ||
              (p.orderDefectRate ?? 0) >= 1 ||
              (p.lateShipmentRate30d ?? 0) >= 4 ||
              (p.validTrackingRate ?? 100) <= 95 ||
              (p.onTimeDeliveryRate ?? 100) <= 90)
          ? "critical"
          : "healthy";

  const snapshot = await prisma.accountHealthSnapshot.create({
    data: {
      storeId,
      storeName: "Amazon.com",
      status,
      syncStatus: "done",
      syncedAt: new Date(),

      accountHealthRating: p.accountHealthRating ?? null,
      accountHealthRatingStatus: p.accountHealthRatingStatus ?? null,

      orderDefectRate: p.orderDefectRate ?? null,
      odrOrders60d: p.odrOrders60d ?? null,
      negativeFeedbackCount: p.negativeFeedbackCount ?? null,
      negativeFeedbackRate: p.negativeFeedbackRate ?? null,
      atozClaimsCount: p.atozClaimsCount ?? null,
      atozClaimsRate: p.atozClaimsRate ?? null,
      chargebackCount: p.chargebackCount ?? null,
      chargebackRate: p.chargebackRate ?? null,

      odrSellerFulfilled: p.odrSellerFulfilled ?? null,
      odrSellerFulfilledOrders: p.odrSellerFulfilledOrders ?? null,
      odrFulfilledByAmazon: p.odrFulfilledByAmazon ?? null,
      odrFulfilledByAmazonOrders: p.odrFulfilledByAmazonOrders ?? null,

      lateShipmentRate10d: p.lateShipmentRate10d ?? null,
      lsr10dLate: p.lsr10dLate ?? null,
      lsr10dTotal: p.lsr10dTotal ?? null,
      lateShipmentRate30d: p.lateShipmentRate30d ?? null,
      lsr30dLate: p.lsr30dLate ?? null,
      lsr30dTotal: p.lsr30dTotal ?? null,

      preFulfillmentCancelRate: p.preFulfillmentCancelRate ?? null,
      cancelCancelled: p.cancelCancelled ?? null,
      cancelTotal: p.cancelTotal ?? null,

      validTrackingRate: p.validTrackingRate ?? null,
      vtrTracked: p.vtrTracked ?? null,
      vtrTotal: p.vtrTotal ?? null,

      onTimeDeliveryRate: p.onTimeDeliveryRate ?? null,
      otdrOnTime: p.otdrOnTime ?? null,
      otdrTotal: p.otdrTotal ?? null,
    },
  });

  // Replace this snapshot's policy categories. Cascade deletes details.
  await prisma.policyViolationCategory.deleteMany({
    where: { snapshotId: snapshot.id },
  });
  for (const cat of p.policyCategories) {
    await prisma.policyViolationCategory.create({
      data: {
        snapshotId: snapshot.id,
        category: cat.code,
        displayName: cat.displayName,
        count: cat.count,
        status: cat.status,
      },
    });
  }

  // Alert evaluation — same metrics map the legacy sync used.
  let alertsCreated = 0;
  try {
    const store = await prisma.store.findFirst({
      where: { storeIndex, channel: "Amazon" },
      select: { id: true, name: true },
    });
    if (store) {
      const policyDelta: Record<string, number> = {};
      for (const cat of p.policyCategories) {
        policyDelta[`newPolicyViolation_${cat.code}`] = cat.count;
      }
      const created = await evaluateCriticalAlerts({
        storeId: store.id,
        storeName: store.name,
        channel: "Amazon",
        metrics: {
          accountHealthRating: p.accountHealthRating,
          orderDefectRate: p.orderDefectRate,
          lateShipmentRate30d: p.lateShipmentRate30d,
          preFulfillmentCancelRate: p.preFulfillmentCancelRate,
          validTrackingRate: p.validTrackingRate,
          onTimeDeliveryRate: p.onTimeDeliveryRate,
          ...policyDelta,
        },
      });
      alertsCreated = created.length;
    }
  } catch (err) {
    console.error("[report-orchestrator] alert eval failed:", err);
  }

  return { snapshotId: snapshot.id, alertsCreated };
}
