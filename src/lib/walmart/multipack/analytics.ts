// Remediation analytics — log every applied listing change with the item's
// metrics BEFORE the change, so a later measure-after pass can compute the delta
// in listing-quality score, conversion, page views and GMV. This is the data
// foundation for learning which edits actually improve sales/conversion.
//
// Reads current per-item metrics from WalmartListingQualityItem (populated by
// the syncListingQuality sweep) and writes events to WalmartListingRemediation.
// Uses raw libsql so the publish scripts can call it with their existing client.

import type { Client } from "@libsql/client";
import { randomUUID } from "crypto";

export interface ItemMetrics {
  capturedAt: string | null;
  lqScore: number | null;
  contentScore: number | null;
  conversionRate30d: number | null;
  pageViews30d: number | null;
  gmv30d: number | null;
  units30d: number | null;
  issueCount: number | null;
}

/** Latest per-item metrics from the listing-quality mirror (null row → all null). */
export async function getItemMetrics(db: Client, sku: string, storeIndex = 1): Promise<ItemMetrics> {
  const r = await db.execute({
    sql: `SELECT lqScore, contentScore, conversionRate30d, pageViews30d, gmv30d, units30d, issueCount, scoredAt, syncedAt
          FROM WalmartListingQualityItem WHERE storeIndex=? AND sku=? LIMIT 1`,
    args: [storeIndex, sku],
  });
  const x = r.rows[0] as any;
  if (!x) return { capturedAt: null, lqScore: null, contentScore: null, conversionRate30d: null, pageViews30d: null, gmv30d: null, units30d: null, issueCount: null };
  return {
    capturedAt: x.scoredAt ?? x.syncedAt ?? null,
    lqScore: num(x.lqScore), contentScore: num(x.contentScore),
    conversionRate30d: num(x.conversionRate30d), pageViews30d: int(x.pageViews30d),
    gmv30d: num(x.gmv30d), units30d: int(x.units30d), issueCount: int(x.issueCount),
  };
}

export interface RemediationLog {
  sku: string; storeIndex?: number; wpid?: string | null; upc?: string | null; buyerItemId?: string | null;
  changeType?: string; feedId?: string | null; feedType?: string; feedStatus?: string | null; ok: boolean;
  packCount?: number; newTitle?: string; titleChanged?: boolean; bulletsCount?: number; imagesCount?: number;
  descriptionLength?: number; mainImageUrl?: string; usedAiPolish?: boolean; changeSummary?: unknown; notes?: string;
}

/** Insert one remediation event with the item's before-metrics snapshot. */
export async function logRemediation(db: Client, log: RemediationLog): Promise<string> {
  const storeIndex = log.storeIndex ?? 1;
  const before = await getItemMetrics(db, log.sku, storeIndex);
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO WalmartListingRemediation
      (id, storeIndex, sku, wpid, upc, buyerItemId, changeType, feedId, feedType, feedStatus, ok,
       packCount, newTitle, titleChanged, bulletsCount, imagesCount, descriptionLength, mainImageUrl, usedAiPolish, changeSummary,
       beforeCapturedAt, beforeLqScore, beforeContentScore, beforeConversionRate30d, beforePageViews30d, beforeGmv30d, beforeUnits30d, beforeIssueCount, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
    args: [
      id, storeIndex, log.sku, log.wpid ?? null, log.upc ?? null, log.buyerItemId ?? null,
      log.changeType ?? "multipack", log.feedId ?? null, log.feedType ?? "MP_MAINTENANCE", log.feedStatus ?? null, log.ok ? 1 : 0,
      log.packCount ?? null, log.newTitle ?? null, log.titleChanged ? 1 : 0, log.bulletsCount ?? null, log.imagesCount ?? null,
      log.descriptionLength ?? null, log.mainImageUrl ?? null, log.usedAiPolish ? 1 : 0,
      log.changeSummary ? JSON.stringify(log.changeSummary) : null,
      before.capturedAt, before.lqScore, before.contentScore, before.conversionRate30d, before.pageViews30d, before.gmv30d, before.units30d, before.issueCount,
      log.notes ?? null,
    ],
  });
  return id;
}

/** Fill after-metrics + delta for remediations whose change is old enough and a
 *  newer sweep has landed. Returns count updated. */
export async function measureAfter(db: Client, opts: { minAgeHours?: number; storeIndex?: number } = {}): Promise<number> {
  const storeIndex = opts.storeIndex ?? 1;
  const minAgeHours = opts.minAgeHours ?? 24;
  const rows = await db.execute({
    sql: `SELECT id, sku, runAt FROM WalmartListingRemediation
          WHERE storeIndex=? AND ok=1 AND afterCapturedAt IS NULL
            AND runAt <= datetime('now', ?)`,
    args: [storeIndex, `-${minAgeHours} hours`],
  });
  let updated = 0;
  for (const row of rows.rows as any[]) {
    const m = await getItemMetrics(db, row.sku, storeIndex);
    // Only record "after" if the sweep that produced it is newer than the change.
    if (!m.capturedAt || m.capturedAt <= row.runAt) continue;
    await db.execute({
      sql: `UPDATE WalmartListingRemediation SET
              afterCapturedAt=?, afterLqScore=?, afterContentScore=?, afterConversionRate30d=?,
              afterPageViews30d=?, afterGmv30d=?, afterUnits30d=?, afterIssueCount=? WHERE id=?`,
      args: [m.capturedAt, m.lqScore, m.contentScore, m.conversionRate30d, m.pageViews30d, m.gmv30d, m.units30d, m.issueCount, row.id],
    });
    updated++;
  }
  return updated;
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v: any): number | null { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
