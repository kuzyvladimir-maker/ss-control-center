import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchAllOrders,
  getProduct,
  getShippingRates,
  veeqoDateToLocal,
  getTodayNY,
} from "@/lib/veeqo";
import { fetchSkuDatabase, type SkuRow } from "@/lib/google-sheets";

// ── Veeqo rate shape (actual API fields) ──
interface VeeqoRate {
  carrier: string; // "amazon_shipping_v2"
  name: string; // full service identifier for purchase
  title: string; // display: "UPS® Ground", "FedEx Ground Economy"
  short_title: string;
  total_net_charge: string;
  base_rate: string;
  delivery_promise_date: string;
  sub_carrier_id: string; // "UPS", "FEDEX", "USPS"
  service_carrier: string; // "ups", "fedex", "usps"
  remote_shipment_id: string;
  service_id: string;
  [key: string]: unknown;
}

// ── Day info ──
function getDayInfo(today: string) {
  const d = new Date(today + "T12:00:00");
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;

  const actualShipDay = new Date(d);
  if (dow === 0) actualShipDay.setDate(actualShipDay.getDate() + 1);
  else if (dow === 6) actualShipDay.setDate(actualShipDay.getDate() + 2);

  const dispatchTarget = new Date(d);
  if (dow === 6) dispatchTarget.setDate(dispatchTarget.getDate() + 2);
  else if (dow === 0) dispatchTarget.setDate(dispatchTarget.getDate() + 1);

  return {
    today,
    dow,
    dayName: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
    isWeekend,
    actualShipDay: actualShipDay.toISOString().split("T")[0],
    dispatchTarget: dispatchTarget.toISOString().split("T")[0],
    dispatchTargetFormatted: dispatchTarget.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  };
}

// ── Next Monday from a date string ──
function getNextMonday(from: string): string {
  const d = new Date(from + "T12:00:00");
  const dow = d.getDay();
  const daysUntilMon = dow === 0 ? 1 : 8 - dow;
  d.setDate(d.getDate() + daysUntilMon);
  return d.toISOString().split("T")[0];
}

// ── Select best rate ──
// Rates use actual Veeqo field names:
//   sub_carrier_id = "UPS"/"FEDEX"/"USPS"
//   title = "UPS® Ground", "FedEx 2Day" etc.
//   total_net_charge = price string
//   delivery_promise_date = ISO date
function selectBestRate(
  rates: VeeqoRate[],
  productType: string,
  deliveryBy: string,
  actualShipDay: string,
  dayName: string,
  isAfterNoon: boolean
): VeeqoRate | null {
  const deliveryByDate = new Date(deliveryBy + "T23:59:59");
  const shipDate = new Date(actualShipDay + "T00:00:00");

  const enriched = rates
    .map((rate) => {
      const eddLocal = veeqoDateToLocal(rate.delivery_promise_date);
      const eddDate = new Date(eddLocal + "T00:00:00");
      const calDays = Math.round(
        (eddDate.getTime() - shipDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      const carrierUp = (rate.sub_carrier_id || "").toUpperCase();
      const titleLow = (rate.title || "").toLowerCase();
      return {
        ...rate,
        eddLocal,
        eddDate,
        calDays,
        meetsDeadline: eddDate <= deliveryByDate,
        price: parseFloat(rate.total_net_charge),
        carrierUp,
        titleLow,
      };
    })
    .filter((r) => r.meetsDeadline && r.price > 0);

  if (enriched.length === 0) return null;

  // ── FROZEN ──
  if (productType === "Frozen") {
    let pool = enriched.filter((r) => r.calDays <= 3);

    // Wednesday: ground doesn't work (3 business = 5 calendar)
    if (dayName === "Wed") {
      const noGround = pool.filter(
        (r) => !r.titleLow.includes("ground")
      );
      if (noGround.length > 0) pool = noGround;
    }

    // Friday: FedEx Express NEVER
    if (dayName === "Fri") {
      pool = pool.filter(
        (r) =>
          !(r.carrierUp === "FEDEX" && r.titleLow.includes("express"))
      );
    }

    if (pool.length === 0) return null;

    pool.sort((a, b) => a.price - b.price);
    const cheapest = pool[0];

    // ~10% more but 1-2 days faster → prefer faster
    for (const rate of pool) {
      const priceDiff = (rate.price - cheapest.price) / cheapest.price;
      const daysSaved = cheapest.calDays - rate.calDays;
      if (priceDiff <= 0.1 && priceDiff > 0 && daysSaved >= 1) return rate;
    }

    // ≤$0.50 → earlier EDD
    const close = pool.filter((r) => r.price - cheapest.price <= 0.5);
    if (close.length > 1) {
      close.sort((a, b) => a.eddDate.getTime() - b.eddDate.getTime());
      return close[0];
    }

    return cheapest;
  }

  // ── DRY ──
  let pool = [...enriched];

  // After 12:00 ET: avoid USPS if alternatives exist
  if (isAfterNoon) {
    const nonUsps = pool.filter((r) => r.carrierUp !== "USPS");
    if (nonUsps.length > 0) pool = nonUsps;
  }

  if (pool.length === 0) return null;

  pool.sort((a, b) => a.price - b.price);
  const cheapest = pool[0];

  // ≤10% diff → prefer UPS
  for (const rate of pool) {
    const diff = (rate.price - cheapest.price) / cheapest.price;
    if (diff <= 0.1 && rate.carrierUp === "UPS") return rate;
  }

  // ≤$0.50 → earlier EDD
  const within50 = pool.filter((r) => r.price - cheapest.price <= 0.5);
  if (within50.length > 1) {
    within50.sort((a, b) => a.eddDate.getTime() - b.eddDate.getTime());
    return within50[0];
  }

  return cheapest;
}

// ── Main handler ──
export async function GET() {
  try {
    const today = getTodayNY();
    const dayInfo = getDayInfo(today);
    const { isWeekend: weekend, actualShipDay, dispatchTarget } = dayInfo;
    const nowNY = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const isAfterNoon = nowNY.getHours() >= 12;

    let skuDatabase: SkuRow[] = [];
    try {
      skuDatabase = await fetchSkuDatabase();
    } catch (e) {
      console.error("Failed to fetch SKU database:", e);
    }

    const orders = await fetchAllOrders();

    // Debug
    const debug = {
      totalFromVeeqo: orders.length,
      today,
      dispatchTarget,
      dayName: dayInfo.dayName,
      isWeekend: weekend,
      isAfterNoon,
      skuCount: skuDatabase.length,
      filters: {
        afterPlacedTag: 0,
        afterDispatchDate: 0,
        afterChannel: 0,
        afterWalmartWeekend: 0,
        afterDuplicateCheck: 0,
      },
      sampleOrders: orders.slice(0, 5).map(
        (o: {
          number: string;
          dispatch_date: string;
          tags: { name: string }[];
          channel: { name: string; type_code: string };
          status: string;
          employee_notes: string;
        }) => ({
          number: o.number,
          dispatch_date_raw: o.dispatch_date,
          dispatch_date_converted: o.dispatch_date
            ? veeqoDateToLocal(o.dispatch_date)
            : null,
          tags: (o.tags || []).map((t: { name: string }) => t.name),
          channel: o.channel?.name || "unknown",
          channelType: o.channel?.type_code || "unknown",
          status: o.status,
          hasPlacedTag: (o.tags || []).some(
            (t: { name: string }) => t.name === "Placed"
          ),
          hasLabelPurchased: (o.employee_notes || "").includes(
            "Label Purchased"
          ),
        })
      ),
    };

    const planItems: Array<{
      orderNumber: string; orderId: string; channel: string; product: string;
      sku: string; qty: number; productType: string; _productId: number | null;
      weight: number | null; boxSize: string | null; budgetMax: number | null;
      carrier: string | null; service: string | null; price: number | null;
      edd: string | null; deliveryBy: string; actualShipDay: string;
      notes: string | null; status: string;
      allocationId: string | null; carrierId: string | null;
      remoteShipmentId: string | null; serviceType: string | null;
      subCarrierId: string | null; serviceCarrier: string | null;
      totalNetCharge: string | null; baseRate: string | null;
    }> = [];

    for (const order of orders) {
      const hasPlaced = order.tags?.some(
        (t: { name: string }) => t.name === "Placed"
      );
      if (!hasPlaced) continue;
      debug.filters.afterPlacedTag++;

      const shipBy = veeqoDateToLocal(order.dispatch_date);
      if (shipBy !== dispatchTarget) continue;
      debug.filters.afterDispatchDate++;

      const channel = order.channel?.name || "";
      const channelType = (order.channel?.type_code || "").toLowerCase();
      const isAmazon = channelType === "amazon";
      const isWalmart = channelType === "walmart";
      if (!isAmazon && !isWalmart) continue;
      debug.filters.afterChannel++;

      if (isWalmart && weekend) continue;
      debug.filters.afterWalmartWeekend++;

      const alreadyPurchased =
        order.employee_notes?.includes("Label Purchased");
      if (alreadyPurchased) continue;
      debug.filters.afterDuplicateCheck++;

      // ── Product type ──
      let productType = "Unknown";
      let stopReason: string | null = null;
      const productId: number | null =
        order.line_items?.[0]?.sellable?.product?.id || null;

      if (isWalmart) {
        productType = "Dry";
      } else {
        // Check local override first (set via "Set Frozen/Dry" button)
        let localOverride: string | null = null;
        if (productId) {
          const override = await prisma.productTypeOverride.findUnique({
            where: { productId },
          });
          if (override) localOverride = override.type;
        }

        if (localOverride) {
          productType = localOverride;
        } else {
          try {
            if (productId) {
              const product = await getProduct(productId);
              const tagNames = (product.tags || []).map(
                (t: { name?: string } | string) =>
                  (typeof t === "string" ? t : t.name || "").toLowerCase()
              );
              if (tagNames.some((t: string) => t.includes("frozen"))) {
                productType = "Frozen";
              } else if (tagNames.some((t: string) => t.includes("dry"))) {
                productType = "Dry";
              } else {
                stopReason = `Missing Frozen/Dry tag (tags: ${tagNames.join(", ") || "none"})`;
              }
            } else {
              stopReason = "No product_id in line_items";
            }
          } catch (e) {
            stopReason = `Could not fetch product tags: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }

      // ── SKU lookup ──
      const firstSku =
        order.line_items?.[0]?.sellable?.sku_code ||
        order.line_items?.[0]?.sellable?.sku ||
        "";
      const skuData =
        skuDatabase.find((r) => r.sku === firstSku) || null;
      let skuWeight: number | null = null;
      let skuBoxSize: string | null = null;

      if (!stopReason && !skuData) {
        stopReason = `SKU ${firstSku} not in SKU Database v2`;
      } else if (!stopReason && skuData && !skuData.hasCompleteData) {
        stopReason = `SKU ${firstSku}: missing weight/dimensions`;
      } else if (skuData) {
        skuWeight = skuData.weight;
        if (skuData.length && skuData.width && skuData.height) {
          skuBoxSize = `${skuData.length}x${skuData.width}x${skuData.height}`;
        }
      }

      const deliveryBy = veeqoDateToLocal(order.due_date);
      const allocationId = order.allocations?.[0]?.id;

      // ── Get rates & select best ──
      let selectedRate: VeeqoRate | null = null;
      let shipDateNote: string | null = null;

      if (!stopReason && allocationId) {
        try {
          const ratesResponse = await getShippingRates(String(allocationId));
          const rates: VeeqoRate[] = ratesResponse?.available || [];

          selectedRate = selectBestRate(
            rates,
            productType,
            deliveryBy,
            actualShipDay,
            dayInfo.dayName,
            isAfterNoon
          );

          // Ship Date Trick for Thu/Fri Frozen with no rates
          if (
            !selectedRate &&
            productType === "Frozen" &&
            (dayInfo.dayName === "Thu" || dayInfo.dayName === "Fri")
          ) {
            shipDateNote = `Ship Date Trick: actual shipment Monday`;
            // NOTE: The actual Ship Date trick (PUT dispatch_date → Mon,
            // fetch rates, PUT back) would be done here in production.
            // For now we mark it for manual handling.
            stopReason = `No Frozen rate ≤3 days — needs Ship Date trick (${dayInfo.dayName}→Mon). Handle manually.`;
          }

          if (!selectedRate && !stopReason) {
            stopReason = `No rate where EDD ≤ Delivery By (${deliveryBy}). ${rates.length} rates checked.`;
          }
        } catch (e) {
          stopReason = `Rates error: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else if (!stopReason && !allocationId) {
        stopReason = "No allocation_id on order";
      }

      // ── Build plan row ──
      const sku =
        order.line_items
          ?.map(
            (li: { sellable: { sku_code?: string; sku?: string } }) =>
              li.sellable.sku_code || li.sellable.sku || ""
          )
          .join("; ") || "";
      const product =
        order.line_items
          ?.map(
            (li: { sellable: { product_title: string } }) =>
              li.sellable.product_title
          )
          .join("; ") || "";
      const qty =
        order.line_items?.reduce(
          (sum: number, li: { quantity: number }) => sum + li.quantity,
          0
        ) || 1;

      planItems.push({
        orderNumber: order.number,
        orderId: String(order.id),
        channel,
        product,
        sku,
        qty,
        productType,
        _productId: productId, // Not saved to DB, used in response
        weight: skuWeight,
        boxSize: skuBoxSize,
        budgetMax: null,
        // Map Veeqo rate fields to our display/purchase fields
        carrier: selectedRate?.sub_carrier_id || null, // "UPS", "FEDEX", "USPS"
        service: selectedRate?.title || null, // "UPS® Ground", "FedEx 2Day"
        price: selectedRate
          ? parseFloat(selectedRate.total_net_charge)
          : null,
        edd: selectedRate
          ? veeqoDateToLocal(selectedRate.delivery_promise_date)
          : null,
        deliveryBy,
        actualShipDay: shipDateNote
          ? getNextMonday(today)
          : actualShipDay,
        notes: stopReason || shipDateNote,
        status: stopReason ? "stop" : "pending",
        // Purchase payload fields (actual Veeqo field names)
        allocationId: allocationId ? String(allocationId) : null,
        carrierId: selectedRate?.carrier || null, // "amazon_shipping_v2"
        remoteShipmentId: selectedRate?.remote_shipment_id || null,
        serviceType: selectedRate?.name || null, // full service identifier
        subCarrierId: selectedRate?.sub_carrier_id || null, // "UPS"
        serviceCarrier: selectedRate?.service_carrier || null, // "ups"
        totalNetCharge: selectedRate?.total_net_charge || null,
        baseRate: selectedRate?.base_rate || null,
      });
    }

    // Save plan
    const plan = await prisma.shippingPlan.create({
      data: {
        date: today,
        status: "draft",
        items: {
          create: planItems.map((item) => ({
            orderNumber: item.orderNumber,
            orderId: item.orderId,
            channel: item.channel,
            product: item.product,
            sku: item.sku,
            qty: item.qty,
            productType: item.productType,
            weight: item.weight,
            boxSize: item.boxSize,
            budgetMax: item.budgetMax,
            carrier: item.carrier,
            service: item.service,
            price: item.price,
            edd: item.edd,
            deliveryBy: item.deliveryBy,
            actualShipDay: item.actualShipDay,
            notes: item.notes,
            status: item.status,
            allocationId: item.allocationId,
            carrierId: item.carrierId,
            remoteShipmentId: item.remoteShipmentId,
            serviceType: item.serviceType,
            subCarrierId: item.subCarrierId,
            serviceCarrier: item.serviceCarrier,
            totalNetCharge: item.totalNetCharge,
            baseRate: item.baseRate,
          })),
        },
      },
      include: { items: true },
    });

    const readyCount = plan.items.filter(
      (i) => i.status === "pending"
    ).length;
    const stopCount = plan.items.filter(
      (i) => i.status === "stop"
    ).length;

    // Enrich DB items with productId (not stored in DB)
    const enrichedItems = plan.items.map((dbItem) => {
      const src = planItems.find(
        (p) => p.orderNumber === dbItem.orderNumber
      );
      return { ...dbItem, _productId: src?._productId || null };
    });

    return NextResponse.json({
      planId: plan.id,
      date: today,
      dispatchDate: dispatchTarget,
      dispatchDateFormatted: dayInfo.dispatchTargetFormatted,
      isWeekend: weekend,
      dayName: dayInfo.dayName,
      orders: enrichedItems,
      total: plan.items.length,
      readyCount,
      stopCount,
      debug,
    });
  } catch (error) {
    console.error("Shipping plan error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate shipping plan",
      },
      { status: 500 }
    );
  }
}
