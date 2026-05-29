/**
 * Adjustment enrichment — fills carrier / service / productName on
 * ShippingAdjustment rows by joining with ShippingPlanItem (the Veeqo-
 * driven label purchase records that DO know which carrier shipped
 * which order).
 *
 * Amazon's /finances/v0/financialEvents and Settlement Reports don't
 * expose carrier on adjustment rows — to surface it on the page we
 * cross-reference the order ID against our own outgoing-label history.
 *
 * Coverage is intentionally partial: ~38% of adjustment orderIds match
 * a ShippingPlanItem (the rest are orders Vladimir didn't ship via the
 * Veeqo pipeline — e.g. legacy or FBA). Better than nothing.
 */

import { prisma } from "@/lib/prisma";

export interface EnrichResult {
  candidates: number;
  updated: number;
  withCarrier: number;
  withProductName: number;
}

/** Enrich every Amazon adjustment row that's missing carrier or productName. */
export async function enrichAdjustmentsFromShippingPlan(): Promise<EnrichResult> {
  const candidates = await prisma.shippingAdjustment.findMany({
    where: {
      channel: "Amazon",
      amazonOrderId: { not: null },
      OR: [{ carrier: null }, { productName: null }],
    },
    select: { id: true, amazonOrderId: true, carrier: true, productName: true },
  });

  if (candidates.length === 0) {
    return { candidates: 0, updated: 0, withCarrier: 0, withProductName: 0 };
  }

  const orderIds = [
    ...new Set(candidates.map((c) => c.amazonOrderId!).filter(Boolean)),
  ];

  // ShippingPlanItem.orderNumber == Amazon order ID. Multiple rows per
  // order (one per item) — group + pick first non-null per field.
  const planItems = await prisma.shippingPlanItem.findMany({
    where: { orderNumber: { in: orderIds } },
    select: {
      orderNumber: true,
      carrier: true,
      service: true,
      product: true,
    },
  });

  const byOrder = new Map<
    string,
    { carrier: string | null; service: string | null; product: string | null }
  >();
  for (const it of planItems) {
    const key = it.orderNumber;
    const cur = byOrder.get(key) ?? {
      carrier: null,
      service: null,
      product: null,
    };
    cur.carrier ??= it.carrier ?? null;
    cur.service ??= it.service ?? null;
    cur.product ??= it.product ?? null;
    byOrder.set(key, cur);
  }

  let updated = 0;
  let withCarrier = 0;
  let withProductName = 0;

  for (const adj of candidates) {
    const info = byOrder.get(adj.amazonOrderId!);
    if (!info) continue;
    const patch: Record<string, string | null> = {};
    if (!adj.carrier && info.carrier) patch.carrier = info.carrier;
    if (!adj.carrier && info.service) patch.service = info.service;
    if (!adj.productName && info.product) patch.productName = info.product;
    if (Object.keys(patch).length === 0) continue;

    await prisma.shippingAdjustment.update({
      where: { id: adj.id },
      data: patch,
    });
    updated++;
    if (patch.carrier) withCarrier++;
    if (patch.productName) withProductName++;
  }

  return {
    candidates: candidates.length,
    updated,
    withCarrier,
    withProductName,
  };
}
