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
  return res.json();
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

  // VAS field required for UPS/USPS only — FedEx rejects it
  const carrier = payload.subCarrierId.toUpperCase();
  if (carrier !== "FEDEX") {
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
