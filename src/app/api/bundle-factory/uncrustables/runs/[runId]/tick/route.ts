/**
 * POST /api/bundle-factory/uncrustables/runs/[runId]/tick
 *
 * Advances the run by AT MOST ONE render. The client polls this while any
 * candidate sits in PLANNED / RENDER_QUEUED:
 *
 *   1. claim ONE candidate via an atomic CAS updateMany (state -> RENDERING;
 *      count === 1 or the claim is lost to a concurrent tick);
 *   2. re-resolve donors, build the frozen base prompt + PROVEN contract;
 *   3. renderUncrustablesMainCandidate (render + immediate sha256/dims
 *      postcheck of the exact R2 bytes);
 *   4. success  -> RENDERED with image fields;
 *      failure  -> RENDER_QUEUED while attempts < 8, else FAILED.
 *
 * A render on the subscription worker takes 1-3 minutes, so maxDuration is
 * the 300s platform ceiling and each tick renders exactly one candidate.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { renderUncrustablesMainCandidate } from "@/lib/bundle-factory/uncrustables-render-runner";
import {
  buildStudioCandidatePrompt,
  loadUncrustablesDonorPool,
  parseStudioRecipeJson,
  resolveStudioComps,
} from "@/lib/bundle-factory/uncrustables-studio-run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_RENDER_ATTEMPTS = 8;
const CLAIMABLE_STATES = ["PLANNED", "RENDER_QUEUED"] as const;
const STUDIO_R2_PREFIX = "studio";

export const POST = withErrorHandler(
  "uncrustables-run-tick",
  async (_request: Request, ctx: { params: Promise<{ runId: string }> }) => {
    const { runId } = await ctx.params;
    const run = await prisma.uncrustablesStudioRun.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!run) return notFound(`Run ${runId} not found`);

    // Pick the oldest claimable candidate, then claim it with a CAS update on
    // its EXACT previous state. count !== 1 means a concurrent tick won.
    const next = await prisma.uncrustablesStudioCandidate.findFirst({
      where: { run_id: runId, state: { in: [...CLAIMABLE_STATES] } },
      orderBy: { created_at: "asc" },
      select: { id: true, slug: true, state: true, title: true, recipe_json: true, render_attempts: true },
    });
    if (!next) {
      return NextResponse.json({ claimed: false, reason: "no claimable candidate" });
    }
    const claim = await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: next.id, state: next.state },
      data: { state: "RENDERING" },
    });
    if (claim.count !== 1) {
      return NextResponse.json({ claimed: false, reason: "lost claim race" });
    }

    const attempts = next.render_attempts + 1;

    // ---- prompt assembly (donor resolver + frozen contract). A failure here
    // consumes an attempt exactly like a render failure: donor pools and the
    // registry can heal between ticks, but a hard cap of 8 still applies.
    let prompt: string;
    let referenceUrls: string[];
    try {
      const recipe = parseStudioRecipeJson(next.recipe_json);
      const donors = await loadUncrustablesDonorPool();
      const resolved = resolveStudioComps(
        recipe.comps.map((c) => ({ flavor: c.flavor, qty: c.qty })),
        donors,
      );
      if (resolved.errors.length) {
        throw new Error(`donor/art resolution failed: ${resolved.errors.join("; ")}`);
      }
      // Refresh the snapshot with the donors actually used for this render so
      // the review page always describes the rendered image.
      const freshRecipe = { ...recipe, comps: resolved.snapshots };
      const built = buildStudioCandidatePrompt({ title: next.title, recipe: freshRecipe });
      prompt = built.prompt;
      referenceUrls = built.referenceUrls;
      await prisma.uncrustablesStudioCandidate.update({
        where: { id: next.id },
        data: {
          recipe_json: JSON.stringify(freshRecipe),
          prompt,
          reference_urls: JSON.stringify(referenceUrls),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = attempts < MAX_RENDER_ATTEMPTS ? "RENDER_QUEUED" : "FAILED";
      await prisma.uncrustablesStudioCandidate.update({
        where: { id: next.id },
        data: { state, render_attempts: attempts, last_error: `PROMPT: ${message}` },
      });
      return NextResponse.json({
        claimed: true,
        candidate_id: next.id,
        slug: next.slug,
        state,
        render_attempts: attempts,
        error: message,
      });
    }

    // ---- one render + immediate byte postcheck (sha256 + dims >= 2000px).
    const result = await renderUncrustablesMainCandidate({
      slug: next.slug,
      prompt,
      referenceUrls,
      r2Prefix: STUDIO_R2_PREFIX,
    });

    if (result.ok) {
      await prisma.uncrustablesStudioCandidate.update({
        where: { id: next.id },
        data: {
          state: "RENDERED",
          render_attempts: attempts,
          main_image_url: result.imageUrl,
          image_sha256: result.imageSha256,
          pixel_width: result.pixelDimensions.width,
          pixel_height: result.pixelDimensions.height,
          last_error: null,
        },
      });
      return NextResponse.json({
        claimed: true,
        candidate_id: next.id,
        slug: next.slug,
        state: "RENDERED",
        render_attempts: attempts,
        image_url: result.imageUrl,
        image_sha256: result.imageSha256,
        pixel_dimensions: result.pixelDimensions,
        duration_ms: result.durationMs,
      });
    }

    const state = attempts < MAX_RENDER_ATTEMPTS ? "RENDER_QUEUED" : "FAILED";
    await prisma.uncrustablesStudioCandidate.update({
      where: { id: next.id },
      data: {
        state,
        render_attempts: attempts,
        last_error: `${result.code}: ${result.error}`,
      },
    });
    return NextResponse.json({
      claimed: true,
      candidate_id: next.id,
      slug: next.slug,
      state,
      render_attempts: attempts,
      error: `${result.code}: ${result.error}`,
      duration_ms: result.durationMs,
    });
  },
);
