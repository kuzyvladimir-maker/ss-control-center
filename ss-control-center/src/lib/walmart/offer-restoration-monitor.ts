/**
 * Read-only buyer-surface monitor for the temporarily suppressed Walmart
 * catalog. Seller API `PUBLISHED` / `IN_STOCK` is intentionally not accepted as
 * buyer availability: during the 2026-08 catalog suspension those fields stayed
 * green while walmart.com showed another seller or no buyable offer at all.
 *
 * The monitored item IDs were resolved through the exact seller SKU -> UPC ->
 * Walmart catalog search chain on 2026-08-09. The public seller identity comes
 * from a buyer-PDP capture made while STARFITSTORE was live on 2026-08-01.
 */

export const WALMART_OFFER_RESTORATION_MONITOR_SCHEMA =
  "walmart-offer-restoration-monitor/v1" as const;

export const WALMART_OFFER_RESTORATION_STATE_KEY =
  "walmart:offer-restoration-monitor:store1:v1" as const;

export const WALMART_OFFER_RESTORATION_TARGETS = [
  {
    sku: "RizwanX-198",
    itemId: "168645059",
    title:
      "Del Monte Diced Tomatoes Basil, Garlic And Oregano, 14.5-Ounce (Pack Of 8)",
    lastSoldAt: "2026-08-07T13:13:28.166Z",
  },
  {
    sku: "FaisalX-1142",
    itemId: "8412902252",
    title:
      "Pepperidge Farm Very Thin 100% Whole Wheat Bread, 16 oz (Pack of 2)",
    lastSoldAt: "2026-08-07T13:11:35.842Z",
  },
  {
    sku: "FaisalX-1884",
    itemId: "9608853551",
    title:
      "Minute Maid Zero Sugar Pink Lemonade Juice, 52 fl oz Bottle (Pack of 6)",
    lastSoldAt: "2026-08-06T17:48:05.204Z",
  },
] as const;

export type WalmartOfferRestorationTarget =
  (typeof WALMART_OFFER_RESTORATION_TARGETS)[number];

const OWN_PUBLIC_SELLER = {
  sellerId: "AAF796A61B674A8E93906B5A41C19CDB",
  catalogSellerId: "101604958",
  names: new Set([
    "sirius trading international llc",
    "starfitstore",
  ]),
} as const;

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BUYABLE_STATUSES = new Set(["AVAILABLE", "IN_STOCK"]);

type JsonRecord = Record<string, unknown>;

export type WalmartOwnOfferStatus = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface WalmartMatchedOffer {
  role: "PRIMARY" | "SECONDARY" | "TOP_BOOSTED";
  sellerId: string | null;
  catalogSellerId: string | null;
  sellerName: string | null;
  sellerDisplayName: string | null;
  availabilityStatus: string | null;
  shippingAvailabilityStatus: string | null;
  price: number | null;
  addToCartEnabled: boolean | null;
  buyable: boolean;
}

export interface WalmartOfferRestorationObservation {
  sku: string;
  itemId: string;
  expectedTitle: string;
  observedTitle: string | null;
  observedAt: string;
  sourceUrl: string;
  finalUrl: string | null;
  status: WalmartOwnOfferStatus;
  reason:
    | "OWN_OFFER_BUYABLE"
    | "OWN_OFFER_NOT_BUYABLE"
    | "OWN_OFFER_NOT_PRESENT"
    | "BUYER_PDP_UNVERIFIED";
  pageAvailabilityStatus: string | null;
  pageAddToCartEnabled: boolean | null;
  matchedOffer: WalmartMatchedOffer | null;
  error: string | null;
}

export interface WalmartPendingRestorationNotification {
  detectedAt: string;
  sourceUrl: string;
  title: string;
  sellerDisplayName: string | null;
  price: number | null;
}

export interface WalmartOfferRestorationStateItem {
  sku: string;
  itemId: string;
  title: string;
  lastStatus: WalmartOwnOfferStatus;
  lastReason: WalmartOfferRestorationObservation["reason"];
  lastObservedAt: string;
  lastSourceUrl: string;
  lastError: string | null;
  pendingNotification: WalmartPendingRestorationNotification | null;
  lastNotifiedAt: string | null;
}

export interface WalmartOfferRestorationState {
  schemaVersion: typeof WALMART_OFFER_RESTORATION_MONITOR_SCHEMA;
  updatedAt: string;
  items: Record<string, WalmartOfferRestorationStateItem>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function statusText(value: unknown): string | null {
  const raw = isRecord(value) ? value.value ?? value.display : value;
  return text(raw)?.toUpperCase().replace(/\s+/gu, "_") ?? null;
}

function priceValue(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const current = isRecord(value.currentPrice) ? value.currentPrice.price : null;
  const parsed = typeof current === "number" ? current : Number(current);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractNextData(html: string): JsonRecord {
  if (
    typeof html !== "string"
    || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES
  ) {
    throw new Error("Walmart PDP HTML must be a bounded string");
  }
  const matches = [
    ...html.matchAll(
      /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/giu,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one Walmart __NEXT_DATA__ script, found ${matches.length}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    throw new Error("Walmart __NEXT_DATA__ is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Walmart __NEXT_DATA__ must be an object");
  return parsed;
}

function exactPrimaryProduct(next: JsonRecord, expectedItemId: string): JsonRecord {
  const props = isRecord(next.props) ? next.props : null;
  const pageProps = props && isRecord(props.pageProps) ? props.pageProps : null;
  const initialData = pageProps && isRecord(pageProps.initialData)
    ? pageProps.initialData
    : null;
  const data = initialData && isRecord(initialData.data) ? initialData.data : null;
  const product = data && isRecord(data.product) ? data.product : null;
  if (!product) throw new Error("Walmart PDP primary product is missing");
  if (text(product.usItemId) !== expectedItemId) {
    throw new Error("Walmart PDP item ID does not match the monitored item");
  }
  const canonical = text(product.canonicalUrl);
  if (!canonical) throw new Error("Walmart PDP canonical URL is missing");
  const canonicalUrl = new URL(canonical, "https://www.walmart.com");
  if (
    (canonicalUrl.hostname !== "walmart.com"
      && !canonicalUrl.hostname.endsWith(".walmart.com"))
    || !canonicalUrl.pathname.match(
      new RegExp(`/ip/(?:[^/]+/)?${expectedItemId}/?$`, "iu"),
    )
  ) {
    throw new Error("Walmart PDP canonical URL does not bind the monitored item");
  }
  return product;
}

function isOwnSeller(offer: JsonRecord): boolean {
  const sellerId = text(offer.sellerId)?.toUpperCase() ?? null;
  const catalogSellerId = text(offer.catalogSellerId);
  const names = [offer.sellerName, offer.sellerDisplayName]
    .map((value) => text(value)?.toLowerCase() ?? null)
    .filter((value): value is string => value !== null);
  return sellerId === OWN_PUBLIC_SELLER.sellerId
    || catalogSellerId === OWN_PUBLIC_SELLER.catalogSellerId
    || names.some((name) => OWN_PUBLIC_SELLER.names.has(name));
}

function shippingAvailability(offer: JsonRecord): string | null {
  const options = Array.isArray(offer.fulfillmentOptions)
    ? offer.fulfillmentOptions.filter(isRecord)
    : [];
  const shipping = options.find(
    (option) => statusText(option.type) === "SHIPPING",
  );
  if (shipping) return statusText(shipping.availabilityStatus);
  const shippingOption = isRecord(offer.shippingOption)
    ? offer.shippingOption
    : null;
  return shippingOption ? statusText(shippingOption.availabilityStatus) : null;
}

function projectOffer(
  offer: JsonRecord,
  role: WalmartMatchedOffer["role"],
): WalmartMatchedOffer {
  const availabilityStatus = statusText(offer.availabilityStatus);
  const shippingAvailabilityStatus = shippingAvailability(offer);
  const price = priceValue(offer.priceInfo);
  const addToCartEnabled = role === "PRIMARY"
    ? typeof offer.showAtc === "boolean" ? offer.showAtc : null
    : null;
  const buyable = BUYABLE_STATUSES.has(availabilityStatus ?? "")
    && BUYABLE_STATUSES.has(shippingAvailabilityStatus ?? "")
    && price !== null
    && (role !== "PRIMARY" || addToCartEnabled === true);
  return {
    role,
    sellerId: text(offer.sellerId),
    catalogSellerId: text(offer.catalogSellerId),
    sellerName: text(offer.sellerName),
    sellerDisplayName: text(offer.sellerDisplayName),
    availabilityStatus,
    shippingAvailabilityStatus,
    price,
    addToCartEnabled,
    buyable,
  };
}

function candidateOffers(product: JsonRecord): Array<{
  value: JsonRecord;
  role: WalmartMatchedOffer["role"];
}> {
  const offers: Array<{
    value: JsonRecord;
    role: WalmartMatchedOffer["role"];
  }> = [{ value: product, role: "PRIMARY" }];
  if (Array.isArray(product.secondaryOffers)) {
    for (const value of product.secondaryOffers) {
      if (isRecord(value)) offers.push({ value, role: "SECONDARY" });
    }
  }
  if (isRecord(product.topBoostedOffer)) {
    offers.push({ value: product.topBoostedOffer, role: "TOP_BOOSTED" });
  }
  return offers;
}

function unknownObservation(
  target: WalmartOfferRestorationTarget,
  observedAt: string,
  finalUrl: string | null,
  error: unknown,
): WalmartOfferRestorationObservation {
  return {
    sku: target.sku,
    itemId: target.itemId,
    expectedTitle: target.title,
    observedTitle: null,
    observedAt,
    sourceUrl: `https://www.walmart.com/ip/${target.itemId}`,
    finalUrl,
    status: "UNKNOWN",
    reason: "BUYER_PDP_UNVERIFIED",
    pageAvailabilityStatus: null,
    pageAddToCartEnabled: null,
    matchedOffer: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Pure parser: no network, database, provider, or Walmart writes. */
export function inspectWalmartOwnOfferHtml(
  html: string,
  target: WalmartOfferRestorationTarget,
  options: { observedAt?: string; finalUrl?: string | null } = {},
): WalmartOfferRestorationObservation {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const finalUrl = options.finalUrl ?? null;
  try {
    const product = exactPrimaryProduct(extractNextData(html), target.itemId);
    const ownOffers = candidateOffers(product)
      .filter((candidate) => isOwnSeller(candidate.value))
      .map((candidate) => projectOffer(candidate.value, candidate.role));
    const matchedOffer = ownOffers.find((offer) => offer.buyable)
      ?? ownOffers[0]
      ?? null;
    const available = matchedOffer?.buyable === true;
    return {
      sku: target.sku,
      itemId: target.itemId,
      expectedTitle: target.title,
      observedTitle: text(product.name),
      observedAt,
      sourceUrl: `https://www.walmart.com/ip/${target.itemId}`,
      finalUrl,
      status: available ? "AVAILABLE" : "UNAVAILABLE",
      reason: available
        ? "OWN_OFFER_BUYABLE"
        : matchedOffer
          ? "OWN_OFFER_NOT_BUYABLE"
          : "OWN_OFFER_NOT_PRESENT",
      pageAvailabilityStatus:
        statusText(product.itemPageAvailabilityStatus)
        ?? statusText(product.availabilityStatus),
      pageAddToCartEnabled:
        typeof product.showAtc === "boolean" ? product.showAtc : null,
      matchedOffer,
      error: null,
    };
  } catch (error) {
    return unknownObservation(target, observedAt, finalUrl, error);
  }
}

export type WalmartBuyerPdpFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** One free, read-only walmart.com GET. Paid providers are never invoked. */
export async function fetchWalmartOwnOfferObservation(
  target: WalmartOfferRestorationTarget,
  fetcher: WalmartBuyerPdpFetcher = fetch,
  observedAt = new Date().toISOString(),
): Promise<WalmartOfferRestorationObservation> {
  const sourceUrl = `https://www.walmart.com/ip/${target.itemId}`;
  let finalUrl: string | null = null;
  try {
    const response = await fetcher(sourceUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
          + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 "
          + "Safari/537.36",
      },
      signal: AbortSignal.timeout(25_000),
    });
    finalUrl = response.url || sourceUrl;
    if (!response.ok) throw new Error(`Walmart PDP returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
      throw new Error("Walmart PDP response exceeds the byte limit");
    }
    const html = await response.text();
    return inspectWalmartOwnOfferHtml(html, target, { observedAt, finalUrl });
  } catch (error) {
    return unknownObservation(target, observedAt, finalUrl, error);
  }
}

export function parseWalmartOfferRestorationState(
  raw: string | null | undefined,
): WalmartOfferRestorationState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== WALMART_OFFER_RESTORATION_MONITOR_SCHEMA
      || !text(parsed.updatedAt)
      || !isRecord(parsed.items)
    ) {
      return null;
    }
    return parsed as unknown as WalmartOfferRestorationState;
  } catch {
    return null;
  }
}

export function advanceWalmartOfferRestorationState(
  previous: WalmartOfferRestorationState | null,
  observations: WalmartOfferRestorationObservation[],
  updatedAt = new Date().toISOString(),
): WalmartOfferRestorationState {
  const items: Record<string, WalmartOfferRestorationStateItem> = {};
  for (const observation of observations) {
    const prior = previous?.items[observation.sku] ?? null;
    const becameAvailable = observation.status === "AVAILABLE"
      && prior?.lastStatus !== "AVAILABLE";
    const pendingNotification = prior?.pendingNotification
      ?? (becameAvailable && observation.matchedOffer
        ? {
            detectedAt: observation.observedAt,
            sourceUrl: observation.sourceUrl,
            title: observation.observedTitle ?? observation.expectedTitle,
            sellerDisplayName:
              observation.matchedOffer.sellerDisplayName
              ?? observation.matchedOffer.sellerName,
            price: observation.matchedOffer.price,
          }
        : null);
    items[observation.sku] = {
      sku: observation.sku,
      itemId: observation.itemId,
      title: observation.observedTitle ?? observation.expectedTitle,
      lastStatus: observation.status,
      lastReason: observation.reason,
      lastObservedAt: observation.observedAt,
      lastSourceUrl: observation.sourceUrl,
      lastError: observation.error,
      pendingNotification,
      lastNotifiedAt: prior?.lastNotifiedAt ?? null,
    };
  }
  return {
    schemaVersion: WALMART_OFFER_RESTORATION_MONITOR_SCHEMA,
    updatedAt,
    items,
  };
}

export function pendingWalmartRestorationSkus(
  state: WalmartOfferRestorationState,
): string[] {
  return Object.values(state.items)
    .filter((item) => item.pendingNotification !== null)
    .map((item) => item.sku)
    .sort();
}

export function markWalmartRestorationNotificationsDelivered(
  state: WalmartOfferRestorationState,
  skus: string[],
  deliveredAt = new Date().toISOString(),
): WalmartOfferRestorationState {
  const delivered = new Set(skus);
  return {
    ...state,
    updatedAt: deliveredAt,
    items: Object.fromEntries(
      Object.entries(state.items).map(([sku, item]) => [
        sku,
        delivered.has(sku)
          ? {
              ...item,
              pendingNotification: null,
              lastNotifiedAt: deliveredAt,
            }
          : item,
      ]),
    ),
  };
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

export function formatWalmartRestorationTelegram(
  state: WalmartOfferRestorationState,
  skus: string[],
): string {
  const lines = skus.flatMap((sku) => {
    const item = state.items[sku];
    const pending = item?.pendingNotification;
    if (!item || !pending) return [];
    const price = pending.price === null ? "" : ` — $${pending.price.toFixed(2)}`;
    return [
      `• <code>${escapeTelegramHtml(sku)}</code>${price}`,
      `  <a href="${escapeTelegramHtml(pending.sourceUrl)}">Открыть на Walmart</a>`,
    ];
  });
  const availableCount = Object.values(state.items)
    .filter((item) => item.lastStatus === "AVAILABLE").length;
  return [
    "<b>Walmart: наше предложение снова доступно покупателю</b>",
    "",
    ...lines,
    "",
    `Сейчас доступно наших контрольных SKU: ${availableCount}/${WALMART_OFFER_RESTORATION_TARGETS.length}.`,
    "Проверено по публичной карточке и точному seller identity STARFITSTORE.",
  ].join("\n");
}
