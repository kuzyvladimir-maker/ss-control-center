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

// Get product details (for tags)
export async function getProduct(productId: number) {
  return veeqoFetch(`/products/${productId}`);
}

// Get shipping rates for an allocation
export async function getShippingRates(allocationId: string) {
  return veeqoFetch(
    `/shipping/rates/${allocationId}?from_allocation_package=true`
  );
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
// Strategy per VAS group:
//   1. If any value starts with "NO_" (NO_CONFIRMATION / NO_SIGNATURE) →
//      pick it (least intrusive, almost always free).
//   2. Otherwise pick the cheapest value (price 0 if available) — this
//      is what USPS Ground Advantage requires: only DELIVERY_CONFIRMATION
//      is offered, price 0, and it's effectively mandatory.
// Candidate VAS sets to try when Veeqo returns
// `shipping_service_options: null` but the underlying carrier still
// requires a VAS value. We have no way to know which value is right
// upfront — Veeqo doesn't tell us — so the buy endpoint tries each
// candidate in order on INVALID_VALUE_ADDED_SERVICES, and stops at the
// first one that succeeds. Order is best-guess: most likely value
// first.
//
// History of observed failures for FEDEX_PTP_SMARTPOST (FedEx Ground
// Economy):
//   2026-05-14 (yesterday): no VAS sent → ✅ succeeded
//   2026-05-14 (today):     no VAS sent → ❌ INVALID_VAS
//   2026-05-14 (today):     DELIVERY_CONFIRMATION → ❌ INVALID_VAS
//   Next to try: NO_CONFIRMATION, then SIGNATURE_CONFIRMATION,
//   then ADULT_SIGNATURE_CONFIRMATION.
//
// Add new service_id entries here if other carriers hit the same
// "null options but VAS required" bug.
const SERVICE_ID_VAS_CANDIDATES: Record<
  string,
  Array<Record<string, string>>
> = {
  FEDEX_PTP_SMARTPOST: [
    {
      value_added_service__VAS_GROUP_ID_CONFIRMATION: "NO_CONFIRMATION",
    },
    {
      value_added_service__VAS_GROUP_ID_CONFIRMATION: "SIGNATURE_CONFIRMATION",
    },
    {
      value_added_service__VAS_GROUP_ID_CONFIRMATION: "ADULT_SIGNATURE_CONFIRMATION",
    },
  ],
};

// Public lookup — returns the candidate list for a given service_id,
// or an empty array. Buy endpoint uses this for retry-on-VAS-error.
export function getVasCandidatesForService(
  serviceId: string | undefined | null
): Array<Record<string, string>> {
  if (!serviceId) return [];
  return SERVICE_ID_VAS_CANDIDATES[serviceId] ?? [];
}

export function extractVasFromRate(
  rate: Record<string, unknown>
): Record<string, string> {
  const vas: Record<string, string> = {};

  const options = rate.shipping_service_options;
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

  // Last-resort fallback for services where Veeqo returns null options
  // but the carrier still requires VAS. Looked up by service_id; only
  // applied when we couldn't extract anything from the actual rate.
  // Returns the FIRST candidate — buy endpoint retries with subsequent
  // candidates if Veeqo rejects this one.
  if (Object.keys(vas).length === 0) {
    const serviceId =
      typeof rate.service_id === "string" ? rate.service_id : "";
    const candidates = SERVICE_ID_VAS_CANDIDATES[serviceId];
    if (candidates && candidates.length > 0) {
      for (const [k, v] of Object.entries(candidates[0])) vas[k] = v;
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

  return veeqoFetch("/shipping/shipments", {
    method: "POST",
    body: JSON.stringify({ carrier: "amazon_shipping_v2", shipment }),
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

// Convert UTC date to UTC-7 (Pacific) as Veeqo uses
export function veeqoDateToLocal(utcDate: string): string {
  const d = new Date(utcDate);
  d.setHours(d.getHours() - 7);
  return d.toISOString().split("T")[0];
}

// Get "today" in America/New_York timezone
export function getTodayNY(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}
