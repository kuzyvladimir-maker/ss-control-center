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
import { enrichTarget, cleanupOrphans } from "@/lib/sourcing/donor-catalog";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DRAIN_PER_TICK = 8;          // targets per tick; each ≈ 1 BlueCart + up to 3 Unwrangle calls
const TIME_BUDGET_MS = 240_000;    // < the 5-min interval so ticks don't overlap
const BLUECART_CREDIT_FLOOR = 300; // pause Walmart enrichment below this (protect the monthly allotment)
const MAX_ATTEMPTS = 4;
const INTER_JOB_MS = 500;
const UNWRANGLE_RETAILERS: ("target" | "samsclub" | "costco")[] = ["target", "samsclub", "costco"];
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

  // Budget guard: don't burn BlueCart below the floor.
  const credits = await bluecartCreditsRemaining();
  (out as any).bluecartCredits = credits;
  if (credits != null && credits <= BLUECART_CREDIT_FLOOR) {
    return NextResponse.json({ ok: true, paused: "bluecart credits at/below floor", ...out });
  }

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
      const r = await enrichTarget(conn, { target: String(job.target), brand, zip: ZIP, unwrangleRetailers: UNWRANGLE_RETAILERS });
      out.productsCreated += r.productsCreated;
      out.offersUpserted += r.offersUpserted;
      await conn.execute({
        sql: `UPDATE "EnrichmentJob" SET status='done', finishedAt=CURRENT_TIMESTAMP, result=?, error=NULL WHERE id=?`,
        args: [JSON.stringify(r), job.id],
      });
      out.done++;
      out.processed.push({ target: job.target, ...r });
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

  // Self-heal: drop any products left with zero offers (legacy dedup artifacts).
  try { (out as any).orphansCleaned = await cleanupOrphans(conn); } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
