/**
 * FULL catalog sync via Walmart's async ITEM report.
 *
 * Why: the `/v3/items` endpoint (see iterateWalmartCatalog) under-reports — it
 * returned ~2981 published for an account the Seller Center UI shows 3895 published.
 * The authoritative full catalog (all statuses, matching the UI) comes from the
 * On-Request **ITEM report** (`POST /reports/reportRequests?reportType=ITEM`). It's
 * async (report generates in ~15-45 min). Legacy ITEM report creation is now
 * retired; this module may only poll/download an already-retained in-flight
 * request. A new request belongs to the owner-permitted canonical capture engine.
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
} from "./reports-insights.ts";

export const ITEM_CATALOG_REPORT_TYPE = "ITEM_CATALOG"; // WalmartReport.reportType tag
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000; // re-request ~daily after a good run
const ERROR_RETRY_AFTER_MS = 60 * 60 * 1000; // a failed report retries after ~1h, not 20h
const IN_FLIGHT = new Set(["REQUESTED", "INPROGRESS", "RECEIVED", "SUBMITTED"]);
const INSERT_CHUNK = 500;
const TX_TIMEOUT_MS = 120_000;
export const ITEM_REPORT_CREATE_RETIRED_REASON =
  "LEGACY_ITEM_REPORT_CREATE_RETIRED_OWNER_PERMIT_REQUIRED" as const;
// Guard: refuse to replace the mirror with fewer than this many rows (protects the
// shared cache from a wrong-columns / truncated report). Our catalog is ~4-5k items.
// Exported so the /v3/items fallback (syncWalmartCatalog) applies the SAME floor.
export const MIN_SANE_ROWS = 2500;

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
  action: "polled" | "downloaded" | "errored" | "rateLimited" | "idle";
  status?: string;
  requestId?: string;
  written?: number;
  publishedCount?: number;
  headers?: string[];
  message?: string;
  reason?: typeof ITEM_REPORT_CREATE_RETIRED_REASON;
}

/** Poll/download one already-existing ITEM report request; never create one. */
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
  // Legacy report creation is permanently retired. This reader may continue an
  // already-retained in-flight request, but it must never originate a new ITEM
  // report. A replacement create attempt belongs only to the canonical capture
  // engine and its externally owner-authorized one-shot permit.
  const needsNewRequest =
    !latest ||
    (latest.status === "DOWNLOADED" && age > REFRESH_AFTER_MS) ||
    (latest.status === "ERROR" && age > ERROR_RETRY_AFTER_MS);

  if (needsNewRequest) {
    return {
      action: "idle",
      status: latest?.status,
      reason: ITEM_REPORT_CREATE_RETIRED_REASON,
      message: "legacy ITEM report creation is retired; an owner-permitted canonical capture is required",
    };
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
