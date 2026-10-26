/**
 * Live NAN Health (Shopify) rates — payload parsing and display helpers.
 *
 * Shopify's shippingLabelPurchase API lists no rates and can't buy FedEx, so a
 * collector on our server (scripts/nan_rates_collector.py, Jackie) reads the
 * Shopify admin "Buy shipping label" page through the iMac Chrome session (no
 * purchase) and POSTs here:
 *   {captured_at, orders:[{order_name:"#1374", shopify_order_id,
 *     dest:{city,state,country}, package:{l,w,h,in?,weight_lb},
 *     rates:[{carrier,service,price_usd,eta_text,cheapest,fastest}]}]}
 * Pure: no DB, no network.
 */

export const NAN_SHOPIFY_STORE = "1bndby-p8";
/** A snapshot older than this is shown grey and marked stale. */
export const NAN_RATES_STALE_MIN = 30;
export const NAN_CARRIERS = ["FedEx", "UPS", "USPS", "DHL"] as const;

export interface NanRate {
  carrier: string;
  service: string;
  price: number;
  eta: string;
  cheapest: boolean;
  fastest: boolean;
  /** Shopify's codes for this rate (e.g. "ups_shipping"/"93"): what the
   *  official shippingLabelPurchase takes as preferredRateSelection. Absent
   *  on snapshots captured before 2026-10-26. */
  carrierCode?: string;
  serviceCode?: string;
}

export interface NanOrderSnapshot {
  orderNumber: string; // without "#"
  shopifyOrderId: string | null;
  dest: { city?: string; state?: string; country?: string } | null;
  pkg: Record<string, unknown> | null;
  rates: NanRate[];
}

/** "#1374" / " 1374 " → "1374". */
export function normOrderNumber(n: unknown): string {
  return String(n ?? "").trim().replace(/^#/, "");
}

function carrierOf(full: string, given: string): { carrier: string; service: string } {
  const g = given.trim();
  const known = NAN_CARRIERS.find(
    (c) => c.toLowerCase() === g.toLowerCase(),
  );
  if (known) {
    // Drop a repeated carrier prefix from the service ("UPS Ground" → "Ground").
    const svc = full.trim().replace(new RegExp(`^${known}[®™]?\\s+`, "i"), "");
    return { carrier: known, service: svc || full.trim() };
  }
  for (const c of NAN_CARRIERS) {
    const m = new RegExp(`^${c}[®™]?\\s+`, "i").exec(full.trim());
    if (m) return { carrier: c, service: full.trim().slice(m[0].length).trim() };
  }
  return { carrier: g, service: full.trim() };
}

/** Smallest day count in an ETA text ("4-5d" → 4, "2 business days" → 2). */
export function etaDays(eta: string): number {
  const m = /(\d+)/.exec(eta ?? "");
  return m ? Number(m[1]) : Infinity;
}

const isMediaOnly = (r: { service: string; eta: string }) =>
  /media/i.test(`${r.service} ${r.eta}`);

/**
 * Normalise a rates list (the collector's objects, or the older compact
 * tuples ["FedEx Ground Economy", 6.98, "4-5d"]). Sorted cheapest first;
 * media-only mail last (not for food). `cheapest`/`fastest` come from the
 * collector when it sets them, else are computed (media-only excluded).
 */
export function normalizeNanRates(raw: unknown): NanRate[] {
  if (!Array.isArray(raw)) return [];
  const out: NanRate[] = [];
  let flagged = false;
  for (const r of raw) {
    let full = "";
    let given = "";
    let price = NaN;
    let eta = "";
    let cheapest = false;
    let fastest = false;
    let carrierCode = "";
    let serviceCode = "";
    if (Array.isArray(r)) {
      full = String(r[0] ?? "");
      price = Number(r[1]);
      eta = String(r[2] ?? "");
    } else if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      full = String(o.service ?? o.name ?? "");
      given = String(o.carrier ?? "");
      price = Number(o.price_usd ?? o.price ?? o.amount);
      eta = String(o.eta_text ?? o.eta ?? o.transit ?? "");
      cheapest = o.cheapest === true;
      fastest = o.fastest === true;
      carrierCode = String(o.carrier_code ?? o.carrierCode ?? "").trim();
      serviceCode = String(o.service_code ?? o.serviceCode ?? "").trim();
      if (cheapest || fastest) flagged = true;
    }
    if (!full || !Number.isFinite(price) || price <= 0) continue;
    const { carrier, service } = carrierOf(full, given);
    out.push({
      carrier,
      service,
      price: Math.round(price * 100) / 100,
      eta: eta.trim(),
      cheapest,
      fastest,
      ...(carrierCode && serviceCode ? { carrierCode, serviceCode } : {}),
    });
  }
  if (!flagged) {
    const usable = out.filter((r) => !isMediaOnly(r));
    const minPrice = Math.min(...usable.map((r) => r.price));
    const minDays = Math.min(...usable.map((r) => etaDays(r.eta)));
    for (const r of usable) {
      r.cheapest = r.price === minPrice;
      r.fastest = Number.isFinite(minDays) && etaDays(r.eta) === minDays;
    }
  }
  return out.sort(
    (a, b) => Number(isMediaOnly(a)) - Number(isMediaOnly(b)) || a.price - b.price,
  );
}

/** Parse the collector's POST body. Invalid orders are skipped, not fatal. */
export function parseNanPayload(body: unknown): {
  capturedAt: Date | null;
  orders: NanOrderSnapshot[];
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const ts = Date.parse(String(b.captured_at ?? b.capturedAt ?? ""));
  const capturedAt = Number.isFinite(ts) ? new Date(ts) : null;
  const list = Array.isArray(b.orders) ? b.orders : [];
  const orders: NanOrderSnapshot[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const orderNumber = normOrderNumber(r.order_name ?? r.order);
    const rates = normalizeNanRates(r.rates);
    if (!orderNumber || rates.length === 0) continue;
    orders.push({
      orderNumber,
      shopifyOrderId:
        r.shopify_order_id != null ? String(r.shopify_order_id) : null,
      dest:
        r.dest && typeof r.dest === "object"
          ? (r.dest as NanOrderSnapshot["dest"])
          : null,
      pkg:
        r.package && typeof r.package === "object"
          ? (r.package as Record<string, unknown>)
          : null,
      rates,
    });
  }
  return { capturedAt, orders };
}

/** "3 мин назад" / "2 ч назад"; stale after NAN_RATES_STALE_MIN minutes. */
export function snapshotAge(
  capturedAt: string | Date | null | undefined,
  now: Date = new Date(),
): { text: string; stale: boolean } {
  if (!capturedAt) return { text: "снимка ещё нет", stale: true };
  const t = new Date(capturedAt).getTime();
  if (!Number.isFinite(t)) return { text: "время неизвестно", stale: true };
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  const text =
    min < 1
      ? "только что"
      : min < 60
        ? `${min} мин назад`
        : min < 48 * 60
          ? `${Math.floor(min / 60)} ч назад`
          : `${Math.floor(min / 1440)} дн. назад`;
  return { text, stale: min > NAN_RATES_STALE_MIN };
}

/** Shopify admin page for the order (the owner buys there himself). */
export function nanAdminOrderUrl(
  shopifyOrderId: string | null | undefined,
  orderNumber: string,
): string {
  const base = `https://admin.shopify.com/store/${NAN_SHOPIFY_STORE}/orders`;
  return shopifyOrderId
    ? `${base}/${encodeURIComponent(shopifyOrderId)}`
    : `${base}?query=${encodeURIComponent(normOrderNumber(orderNumber))}`;
}
