/**
 * POST /api/bundle-factory/uncrustables/candidates/[candidateId]/approve
 * Body: { reviewer: string }
 *
 * The human APPROVE gate (RENDERED -> APPROVED). The server trusts NOTHING
 * from the client's screen: it re-downloads the exact main_image_url bytes
 * from R2, recomputes sha256 and PNG dimensions, and approves ONLY when the
 * hash equals the stored image_sha256 and both dimensions are >= 2000px.
 * Any mismatch returns 409 with the mismatch details. The final state write
 * is a CAS on (state=RENDERED, image_sha256) so a concurrent re-render can
 * never be approved with stale bytes.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { MIN_MAIN_DIMENSION_PX } from "@/lib/bundle-factory/uncrustables-render-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const pngSignature = "89504e470d0a1a0a";
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === pngSignature &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return null;
}

export const POST = withErrorHandler(
  "uncrustables-candidate-approve",
  async (request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const body = await readJson<{ reviewer?: string }>(request);
    const reviewer = body?.reviewer?.trim();
    if (!reviewer) return badRequest("reviewer is required");

    const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
      where: { id: candidateId },
      select: { id: true, state: true, main_image_url: true, image_sha256: true },
    });
    if (!candidate) return notFound(`Candidate ${candidateId} not found`);
    if (candidate.state !== "RENDERED") {
      return NextResponse.json(
        { error: `Cannot approve from state ${candidate.state}; only RENDERED` },
        { status: 409 },
      );
    }
    if (!candidate.main_image_url || !candidate.image_sha256) {
      return NextResponse.json(
        { error: "Candidate has no rendered image or stored sha256" },
        { status: 409 },
      );
    }

    // ---- server-side byte verification of the EXACT R2 object.
    let bytes: Buffer;
    try {
      const response = await fetch(candidate.main_image_url, {
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`R2 returned HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("empty response body");
    } catch (error) {
      return NextResponse.json(
        {
          error: "Failed to re-download image bytes for verification",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 409 },
      );
    }

    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    const dims = pngDimensions(bytes);
    if (actualSha256 !== candidate.image_sha256) {
      return NextResponse.json(
        {
          error: "Image bytes changed since render — sha256 mismatch",
          expected_sha256: candidate.image_sha256,
          actual_sha256: actualSha256,
        },
        { status: 409 },
      );
    }
    if (!dims) {
      return NextResponse.json(
        { error: "Downloaded bytes are not a PNG" },
        { status: 409 },
      );
    }
    if (dims.width < MIN_MAIN_DIMENSION_PX || dims.height < MIN_MAIN_DIMENSION_PX) {
      return NextResponse.json(
        {
          error: `Image is ${dims.width}x${dims.height}; production MAIN requires ${MIN_MAIN_DIMENSION_PX}px+`,
          width: dims.width,
          height: dims.height,
        },
        { status: 409 },
      );
    }

    // ---- CAS approval: state AND sha must still be exactly what we verified.
    const approved = await prisma.uncrustablesStudioCandidate.updateMany({
      where: {
        id: candidateId,
        state: "RENDERED",
        image_sha256: candidate.image_sha256,
      },
      data: {
        state: "APPROVED",
        reviewed_by: reviewer,
        reviewed_at: new Date(),
      },
    });
    if (approved.count !== 1) {
      return NextResponse.json(
        { error: "Candidate changed during verification — approval aborted" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      candidate_id: candidateId,
      state: "APPROVED",
      reviewed_by: reviewer,
      image_sha256: candidate.image_sha256,
      pixel_dimensions: dims,
    });
  },
);
