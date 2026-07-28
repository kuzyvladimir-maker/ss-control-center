/**
 * POST /api/bundle-factory/uncrustables/candidates/[candidateId]/prepare
 *
 * Phase A4 — APPROVED -> STAGED -> PROOFED (uncrustables-studio-integration-plan.md).
 *
 *   1. re-download the EXACT approved R2 bytes and verify sha256 against the
 *      stored image_sha256 (409 on drift, before any side effect);
 *   2. atomic CAS claim APPROVED -> STAGED (concurrent prepare loses -> 409);
 *   3. stageUncrustablesCandidate() with the REAL engine deps: donor rows,
 *      real compliance gate, real promoteDraftToChannelSkus (SKU + UPC mint),
 *      canonical ship-spec band, operator-declared inventory;
 *   4. archive the exact bytes + generation manifest under
 *      data/audits/uncrustables-studio/;
 *   5. mintCandidateProof() with the REAL reviewer/session/timestamps, then
 *      sealStudioOwnerApprovalManifest + registerSealedOwnerApprovalManifest
 *      (full union re-verification — fail closed);
 *   6. append-only UncrustablesOwnerApprovalManifestRecord row, then the
 *      final CAS STAGED -> PROOFED with all linkage columns.
 *
 * Any staging/minting failure lands in state FAILED with last_error and a
 * 422; the operator loops through rerender -> approve to retry.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  registerSealedOwnerApprovalManifest,
} from "@/lib/bundle-factory/audit/uncrustables-owner-approval-manifests";
import {
  mintCandidateProof,
  sealStudioOwnerApprovalManifest,
} from "@/lib/bundle-factory/audit/uncrustables-owner-approval-minting";
import { ensureStudioManifestRecordsRegistered } from "@/lib/bundle-factory/audit/uncrustables-studio-manifest-records";
import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import type { ComplianceInput } from "@/lib/bundle-factory/compliance/types";
import { donorUnitPriceCents } from "@/lib/bundle-factory/donor-dedup";
import { withVerifiedPhysicalPackageSpecs } from "@/lib/bundle-factory/physical-package-specs";
import {
  stageUncrustablesCandidate,
  type UncrustablesStagePrisma,
} from "@/lib/bundle-factory/uncrustables-stage";
import { parseStudioRecipeJson } from "@/lib/bundle-factory/uncrustables-studio-run";
import type { UncrustablesShipSpecBand } from "@/lib/bundle-factory/uncrustables-ship-specs";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { uploadBundleFactoryAuditObject } from "@/lib/bundle-factory/image-generation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Archive locators. Primary: content in R2 under studio-audit/ with public
 *  https URLs baked into the proof (isEvidenceLocator accepts https; the
 *  serverless filesystem is read-only, so repo paths cannot exist in prod).
 *  Fallback when R2 is unconfigured (bare local dev): repo-relative
 *  data/audits/uncrustables-studio/<slug>.* written to disk. */
const ARCHIVE_DIR = "data/audits/uncrustables-studio";
function archiveKey(slug: string, kind: "image" | "generation-manifest"): string {
  return `studio-audit/${slug}.${kind === "image" ? "png" : "generation-manifest.json"}`;
}
function localArchiveLocator(
  slug: string,
  kind: "image" | "generation-manifest",
): string {
  return `${ARCHIVE_DIR}/${slug}.${kind === "image" ? "png" : "generation-manifest.json"}`;
}

const WORKER_LABEL =
  "codex-image-worker (ChatGPT subscription image_gen on OpenClaw box)";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeParseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** Mark the claimed candidate FAILED with a stage-tagged error and 422. */
async function failCandidate(
  candidateId: string,
  stage: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<Response> {
  const lastError = `PREPARE ${stage}: ${message}`.slice(0, 1900);
  await prisma.uncrustablesStudioCandidate.updateMany({
    where: { id: candidateId },
    data: { state: "FAILED", last_error: lastError },
  });
  return NextResponse.json(
    { error: message, stage, state: "FAILED", ...(extra ?? {}) },
    { status: 422 },
  );
}

export const POST = withErrorHandler(
  "uncrustables-candidate-prepare",
  async (_request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
      where: { id: candidateId },
      include: { run: { select: { id: true, owner_order: true } } },
    });
    if (!candidate) return notFound(`Candidate ${candidateId} not found`);
    if (candidate.state !== "APPROVED") {
      return NextResponse.json(
        { error: `Cannot prepare from state ${candidate.state}; only APPROVED` },
        { status: 409 },
      );
    }
    if (!candidate.main_image_url || !candidate.image_sha256) {
      return NextResponse.json(
        { error: "Approved candidate is missing main_image_url or image_sha256" },
        { status: 409 },
      );
    }
    if (!candidate.reviewed_by || !candidate.reviewed_at) {
      return NextResponse.json(
        { error: "Approved candidate has no recorded reviewer/timestamp" },
        { status: 409 },
      );
    }

    // ---- recipe + bullets snapshots (fail loudly before any side effect).
    let recipe;
    try {
      recipe = parseStudioRecipeJson(candidate.recipe_json);
    } catch (error) {
      return NextResponse.json(
        {
          error: `recipe_json is malformed: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 409 },
      );
    }
    const bullets = safeParseStringArray(candidate.bullets_json);
    if (bullets.length === 0) {
      return NextResponse.json(
        { error: "bullets_json is empty or malformed" },
        { status: 409 },
      );
    }

    // ---- the sealed-manifest union must be loadable BEFORE registering a
    // new manifest, so cross-manifest proof_id/subject uniqueness includes
    // every previously persisted studio record after a cold start.
    await ensureStudioManifestRecordsRegistered(prisma);

    // ---- re-download the EXACT R2 bytes; the mint gate hashes what the
    // server read, never what the client saw. Drift -> 409, no side effects.
    let imageBytes: Buffer;
    try {
      const response = await fetch(candidate.main_image_url, {
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`R2 returned HTTP ${response.status}`);
      imageBytes = Buffer.from(await response.arrayBuffer());
      if (imageBytes.length === 0) throw new Error("empty response body");
    } catch (error) {
      return NextResponse.json(
        {
          error: "Failed to re-download the approved image bytes",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 409 },
      );
    }
    const actualSha256 = sha256Hex(imageBytes);
    if (actualSha256 !== candidate.image_sha256) {
      return NextResponse.json(
        {
          error: "Image bytes changed since approval — sha256 mismatch",
          expected_sha256: candidate.image_sha256,
          actual_sha256: actualSha256,
        },
        { status: 409 },
      );
    }

    // ---- CAS claim: APPROVED -> STAGED. A concurrent prepare loses here.
    const claim = await prisma.uncrustablesStudioCandidate.updateMany({
      where: {
        id: candidateId,
        state: "APPROVED",
        image_sha256: candidate.image_sha256,
      },
      data: { state: "STAGED", last_error: null },
    });
    if (claim.count !== 1) {
      return NextResponse.json(
        { error: "Candidate changed concurrently — prepare aborted" },
        { status: 409 },
      );
    }

    // ---- stage: job -> draft -> content -> REAL compliance gate ->
    // promote (SKU + UPC mint) -> canonical ship-spec band -> inventory.
    const stageResult = await stageUncrustablesCandidate(
      {
        slug: candidate.slug,
        title: candidate.title,
        bullets,
        description: candidate.description,
        mainImageUrl: candidate.main_image_url,
        packCount: candidate.pack_count,
        costCents: candidate.cost_cents,
        comps: recipe.comps.map((comp) => ({
          flavor: comp.flavor,
          qty: comp.qty,
          donor_title: comp.donor_title,
        })),
        briefSource: "uncrustables-studio",
        ownerOrder: candidate.run.owner_order,
        actor: "studio-prepare",
      },
      {
        prisma: prisma as unknown as UncrustablesStagePrisma,
        donorUnitPriceCents: (donor) =>
          donorUnitPriceCents(donor as Parameters<typeof donorUnitPriceCents>[0]),
        runComplianceGate: (payload, options) =>
          runComplianceGate(payload as ComplianceInput, options),
        promoteDraftToChannelSkus,
        withVerifiedPhysicalPackageSpecs: (existingSpec, band) =>
          withVerifiedPhysicalPackageSpecs(
            existingSpec as string | null,
            band as UncrustablesShipSpecBand,
          ),
      },
    );
    if (!stageResult.ok) {
      return failCandidate(candidateId, `STAGE_${stageResult.stage}`, stageResult.error, {
        draft_id: stageResult.draftId ?? null,
        blocked_rule_ids: stageResult.blockedRuleIds ?? [],
      });
    }
    if (stageResult.skus.length !== 1) {
      return failCandidate(
        candidateId,
        "STAGE_PROMOTE",
        `expected exactly one staged ChannelSKU, got ${stageResult.skus.length}`,
        { draft_id: stageResult.draftId },
      );
    }
    const staged = stageResult.skus[0];

    // Persist the stage linkage immediately so a later failure still leaves a
    // debuggable trail (state stays STAGED until the final PROOFED CAS).
    await prisma.uncrustablesStudioCandidate.update({
      where: { id: candidateId },
      data: {
        draft_id: stageResult.draftId,
        master_bundle_id: stageResult.masterBundleId,
        channel_sku_id: staged.channel_sku_id,
        sku: staged.sku,
      },
    });

    // ---- archive the exact PNG copy BEFORE minting so the proof's image
    // locator points at content that already exists. Primary: R2 (works on
    // the read-only serverless filesystem). R2 unconfigured → repo-relative
    // local locators, written after mint.
    let imageArchiveUrl: string | null = null;
    try {
      imageArchiveUrl = await uploadBundleFactoryAuditObject(
        archiveKey(candidate.slug, "image"),
        imageBytes,
        "image/png",
      );
    } catch (error) {
      return failCandidate(
        candidateId,
        "ARCHIVE",
        `failed to upload audit copy to R2: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const archiveBase = imageArchiveUrl
      ? imageArchiveUrl.slice(0, -(archiveKey(candidate.slug, "image").length + 1))
      : null;
    const archiveLocatorFor = (
      slug: string,
      kind: "image" | "generation-manifest",
    ): string =>
      archiveBase
        ? `${archiveBase}/${archiveKey(slug, kind)}`
        : localArchiveLocator(slug, kind);

    // ---- mint the owner-approval proof from the verified bytes with the
    // REAL reviewer identity and the REAL observe/approve timestamps.
    const reviewedAt = candidate.reviewed_at;
    let minted;
    try {
      minted = mintCandidateProof(
        {
          slug: candidate.slug,
          sku: staged.sku,
          mainImageUrl: candidate.main_image_url,
          imageBytes,
          prompt: candidate.prompt,
          referenceUrls: safeParseStringArray(candidate.reference_urls),
          renderScript: "studio",
          workerLabel: WORKER_LABEL,
          comps: recipe.comps.map((comp) => ({
            flavor: comp.flavor,
            qty: comp.qty,
            box_size: comp.box_size,
            box_count: comp.box_count,
          })),
          observedAt: reviewedAt,
          approvedAt: reviewedAt,
          reviewNotes:
            `Studio review gate: reviewer ${candidate.reviewed_by} confirmed all 11 checklist items on the ` +
            `zoomable 2048px surface against the expected-carton table and donor reference art; the server ` +
            `re-downloaded the exact R2 bytes and verified sha256 ${candidate.image_sha256.slice(0, 12)}… ` +
            `plus 2000px+ dimensions at approval and again at prepare.`,
          approvalNotes:
            `Approved in the Uncrustables Studio review gate (run ${candidate.run.id}) under the owner order: ` +
            `${candidate.run.owner_order}`,
        },
        { reviewer: candidate.reviewed_by, session: candidate.run.id },
        archiveLocatorFor,
      );
    } catch (error) {
      return failCandidate(
        candidateId,
        "MINT",
        error instanceof Error ? error.message : String(error),
      );
    }

    // ---- archive the exact generation-manifest text the lib hashed at the
    // locator baked into the proof. R2 path: upload to the deterministic key
    // (the PNG copy went up before minting). Local-FS path (R2 unconfigured):
    // both files must land on disk. R2 failures fail closed — a proof must
    // never reference a locator that holds nothing.
    try {
      if (imageArchiveUrl) {
        const manifestUrl = await uploadBundleFactoryAuditObject(
          archiveKey(candidate.slug, "generation-manifest"),
          minted.generationManifest.text,
          "application/json",
        );
        if (manifestUrl !== archiveLocatorFor(candidate.slug, "generation-manifest")) {
          throw new Error("generation-manifest archive URL drifted from the proof locator");
        }
      } else {
        const archiveRoot = path.join(process.cwd(), ARCHIVE_DIR);
        await mkdir(archiveRoot, { recursive: true });
        await writeFile(
          path.join(process.cwd(), localArchiveLocator(candidate.slug, "image")),
          imageBytes,
        );
        await writeFile(
          path.join(process.cwd(), localArchiveLocator(candidate.slug, "generation-manifest")),
          minted.generationManifest.text,
          "utf8",
        );
      }
    } catch (error) {
      return failCandidate(
        candidateId,
        "ARCHIVE",
        `failed to write audit archive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ---- seal + register. Registration re-verifies the WHOLE union with
    // this manifest included; a throw means nothing is persisted (no DB row).
    const manifestId = `uncrustables-studio-${candidate.run.id}-${candidateId}`;
    const capturedAt = new Date();
    let manifest;
    try {
      manifest = sealStudioOwnerApprovalManifest({
        manifestId,
        capturedAt,
        approvedBy: candidate.reviewed_by,
        entries: [minted.proof],
      });
      registerSealedOwnerApprovalManifest(manifest);
    } catch (error) {
      return failCandidate(
        candidateId,
        "SEAL_REGISTER",
        error instanceof Error ? error.message : String(error),
      );
    }

    // ---- append-only DB record (never updated or deleted) + final CAS.
    let recordId: string;
    try {
      const record = await prisma.uncrustablesOwnerApprovalManifestRecord.create({
        data: {
          manifest_id: manifest.manifest_id,
          sha256: manifest.sha256,
          body_json: JSON.stringify(manifest),
          entry_count: manifest.entries.length,
          approved_by: manifest.approved_by,
          captured_at: capturedAt,
        },
        select: { id: true },
      });
      recordId = record.id;
    } catch (error) {
      return failCandidate(
        candidateId,
        "MANIFEST_RECORD",
        `failed to persist the sealed manifest record: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { manifest_id: manifestId, manifest_sha256: manifest.sha256 },
      );
    }

    const proofed = await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: candidateId, state: "STAGED" },
      data: {
        state: "PROOFED",
        proof_id: minted.proof.proof_id,
        manifest_record_id: recordId,
        last_error: null,
      },
    });
    if (proofed.count !== 1) {
      return NextResponse.json(
        {
          error: "Candidate left STAGED during proofing — record persisted, state not advanced",
          manifest_record_id: recordId,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      candidate_id: candidateId,
      state: "PROOFED",
      draft_id: stageResult.draftId,
      master_bundle_id: stageResult.masterBundleId,
      channel_sku_id: staged.channel_sku_id,
      sku: staged.sku,
      upc: staged.upc,
      price_cents: staged.price_cents,
      proof_id: minted.proof.proof_id,
      manifest_id: manifest.manifest_id,
      manifest_sha256: manifest.sha256,
      manifest_record_id: recordId,
      image_sha256: minted.imageSha256,
      pixel_dimensions: minted.pixelDimensions,
      archived: {
        image: archiveLocatorFor(candidate.slug, "image"),
        generation_manifest: archiveLocatorFor(candidate.slug, "generation-manifest"),
      },
    });
  },
);
