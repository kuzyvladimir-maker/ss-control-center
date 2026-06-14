/**
 * Amazon Growth — async report state machine + enrichment.
 *
 * Amazon reports generate async (FYP/Sales&Traffic in ~1-3 min, Brand Analytics
 * >5 min) and the Reports API is rate-limited, so we drive a state machine
 * across cron runs (mirror of Walmart's sync-reports):
 *   REQUESTED → (poll) IN_PROGRESS → DONE → (parse + enrich items) PARSED | ERROR
 *
 * Reports enrich the per-SKU health items the Listings sweep created:
 *   - FYP (GET_MERCHANTS_LISTINGS_FYP_REPORT): authoritative search-suppression.
 *     Sets isSuppressed + suppressionReason; suppression crushes buyability.
 *   - Sales & Traffic (GET_SALES_AND_TRAFFIC_REPORT): per-ASIN sessions, units,
 *     buy-box %, conversion → fills the conversion + buyBox components.
 *
 * After enrichment each touched item's healthScore + topFixComponent are
 * recomputed from the full (merged) component set.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { getCachedAccessToken } from "@/lib/amazon-sp-api/auth";
import {
  type ComponentScores,
  computeHealthScore,
  pickTopFix,
  scoreConversion,
  scoreBuyBox,
  SUPPRESSED_BUYABILITY,
} from "./listing-health";

const SP_ENDPOINT = process.env.AMAZON_SP_ENDPOINT || "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER";

export type GrowthReportType = "FYP" | "SALES_TRAFFIC";

const REPORT_SPEC: Record<
  GrowthReportType,
  { amazonType: string; withDates: boolean; daysBack?: number; reportOptions?: Record<string, string> }
> = {
  FYP: { amazonType: "GET_MERCHANTS_LISTINGS_FYP_REPORT", withDates: false },
  SALES_TRAFFIC: {
    amazonType: "GET_SALES_AND_TRAFFIC_REPORT",
    withDates: true,
    daysBack: 30,
    reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
  },
};

// ─── Low-level SP-API report calls ──────────────────────────────────────────
async function createReport(storeId: string, type: GrowthReportType): Promise<string> {
  const spec = REPORT_SPEC[type];
  const token = await getCachedAccessToken(storeId);
  const body: Record<string, unknown> = {
    reportType: spec.amazonType,
    marketplaceIds: [MARKETPLACE_ID],
  };
  if (spec.withDates) {
    const days = spec.daysBack ?? 30;
    body.dataEndTime = new Date(Date.now() - 2 * 864e5).toISOString();
    body.dataStartTime = new Date(Date.now() - (days + 2) * 864e5).toISOString();
  }
  if (spec.reportOptions) body.reportOptions = spec.reportOptions;

  const res = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
    method: "POST",
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createReport ${type} failed ${res.status}: ${await res.text()}`);
  return (await res.json()).reportId as string;
}

async function getReportStatus(
  storeId: string,
  reportId: string,
): Promise<{ status: string; documentId?: string }> {
  const token = await getCachedAccessToken(storeId);
  const res = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
    headers: { "x-amz-access-token": token },
  });
  if (!res.ok) throw new Error(`getReportStatus failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { status: data.processingStatus, documentId: data.reportDocumentId };
}

async function downloadDocument(storeId: string, documentId: string): Promise<string> {
  const token = await getCachedAccessToken(storeId);
  const res = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
    headers: { "x-amz-access-token": token },
  });
  if (!res.ok) throw new Error(`getDocument failed ${res.status}: ${await res.text()}`);
  const { url } = await res.json();
  const dl = await fetch(url);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const { gunzipSync } = await import("node:zlib");
    return gunzipSync(buf).toString("utf-8");
  }
  return buf.toString("utf-8");
}

// ─── State machine driver (one step per call) ───────────────────────────────
export interface ReportStep {
  storeIndex: number;
  reportType: GrowthReportType;
  action: "requested" | "polling" | "ingested" | "error" | "noop";
  status?: string;
  rowsEnriched?: number;
  error?: string;
}

/**
 * Advance the FYP + SALES_TRAFFIC reports for one store by one step each:
 *  - if no in-flight report (or last is stale), request a fresh one
 *  - if in-flight, poll; when DONE, download + parse + enrich + mark PARSED
 * Designed to be called repeatedly by the cron.
 */
export async function advanceReports(
  prisma: PrismaClient,
  storeIndex: number,
  opts: { staleHours?: number } = {},
): Promise<ReportStep[]> {
  const staleMs = (opts.staleHours ?? 12) * 3600_000;
  const steps: ReportStep[] = [];
  for (const reportType of ["FYP", "SALES_TRAFFIC"] as GrowthReportType[]) {
    try {
      steps.push(await advanceOne(prisma, storeIndex, reportType, staleMs));
    } catch (err) {
      steps.push({ storeIndex, reportType, action: "error", error: (err as Error).message });
    }
  }
  return steps;
}

async function advanceOne(
  prisma: PrismaClient,
  storeIndex: number,
  reportType: GrowthReportType,
  staleMs: number,
): Promise<ReportStep> {
  const storeId = `store${storeIndex}`;
  // Most recent non-terminal report for this (store, type).
  const inFlight = await prisma.amazonGrowthReport.findFirst({
    where: { storeIndex, reportType, status: { in: ["REQUESTED", "IN_PROGRESS"] } },
    orderBy: { requestedAt: "desc" },
  });

  if (inFlight) {
    const { status, documentId } = await getReportStatus(storeId, inFlight.reportId);
    if (status === "DONE" && documentId) {
      const text = await downloadDocument(storeId, documentId);
      const rows =
        reportType === "FYP"
          ? await ingestFyp(prisma, storeIndex, text)
          : await ingestSalesTraffic(prisma, storeIndex, text);
      await prisma.amazonGrowthReport.update({
        where: { id: inFlight.id },
        data: { status: "PARSED", doneAt: new Date(), rowCount: rows, statusCheckedAt: new Date() },
      });
      return { storeIndex, reportType, action: "ingested", status, rowsEnriched: rows };
    }
    if (status === "FATAL" || status === "CANCELLED") {
      await prisma.amazonGrowthReport.update({
        where: { id: inFlight.id },
        data: { status: "ERROR", error: status, statusCheckedAt: new Date() },
      });
      return { storeIndex, reportType, action: "error", status };
    }
    // Still cooking.
    await prisma.amazonGrowthReport.update({
      where: { id: inFlight.id },
      data: { status: "IN_PROGRESS", statusCheckedAt: new Date() },
    });
    return { storeIndex, reportType, action: "polling", status };
  }

  // No in-flight report — request a fresh one if the last good ingest is stale.
  const lastParsed = await prisma.amazonGrowthReport.findFirst({
    where: { storeIndex, reportType, status: "PARSED" },
    orderBy: { doneAt: "desc" },
  });
  const lastTime = lastParsed?.doneAt?.getTime() ?? 0;
  if (Date.now() - lastTime < staleMs) {
    return { storeIndex, reportType, action: "noop" };
  }
  const reportId = await createReport(storeId, reportType);
  await prisma.amazonGrowthReport.create({
    data: { storeIndex, reportType, reportId, status: "REQUESTED" },
  });
  return { storeIndex, reportType, action: "requested" };
}

// ─── Parsers + enrichment ───────────────────────────────────────────────────

/** Recompute healthScore + topFix from a row's six component columns. */
function recompute(row: {
  buyabilityScore: number | null;
  issuesScore: number | null;
  contentScore: number | null;
  complianceScore: number | null;
  buyBoxScore: number | null;
  conversionScore: number | null;
}): { healthScore: number; topFixComponent: string | null } {
  const components: ComponentScores = {
    buyability: row.buyabilityScore,
    issues: row.issuesScore,
    content: row.contentScore,
    compliance: row.complianceScore,
    buyBox: row.buyBoxScore,
    conversion: row.conversionScore,
  };
  return { healthScore: computeHealthScore(components), topFixComponent: pickTopFix(components) };
}

/** FYP report: tab-delimited. Columns: Status, Reason, SKU, ASIN, Product name,
 *  Condition, Status Change Date, Issue Description. Authoritative suppression. */
async function ingestFyp(prisma: PrismaClient, storeIndex: number, text: string): Promise<number> {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return 0;
  const header = lines[0].split("\t").map((h) => h.replace(/^﻿/, "").trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iSku = col("SKU");
  const iReason = col("Reason");
  const iStatus = col("Status");
  const iIssue = col("Issue Description");
  const iAsin = col("ASIN");
  const iName = col("Product name");

  // Authoritative: reset everyone, then flag the listed SKUs.
  await prisma.amazonListingHealthItem.updateMany({
    where: { storeIndex, isSuppressed: true },
    data: { isSuppressed: false, suppressionReason: null },
  });

  let enriched = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const sku = cells[iSku]?.trim();
    if (!sku) continue;
    const reason = [cells[iStatus]?.trim(), cells[iReason]?.trim(), cells[iIssue]?.trim()]
      .filter(Boolean)
      .join(" — ");
    const existing = await prisma.amazonListingHealthItem.findUnique({
      where: { amazon_health_item_dedup: { storeIndex, sku } },
    });

    if (!existing) {
      // Suppressed SKU not yet in the mirror (e.g. beyond the Listings API
      // ~1000-item enumeration). Create a minimal row so suppression — the
      // highest-value signal — is never hidden by sweep coverage. The next
      // sweep fills in the rest of the fields.
      const components: ComponentScores = {
        buyability: SUPPRESSED_BUYABILITY,
        issues: null,
        content: null,
        compliance: null,
        buyBox: null,
        conversion: null,
      };
      await prisma.amazonListingHealthItem.create({
        data: {
          storeIndex,
          sku,
          asin: iAsin >= 0 ? cells[iAsin]?.trim() || null : null,
          itemName: iName >= 0 ? cells[iName]?.trim() || null : null,
          isSuppressed: true,
          isBuyable: true,
          isDiscoverable: false,
          suppressionReason: reason || "Search suppressed",
          buyabilityScore: SUPPRESSED_BUYABILITY,
          healthScore: computeHealthScore(components),
          topFixComponent: pickTopFix(components),
        },
      });
      enriched++;
      continue;
    }

    const merged = { ...existing, buyabilityScore: SUPPRESSED_BUYABILITY };
    const { healthScore, topFixComponent } = recompute(merged);
    await prisma.amazonListingHealthItem.update({
      where: { amazon_health_item_dedup: { storeIndex, sku } },
      data: {
        isSuppressed: true,
        isDiscoverable: false,
        suppressionReason: reason || "Search suppressed",
        buyabilityScore: SUPPRESSED_BUYABILITY,
        healthScore,
        topFixComponent,
      },
    });
    enriched++;
  }
  return enriched;
}

interface StAsinEntry {
  childAsin?: string;
  parentAsin?: string;
  salesByAsin?: { unitsOrdered?: number };
  trafficByAsin?: {
    sessions?: number;
    browserPageViews?: number;
    mobileAppPageViews?: number;
    pageViews?: number;
    buyBoxPercentage?: number;
    unitSessionPercentage?: number;
  };
}

/** Sales & Traffic report: JSON. salesAndTrafficByAsin[] keyed by childAsin.
 *  Enriches every health item that shares the ASIN. */
async function ingestSalesTraffic(prisma: PrismaClient, storeIndex: number, text: string): Promise<number> {
  let json: { salesAndTrafficByAsin?: StAsinEntry[] };
  try {
    json = JSON.parse(text);
  } catch {
    return 0;
  }
  const entries = json.salesAndTrafficByAsin ?? [];
  // Aggregate by ASIN (report may have per-day rows for the same ASIN).
  const byAsin = new Map<string, { sessions: number; pageViews: number; units: number; bbPctSum: number; bbN: number }>();
  for (const e of entries) {
    const asin = e.childAsin ?? e.parentAsin;
    if (!asin) continue;
    const t = e.trafficByAsin ?? {};
    const s = e.salesByAsin ?? {};
    const cur = byAsin.get(asin) ?? { sessions: 0, pageViews: 0, units: 0, bbPctSum: 0, bbN: 0 };
    cur.sessions += t.sessions ?? 0;
    cur.pageViews += t.pageViews ?? (t.browserPageViews ?? 0) + (t.mobileAppPageViews ?? 0);
    cur.units += s.unitsOrdered ?? 0;
    if (t.buyBoxPercentage != null) {
      cur.bbPctSum += t.buyBoxPercentage;
      cur.bbN += 1;
    }
    byAsin.set(asin, cur);
  }

  let enriched = 0;
  for (const [asin, agg] of byAsin) {
    const items = await prisma.amazonListingHealthItem.findMany({ where: { storeIndex, asin } });
    if (items.length === 0) continue;
    const unitSessionPct = agg.sessions > 0 ? agg.units / agg.sessions : null;
    const buyBoxPct = agg.bbN > 0 ? agg.bbPctSum / agg.bbN : null;
    const conversionScore = scoreConversion(agg.sessions, unitSessionPct);
    const buyBoxScore = scoreBuyBox(buyBoxPct);

    for (const it of items) {
      const merged = { ...it, conversionScore, buyBoxScore };
      const { healthScore, topFixComponent } = recompute(merged);
      await prisma.amazonListingHealthItem.update({
        where: { id: it.id },
        data: {
          sessions30d: agg.sessions,
          pageViews30d: agg.pageViews,
          unitsOrdered30d: agg.units,
          buyBoxPercentage: buyBoxPct,
          unitSessionPct,
          conversionScore,
          buyBoxScore,
          healthScore,
          topFixComponent,
        },
      });
      enriched++;
    }
  }
  return enriched;
}
