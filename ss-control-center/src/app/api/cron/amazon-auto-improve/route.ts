/**
 * GET /api/cron/amazon-auto-improve
 *
 * The autonomous safe-improvement loop (experiment engine, Phase 2). Each run it
 * finds OWN-BRAND listings (Salutem Vita + Starfit, incl. gift sets) that still
 * have a fixable problem — search-suppression or ERROR-severity issues — and
 * enqueues them for the deterministic remediation worker (dedupe duplicate attrs,
 * brand-voice title scrub, derive structural unit_count/weight). The worker
 * validates every write (VALIDATION_PREVIEW) before applying, logs it, and the
 * daily diff-in-diff sweep measures whether it actually lifted sales.
 *
 * Conservative + safe by construction: own-brand only, deterministic fixes only
 * (never price/UPC/brand/productType, never AI-generated content), validated,
 * reversible. Small batches so it ramps gradually and bad effects surface early.
 * The existing amazon-remediation cron drains the queue.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const maxDuration = 120;

const STORES = [1, 3];
const BATCH_PER_STORE = 12;
const RECHECK_HOURS = 12; // don't re-enqueue a listing fixed/seen within this window

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const scope = JSON.stringify({ dedupe: true, brandVoice: true, suppression: true });
  const recheckCutoff = new Date(Date.now() - RECHECK_HOURS * 3600e3);
  const out: unknown[] = [];

  for (const storeIndex of STORES) {
    try {
      // Own-brand listings with a DETERMINISTICALLY-fixable problem, worst-
      // opportunity first. We target only what the safe worker can actually fix:
      //  - search-suppressed (derive structural unit_count/weight from the title), or
      //  - a "maximum of N occurrence(s)" duplicate-attribute issue (99016 dedupe).
      // Other ERROR issues (18971 listing-limitation, 8541 catalog mismatch, …) are
      // manual/business and are intentionally left alone — no churn, no wasted calls.
      const candidates = await prisma.amazonListingHealthItem.findMany({
        where: {
          storeIndex,
          OR: [{ itemName: { contains: "Salutem Vita" } }, { itemName: { contains: "Starfit" } }],
          AND: [{ OR: [{ isSuppressed: true }, { issuesSummary: { contains: "occurrence" } }] }],
        },
        orderBy: { opportunityScore: "desc" },
        select: { sku: true, asin: true, itemName: true },
        take: BATCH_PER_STORE * 4,
      });

      let queued = 0;
      for (const c of candidates) {
        if (queued >= BATCH_PER_STORE) break;
        const existing = await prisma.amazonRemediationQueue.findUnique({
          where: { amazon_remediation_queue_dedup: { storeIndex, sku: c.sku } },
          select: { status: true, processedAt: true },
        });
        // Skip if already waiting/running, or processed recently (avoid churn).
        if (existing && (existing.status === "REQUESTED" || existing.status === "RUNNING")) continue;
        if (existing?.processedAt && existing.processedAt > recheckCutoff) continue;

        await prisma.amazonRemediationQueue.upsert({
          where: { amazon_remediation_queue_dedup: { storeIndex, sku: c.sku } },
          create: { storeIndex, sku: c.sku, asin: c.asin, itemName: c.itemName, scope, status: "REQUESTED" },
          update: { scope, status: "REQUESTED", changesApplied: 0, result: null, error: null, processedAt: null, queuedAt: new Date() },
        });
        queued++;
      }
      out.push({ storeIndex, candidates: candidates.length, queued });
    } catch (err) {
      out.push({ storeIndex, error: (err as Error).message });
    }
  }

  return NextResponse.json({ ok: true, enqueued: out });
}
