/**
 * GET /api/bundle-factory/uncrustables/candidates/[candidateId]
 *
 * Full candidate detail (all render/review/stage/submit fields) + its run
 * header + a `submission` block from the staged ChannelSKU.
 *
 * Live-status wiring (Phase A5): when the candidate is SUBMITTED with no ASIN
 * yet, this GET makes ONE lightweight, error-tolerant pass through the
 * existing poll path (pollSubmissionStatus + persistPollResult) and lifts the
 * candidate to LIVE with its ASIN once Amazon reports BUYABLE/DISCOVERABLE.
 * Poll failures never break the read — they surface as `poll_error`.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  persistPollResult,
  pollSubmissionStatus,
} from "@/lib/bundle-factory/distribution/status-poller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withErrorHandler(
  "uncrustables-candidate-detail",
  async (_request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
      where: { id: candidateId },
      include: { run: { select: { id: true, name: true, status: true } } },
    });
    if (!candidate) return notFound(`Candidate ${candidateId} not found`);

    // ---- lightweight live poll: only for SUBMITTED candidates without an
    // ASIN — one marketplace GET, fully error-tolerant.
    let pollError: string | null = null;
    let state = candidate.state;
    let asin = candidate.asin;
    if (state === "SUBMITTED" && !asin && candidate.channel_sku_id) {
      try {
        const skuRow = await prisma.channelSKU.findUnique({
          where: { id: candidate.channel_sku_id },
        });
        if (skuRow) {
          const polled = await pollSubmissionStatus(skuRow);
          await persistPollResult(polled);
          if (polled.new_listing_status === "LIVE" && polled.asin) {
            const lifted = await prisma.uncrustablesStudioCandidate.updateMany({
              where: { id: candidateId, state: "SUBMITTED" },
              data: { state: "LIVE", asin: polled.asin },
            });
            if (lifted.count === 1) {
              state = "LIVE";
              asin = polled.asin;
            }
          }
        }
      } catch (error) {
        pollError = error instanceof Error ? error.message : String(error);
      }
    }

    // ---- submission block from the staged ChannelSKU (post-prepare states).
    let submission: Record<string, unknown> | null = null;
    if (candidate.channel_sku_id) {
      const skuRow = await prisma.channelSKU.findUnique({
        where: { id: candidate.channel_sku_id },
        select: {
          id: true,
          sku: true,
          upc: true,
          price_cents: true,
          listing_status: true,
          lifecycle_status: true,
          submission_id: true,
          submitted_at: true,
          asin: true,
          live_url: true,
          last_status_check_at: true,
          distribution_errors: true,
        },
      });
      if (skuRow) {
        submission = {
          channel_sku_id: skuRow.id,
          sku: skuRow.sku,
          upc: skuRow.upc,
          price_cents: skuRow.price_cents,
          listing_status: skuRow.listing_status,
          lifecycle_status: skuRow.lifecycle_status,
          submission_id: skuRow.submission_id,
          submitted_at: skuRow.submitted_at,
          asin: skuRow.asin,
          live_url: skuRow.live_url,
          last_status_check_at: skuRow.last_status_check_at,
          distribution_errors: skuRow.distribution_errors
            ? safeParse(skuRow.distribution_errors)
            : null,
        };
      }
    }

    return NextResponse.json({
      ...candidate,
      state,
      asin,
      recipe: safeParse(candidate.recipe_json),
      bullets: safeParse(candidate.bullets_json),
      reference_urls_parsed: candidate.reference_urls ? safeParse(candidate.reference_urls) : null,
      submission,
      poll_error: pollError,
    });
  },
);

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
