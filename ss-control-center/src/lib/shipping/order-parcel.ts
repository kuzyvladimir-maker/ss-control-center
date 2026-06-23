/**
 * Resolve the physical parcel (weight + box dims) for a Veeqo order from OUR
 * catalog — the single source of truth for what the package actually is.
 *
 * Why this exists: the new Veeqo Rate Shopping API (`getRatesForShipDate` →
 * POST /shipping/api/v1/rates) quotes against whatever `parcel` we hand it. If
 * we hand it nothing, it falls back to Veeqo's stored allocation_package, which
 * Veeqo frequently overwrites with an auto-"SUGGESTION" package (wrong weight +
 * dims) — e.g. order 113-7774410 had a 16 lb / 13×13×15 SUGGESTION while our
 * catalog says 10 lb / 12×12×10. Quoting against the suggestion inflated every
 * rate (UPS 3 Day Select $35.32 instead of the real $25.38) and dropped rates
 * (FedEx 2Day One Rate vanished). The plan/card path already passes a catalog
 * parcel and quotes correctly; the manual Pick-Rate modal did NOT, so the two
 * disagreed. This helper lets both resolve the SAME parcel the SAME way.
 *
 * Resolution mirrors /api/shipping/plan:
 *   • single line, qty 1  → per-SKU SkuShippingData row
 *   • multi-line OR qty>1 → PackingProfile keyed by the composition signature
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { SkuRow } from "@/lib/sku-database";
import {
  buildPackingSignature,
  requiresPackingProfile,
} from "@/lib/shipping/packing-signature";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";

export interface ResolvedParcel {
  /** Weight in OUNCES (the unit the Rate Shopping API expects). */
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

/**
 * Returns the catalog parcel for `order`, or `undefined` when we have no usable
 * weight (in which case the caller should let the Rate Shopping API fall back —
 * there's nothing better to send). Dimensions are included only when a complete
 * box is resolvable; weight-only is still useful and matches the plan's
 * behaviour for SKUs that have a weight but no box.
 */
export async function resolveOrderParcel(
  order: Record<string, any>,
  prisma: PrismaClient,
  skuDatabase: SkuRow[],
): Promise<ResolvedParcel | undefined> {
  const orderLines: Array<{
    sku: string;
    quantity: number;
    fallbackId: number | null;
  }> = (order.line_items ?? [])
    .map((li: any) => ({
      sku: String(li?.sellable?.sku_code ?? li?.sellable?.sku ?? ""),
      quantity: Number(li?.quantity ?? 1),
      fallbackId:
        typeof li?.sellable?.product?.id === "number"
          ? li.sellable.product.id
          : typeof li?.sellable?.product_id === "number"
            ? li.sellable.product_id
            : typeof li?.sellable?.id === "number"
              ? li.sellable.id
              : null,
    }))
    .filter(
      (i: { sku: string; fallbackId: number | null }) =>
        i.sku || i.fallbackId != null,
    );

  let weightLbs: number | null = null;
  let boxSize: string | null = null;

  if (requiresPackingProfile(orderLines)) {
    const signature = buildPackingSignature(orderLines);
    const profile = await prisma.packingProfile.findUnique({
      where: { signature },
    });
    if (profile) {
      weightLbs = profile.weight;
      boxSize = profile.boxSize;
    }
  } else {
    const firstSku =
      order.line_items?.[0]?.sellable?.sku_code ||
      order.line_items?.[0]?.sellable?.sku ||
      "";
    const skuData = skuDatabase.find((r) => r.sku === firstSku) || null;
    if (skuData) {
      weightLbs = skuData.weight;
      if (skuData.length && skuData.width && skuData.height) {
        boxSize = `${skuData.length}x${skuData.width}x${skuData.height}`;
      }
    }
  }

  if (weightLbs == null) return undefined;

  const dims = boxSize ? resolveBoxDimensions(boxSize) : null;
  return dims
    ? {
        weightOz: weightLbs * 16,
        lengthIn: dims.length,
        widthIn: dims.width,
        heightIn: dims.height,
      }
    : { weightOz: weightLbs * 16 };
}
