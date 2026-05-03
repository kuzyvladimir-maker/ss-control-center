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
  customerName: string | null;

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

  // Deadlines (ISO strings as Veeqo returns them)
  shipBy: string | null;
  expectedDispatchDate: string | null;

  // Priority hints
  isPremium: boolean;
  shippingMethod: string | null;
}

// Loose shape of an order returned from the Veeqo API. We use unknown-tolerant
// reads everywhere so renames or shape drift in Veeqo don't crash the page.
type VeeqoOrder = Record<string, unknown> & {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string };
  delivery_method?: { name?: string };
  deliver_by?: string;
  expected_dispatch_date?: string;
  is_premium?: boolean;
  priority?: string;
  customer?: { full_name?: string; first_name?: string; last_name?: string };
  line_items?: VeeqoLineItem[];
};

type VeeqoLineItem = {
  id?: string | number;
  quantity?: number;
  sellable?: VeeqoSellable;
};

type VeeqoSellable = {
  sku_code?: string;
  sku?: string;
  title?: string;
  product_title?: string;
  image_url?: string;
  main_image?: { src?: string; url?: string };
  product?: VeeqoProduct;
};

type VeeqoProduct = {
  id?: string | number;
  title?: string;
  name?: string;
  main_image_src?: string;
  main_image_url?: string;
  image_url?: string;
  images?: Array<{
    src?: string;
    url?: string;
    image_url?: string;
    src_thumbnail?: string;
  }>;
};

// Try a long list of field paths Veeqo has been observed to use for product
// images across channels. First non-empty wins. Returning `null` means "no
// image found" — the UI shows a placeholder.
function pickImageUrl(li: VeeqoLineItem): string | null {
  const sellable = li.sellable ?? {};
  const product = sellable.product ?? {};
  const candidates: Array<unknown> = [
    sellable.image_url,
    sellable.main_image?.src,
    sellable.main_image?.url,
    product.main_image_src,
    product.main_image_url,
    product.image_url,
    product.images?.[0]?.src,
    product.images?.[0]?.url,
    product.images?.[0]?.image_url,
    product.images?.[0]?.src_thumbnail,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return null;
}

function pickCustomerName(order: VeeqoOrder): string | null {
  const c = order.customer;
  if (!c) return null;
  if (typeof c.full_name === "string" && c.full_name.trim()) return c.full_name;
  const parts = [c.first_name, c.last_name].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Top-level fetcher for the Procurement page.
 *   1. Page through all `awaiting_fulfillment` orders
 *   2. Drop orders excluded by tag rules
 *   3. Expand into per-line-item cards
 *   4. Apply the [PROCUREMENT] note block (skip already-bought lines,
 *      adjust `remaining` for partial buys)
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

      cards.push({
        lineItemId,
        orderId: String(order.id ?? ""),
        orderNumber: order.number ?? String(order.id ?? ""),
        channel: order.channel?.type_code ?? order.channel?.name ?? "Unknown",
        storeName: order.channel?.name ?? "Unknown",
        customerName: pickCustomerName(order),
        productId: String(product.id ?? ""),
        productTitle:
          product.title ??
          product.name ??
          sellable.title ??
          sellable.product_title ??
          "?",
        productImageUrl: pickImageUrl(li),
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
