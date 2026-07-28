/**
 * POST /api/bundle-factory/uncrustables/candidates/[candidateId]/submit
 * Body: { mode: "dry_run" | "live", confirm?: string }
 *
 * Phase A5 — PROOFED -> SUBMITTED (uncrustables-studio-integration-plan.md).
 *
 * Submit chain: the DIRECT PROVEN conveyor from scripts/_publish_batch12_submit.ts
 * (verified on the 22 live listings + the trial SKUs), imported from the real
 * libs — NOT copied:
 *   preflightProductionUncrustablesMain (exact R2 bytes vs the sealed
 *   owner-approval union, emits the sealed publish permit)
 *   -> verifyUncrustablesMainPublishPermit
 *   -> submitToAmazon (full blast-door chain: physical-spec byte match,
 *      verified allergens, canonical count/price, permit re-verification,
 *      fresh inventory, mandatory VALIDATION_PREVIEW before the real PUT).
 *
 * runDistribution() was considered per план решение 3 but cannot run a studio
 * draft end-to-end without engine edits: it fails closed on
 * validation_status !== "PASSED" and draft.approved_at (Stage-6
 * runValidationForDraft × Uncrustables drafts is the unproven combination the
 * plan flags as risk 1 — the proven script conveyor deliberately bypassed it),
 * so the plan's sanctioned fallback — the proven direct chain behind the SAME
 * authenticity gates — is used instead.
 *
 * dry_run returns a readable payload preview with ZERO marketplace calls and
 * ZERO state changes. live requires the typed confirmation string
 * "PUBLISH <sku>" (defense in depth behind the UI gate — no auto-publish).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  notFound,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { amazonAllergensFromStoredDeclarations } from "@/lib/bundle-factory/allergen-declaration";
import {
  preflightProductionUncrustablesMain,
  verifyUncrustablesMainPublishPermit,
} from "@/lib/bundle-factory/audit/uncrustables-main-production-preflight";
import { ensureStudioManifestRecordsRegistered } from "@/lib/bundle-factory/audit/uncrustables-studio-manifest-records";
import { channelTarget } from "@/lib/bundle-factory/distribution/account-map";
import { submitToAmazon } from "@/lib/bundle-factory/distribution/amazon-publish";
import { parseVerifiedPhysicalPackageSpecs } from "@/lib/bundle-factory/physical-package-specs";
import { parseStudioRecipeJson } from "@/lib/bundle-factory/uncrustables-studio-run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PRODUCT_TYPE = "GROCERY";
const LISTING_BRAND = "Uncrustables";
const DEFAULT_DECLARED_QTY = 10;

export const POST = withErrorHandler(
  "uncrustables-candidate-submit",
  async (request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const body = await readJson<{ mode?: string; confirm?: string }>(request);
    const mode = body?.mode;
    if (mode !== "dry_run" && mode !== "live") {
      return badRequest('mode must be "dry_run" or "live"');
    }

    const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
      where: { id: candidateId },
      include: { run: { select: { id: true, owner_order: true } } },
    });
    if (!candidate) return notFound(`Candidate ${candidateId} not found`);
    if (candidate.state !== "PROOFED") {
      return NextResponse.json(
        { error: `Cannot submit from state ${candidate.state}; only PROOFED` },
        { status: 409 },
      );
    }
    if (!candidate.channel_sku_id || !candidate.sku || !candidate.main_image_url) {
      return NextResponse.json(
        { error: "Proofed candidate is missing channel_sku_id, sku or main_image_url" },
        { status: 409 },
      );
    }

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

    // The union must include every sealed studio DB manifest (cold-start
    // safe) BEFORE the preflight looks for this SKU's proof.
    await ensureStudioManifestRecordsRegistered(prisma);

    const sku = await prisma.channelSKU.findUnique({
      where: { id: candidate.channel_sku_id },
    });
    if (!sku) {
      return NextResponse.json(
        { error: `Staged ChannelSKU ${candidate.channel_sku_id} no longer exists` },
        { status: 409 },
      );
    }
    if (sku.sku !== candidate.sku) {
      return NextResponse.json(
        { error: `ChannelSKU code drifted: candidate ${candidate.sku}, row ${sku.sku}` },
        { status: 409 },
      );
    }
    if (sku.main_image_url !== candidate.main_image_url) {
      return NextResponse.json(
        {
          error: "ChannelSKU main_image_url drifted from the approved candidate image",
          candidate_main_image_url: candidate.main_image_url,
          channel_sku_main_image_url: sku.main_image_url,
        },
        { status: 409 },
      );
    }
    const target = channelTarget(sku.channel);
    if (target.kind !== "amazon" || target.skipReason) {
      return NextResponse.json(
        {
          error: `Channel ${sku.channel} is not an eligible Amazon target`,
          skip_reason: target.skipReason ?? null,
        },
        { status: 422 },
      );
    }

    const masterBundle = await prisma.masterBundle.findUnique({
      where: { id: sku.master_bundle_id },
      select: {
        category: true,
        brand: true,
        pack_count: true,
        packaging_spec: true,
        components: { select: { allergens: true } },
      },
    });
    if (!masterBundle) {
      return NextResponse.json(
        { error: `MasterBundle ${sku.master_bundle_id} not found` },
        { status: 409 },
      );
    }
    const physicalPackageSpecs = parseVerifiedPhysicalPackageSpecs(
      masterBundle.packaging_spec,
    );
    if (!physicalPackageSpecs) {
      return NextResponse.json(
        { error: "MasterBundle has no verified physical package specs" },
        { status: 422 },
      );
    }
    let verifiedAllergens: string[];
    try {
      verifiedAllergens = amazonAllergensFromStoredDeclarations(
        masterBundle.components.map((component) => component.allergens),
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: `Stored allergen declarations are invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        { status: 422 },
      );
    }

    // ---- the SAME gate the proven conveyor runs: exact R2 bytes vs the
    // sealed owner-approval union -> sealed publish permit (fail closed).
    const preflight = await preflightProductionUncrustablesMain({
      sku: sku.sku,
      main_image_url: sku.main_image_url ?? "",
      pack_count: candidate.pack_count,
      components: recipe.comps.map((comp) => ({
        product_name: comp.flavor,
        flavor: comp.flavor,
        qty: comp.qty,
      })),
    });
    if (!preflight.pass || !preflight.permit) {
      return NextResponse.json(
        {
          error: "Uncrustables MAIN authenticity preflight BLOCKED",
          decision: preflight.decision,
          findings: preflight.findings,
        },
        { status: 422 },
      );
    }
    const permit = preflight.permit;

    if (mode === "dry_run") {
      // Full preview, ZERO Amazon calls, ZERO state changes.
      return NextResponse.json({
        mode: "dry_run",
        decision: "CAN_PUBLISH",
        candidate_id: candidateId,
        state: candidate.state,
        preview: {
          channel: sku.channel,
          store_index: target.storeIndex,
          product_type: PRODUCT_TYPE,
          brand: LISTING_BRAND,
          category: masterBundle.category ?? "FROZEN_GROCERY",
          sku: sku.sku,
          upc: sku.upc,
          title: candidate.title,
          bullets: safeParseArray(candidate.bullets_json),
          description: candidate.description,
          price_cents: candidate.price_cents,
          pricing: recipe.pricing ?? null,
          pack_count: candidate.pack_count,
          components: recipe.comps.map((comp) => ({
            flavor: comp.flavor,
            qty: comp.qty,
            box_size: comp.box_size,
            box_count: comp.box_count,
          })),
          ship_specs: {
            length_in: physicalPackageSpecs.length_in,
            width_in: physicalPackageSpecs.width_in,
            height_in: physicalPackageSpecs.height_in,
            weight_oz: physicalPackageSpecs.weight_oz,
          },
          allergens: verifiedAllergens,
          main_image_url: sku.main_image_url,
          image_sha256: preflight.image_sha256 ?? null,
          available_quantity: sku.available_quantity,
          permit: {
            proof_id: permit.proof_id,
            permit_sha256_prefix: permit.sha256.slice(0, 16),
            main_image_sha256_prefix: permit.main_image_sha256.slice(0, 16),
            owner_approval_manifest_sha256_prefix:
              permit.owner_approval_manifest_sha256.slice(0, 16),
            registry_sha256_prefix: permit.registry_sha256.slice(0, 16),
            approved_subject_sha256_prefix:
              permit.approved_subject_sha256.slice(0, 16),
          },
          note: "Live submit refreshes the operator-declared inventory stamp and runs Amazon VALIDATION_PREVIEW before the real PUT.",
        },
      });
    }

    // ---- live: typed confirmation is required (no auto-publish, ever).
    const expectedConfirmation = `PUBLISH ${candidate.sku}`;
    if (body?.confirm !== expectedConfirmation) {
      return badRequest(
        `Live publish requires the typed confirmation string "${expectedConfirmation}"`,
      );
    }

    // Final permit verification at the app boundary (submitToAmazon repeats
    // it independently as the last blast door).
    const permitCheck = verifyUncrustablesMainPublishPermit(permit, {
      sku: sku.sku,
      main_image_url: sku.main_image_url ?? "",
      pack_count: candidate.pack_count,
    });
    if (!permitCheck.valid) {
      return NextResponse.json(
        { error: `Publish permit verification failed: ${permitCheck.error}` },
        { status: 422 },
      );
    }

    // Refresh the operator-declared inventory stamp (15-minute freshness
    // gate) exactly like the proven conveyor, then submit the FRESH row.
    await prisma.channelSKU.update({
      where: { id: sku.id },
      data: {
        available_quantity:
          sku.available_quantity && sku.available_quantity > 0
            ? sku.available_quantity
            : DEFAULT_DECLARED_QTY,
        inventory_checked_at: new Date(),
      },
    });
    const freshSku = await prisma.channelSKU.findUniqueOrThrow({
      where: { id: sku.id },
    });

    const result = await submitToAmazon({
      sku: freshSku,
      storeIndex: target.storeIndex,
      productType: PRODUCT_TYPE,
      brand: LISTING_BRAND,
      category: masterBundle.category ?? "FROZEN_GROCERY",
      dryRun: false,
      physicalPackageSpecs,
      verifiedAllergens,
      uncrustablesMainPermit: permit,
    });

    if (!result.ok) {
      // Keep PROOFED; surface the marketplace error for the operator.
      const issueText = result.issues
        .map((issue) => `${issue.severity ?? "?"}:${issue.code ?? "?"} ${issue.message ?? ""}`)
        .join(" | ");
      const message = result.error ?? (issueText || "Amazon submission failed");
      await prisma.uncrustablesStudioCandidate.updateMany({
        where: { id: candidateId, state: "PROOFED" },
        data: { last_error: `SUBMIT: ${message}`.slice(0, 1900) },
      });
      return NextResponse.json(
        {
          error: message,
          amazon_status: result.amazon_status,
          issues: result.issues,
          state: "PROOFED",
        },
        { status: 502 },
      );
    }

    // Mirror the pipeline's persistence contract on the ChannelSKU row so the
    // existing poll path can lift it to LIVE later.
    await prisma.channelSKU.update({
      where: { id: sku.id },
      data: {
        listing_status: "SUBMITTED",
        lifecycle_status: "SUBMITTED",
        submission_id: result.submission_id ?? null,
        submitted_at: new Date(),
        last_status_check_at: new Date(),
        distribution_attempt_count: { increment: 1 },
        distribution_errors: result.issues.length
          ? JSON.stringify(result.issues)
          : null,
      },
    });
    const advanced = await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: candidateId, state: "PROOFED" },
      data: {
        state: "SUBMITTED",
        submission_id: result.submission_id ?? null,
        last_error: null,
      },
    });

    return NextResponse.json({
      mode: "live",
      candidate_id: candidateId,
      state: advanced.count === 1 ? "SUBMITTED" : candidate.state,
      state_conflict: advanced.count !== 1,
      sku: sku.sku,
      submission_id: result.submission_id,
      amazon_status: result.amazon_status,
      issues: result.issues,
    });
  },
);

function safeParseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
