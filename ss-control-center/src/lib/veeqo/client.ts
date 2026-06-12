import { todayNY, utcToPacificYMD } from "@/lib/shipping/dates";

const VEEQO_API_KEY = process.env.VEEQO_API_KEY!;
const VEEQO_BASE_URL = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";

export async function veeqoFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${VEEQO_BASE_URL}${path}`, {
    ...options,
    headers: {
      "x-api-key": VEEQO_API_KEY,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veeqo API error ${res.status}: ${text}`);
  }
  // Some endpoints (e.g. /bulk_tagging) return 204 / empty body on success.
  // res.json() would throw "Unexpected end of JSON input" on those.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Fetch all orders with pagination
export async function fetchAllOrders(status = "awaiting_fulfillment") {
  const allOrders = [];
  let page = 1;
  while (true) {
    const orders = await veeqoFetch(
      `/orders?status=${status}&page_size=100&page=${page}`
    );
    if (!orders || orders.length === 0) break;
    allOrders.push(...orders);
    page++;
  }
  return allOrders;
}

/**
 * Fetch Veeqo orders created within a UTC date range, with parallel
 * pagination for speed. Used by Sales Overview to pull non-cached
 * channels (eBay / TikTok / Shopify / direct / Merged) — Amazon and
 * Walmart already live in our local DB so the caller filters them
 * out post-hoc with `channel.type_code`.
 *
 * Pagination strategy: page_size=200 (Veeqo max) and fire `batchSize`
 * pages at a time. We continue fetching batches as long as the LAST
 * page in the batch came back full — when any page returns < 200 we
 * know we've reached the tail and stop. This keeps the total wall-
 * clock close to `(totalPages / batchSize) * pageLatency` instead of
 * `totalPages * pageLatency`.
 */
async function veeqoFetchWithRetry(
  path: string,
  attempts = 4,
): Promise<unknown> {
  // Veeqo's docs don't publish a hard QPS but empirically the API
  // throws 429 when we run 5+ parallel /orders pages in a tight loop.
  // Exponential backoff (250ms → 500ms → 1s → 2s) recovers cleanly on
  // every 429 we've seen so far; the 4th attempt almost always wins.
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await veeqoFetch(path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/\b429\b/.test(msg)) throw e;
      lastErr = e;
      const delay = 250 * 2 ** i + Math.random() * 150;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Fetch Veeqo orders created within a UTC date range, with parallel
 * pagination for speed. Used by Sales Overview to pull non-cached
 * channels (eBay / TikTok / Shopify / direct / Merged / Etsy) —
 * Amazon and Walmart already live in our local DB so the caller
 * filters them out post-hoc with `channel.type_code`.
 *
 * Pagination strategy: page_size=200 (Veeqo max) and fire `batchSize`
 * pages at a time. The default batchSize=2 is deliberately
 * conservative — earlier 5-way batches were getting 429-throttled in
 * production. Per-page retries with backoff in veeqoFetchWithRetry
 * absorb the occasional rate-limit hit.
 */
export async function fetchOrdersInRange(opts: {
  /** ISO 8601 inclusive start, e.g. "2026-05-01T00:00:00Z" */
  createdAtMin: string;
  /** ISO 8601 inclusive end, e.g. "2026-06-04T23:59:59Z" */
  createdAtMax: string;
  /** Parallel pages per batch. Default 2 — Veeqo 429s anything higher. */
  batchSize?: number;
  /** Hard cap on total orders pulled — defensive guard so a bad
   *  query (e.g. multi-year range) can't run forever. Default 50_000. */
  maxOrders?: number;
}): Promise<unknown[]> {
  const PAGE_SIZE = 200;
  const batch = opts.batchSize ?? 2;
  const cap = opts.maxOrders ?? 50_000;
  const all: unknown[] = [];
  const baseQs =
    `page_size=${PAGE_SIZE}` +
    `&created_at_min=${encodeURIComponent(opts.createdAtMin)}` +
    `&created_at_max=${encodeURIComponent(opts.createdAtMax)}`;
  let page = 1;
  while (all.length < cap) {
    const pages = Array.from({ length: batch }, (_, i) => page + i);
    const results = await Promise.all(
      pages.map((p) =>
        veeqoFetchWithRetry(`/orders?${baseQs}&page=${p}`).then(
          (r) => (Array.isArray(r) ? r : []) as unknown[],
        ),
      ),
    );
    let anyFull = false;
    for (const chunk of results) {
      all.push(...chunk);
      if (chunk.length === PAGE_SIZE) anyFull = true;
    }
    if (!anyFull || results[results.length - 1].length < PAGE_SIZE) break;
    page += batch;
  }
  return all.slice(0, cap);
}

// Get product details (for tags)
export async function getProduct(productId: number) {
  return veeqoFetch(`/products/${productId}`);
}

// Get shipping rates for an allocation (OLD endpoint — no ship-date parameter,
// EDDs are a fixed "ship now" estimate). Kept for Dry + as a fallback.
export async function getShippingRates(allocationId: string) {
  return veeqoFetch(
    `/shipping/rates/${allocationId}?from_allocation_package=true`
  );
}

// ── NEW Rate Shopping API — re-quotes EDDs by ship date ─────────────────────
// `POST /shipping/api/v1/rates` accepts `preferred_shipment_date`, which is the
// ONLY lever that re-anchors carrier EDDs to a chosen physical ship day. This
// is exactly what Veeqo's web UI uses when you change the "Ship Date" dropdown.
// The old GET endpoint above has NO date parameter, which is why the Frozen
// Monday-shift trick never really worked. Full discovery + proof:
// docs/wiki/veeqo-rate-shopping-api.md (verified live 2026-06-12).
//
// We normalize the (differently-named) response fields back onto the SAME shape
// the old code consumes (delivery_promise_date / total_net_charge / title /
// sub_carrier_id / name / shipping_service_options) so selectBestRate and the
// buy flow read rates identically regardless of which endpoint produced them.

export interface VeeqoNormalizedRate {
  carrier: string; // "amazon_shipping_v2" (used as carrierId on buy)
  name: string; // unique per-rate id (new: rate_id) — match on this to buy
  title: string; // display service name (new: service_name)
  short_title: string;
  total_net_charge: string; // price (new: total_charge)
  base_rate: string;
  delivery_promise_date: string; // EDD (new: delivery_estimate)
  sub_carrier_id: string; // "UPS" | "FEDEX" | "USPS" (new: carrier_id)
  service_carrier: string; // "ups" | "fedex" | "usps"
  remote_shipment_id: string;
  service_id: string;
  shipping_service_options: unknown;
  [key: string]: unknown;
}

function normalizeV1Quote(q: Record<string, unknown>): VeeqoNormalizedRate {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    carrier: "amazon_shipping_v2",
    name: s(q.rate_id),
    title: s(q.service_name),
    short_title: s(q.service_name),
    total_net_charge: s(q.total_charge),
    base_rate: s(q.base_rate ?? q.total_charge),
    delivery_promise_date: s(q.delivery_estimate),
    sub_carrier_id: s(q.carrier_id).toUpperCase(),
    service_carrier: s(q.service_carrier),
    remote_shipment_id: s(q.remote_shipment_id ?? ""),
    service_id: s(q.service_id ?? ""),
    shipping_service_options: q.shipping_service_options ?? null,
    rate_id: s(q.rate_id),
  };
}

interface RateShopParcel {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

/**
 * Quote carrier rates for a SPECIFIC physical ship date via the new Rate
 * Shopping API. `order` is the full Veeqo order object (needs deliver_to,
 * allocations[0].warehouse, line_items[].remote_id, number, due_date).
 * `preferredShipmentDate` is an ISO 8601 datetime (the physical ship day).
 * `parcel` overrides the package dims (lbs→oz handled by caller); when omitted
 * we fall back to the allocation's total_weight + allocation_package.
 *
 * Returns `{ available: VeeqoNormalizedRate[] }` to mirror getShippingRates so
 * callers swap endpoints without reshaping. Throws on a hard API error.
 */
export async function getRatesForShipDate(
  order: Record<string, any>,
  preferredShipmentDate: string,
  parcel?: RateShopParcel
): Promise<{ available: VeeqoNormalizedRate[] }> {
  const alloc = order.allocations?.[0];
  const wh = alloc?.warehouse ?? {};
  const to = order.deliver_to ?? {};
  const pkg = alloc?.allocation_package ?? {};

  const toAddress = {
    name: `${to.first_name ?? ""} ${to.last_name ?? ""}`.trim() || to.company || "Customer",
    phone: to.phone || undefined,
    line1: to.address1,
    line2: to.address2 || undefined,
    town: to.city,
    postcode: to.zip,
    country_code: to.country || "US",
    county: to.state || undefined,
  };
  const fromAddress = {
    name: wh.name || wh.trading_name || "Warehouse",
    company: wh.trading_name || wh.name || undefined,
    phone: wh.phone || undefined,
    line1: wh.address_line_1 || wh.address1,
    line2: wh.address_line_2 || undefined,
    town: wh.city,
    postcode: wh.post_code || wh.postcode || wh.zip,
    country_code: wh.country || "US",
    county: wh.region || wh.state || undefined,
  };

  const weightOz = parcel?.weightOz ?? alloc?.total_weight ?? 16;
  const parcels = [
    {
      weight: weightOz,
      weight_unit: "oz",
      length: parcel?.lengthIn ?? pkg.depth ?? undefined,
      width: parcel?.widthIn ?? pkg.width ?? undefined,
      height: parcel?.heightIn ?? pkg.height ?? undefined,
      dimension_unit: "in",
    },
  ];

  const channelItems = (order.line_items ?? [])
    .map((li: any) => ({
      remote_id: String(li?.remote_id ?? li?.id ?? ""),
      quantity: Number(li?.quantity ?? 1),
    }))
    .filter((ci: { remote_id: string }) => ci.remote_id);

  const body = {
    to_address: toAddress,
    from_address: fromAddress,
    parcels,
    customer_reference: order.number,
    is_amazon_order: true,
    due_date: order.due_date || undefined,
    preferred_shipment_date: preferredShipmentDate,
    channel_items: channelItems,
    include_unavailable_quotes: false,
  };

  const resp = await veeqoFetch(`/shipping/api/v1/rates`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const quotes: unknown[] = resp?.quotes ?? resp?.rates ?? resp?.available ?? [];
  const available = (Array.isArray(quotes) ? quotes : []).map((q) =>
    normalizeV1Quote(q as Record<string, unknown>)
  );
  return { available };
}

// Extract Value-Added-Service flags from a Veeqo rate object so the
// matching `/shipping/shipments` POST can echo them back. Veeqo's
// Amazon Shipping V2 errors with INVALID_VALUE_ADDED_SERVICES when the
// request VAS set doesn't match what the chosen rate offered.
//
// Confirmed Veeqo shape (verified from production diagnostic 2026-05-14):
//   rate.shipping_service_options = [
//     { key: "value_added_service__VAS_GROUP_ID_CONFIRMATION",
//       type: "select",
//       values: [{ value: "DELIVERY_CONFIRMATION", label, price, currency }, …] },
//     { key: "liability_amount",  // non-VAS option — skipped
//       type: "number",
//       validation: {min,max}, default: null },
//     …
//   ]
//
// Master rule (from Jackie's experience, confirmed by Vladimir 2026-05-14):
//   shipping_service_options === null  →  send NO VAS field at all.
//     This is how FedEx Ground Economy (SmartPost) works — the carrier
//     doesn't support VAS, so even sending `NO_CONFIRMATION` triggers
//     INVALID_VALUE_ADDED_SERVICES. Don't include the field.
//   shipping_service_options === array →  emit one key per offered VAS
//     group, picking a value from each group's `values` array.
//
// Per-group value choice:
//   1. If any value starts with "NO_" (NO_CONFIRMATION / NO_SIGNATURE) →
//      pick it (least intrusive, almost always free).
//   2. Otherwise pick the cheapest value (price 0 if available) — this
//      is what USPS Ground Advantage requires: only DELIVERY_CONFIRMATION
//      is offered, price 0, and it's effectively mandatory.
export function extractVasFromRate(
  rate: Record<string, unknown>
): Record<string, string> {
  const vas: Record<string, string> = {};

  const options = rate.shipping_service_options;
  // null options → send no VAS at all. Carriers like FedEx SmartPost
  // don't accept the field; sending it (even with a "safe" value)
  // returns INVALID_VALUE_ADDED_SERVICES.
  if (options === null) return vas;

  if (Array.isArray(options)) {
    for (const opt of options) {
      if (!opt || typeof opt !== "object") continue;
      const obj = opt as Record<string, unknown>;
      const key = typeof obj.key === "string" ? obj.key : "";
      if (!key.startsWith("value_added_service__")) continue;

      const rawValues = obj.values;
      if (!Array.isArray(rawValues) || rawValues.length === 0) continue;

      // Normalise each value entry into { value, price }.
      type Norm = { value: string; price: number };
      const parsed: Norm[] = [];
      for (const v of rawValues) {
        if (typeof v === "string" && v) {
          parsed.push({ value: v, price: 0 });
          continue;
        }
        if (v && typeof v === "object") {
          const vo = v as Record<string, unknown>;
          const val =
            typeof vo.value === "string"
              ? vo.value
              : typeof vo.id === "string"
                ? vo.id
                : null;
          if (!val) continue;
          const price =
            typeof vo.price === "number"
              ? vo.price
              : typeof vo.price === "string"
                ? parseFloat(vo.price) || 0
                : 0;
          parsed.push({ value: val, price });
        }
      }
      if (parsed.length === 0) continue;

      const noOpt = parsed.find((p) =>
        p.value.toUpperCase().startsWith("NO_")
      );
      const chosen =
        noOpt ?? parsed.reduce((a, b) => (a.price <= b.price ? a : b));
      vas[key] = chosen.value;
    }
  }

  // Legacy fallback: pre-flattened keys directly on the rate object.
  // Kept in case any carrier uses the older shape.
  for (const [key, value] of Object.entries(rate)) {
    if (
      key.startsWith("value_added_service__") &&
      typeof value === "string" &&
      !(key in vas)
    ) {
      vas[key] = value;
    }
  }

  return vas;
}

// Buy a shipping label. `vas` is passed in from the buy endpoint after
// it re-fetches the live rate and runs `extractVasFromRate` — we don't
// hardcode per-carrier here so the function works for any carrier
// without code edits when Veeqo changes its VAS contract.
export async function buyShippingLabel(payload: {
  allocationId: string;
  carrierId: string;
  remoteShipmentId: string;
  serviceType: string;
  subCarrierId: string;
  serviceCarrier: string;
  totalNetCharge: string;
  baseRate: string;
  vas?: Record<string, string>;
}) {
  const shipment: Record<string, unknown> = {
    allocation_id: payload.allocationId,
    carrier_id: payload.carrierId,
    remote_shipment_id: payload.remoteShipmentId,
    service_type: payload.serviceType,
    notify_customer: false,
    sub_carrier_id: payload.subCarrierId,
    service_carrier: payload.serviceCarrier,
    payment_method_id: null,
    total_net_charge: payload.totalNetCharge,
    base_rate: payload.baseRate,
    ...(payload.vas ?? {}),
  };

  // The OUTER `carrier` field is Veeqo's "shipping integration" name (e.g.
  // "amazon_shipping_v2"). The selected rate's `rate.carrier` IS that
  // integration name — we already pass it through as payload.carrierId —
  // so reuse it here instead of hardcoding amazon_shipping_v2. Hardcoding
  // broke every non-Amazon channel buy (eBay/TikTok/Shopify): Veeqo would
  // reject the POST because the integration name in the body didn't match
  // the carrier_id on the shipment.
  return veeqoFetch("/shipping/shipments", {
    method: "POST",
    body: JSON.stringify({ carrier: payload.carrierId, shipment }),
  });
}

// Set tag on a product (Frozen / Dry)
export async function setProductTag(
  productId: number,
  tagName: "Frozen" | "Dry"
) {
  const colour = tagName === "Frozen" ? "blue" : "green";
  return veeqoFetch(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        tags_attributes: [{ name: tagName, colour }],
      },
    }),
  });
}

/**
 * Update an order's dispatch_date in Veeqo (the field that drives the
 * Ship Date the carrier-rate API uses). Returns the updated order so the
 * caller can read back the saved value if needed.
 *
 * Used by the Frozen "Ship Date Trick" — temporarily shifting an order's
 * dispatch_date to next Monday lets us pull a different rate set from
 * Veeqo, compare it against today's rates, and restore the original date
 * if Monday didn't win.
 */
export async function updateOrderDispatchDate(
  orderId: number | string,
  isoDate: string
) {
  return veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      order: {
        dispatch_date: isoDate,
      },
    }),
  });
}

/**
 * Push parcel dimensions + weight to an allocation's "allocation_package"
 * so the next `/shipping/rates/{allocationId}?from_allocation_package=true`
 * call quotes against the new packaging.
 *
 * Units: weight in `oz`, dimensions in `in` (we receive lbs+inches from
 * the UI and convert here so callers don't have to think about it).
 *
 * `save_for_similar_shipments` default is `false` — Veeqo's
 * /api/operations/update-allocation-package docs explicitly say
 * "Should be false" when dimensions are set via the API. Earlier we
 * sent `true` (thinking it was what made Veeqo remember the dims for
 * the next order with the same SKU/qty), but that triggered silent
 * 422 / non-persistence on at least some allocations — the PUT
 * appeared to succeed but Veeqo's own UI / rate quotes kept showing
 * the original packaging. Our DB already remembers per-SKU dims via
 * SkuShippingData / PackingProfile, so we don't need Veeqo to.
 */
export async function updateAllocationPackage(
  allocationId: number | string,
  packageDims: {
    weightLbs: number;
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    saveForSimilar?: boolean;
  },
) {
  const body = {
    allocation_package: {
      // lbs → oz (Veeqo's accepted units per /api/operations/update-allocation-package)
      weight: Math.round(packageDims.weightLbs * 16 * 100) / 100,
      weight_unit: "oz",
      // Veeqo uses width / height / depth; map our L/W/H so the longest
      // dimension becomes `depth` (Veeqo's convention for shipping label
      // length).
      depth: packageDims.lengthIn,
      width: packageDims.widthIn,
      height: packageDims.heightIn,
      dimensions_unit: "in",
      package_provider: "CUSTOM",
      package_selection_source: "ONE_OFF",
      save_for_similar_shipments: packageDims.saveForSimilar ?? false,
    },
  };
  return veeqoFetch(`/allocations/${allocationId}/allocation_package`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// Add employee note to order
export async function addEmployeeNote(orderId: number, text: string) {
  return veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      order: {
        employee_notes_attributes: [{ text }],
      },
    }),
  });
}

// Convert a Veeqo UTC timestamp to the YYYY-MM-DD string Veeqo's own UI
// displays — Pacific. Veeqo encodes dispatch deadlines as the END of a
// PT calendar day (e.g. `2026-06-05T06:59:59.000Z` = 23:59 PT Jun 4),
// so any other anchor would push those orders into the next calendar
// day and Today/Tomorrow buckets wouldn't agree with Veeqo's "Today"
// badge. Confirmed empirically 2026-06-04 via /api/diag/tz: order
// 113-9443744-1379467 had dispatch_date encoded that way and was
// rendering as 6/5 under Eastern while Veeqo showed 6/4.
//
// History note: an earlier refactor (2026-06-04 same day) tried
// Eastern to "unify on Miami time" — but Miami is the operator's
// chair, not where the data lives. Operator-local "today" still uses
// `todayNY` for the date picker default, etc.
export function veeqoDateToLocal(utcDate: string): string {
  return utcToPacificYMD(utcDate);
}

// Get "today" in America/New_York timezone.
// Re-exported here as an alias of `todayNY` for backward compatibility
// with the many callers that import from veeqo/client. The body has
// always been NY-anchored; only the import path changes.
export function getTodayNY(): string {
  return todayNY();
}
