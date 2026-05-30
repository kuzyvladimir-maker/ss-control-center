/**
 * Amazon-order shipment cache — sourced from Veeqo, not Amazon SP-API.
 *
 * Why Veeqo and not Amazon Reports:
 *   * Amazon's flat-file Orders reports (GENERAL variant) have no
 *     carrier or tracking columns.
 *   * Amazon doesn't expose seller-confirmed tracking back via standard
 *     Orders / Finances endpoints — that data lives in past confirmShipment
 *     feeds and isn't ergonomic to read.
 *   * Vladimir ships ~every order through Veeqo, which records the
 *     actual carrier (service_carrier_name) + tracking_number +
 *     outbound label cost on each shipment.
 *
 * Veeqo API response shape (verified 2026-05-30 against prod):
 *   GET /orders?query=<amazon-order-id> → array, first match is the order
 *   order.allocations[0].shipment = {
 *     service_carrier_name: "fedex" | "ups" | "usps" | …  ← REAL carrier
 *     tracking_number: { tracking_number: "381275794590", … }
 *     tracking_url: full carrier URL
 *     outbound_label_charges: { value: 17.78, unit: null }  ← label cost
 *     carrier.name: "Buy Shipping" | "FedEx Direct" | …  (Veeqo integration)
 *     carrier.provider_type: "amazon_shipping_v2" | "fedex" | …
 *   }
 *
 * We upsert per (amazonOrderId, sku) into AmazonOrderShipment so
 * adjustment enrichment can join by amazonOrderId.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { prisma } from "@/lib/prisma";
import { veeqoFetch } from "@/lib/veeqo/client";
import { inferCarrierFromTracking } from "@/lib/adjustments/tracking-carrier";

export interface ShipmentSyncResult {
  scanned: number;
  upserted: number;
  withCarrier: number;
  withTracking: number;
  notFound: number;
  errors: number;
}

/**
 * Pull every Amazon order from ShippingAdjustment that doesn't yet have
 * a row in AmazonOrderShipment, query Veeqo for it, and upsert the
 * carrier + tracking. One Veeqo call per unique amazonOrderId.
 *
 * Sequential to respect Veeqo rate limits (no documented hard limit
 * but we've seen 429 on aggressive bursts).
 */
export async function syncShipmentsForAdjustments(opts: {
  limit?: number;
} = {}): Promise<ShipmentSyncResult> {
  const limit = opts.limit ?? 500;

  // Find adjustment orderIds we haven't fully synced yet. "Fully" means
  // all the fields we extract from Veeqo are present. Missing any =
  // re-pull (covers new fields added after the first sync).
  const have = new Set(
    (
      await prisma.amazonOrderShipment.findMany({
        select: { amazonOrderId: true },
        where: {
          carrier: { not: null },
          outboundLabelCost: { not: null },
          productName: { not: null },
        },
        distinct: ["amazonOrderId"],
      })
    ).map((r) => r.amazonOrderId),
  );

  const candidateOrderIds = (
    await prisma.shippingAdjustment.findMany({
      where: { channel: "Amazon", amazonOrderId: { not: null } },
      select: { amazonOrderId: true },
      distinct: ["amazonOrderId"],
    })
  )
    .map((r) => r.amazonOrderId!)
    .filter((id) => id && !have.has(id))
    .slice(0, limit);

  const result: ShipmentSyncResult = {
    scanned: candidateOrderIds.length,
    upserted: 0,
    withCarrier: 0,
    withTracking: 0,
    notFound: 0,
    errors: 0,
  };

  for (const amazonOrderId of candidateOrderIds) {
    try {
      const found = await veeqoFetch(
        `/orders?query=${encodeURIComponent(amazonOrderId)}`,
      );
      if (!Array.isArray(found) || found.length === 0) {
        result.notFound++;
        continue;
      }
      const order = found[0];
      const allocations: any[] = order?.allocations ?? [];
      if (allocations.length === 0) {
        result.notFound++;
        continue;
      }

      // One row per allocation × line-item. Most orders are single-SKU,
      // single-allocation but we handle the multi case.
      for (const alloc of allocations) {
        const shipment = alloc?.shipment;
        const carrier = extractCarrier(shipment);
        const tracking = extractTracking(shipment);
        const inferred = tracking
          ? inferCarrierFromTracking(tracking)
          : null;
        const service =
          shipment?.delivery_method?.name ??
          alloc?.delivery_method?.name ??
          shipment?.carrier?.name ??
          null;

        // labelCost = outbound_label_charges.value — useful to surface
        // in the adjustment expansion (original label vs adjusted cost).
        const labelCost =
          shipment?.outbound_label_charges?.value ??
          shipment?.outbound_label_charges?.amount ??
          null;

        const pkg = alloc?.allocation_package;
        const packageWeightLbs = pkgWeightToLbs(pkg);
        const packageDims = pkgDimsToInches(pkg);
        const packageName = pkg?.package_name ?? null;

        const lineItems: any[] = alloc?.line_items ?? [];
        if (lineItems.length === 0) {
          // No items on this allocation — store a single row with empty sku.
          await upsertOne({
            amazonOrderId,
            sku: "",
            asin: null,
            carrier,
            tracking,
            service,
            inferred,
            labelCost,
            productName: null,
            productImageUrl: null,
            packageWeightLbs,
            packageDimL: packageDims.l,
            packageDimW: packageDims.w,
            packageDimH: packageDims.h,
            packageName,
          });
          if (carrier) result.withCarrier++;
          if (tracking) result.withTracking++;
          result.upserted++;
        } else {
          for (const li of lineItems) {
            const sku = li?.sellable?.sku_code ?? "";
            const productName =
              li?.sellable?.product_title ??
              li?.sellable?.full_title ??
              null;
            const productImageUrl = li?.sellable?.image_url ?? null;
            await upsertOne({
              amazonOrderId,
              sku,
              asin: null,
              carrier,
              tracking,
              service,
              inferred,
              labelCost,
              productName,
              productImageUrl,
              packageWeightLbs,
              packageDimL: packageDims.l,
              packageDimW: packageDims.w,
              packageDimH: packageDims.h,
              packageName,
            });
            if (carrier) result.withCarrier++;
            if (tracking) result.withTracking++;
            result.upserted++;
          }
        }
      }
    } catch (err) {
      console.warn(
        `[shipments-veeqo] ${amazonOrderId}: ${err instanceof Error ? err.message : err}`,
      );
      result.errors++;
    }
  }

  return result;
}

interface UpsertArgs {
  amazonOrderId: string;
  sku: string;
  asin: string | null;
  carrier: string | null;
  tracking: string | null;
  service: string | null;
  inferred: string | null;
  labelCost: number | null;
  productName: string | null;
  productImageUrl: string | null;
  packageWeightLbs: number | null;
  packageDimL: number | null;
  packageDimW: number | null;
  packageDimH: number | null;
  packageName: string | null;
}

async function upsertOne(a: UpsertArgs) {
  await prisma.amazonOrderShipment.upsert({
    where: {
      amazon_order_shipment_dedup: {
        amazonOrderId: a.amazonOrderId,
        sku: a.sku,
      },
    },
    create: {
      amazonOrderId: a.amazonOrderId,
      sku: a.sku,
      asin: a.asin,
      carrier: a.carrier,
      trackingNumber: a.tracking,
      shipServiceLevel: a.service,
      carrierInferred: a.inferred,
      outboundLabelCost: a.labelCost,
      productName: a.productName,
      productImageUrl: a.productImageUrl,
      packageWeightLbs: a.packageWeightLbs,
      packageDimL: a.packageDimL,
      packageDimW: a.packageDimW,
      packageDimH: a.packageDimH,
      packageName: a.packageName,
    },
    update: {
      carrier: a.carrier ?? undefined,
      trackingNumber: a.tracking ?? undefined,
      shipServiceLevel: a.service ?? undefined,
      carrierInferred: a.inferred ?? undefined,
      outboundLabelCost: a.labelCost ?? undefined,
      productName: a.productName ?? undefined,
      productImageUrl: a.productImageUrl ?? undefined,
      packageWeightLbs: a.packageWeightLbs ?? undefined,
      packageDimL: a.packageDimL ?? undefined,
      packageDimW: a.packageDimW ?? undefined,
      packageDimH: a.packageDimH ?? undefined,
      packageName: a.packageName ?? undefined,
    },
  });
}

/** Convert Veeqo allocation_package.weight to pounds. */
function pkgWeightToLbs(pkg: any): number | null {
  if (!pkg) return null;
  const w = pkg.weight;
  if (typeof w !== "number" || w === 0) return null;
  const unit = (pkg.weight_unit || "").toLowerCase();
  if (unit === "lbs" || unit === "lb" || unit === "pounds") return w;
  if (unit === "oz" || unit === "ounces") return w / 16;
  if (unit === "kg" || unit === "kilograms") return w * 2.20462;
  if (unit === "g" || unit === "grams") return w * 0.00220462;
  return w; // unknown unit — assume already lbs
}

/** Convert Veeqo allocation_package depth/width/height to inches. */
function pkgDimsToInches(
  pkg: any,
): { l: number | null; w: number | null; h: number | null } {
  if (!pkg) return { l: null, w: null, h: null };
  const unit = (pkg.dimensions_unit || "").toLowerCase();
  const convert = (v: number | undefined | null): number | null => {
    if (typeof v !== "number" || v === 0) return null;
    if (unit === "inches" || unit === "in") return v;
    if (unit === "cm" || unit === "centimeters") return v * 0.393701;
    if (unit === "mm" || unit === "millimeters") return v * 0.0393701;
    return v;
  };
  return {
    l: convert(pkg.depth),
    w: convert(pkg.width),
    h: convert(pkg.height),
  };
}

/**
 * Pull carrier from Veeqo shipment, preferring the actual service carrier
 * (FedEx / UPS / USPS) over the integration name ("Buy Shipping").
 */
function extractCarrier(shipment: any): string | null {
  if (!shipment) return null;
  const svc = shipment.service_carrier_name;
  if (svc && typeof svc === "string") return normalize(svc);
  const provider = shipment.carrier?.provider_type;
  if (provider && typeof provider === "string") return normalize(provider);
  const name = shipment.carrier?.name;
  if (name && typeof name === "string") return normalize(name);
  return null;
}

/** Tracking number lives in different places across Veeqo response variants. */
function extractTracking(shipment: any): string | null {
  if (!shipment) return null;
  const tn = shipment.tracking_number;
  if (tn && typeof tn === "object" && tn.tracking_number) {
    return String(tn.tracking_number);
  }
  if (typeof tn === "string" && tn) return tn;
  if (shipment.tracking_code) return String(shipment.tracking_code);
  return null;
}

function normalize(raw: string): string | null {
  const lo = raw.trim().toLowerCase();
  if (!lo || lo === "other" || lo === "n/a") return null;
  // Veeqo emits resellers as "ups_reseller", "fedex_reseller" etc. Collapse
  // to the real carrier — Vladimir cares about which truck drove the box,
  // not which reseller handled the billing.
  if (/ups/.test(lo)) return "UPS";
  if (/fedex/.test(lo)) return "FEDEX";
  if (/usps|united states postal/.test(lo)) return "USPS";
  if (/dhl/.test(lo)) return "DHL";
  if (/ontrac/.test(lo)) return "ONTRAC";
  if (/lasership/.test(lo)) return "LASERSHIP";
  if (/amazon_shipping|buy.shipping/.test(lo)) return "AMAZON_BUY_SHIPPING";
  if (/amazon/.test(lo)) return "AMAZON";
  return raw.trim().toUpperCase();
}
