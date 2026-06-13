import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchAllOrders,
  getProduct,
  getShippingRates,
  getRatesForShipDate,
  veeqoDateToLocal,
  getTodayNY,
  updateOrderDispatchDate,
  updateAllocationPackage,
} from "@/lib/veeqo";
import { fetchSkuDatabase, type SkuRow } from "@/lib/sku-database";
import {
  buildPackingSignature,
  requiresPackingProfile,
} from "@/lib/shipping/packing-signature";
import { computeLabelDate, nextMondayFrom } from "@/lib/shipping/dates";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";
import { normalizeChannelKind } from "@/lib/shipping-label-files";

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

// Run `fn` over `items` with at most `poolSize` concurrent executions.
// Used to parallelize the per-order rate pre-warm below without firing all
// requests at Veeqo at once (it rate-limits bursts). Each worker pulls the
// next index until the list is drained.
async function mapPool<T>(
  items: T[],
  poolSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(poolSize, 1), items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    }
  );
  await Promise.all(workers);
}

// ── Select best rate ──
// Rates use actual Veeqo field names:
//   sub_carrier_id = "UPS"/"FEDEX"/"USPS"
//   title = "UPS® Ground", "FedEx 2Day" etc.
//   total_net_charge = price string
//   delivery_promise_date = ISO date
// All date conversion goes through `veeqoDateToLocal` from
// veeqo/client.ts, which renders YYYY-MM-DD in America/Los_Angeles —
// the same TZ Veeqo's own UI uses for ship-by and EDD. A previous
// workaround helper (`eddNYDate`) used America/New_York, which made
// our EDD column read one day later than Veeqo's and pushed cheaper
// rates like UPS Ground Saver out of the deadline filter.

/**
 * Frozen calendar-day cap. Master Prompt v3.4 §5 tightens the transit
 * cap from "≤3 days" to "≤2 days" when the FrozenRiskAlert rates the
 * destination as `high` OR `critical` — hot destinations / multi-day
 * high-temp routes that put the food itself at risk regardless of
 * marketplace deadline math.
 * (Vladimir 2026-06-09: BOTH high and critical → 2 days, not critical
 *  only.) For all other levels (ok/low/medium or no alert) the default
 * ≤3-day cap applies.
 */
function frozenMaxCalDays(riskLevel: string | null | undefined): number {
  const lvl = (riskLevel ?? "").toLowerCase();
  return lvl === "critical" || lvl === "high" ? 2 : 3;
}

// Master Prompt v3.5 (Vladimir 2026-06-12): among valid Frozen rates take the
// cheapest, BUT prefer a faster one when it costs no more than this many
// dollars MORE (absolute, not percentage). "$3 on a $13 rate is 23% — sounds
// like a lot by percent, but it's pennies for a day-earlier delivery, so take
// it; the same 25% on a $32 rate is +$8 and not worth it. Judge in dollars."
const FROZEN_SPEED_TOLERANCE_USD = 3;

// Master Prompt v3.5: the Monday-shift wins only when shipping Monday is more
// than this fraction CHEAPER than shipping today (or when today has no valid
// rate at all). Below the threshold we just ship today.
const MONDAY_SHIFT_MIN_SAVING_PCT = 0.15;

function selectBestRate(
  rates: VeeqoRate[],
  productType: string,
  deliveryBy: string,
  actualShipDay: string,
  dayName: string,
  isAfterNoon: boolean,
  frozenRiskLevel: string | null = null
): { rate: VeeqoRate | null; diagnostic: string | null } {
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

  if (enriched.length === 0) return { rate: null, diagnostic: null };

  // ── FROZEN (Master Prompt v3.5 — Vladimir 2026-06-12) ──
  //
  // A rate is VALID on exactly two conditions:
  //   1. EDD ≤ marketplace deadline  (already enforced in `enriched`)
  //   2. transit within the frozen window: calDays(EDD − shipDay) ≤ cap
  //      (cap = 2 when the destination is hot/critical, else 3)
  // Nothing else. All the old carrier exclusions (Ground Saver / Ground
  // Economy / tender-to-USPS), the Friday-FedEx-Express ban, the "no ground on
  // Wednesday" rule, and the percentage tolerance band were REMOVED per
  // Vladimir's explicit simplification — those two conditions are the whole
  // food-safety gate.
  //
  // Among valid rates: take the CHEAPEST, but prefer a faster one (fewer cal
  // days) when it costs no more than $FROZEN_SPEED_TOLERANCE_USD ABSOLUTE above
  // the cheapest (judge in dollars, not percent — see the constant's comment).
  if (productType === "Frozen") {
    const maxCalDays = frozenMaxCalDays(frozenRiskLevel);
    const pool = enriched.filter((r) => r.calDays <= maxCalDays);
    if (pool.length === 0) return { rate: null, diagnostic: null };

    const cheapest = Math.min(...pool.map((r) => r.price));
    const candidates = pool.filter(
      (r) => r.price - cheapest <= FROZEN_SPEED_TOLERANCE_USD,
    );
    candidates.sort((a, b) => {
      if (a.calDays !== b.calDays) return a.calDays - b.calDays; // fewer days first
      const dt = a.eddDate.getTime() - b.eddDate.getTime();
      if (dt !== 0) return dt; // earlier EDD
      return a.price - b.price; // then cheaper
    });

    // Diagnostic — a short trace the route handler attaches to planItem.notes
    // (visible in UI). Returned (not a module global) so the per-order loop can
    // run in parallel without races.
    let diagnostic: string | null = null;
    try {
      const cand = candidates
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d/${r.eddLocal}`);
      const riskTag =
        maxCalDays === 2 ? `risk=${(frozenRiskLevel ?? "").toLowerCase()}→max2d ` : "";
      const summary =
        `[frozen-rate v3.5] day=${dayName} ship=${actualShipDay} ` +
        `${riskTag}cap=${maxCalDays}d cheapest=$${cheapest.toFixed(2)} ` +
        `tol=$${FROZEN_SPEED_TOLERANCE_USD} cand=[${cand.join(" | ")}] ` +
        `picked=${candidates[0]?.title}/$${candidates[0]?.price.toFixed(2)}/${candidates[0]?.calDays}d/${candidates[0]?.eddLocal}`;
      console.log(summary);
      diagnostic = summary;
    } catch {
      /* logging must never break the buy flow */
    }
    return { rate: candidates[0], diagnostic };
  }

  // ── DRY ──
  //
  // Strict cheapest-that-meets-deadline. Previous version applied two
  // adjustments inherited from MASTER_PROMPT v3.1:
  //   - drop USPS after 12:00 ET (drop-off cut-off concern)
  //   - prefer UPS within 10% of cheapest (tracking reliability)
  // Both were removed by Vladimir's explicit decision on 2026-05-14: the
  // operator now picks the cheapest carrier regardless of who it is, and
  // does the cut-off / reliability judgement themselves looking at the
  // alt-rates list.
  // (isAfterNoon kept in the signature so call sites don't churn if the
  //  time-of-day rule comes back.)
  void isAfterNoon;
  // (No empty-pool guard here — the `enriched.length === 0` return near the top
  // of selectBestRate already covers it before the Frozen/Dry split.)
  const pool = [...enriched].sort((a, b) => a.price - b.price);
  return { rate: pool[0], diagnostic: null };
}

// ── Main handler ──
export async function GET(request: NextRequest) {
  try {
    // Optional CSV filter — `?orderIds=…` re-runs plan formation only for
    // the listed Veeqo order ids. Used by the rebuilt Shipping Labels UI
    // when an individual card needs to be refreshed after the operator
    // resolves its classification / packing profile.
    const orderIdsParam = request.nextUrl?.searchParams.get("orderIds");
    const orderIdFilter = orderIdsParam
      ? new Set(
          orderIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
        )
      : null;

    // Optional `?shipDate=YYYY-MM-DD` — the operator manually picked a
    // physical dispatch day (inline card picker / rate modal). When set we
    // quote EVERY filtered order at exactly that day (PUT dispatch → live
    // re-quote → restore) and SKIP the auto Monday-shift — they chose the
    // day, so we honour it and just recompute the best rate for it. Only
    // honoured alongside an orderIds filter (it's a per-card refresh, never
    // the full-dashboard pass). Absent ⇒ zero behaviour change.
    const shipDateParam = request.nextUrl?.searchParams.get("shipDate");
    const shipDateOverride =
      orderIdFilter && shipDateParam && /^\d{4}-\d{2}-\d{2}$/.test(shipDateParam)
        ? shipDateParam
        : null;

    const today = getTodayNY();
    const dayInfo = getDayInfo(today);
    const { isWeekend: weekend, actualShipDay, dispatchTarget } = dayInfo;
    const nowNY = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const isAfterNoon = nowNY.getHours() >= 12;

    let skuDatabase: SkuRow[] = [];
    // SKU data lives in the internal DB (SkuShippingData) since the
    // 2026-05-12 Google Sheets migration. A non-empty skuLoadError almost
    // always means a DB connectivity issue; previously it could also mean
    // missing GOOGLE_SHEETS_* env vars (now irrelevant).
    let skuLoadError: string | null = null;
    try {
      skuDatabase = await fetchSkuDatabase();
    } catch (e) {
      skuLoadError = e instanceof Error ? e.message : String(e);
      console.error("Failed to fetch SKU database:", e);
    }
    const skuConfigStatus = skuLoadError ? "load-failed" : "ok";

    const orders = await fetchAllOrders();

    // Pull pending FrozenRiskAlert rows for every order we're about to
    // quote, keyed by Veeqo order number — selectBestRate uses the
    // riskLevel to tighten the Frozen calendar-day cap from 3 to 2
    // when an order is `critical` (Master Prompt v3.4 §5). One round
    // trip up front beats N queries inside the loop. Multiple alerts
    // per order can exist (different ship dates); we keep the highest
    // riskLevel so the cap conservatively reflects the worst forecast.
    const orderNumbersForRisk: string[] = orders
      .map((o: { number?: string | number }) => String(o.number ?? "").trim())
      .filter(Boolean);
    const frozenRiskByOrderNumber = new Map<string, string>();
    if (orderNumbersForRisk.length > 0) {
      try {
        const alertRows = await prisma.frozenRiskAlert.findMany({
          where: {
            orderId: { in: orderNumbersForRisk },
            status: "pending",
          },
          select: { orderId: true, riskLevel: true },
        });
        // Rank order matches LEVEL_ORDER in src/lib/frozen-analytics/rules-engine.ts.
        const RANK: Record<string, number> = {
          ok: 0, low: 1, medium: 2, high: 3, critical: 4,
        };
        for (const row of alertRows) {
          const lv = (row.riskLevel ?? "").toLowerCase();
          const cur = frozenRiskByOrderNumber.get(row.orderId);
          if (!cur || (RANK[lv] ?? -1) > (RANK[cur] ?? -1)) {
            frozenRiskByOrderNumber.set(row.orderId, lv);
          }
        }
      } catch (e) {
        // Non-fatal — falls back to the standard ≤3-day cap.
        console.warn(
          "[plan] frozenRiskAlert lookup failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    // Debug
    const debug = {
      totalFromVeeqo: orders.length,
      today,
      dispatchTarget,
      dayName: dayInfo.dayName,
      isWeekend: weekend,
      isAfterNoon,
      skuCount: skuDatabase.length,
      skuLoadError,
      skuConfigStatus,
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
      orderNumber: string; orderId: string; channel: string;
      channelKind: string; product: string;
      sku: string; qty: number; productType: string; _productId: number | null;
      weight: number | null; boxSize: string | null; budgetMax: number | null;
      carrier: string | null; service: string | null; price: number | null;
      edd: string | null; deliveryBy: string;
      // v3.3 dual-date model (§0.1):
      //   labelDate         = date Amazon sees on the printed label
      //   physicalShipDate  = day warehouse hands package to carrier
      //   shipDateTrickApplied = true when these two diverge (Frozen
      //     Monday-shift) — used by UI to flag the card and by buy
      //     flow to know the dispatch_date dance is needed.
      // `actualShipDay` is kept around for backward-compat with the
      // existing DB column + readers; new code should prefer
      // `physicalShipDate`.
      labelDate: string;
      physicalShipDate: string;
      shipDateTrickApplied: boolean;
      actualShipDay: string;
      notes: string | null; status: string;
      allocationId: string | null; carrierId: string | null;
      remoteShipmentId: string | null; serviceType: string | null;
      subCarrierId: string | null; serviceCarrier: string | null;
      totalNetCharge: string | null; baseRate: string | null;
    }> = [];

    // ── Pre-warm rate quotes in parallel ──────────────────────────────────
    // The dominant per-order latency in the loop below is the sequential
    // `getShippingRates` round-trip — with N ready orders that was N calls in
    // series (the source of the "shipping page is slow" lag). Fetch them
    // concurrently up front, keyed by allocationId, so the loop reads from
    // this cache instead of awaiting. Purely an optimization: the loop falls
    // back to a direct fetch on any cache miss, so the result is identical
    // even if these gates ever drift from the loop's. The Frozen Monday-shift
    // refetch is deliberately NOT cached — it mutates dispatch_date first and
    // must quote live.
    const ratesByAlloc = new Map<
      string,
      Awaited<ReturnType<typeof getShippingRates>>
    >();
    {
      const warmAllocIds = new Set<string>();
      for (const order of orders) {
        if (orderIdFilter && !orderIdFilter.has(String(order.id))) continue;
        const ct = (order.channel?.type_code || "").toLowerCase();
        if (ct === "walmart") continue; // Walmart quotes via its own path
        const placed =
          order.tags?.some((t: { name: string }) => t.name === "Placed") ||
          ct === "shopify";
        if (!placed) continue;
        if (
          !orderIdFilter &&
          (!order.dispatch_date ||
            veeqoDateToLocal(order.dispatch_date) !== dispatchTarget)
        )
          continue;
        if (String(order.status ?? "").toLowerCase() === "shipped") continue;
        const allocId = order.allocations?.[0]?.id;
        if (allocId) warmAllocIds.add(String(allocId));
      }
      await mapPool([...warmAllocIds], 6, async (id) => {
        try {
          ratesByAlloc.set(id, await getShippingRates(id));
        } catch {
          // Leave uncached — the loop's direct fetch re-runs it and surfaces
          // the real error in context.
        }
      });
    }

    // Process orders concurrently. Each order now ALWAYS runs the Frozen
    // Monday re-quote (mutate dispatch_date → re-quote → restore, ~1.5s of
    // Veeqo round-trips), so a sequential loop would stack that per Frozen
    // row and make the page crawl. A bounded pool overlaps them. Safe to
    // parallelize: the only cross-order writes are `planItems.push` (order-
    // independent — the response is keyed by orderNumber) and the atomic
    // `debug.filters.*++` counters; selectBestRate no longer uses a module
    // global, and each order mutates only its OWN allocation/dispatch_date.
    // Kept modest (5) to stay under Veeqo's burst rate-limit given the extra
    // dispatch-date writes the Monday dance adds on top of the dim push.
    const PLAN_LOOP_CONCURRENCY = 5;
    await mapPool(orders, PLAN_LOOP_CONCURRENCY, async (order) => {
      // When the caller passed an explicit orderIds filter, only process
      // those rows (lets the UI cheap-refresh a single card).
      if (orderIdFilter && !orderIdFilter.has(String(order.id))) return;

      // Shopify channels are third-party clients (NAN health and similar)
      // whose products live in our warehouse — they skip the supplier-
      // procurement workflow, so the Placed tag never gets set on them
      // and the dashboard treats them as Placed implicitly. Mirror that
      // here so /api/shipping/plan also rate-quotes them without the gate.
      const planChannelType = (order.channel?.type_code || "").toLowerCase();
      const planIsShopify = planChannelType === "shopify";
      const hasPlaced = order.tags?.some(
        (t: { name: string }) => t.name === "Placed"
      );
      if (!hasPlaced && !planIsShopify) return;
      debug.filters.afterPlacedTag++;

      const shipBy = veeqoDateToLocal(order.dispatch_date);
      // The orderIds filter overrides the "today only" gate so refreshes
      // work for orders that aren't on today's dispatch date (e.g. a card
      // the operator just changed packing for).
      if (!orderIdFilter && shipBy !== dispatchTarget) return;
      debug.filters.afterDispatchDate++;

      const channel = order.channel?.name || "";
      const channelType = (order.channel?.type_code || "").toLowerCase();
      // Veeqo-merged orders get channel.name = "Merged Orders" and
      // channel.type_code = "direct" — but the underlying source orders are
      // always Amazon (Walmart orders can't be merged in Veeqo), and we buy
      // labels for them through the same Amazon Buy Shipping path. Treat
      // the merge bucket as Amazon-equivalent.
      const isMergedAmazon = channel === "Merged Orders";
      const isAmazon = channelType === "amazon" || isMergedAmazon;
      const isWalmart = channelType === "walmart";
      // Everything else (eBay, TikTok, Shopify, Etsy, direct…) rate-shops
      // through Veeqo just like Amazon — same /shipping/rates endpoint,
      // same selectBestRate logic. We default to the Amazon-style path
      // for them so a new marketplace works out of the box without a
      // dedicated branch here. (Walmart still uses its own /walmart/rates
      // flow because Buy-with-Walmart bypasses Veeqo entirely.)
      if (!channelType && !isMergedAmazon) {
        // No channel info at all — skip (defensive; in practice every
        // Veeqo order has a channel).
        return;
      }
      debug.filters.afterChannel++;

      if (isWalmart && weekend) return;
      debug.filters.afterWalmartWeekend++;

      // Duplicate-purchase guard: trust Veeqo's order.status, NOT the
      // "Label Purchased" employee note. The note is append-only in
      // Veeqo (see veeqo-api-quirks §3), so a cancelled-and-refunded
      // label still leaves the note in place — using the note made
      // cancelled orders permanently invisible to /plan. Veeqo's status
      // is set to "shipped" on label purchase and reverts to
      // "awaiting_fulfillment" when the label is cancelled — exactly
      // the signal we want.
      const orderStatus = String(order.status ?? "").toLowerCase();
      if (orderStatus === "shipped") return;
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
              } else if (!isAmazon) {
                // TikTok / eBay / Shopify / direct — these channels only
                // sell Dry goods (supplements, accessories) in this op;
                // the Frozen/Dry classification gate exists for Amazon's
                // food-safety 3-day rule and isn't meaningful here. Default
                // to Dry instead of stopping the plan; the operator can
                // still flip to Frozen manually via Set Frozen/Dry if a
                // frozen item ever ships on these channels.
                productType = "Dry";
              } else {
                stopReason = `Missing Frozen/Dry tag (tags: ${tagNames.join(", ") || "none"})`;
              }
            } else if (!isAmazon) {
              // Non-Amazon order with no product_id resolved (Veeqo
              // sometimes returns eBay/TikTok line_items in a different
              // shape) — still safe to assume Dry.
              productType = "Dry";
            } else {
              stopReason = "No product_id in line_items";
            }
          } catch (e) {
            stopReason = `Could not fetch product tags: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }

      // ── SKU lookup OR PackingProfile lookup for multi-item orders ──
      //
      // Single-line + qty=1 → use SkuShippingData (per-SKU box+weight).
      // Multi-line OR qty>1  → use PackingProfile keyed by composition
      //                        signature. Profile is set up once by the
      //                        operator via /api/shipping/packing-profile.
      const orderLines: Array<{
        sku: string;
        quantity: number;
        fallbackId: number | null;
      }> = (order.line_items ?? [])
        .map(
          (li: {
            sellable?: {
              sku_code?: string;
              sku?: string;
              id?: number;
              product_id?: number;
              product?: { id?: number };
            };
            quantity?: number;
          }) => ({
            sku: String(li?.sellable?.sku_code ?? li?.sellable?.sku ?? ""),
            quantity: Number(li?.quantity ?? 1),
            // Same fallback the dashboard uses (sellable.product.id ??
            // product_id ?? sellable.id) so SKU-less Shopify/eBay lines key on
            // a stable id and match the saved packing profile.
            fallbackId:
              (typeof li?.sellable?.product?.id === "number"
                ? li.sellable.product.id
                : typeof li?.sellable?.product_id === "number"
                  ? li.sellable.product_id
                  : typeof li?.sellable?.id === "number"
                    ? li.sellable.id
                    : null),
          }),
        )
        // Keep a line if it has EITHER a SKU or a fallback id — dropping
        // SKU-less lines here made requiresPackingProfile() see an empty list.
        .filter(
          (i: { sku: string; quantity: number; fallbackId: number | null }) =>
            i.sku || i.fallbackId != null,
        );

      const firstSku =
        order.line_items?.[0]?.sellable?.sku_code ||
        order.line_items?.[0]?.sellable?.sku ||
        "";
      let skuWeight: number | null = null;
      let skuBoxSize: string | null = null;

      if (requiresPackingProfile(orderLines)) {
        const signature = buildPackingSignature(orderLines);
        const profile = await prisma.packingProfile.findUnique({
          where: { signature },
        });
        if (!profile) {
          stopReason = `Multi-item order — no PackingProfile for "${signature}"`;
        } else {
          skuWeight = profile.weight;
          skuBoxSize = profile.boxSize;
        }
      } else {
        const skuData = skuDatabase.find((r) => r.sku === firstSku) || null;
        // For Amazon orders our local SkuShippingData is the source of
        // truth — we push those dims to Veeqo and quote from them, so
        // missing data here is genuinely a blocker.
        //
        // For eBay/TikTok/Shopify/Etsy/direct, Vladimir packs in Veeqo's
        // own UI (the allocation_package field on the Veeqo allocation).
        // The Veeqo screenshot for order 02-14738-90816 confirms this:
        // package is 2 lbs / 1x1x1 in Veeqo, and a full slate of carrier
        // rates is available — but our local SkuShippingData has no row
        // for this SKU, so the old "SKU not in SKU Database" stop fired
        // and the row never got a rate.
        //
        // Fix: skip the missing-SKU stop for non-Amazon channels. We
        // still use skuData when it exists (to optionally re-push the
        // allocation_package below), but never block on its absence —
        // Veeqo's existing package is fine.
        if (!stopReason && !skuData && isAmazon) {
          stopReason = `SKU ${firstSku} not in SKU Database`;
        } else if (!stopReason && skuData && !skuData.hasCompleteData && isAmazon) {
          stopReason = `SKU ${firstSku}: missing weight/dimensions`;
        } else if (skuData) {
          skuWeight = skuData.weight;
          if (skuData.length && skuData.width && skuData.height) {
            skuBoxSize = `${skuData.length}x${skuData.width}x${skuData.height}`;
          }
        }
      }

      // due_date is the Amazon-promised deliver-by deadline; on TikTok
      // and eBay orders Veeqo doesn't get one back (the platforms don't
      // expose a per-order delivery deadline the way Amazon does), so the
      // field comes back null. Passing that to `veeqoDateToLocal` produces
      // "1969-12-31" (epoch zero in PT) and the rate filter then rejects
      // every rate because no EDD is ≤ 1969 — that's the
      // "No rate where EDD ≤ Delivery By (1969-12-31)" stop the operator
      // sees on TikTok rows. For non-Amazon channels, fall back to a
      // generous deliver-by window anchored on dispatch_date — gives
      // selectBestRate freedom to pick cheapest without a hard deadline
      // (TikTok/eBay don't enforce marketplace deadlines like Amazon).
      let deliveryBy: string;
      if (order.due_date) {
        deliveryBy = veeqoDateToLocal(order.due_date);
      } else {
        // dispatch_date + 10 days as a sane default. Operator can still
        // see the EDD on the picked rate; the marketplace doesn't gate
        // them on a deadline so we just need any future date.
        const dispatchDay = order.dispatch_date
          ? veeqoDateToLocal(order.dispatch_date)
          : actualShipDay;
        const baseDate = new Date(`${dispatchDay}T12:00:00`);
        baseDate.setDate(baseDate.getDate() + 10);
        const y = baseDate.getFullYear();
        const m = String(baseDate.getMonth() + 1).padStart(2, "0");
        const d = String(baseDate.getDate()).padStart(2, "0");
        deliveryBy = `${y}-${m}-${d}`;
      }
      const allocationId = order.allocations?.[0]?.id;

      // ── Get rates & select best ──
      let selectedRate: VeeqoRate | null = null;
      let shipDateNote: string | null = null;
      let frozenRateDebug: string | null = null;

      // Per-order diagnostic for non-Amazon-non-Walmart paths. We log
      // every gate the order passes/fails so we can see in Vercel logs
      // exactly why an eBay/TikTok/Shopify row stays at "loading…" or
      // "Awaiting rate". The Amazon path is well-trodden and already
      // logged via [frozen-rate].
      const isAlt = !isAmazon && !isWalmart;
      if (isAlt) {
        console.log(
          `[plan-alt] order=${order.number} channelType=${channelType} ` +
            `allocationId=${allocationId ?? "none"} stopReason=${stopReason ?? "none"} ` +
            `skuWeight=${skuWeight ?? "null"} skuBoxSize=${skuBoxSize ?? "null"} ` +
            `productType=${productType}`,
        );
      }

      // Push OUR catalog dims (SkuShippingData / PackingProfile) into the
      // Veeqo allocation_package before quoting — for EVERY Veeqo channel,
      // Amazon included.
      //
      // This used to be gated on `isAlt` (non-Amazon only), on the
      // assumption that "Veeqo's native Amazon integration supplies dims
      // automatically". That assumption is WRONG and was the root cause of
      // labels printing at the wrong weight/box (e.g. card showed 10lbs /
      // 12×12×10 but the UPS label came out 7lbs / 10×8×6 — Veeqo's empty-
      // package default). The operator sets the package size in OUR catalog
      // and Veeqo must be told it for ANY channel; Amazon's own declared
      // dims are irrelevant to the label we buy. The quote below uses
      // `from_allocation_package=true`, so the rate (and thus the bought
      // label) only matches the card when we push first. Best-effort: a
      // push failure doesn't stop the quote.
      //
      // Walmart-via-Walmart orders have no Veeqo allocationId, so the
      // `allocationId` guard skips them automatically (they're rate-shopped
      // + bought through Walmart's own API).
      if (
        !stopReason &&
        allocationId &&
        skuWeight != null &&
        skuBoxSize
      ) {
        // resolveBoxDimensions handles BOTH "LxWxH" AND named presets ("XL",
        // "M", …). The old raw regex only matched "LxWxH", so a named box like
        // "XL" silently skipped the push and the order quoted against Veeqo's
        // stale package — e.g. 112-0136653 (32lb XL) quoted as a tiny 10×8×6
        // box, surfacing a bogus $17.78 FedEx 2Day One Rate flat price.
        const dims = resolveBoxDimensions(skuBoxSize);
        if (dims) {
          try {
            await updateAllocationPackage(allocationId, {
              weightLbs: skuWeight,
              lengthIn: dims.length,
              widthIn: dims.width,
              heightIn: dims.height,
            });
            console.log(
              `[plan] ${order.number} allocation_package pushed: ${dims.length}x${dims.width}x${dims.height} ${skuWeight}lbs`,
            );
          } catch (e) {
            console.warn(
              `[plan] ${order.number} allocation_package push FAILED:`,
              e instanceof Error ? e.message : e,
            );
          }
        } else {
          console.warn(
            `[plan] ${order.number} skuBoxSize="${skuBoxSize}" not resolvable to dims — skipping package push`,
          );
        }
      }

      // For a shipDate override on the OLD path we move dispatch_date and
      // restore it in the finally below; the new Rate Shopping API needs no
      // such mutation.
      const overrideOrigDispatch: string | undefined =
        shipDateOverride && !stopReason && allocationId
          ? order.dispatch_date
          : undefined;
      if (!stopReason && allocationId) {
        try {
          // Frozen risk lookup — null when no alert / not Frozen, so
          // selectBestRate's default ≤3-day cap applies.
          const frozenRiskLevel =
            frozenRiskByOrderNumber.get(String(order.number)) ?? null;
          // Ship day driving the rate math: operator's forced date when present,
          // else today's computed dispatch day.
          const effectiveShipDay = shipDateOverride || actualShipDay;
          const effectiveDayName = shipDateOverride
            ? getDayInfo(shipDateOverride).dayName
            : dayInfo.dayName;

          // Frozen Amazon quotes through the NEW Rate Shopping API
          // (getRatesForShipDate → POST /shipping/api/v1/rates) so EDDs are
          // anchored to the real physical ship day via `preferred_shipment_date`
          // — the lever the old /shipping/rates endpoint lacks. See
          // MASTER_PROMPT_v3.5 §7 + wiki/veeqo-rate-shopping-api.md. Everything
          // else keeps the old allocation-rates path (Dry needs no date
          // anchoring; non-Amazon packs dims in Veeqo).
          const useNewRateApi = productType === "Frozen" && isAmazon;
          // Parcel for the new API, built from OUR catalog dims (lbs → oz).
          // resolveBoxDimensions handles named presets ("XL") too — without it a
          // named box fell through to the stale-allocation fallback and mispriced
          // the rate (see 112-0136653).
          const newApiParcel = (() => {
            if (skuWeight == null || !skuBoxSize) return undefined;
            const d = resolveBoxDimensions(skuBoxSize);
            return d
              ? {
                  weightOz: skuWeight * 16,
                  lengthIn: d.length,
                  widthIn: d.width,
                  heightIn: d.height,
                }
              : undefined;
          })();

          let rates: VeeqoRate[];
          if (useNewRateApi) {
            const resp = await getRatesForShipDate(
              order,
              `${effectiveShipDay}T16:00:00Z`,
              newApiParcel,
            );
            rates = resp.available as unknown as VeeqoRate[];
          } else {
            if (shipDateOverride) {
              try {
                await updateOrderDispatchDate(
                  order.id,
                  `${shipDateOverride}T06:59:59.000Z`,
                );
                await new Promise((r) => setTimeout(r, 800));
              } catch (e) {
                console.warn(
                  `[plan] shipDate override dispatch PUT failed for ${order.id}:`,
                  e instanceof Error ? e.message : e,
                );
              }
            }
            const ratesResponse = shipDateOverride
              ? await getShippingRates(String(allocationId))
              : (ratesByAlloc.get(String(allocationId)) ??
                (await getShippingRates(String(allocationId))));
            rates = ratesResponse?.available || [];
          }

          if (isAlt) {
            console.log(
              `[plan-alt] ${order.number} rates returned: ${rates.length}` +
                (rates.length > 0
                  ? ` (sample: ${rates.slice(0, 3).map((r) => `${r.sub_carrier_id}/${r.title}/$${r.total_net_charge}`).join(" | ")})`
                  : " — EMPTY → row will stay at 'Awaiting rate'"),
            );
          }

          const todaySel = selectBestRate(
            rates,
            productType,
            deliveryBy,
            effectiveShipDay,
            effectiveDayName,
            isAfterNoon,
            frozenRiskLevel,
          );
          selectedRate = todaySel.rate;
          if (productType === "Frozen" && todaySel.diagnostic) {
            frozenRateDebug = `today: ${todaySel.diagnostic}`;
          }

          // Surface a stopReason for non-Amazon orders whose rate quote
          // came back empty, so the UI shows "stopped: Veeqo returned 0
          // rates" instead of "Awaiting rate" forever. Without this the
          // operator has no way to tell whether the row is mid-load or
          // genuinely blocked.
          if (isAlt && !selectedRate) {
            if (rates.length === 0) {
              stopReason =
                `Veeqo returned 0 rates — most likely no allocation_package` +
                ` configured. Check Veeqo allocation ${allocationId}.`;
            } else {
              stopReason =
                `${rates.length} rate(s) available but none passed the` +
                ` deadline/type filter (deliveryBy=${deliveryBy}, type=${productType}).`;
            }
            console.warn(
              `[plan-alt] ${order.number} → ${stopReason}`,
            );
          }

          // ── Ship Date Trick (Frozen only — Master Prompt v3.5) ──────────
          //
          // Quote next Monday through the SAME new Rate Shopping API (real
          // date-anchored EDDs via preferred_shipment_date — NO dispatch_date
          // mutation, no 800ms waits, no restore). Then per v3.5: take Monday
          // ONLY when today has no valid rate, OR Monday is more than
          // MONDAY_SHIFT_MIN_SAVING_PCT cheaper than today. The physical ship
          // day is invisible to Amazon (labelDate stays today), so this is a
          // pure savings decision.
          //   * monDeadlineDays >= 1 — Monday must still beat the deadline.
          //   * dayInfo.dayName !== "Mon" — today IS Monday → "next Monday" is a
          //     full week out, don't shift.
          const nextMonday = nextMondayFrom(today);
          const monDeadlineDays = nextMonday
            ? Math.round(
                (new Date(deliveryBy + "T00:00:00").getTime() -
                  new Date(nextMonday + "T00:00:00").getTime()) /
                  86_400_000
              )
            : -1;
          const tryMonday =
            !shipDateOverride &&
            productType === "Frozen" &&
            isAmazon &&
            monDeadlineDays >= 1 &&
            dayInfo.dayName !== "Mon";

          if (tryMonday) {
            try {
              const mondayResp = await getRatesForShipDate(
                order,
                `${nextMonday}T16:00:00Z`,
                newApiParcel,
              );
              const mondayRates = mondayResp.available as unknown as VeeqoRate[];
              const mondaySel = selectBestRate(
                mondayRates,
                productType,
                deliveryBy,
                nextMonday,
                "Mon",
                false,
                frozenRiskLevel,
              );
              const mondayPick = mondaySel.rate;
              const todayPrice = selectedRate
                ? parseFloat(selectedRate.total_net_charge)
                : Infinity;
              const mondayPrice = mondayPick
                ? parseFloat(mondayPick.total_net_charge)
                : Infinity;
              // Transit days (= calendar days in transit) for each pick, from
              // its OWN ship day. Fewer transit days = less thaw risk for frozen.
              const transitDays = (rawEdd: string, shipYmd: string) =>
                Math.round(
                  (new Date(veeqoDateToLocal(rawEdd) + "T00:00:00").getTime() -
                    new Date(shipYmd + "T00:00:00").getTime()) /
                    86_400_000,
                );
              const todayTransit = selectedRate
                ? transitDays(selectedRate.delivery_promise_date, actualShipDay)
                : Infinity;
              const mondayTransit = mondayPick
                ? transitDays(mondayPick.delivery_promise_date, nextMonday)
                : Infinity;

              // Choose today vs Monday (Master Prompt v3.5 — refined by Vladimir
              // 2026-06-12). Both already meet deadline + window. We NEVER pick a
              // Monday that delivers in MORE transit days than today (a slower
              // delivery is unacceptable even for a big saving — Vladimir). Take
              // Monday only if:
              //   1. there's no valid rate today, OR
              //   2. Monday is FASTER in transit (fewer days → safer for frozen)
              //      AND no more than $FROZEN_SPEED_TOLERANCE_USD pricier (same $3
              //      speed rule, applied across ship days), OR
              //   3. Monday is NOT slower (same transit days) AND is
              //      >MONDAY_SHIFT_MIN_SAVING_PCT cheaper — a big saving at no
              //      delivery-speed cost.
              // Otherwise keep today.
              let takeMonday = false;
              let switchReason = "";
              if (mondayPick && !selectedRate) {
                takeMonday = true;
                switchReason = "no on-time rate from today";
              } else if (mondayPick && selectedRate) {
                if (
                  mondayTransit < todayTransit &&
                  mondayPrice <= todayPrice + FROZEN_SPEED_TOLERANCE_USD
                ) {
                  takeMonday = true;
                  switchReason =
                    `faster ${mondayTransit}d vs ${todayTransit}d transit` +
                    ` (Mon $${mondayPrice.toFixed(2)} vs $${todayPrice.toFixed(2)})`;
                } else if (
                  mondayTransit <= todayTransit &&
                  mondayPrice < todayPrice * (1 - MONDAY_SHIFT_MIN_SAVING_PCT)
                ) {
                  takeMonday = true;
                  switchReason =
                    `${Math.round((1 - mondayPrice / todayPrice) * 100)}% cheaper` +
                    ` same ${mondayTransit}d transit ($${todayPrice.toFixed(2)}→$${mondayPrice.toFixed(2)})`;
                }
              }
              // else: Monday is slower, or not enough cheaper at the same speed →
              // keep today. A slower Monday is never chosen.

              if (takeMonday && mondayPick) {
                selectedRate = mondayPick;
                if (mondaySel.diagnostic) frozenRateDebug = `mon: ${mondaySel.diagnostic}`;
                shipDateNote = `Shifted to Mon ${nextMonday}: ${switchReason}`;
              }
            } catch (e) {
              // Trick failed — keep today's pick. The new API doesn't mutate the
              // order, so there is nothing to restore.
              console.warn(
                "Ship Date Trick (rate-shopping API) failed for order",
                order.id,
                e instanceof Error ? e.message : e,
              );
            }
          }

          if (!selectedRate && !stopReason) {
            // Two distinct "no rate" reasons — surface the right one so
            // the operator can act (Frozen needs different action than
            // Dry — typically manual Veeqo purchase with a deadline
            // override, vs no carrier serves at all).
            if (productType === "Frozen") {
              // Count rates that DO meet deadline so we can tell apart
              // "no rate at all" from "no rate within 3 cal days".
              const meetingDeadline = rates.filter((r) => {
                const eddLocal = veeqoDateToLocal(r.delivery_promise_date);
                const eddDate = new Date(eddLocal + "T00:00:00");
                return eddDate <= new Date(deliveryBy + "T23:59:59");
              }).length;
              const maxCalDays = frozenMaxCalDays(frozenRiskLevel);
              const riskTag =
                maxCalDays === 2 ? " — risk=CRITICAL tightens cap to 2 days" : "";
              stopReason =
                meetingDeadline > 0
                  ? `Frozen — none of ${meetingDeadline}/${rates.length} on-time rates deliver within ${maxCalDays} calendar days (food safety)${riskTag}. Monday-shift trick also didn't help.`
                  : `No rate where EDD ≤ Delivery By (${deliveryBy}). ${rates.length} rates checked.`;
            } else {
              // Dry: no carrier delivers by the deadline. Spell out the
              // soonest available delivery + how many days late it is, so the
              // operator instantly sees the situation (often a rural ZIP or a
              // PO Box that only USPS serves) and knows the order CAN still
              // ship — just late — via a manual rate pick. Beats the old
              // cryptic "No rate where EDD ≤ …" that read like a hard failure.
              const soonest = rates
                .map((r) => veeqoDateToLocal(r.delivery_promise_date))
                .filter((d): d is string => !!d)
                .sort()[0];
              if (soonest) {
                const lateDays = Math.round(
                  (new Date(soonest + "T00:00:00").getTime() -
                    new Date(deliveryBy + "T00:00:00").getTime()) /
                    86_400_000,
                );
                stopReason =
                  `No on-time rate — deadline ${deliveryBy}, soonest delivery ${soonest}` +
                  (lateDays > 0
                    ? ` (${lateDays} day${lateDays === 1 ? "" : "s"} late)`
                    : "") +
                  `. ${rates.length} rates checked. Pick a rate to ship anyway.`;
              } else {
                stopReason = `No rate where EDD ≤ Delivery By (${deliveryBy}). ${rates.length} rates checked.`;
              }
            }
          }
        } catch (e) {
          stopReason = `Rates error: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          // Restore the dispatch_date we moved for a shipDate override. The
          // real dispatch is re-applied at purchase time in /api/shipping/buy
          // from the plan item's physicalShipDate, so Veeqo state must be left
          // unchanged here.
          if (shipDateOverride && overrideOrigDispatch) {
            try {
              await updateOrderDispatchDate(order.id, overrideOrigDispatch);
            } catch (e) {
              console.error(
                `CRITICAL: failed to restore dispatch_date after shipDate override on ${order.id} — left at ${shipDateOverride}. Original: ${overrideOrigDispatch}`,
                e
              );
            }
          }
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

      // v3.3 §0.1 — derive labelDate per-order from shipBy + cutoff.
      // For now we keep the legacy actualShipDay calculation in
      // parallel for the storage column; physicalShipDate is the
      // truth for new readers. shipDateTrickApplied tells the UI to
      // flag the card and the buy flow to do the dispatch-date dance.
      const labelDate = computeLabelDate(shipBy);
      const autoTrick = Boolean(shipDateNote); // auto Monday-shift fired
      // A manual ship-date override sets the physical ship day directly; the
      // label date stays the Amazon-facing date so LSR isn't affected.
      const physicalShipDate = shipDateOverride
        ? shipDateOverride
        : autoTrick
          ? nextMondayFrom(labelDate)
          : labelDate;
      const legacyActualShipDay = shipDateOverride
        ? shipDateOverride
        : autoTrick
          ? nextMondayFrom(today)
          : actualShipDay;
      // Drive the dual-date UI chip + the buy-time dispatch dance whenever the
      // physical day differs from the label date — auto-shift OR manual override.
      const trickFired = autoTrick || physicalShipDate !== labelDate;

      planItems.push({
        orderNumber: order.number,
        orderId: String(order.id),
        channel,
        channelKind: normalizeChannelKind(channelType),
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
        labelDate,
        physicalShipDate,
        shipDateTrickApplied: trickFired,
        actualShipDay: legacyActualShipDay,
        notes:
          stopReason ||
          [shipDateNote, frozenRateDebug].filter(Boolean).join(" | ") ||
          null,
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
    });

    // ── Already-bought rows: show what was ACTUALLY bought ──────────────
    // Bought orders stay visible in the list (operator wants to see the
    // tracking + what was purchased). But the loop above re-quotes them
    // live, so the row would drift to whatever rate is cheapest NOW —
    // showing e.g. "UPS Ground Saver" on a row whose label is actually
    // "UPS Ground". Overlay the carrier/service/price/edd persisted on the
    // most-recent bought plan item for each order so the row reflects the
    // real purchase. Display-only: the purchase identifiers are untouched,
    // and bought orders aren't selectable for buying anyway.
    const orderNumbersForPlan = planItems
      .map((i) => i.orderNumber)
      .filter((n): n is string => !!n);
    if (orderNumbersForPlan.length > 0) {
      const boughtRecords = await prisma.shippingPlanItem.findMany({
        where: { orderNumber: { in: orderNumbersForPlan }, status: "bought" },
        orderBy: { updatedAt: "desc" },
      });
      const boughtByOrder = new Map<string, (typeof boughtRecords)[number]>();
      for (const b of boughtRecords) {
        if (!boughtByOrder.has(b.orderNumber)) boughtByOrder.set(b.orderNumber, b);
      }
      for (const item of planItems) {
        const b = boughtByOrder.get(item.orderNumber);
        if (!b) continue;
        if (b.carrier != null) item.carrier = b.carrier;
        if (b.service != null) item.service = b.service;
        if (b.price != null) item.price = b.price;
        if (b.edd != null) item.edd = b.edd;
      }
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
            channelKind: item.channelKind,
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
            labelDate: item.labelDate,
            physicalShipDate: item.physicalShipDate,
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

    // Enrich DB items with fields not persisted to DB:
    //   _productId          — used by UI for Frozen/Dry classify flow
    //   shipDateTrickApplied — derived (labelDate != physicalShipDate)
    //                          but we surface it explicitly so the
    //                          client doesn't have to recompute it
    //   datesMatch          — convenience inverse for cards that only
    //                         care about the "trick applied" badge
    const enrichedItems = plan.items.map((dbItem) => {
      const src = planItems.find(
        (p) => p.orderNumber === dbItem.orderNumber
      );
      const datesMatch =
        !!dbItem.labelDate &&
        !!dbItem.physicalShipDate &&
        dbItem.labelDate === dbItem.physicalShipDate;
      return {
        ...dbItem,
        _productId: src?._productId || null,
        shipDateTrickApplied: src?.shipDateTrickApplied ?? !datesMatch,
        datesMatch,
      };
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
