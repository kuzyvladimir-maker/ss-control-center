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

// Buy a shipping label
export async function buyShippingLabel(payload: {
  allocationId: string;
  carrierId: string;
  remoteShipmentId: string;
  serviceType: string;
  subCarrierId: string;
  serviceCarrier: string;
  totalNetCharge: string;
  baseRate: string;
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
  };

  // VAS GROUP_ID_CONFIRMATION is only valid for UPS rates.
  //
  // History: previously sent for "UPS/USPS, not FedEx". USPS Ground
  // Advantage now rejects it with INVALID_VALUE_ADDED_SERVICES (2026-05-14,
  // Veeqo API error 400 in production). FedEx has always rejected it.
  // UPS is the only carrier confirmed to require/accept this VAS group
  // through Amazon Shipping V2, so we now scope the field accordingly.
  // If another USPS service ever requires a different VAS, the error
  // surfaces in the post-buy modal — handle case-by-case.
  const carrier = payload.subCarrierId.toUpperCase();
  if (carrier === "UPS") {
    shipment.value_added_service__VAS_GROUP_ID_CONFIRMATION = "NO_CONFIRMATION";
  }

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
