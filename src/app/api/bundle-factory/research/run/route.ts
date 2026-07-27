/**
 * POST /api/bundle-factory/research/run
 *      Body: { bundle_draft_id, trigger? }
 *
 * Kicks off Stage 2 (Research) for a BundleDraft. Runs synchronously
 * inside the request — Perplexity round-trip is ~10–30s, R2 mirror adds
 * another 2–5s. The route declares `maxDuration = 120` so Vercel allows
 * it. When concurrency matters (Phase 5+) this moves behind a job queue.
 *
 * Returns 200 on success with pool_size + duration_ms + citations, or
 * 500 with the error message on failure. The orchestrator captures the
 * raw Perplexity response into `GenerationStage.error` so the UI can
 * surface a useful diagnostic.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runResearch } from "@/lib/bundle-factory/research-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Body = { bundle_draft_id?: string; trigger?: string; actor?: string };

export const POST = withErrorHandler(
  "research/run[POST]",
  async (request: Request) => {
    const body = await readJson<Body>(request);
    if (!body?.bundle_draft_id) {
      return badRequest("bundle_draft_id is required");
    }

    const trigger =
      body.trigger === "auto" ? "auto" : ("manual" as const);

    const result = await runResearch({
      bundle_draft_id: body.bundle_draft_id,
      trigger,
      actor: body.actor ?? "user",
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error ?? "research_failed",
          generation_job_id: result.generation_job_id,
          duration_ms: result.duration_ms,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      generation_job_id: result.generation_job_id,
      pool_size: result.pool_size,
      duration_ms: result.duration_ms,
      citations: result.citations,
      mocked: result.mocked,
      mirror_summary: result.mirror_summary,
    });
  },
);
