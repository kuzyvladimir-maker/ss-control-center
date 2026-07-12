import { veeqoFetch } from "./client";
import { parsePackSize } from "@/lib/procurement/pack-size";
import { shouldIncludeOrderInProcurement } from "@/lib/procurement/filter-rules";
import { hasTag, PROCUREMENT_TAGS } from "./tags";
import { getInternalNotes } from "./notes";
import {
  parseProcurementBlock,
  type LineItemStatus,
} from "./procurement-notes-parser";
import { getListing, flattenListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";

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
  /** Set when Veeqo's stale product-master title disagrees on pack size with
   *  the order-line title we now trust. Surfaced as a warning on the card so
   *  the operator can sanity-check the buy quantity if Veeqo data drifts. */
  packSizeWarning: string | null;

  // Quantities
  quantityOrdered: number;
  remaining: number; // = quantityOrdered if untouched, N if remain:N, 0 if bought (filtered out)

  // Status from [PROCUREMENT] block
  status: LineItemStatus | null;

  // True when the order carries the "Заказано у Майка" Veeqo tag — i.e. Jackie
  // SMS'd Mike (Publix) and ordered it through him instead of online. Such
  // orders are shown for visibility but kept OUT of the buy pool (no checkbox,
  // no "Купил всё") so Vladimir doesn't re-purchase what Mike already has.
  fromMike: boolean;

  // Deadlines (ISO strings as Veeqo returns them)
  shipBy: string | null;
  expectedDispatchDate: string | null;

  // Priority hints
  isPremium: boolean;
  shippingMethod: string | null;

  // Total amount the customer paid INCLUDING shipping — Veeqo's
  // `total_price` is the gross total, not the subtotal. Falls back to
  // `subtotal_price` if `total_price` is missing. Repeated on every line
  // belonging to the same order so the grouping layer (which uses the
  // first line's fields as the order header) picks it up automatically.
  orderTotal: number | null;
  currency: string | null;
}

// Loose shape of an order returned from the Veeqo API. We use unknown-tolerant
// reads everywhere so renames or shape drift in Veeqo don't crash the page.
type VeeqoOrder = Record<string, unknown> & {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string };
  delivery_method?: { name?: string };
  // Veeqo exposes a small zoo of date fields. Names + meanings observed live:
  //   dispatch_date           — when the seller must ship out (THIS is what
  //                              Vladimir cares about for procurement urgency)
  //   expected_dispatch_date  — sometimes set, often null
  //   due_date                — deliver-by date (when customer expects it)
  //   deliver_by              — older alias, frequently null
  // We pick dispatch_date first and only fall back to delivery dates so the
  // "Ship by today / tomorrow" labels match what Veeqo's own UI shows.
  dispatch_date?: string;
  expected_dispatch_date?: string;
  due_date?: string;
  deliver_by?: string;
  is_premium?: boolean;
  priority?: string;
  customer?: { full_name?: string; first_name?: string; last_name?: string };
  line_items?: VeeqoLineItem[];
  total_price?: number | string;
  subtotal_price?: number | string;
  currency_code?: string;
  currency?: string;
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

/**
 * Veeqo's `total_price` already includes shipping (it's the gross total the
 * customer paid). `subtotal_price` is the line-item subtotal pre-shipping
 * — used as fallback only if total_price is missing/zero.
 */
function pickOrderTotal(order: VeeqoOrder): number | null {
  const total = Number(order.total_price ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const subtotal = Number(order.subtotal_price ?? 0);
  if (Number.isFinite(subtotal) && subtotal > 0) return subtotal;
  return null;
}

function pickCurrency(order: VeeqoOrder): string | null {
  return order.currency_code ?? order.currency ?? null;
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

// ── Anchor Amazon cards on the LIVE listing ────────────────────────────────
// Veeqo's cached `sellable` can drift to a stale/wrong product for a SKU (we
// hit a "…16 count White Castle Beef Hamburgers" cached title on an order whose
// real listing was "Gourmet Kitchn Cheese Sliders — 2 Boxes … 64"). For Amazon
// orders the marketplace itself is the source of truth, so we override the
// card's title + image from the live Listings API. Any failure (suspended
// account, no US marketplace, SKU 404, rate limit, network) silently keeps the
// Veeqo values — enrichment is best-effort and never blocks the page.

/** Map a Veeqo Amazon channel to our SP-API store index (1..5). Returns null
 *  for non-Amazon channels or Amazon accounts we can't confidently identify —
 *  the caller then keeps Veeqo's cached title/image. */
function veeqoAmazonStoreIndex(order: VeeqoOrder): number | null {
  const type = (order.channel?.type_code ?? "").toLowerCase();
  const name = (order.channel?.name ?? "").toLowerCase();
  const looksAmazon =
    type.includes("amazon") ||
    /salutem|amz|commerce|sirius|retailer|distributor|personal/.test(name);
  if (!looksAmazon) return null;
  if (name.includes("salutem")) return 1;
  if (name.includes("amz") || name.includes("commerce")) return 3;
  if (name.includes("personal") || name.includes("vladimir")) return 2;
  if (name.includes("sirius")) return 4;
  if (name.includes("retailer") || name.includes("distributor")) return 5;
  return null;
}

type LiveListing = { title: string | null; image: string | null; at: number };

// Best-effort per-instance cache so we don't re-query SP-API for the same SKU
// on every procurement page load. Hits are kept longer than misses so a
// suspended account or transient error can recover on the next load.
const liveListingCache = new Map<string, LiveListing>();
const LIVE_HIT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const LIVE_MISS_TTL_MS = 20 * 60 * 1000; // 20m

async function fetchLiveListing(
  storeIndex: number,
  sku: string,
): Promise<LiveListing> {
  const key = `${storeIndex}:${sku}`;
  const cached = liveListingCache.get(key);
  if (cached) {
    const hit = cached.title || cached.image;
    const ttl = hit ? LIVE_HIT_TTL_MS : LIVE_MISS_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached;
  }
  let result: LiveListing = { title: null, image: null, at: Date.now() };
  try {
    const sellerId = await getMerchantToken(storeIndex);
    const flat = flattenListing(await getListing(storeIndex, sellerId, sku));
    result = {
      title: flat.title?.trim() || null,
      image: flat.main_image_url || null,
      at: Date.now(),
    };
  } catch {
    // keep the empty (miss) result → caller no-ops → Veeqo values stay
  }
  liveListingCache.set(key, result);
  return result;
}

/** Override title + image on Amazon cards from their live listing. Runs a
 *  small concurrency pool (SP-API allows 5 req/s) and dedupes by store+SKU. */
async function anchorAmazonCardsOnLiveListing(
  items: Array<{ card: ProcurementCard; storeIndex: number }>,
): Promise<void> {
  const bySku = new Map<
    string,
    { storeIndex: number; sku: string; cards: ProcurementCard[] }
  >();
  for (const { card, storeIndex } of items) {
    if (!card.sku) continue;
    const key = `${storeIndex}:${card.sku}`;
    const entry = bySku.get(key) ?? { storeIndex, sku: card.sku, cards: [] };
    entry.cards.push(card);
    bySku.set(key, entry);
  }

  const entries = [...bySku.values()];
  if (entries.length === 0) return;

  let cursor = 0;
  const CONCURRENCY = 5;
  const worker = async () => {
    while (cursor < entries.length) {
      const e = entries[cursor++];
      const live = await fetchLiveListing(e.storeIndex, e.sku);
      if (!live.title && !live.image) continue;
      for (const c of e.cards) {
        if (live.title) c.productTitle = live.title;
        if (live.image) c.productImageUrl = live.image;
        // The Veeqo-drift warning compared two Veeqo titles; now that we trust
        // the live listing it's no longer meaningful.
        if (live.title) c.packSizeWarning = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker),
  );
}

/**
 * Top-level fetcher for the Procurement page.
 *   1. Page through all `awaiting_fulfillment` orders
 *   2. Drop orders excluded by tag rules
 *   3. Expand into per-line-item cards
 *   4. Apply the [PROCUREMENT] note block (skip already-bought lines,
 *      adjust `remaining` for partial buys)
 *   5. Anchor Amazon cards' title + image on the live marketplace listing
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
  const enrichable: Array<{ card: ProcurementCard; storeIndex: number }> = [];

  for (const order of allOrders) {
    if (!shouldIncludeOrderInProcurement(order)) continue;

    const notes = getInternalNotes(order);
    const block = parseProcurementBlock(notes);
    const fromMike = hasTag(order as never, PROCUREMENT_TAGS.ORDERED_BY_MIKE);
    const amazonStoreIndex = veeqoAmazonStoreIndex(order);

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

      // Prefer the ORDER-LINE title (what the customer actually bought — this
      // is what both Amazon and Veeqo's own order list show) over Veeqo's
      // shared product-MASTER record, which can drift stale. We hit a case
      // where the master read "2 Pack" while the live listing was "3 Pack",
      // so picking the master made the pack parser under-buy the multipack
      // (bought 2 of 3). See docs/wiki/procurement-title-source.md.
      const lineTitle = sellable.product_title ?? sellable.title ?? null;
      const masterTitle = product.title ?? product.name ?? null;
      const productTitle = lineTitle ?? masterTitle ?? "?";

      // Safety net: if the two titles disagree on parsed pack size, flag it so
      // the operator double-checks the buy quantity even if Veeqo drifts again.
      let packSizeWarning: string | null = null;
      if (lineTitle && masterTitle && lineTitle !== masterTitle) {
        const lineSize = parsePackSize(lineTitle)?.size ?? null;
        const masterSize = parsePackSize(masterTitle)?.size ?? null;
        if (lineSize !== null && masterSize !== null && lineSize !== masterSize) {
          packSizeWarning = `Veeqo каталог: ${masterSize}-pack, заказ: ${lineSize}-pack — берём заказ (${lineSize}). Проверьте кол-во.`;
        }
      }

      const card: ProcurementCard = {
        lineItemId,
        orderId: String(order.id ?? ""),
        orderNumber: order.number ?? String(order.id ?? ""),
        channel: order.channel?.type_code ?? order.channel?.name ?? "Unknown",
        storeName: order.channel?.name ?? "Unknown",
        customerName: pickCustomerName(order),
        productId: String(product.id ?? ""),
        productTitle,
        packSizeWarning,
        productImageUrl: pickImageUrl(li),
        sku: sellable.sku_code ?? sellable.sku ?? "",
        quantityOrdered,
        remaining,
        status,
        fromMike,
        shipBy:
          order.dispatch_date ??
          order.expected_dispatch_date ??
          order.due_date ??
          order.deliver_by ??
          null,
        expectedDispatchDate: order.expected_dispatch_date ?? null,
        isPremium: Boolean(order.is_premium ?? order.priority === "premium"),
        shippingMethod: order.delivery_method?.name ?? null,
        orderTotal: pickOrderTotal(order),
        currency: pickCurrency(order),
      };

      cards.push(card);
      if (amazonStoreIndex !== null && card.sku) {
        enrichable.push({ card, storeIndex: amazonStoreIndex });
      }
    }
  }

  // Override title + image on Amazon cards from the live listing (best-effort).
  await anchorAmazonCardsOnLiveListing(enrichable);

  return cards;
}
