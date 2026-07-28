/**
 * Uncrustables Studio — review gate (human APPROVE / REJECT).
 *
 * Server shell: loads the candidate with its parsed recipe and hands the
 * data to the client review surface (zoomable 2048px image, expected-carton
 * table, the 11-point checklist). Approve is server-verified: the API
 * re-downloads the exact R2 bytes and re-checks sha256 + dimensions.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import type { StudioRecipeJson } from "@/lib/bundle-factory/uncrustables-studio-run";
import { ReviewClient } from "./ReviewClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ runId: string; candidateId: string }>;
}

export default async function UncrustablesReviewPage({ params }: PageProps) {
  const { runId, candidateId } = await params;
  const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
    where: { id: candidateId },
    include: { run: { select: { id: true, name: true } } },
  });
  if (!candidate || candidate.run_id !== runId) return notFound();

  let recipe: StudioRecipeJson | null = null;
  let bullets: string[] = [];
  try {
    recipe = JSON.parse(candidate.recipe_json) as StudioRecipeJson;
    bullets = JSON.parse(candidate.bullets_json) as string[];
  } catch {
    // Malformed rows still render the shell; the client shows what exists.
  }

  return (
    <>
      <PageHead
        title={`Review ${candidate.slug}`}
        subtitle={
          <>
            <Link
              href={`/bundle-factory/uncrustables/${runId}`}
              className="underline-offset-2 hover:underline"
            >
              {candidate.run.name}
            </Link>
            <Sep />
            <span>state {candidate.state}</span>
            <Sep />
            <span className="font-mono tabular-nums">
              attempts {candidate.render_attempts}
            </span>
          </>
        }
      />
      <ReviewClient
        candidate={{
          id: candidate.id,
          run_id: runId,
          slug: candidate.slug,
          state: candidate.state,
          title: candidate.title,
          bullets,
          description: candidate.description,
          recipe,
          price_cents: candidate.price_cents,
          pack_count: candidate.pack_count,
          main_image_url: candidate.main_image_url,
          image_sha256: candidate.image_sha256,
          pixel_width: candidate.pixel_width,
          pixel_height: candidate.pixel_height,
          reviewed_by: candidate.reviewed_by,
          reject_reason: candidate.reject_reason,
          last_error: candidate.last_error,
          sku: candidate.sku,
          proof_id: candidate.proof_id,
          submission_id: candidate.submission_id,
          asin: candidate.asin,
        }}
      />
    </>
  );
}
