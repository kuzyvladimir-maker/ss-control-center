/**
 * Drive the Buy Box report state machine across cron runs.
 *
 * One call advances the latest request by exactly one step (rate-bucket on
 * /reports is tiny, so we never burst):
 *
 *   no active request, or last finished > REFRESH_AFTER_MS ago  → request new
 *   REQUESTED / INPROGRESS                                       → poll status
 *     READY      → download + parse + persist → DOWNLOADED
 *     in-flight  → bump statusCheckedAt
 *     ERROR      → mark ERROR (next run requests fresh)
 *
 * Rate-limit (429) is caught and reported as a soft "retry next run", never a
 * hard failure — the cron runs often enough to recover.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";
import {
  requestReport,
  getReportStatus,
  getReportDownloadUrl,
  fetchReportText,
  ReportRateLimitedError,
} from "./reports-insights";
import { persistBuyBoxReport } from "./persist-buybox";

/** Re-request a fresh Buy Box report once the last one is ~a day old. */
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
const IN_FLIGHT = new Set(["REQUESTED", "INPROGRESS", "RECEIVED", "SUBMITTED"]);

export interface DriveResult {
  reportType: "BUYBOX";
  action: "requested" | "polled" | "downloaded" | "errored" | "rateLimited" | "idle";
  status?: string;
  requestId?: string;
  rowsParsed?: number;
  upserted?: number;
  losing?: number;
  message?: string;
}

export async function driveBuyBoxReport(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number
): Promise<DriveResult> {
  const latest = await prisma.walmartReport.findFirst({
    where: { storeIndex, reportType: "BUYBOX" },
    orderBy: { requestedAt: "desc" },
  });

  const now = Date.now();
  const isFinished = latest && (latest.status === "DOWNLOADED" || latest.status === "ERROR");
  const stale = latest && isFinished && now - latest.requestedAt.getTime() > REFRESH_AFTER_MS;

  // ── Need a fresh request? ──
  if (!latest || stale) {
    try {
      const requestId = await requestReport(client, "BUYBOX");
      await prisma.walmartReport.create({
        data: { storeIndex, reportType: "BUYBOX", requestId, status: "REQUESTED" },
      });
      return { reportType: "BUYBOX", action: "requested", requestId, status: "REQUESTED" };
    } catch (err) {
      if (err instanceof ReportRateLimitedError) {
        return { reportType: "BUYBOX", action: "rateLimited", message: "request deferred" };
      }
      throw err;
    }
  }

  // ── An in-flight request exists → poll it ──
  if (latest && IN_FLIGHT.has(latest.status)) {
    let st;
    try {
      st = await getReportStatus(client, latest.requestId);
    } catch (err) {
      if (err instanceof ReportRateLimitedError) {
        return { reportType: "BUYBOX", action: "rateLimited", requestId: latest.requestId };
      }
      throw err;
    }

    if (st.status === "READY") {
      try {
        const url = await getReportDownloadUrl(client, latest.requestId);
        const text = await fetchReportText(url);
        const result = await persistBuyBoxReport(prisma, storeIndex, text);
        await prisma.walmartReport.update({
          where: { id: latest.id },
          data: {
            status: "DOWNLOADED",
            readyAt: new Date(),
            downloadedAt: new Date(),
            statusCheckedAt: new Date(),
            rowCount: result.upserted,
            error: null,
          },
        });
        return {
          reportType: "BUYBOX",
          action: "downloaded",
          status: "DOWNLOADED",
          requestId: latest.requestId,
          rowsParsed: result.rowsParsed,
          upserted: result.upserted,
          losing: result.losing,
        };
      } catch (err) {
        if (err instanceof ReportRateLimitedError) {
          return { reportType: "BUYBOX", action: "rateLimited", requestId: latest.requestId };
        }
        await prisma.walmartReport.update({
          where: { id: latest.id },
          data: { status: "ERROR", error: (err as Error).message.slice(0, 500), statusCheckedAt: new Date() },
        });
        return { reportType: "BUYBOX", action: "errored", message: (err as Error).message };
      }
    }

    if (st.status === "ERROR") {
      await prisma.walmartReport.update({
        where: { id: latest.id },
        data: { status: "ERROR", statusCheckedAt: new Date(), error: "Walmart report status ERROR" },
      });
      return { reportType: "BUYBOX", action: "errored", status: "ERROR", requestId: latest.requestId };
    }

    // still generating
    await prisma.walmartReport.update({
      where: { id: latest.id },
      data: { status: "INPROGRESS", statusCheckedAt: new Date() },
    });
    return { reportType: "BUYBOX", action: "polled", status: st.status, requestId: latest.requestId };
  }

  // Latest is DOWNLOADED and fresh — nothing to do.
  return { reportType: "BUYBOX", action: "idle", status: latest?.status, requestId: latest?.requestId };
}
