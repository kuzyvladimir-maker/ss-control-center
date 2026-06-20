// loadSkuEconomics — the only orchestrator that touches the DB. It assembles a
// ProfitInput per live SKU from cached sources (no live SP-API/Walmart calls)
// and runs computeProfit. Anything we can't source is set to a safe value and
// flagged, so the page is honest about what's real vs estimated.
//
// Cached sources (see the data-source survey):
//   Amazon  — price: AmazonListingSnapshot (latest per store+sku)
//             ownShipping: avg AmazonOrderShipment.outboundLabelCost per sku
//             shippingCharged: ≈ ownShipping on MFN (flagged estimate)
//   Walmart — price/shippingCharged: WalmartBuyBoxItem.sellerItemPrice/sellerShipPrice
//             ownShipping: estimated from weight via cost-model LABEL (flagged)
//   Both    — weight/category: SkuShippingData; COGS: SkuCost (via getCogsForSkus)

import { prisma } from "@/lib/prisma";
import type { Marketplace, ProfitResult } from "./types";
import { computeProfit } from "./compute-profit";
import { getCogsForSkus } from "./cogs";
import { resolveSkuCategories } from "./categories";
import { packagingForSku } from "./packaging";
import { coolerForWeight } from "./packaging";
import { LABEL } from "@/lib/pricing/cost-model";

export interface EconomicsRow extends ProfitResult {
  title: string | null;
  cooler: string | null;
  cogsSource: string | null;
  cogsEffectiveDate: string | null;
}

export interface EconomicsSummary {
  storeIndex: number;
  marketplace: Marketplace;
  total: number;
  cogsMissing: number;
  belowTargetMargin: number;
  rows: EconomicsRow[];
}

function round2(n: number | null | undefined): number {
  return n == null ? 0 : Math.round(n * 100) / 100;
}

/** weight + category from SkuShippingData for a set of SKUs. */
async function loadShippingData(skus: string[]) {
  const rows = await prisma.skuShippingData.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, weight: true, category: true, unitsInListing: true, productTitle: true },
  });
  return new Map(rows.map((r) => [r.sku, r]));
}

/** Latest Amazon listing price per (store, sku). */
async function loadAmazonPrices(storeIndex: number) {
  const rows = await prisma.amazonListingSnapshot.findMany({
    where: { storeIndex, price: { not: null } },
    orderBy: { capturedAt: "desc" },
    select: { sku: true, price: true, title: true },
  });
  const m = new Map<string, { price: number; title: string | null }>();
  for (const r of rows) {
    if (m.has(r.sku) || r.price == null) continue; // newest-first dedup
    m.set(r.sku, { price: r.price, title: r.title });
  }
  return m;
}

/** Average outbound label cost we actually paid per SKU (Amazon, store-scoped). */
async function loadAmazonLabelCosts(storeIndex: number, skus: string[]) {
  const grouped = await prisma.amazonOrderShipment.groupBy({
    by: ["sku"],
    where: { storeIndex, sku: { in: skus }, outboundLabelCost: { not: null } },
    _avg: { outboundLabelCost: true },
  });
  const m = new Map<string, number>();
  for (const g of grouped) {
    if (g.sku && g._avg.outboundLabelCost != null) {
      m.set(g.sku, Math.round(g._avg.outboundLabelCost * 100) / 100);
    }
  }
  return m;
}

export async function loadSkuEconomics(opts: {
  storeIndex: number;
  marketplace: Marketplace;
}): Promise<EconomicsSummary> {
  const { storeIndex, marketplace } = opts;

  // 1) Anchor the SKU universe + price/shipping on the marketplace's cache.
  const priceBySku = new Map<
    string,
    { itemPrice: number; shippingCharged: number | null; title: string | null }
  >();

  if (marketplace === "amazon") {
    const prices = await loadAmazonPrices(storeIndex);
    for (const [sku, p] of prices) {
      priceBySku.set(sku, { itemPrice: p.price, shippingCharged: null, title: p.title });
    }
  } else {
    const rows = await prisma.walmartBuyBoxItem.findMany({
      where: { storeIndex },
      select: { sku: true, sellerItemPrice: true, sellerShipPrice: true, productName: true },
    });
    for (const r of rows) {
      if (r.sellerItemPrice == null) continue;
      priceBySku.set(r.sku, {
        itemPrice: r.sellerItemPrice,
        shippingCharged: r.sellerShipPrice ?? null,
        title: r.productName,
      });
    }
  }

  const skus = [...priceBySku.keys()];

  // 2) Enrich from shared + marketplace-specific caches (all batched).
  const [cogs, categories, shipData, labelCosts] = await Promise.all([
    getCogsForSkus(skus),
    resolveSkuCategories(skus),
    loadShippingData(skus),
    marketplace === "amazon"
      ? loadAmazonLabelCosts(storeIndex, skus)
      : Promise.resolve(new Map<string, number>()),
  ]);

  // 3) Build a ProfitInput + flags per SKU and compute.
  const rows: EconomicsRow[] = [];
  for (const sku of skus) {
    const price = priceBySku.get(sku)!;
    const c = cogs.get(sku)!;
    const sd = shipData.get(sku);
    const weight = sd?.weight ?? null;
    const category = sd?.category ?? null;

    const flags: string[] = [];

    // COGS (whole-listing, pack-aware). Missing → compute with 0 as an UPPER
    // BOUND and flag loudly; never fabricate a fake cost.
    let cogsValue = 0;
    if (c.missing || c.cost == null) flags.push("cogs_missing");
    else {
      cogsValue = c.cost;
      if (c.stale) flags.push("cogs_stale");
    }

    // Packaging — guarded against double-count via includesPackaging.
    const pkg = packagingForSku({
      weightLb: weight,
      includesPackaging: c.includesPackaging,
      category,
    });
    if (pkg.estimated) flags.push("packaging_estimated");

    // Own outbound shipping cost.
    let ownShipping = 0;
    if (marketplace === "amazon") {
      const avg = labelCosts.get(sku);
      if (avg != null) ownShipping = avg;
      else flags.push("own_shipping_missing");
    } else {
      // Walmart: no label-cost cache — estimate from weight via cost-model LABEL.
      if (weight != null && weight > 0) {
        ownShipping = LABEL[coolerForWeight(weight)];
        flags.push("own_shipping_estimated");
      } else {
        flags.push("own_shipping_missing");
      }
    }

    // Shipping charged to the customer.
    let shippingCharged = price.shippingCharged ?? 0;
    if (price.shippingCharged == null) {
      // Amazon MFN: customer pays ≈ our label. Use ownShipping as the proxy.
      shippingCharged = ownShipping;
      flags.push("shipping_charged_estimated");
    }

    const result = computeProfit(
      {
        sku,
        marketplace,
        itemPrice: round2(price.itemPrice),
        shippingCharged: round2(shippingCharged),
        cogs: cogsValue,
        packaging: pkg.packaging,
        ownShipping: round2(ownShipping),
        category: categories.get(sku)!,
      },
      flags,
    );

    rows.push({
      ...result,
      title: price.title ?? sd?.productTitle ?? null,
      cooler: pkg.cooler,
      cogsSource: c.source,
      cogsEffectiveDate: c.effectiveDate,
    });
  }

  // Sort worst-margin first — that's the worklist.
  rows.sort((a, b) => a.marginPct - b.marginPct);

  return {
    storeIndex,
    marketplace,
    total: rows.length,
    cogsMissing: rows.filter((r) => r.flags.includes("cogs_missing")).length,
    belowTargetMargin: rows.filter((r) => r.flags.includes("below_target_margin")).length,
    rows,
  };
}
