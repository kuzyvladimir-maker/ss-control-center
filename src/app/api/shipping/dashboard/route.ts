/**
 * GET /api/shipping/dashboard
 *
 * Live snapshot powering the new Shipping Labels operations page. Hits
 * Veeqo for all awaiting_fulfillment orders, classifies each into one of
 * { ready_to_buy, need_attention, waiting_placed, bought } and bins them
 * into time buckets (overdue / today / tomorrow / dayafter / later).
 *
 * Intentionally avoids the heavy rate-fetch and plan-formation path —
 * those run via /api/shipping/plan when the operator actually wants to
 * see prices for a specific subset.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchAllOrders, getProduct } from "@/lib/veeqo/client";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import {
  buildPackingSignature,
  requiresPackingProfile,
  type OrderLineItem,
} from "@/lib/shipping/packing-signature";
import { utcToPacificYMD, todayPacific } from "@/lib/shipping/dates";

const PLACED_TAG = "Placed";

type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";

function shipByBucket(iso: string | null): ShipByBucket | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Anchor in America/Los_Angeles (Pacific) — same TZ Veeqo's UI uses
  // for the "Today / Tomorrow" badge it shows next to each order. Veeqo
  // stores dispatch_date as the END of a PT calendar day (T06:59:59
  // UTC of next-day = 23:59 PT current-day), so Pacific is the only
  // anchor where our bucket matches Veeqo's badge for the cluster of
  // orders that share that encoding. Verified 2026-06-04 with the
  // `/api/diag/tz` endpoint against Veeqo's UI.
  const dStr = utcToPacificYMD(d);
  const nowStr = todayPacific();
  const diffDays = Math.round(
    (new Date(dStr + "T00:00:00Z").getTime() -
      new Date(nowStr + "T00:00:00Z").getTime()) /
      86_400_000,
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === 2) return "dayafter";
  return "later";
}

function isPlaced(o: any): boolean {
  const tags = o.tags ?? [];
  return tags.some(
    (t: any) =>
      String(t?.name ?? "").toLowerCase() === PLACED_TAG.toLowerCase()
  );
}

// Authoritative signal: Veeqo's `order.status`. When a label is bought
// Veeqo flips it to "shipped"; when the operator cancels the label in
// Veeqo it flips back to "awaiting_fulfillment" — exactly the signal we
// need so cancelled orders reappear in the dashboard.
//
// Previous implementation checked `employee_notes` for the literal
// "Label Purchased" token. That token is append-only (Veeqo notes are
// never deleted, see [veeqo-api-quirks §3](docs/wiki/veeqo-api-quirks.md))
// so a cancelled-and-refunded label still leaves the order tagged as
// "bought" forever from our app's perspective. Switched 2026-05-14.
function isBought(o: any): boolean {
  return String(o?.status ?? "").toLowerCase() === "shipped";
}

function isFrozenWalmart(channelName: string | undefined, type: string | null) {
  if (!channelName) return false;
  return (
    channelName.toLowerCase().includes("walmart") && type === "Frozen"
  );
}

function isMixedOrder(items: Array<{ knownType: string | null }>): boolean {
  const types = items
    .map((i) => i.knownType)
    .filter((t): t is string => t === "Frozen" || t === "Dry");
  if (types.length < 2) return false;
  return new Set(types).size > 1;
}

export async function GET() {
  try {
    const refreshedAt = new Date().toISOString();
    const stores = await prisma.store.findMany({
      where: { active: true },
    });
    // Map Veeqo channel name → our internal Store.
    const channelToStore = (channelName: string | undefined) => {
      if (!channelName) return null;
      const low = channelName.toLowerCase();
      return (
        stores.find((s) => low.includes(s.name.toLowerCase())) ??
        // Fallback: match the first word
        stores.find((s) =>
          low.includes((s.name.split(/\s+/)[0] ?? "").toLowerCase())
        ) ??
        null
      );
    };

    const veeqoOrders: any[] = await fetchAllOrders("awaiting_fulfillment");

    // ── Bulk-fetch the tagged Veeqo products to figure out Frozen/Dry tags
    // without N requests. Dedupe by productId.
    const productIds = new Set<number>();
    for (const o of veeqoOrders) {
      for (const li of o.line_items ?? []) {
        const pid =
          li?.sellable?.product?.id ??
          li?.sellable?.product_id ??
          li?.sellable?.id;
        if (typeof pid === "number") productIds.add(pid);
      }
    }
    const idList = [...productIds];

    // Prisma ProductTypeOverride lookup — fast single query.
    const overrides = idList.length
      ? await prisma.productTypeOverride.findMany({
          where: { productId: { in: idList } },
        })
      : [];
    const overrideByPid = new Map(overrides.map((o) => [o.productId, o.type]));

    // Fetch Veeqo product details for products without an override. Veeqo
    // rate-limits aggressively, so cap at 5 in flight — but as a SLIDING
    // window (workers drain a shared index) rather than fixed batches, so one
    // slow call no longer stalls the other 4 in its batch. Started here but
    // NOT awaited: it runs concurrently with the PackingProfile/SKU DB work and
    // the Walmart-PO resolution below, and is awaited once just before the
    // orders loop that actually reads `veeqoProductType` (line ~475). Cuts the
    // dashboard's network wall-clock from probe+walmart to roughly max(...).
    const idsToProbe = idList.filter((pid) => !overrideByPid.has(pid));
    const veeqoProductType = new Map<number, "Frozen" | "Dry" | null>();
    const PROBE_CONCURRENCY = 5;
    const productProbeDone = (async () => {
      let next = 0;
      const worker = async () => {
        while (next < idsToProbe.length) {
          const pid = idsToProbe[next++];
          try {
            const product: any = await getProduct(pid);
            const names: string[] = (product?.tags ?? []).map((t: any) =>
              String(t?.name ?? "").toLowerCase(),
            );
            veeqoProductType.set(
              pid,
              names.some((n) => n === "frozen")
                ? "Frozen"
                : names.some((n) => n === "dry")
                  ? "Dry"
                  : null,
            );
          } catch {
            veeqoProductType.set(pid, null);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(PROBE_CONCURRENCY, idsToProbe.length) },
          worker,
        ),
      );
    })();

    const productType = (pid: number | undefined): "Frozen" | "Dry" | null => {
      if (pid == null) return null;
      const o = overrideByPid.get(pid);
      if (o === "Frozen" || o === "Dry") return o;
      return veeqoProductType.get(pid) ?? null;
    };

    // ── Bulk-fetch PackingProfile rows for every signature we'll need.
    type LiteItem = {
      sku: string;
      productId: number | null;
      productTitle: string;
      quantity: number;
      imageUrl: string | null;
    };
    // Veeqo's image URL lives in a different field per channel. Same multi-
    // path lookup as src/lib/veeqo/orders-procurement.ts:pickImageUrl. First
    // non-empty string wins.
    const pickImage = (li: any): string | null => {
      const s = li?.sellable ?? {};
      const p = s.product ?? {};
      const candidates: Array<unknown> = [
        s.image_url,
        s.main_image?.src,
        s.main_image?.url,
        p.main_image_src,
        p.main_image_url,
        p.image_url,
        p.images?.[0]?.src,
        p.images?.[0]?.url,
        p.images?.[0]?.image_url,
        p.images?.[0]?.src_thumbnail,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c;
      }
      return null;
    };
    const orderItems = new Map<number | string, LiteItem[]>();
    const signatures = new Set<string>();
    for (const o of veeqoOrders) {
      const items: LiteItem[] = (o.line_items ?? [])
        .map((li: any) => {
          const sellable = li?.sellable ?? {};
          const sku = String(sellable?.sku_code ?? sellable?.sku ?? "");
          const productId =
            typeof sellable?.product?.id === "number"
              ? sellable.product.id
              : typeof sellable?.product_id === "number"
                ? sellable.product_id
                : typeof sellable?.id === "number"
                  ? sellable.id
                  : null;
          return {
            sku,
            productId,
            productTitle: String(
              sellable?.product_title ?? sellable?.product?.title ?? sku
            ),
            quantity: Number(li?.quantity ?? 1),
            imageUrl: pickImage(li),
          };
        })
        // Keep the line as long as it has a recognisable identity. SKU is
        // the cleanest key, but eBay listings often have NO SKU (Veeqo
        // shows "SKU: -" for them) — falling back to productId / title
        // keeps the row visible with image + name instead of dropping it
        // out of the dashboard entirely.
        .filter(
          (i: LiteItem) => i.sku || i.productId != null || i.productTitle,
        );
      orderItems.set(o.id, items);
      if (requiresPackingProfile(items)) {
        signatures.add(
          buildPackingSignature(
            items.map((i: LiteItem): OrderLineItem => ({
              sku: i.sku,
              quantity: i.quantity,
              fallbackId: i.productId,
            }))
          )
        );
      }
    }
    const packingProfiles = signatures.size
      ? await prisma.packingProfile.findMany({
          where: { signature: { in: [...signatures] } },
        })
      : [];
    const profileBySig = new Set(packingProfiles.map((p) => p.signature));

    // ── Lookup SKU rows so we know which orders are missing SKU data.
    const skuList = new Set<string>();
    for (const items of orderItems.values()) {
      for (const i of items) skuList.add(i.sku);
    }
    // Only membership is needed (skuByCode.has below), so select just the sku
    // column and build a Set — avoids materializing every column of every row.
    const skuRows = skuList.size
      ? await prisma.skuShippingData.findMany({
          where: { sku: { in: [...skuList] } },
          select: { sku: true },
        })
      : [];
    const skuByCode = new Set(skuRows.map((r) => r.sku));

    // ── Per-order classification + assembly ─────────────────────────────
    const storeTotals = new Map<
      string,
      {
        storeId: string;
        storeName: string;
        channel: string;
        all: number;
        readyToBuy: number;
        needAttention: number;
        waitingPlaced: number;
        boughtToday: number;
      }
    >();
    const ensureTotals = (
      storeId: string,
      storeName: string,
      channel: string
    ) => {
      let row = storeTotals.get(storeId);
      if (!row) {
        row = {
          storeId,
          storeName,
          channel,
          all: 0,
          readyToBuy: 0,
          needAttention: 0,
          waitingPlaced: 0,
          boughtToday: 0,
        };
        storeTotals.set(storeId, row);
      }
      return row;
    };

    const timeBuckets: Record<ShipByBucket, number> = {
      overdue: 0,
      today: 0,
      tomorrow: 0,
      dayafter: 0,
      later: 0,
    };

    // Walmart orders come into Veeqo under store names like "SIRIUS TRADING
    // INTERNATIONAL LLC" (NOT "Walmart"), and their Veeqo order `number` is
    // the Walmart customerOrderId. Map customerOrderId → purchaseOrderId here
    // so the UI can route Walmart rows to the Walmart-direct rate/buy flow
    // (and skip Veeqo) — channel-name matching is unreliable.
    //
    // Also map customerOrderId → Walmart status. Walmart-direct buy + ship
    // bypasses Veeqo, so the Veeqo order stays at `awaiting_fulfillment`
    // forever even after we've already marked the PO Shipped on Walmart.
    // We use the DB-cached status (orders-walmart-light cron refreshes
    // every 2h) to prune Shipped rows from the dashboard at the source —
    // otherwise the sidebar count diverges from the page count by exactly
    // the number of Walmart-direct-Shipped rows.
    const orderNumbers = veeqoOrders.map((o) => String(o.number ?? o.id));
    const walmartPoByCustomer = new Map<string, string>();
    const walmartShippedCustomerIds = new Set<string>();
    if (orderNumbers.length > 0) {
      const wmRows = await prisma.walmartOrder.findMany({
        where: { customerOrderId: { in: orderNumbers } },
        select: {
          customerOrderId: true,
          purchaseOrderId: true,
          status: true,
        },
      });
      for (const r of wmRows) {
        walmartPoByCustomer.set(r.customerOrderId, r.purchaseOrderId);
        if (r.status === "Shipped") walmartShippedCustomerIds.add(r.customerOrderId);
      }
    }

    // On-demand Walmart PO resolution. The walmartOrder table is filled by a
    // 2-hourly cron, so a brand-new Walmart order sits in Veeqo (channel
    // type_code = "walmart") for minutes before it lands in our table. Until
    // then `isWalmart` was false → the row was treated as a Veeqo order, shown
    // a Veeqo rate, and the buy got refused server-side ("bought via Walmart,
    // not Veeqo") — unbuyable BOTH ways. So for any walmart-channel order we
    // don't yet have a PO for, look it up straight from Walmart and cache it
    // (so the next load + the cron don't re-fetch). Bounded + fully non-fatal:
    // a lookup failure just leaves the order as before.
    const unresolvedWalmart = veeqoOrders.filter(
      (o) =>
        (o.channel?.type_code ?? "").toLowerCase() === "walmart" &&
        !walmartPoByCustomer.has(String(o.number ?? o.id)),
    );
    if (unresolvedWalmart.length > 0) {
      try {
        const wmApi = new WalmartOrdersApi(getWalmartClient(1));
        const POOL = 6; // cap concurrency so a burst of new orders can't hammer Walmart
        for (let i = 0; i < unresolvedWalmart.length; i += POOL) {
          await Promise.all(
            unresolvedWalmart.slice(i, i + POOL).map(async (o) => {
              const custId = String(o.number ?? o.id);
              try {
                const page = await wmApi.getAllOrders({ customerOrderId: custId });
                const wmOrder =
                  page.orders.find((w) => w.customerOrderId === custId) ??
                  page.orders[0];
                if (!wmOrder?.purchaseOrderId) return;
                walmartPoByCustomer.set(custId, wmOrder.purchaseOrderId);
                if (wmOrder.status === "Shipped")
                  walmartShippedCustomerIds.add(custId);
                // Cache so subsequent loads hit the DB, not Walmart.
                const ship = wmOrder.shippingInfo?.postalAddress;
                await prisma.walmartOrder
                  .upsert({
                    where: { purchaseOrderId: wmOrder.purchaseOrderId },
                    create: {
                      purchaseOrderId: wmOrder.purchaseOrderId,
                      customerOrderId: wmOrder.customerOrderId,
                      customerEmailId: wmOrder.customerEmailId,
                      storeIndex: 1,
                      status: wmOrder.status,
                      shipNodeType: wmOrder.shipNodeType,
                      orderType: wmOrder.orderType,
                      orderDate: wmOrder.orderDate,
                      estimatedShipDate: wmOrder.shippingInfo?.estimatedShipDate,
                      estimatedDeliveryDate:
                        wmOrder.shippingInfo?.estimatedDeliveryDate,
                      orderTotal: wmOrder.orderTotal,
                      currency: wmOrder.currency || "USD",
                      shipCity: ship?.city,
                      shipState: ship?.state,
                      shipZip: ship?.postalCode,
                      shipCountry: ship?.country,
                      numberOfItems: wmOrder.orderLines.reduce(
                        (s, l) => s + (l.orderedQty || 0),
                        0,
                      ),
                      rawData: JSON.stringify(wmOrder.raw),
                    },
                    update: {
                      customerOrderId: wmOrder.customerOrderId,
                      status: wmOrder.status,
                      rawData: JSON.stringify(wmOrder.raw),
                    },
                  })
                  .catch(() => {
                    /* cache write is best-effort; in-memory map already set */
                  });
              } catch (e) {
                console.warn(
                  `[dashboard] Walmart PO lookup failed for ${custId}:`,
                  e instanceof Error ? e.message : e,
                );
              }
            }),
          );
        }
      } catch (e) {
        console.warn(
          "[dashboard] on-demand Walmart PO resolution skipped:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    // Ensure the Veeqo product-type probe (kicked off above, overlapping the
    // DB + Walmart work) has finished before the loop reads veeqoProductType.
    await productProbeDone;

    const orders = [];
    for (const o of veeqoOrders) {
      // Prune Walmart-direct rows that are already Shipped on Walmart's
      // side. Veeqo keeps them at `awaiting_fulfillment` (Walmart-direct
      // buy/ship bypasses Veeqo), so without this prune they keep
      // showing in the dashboard list AND inflate the sidebar count by
      // exactly the Walmart-Shipped delta. The DB status is refreshed
      // every 2h by orders-walmart-light.
      const veeqoNum = String(o.number ?? o.id);
      if (walmartShippedCustomerIds.has(veeqoNum)) continue;

      const channelName: string = o.channel?.name ?? o.channel_name ?? "";
      const store = channelToStore(channelName);
      const storeId = store?.id ?? "unknown";
      const storeName = store?.name ?? channelName ?? "Unknown";

      // Convert dispatch_date to Pacific YYYY-MM-DD before sending to the
      // UI — same TZ Veeqo's own UI displays. The raw UTC ISO sliced as
      // YMD lands in UTC (off by hours from Pacific) and Eastern (off by
      // a day for the late-PT-evening encoding Veeqo uses for dispatch
      // deadlines). Pacific is the right anchor for marketplace data.
      const shipByRaw: string | null = o.dispatch_date ?? o.due_date ?? null;
      const shipBy: string | null = shipByRaw
        ? utcToPacificYMD(shipByRaw)
        : null;
      const bucket = shipByBucket(shipByRaw);
      if (bucket) timeBuckets[bucket]++;

      // Walmart-channel orders are always treated as Dry — Vladimir's
      // Walmart catalog has no frozen SKUs, the plan endpoint mirrors
      // this rule when picking rates, and the dashboard should match so
      // the Frozen/Dry/Untyped tabs don't show phantom "Untyped" rows
      // just because no operator ever tagged the Veeqo product.
      const walmartChannelForType =
        ((o.channel?.type_code as string | undefined) ?? "").toLowerCase() ===
        "walmart";

      const items = orderItems.get(o.id) ?? [];
      const itemsWithType = items.map((i) => ({
        sku: i.sku,
        productId: i.productId,
        productTitle: i.productTitle,
        quantity: i.quantity,
        imageUrl: i.imageUrl,
        knownType: walmartChannelForType
          ? "Dry"
          : productType(i.productId ?? undefined),
      }));

      // ── State classification ──
      let state: "bought" | "waiting_placed" | "need_attention" | "ready_to_buy";
      let needAttentionReason:
        | "no_type"
        | "mixed_order"
        | "frozen_walmart"
        | "no_packing"
        | "no_sku"
        | "budget"
        | "no_service"
        | null = null;

      const totals = ensureTotals(storeId, storeName, channelName || "");
      totals.all++;

      const reqsProfile = requiresPackingProfile(
        items.map((i) => ({ sku: i.sku, quantity: i.quantity }))
      );
      const sig = reqsProfile
        ? buildPackingSignature(
            items.map((i) => ({
              sku: i.sku,
              quantity: i.quantity,
              fallbackId: i.productId,
            }))
          )
        : "";

      // Shopify channels are third-party clients (NAN health and similar)
      // whose products are already in our warehouse — they don't go
      // through the supplier-procurement workflow at all, so the Placed
      // gate is meaningless for them. Treat as Placed implicitly so the
      // rate row + Buy button appear immediately without an extra click.
      //
      // Walmart channels ALSO go through procurement (Vladimir confirmed
      // 2026-06-05): he procures bundled food items for Walmart-channel
      // orders the same way he does for Amazon. The earlier "Walmart
      // bypass" — added when we thought buying via Walmart's API meant
      // skipping procurement — let operators buy shipping labels for
      // orders whose items were never sourced. Removed; Walmart now
      // respects the Placed gate like every other own-brand channel.
      const orderTypeCodeForGate = (o.channel?.type_code as string | undefined)
        ?.toLowerCase() ?? "";
      const isShopifyChannel = orderTypeCodeForGate === "shopify";
      const skipPlacedGate = isShopifyChannel;

      if (isBought(o)) {
        state = "bought";
        totals.boughtToday++;
      } else if (!isPlaced(o) && !skipPlacedGate) {
        state = "waiting_placed";
        totals.waitingPlaced++;
      } else {
        // Has Placed — needs to pass several gates.
        // `noType` is the "missing Frozen/Dry classification" gate. We
        // only enforce it on Amazon orders — that's the channel where the
        // 3-day food-safety rule matters. TikTok/eBay/Shopify in this op
        // ship Dry goods only (supplements, accessories), and the plan
        // endpoint mirrors this by defaulting their productType to Dry.
        //
        // Anchor the "is this Amazon?" decision on Veeqo's `type_code`
        // (already captured as orderTypeCodeForGate above) rather than
        // on the channel NAME — channel names can be operator-set
        // strings like "AMZ eBay" (an eBay listing under an AMZ
        // Commerce account) which would match a `.startsWith("amz")`
        // check and falsely flag every untagged eBay item as
        // need_attention=no_type. Merged Orders in Veeqo get
        // type_code="direct" but the underlying sources are Amazon,
        // so include that bucket too.
        const isAmazonOrder =
          orderTypeCodeForGate === "amazon" ||
          (channelName || "").toLowerCase() === "merged orders";
        const noType =
          isAmazonOrder && itemsWithType.some((i) => !i.knownType);
        const mixed = isMixedOrder(itemsWithType);
        const frozenWalmart = itemsWithType.some((i) =>
          isFrozenWalmart(channelName, i.knownType)
        );
        // Per-SKU SkuShippingData is only consulted when the order is
        // single-line single-qty (no PackingProfile required). For
        // multi-item orders the PackingProfile covers box+weight, so a
        // missing per-SKU row is fine — don't flag no_sku in that case.
        //
        // Also Amazon-only: for eBay/TikTok/Shopify/Etsy/direct, Vladimir
        // sets the package in Veeqo's own UI (allocation_package on the
        // allocation) and rates come from Veeqo against THAT package —
        // our SkuShippingData is unused for those channels. Flagging
        // no_sku on a non-Amazon row would falsely block a row Veeqo
        // can already quote.
        const needsProfileMissing =
          reqsProfile && !profileBySig.has(sig);
        const missingSku =
          isAmazonOrder &&
          !reqsProfile &&
          items.some((i) => !skuByCode.has(i.sku));

        if (frozenWalmart) {
          state = "need_attention";
          needAttentionReason = "frozen_walmart";
        } else if (mixed) {
          state = "need_attention";
          needAttentionReason = "mixed_order";
        } else if (noType) {
          state = "need_attention";
          needAttentionReason = "no_type";
        } else if (needsProfileMissing) {
          state = "need_attention";
          needAttentionReason = "no_packing";
        } else if (missingSku) {
          state = "need_attention";
          needAttentionReason = "no_sku";
        } else {
          state = "ready_to_buy";
        }
        if (state === "need_attention") totals.needAttention++;
        if (state === "ready_to_buy") totals.readyToBuy++;
      }

      // Money fields Veeqo already gave us on each order. Cheap, no extra
      // API call needed — surface them so the row is informative without
      // touching /api/shipping/plan.
      const orderTotal =
        Number(o.total_price ?? o.subtotal_price ?? 0) || 0;
      const customerPaidShipping = Number(o.delivery_cost ?? 0) || 0;
      // The shipping speed the buyer actually selected/paid for, straight
      // from Veeqo's `delivery_method.name` ("Standard", "Expedited",
      // "Second Day", "Next Day", "FREE Economy", …). Shown next to the
      // customer-paid-shipping amount so the operator can see at a glance
      // when a customer bought a faster tier than Standard and the label
      // must match that promise. Null when Veeqo didn't carry one.
      const customerShippingService =
        (o.delivery_method?.name as string | undefined)?.trim() || null;

      // Shipping address — name/city/state — pulled from deliver_to so the
      // operator can sanity-check the destination on the row without
      // opening Veeqo. (Address1/zip omitted to keep the chip compact;
      // they'd dox the order without adding decision-useful info.)
      const dt = o.deliver_to ?? {};
      const firstName = String(dt.first_name ?? "").trim();
      const lastName = String(dt.last_name ?? "").trim();
      const customerName =
        [firstName, lastName].filter(Boolean).join(" ") || null;
      const city = String(dt.city ?? "").trim() || null;
      const stateCode = String(dt.state ?? "").trim() || null;

      orders.push({
        orderId: String(o.id),
        orderNumber: String(o.number ?? o.id),
        storeId,
        storeName,
        channel: channelName || null,
        shipBy,
        timeBucket: bucket,
        // The Amazon/Walmart deliver-by deadline lives on Veeqo's `due_date`
        // (same field /api/shipping/plan reads). The other candidate names
        // we tried before (`deliver_no_later_than`, `expected_delivery_date`)
        // aren't populated, so the row showed "—" for every order.
        //
        // MUST be Pacific-normalized, exactly like `shipBy` above and like
        // the plan route's rate engine (`veeqoDateToLocal` = utcToPacificYMD).
        // Veeqo encodes the deadline as END-OF-DAY PACIFIC stored as next-day
        // `T06:59:59Z` (e.g. due "2026-06-17T06:59:59Z" = the Jun 16 PT
        // deadline). Sending the raw ISO let the UI string-slice it to the
        // UTC date (Jun 17) — a day LATER than the real deadline — so the
        // on-time/late badge compared a UTC-sliced deadline against the
        // Pacific EDD and read "on time" for orders that are actually late.
        // Normalizing here makes the displayed deadline identical to the one
        // the rate engine enforces.
        deliverBy: (() => {
          const raw =
            o.due_date ??
            o.deliver_no_later_than ??
            o.expected_delivery_date ??
            null;
          return raw ? utcToPacificYMD(raw) : null;
        })(),
        state,
        needAttentionReason,
        items: itemsWithType,
        packingSignature: reqsProfile ? sig : null,
        packingProfileFound: reqsProfile ? profileBySig.has(sig) : null,
        orderTotal,
        customerPaidShipping,
        customerShippingService,
        currency: o.currency_code ?? "USD",
        // Marketplace kind from Veeqo's channel.type_code — "amazon",
        // "walmart", "ebay", "tiktok", "shopify", "direct" (used for
        // Merged Orders), etc. Drives the channel-filter chips at the
        // top of the page so new marketplaces auto-appear once their
        // first open order shows up.
        channelKind: ((o.channel?.type_code as string | undefined) || "")
          .toLowerCase() || null,
        customerName,
        city,
        shipToState: stateCode,
        // Walmart-direct flow markers (null/false for Amazon orders).
        isWalmart: walmartPoByCustomer.has(String(o.number ?? o.id)),
        walmartPurchaseOrderId:
          walmartPoByCustomer.get(String(o.number ?? o.id)) ?? null,
      });
    }

    const storeBreakdown = [...storeTotals.values()].sort((a, b) =>
      a.storeName.localeCompare(b.storeName)
    );

    return NextResponse.json({
      refreshedAt,
      storeBreakdown,
      timeBuckets,
      orders,
    });
  } catch (err) {
    console.error("[api/shipping/dashboard]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "dashboard failed" },
      { status: 500 }
    );
  }
}
