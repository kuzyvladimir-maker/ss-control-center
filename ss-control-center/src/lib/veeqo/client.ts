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
// request VAS set doesn't match what the chosen rate offered — so we
// MUST read VAS from the live rate, not hardcode per-carrier.
//
// Veeqo's rate object can present VAS two ways depending on carrier /
// API version, both handled below:
//   1. Pre-flattened keys: `value_added_service__VAS_GROUP_ID_FOO: "BAR"`
//      → mirror the key/value directly.
//   2. Nested array: `value_added_services: [{ group_id, available_values }]`
//      → pick a no-op default per group (NO_CONFIRMATION / NO_SIGNATURE…)
//      and emit `value_added_service__<group_id>: <value>`.
export function extractVasFromRate(
  rate: Record<string, unknown>
): Record<string, string> {
  const vas: Record<string, string> = {};

  // Pattern 1: keys already flattened on the rate.
  for (const [key, value] of Object.entries(rate)) {
    if (key.startsWith("value_added_service__") && typeof value === "string") {
      vas[key] = value;
    }
  }

  // Pattern 2: nested array with available_values per group.
  const arr = rate.value_added_services;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const group = raw as Record<string, unknown>;
      const groupId = String(group.group_id ?? group.id ?? "");
      if (!groupId) continue;
      const key = `value_added_service__${groupId}`;
      if (key in vas) continue;

      const values =
        (Array.isArray(group.available_values) && group.available_values) ||
        (Array.isArray(group.values) && group.values) ||
        null;
      if (!values || values.length === 0) continue;

      // Prefer a NO_* option (least intrusive — no signature required,
      // no return receipt, …); fall back to the first listed value.
      const pickValue = (v: unknown): string | null => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const obj = v as Record<string, unknown>;
          if (typeof obj.value === "string") return obj.value;
          if (typeof obj.id === "string") return obj.id;
        }
        return null;
      };
      const noOpt = values.find((v: unknown) => {
        const s = pickValue(v);
        return s != null && s.toUpperCase().startsWith("NO_");
      });
      const chosen = pickValue(noOpt ?? values[0]);
      if (chosen) vas[key] = chosen;
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
