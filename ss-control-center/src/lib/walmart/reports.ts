/**
 * Walmart Reports API — Reconciliation reports.
 *
 * Endpoints:
 *   GET /v3/report/reconreport/availableReconFiles
 *   GET /v3/report/reconreport/reconFile?reportDate=YYYY-MM-DD&pageNo=1&limit=1000
 *
 * Recon reports contain Sales + Refunds + Adjustments + Fees rows and are
 * the authoritative source of money movement for a given settlement date.
 * Column `transaction_posted_timestamp` is the chronological key.
 */

import type { WalmartClient } from "./client";
import { mapReconTx } from "./mappers";
import type { WalmartReconReportMeta, WalmartReconTransaction } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_LIMIT = 2000;

export interface ReconReportPage {
  meta: WalmartReconReportMeta;
  transactions: WalmartReconTransaction[];
}

export class WalmartReportsApi {
  constructor(private client: WalmartClient) {}

  /** Dates for which recon reports are available (latest first). */
  async getAvailableReconReportDates(): Promise<string[]> {
    const data = await this.client.request<any>(
      "GET",
      "/report/reconreport/availableReconFiles"
    );
    // Response is { availableReconFiles: [{ reportDate: "YYYY-MM-DD" }, ...] }
    const files: any[] = data?.availableReconFiles ?? data ?? [];
    const dates = files
      .map((f) => f?.reportDate ?? f?.date)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    dates.sort().reverse();
    return dates;
  }

  /** Fetch one page of the recon report for a given date. */
  async getReconReport(params: {
    reportDate: string;
    pageNo?: number;
    limit?: number;
  }): Promise<ReconReportPage> {
    const limit = Math.min(params.limit ?? 1000, MAX_LIMIT);
    const data = await this.client.request<any>(
      "GET",
      "/report/reconreport/reconFile",
      {
        params: {
          reportDate: params.reportDate,
          pageNo: params.pageNo ?? 1,
          limit,
        },
      }
    );
    const metaRaw = data?.meta ?? {};
    const meta: WalmartReconReportMeta = {
      fileSize: Number(metaRaw.fileSize ?? 0),
      totalRows: Number(metaRaw.totalRows ?? 0),
      totalPages: Number(metaRaw.totalPages ?? 1),
      rowsOnThisPage: Number(metaRaw.rowsOnThisPage ?? 0),
      pageNo: Number(metaRaw.pageNo ?? params.pageNo ?? 1),
    };
    const rows: any[] = data?.transactions ?? data?.rows ?? [];
    return { meta, transactions: rows.map(mapReconTx) };
  }

  /** Fetch every page for a date and return all transactions. */
  async getFullReconReport(reportDate: string): Promise<WalmartReconTransaction[]> {
    const first = await this.getReconReport({ reportDate, pageNo: 1, limit: MAX_LIMIT });
    const all = [...first.transactions];
    for (let p = 2; p <= first.meta.totalPages; p++) {
      const page = await this.getReconReport({
        reportDate,
        pageNo: p,
        limit: MAX_LIMIT,
      });
      all.push(...page.transactions);
    }
    return all;
  }
}
