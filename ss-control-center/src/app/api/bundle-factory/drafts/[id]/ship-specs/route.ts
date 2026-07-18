/**
 * POST /api/bundle-factory/drafts/[id]/ship-specs
 *      Body: { weight_oz: number; length_in: number; width_in: number; height_in: number }
 *
 * Manual ship-specs entry (Phase-2 scaffold). The validators
 * `validator-weight` + `validator-packaging-dims` hard-FAIL a ChannelSKU
 * whose package weight / dimensions are unset — and the factory has no
 * algorithm to derive them yet (deferred). Until then the operator types one
 * weight + L×W×H for the bundle here, and we write it onto every ChannelSKU of
 * the draft so validation can reach PASSED → Publish.
 *
 * The retail PRICE is NOT entered here — it is set automatically by the
 * pricing model in promote-draft (see pricing-config.ts).
 *
 * Idempotently promotes the draft to ChannelSKUs first (same call the validate
 * route makes), so the operator can enter specs straight after generation
 * without a separate validate round-trip.
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { withVerifiedPhysicalPackageSpecs } from "@/lib/bundle-factory/physical-package-specs";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  weight_oz?: unknown;
  length_in?: unknown;
  width_in?: unknown;
  height_in?: unknown;
}

/** Positive finite number, capped to a sane carrier maximum. */
function posNum(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

export const POST = withErrorHandler(
  "drafts[id]/ship-specs[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson<Body>(request)) ?? {};

    const weight_oz = posNum(body.weight_oz, 70 * 16); // ≤ ~70 lb
    const length_in = posNum(body.length_in, 108); // carrier max dimension
    const width_in = posNum(body.width_in, 108);
    const height_in = posNum(body.height_in, 108);

    if (weight_oz == null)
      return badRequest("weight_oz must be a positive number (oz, ≤ 1120).");
    if (length_in == null || width_in == null || height_in == null)
      return badRequest("length_in, width_in, height_in must be positive numbers (in, ≤ 108).");

    // Ensure the draft has ChannelSKU rows to write onto (no-op if it already
    // does). Mirrors the validate route's lazy promotion.
    const promote = await promoteDraftToChannelSkus(id);

    const draft = await prisma.bundleDraft.findUnique({
      where: { id },
      select: { master_bundle_id: true },
    });
    if (!draft?.master_bundle_id) {
      return NextResponse.json(
        {
          ok: false,
          updated: 0,
          note:
            "Draft has no ChannelSKUs yet — generate content + image (CAN_PUBLISH) before entering ship specs.",
          promote,
        },
        { status: 200 },
      );
    }
    const master = await prisma.masterBundle.findUniqueOrThrow({
      where: { id: draft.master_bundle_id },
      select: { packaging_spec: true },
    });

    // Record the operator-entered measurements as explicit provenance on the
    // MasterBundle. Future marketplace payloads require this exact proof and
    // refuse calculated cooler weights/dimensions.
    const packagingSpec = withVerifiedPhysicalPackageSpecs(
      master.packaging_spec,
      {
        weight_oz,
        length_in,
        width_in,
        height_in,
      },
    );
    const res = await prisma.$transaction(async (tx) => {
      const updated = await tx.channelSKU.updateMany({
        where: { master_bundle_id: draft.master_bundle_id! },
        data: {
          package_weight_oz: weight_oz,
          package_length_in: length_in,
          package_width_in: width_in,
          package_height_in: height_in,
        },
      });
      await tx.masterBundle.update({
        where: { id: draft.master_bundle_id! },
        data: {
          total_weight_oz: weight_oz,
          packaging_spec: packagingSpec,
        },
      });
      return updated;
    });

    // Weight can change cooler size and therefore packaging, label, floor, and
    // selling price. Re-run the canonical promotion calculation after the
    // weight write so preview, MasterBundle, ChannelSKU, and price bands stay
    // on one formula. This also leaves validation PENDING for an honest re-run.
    const repriced = await promoteDraftToChannelSkus(id);

    return NextResponse.json({
      ok: true,
      updated: res.count,
      specs: { weight_oz, length_in, width_in, height_in },
      promote,
      repriced,
    });
  },
);
