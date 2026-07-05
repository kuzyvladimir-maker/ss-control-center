/**
 * GET /api/cron/cogs-sweep
 *
 * The background COGS auto-sweep — "runs itself over ~2 weeks" (Vladimir). Vercel is
 * serverless, so each cron tick costs a BOUNDED chunk of the catalog: it claims the
 * next N still-uncosted PUBLISHED Walmart SKUs (then Amazon once Walmart is fully
 * covered), runs the shared costOneSku engine on each (own-brand → exact 1P →
 * line-price → Google Shopping), and writes SkuCost + SkuComponent. The resumable
 * query means every tick advances; a tick killed mid-run just re-runs those SKUs next
 * time (SkuCost is written per-SKU). No SKU is left without a number.
 *
 * Tunables via query string:
 *   ?channel=auto|walmart|amazon   (default auto: walmart until 0 remain, then amazon)
 *   ?limit=25                      (SKUs per tick)
 *   ?concurrency=3                 (parallel SKUs; each = vision + retail calls)
 *   ?confidence=0.7                (identify gate → needsReview below this)
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, type Client } from "@libsql/client";
import { costOneSku, nextUncostedWalmartSkus, amazonSkus, walmartSweepRemaining } from "@/lib/sourcing/cogs-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// < the 300s function cap with margin for in-flight SKUs to finish. NOTE: the Codex
// vision worker SERIALIZES runs (~20-25s each, shared with Bundle-Factory image gen),
// so a tick realistically identifies ~8-10 uncached SKUs before this budget stops it;
// cached SKUs (identity already stored) skip vision and fly through much faster.
const TIME_BUDGET_MS = 215_000;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function db(): Client {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const started = Date.now();
  const conn = db();
  const url = new URL(request.url);
  const channelParam = (url.searchParams.get("channel") || "auto").toLowerCase();
  const LIMIT = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "25", 10)));
  const CONCURRENCY = Math.max(1, Math.min(6, parseInt(url.searchParams.get("concurrency") || "3", 10)));
  const MIN_CONF = parseFloat(url.searchParams.get("confidence") || "0.7");

  // Decide channel: auto = Walmart until its published catalog is fully costed, then Amazon.
  const wm = await walmartSweepRemaining(conn);
  let channel = channelParam;
  if (channelParam === "auto") channel = wm.remaining > 0 ? "walmart" : "amazon";

  const skus = channel === "amazon" ? await amazonSkus(LIMIT) : await nextUncostedWalmartSkus(conn, LIMIT);

  const out: any = {
    channel,
    walmart: { remaining: wm.remaining, total: wm.total, costed: wm.total - wm.remaining },
    picked: skus.length,
    costed: 0, noPrice: 0, review: 0, errored: 0, noInput: 0,
    results: [] as any[],
  };

  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, async () => {
    while (true) {
      if (Date.now() - started > TIME_BUDGET_MS) break; // stop claiming near the time cap
      const i = idx++;
      if (i >= skus.length) break;
      const r = await costOneSku(conn, { sku: skus[i], channel, minConf: MIN_CONF });
      if (r.status === "costed") { out.costed++; if (r.needsReview) out.review++; }
      else if (r.status === "no-price") out.noPrice++;
      else if (r.status === "no-input") out.noInput++;
      else if (r.status === "error") out.errored++;
      out.results.push({ sku: r.sku, status: r.status, total: r.total, methods: r.methods, review: r.needsReview, error: r.error });
    }
  }));

  out.ms = Date.now() - started;
  out.remainingAfter = channel === "walmart" ? Math.max(0, wm.remaining - out.costed) : undefined;
  return NextResponse.json(out);
}
