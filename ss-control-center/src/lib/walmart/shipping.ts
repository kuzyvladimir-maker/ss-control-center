/**
 * Walmart "Ship with Walmart" (SWW / Buy Shipping) API — rate shopping +
 * label purchase. This is the API behind the Seller Center "Buy Shipping"
 * button, on Walmart's negotiated FedEx/UPS/USPS accounts.
 *
 * Why it matters: buying a label here does NOT mark the order Shipped (it
 * stays Acknowledged) — unlike Veeqo, which pushes a fulfillment to Walmart
 * the moment a label is bought. So SSCC can buy the label and let the
 * walmart-ship-confirm cron mark Shipped only once the package is moving.
 *
 * Schema verified live 2026-05-30 against STORE1. Endpoints (note they nest
 * under /shipping/labels, NOT /shipping):
 *   POST /v3/shipping/labels/shipping-estimates  — rate shopping (free quote)
 *   POST /v3/shipping/labels                      — buy a label
 *   GET  /v3/shipping/labels/carriers             — supported carriers
 *   GET  /v3/shipping/labels/carriers/{c}/package-types
 *   GET  /v3/shipping/labels/carriers/{c}/trackings/{tn}  — download label PDF
 */

import type { WalmartClient } from "./client";

/* eslint-disable @typescript-eslint/no-explicit-any */

// The single registered ship node for STORE1. SWW estimates need a from
// address; createLabel derives it from the PO so doesn't. If a second
// warehouse/ship node is added, make this configurable.
export const SHIP_FROM_WAREHOUSE_1162 = {
  addressLines: ["1162 Kapp Dr"],
  city: "Clearwater",
  state: "FL",
  postalCode: "33765",
  countryCode: "US",
};

export interface BoxInput {
  length: number;
  width: number;
  height: number;
  weight: number;
  dimUnit?: "IN" | "FT" | "CM"; // default IN
  weightUnit?: "LB" | "KG" | "OZ"; // default LB
}

export interface ShipAddressInput {
  addressLines: string[];
  city: string;
  state: string;
  postalCode: string;
  countryCode?: string; // default US
}

export interface WalmartRateOption {
  /** Pass this back to buyShippingLabel as carrierServiceType. e.g. GROUND_ADVANTAGE */
  serviceType: string;
  displayName: string; // e.g. "USPS Ground Advantage"
  carrierName: string; // e.g. USPS | FedEx — pass back as carrierName
  amount: number | null;
  currency: string | null;
  deliveryDate: string | null;
  deliveryPromiseFulfilled: boolean;
}

function boxDimensions(b: BoxInput) {
  return {
    boxLength: b.length,
    boxWidth: b.width,
    boxHeight: b.height,
    boxWeight: b.weight,
    boxDimensionUnit: b.dimUnit ?? "IN",
    boxWeightUnit: b.weightUnit ?? "LB",
  };
}

// Walmart requires dates as yyyy-MM-dd'T'HH:mm:ss.SSS'Z' — exactly what
// Date.prototype.toISOString() emits.
function toIsoZ(d: string | Date): string {
  return new Date(d).toISOString();
}

function address(a: ShipAddressInput) {
  return {
    addressLines: a.addressLines.filter(Boolean),
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    countryCode: a.countryCode ?? "US",
  };
}

/** Rate-shop a shipment. Read-only quote — does NOT buy anything. */
export async function estimateShippingRates(
  client: WalmartClient,
  opts: {
    box: BoxInput;
    to: ShipAddressInput;
    shipByDate: string | Date;
    deliverByDate: string | Date;
    from?: ShipAddressInput;
    packageType?: string;
  },
): Promise<WalmartRateOption[]> {
  const body = {
    packageType: opts.packageType ?? "CUSTOM_PACKAGE",
    shipByDate: toIsoZ(opts.shipByDate),
    deliverByDate: toIsoZ(opts.deliverByDate),
    boxDimensions: boxDimensions(opts.box),
    fromAddress: opts.from ? address(opts.from) : SHIP_FROM_WAREHOUSE_1162,
    toAddress: address(opts.to),
  };
  const r = await client.request<any>("POST", "/shipping/labels/shipping-estimates", { body });
  const estimates: any[] = r?.data?.estimates ?? r?.estimates ?? [];
  return estimates.map((e) => ({
    serviceType: String(e?.name ?? ""),
    displayName: String(e?.displayName ?? ""),
    carrierName: String(e?.carrierName ?? ""),
    amount: typeof e?.estimatedRate?.amount === "number" ? e.estimatedRate.amount : null,
    currency: e?.estimatedRate?.currency ?? null,
    deliveryDate: e?.deliveryDate ?? null,
    deliveryPromiseFulfilled: !!e?.isDeliveryPromiseFulfilled,
  }));
}

export interface BuyLabelResult {
  purchaseOrderId: string;
  trackingNumber: string;
  carrierName: string;
  carrierServiceType: string;
  boxItems: Array<{ sku?: string; quantity: number; lineNumber: string }>;
  raw: unknown;
}

/**
 * Buy a Ship-with-Walmart label for an order. Does NOT mark the order
 * Shipped. carrierName + carrierServiceType come from a chosen rate option
 * (carrierName + serviceType from estimateShippingRates). Accept stays
 * application/json so we get the tracking number back as JSON; download the
 * PDF separately via downloadLabelPdf.
 */
export async function buyShippingLabel(
  client: WalmartClient,
  opts: {
    purchaseOrderId: string;
    carrierName: string;
    carrierServiceType: string;
    box: BoxInput;
    boxItems: Array<{ sku?: string; quantity: number; lineNumber: string }>;
    packageType?: string;
  },
): Promise<BuyLabelResult> {
  const body = {
    purchaseOrderId: opts.purchaseOrderId,
    packageType: opts.packageType ?? "CUSTOM_PACKAGE",
    carrierName: opts.carrierName,
    carrierServiceType: opts.carrierServiceType,
    boxDimensions: boxDimensions(opts.box),
    boxItems: opts.boxItems,
  };
  const r = await client.request<any>("POST", "/shipping/labels", { body });
  // CommonResponseLabelGenerationResponse — payload location varies; probe.
  const d = r?.payload ?? r?.data ?? r;
  const label = Array.isArray(d) ? d[0] : d;
  return {
    purchaseOrderId: String(label?.purchaseOrderId ?? opts.purchaseOrderId),
    trackingNumber: String(label?.trackingNo ?? label?.trackingNumber ?? ""),
    carrierName: opts.carrierName,
    carrierServiceType: opts.carrierServiceType,
    boxItems: Array.isArray(label?.boxItems) ? label.boxItems : [],
    raw: r,
  };
}

/** List the carriers enabled for SWW on this account. */
export async function getSwwCarriers(
  client: WalmartClient,
): Promise<Array<{ carrierId: string; shortName: string; carrierName: string }>> {
  const r = await client.request<any>("GET", "/shipping/labels/carriers");
  const list: any[] = r?.carriers ?? r?.payload ?? [];
  return list.map((c) => ({
    carrierId: String(c?.carrierId ?? ""),
    shortName: String(c?.shortName ?? ""),
    carrierName: String(c?.carrierName ?? ""),
  }));
}

/**
 * Download the label PDF for a carrier + tracking number (returned by
 * buyShippingLabel). Returns the raw Response so the caller can stream the
 * bytes (e.g. up to Google Drive). carrierShortName is the SWW short name
 * ("FedEx", "USPS", "Walmart Shipping Services").
 */
export async function downloadLabelPdf(
  client: WalmartClient,
  carrierShortName: string,
  trackingNumber: string,
): Promise<Response> {
  return client.request<Response>(
    "GET",
    `/shipping/labels/carriers/${encodeURIComponent(carrierShortName)}/trackings/${encodeURIComponent(trackingNumber)}`,
    { accept: "application/json,application/pdf", raw: true },
  );
}
