/**
 * GET /api/cron/reference-enrichment-worker
 *
 * Drains EnrichmentJob — the always-on engine behind the Reference Catalog's
 * "enrich by brand/vector" button (and, later, Bundle Factory misses + an auto
 * seeder). Vercel is serverless, so a frequent cron tick = the loop: each run
 * claims a few queued targets, runs enrichTarget (search live retailers → gate →
 * upsert DonorProduct/DonorOffer), and marks them done.
 *
 * Walmart (BlueCart) is always searched; Target/Sam's/Costco (Unwrangle) activate
 * automatically once that sub is paid (enrichTarget skips a retailer that reports
 * trial-exhausted). Spending is guarded by a BlueCart credit floor.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { enrichTarget, cleanupOrphans, dedupeOffersPerRetailer, harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DRAIN_PER_TICK = 8;          // targets per tick; each ≈ 1 BlueCart + up to 3 Unwrangle calls
const TIME_BUDGET_MS = 110_000;    // < the 2-min interval so ticks don't overlap
const MAX_ATTEMPTS = 4;
const INTER_JOB_MS = 500;
// Walmart included so it falls back to Unwrangle walmart_search when BlueCart is
// down/exhausted (enrichTarget still prefers BlueCart for Walmart when available).
const UNWRANGLE_RETAILERS: ("walmart" | "target" | "samsclub" | "costco")[] = ["walmart", "target", "samsclub", "costco"];
// OpenClaw (logged-in browser on the box) reliably covers all three gated grocery
// nets — BJ's, Publix, Aldi. Oxylabs grocery targets are gated/empty, so it's not
// called per-enrichment for now (kept wired for future Amazon/Walmart use).
const OXYLABS_RETAILERS = [] as const;
const OPENCLAW_RETAILERS = ["bjs", "publix", "aldi"] as const;
const ZIP = "33765"; // Clearwater, FL — our buying zone

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const out = { done: 0, errored: 0, requeued: 0, productsCreated: 0, offersUpserted: 0, processed: [] as any[] };

  // REAP: a tick killed mid-run leaves a row stuck 'running' — return it after 10 min.
  try {
    const reap = await conn.execute(`UPDATE "EnrichmentJob" SET status='queued', startedAt=NULL WHERE status='running' AND startedAt < datetime('now','-10 minutes')`);
    (out as any).reaped = reap.rowsAffected || 0;
  } catch { /* ignore */ }

  // BlueCart balance is surfaced for visibility only. Enrichment no longer pauses
  // on a low BlueCart floor — Walmart falls back to Unwrangle (100k-credit plan),
  // so a depleted BlueCart must not stall the whole queue.
  (out as any).bluecartCredits = await bluecartCreditsRemaining();

  while (Date.now() - started < TIME_BUDGET_MS) {
    const q = await conn.execute(`SELECT id, targetType, target, attempts FROM "EnrichmentJob" WHERE status='queued' ORDER BY priority DESC, attempts ASC, queuedAt ASC LIMIT 1`);
    const job = (q.rows as any[])[0];
    if (!job) break;

    // Claim it (counting the attempt) so a concurrent tick can't grab the row.
    const attempt = Number(job.attempts || 0) + 1;
    const claim = await conn.execute({
      sql: `UPDATE "EnrichmentJob" SET status='running', startedAt=CURRENT_TIMESTAMP, attempts=? WHERE id=? AND status='queued'`,
      args: [attempt, job.id],
    });
    if (claim.rowsAffected === 0) continue;

    try {
      const brand = job.targetType === "brand" ? String(job.target) : undefined;
      const r = await enrichTarget(conn, { target: String(job.target), brand, zip: ZIP, unwrangleRetailers: UNWRANGLE_RETAILERS, oxylabsRetailers: [...OXYLABS_RETAILERS], openClawRetailers: [...OPENCLAW_RETAILERS] });
      out.productsCreated += r.productsCreated;
      out.offersUpserted += r.offersUpserted;

      // Harvest the freshly-created products RIGHT NOW (parallel batches) so a new
      // brand never shows up with only a title + 1 thumbnail. Bounded by the tick's
      // time budget; whatever doesn't fit is caught by the harvest cron (newest-first).
      let harvested = 0;
      const fresh = r.createdProductIds || [];
      for (let i = 0; i < fresh.length && Date.now() - started < TIME_BUDGET_MS; i += 5) {
        const batch = fresh.slice(i, i + 5);
        const res = await Promise.all(batch.map((id) => harvestDonorDetail(conn, id).then((h) => h.ok).catch(() => false)));
        harvested += res.filter(Boolean).length;
      }
      (out as any).harvested = ((out as any).harvested || 0) + harvested;

      await conn.execute({
        sql: `UPDATE "EnrichmentJob" SET status='done', finishedAt=CURRENT_TIMESTAMP, result=?, error=NULL WHERE id=?`,
        args: [JSON.stringify({ ...r, harvested }), job.id],
      });
      out.done++;
      out.processed.push({ target: job.target, ...r, harvested });
    } catch (e: any) {
      const msg = String(e?.message || "exception").slice(0, 200);
      if (attempt < MAX_ATTEMPTS) {
        out.requeued++;
        await conn.execute({ sql: `UPDATE "EnrichmentJob" SET status='queued', startedAt=NULL, error=? WHERE id=?`, args: [msg, job.id] });
      } else {
        out.errored++;
        await conn.execute({ sql: `UPDATE "EnrichmentJob" SET status='error', finishedAt=CURRENT_TIMESTAMP, error=? WHERE id=?`, args: [msg, job.id] });
      }
    }

    await sleep(INTER_JOB_MS);
    if (out.done + out.errored >= DRAIN_PER_TICK) break;
  }

  // Self-heal: drop zero-offer products + collapse doubled same-retailer offers.
  try { (out as any).orphansCleaned = await cleanupOrphans(conn); } catch { /* best-effort */ }
  try { (out as any).offersDeduped = await dedupeOffersPerRetailer(conn); } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
