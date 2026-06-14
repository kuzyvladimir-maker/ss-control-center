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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STORE = 1;
const DRAIN_PER_TICK = 3;     // build+submit is ~30–60s each; 3 fits 300s with headroom
const FINALIZE_PER_TICK = 25; // feed-status GETs are cheap
const TIME_BUDGET_MS = 230_000;

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
  const out = { finalized: 0, done: 0, errored: 0, submitted: 0, skipped: 0, processed: [] as any[] };

  // ── 1. FINALIZE submitted feeds ──────────────────────────────────────────
  try {
    const subs = await conn.execute({
      sql: `SELECT sku, feedId FROM WalmartRemediationQueue WHERE storeIndex=? AND status='submitted' AND feedId IS NOT NULL ORDER BY finishedAt ASC LIMIT ?`,
      args: [STORE, FINALIZE_PER_TICK],
    });
    for (const row of subs.rows as any[]) {
      const feedId = String(row.feedId);
      try {
        const res = await checkFeed(client, feedId);
        if (!res) continue; // still processing — leave 'submitted'
        out.finalized++;
        if (res.ok) out.done++; else out.errored++;
        await conn.execute({
          sql: `UPDATE WalmartRemediationQueue SET status=?, finishedAt=CURRENT_TIMESTAMP, result=?, error=? WHERE sku=? AND status='submitted'`,
          args: [res.ok ? "done" : "error", res.detail, res.ok ? null : res.detail, row.sku],
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
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now()).slice(-5);
    while (Date.now() - started < TIME_BUDGET_MS) {
      const q = await conn.execute({
        sql: `SELECT id, sku, result FROM WalmartRemediationQueue WHERE storeIndex=? AND status='queued' ORDER BY queuedAt ASC LIMIT 1`,
        args: [STORE],
      });
      const job = (q.rows as any[])[0];
      if (!job) break;
      // Claim it so a concurrent tick can't grab the same row.
      const claim = await conn.execute({
        sql: `UPDATE WalmartRemediationQueue SET status='running', startedAt=CURRENT_TIMESTAMP WHERE id=? AND status='queued'`,
        args: [job.id],
      });
      if (claim.rowsAffected === 0) continue;

      let scope: RemediateScope | null = null;
      try { const r = JSON.parse(job.result || "{}"); if (r && typeof r.scope === "object") scope = r.scope; } catch {}

      try {
        const r = await buildAndSubmitOne(conn, client, job.sku, { scope, stamp });
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
        } else {
          // SKIP (no donor/pack/not-found) or POST failure → terminal so it doesn't loop.
          const terminal = r.status === "SKIP" ? "skipped" : "error";
          if (r.status === "SKIP") out.skipped++; else out.errored++;
          await conn.execute({
            sql: `UPDATE WalmartRemediationQueue SET status=?, finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`,
            args: [terminal, r.detail || r.status, job.id],
          });
        }
        out.processed.push({ sku: job.sku, status: r.status, feedId: r.feedId, url: r.url });
      } catch (e: any) {
        out.errored++;
        await conn.execute({
          sql: `UPDATE WalmartRemediationQueue SET status='error', finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`,
          args: [String(e?.message || "exception").slice(0, 200), job.id],
        });
      }

      if (out.submitted + out.skipped >= DRAIN_PER_TICK) break;
    }
  } catch (e) { /* drain loop guard */ }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
