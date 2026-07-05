/**
 * FULL catalog sync via Walmart's async ITEM report.
 *
 * Why: the `/v3/items` endpoint (see iterateWalmartCatalog) under-reports — it
 * returned ~2981 published for an account the Seller Center UI shows 3895 published.
 * The authoritative full catalog (all statuses, matching the UI) comes from the
 * On-Request **ITEM report** (`POST /reports/reportRequests?reportType=ITEM`). It's
 * async (report generates in ~15-45 min) and the /reports rate bucket is TINY, so
 * this runs as a poll-driven state machine across cron ticks — exactly like the Buy
 * Box report (driveBuyBoxReport), which this mirrors.
 *
 * Safety: the mirror is REPLACED (delete-then-insert) only when the parsed report has
 * a sane row count (>= MIN_SANE_ROWS) — a short/garbled report never wipes the mirror
 * that Jackie search + account health + the COGS sweep depend on. A failed step
 * degrades to "stale", never to "empty".
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";
import {
  getReportStatus,
  getReportDownloadUrl,
  fetchReportText,
  parseCsv,
  col,
  ReportRateLimitedError,
} from "./reports-insights";

export const ITEM_CATALOG_REPORT_TYPE = "ITEM_CATALOG"; // WalmartReport.reportType tag
const ITEM_REPORT_VERSION = "4"; // Walmart's Item Report is version 4
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000; // re-request ~daily after a good run
const ERROR_RETRY_AFTER_MS = 60 * 60 * 1000; // a failed report retries after ~1h, not 20h
const INFLIGHT_TIMEOUT_MS = 3 * 60 * 60 * 1000; // a report stuck in-flight >3h is presumed dropped → re-request
const IN_FLIGHT = new Set(["REQUESTED", "INPROGRESS", "RECEIVED", "SUBMITTED"]);
const INSERT_CHUNK = 500;
const TX_TIMEOUT_MS = 120_000;
// Guard: refuse to replace the mirror with fewer than this many rows (protects the
// shared cache from a wrong-columns / truncated report). Our catalog is ~4-5k items.
// Exported so the /v3/items fallback (syncWalmartCatalog) applies the SAME floor.
export const MIN_SANE_ROWS = 2500;

/** Request a fresh ITEM report. Returns the requestId to poll. Separate from the
 *  insights requestReport because the ITEM report uses reportVersion 4 (not v1). */
async function requestItemReport(client: WalmartClient): Promise<string> {
  const res = await client.requestRaw("POST", "/reports/reportRequests", {
    params: { reportType: "ITEM", reportVersion: ITEM_REPORT_VERSION },
    body: {},
    headers: { "Content-Type": "application/json" },
    noRetryOn429: true, // tiny rate bucket — defer to next tick rather than hammer
  } as any);
  if (res.status === 429) throw new ReportRateLimitedError();
  if (!res.ok) throw new Error(`requestItemReport ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  const b = res.body as { requestId?: string; requestID?: string } | undefined;
  const id = b?.requestId ?? b?.requestID;
  if (!id) throw new Error(`requestItemReport: no requestId in ${JSON.stringify(res.body).slice(0, 300)}`);
  return id;
}

export interface ItemCatalogRow {
  sku: string;
  itemId: string | null;
  title: string | null;
  publishedStatus: string | null;
  lifecycleStatus: string | null;
}

/** Parse the report body into records, auto-detecting CSV vs TSV. Walmart on-request
 *  reports are sometimes tab-delimited; a comma-only parser would collapse a TSV into
 *  one column, yield 0 SKUs, and silently strand the catalog on the fallback forever. */
function toRecords(text: string): Record<string, string>[] {
  const firstLine = (text.split(/\r?\n/, 1)[0] || "");
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  if (tabs > commas) {
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 2) return [];
    const headers = lines[0].split("\t").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split("\t");
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => { rec[h] = (cells[i] ?? "").trim(); });
      return rec;
    });
  }
  return parseCsv(text);
}

/** Parse the ITEM report → catalog rows. Column names vary across report versions, so
 *  every field is resolved through a list of aliases; the header row is returned so
 *  the first live run can confirm the mapping. Delimiter (CSV/TSV) is auto-detected. */
export function parseItemReport(text: string): { rows: ItemCatalogRow[]; headers: string[]; total: number } {
  const recs = toRecords(text);
  const headers = recs.length ? Object.keys(recs[0]) : [];
  const rows: ItemCatalogRow[] = [];
  for (const r of recs) {
    const sku = col(r, "SKU", "sku", "Sku", "Seller SKU", "seller sku", "sellerSku", "merchantSku", "SKU ");
    if (!sku || !String(sku).trim()) continue;
    const pub = col(r, "Published Status", "publishedStatus", "Publish Status", "Status", "status", "Publishing Status");
    const life = col(r, "Lifecycle Status", "lifecycleStatus", "Lifecycle", "lifecycle");
    rows.push({
      sku: String(sku).trim(),
      itemId: (col(r, "Item ID", "itemId", "wpid", "WPID", "Wpid", "itemID", "Walmart Item ID") || null) as string | null,
      title: (col(r, "Product Name", "productName", "Item Name", "itemName", "Product Title", "title", "Product Name ") || null) as string | null,
      publishedStatus: pub ? String(pub).toUpperCase().replace(/\s+/g, "_") : null,
      lifecycleStatus: life ? String(life).toUpperCase().replace(/\s+/g, "_") : null,
    });
  }
  return { rows, headers, total: recs.length };
}

/** Replace one store's mirror from parsed rows — same delete-then-insert-in-txn as
 *  syncWalmartCatalog, guarded by MIN_SANE_ROWS. Returns the written count. */
export async function replaceMirrorFromItemReport(
  prisma: PrismaClient,
  storeIndex: number,
  rows: ItemCatalogRow[],
): Promise<{ written: number; replaced: number; publishedCount: number }> {
  const seen = new Set<string>();
  const clean: Array<ItemCatalogRow & { storeIndex: number; syncedAt: Date }> = [];
  const syncedAt = new Date();
  for (const r of rows) {
    if (!r.sku || seen.has(r.sku)) continue;
    seen.add(r.sku);
    clean.push({ ...r, storeIndex, syncedAt });
  }
  if (clean.length < MIN_SANE_ROWS) {
    throw new Error(`ITEM report parsed only ${clean.length} SKU rows (< ${MIN_SANE_ROWS}) — refusing to replace mirror (likely wrong columns/truncated)`);
  }
  // publishedCount from the SAME deduped set that gets written (so it reconciles with `written`).
  const publishedCount = clean.filter((r) => r.publishedStatus === "PUBLISHED").length;
  // Preserve the lazily-warmed image cache (mainImageUrl / mainImageFetchedAt) across
  // the replace — delete-then-insert would otherwise reset it to NULL every sync and
  // the 7-day TTL (retire-listing sku-details + sourcing/identify read it) could never
  // accumulate. Re-attach by SKU.
  const priorImgs = await prisma.walmartCatalogItem.findMany({
    where: { storeIndex },
    select: { sku: true, mainImageUrl: true, mainImageFetchedAt: true },
  });
  const imgBySku = new Map(priorImgs.map((p) => [p.sku, p]));
  const replaced = await prisma.$transaction(
    async (tx) => {
      const prior = await tx.walmartCatalogItem.deleteMany({ where: { storeIndex } });
      for (let i = 0; i < clean.length; i += INSERT_CHUNK) {
        await tx.walmartCatalogItem.createMany({
          data: clean.slice(i, i + INSERT_CHUNK).map((r) => {
            const img = imgBySku.get(r.sku);
            return {
              storeIndex: r.storeIndex,
              sku: r.sku,
              itemId: r.itemId,
              title: r.title,
              lifecycleStatus: r.lifecycleStatus,
              publishedStatus: r.publishedStatus,
              mainImageUrl: img?.mainImageUrl ?? null,
              mainImageFetchedAt: img?.mainImageFetchedAt ?? null,
              syncedAt: r.syncedAt,
            };
          }),
        });
      }
      return prior.count;
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
  );
  return { written: clean.length, replaced, publishedCount };
}

/** True when a fresh ITEM_CATALOG report has replaced the mirror recently — used by
 *  the /v3/items sync to step aside (report is authoritative; they must not fight). */
export async function itemReportIsFresh(prisma: PrismaClient, storeIndex: number, withinMs = 30 * 60 * 60 * 1000): Promise<boolean> {
  const last = await prisma.walmartReport.findFirst({
    where: { storeIndex, reportType: ITEM_CATALOG_REPORT_TYPE, status: "DOWNLOADED" },
    orderBy: { downloadedAt: "desc" },
  });
  return !!(last?.downloadedAt && Date.now() - last.downloadedAt.getTime() < withinMs);
}

export interface ItemReportDriveResult {
  action: "requested" | "polled" | "downloaded" | "errored" | "rateLimited" | "idle";
  status?: string;
  requestId?: string;
  written?: number;
  publishedCount?: number;
  headers?: string[];
  message?: string;
}

/** Advance the ITEM report state machine by one step. Mirrors driveBuyBoxReport. */
export async function driveItemCatalogReport(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number,
): Promise<ItemReportDriveResult> {
  const latest = await prisma.walmartReport.findFirst({
    where: { storeIndex, reportType: ITEM_CATALOG_REPORT_TYPE },
    orderBy: { requestedAt: "desc" },
  });

  const now = Date.now();
  const age = latest ? now - latest.requestedAt.getTime() : Infinity;
  // Self-healing: re-request after a good run (daily), sooner after an ERROR, and if a
  // report has been stuck in-flight too long (Walmart dropped it) so it can't wedge.
  const needFresh =
    !latest ||
    (latest.status === "DOWNLOADED" && age > REFRESH_AFTER_MS) ||
    (latest.status === "ERROR" && age > ERROR_RETRY_AFTER_MS) ||
    (IN_FLIGHT.has(latest.status) && age > INFLIGHT_TIMEOUT_MS);

  // ── Need a fresh request? ──
  if (needFresh) {
    try {
      const requestId = await requestItemReport(client);
      await prisma.walmartReport.create({
        data: { storeIndex, reportType: ITEM_CATALOG_REPORT_TYPE, requestId, status: "REQUESTED" },
      });
      return { action: "requested", requestId, status: "REQUESTED" };
    } catch (err) {
      if (err instanceof ReportRateLimitedError) return { action: "rateLimited", message: "request deferred" };
      throw err;
    }
  }

  // ── In-flight → poll ──
  if (latest && IN_FLIGHT.has(latest.status)) {
    let st;
    try {
      st = await getReportStatus(client, latest.requestId);
    } catch (err) {
      if (err instanceof ReportRateLimitedError) return { action: "rateLimited", requestId: latest.requestId };
      throw err;
    }

    if (st.status === "READY") {
      try {
        const url = await getReportDownloadUrl(client, latest.requestId);
        const text = await fetchReportText(url);
        const { rows, headers } = parseItemReport(text);
        const { written, publishedCount } = await replaceMirrorFromItemReport(prisma, storeIndex, rows);
        await prisma.walmartReport.update({
          where: { id: latest.id },
          data: { status: "DOWNLOADED", readyAt: new Date(), downloadedAt: new Date(), statusCheckedAt: new Date(), rowCount: written, error: null },
        });
        return { action: "downloaded", status: "DOWNLOADED", requestId: latest.requestId, written, publishedCount, headers };
      } catch (err) {
        if (err instanceof ReportRateLimitedError) return { action: "rateLimited", requestId: latest.requestId };
        await prisma.walmartReport.update({
          where: { id: latest.id },
          data: { status: "ERROR", error: (err as Error).message.slice(0, 500), statusCheckedAt: new Date() },
        });
        return { action: "errored", message: (err as Error).message };
      }
    }

    if (st.status === "ERROR") {
      await prisma.walmartReport.update({
        where: { id: latest.id },
        data: { status: "ERROR", statusCheckedAt: new Date(), error: "Walmart report status ERROR" },
      });
      return { action: "errored", status: "ERROR", requestId: latest.requestId };
    }

    await prisma.walmartReport.update({
      where: { id: latest.id },
      data: { status: "INPROGRESS", statusCheckedAt: new Date() },
    });
    return { action: "polled", status: st.status, requestId: latest.requestId };
  }

  return { action: "idle", status: latest?.status, requestId: latest?.requestId };
}
