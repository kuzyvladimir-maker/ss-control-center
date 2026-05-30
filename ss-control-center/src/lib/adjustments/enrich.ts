/**
 * Adjustment enrichment — fills carrier / service / productName on
 * ShippingAdjustment rows.
 *
 * Three sources, tried in order until a value is found:
 *
 *   1. AmazonOrderShipment (populated by /api/cron/orders-shipments-amazon
 *      from the Reports API GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
 *      report — has carrier + tracking + service for 95%+ of shipped orders)
 *
 *   2. tracking-number → regex (when AmazonOrderShipment.carrier is null
 *      but trackingNumber is set; covers "Other"-labeled rows)
 *
 *   3. ShippingPlanItem (Veeqo outgoing labels — productName fallback,
 *      only for orders Vladimir shipped via the Veeqo pipeline; ~40% of
 *      orders)
 *
 * Amazon's /finances/v0 and Settlement Reports don't expose carrier on
 * adjustment events — anonymous "PostageBilling_PostageAdjustment". The
 * Orders Report (source 1) is the canonical way to attach a carrier to
 * an Amazon order.
 */

import { prisma } from "@/lib/prisma";
import { inferCarrierFromTracking } from "./tracking-carrier";

export interface EnrichResult {
  candidates: number;
  updated: number;
  withCarrier: number;
  withProductName: number;
  withLabelCost: number;
  carrierFromReport: number;
  carrierFromTracking: number;
  carrierFromShippingPlan: number;
}

/** Enrich every Amazon adjustment row that's missing carrier or productName. */
export async function enrichAdjustmentsFromShippingPlan(): Promise<EnrichResult> {
  const candidates = await prisma.shippingAdjustment.findMany({
    where: {
      channel: "Amazon",
      amazonOrderId: { not: null },
      OR: [
        { carrier: null },
        { productName: null },
        { originalLabelCost: null },
      ],
    },
    select: {
      id: true,
      amazonOrderId: true,
      carrier: true,
      productName: true,
      originalLabelCost: true,
    },
  });

  if (candidates.length === 0) {
    return {
      candidates: 0,
      updated: 0,
      withCarrier: 0,
      withProductName: 0,
      withLabelCost: 0,
      carrierFromReport: 0,
      carrierFromTracking: 0,
      carrierFromShippingPlan: 0,
    };
  }

  const orderIds = [
    ...new Set(candidates.map((c) => c.amazonOrderId!).filter(Boolean)),
  ];

  // Source 1+2: AmazonOrderShipment (Veeqo-sourced) — carrier, service, tracking, label cost.
  const shipments = await prisma.amazonOrderShipment.findMany({
    where: { amazonOrderId: { in: orderIds } },
    select: {
      amazonOrderId: true,
      carrier: true,
      carrierInferred: true,
      trackingNumber: true,
      shipServiceLevel: true,
      outboundLabelCost: true,
    },
  });
  // Multiple shipment rows per order possible (multi-item) — first non-null wins.
  const shipByOrder = new Map<
    string,
    {
      carrier: string | null;
      service: string | null;
      tracking: string | null;
      inferred: string | null;
      labelCost: number | null;
    }
  >();
  for (const s of shipments) {
    const cur = shipByOrder.get(s.amazonOrderId) ?? {
      carrier: null,
      service: null,
      tracking: null,
      inferred: null,
      labelCost: null,
    };
    cur.carrier ??= s.carrier ?? null;
    cur.service ??= s.shipServiceLevel ?? null;
    cur.tracking ??= s.trackingNumber ?? null;
    cur.inferred ??= s.carrierInferred ?? null;
    cur.labelCost ??= s.outboundLabelCost ?? null;
    shipByOrder.set(s.amazonOrderId, cur);
  }

  // Source 3: ShippingPlanItem (Veeqo) — productName fallback + carrier
  // for orders that didn't go through Amazon Orders API (rare, but
  // covers edge cases).
  const planItems = await prisma.shippingPlanItem.findMany({
    where: { orderNumber: { in: orderIds } },
    select: {
      orderNumber: true,
      carrier: true,
      service: true,
      product: true,
    },
  });
  const planByOrder = new Map<
    string,
    { carrier: string | null; service: string | null; product: string | null }
  >();
  for (const it of planItems) {
    const cur = planByOrder.get(it.orderNumber) ?? {
      carrier: null,
      service: null,
      product: null,
    };
    cur.carrier ??= it.carrier ?? null;
    cur.service ??= it.service ?? null;
    cur.product ??= it.product ?? null;
    planByOrder.set(it.orderNumber, cur);
  }

  let updated = 0;
  let withCarrier = 0;
  let withProductName = 0;
  let withLabelCost = 0;
  let carrierFromReport = 0;
  let carrierFromTracking = 0;
  let carrierFromShippingPlan = 0;

  for (const adj of candidates) {
    const ship = shipByOrder.get(adj.amazonOrderId!);
    const plan = planByOrder.get(adj.amazonOrderId!);

    let carrier: string | null = null;
    let service: string | null = null;
    let carrierSource: "report" | "tracking" | "plan" | null = null;

    if (ship?.carrier) {
      carrier = ship.carrier;
      carrierSource = "report";
    } else if (ship?.inferred) {
      carrier = ship.inferred;
      carrierSource = "tracking";
    } else if (ship?.tracking) {
      const inferred = inferCarrierFromTracking(ship.tracking);
      if (inferred) {
        carrier = inferred;
        carrierSource = "tracking";
      }
    }
    if (!carrier && plan?.carrier) {
      carrier = plan.carrier;
      carrierSource = "plan";
    }
    service = ship?.service ?? plan?.service ?? null;

    const productName = plan?.product ?? null;
    const labelCost = ship?.labelCost ?? null;

    const patch: Record<string, string | number | null> = {};
    if (!adj.carrier && carrier) patch.carrier = carrier;
    if (!adj.carrier && service) patch.service = service;
    if (!adj.productName && productName) patch.productName = productName;
    if (!adj.originalLabelCost && labelCost != null) {
      patch.originalLabelCost = labelCost;
    }
    if (Object.keys(patch).length === 0) continue;

    await prisma.shippingAdjustment.update({
      where: { id: adj.id },
      data: patch,
    });
    updated++;
    if (patch.carrier) {
      withCarrier++;
      if (carrierSource === "report") carrierFromReport++;
      else if (carrierSource === "tracking") carrierFromTracking++;
      else if (carrierSource === "plan") carrierFromShippingPlan++;
    }
    if (patch.productName) withProductName++;
    if (patch.originalLabelCost) withLabelCost++;
  }

  return {
    candidates: candidates.length,
    updated,
    withCarrier,
    withProductName,
    withLabelCost,
    carrierFromReport,
    carrierFromTracking,
    carrierFromShippingPlan,
  };
}
