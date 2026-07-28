/**
 * GET /api/cron/bundle-factory-poll-pending
 *
 * The always-on tail of the Bundle Factory publish loop. Vercel is serverless
 * (no persistent worker), so a frequent cron tick does the job:
 *   1. REAP  — return leaked RESERVED barcodes (past TTL) to AVAILABLE so a
 *      crash between reserve and assign never loses a paid code.
 *   2. POLL  — advance SUBMITTED listings: PENDING_REVIEW/LIVE/FAILED, and
 *      self-heal UPC collisions (burn → next barcode → re-publish).
 *
 * Without this on a schedule, SUBMITTED listings hang forever and the UPC
 * self-heal never runs (audit finding 2026-07-01).
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextResponse } from "next/server";
import { runPollPending } from "@/lib/bundle-factory/distribution/poll-pending-core";
import { reapExpiredReservations } from "@/lib/bundle-factory/distribution/upc-burn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const reaped = await reapExpiredReservations();
  const poll = await runPollPending({ olderThanMinutes: 5, limit: 50 });

  return NextResponse.json({ reaped: reaped.reaped, poll });
}
