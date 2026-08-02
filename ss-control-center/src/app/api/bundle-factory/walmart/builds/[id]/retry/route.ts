/**
 * Re-queue the failed listings of a Walmart studio build.
 *
 * The engine already retries a work item three times on its own; after that it
 * is FAILED for good and the only way back was editing the row by hand. That
 * is not a tool an operator has. This resets exactly the FAILED items of one
 * build to PENDING with a fresh attempt budget and lets the normal tick pick
 * them up again.
 *
 * This lane reads Product Truth, composes an image and writes an internal
 * draft. It holds no Walmart client, reserves no UPC and cannot mutate a
 * marketplace, so re-running a failed item is not a repeat of an unknown POST.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW,
} from "@/lib/bundle-factory/walmart-durable-build";
import { prisma } from "@/lib/prisma";

const WALMART_STUDIO_WORKFLOWS = new Set([
  "CANONICAL_WALMART_NEW_SKU",
  WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW,
]);

export const POST = withErrorHandler(
  "bundle-factory-walmart-build-retry",
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const { id } = await context.params;
    const job = await prisma.generationJob.findUnique({
      where: { id },
      select: { id: true, brief: true, bundles_target: true },
    });
    if (!job) {
      return NextResponse.json({ error: "Build not found" }, { status: 404 });
    }
    let workflow: unknown = null;
    try {
      workflow = (JSON.parse(job.brief) as { workflow?: unknown }).workflow;
    } catch {
      workflow = null;
    }
    if (typeof workflow !== "string" || !WALMART_STUDIO_WORKFLOWS.has(workflow)) {
      return NextResponse.json(
        { error: "This build is not a Walmart studio build." },
        { status: 422 },
      );
    }

    const failed = await prisma.generationWorkItem.findMany({
      where: { generation_job_id: job.id, status: "FAILED" },
      select: { id: true, spec_index: true, last_error: true },
      orderBy: { spec_index: "asc" },
    });
    if (failed.length === 0) {
      return NextResponse.json(
        { ok: true, requeued: 0, note: "Nothing in this build has failed." },
      );
    }
    // attempts goes back to 0 so the engine's own three-strike budget applies
    // to the new run rather than being already spent.
    const requeued = await prisma.generationWorkItem.updateMany({
      where: { generation_job_id: job.id, status: "FAILED" },
      data: { status: "PENDING", attempts: 0, locked_at: null },
    });
    await prisma.generationJob.update({
      where: { id: job.id },
      data: {
        status: "IN_PROGRESS",
        current_stage: "WALMART_DRAFT_GENERATION",
        bundles_error: 0,
        completed_at: null,
      },
    });
    return NextResponse.json({
      ok: true,
      requeued: requeued.count,
      items: failed.map((item) => ({
        spec_index: item.spec_index,
        previous_error: item.last_error,
      })),
    });
  },
);
