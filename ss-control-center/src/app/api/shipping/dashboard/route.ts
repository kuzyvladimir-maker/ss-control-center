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
import {
  buildPackingSignature,
  requiresPackingProfile,
  type OrderLineItem,
} from "@/lib/shipping/packing-signature";

const PLACED_TAG = "Placed";

type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";

function shipByBucket(iso: string | null): ShipByBucket | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diffDays = Math.floor(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000
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

    // Fetch Veeqo product details in parallel batches (5/req at a time —
    // Veeqo rate-limits aggressively). Only for products without an override.
    const idsToProbe = idList.filter((pid) => !overrideByPid.has(pid));
    const veeqoProductType = new Map<number, "Frozen" | "Dry" | null>();
    const BATCH = 5;
    for (let i = 0; i < idsToProbe.length; i += BATCH) {
      const slice = idsToProbe.slice(i, i + BATCH);
      const results = await Promise.allSettled(slice.map((pid) => getProduct(pid)));
      for (let j = 0; j < slice.length; j++) {
        const res = results[j];
        if (res.status !== "fulfilled") {
          veeqoProductType.set(slice[j], null);
          continue;
        }
        const product: any = res.value;
        const tags: any[] = product?.tags ?? [];
        const names = tags.map((t) => String(t?.name ?? "").toLowerCase());
        if (names.some((n) => n === "frozen")) {
          veeqoProductType.set(slice[j], "Frozen");
        } else if (names.some((n) => n === "dry")) {
          veeqoProductType.set(slice[j], "Dry");
        } else {
          veeqoProductType.set(slice[j], null);
        }
      }
    }

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
        .filter((i: LiteItem) => i.sku);
      orderItems.set(o.id, items);
      if (requiresPackingProfile(items)) {
        signatures.add(
          buildPackingSignature(
            items.map((i: LiteItem): OrderLineItem => ({
              sku: i.sku,
              quantity: i.quantity,
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
    const skuRows = skuList.size
      ? await prisma.skuShippingData.findMany({
          where: { sku: { in: [...skuList] } },
        })
      : [];
    const skuByCode = new Map(skuRows.map((r) => [r.sku, r]));

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

    const orders = [];
    for (const o of veeqoOrders) {
      const channelName: string = o.channel?.name ?? o.channel_name ?? "";
      const store = channelToStore(channelName);
      const storeId = store?.id ?? "unknown";
      const storeName = store?.name ?? channelName ?? "Unknown";

      const shipBy: string | null =
        o.dispatch_date ?? o.due_date ?? null;
      const bucket = shipByBucket(shipBy);
      if (bucket) timeBuckets[bucket]++;

      const items = orderItems.get(o.id) ?? [];
      const itemsWithType = items.map((i) => ({
        sku: i.sku,
        productId: i.productId,
        productTitle: i.productTitle,
        quantity: i.quantity,
        imageUrl: i.imageUrl,
        knownType: productType(i.productId ?? undefined),
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
            items.map((i) => ({ sku: i.sku, quantity: i.quantity }))
          )
        : "";

      if (isBought(o)) {
        state = "bought";
        totals.boughtToday++;
      } else if (!isPlaced(o)) {
        state = "waiting_placed";
        totals.waitingPlaced++;
      } else {
        // Has Placed — needs to pass several gates.
        const noType = itemsWithType.some((i) => !i.knownType);
        const mixed = isMixedOrder(itemsWithType);
        const frozenWalmart = itemsWithType.some((i) =>
          isFrozenWalmart(channelName, i.knownType)
        );
        // Per-SKU SkuShippingData is only consulted when the order is
        // single-line single-qty (no PackingProfile required). For
        // multi-item orders the PackingProfile covers box+weight, so a
        // missing per-SKU row is fine — don't flag no_sku in that case.
        const needsProfileMissing =
          reqsProfile && !profileBySig.has(sig);
        const missingSku =
          !reqsProfile && items.some((i) => !skuByCode.has(i.sku));

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
        deliverBy:
          o.due_date ??
          o.deliver_no_later_than ??
          o.expected_delivery_date ??
          null,
        state,
        needAttentionReason,
        items: itemsWithType,
        packingSignature: reqsProfile ? sig : null,
        packingProfileFound: reqsProfile ? profileBySig.has(sig) : null,
        orderTotal,
        customerPaidShipping,
        currency: o.currency_code ?? "USD",
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
