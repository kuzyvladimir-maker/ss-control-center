// CS Analysis result from Claude API (v1.2)
export interface CsAnalysisResult {
  id?: string;
  channel: "Amazon" | "Walmart";
  store: string;
  orderId: string;
  customerName: string;
  product: string;
  productType: "Frozen" | "Dry" | "Unknown";
  category: string; // C1-C10
  categoryName: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  language: "English" | "Spanish";
  branch?: "A" | "B" | null;
  branchName?: string | null;
  response: string;
  action: "REPLACEMENT" | "REFUND" | "A2Z_GUARANTEE" | "PHOTO_REQUEST" | "ESCALATE" | "INFO";
  urgency: string;
  internalNotes: string;
  // Carrier delay detection (v1.2)
  carrierDelayDetected: boolean;
  carrierBadge?: "Claims Protected" | "Late Delivery Risk" | "Unknown" | null;
  shippedOnTime?: boolean | null;
  promisedEdd?: string | null;
  actualDelivery?: string | null;
  daysLate?: number | null;
  // Tracking (extracted from screenshots if visible)
  trackingNumber?: string | null;
  trackingCarrier?: "UPS" | "FedEx" | "USPS" | null;
  trackingUrl?: string | null;
  shippingTimeline?: {
    shipDate?: string | null;
    edd?: string | null;
    actualDelivery?: string | null;
    status?: string | null;
    carrierDelayed?: boolean;
  } | null;
}

// CS Case from database
export interface CsCase {
  id: string;
  channel: string;
  store?: string | null;
  orderId?: string | null;
  customerName?: string | null;
  product?: string | null;
  productType?: string | null;
  category?: string | null;
  categoryName?: string | null;
  priority?: string | null;
  language?: string | null;
  branch?: string | null;
  branchName?: string | null;
  response?: string | null;
  action?: string | null;
  urgency?: string | null;
  internalNotes?: string | null;
  carrierDelayDetected: boolean;
  carrierBadge?: string | null;
  shippedOnTime?: boolean | null;
  promisedEdd?: string | null;
  actualDelivery?: string | null;
  daysLate?: number | null;
  status: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Veeqo order
export interface VeeqoOrder {
  id: number;
  number: string;
  status: string;
  channel: { name: string };
  customer: { full_name: string };
  dispatch_date: string;
  due_date: string;
  deliver_to: { first_name: string; last_name: string };
  total_price: string;
  delivery_cost: string;
  employee_notes: string;
  tags: { name: string }[];
  line_items: VeeqoLineItem[];
  allocations: VeeqoAllocation[];
}

export interface VeeqoLineItem {
  id: number;
  quantity: number;
  sellable: {
    sku: string;
    product_title: string;
    product: { id: number };
  };
}

export interface VeeqoAllocation {
  id: number;
  line_item_ids: number[];
}

// Shipping rate from Veeqo
export interface ShippingRate {
  carrier_id: string;
  carrier_name: string;
  service_name: string;
  service_type: string;
  total_net_charge: string;
  base_rate: string;
  delivery_promise_date: string;
  remote_shipment_id: string;
  sub_carrier_id: string;
  service_carrier: string;
}

// Shipping plan item for the UI
export interface ShippingPlanRow {
  id: string;
  orderNumber: string;
  orderId: string;
  channel: string;
  product: string;
  sku: string;
  qty: number;
  productType: "Frozen" | "Dry";
  weight: number | null;
  boxSize: string | null;
  budgetMax: number | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
  edd: string | null;
  deliveryBy: string | null;
  actualShipDay: string | null;
  notes: string | null;
  status: "pending" | "approved" | "bought" | "error" | "stop";
  trackingNumber?: string;
}

// Dashboard stats
export interface DashboardStats {
  ordersToday: number;
  shipToday: number;
  labelsBought: number;
  labelsTotal: number;
  csCasesOpen: number;
}

// Navigation item for sidebar
export interface NavItem {
  title: string;
  href: string;
  icon: string;
  phase?: number;
  disabled?: boolean;
}
