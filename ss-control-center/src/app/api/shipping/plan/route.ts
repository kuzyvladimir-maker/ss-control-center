import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchAllOrders,
  getProduct,
  getShippingRates,
  veeqoDateToLocal,
  getTodayNY,
  updateOrderDispatchDate,
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

// Module-level diagnostic — written by selectBestRate on each Frozen
// invocation. The route handler reads this immediately after the call to
// attach a short trace to the planItem's notes, so the operator can see
// "why this rate was picked" in the UI without digging into Vercel logs.
let lastFrozenRateDiagnostic: string | null = null;

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

    // Policy (Vladimir 2026-05-15): never buy faster than 2-Day for Frozen
    // unless the customer themselves paid for Overnight / Next Day. We use
    // the marketplace deliver-by date as a proxy — if it's within 1 day of
    // ship-day, the customer's service tier was already fast (Next Day or
    // tighter) and we must match it; otherwise cap at 2-day to avoid
    // burning $60+ per label on Overnight when customer paid Standard.
    const shipDt = new Date(actualShipDay + "T00:00:00");
    const deadlineDt = new Date(deliveryBy + "T00:00:00");
    const daysToDeadline = Math.round(
      (deadlineDt.getTime() - shipDt.getTime()) / 86_400_000,
    );
    if (daysToDeadline >= 2) {
      pool = pool.filter((r) => r.calDays >= 2);
    }

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
    // Temporary diagnostic — log + stash a short trace so the route
    // handler can attach it to planItem.notes (visible in UI). Remove
    // once the FedEx One Rate pair behaves.
    try {
      const cand = candidates
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d/${r.eddLocal}`);
      const skipped = pool
        .filter((r) => r.price - cheapest.price > tolerance)
        .slice(0, 4)
        .map((r) => `${r.title}/$${r.price.toFixed(2)}/${r.calDays}d`);
      const summary =
        `[frozen-rate] day=${dayName} ship=${actualShipDay} ` +
        `cheapest=$${cheapest.price.toFixed(2)} tol=$${tolerance.toFixed(2)} ` +
        `cand=[${cand.join(" | ")}] outside=[${skipped.join(" | ")}] ` +
        `picked=${candidates[0]?.title}/${candidates[0]?.eddLocal}`;
      console.log(summary);
      lastFrozenRateDiagnostic = summary;
    } catch {
      /* logging must never break the buy flow */
    }
    return candidates[0];
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
  if (enriched.length === 0) return null;
  const pool = [...enriched].sort((a, b) => a.price - b.price);
  return pool[0];
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

    for (const order of orders) {
      // When the caller passed an explicit orderIds filter, only process
      // those rows (lets the UI cheap-refresh a single card).
      if (orderIdFilter && !orderIdFilter.has(String(order.id))) continue;

      const hasPlaced = order.tags?.some(
        (t: { name: string }) => t.name === "Placed"
      );
      if (!hasPlaced) continue;
      debug.filters.afterPlacedTag++;

      const shipBy = veeqoDateToLocal(order.dispatch_date);
      // The orderIds filter overrides the "today only" gate so refreshes
      // work for orders that aren't on today's dispatch date (e.g. a card
      // the operator just changed packing for).
      if (!orderIdFilter && shipBy !== dispatchTarget) continue;
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
        continue;
      }
      debug.filters.afterChannel++;

      if (isWalmart && weekend) continue;
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
      if (orderStatus === "shipped") continue;
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

      // ── SKU lookup OR PackingProfile lookup for multi-item orders ──
      //
      // Single-line + qty=1 → use SkuShippingData (per-SKU box+weight).
      // Multi-line OR qty>1  → use PackingProfile keyed by composition
      //                        signature. Profile is set up once by the
      //                        operator via /api/shipping/packing-profile.
      const orderLines: Array<{ sku: string; quantity: number }> = (
        order.line_items ?? []
      )
        .map((li: { sellable?: { sku_code?: string; sku?: string }; quantity?: number }) => ({
          sku: String(li?.sellable?.sku_code ?? li?.sellable?.sku ?? ""),
          quantity: Number(li?.quantity ?? 1),
        }))
        .filter((i: { sku: string; quantity: number }) => i.sku);

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
        if (!stopReason && !skuData) {
          stopReason = `SKU ${firstSku} not in SKU Database`;
        } else if (!stopReason && skuData && !skuData.hasCompleteData) {
          stopReason = `SKU ${firstSku}: missing weight/dimensions`;
        } else if (skuData) {
          skuWeight = skuData.weight;
          if (skuData.length && skuData.width && skuData.height) {
            skuBoxSize = `${skuData.length}x${skuData.width}x${skuData.height}`;
          }
        }
      }

      const deliveryBy = veeqoDateToLocal(order.due_date);
      const allocationId = order.allocations?.[0]?.id;

      // ── Get rates & select best ──
      let selectedRate: VeeqoRate | null = null;
      let shipDateNote: string | null = null;
      let frozenRateDebug: string | null = null;

      if (!stopReason && allocationId) {
        try {
          const ratesResponse = await getShippingRates(String(allocationId));
          const rates: VeeqoRate[] = ratesResponse?.available || [];

          lastFrozenRateDiagnostic = null;
          selectedRate = selectBestRate(
            rates,
            productType,
            deliveryBy,
            actualShipDay,
            dayInfo.dayName,
            isAfterNoon
          );
          if (productType === "Frozen" && lastFrozenRateDiagnostic) {
            frozenRateDebug = `today: ${lastFrozenRateDiagnostic}`;
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

          // Compute cal-days-in-transit for the rate just picked, so the
          // Monday-shift guard below can recognise borderline-Frozen
          // picks. We re-derive instead of asking selectBestRate to
          // return it, because that function's signature is shared with
          // the Monday selection too and we want one source of truth
          // for the math (`veeqoDateToLocal` + date diff).
          let selectedCalDays: number = -1;
          if (selectedRate) {
            const eddLocal = veeqoDateToLocal(
              selectedRate.delivery_promise_date
            );
            const eddDate = new Date(eddLocal + "T00:00:00");
            const shipDate = new Date(actualShipDay + "T00:00:00");
            selectedCalDays = Math.round(
              (eddDate.getTime() - shipDate.getTime()) / 86_400_000
            );
          }

          // Skip Monday-shift attempts that can't possibly win:
          //   * non-Frozen orders (no 3-day constraint to relieve)
          //   * Monday is past the marketplace deadline already
          //     (monDeadlineDays < 1 — Monday IS the deadline or later,
          //     no carrier delivers same-day for Frozen)
          //   * today already IS Monday — getNextMonday() would return
          //     Mon+7, a full week out. Too aggressive for routine use;
          //     a Monday order with no rate is a real exception that
          //     should surface as a stop and be handled manually.
          //
          // 2026-05-14: was `>= 3` which was too strict — for orders
          // where Monday is just 1-2 days before deadline the trick can
          // still find a fast Frozen-eligible rate (e.g. UPS Ground
          // Saver from Monday → 2 cal day EDD that meets both
          // ≤3-day Frozen rule and deadline). The `selectBestRate`
          // call inside the trick will return null if Monday doesn't
          // work, so loosening the guard is safe.
          //
          // 2026-05-15: also fire when today's pick is at the edge
          // (calDays >= 3). The 3-day cap is the absolute maximum for
          // frozen food safety — Vladimir flagged order
          // 112-2707311-2069835 where today's UPS Ground Saver was 3
          // days exactly and Monday could have given a tighter 1-2 day
          // EDD. Triggering only on `no rate` / `Saturday surcharge`
          // missed this case.
          const tryMonday =
            productType === "Frozen" &&
            monDeadlineDays >= 1 &&
            dayInfo.dayName !== "Mon" &&
            (
              // No rate found today → trick is our only chance
              !selectedRate ||
              // Today's pick involves Saturday surcharge → Monday may be
              // cheaper (Saturday variants are typically $15-25 over the
              // plain version).
              /saturday/i.test(selectedRate.title || "") ||
              // Today's pick is at or above the 3-cal-day Frozen limit.
              // Monday almost always tightens transit time because the
              // package skips the weekend purgatory.
              selectedCalDays >= 3
            );

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
              lastFrozenRateDiagnostic = null;
              const mondayPick = selectBestRate(
                mondayRates,
                productType,
                deliveryBy,
                nextMonday,
                "Mon",
                false
              );
              const mondayDebug = lastFrozenRateDiagnostic;

              const todayPrice = selectedRate
                ? parseFloat(selectedRate.total_net_charge)
                : Infinity;
              const mondayPrice = mondayPick
                ? parseFloat(mondayPick.total_net_charge)
                : Infinity;

              // Cal-days from Monday for the candidate rate — same math
              // as for `selectedCalDays` above, just anchored at
              // nextMonday instead of actualShipDay.
              let mondayCalDays = -1;
              if (mondayPick) {
                const eddLocal = veeqoDateToLocal(
                  mondayPick.delivery_promise_date
                );
                const eddDate = new Date(eddLocal + "T00:00:00");
                const monShipDate = new Date(nextMonday + "T00:00:00");
                mondayCalDays = Math.round(
                  (eddDate.getTime() - monShipDate.getTime()) / 86_400_000
                );
              }

              // Pick Monday when EITHER it's cheaper OR it gives a
              // strictly tighter EDD-in-cal-days (food safety wins
              // over $0.50 of savings). We keep a `selectedRate == null`
              // branch — when there's no today pick at all, *any* Monday
              // rate is an improvement.
              const mondayIsCheaper =
                mondayPick != null && mondayPrice < todayPrice;
              const mondayIsSafer =
                mondayPick != null &&
                selectedCalDays > 0 &&
                mondayCalDays > 0 &&
                mondayCalDays < selectedCalDays;
              const mondayIsOnlyOption = mondayPick != null && !selectedRate;

              if (mondayIsCheaper || mondayIsSafer || mondayIsOnlyOption) {
                selectedRate = mondayPick;
                // Swap the diagnostic over to the Monday trace so the
                // operator sees what the Monday refetch saw — that's the
                // call that produced the rate they're looking at.
                if (mondayDebug) frozenRateDebug = `mon: ${mondayDebug}`;
                const reasonBits: string[] = [];
                if (mondayIsCheaper && todayPrice !== Infinity) {
                  reasonBits.push(
                    `saved $${(todayPrice - mondayPrice).toFixed(2)}`
                  );
                }
                if (mondayIsSafer) {
                  reasonBits.push(
                    `${selectedCalDays}→${mondayCalDays} cal days (frozen rule)`
                  );
                }
                if (mondayIsOnlyOption && reasonBits.length === 0) {
                  reasonBits.push("no rate from today");
                }
                shipDateNote = `Shifted to Mon ${nextMonday}: ${reasonBits.join(
                  " · "
                )}`;
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
              stopReason =
                meetingDeadline > 0
                  ? `Frozen — none of ${meetingDeadline}/${rates.length} on-time rates deliver within 3 calendar days (food safety). Monday-shift trick also didn't help.`
                  : `No rate where EDD ≤ Delivery By (${deliveryBy}). ${rates.length} rates checked.`;
            } else {
              stopReason = `No rate where EDD ≤ Delivery By (${deliveryBy}). ${rates.length} rates checked.`;
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
