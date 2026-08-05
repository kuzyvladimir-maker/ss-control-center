/**
 * Give a stuck listing a fresh UPC, from the interface.
 *
 * Walmart answers `ERR_EXT_DATA_0101119` when the product ID already exists in
 * its catalog under different details. The poller quarantines that number —
 * correct, it can never be used again — but a UPC is only assigned when the
 * ChannelSKU is created, so the listing kept pointing at a dead number and no
 * amount of pressing Publish could ever work. The only cure lived in a script,
 * which is not a tool an operator has.
 *
 * Deliberately limited to ONE rotation per listing. On 2026-08-05 the same SKU
 * collided twice with two different fresh numbers, which proved the collision
 * is not always about the number: a button that keeps rotating would quietly
 * feed the pool into a hole. After one failed replacement the listing is handed
 * back for a human to look at.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  UpcRotationRefused,
  rotateQuarantinedUpc,
} from "@/lib/bundle-factory/rotate-quarantined-upc";
import { prisma } from "@/lib/prisma";

/** How many pool numbers this listing has already burned. */
export async function countBurnedUpcsForSku(skuCode: string): Promise<number> {
  return prisma.uPCPool.count({
    where: { status: "QUARANTINED", notes: { contains: `SKU ${skuCode}` } },
  });
}

/** One replacement is a repair; a second is a pattern that needs a human. */
export const MAX_UPC_ROTATIONS_PER_LISTING = 1;

export const POST = withErrorHandler(
  "bundle-factory-sku-rotate-upc",
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const { id } = await context.params;

    const sku = await prisma.channelSKU.findUnique({
      where: { id },
      select: { id: true, sku: true, upc: true, channel: true, live_url: true },
    });
    if (!sku) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }
    if (sku.channel !== "WALMART") {
      return NextResponse.json(
        { error: "UPC rotation is a Walmart repair." },
        { status: 422 },
      );
    }

    const burned = await countBurnedUpcsForSku(sku.sku);
    if (burned > MAX_UPC_ROTATIONS_PER_LISTING) {
      return NextResponse.json({
        error:
          `${sku.sku} has already burned ${burned} product IDs on the same rejection. `
          + "The collision is not about the number, so rotating again would only "
          + "consume the pool. This listing needs a look at its payload.",
        code: "ROTATION_LIMIT_REACHED",
        burned_upcs: burned,
      }, { status: 409 });
    }

    try {
      const rotation = await rotateQuarantinedUpc(sku.id);
      return NextResponse.json({
        ok: true,
        sku: rotation.sku,
        previous_upc: rotation.previous_upc,
        new_upc: rotation.new_upc,
        note: "Publish the listing again to submit it under the new number.",
      });
    } catch (error) {
      if (error instanceof UpcRotationRefused) {
        return NextResponse.json(
          { error: error.message, code: "ROTATION_REFUSED" },
          { status: 409 },
        );
      }
      throw error;
    }
  },
);
