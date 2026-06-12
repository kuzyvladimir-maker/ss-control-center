import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchAllOrders,
  getProduct,
  getShippingRates,
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

// ── Next Monday from a date string ──
function getNextMonday(from: string): string {
  const d = new Date(from + "T12:00:00");
  const dow = d.getDay();
  const daysUntilMon = dow === 0 ? 1 : 8 - dow;
  d.setDate(d.getDate() + daysUntilMon);
  return d.toISOString().split("T")[0];
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

  // ── FROZEN ──
  if (productType === "Frozen") {
    const maxCalDays = frozenMaxCalDays(frozenRiskLevel);
    let pool = enriched.filter((r) => r.calDays <= maxCalDays);

    // Economy "tender-to-carrier" services (UPS Ground Saver / SurePost,
    // FedEx Ground Economy / SmartPost) hand the last mile off to USPS.
    // Amazon's quoted `delivery_promise_date` for them is unreliable — it
    // often comes back as an optimistic ≤3-day date that lets the rate slip
    // past the food-safety filter, then the parcel actually takes ~a week
    // (Veeqo flags both as "Late Delivery Risk"). NEVER acceptable for
    // Frozen regardless of the promised date.
    // (Vladimir 2026-06-09: order 113-2379726-9067420 was auto-picked as
    //  UPS Ground Saver @ $26.49 / EDD Jun 16 / 7-day transit instead of
    //  the correct FedEx Express Saver @ $54.31 / EDD Jun 12 / 3-day.)
    pool = pool.filter(
      (r) =>
        !r.titleLow.includes("ground saver") &&
        !r.titleLow.includes("ground economy") &&
        !r.titleLow.includes("surepost") &&
        !r.titleLow.includes("smartpost") &&
        !r.titleLow.includes("tender to"),
    );

    // Policy (Vladimir 2026-05-15, refined 2026-06-10): don't PAY for faster-
    // than-2-day service the customer didn't buy — but only when "faster"
    // actually costs more. The point was to avoid burning $60+ on Overnight
    // when the customer paid Standard; it was NEVER meant to skip a CHEAPER
    // fast option. So: when there's slack to the deadline (≥2 days), drop a
    // sub-2-day rate ONLY if it costs more than the cheapest ≥2-day rate. A
    // cheaper-or-equal faster rate is kept — it saves money AND, for frozen,
    // spends less time in transit (lower thaw risk). Without this, a $16.09
    // 1-day UPS Ground lost to a $18.38 2-day USPS Priority (pricier AND
    // slower) on order 114-6393545-7904214.
    const shipDt = new Date(actualShipDay + "T00:00:00");
    const deadlineDt = new Date(deliveryBy + "T00:00:00");
    const daysToDeadline = Math.round(
      (deadlineDt.getTime() - shipDt.getTime()) / 86_400_000,
    );
    if (daysToDeadline >= 2) {
      const twoDayPlus = pool.filter((r) => r.calDays >= 2);
      if (twoDayPlus.length > 0) {
        const cheapest2Day = Math.min(...twoDayPlus.map((r) => r.price));
        // Keep all ≥2-day rates; keep a <2-day rate only if it's not pricier
        // than the cheapest 2-day option.
        pool = pool.filter((r) => r.calDays >= 2 || r.price <= cheapest2Day);
      }
      // If there are NO ≥2-day options, leave the pool alone — a faster
      // service is the only way to hit the deadline.
    }

    // (Removed the old "no ground on Wednesday" rule — Vladimir 2026-06-10.)
    // It dropped EVERY ground-titled rate on Wednesdays on the assumption
    // "ground from Wed = 3 business = 5 calendar days," judging by service
    // NAME instead of the actual quoted date. But the calendar-day cap above
    // (`calDays <= maxCalDays`, already tightened to 2 days for hot/critical
    // destinations) is the real food-safety gate: it works off Veeqo's
    // quoted EDD, so any ground rate still in the pool DOES deliver within
    // the weather-aware window. The rule was wrongly rejecting a standard
    // UPS Ground that Veeqo quoted at the SAME delivery date as 2nd Day Air,
    // for ~$10 more. Policy: if standard Ground (not the Saver/Economy
    // tender-to-USPS services excluded above) delivers within the cal-day
    // cap, it's allowed — the cap already accounts for weather.

    // Friday: FedEx Express NEVER
    if (dayName === "Fri") {
      pool = pool.filter(
        (r) =>
          !(r.carrierUp === "FEDEX" && r.titleLow.includes("express"))
      );
    }

    if (pool.length === 0) return { rate: null, diagnostic: null };

    // Frozen rate selection policy (per Vladimir 2026-05-15):
    //   "If shipping cost is ±5% or under $1 difference, always prefer the
    //    faster delivery. Food safety wins over small savings."
    //
    // Implementation: tolerance band = max($1.00, 5% of cheapest). Every
    // rate inside the band is a candidate; within candidates we pick the
    // FEWEST calendar days first, then the earliest EDD, then the cheapest.
    // This is the rule that should fire for the FedEx One Rate pair where
    // Express Saver (3-day) and 2Day always share the same price — the
    // 2Day should win every time.
    pool.sort((a, b) => a.price - b.price);
    const cheapest = pool[0];
    const tolerance = Math.max(1.0, cheapest.price * 0.05);
    const candidates = pool.filter(
      (r) => r.price - cheapest.price <= tolerance,
    );
    candidates.sort((a, b) => {
      if (a.calDays !== b.calDays) return a.calDays - b.calDays;
      const dt = a.eddDate.getTime() - b.eddDate.getTime();
      if (dt !== 0) return dt;
      return a.price - b.price;
    });
    // Diagnostic — a short trace the route handler attaches to
    // planItem.notes (visible in UI). Returned (not stashed in a module
    // global) so the per-order loop can run in parallel without races.
    let diagnostic: string | null = null;
    try {
      const cand = candidates
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d/${r.eddLocal}`);
      const skipped = pool
        .filter((r) => r.price - cheapest.price > tolerance)
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d`);
      const riskTag =
        (frozenRiskLevel ?? "").toLowerCase() === "critical"
          ? "risk=CRITICAL→max2d "
          : "";
      const summary =
        `[frozen-rate] day=${dayName} ship=${actualShipDay} ` +
        `${riskTag}` +
        `cheapest=$${cheapest.price.toFixed(2)} tol=$${tolerance.toFixed(2)} ` +
        `cand=[${cand.join(" | ")}] outside=[${skipped.join(" | ")}] ` +
        `picked=${candidates[0]?.title}/${candidates[0]?.eddLocal}`;
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
  if (enriched.length === 0) return { rate: null, diagnostic: null };
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
        const dimMatch = skuBoxSize.match(
          /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i,
        );
        if (dimMatch) {
          try {
            await updateAllocationPackage(allocationId, {
              weightLbs: skuWeight,
              lengthIn: Number(dimMatch[1]),
              widthIn: Number(dimMatch[2]),
              heightIn: Number(dimMatch[3]),
            });
            console.log(
              `[plan] ${order.number} allocation_package pushed: ${dimMatch[1]}x${dimMatch[2]}x${dimMatch[3]} ${skuWeight}lbs`,
            );
          } catch (e) {
            console.warn(
              `[plan] ${order.number} allocation_package push FAILED:`,
              e instanceof Error ? e.message : e,
            );
          }
        } else {
          console.warn(
            `[plan] ${order.number} skuBoxSize="${skuBoxSize}" did not match LxWxH regex — skipping package push`,
          );
        }
      }

      if (!stopReason && allocationId) {
        try {
          // Read the parallel pre-warm cache; fall back to a live fetch on a
          // miss (e.g. an order whose gates differed from the pre-warm pass).
          const ratesResponse =
            ratesByAlloc.get(String(allocationId)) ??
            (await getShippingRates(String(allocationId)));
          const rates: VeeqoRate[] = ratesResponse?.available || [];

          if (isAlt) {
            console.log(
              `[plan-alt] ${order.number} rates returned: ${rates.length}` +
                (rates.length > 0
                  ? ` (sample: ${rates.slice(0, 3).map((r) => `${r.sub_carrier_id}/${r.title}/$${r.total_net_charge}`).join(" | ")})`
                  : " — EMPTY → row will stay at 'Awaiting rate'"),
            );
          }

          // Frozen risk lookup — empty string when no alert / not Frozen,
          // so selectBestRate's existing fallback ("≤3 cal days") fires.
          const frozenRiskLevel =
            frozenRiskByOrderNumber.get(String(order.number)) ?? null;
          const todaySel = selectBestRate(
            rates,
            productType,
            deliveryBy,
            actualShipDay,
            dayInfo.dayName,
            isAfterNoon,
            frozenRiskLevel
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

          // ── Ship Date Trick (Frozen only) ───────────────────────────────
          //
          // For Frozen orders the 3-day in-transit cap often makes Saturday-
          // surcharge rates the only feasible option on certain weekdays.
          // Shifting the actual dispatch_date to next Monday can unlock a
          // cheaper plain weekday rate that still meets both the 3-day rule
          // (now measured from Monday) and the marketplace deadline.
          //
          // Implementation: PUT dispatch_date = nextMonday in Veeqo,
          // re-fetch rates, compare with today's pick, restore on the way
          // out. If Monday wins we mark `actualShipDay = nextMonday` and
          // /api/shipping/buy will re-apply the date before purchasing.
          // The restore in the finally block guarantees Veeqo state is
          // unchanged when the trick doesn't win.
          const nextMonday = getNextMonday(today);
          const monDeadlineDays = nextMonday
            ? Math.round(
                (new Date(deliveryBy + "T00:00:00").getTime() -
                  new Date(nextMonday + "T00:00:00").getTime()) /
                  86_400_000
              )
            : -1;

          // Monday-shift policy (Vladimir 2026-06-12 — canonical, supersedes
          // the 2026-06-09/06-10 overnight-trigger versions):
          //
          // For EVERY Frozen order, compute TWO candidates and keep the
          // economically better one:
          //   • today's best rate (`selectedRate`), and
          //   • the best rate if we instead dispatch next Monday.
          // Each must satisfy the SAME two base conditions — deliver on/before
          // the marketplace deadline AND within the frozen cal-day cap (3
          // normally, 2 hot/critical), measured from THAT candidate's own ship
          // day. selectBestRate enforces both per ship-day, so any non-null
          // pick is already valid. Between two valid picks we take the CHEAPER;
          // if they're within a small tolerance (max $3 / 5%) we keep the one
          // that DELIVERS EARLIER (faster is worth a couple dollars — and for
          // frozen, less transit = safer). The physical ship day doesn't matter
          // to Amazon as long as both conditions hold, so always comparing
          // Monday is safe and simply saves money: a Friday order's only
          // in-window rate is often a $69 overnight, while a Monday-shipped
          // 2-Day clears the same 6/17-6/18 deadline for ~$18.
          //
          //   * monDeadlineDays >= 1 — a Monday dispatch must still beat the
          //     deadline; if it can't there is no Monday candidate and today's
          //     pick stands (so a genuinely tight deadline is never delayed).
          //   * dayInfo.dayName !== "Mon" — today already IS Monday; "next
          //     Monday" would be a full week out, so don't shift.
          const tryMonday =
            productType === "Frozen" &&
            monDeadlineDays >= 1 &&
            dayInfo.dayName !== "Mon";

          if (tryMonday) {
            const originalDispatch: string | undefined = order.dispatch_date;
            try {
              await updateOrderDispatchDate(
                order.id,
                `${nextMonday}T06:59:59.000Z`
              );
              // Brief pause — Veeqo recomputes the allocation's rate cache
              // asynchronously after the order update.
              await new Promise((r) => setTimeout(r, 800));
              const mondayRatesResp = await getShippingRates(
                String(allocationId)
              );
              const mondayRates: VeeqoRate[] =
                mondayRatesResp?.available || [];
              const mondaySel = selectBestRate(
                mondayRates,
                productType,
                deliveryBy,
                nextMonday,
                "Mon",
                false,
                frozenRiskLevel
              );
              const mondayPick = mondaySel.rate;
              const mondayDebug = mondaySel.diagnostic;

              const todayPrice = selectedRate
                ? parseFloat(selectedRate.total_net_charge)
                : Infinity;
              const mondayPrice = mondayPick
                ? parseFloat(mondayPick.total_net_charge)
                : Infinity;

              // Actual delivery dates (PT calendar day) for the tolerance
              // tiebreak — "earlier delivery wins when the prices are close".
              const todayEdd = selectedRate
                ? new Date(
                    veeqoDateToLocal(selectedRate.delivery_promise_date) +
                      "T00:00:00"
                  )
                : null;
              const mondayEdd = mondayPick
                ? new Date(
                    veeqoDateToLocal(mondayPick.delivery_promise_date) +
                      "T00:00:00"
                  )
                : null;

              // Choose between today's pick and Monday's pick. Both already
              // satisfy deadline + frozen cal-day cap for their own ship day,
              // so the choice is purely economic (Vladimir 2026-06-12):
              //   - only one valid        → take it.
              //   - both valid, far apart → CHEAPER wins (ship day is
              //                             irrelevant to Amazon as long as
              //                             both base conditions hold).
              //   - both valid, within    → the EARLIER-delivering one wins;
              //     max($3, 5%)             on an EDD tie the cheaper wins.
              //                             (A couple dollars is worth +1 day
              //                             faster — and less transit is safer
              //                             for frozen.)
              let takeMonday = false;
              let switchReason = "";
              if (mondayPick && !selectedRate) {
                takeMonday = true;
                switchReason = "no on-time rate from today";
              } else if (mondayPick && selectedRate) {
                const tol = Math.max(
                  3,
                  Math.min(todayPrice, mondayPrice) * 0.05
                );
                const within = Math.abs(todayPrice - mondayPrice) <= tol;
                const monEarlier =
                  mondayEdd != null &&
                  todayEdd != null &&
                  mondayEdd.getTime() < todayEdd.getTime();
                const sameEdd =
                  mondayEdd != null &&
                  todayEdd != null &&
                  mondayEdd.getTime() === todayEdd.getTime();
                if (within) {
                  if (monEarlier) {
                    takeMonday = true;
                    switchReason = `delivers earlier within $${tol.toFixed(0)}`;
                  } else if (sameEdd && mondayPrice < todayPrice) {
                    takeMonday = true;
                    switchReason = `same EDD, $${(todayPrice - mondayPrice).toFixed(2)} cheaper`;
                  }
                  // else today is earlier-or-equal within the band → keep it.
                } else if (mondayPrice < todayPrice) {
                  takeMonday = true;
                  switchReason = `saved $${(todayPrice - mondayPrice).toFixed(2)}`;
                }
                // else today is materially cheaper → keep today.
              }

              if (takeMonday && mondayPick) {
                selectedRate = mondayPick;
                // Swap the diagnostic to the Monday trace — that's the call
                // that produced the rate now being shown.
                if (mondayDebug) frozenRateDebug = `mon: ${mondayDebug}`;
                shipDateNote = `Shifted to Mon ${nextMonday}: ${switchReason}`;
              }
            } catch (e) {
              // Trick failed — fall back to today's pick. Don't leak the
              // failure as a hard stop; we still have selectedRate from
              // the initial getShippingRates call.
              console.warn(
                "Ship Date Trick failed for order",
                order.id,
                e instanceof Error ? e.message : e
              );
            } finally {
              // Always restore the original dispatch_date. The actual
              // Monday push happens at purchase time in /api/shipping/buy,
              // not here.
              if (originalDispatch) {
                try {
                  await updateOrderDispatchDate(order.id, originalDispatch);
                } catch (e) {
                  console.error(
                    `CRITICAL: failed to restore dispatch_date on order ${order.id} — left as Monday. Original: ${originalDispatch}`,
                    e
                  );
                }
              }
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
      const trickFired = Boolean(shipDateNote);
      const physicalShipDate = trickFired
        ? nextMondayFrom(labelDate)
        : labelDate;
      const legacyActualShipDay = trickFired
        ? getNextMonday(today)
        : actualShipDay;

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
