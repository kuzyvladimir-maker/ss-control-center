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

/** Walmart returns recon dates as MMDDYYYY (US format). Convert to YYYY-MM-DD. */
function mmddyyyyToISO(s: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/** Reverse: ISO `YYYY-MM-DD` back to Walmart's MMDDYYYY for reconFile calls. */
function isoToMMDDYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}${m[3]}${m[1]}`;
}

export interface ReconReportPage {
  meta: WalmartReconReportMeta;
  transactions: WalmartReconTransaction[];
}

export class WalmartReportsApi {
  constructor(private client: WalmartClient) {}

  /**
   * Dates for which recon reports are available, returned newest-first as
   * ISO `YYYY-MM-DD` strings.
   *
   * Walmart returns `{ availableApReportDates: ["MMDDYYYY", ...] }` — the
   * raw format is the same one the reconFile endpoint expects, so we keep
   * the original strings around for the fetch call (see `availableRaw`).
   */
  async getAvailableReconReportDates(): Promise<string[]> {
    const raw = await this.getAvailableReconReportDatesRaw();
    return raw
      .map((d) => mmddyyyyToISO(d))
      .filter((d): d is string => !!d)
      .sort()
      .reverse();
  }

  /** Raw `MMDDYYYY` strings as returned by Walmart — pass through to reconFile. */
  async getAvailableReconReportDatesRaw(): Promise<string[]> {
    const data = await this.client.request<any>(
      "GET",
      "/report/reconreport/availableReconFiles"
    );
    const dates: unknown =
      data?.availableApReportDates ??
      data?.availableReconFiles ??
      data;
    if (!Array.isArray(dates)) return [];
    return dates
      .map((f) =>
        typeof f === "string"
          ? f
          : f?.reportDate ?? f?.date ?? null
      )
      .filter((d): d is string => typeof d === "string" && d.length > 0);
  }

  /**
   * Fetch one page of the recon report for a given date. Accepts either
   * `YYYY-MM-DD` (preferred) or Walmart's native `MMDDYYYY`.
   */
  async getReconReport(params: {
    reportDate: string;
    pageNo?: number;
    limit?: number;
  }): Promise<ReconReportPage> {
    const limit = Math.min(params.limit ?? 1000, MAX_LIMIT);
    // Normalize to MMDDYYYY for the API call
    const apiDate = /^\d{4}-\d{2}-\d{2}$/.test(params.reportDate)
      ? isoToMMDDYYYY(params.reportDate)
      : params.reportDate;
    const data = await this.client.request<any>(
      "GET",
      "/report/reconreport/reconFile",
      {
        params: {
          reportDate: apiDate,
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
