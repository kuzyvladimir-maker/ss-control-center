/**
 * GET /api/cron/walmart-remediation-worker
 *
 * Drains WalmartRemediationQueue — this is the always-on engine behind the
 * Listing Optimizer's "Run optimization" button. Vercel is serverless (no
 * persistent loop), so a frequent cron tick gives the same effect: each run
 * peeks at the queue and, if there's work, advances it.
 *
 * Because Walmart processes feeds asynchronously (minutes→hours), the heavy
 * pipeline is split across ticks so each stays inside the serverless budget:
 *   1. FINALIZE — for rows already 'submitted', poll the feed once; terminal →
 *      mark done/error + flip the analytics row to ok so measure-after runs.
 *   2. DRAIN    — take a few 'queued' rows, build + submit the partial feed
 *      (scope-aware), log the before-snapshot, mark 'submitted' with the feedId.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { getWalmartClient } from "@/lib/walmart/client";
import { buildAndSubmitOne, checkFeed, RemediateScope } from "@/lib/walmart/multipack/remediate";
import { logRemediation } from "@/lib/walmart/multipack/analytics";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STORE = 1;
const DRAIN_PER_TICK = 2;       // keep Walmart feed/API calls under the account threshold
const FINALIZE_PER_TICK = 25;   // feed-status GETs are cheap
const TIME_BUDGET_MS = 230_000;
const BLUECART_CREDIT_FLOOR = 300; // stop on-demand enrichment below this to protect the monthly allotment
const MAX_ATTEMPTS = 6;         // give a rate-limited SKU several retries before giving up
const INTER_SKU_MS = 2000;      // space out SKUs so a burst doesn't trip the threshold
const BATCH_TARGET = 120;       // account safety: never expose more than this many listings in-flight at once

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Walmart "REQUEST_THRESHOLD_VIOLATED" / 429 are transient — retry, don't fail.
const isRetryable = (s: string) => /REQUEST_THRESHOLD_VIOLATED|threshold|too many requests|rate.?limit|\b429\b/i.test(s || "");

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  const started = Date.now();
  const conn = db();
  const client = getWalmartClient(STORE);
  const out = { finalized: 0, done: 0, errored: 0, submitted: 0, skipped: 0, requeued: 0, processed: [] as any[] };

  // ── 1. FINALIZE submitted feeds ──────────────────────────────────────────
  try {
    const subs = await conn.execute({
      sql: `SELECT id, sku, feedId, result FROM WalmartRemediationQueue WHERE storeIndex=? AND status='submitted' AND feedId IS NOT NULL ORDER BY finishedAt ASC LIMIT ?`,
      args: [STORE, FINALIZE_PER_TICK],
    });
    for (const row of subs.rows as any[]) {
      const feedId = String(row.feedId);
      try {
        const res = await checkFeed(client, feedId);
        if (!res) continue; // still processing — leave 'submitted'
        out.finalized++;

        // Catalog-conflict (QARTH / ERR_EXT_DATA): Walmart rejects content edits
        // on cards we don't own. Fall back to IMAGE-ONLY (the priority fix — the
        // tiled main image isn't "product identity" so it isn't blocked). Only
        // retry once; if image-only also fails, it's truly locked → error.
        let imageRetry = false;
        try { imageRetry = !!JSON.parse(row.result || "{}").imageRetry; } catch {}
        const conflict = !res.ok && /ERR_EXT_DATA|EXT_DATA_ERROR|0101119|QARTH/i.test(res.detail);
        if (conflict && !imageRetry) {
          out.requeued++;
          await conn.execute({
            sql: `UPDATE WalmartRemediationQueue SET status='queued', startedAt=NULL, finishedAt=NULL, feedId=NULL, attempts=0, result=?, error=? WHERE id=?`,
            args: [JSON.stringify({ scope: { image: true, gallery: true }, imageRetry: true }), `catalog-locked → image-only retry`, row.id],
          });
          await conn.execute({ sql: `UPDATE WalmartListingRemediation SET feedStatus=?, ok=0 WHERE feedId=?`, args: [res.status, feedId] });
          continue;
        }

        if (res.ok) out.done++; else out.errored++;
        await conn.execute({
          sql: `UPDATE WalmartRemediationQueue SET status=?, finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`,
          args: [res.ok ? "done" : "error", res.ok ? (imageRetry ? "image-only applied (content catalog-locked)" : null) : res.detail, row.id],
        });
        // Flip the analytics row so measure-after will compute the delta.
        await conn.execute({
          sql: `UPDATE WalmartListingRemediation SET feedStatus=?, ok=? WHERE feedId=?`,
          args: [res.status, res.ok ? 1 : 0, feedId],
        });
      } catch { /* transient feed read — retry next tick */ }
    }
  } catch (e) { /* table/permission issue — surfaced below via empty counts */ }

  // ── 2. DRAIN queued rows: build + submit ─────────────────────────────────
  // Budget guard: only allow on-demand BlueCart enrichment while credits are
  // comfortably above the floor (protects the monthly allotment / $ ceiling).
  const credits = await bluecartCreditsRemaining();
  const allowEnrich = credits == null ? true : credits > BLUECART_CREDIT_FLOOR;
  (out as any).bluecartCredits = credits;
  (out as any).enrichEnabled = allowEnrich;
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now()).slice(-5);

    // Batch gate: keep at most BATCH_TARGET listings in-flight at once. The rest
    // sit in 'held'; we top up only when the current batch drains. This bounds
    // how many catalog changes are ever live at once (account safety).
    const activeRow = await conn.execute({ sql: `SELECT COUNT(*) c FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('queued','running','submitted')`, args: [STORE] });
    const active = Number((activeRow.rows[0] as any)?.c || 0);
    if (active < BATCH_TARGET) {
      const held = await conn.execute({ sql: `SELECT id FROM WalmartRemediationQueue WHERE storeIndex=? AND status='held' ORDER BY queuedAt ASC LIMIT ?`, args: [STORE, BATCH_TARGET - active] });
      const ids = (held.rows as any[]).map((r) => r.id);
      if (ids.length) {
        await conn.execute({ sql: `UPDATE WalmartRemediationQueue SET status='queued' WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids });
        (out as any).promoted = ids.length;
      }
    }

    while (Date.now() - started < TIME_BUDGET_MS) {
      const q = await conn.execute({
        // attempts ASC first: a row re-queued this tick (rate-limit) has a higher
        // attempt count, so fresh rows are picked before it — preventing the same
        // SKU from being re-processed (double enrichment) within one tick.
        sql: `SELECT id, sku, result, attempts FROM WalmartRemediationQueue WHERE storeIndex=? AND status='queued' ORDER BY attempts ASC, queuedAt ASC LIMIT 1`,
        args: [STORE],
      });
      const job = (q.rows as any[])[0];
      if (!job) break;
      // Claim it (counting the attempt) so a concurrent tick can't grab the row.
      const attempt = Number(job.attempts || 0) + 1;
      const claim = await conn.execute({
        sql: `UPDATE WalmartRemediationQueue SET status='running', startedAt=CURRENT_TIMESTAMP, attempts=? WHERE id=? AND status='queued'`,
        args: [attempt, job.id],
      });
      if (claim.rowsAffected === 0) continue;

      let scope: RemediateScope | null = null;
      try { const r = JSON.parse(job.result || "{}"); if (r && typeof r.scope === "object") scope = r.scope; } catch {}

      // Transient (rate-limit) failures go back to the queue for a later tick;
      // give up only after MAX_ATTEMPTS or for non-retryable errors.
      const fail = async (msg: string) => {
        if (isRetryable(msg) && attempt < MAX_ATTEMPTS) {
          out.requeued++;
          await conn.execute({ sql: `UPDATE WalmartRemediationQueue SET status='queued', startedAt=NULL, error=? WHERE id=?`, args: [msg.slice(0, 200), job.id] });
        } else {
          out.errored++;
          await conn.execute({ sql: `UPDATE WalmartRemediationQueue SET status='error', finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`, args: [msg.slice(0, 200), job.id] });
        }
      };

      try {
        const r = await buildAndSubmitOne(conn, client, job.sku, { scope, stamp, enrich: allowEnrich, storeIndex: STORE });
        if (r.feedId && r.meta) {
          await logRemediation(conn, {
            sku: job.sku, wpid: r.meta.wpid, upc: r.meta.upc, buyerItemId: (r.url.match(/ip\/(\d+)/) || [])[1] || null,
            changeType: "multipack", feedId: r.feedId, feedType: "MP_MAINTENANCE", feedStatus: "SUBMITTED", ok: false,
            packCount: r.meta.packCount, newTitle: r.meta.newTitle ?? undefined, titleChanged: !!r.meta.newTitle,
            bulletsCount: r.meta.bulletsCount, imagesCount: r.meta.imagesCount, descriptionLength: r.meta.descriptionLength,
            mainImageUrl: r.meta.mainImageUrl ?? undefined, usedAiPolish: r.meta.usedAiPolish,
            changeSummary: { contentIssues: r.meta.contentIssues, gaps: r.meta.gaps },
            notes: r.meta.gaps?.length ? `content gaps: ${r.meta.gaps.map((g: any) => g.issue).join("; ")}` : "no content gaps",
          });
          await conn.execute({
            sql: `UPDATE WalmartRemediationQueue SET status='submitted', feedId=?, result=? WHERE id=?`,
            args: [r.feedId, r.url, job.id],
          });
          out.submitted++;
        } else if (r.status === "SKIP") {
          out.skipped++;
          await conn.execute({ sql: `UPDATE WalmartRemediationQueue SET status='skipped', finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`, args: [r.detail || "skip", job.id] });
        } else {
          await fail(r.detail || r.status); // POST_FAILED — may be a transient threshold hit
        }
        out.processed.push({ sku: job.sku, status: r.status, feedId: r.feedId, url: r.url });
      } catch (e: any) {
        await fail(String(e?.message || "exception"));
      }

      await sleep(INTER_SKU_MS); // space out so a burst doesn't trip Walmart's threshold
      if (out.submitted + out.skipped + out.errored + out.requeued >= DRAIN_PER_TICK) break;
    }
  } catch (e) { /* drain loop guard */ }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
