import { veeqoFetch } from "./client";
import { shouldIncludeOrderInProcurement } from "@/lib/procurement/filter-rules";
import { getInternalNotes } from "./notes";
import {
  parseProcurementBlock,
  type LineItemStatus,
} from "./procurement-notes-parser";

export interface ProcurementCard {
  // Stable per-line key
  lineItemId: string;

  // Order
  orderId: string;
  orderNumber: string;
  channel: string; // "Amazon" | "Walmart" | "eBay" | ...
  storeName: string; // e.g. one of the 5 Amazon accounts

  // Product
  productId: string;
  productTitle: string;
  productImageUrl: string | null;
  sku: string;

  // Quantities
  quantityOrdered: number;
  remaining: number; // = quantityOrdered if untouched, N if remain:N, 0 if bought (filtered out)

  // Status from [PROCUREMENT] block
  status: LineItemStatus | null;

  // Deadlines
  shipBy: string | null;
  expectedDispatchDate: string | null;

  // Priority hints
  isPremium: boolean;
  shippingMethod: string | null;
}

// Loose shape of an order returned from the Veeqo API. Field names are
// best-effort; many of these are guesses confirmed by other modules in this
// repo. Anything missing falls back to safe defaults rather than crashing.
type VeeqoOrder = {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string };
  delivery_method?: { name?: string };
  deliver_by?: string;
  expected_dispatch_date?: string;
  is_premium?: boolean;
  priority?: string;
  line_items?: VeeqoLineItem[];
} & Record<string, unknown>;

type VeeqoLineItem = {
  id?: string | number;
  quantity?: number;
  sellable?: {
    sku_code?: string;
    sku?: string;
    title?: string;
    product?: {
      id?: string | number;
      title?: string;
      images?: Array<{ src?: string; url?: string }>;
    };
  };
};

/**
 * Top-level fetcher for the Procurement page.
 *   1. Page through all `awaiting_fulfillment` orders
 *   2. Drop orders excluded by tag rules
 *   3. Expand into per-line-item cards
 *   4. Apply the [PROCUREMENT] note block (skip already-bought lines,
 *      adjust `remaining` for partial buys)
 *
 * NB: Several Veeqo field names below (channel.type_code, is_premium, image
 * shape) are educated guesses. Phase 1's success criteria don't depend on
 * any single one being correct — anything missing falls back to a safe
 * default. Tighten in Phase 2 once we've inspected a real response.
 */
export async function fetchProcurementCards(): Promise<ProcurementCard[]> {
  const allOrders: VeeqoOrder[] = [];
  let page = 1;

  while (true) {
    const orders = (await veeqoFetch(
      `/orders?status=awaiting_fulfillment&page_size=100&page=${page}`
    )) as VeeqoOrder[];
    if (!Array.isArray(orders) || orders.length === 0) break;
    allOrders.push(...orders);
    if (orders.length < 100) break;
    page++;
    if (page > 50) break; // safety cap
  }

  const cards: ProcurementCard[] = [];

  for (const order of allOrders) {
    if (!shouldIncludeOrderInProcurement(order)) continue;

    const notes = getInternalNotes(order);
    const block = parseProcurementBlock(notes);

    for (const li of order.line_items ?? []) {
      const lineItemId = String(li.id ?? "");
      if (!lineItemId) continue;

      const status = block.items.get(lineItemId) ?? null;

      // Skip already-bought lines even if the Placed tag hasn't been set yet
      // (the action that sets the tag may have failed/be pending).
      if (status?.kind === "bought") continue;

      const quantityOrdered = li.quantity ?? 0;
      let remaining = quantityOrdered;
      if (status?.kind === "remain") remaining = status.remaining;

      const sellable = li.sellable ?? {};
      const product = sellable.product ?? {};
      const images = product.images ?? [];

      cards.push({
        lineItemId,
        orderId: String(order.id ?? ""),
        orderNumber: order.number ?? String(order.id ?? ""),
        channel: order.channel?.type_code ?? order.channel?.name ?? "Unknown",
        storeName: order.channel?.name ?? "Unknown",
        productId: String(product.id ?? ""),
        productTitle: product.title ?? sellable.title ?? "?",
        productImageUrl: images[0]?.src ?? images[0]?.url ?? null,
        sku: sellable.sku_code ?? sellable.sku ?? "",
        quantityOrdered,
        remaining,
        status,
        shipBy: order.deliver_by ?? null,
        expectedDispatchDate: order.expected_dispatch_date ?? null,
        isPremium: Boolean(order.is_premium ?? order.priority === "premium"),
        shippingMethod: order.delivery_method?.name ?? null,
      });
    }
  }

  return cards;
}
