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

/**
 * Push parcel dimensions + weight to an allocation's "allocation_package"
 * so the next `/shipping/rates/{allocationId}?from_allocation_package=true`
 * call quotes against the new packaging.
 *
 * Veeqo also persists this as a parcel preset for future shipments with
 * the same composition when `save_for_similar_shipments` is true — this
 * is the behaviour the user noticed in Veeqo's UI ("it remembers last
 * dimensions for this SKU/qty").
 *
 * Units: weight in `oz`, dimensions in `in` (we receive lbs+inches from
 * the UI and convert here so callers don't have to think about it).
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
      save_for_similar_shipments: packageDims.saveForSimilar ?? true,
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
// would render — i.e. America/Los_Angeles (Pacific). The previous
// implementation used `setHours(getHours() - 7)`, which:
//   1. broke on Vercel's UTC runtime: timestamps before 07:00 UTC ended
//      up rendering as the previous day everywhere, including EDDs,
//      pushing labels like UPS Ground Saver out of the deadline window
//      they should have met.
//   2. ignored DST: Pacific is UTC-7 in summer but UTC-8 in winter, so
//      every label between Nov and Mar was already a day off.
// Using Intl.DateTimeFormat with timeZone:"America/Los_Angeles" fixes
// both — it's the same conversion Veeqo's UI does, so EDDs and ship-
// by dates now match Veeqo down to the day.
export function veeqoDateToLocal(utcDate: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date(utcDate));
}

// Get "today" in America/New_York timezone
export function getTodayNY(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}
