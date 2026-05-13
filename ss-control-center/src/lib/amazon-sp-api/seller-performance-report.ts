/**
 * Amazon SP-API — Seller Performance Report (GET_V2_SELLER_PERFORMANCE_REPORT).
 *
 * Async flow:
 *   1. requestReport(storeIndex)          → reportId
 *   2. getReportStatus(storeIndex, id)    → { status, reportDocumentId? }
 *      Poll until status = DONE (typical: 30s..5min).
 *   3. downloadReportDocument(idx, docId) → raw JSON string
 *   4. parseSellerPerformanceReport(json) → flat metrics + policy categories
 *
 * Why this path: the report is the only public SP-API surface that returns
 * the *official* numbers Amazon shows on Seller Central → Account Health.
 * Computing them ourselves from orders never matches (FBA filtering,
 * proprietary algorithms, internal feedback events we don't see).
 *
 * Requires the basic "Inventory and Order Tracking" role — already granted.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { spApiGet, spApiPost, MARKETPLACE_ID } from "./client";

export type ReportProcessingStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "DONE"
  | "CANCELLED"
  | "FATAL";

export interface ReportStatus {
  reportId: string;
  status: ReportProcessingStatus;
  reportDocumentId?: string;
  processingEndTime?: string;
}

/**
 * Kick off a fresh Seller Performance report for the given store.
 * Returns the reportId you'll poll with getReportStatus.
 */
export async function requestReport(storeIndex: number): Promise<string> {
  const storeId = `store${storeIndex}`;
  const resp = await spApiPost(
    "/reports/2021-06-30/reports",
    {
      reportType: "GET_V2_SELLER_PERFORMANCE_REPORT",
      marketplaceIds: [MARKETPLACE_ID],
    },
    { storeId }
  );
  if (!resp?.reportId) {
    throw new Error(
      `requestReport: missing reportId in response (${JSON.stringify(
        resp
      ).slice(0, 200)})`
    );
  }
  return resp.reportId as string;
}

export async function getReportStatus(
  storeIndex: number,
  reportId: string
): Promise<ReportStatus> {
  const storeId = `store${storeIndex}`;
  const resp = await spApiGet(`/reports/2021-06-30/reports/${reportId}`, {
    storeId,
  });
  return {
    reportId,
    status: resp.processingStatus as ReportProcessingStatus,
    reportDocumentId: resp.reportDocumentId as string | undefined,
    processingEndTime: resp.processingEndTime as string | undefined,
  };
}

/**
 * Fetch the document descriptor + download its body. Handles GZIP compression
 * when Amazon flags it (otherwise returns raw text).
 */
export async function downloadReportDocument(
  storeIndex: number,
  reportDocumentId: string
): Promise<string> {
  const storeId = `store${storeIndex}`;
  const doc = await spApiGet(
    `/reports/2021-06-30/documents/${reportDocumentId}`,
    { storeId }
  );
  if (!doc?.url) {
    throw new Error("downloadReportDocument: no url in document response");
  }

  const resp = await fetch(doc.url);
  if (!resp.ok) {
    throw new Error(
      `downloadReportDocument: HTTP ${resp.status} when fetching presigned URL`
    );
  }

  if (doc.compressionAlgorithm === "GZIP") {
    const buf = Buffer.from(await resp.arrayBuffer());
    const zlib = await import("zlib");
    return zlib.gunzipSync(buf).toString("utf-8");
  }
  return await resp.text();
}

// ──────────────────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────────────────

export interface ParsedReport {
  accountHealthRating: number | null;
  accountHealthRatingStatus:
    | "AT_RISK_OF_DEACTIVATION"
    | "AT_RISK"
    | "GOOD"
    | null;

  // Customer service (60d), seller-fulfilled vs FBA where available
  orderDefectRate: number | null;
  odrOrders60d: number | null;
  negativeFeedbackRate: number | null;
  negativeFeedbackCount: number | null;
  atozClaimsRate: number | null;
  atozClaimsCount: number | null;
  chargebackRate: number | null;
  chargebackCount: number | null;

  odrSellerFulfilled: number | null;
  odrSellerFulfilledOrders: number | null;
  odrFulfilledByAmazon: number | null;
  odrFulfilledByAmazonOrders: number | null;
  negativeFeedbackSF: number | null;
  negativeFeedbackFBA: number | null;
  atozClaimsRateSF: number | null;
  atozClaimsRateFBA: number | null;
  chargebackRateSF: number | null;
  chargebackRateFBA: number | null;

  // Shipping performance
  lateShipmentRate10d: number | null;
  lsr10dLate: number | null;
  lsr10dTotal: number | null;
  lateShipmentRate30d: number | null;
  lsr30dLate: number | null;
  lsr30dTotal: number | null;

  preFulfillmentCancelRate: number | null;
  cancelCancelled: number | null;
  cancelTotal: number | null;

  validTrackingRate: number | null;
  vtrTracked: number | null;
  vtrTotal: number | null;

  onTimeDeliveryRate: number | null;
  otdrOnTime: number | null;
  otdrTotal: number | null;

  // Policy compliance (10 fixed categories)
  policyCategories: Array<{
    code: string;
    displayName: string;
    count: number;
    status: "OK" | "WARNING" | "CRITICAL";
    issues: Array<{
      asin?: string;
      sku?: string;
      listingTitle?: string;
      violationType: string;
      severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      message: string;
      reportedAt: string;
      amazonReferenceId?: string;
    }>;
  }>;
}

/**
 * Parser for the real Amazon V2 report shape. Confirmed against a live pull
 * from store 1 on 2026-05-12 — see scripts/probe-seller-performance-report.ts
 * for how to re-sample if the shape ever changes.
 *
 * Top-level path: `performanceMetrics[0]`. Every metric ships with
 * `{ rate, orderCount, ...countField }` + `{ status, targetValue }` where
 * the status enum is `GOOD | WARNED | BAD | NONE`.
 */
export function parseSellerPerformanceReport(raw: string): ParsedReport {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("parseSellerPerformanceReport: body is not valid JSON");
  }

  const pm = json?.performanceMetrics?.[0] ?? {};

  const out: ParsedReport = blankReport();

  // ── Account Health Rating ──────────────────────────────────────────────
  const ahr = pm.accountHealthRating ?? {};
  out.accountHealthRating = pickNumber(ahr.ahrScore);
  // ahrStatus in the report: GOOD | WARNED | AT_RISK | AT_RISK_OF_DEACTIVATION
  // (Amazon spelling varies). Normalise to our 3 zones.
  const ahrRaw = String(ahr.ahrStatus ?? "").toUpperCase();
  out.accountHealthRatingStatus =
    ahrRaw === "AT_RISK_OF_DEACTIVATION"
      ? "AT_RISK_OF_DEACTIVATION"
      : ahrRaw === "WARNED" || ahrRaw === "AT_RISK"
        ? "AT_RISK"
        : ahrRaw === "GOOD"
          ? "GOOD"
          : out.accountHealthRating != null
            ? deriveZone(out.accountHealthRating)
            : null;

  // ── Order Defect Rate (60-day) — split into MFN / AFN ──────────────────
  const odrAfn = pm.orderDefectRate?.afn ?? {};
  const odrMfn = pm.orderDefectRate?.mfn ?? {};
  const mfnRate = pickNumber(odrMfn.rate);
  const afnRate = pickNumber(odrAfn.rate);
  const mfnOrders = pickNumber(odrMfn.orderCount) ?? 0;
  const afnOrders = pickNumber(odrAfn.orderCount) ?? 0;
  out.odrSellerFulfilled = ratioToPct(mfnRate);
  out.odrSellerFulfilledOrders = mfnOrders;
  out.odrFulfilledByAmazon = ratioToPct(afnRate);
  out.odrFulfilledByAmazonOrders = afnOrders;
  // Amazon's headline ODR on the dashboard is per-fulfilment; we surface MFN
  // as the primary value (matches "Order Defect Rate" line on the page) and
  // total orders across both channels for context.
  out.orderDefectRate = ratioToPct(mfnRate);
  out.odrOrders60d = mfnOrders + afnOrders;

  // Per-defect-type breakdown (counts only — Amazon doesn't surface SF/AFN
  // rates for each sub-defect, only counts).
  out.negativeFeedbackCount = pickNumber(odrMfn.negativeFeedback?.count);
  out.negativeFeedbackRate = ratioToPct(
    pickNumber(odrMfn.negativeFeedback?.rate)
  );
  out.atozClaimsCount = pickNumber(odrMfn.claims?.count);
  out.atozClaimsRate = ratioToPct(pickNumber(odrMfn.claims?.rate));
  out.chargebackCount = pickNumber(odrMfn.chargebacks?.count);
  out.chargebackRate = ratioToPct(pickNumber(odrMfn.chargebacks?.rate));

  // ── Late Shipment Rate — 10d (shortest list entry) + 30d (top-level) ───
  const ls30 = pm.lateShipmentRate ?? {};
  out.lateShipmentRate30d = ratioToPct(pickNumber(ls30.rate));
  out.lsr30dLate = pickNumber(ls30.lateShipmentCount);
  out.lsr30dTotal = pickNumber(ls30.orderCount);

  const lsList: any[] = Array.isArray(pm.lateShipmentRateList)
    ? pm.lateShipmentRateList
    : [];
  const ls10 = pickShortestWindow(lsList) ?? {};
  out.lateShipmentRate10d = ratioToPct(pickNumber(ls10.rate));
  out.lsr10dLate = pickNumber(ls10.lateShipmentCount);
  out.lsr10dTotal = pickNumber(ls10.orderCount);

  // ── Pre-fulfilment Cancel Rate (7-day) ─────────────────────────────────
  const cancel = pm.preFulfillmentCancellationRate ?? {};
  out.preFulfillmentCancelRate = ratioToPct(pickNumber(cancel.rate));
  out.cancelCancelled = pickNumber(cancel.cancellationCount);
  out.cancelTotal = pickNumber(cancel.orderCount);

  // ── Valid Tracking Rate (30-day) ───────────────────────────────────────
  const vtr = pm.validTrackingRate ?? {};
  out.validTrackingRate = ratioToPct(pickNumber(vtr.rate));
  out.vtrTracked = pickNumber(vtr.validTrackingCount);
  out.vtrTotal = pickNumber(vtr.shipmentCount);

  // ── On-Time Delivery Rate — units variant, matches the dashboard ───────
  // pm.onTimeDeliveryRate is the orders-level metric (~99% typical);
  // the page shows pm.unitOnTimeDeliveryRate (units) which is the stricter
  // 90%+ requirement we want to alert on.
  const otdr = pm.unitOnTimeDeliveryRate ?? pm.onTimeDeliveryRate ?? {};
  out.onTimeDeliveryRate = ratioToPct(pickNumber(otdr.rate));
  out.otdrOnTime = pickNumber(
    otdr.unitOnTimeDeliveryCount ?? otdr.onTimeDeliveryCount
  );
  out.otdrTotal = pickNumber(
    otdr.totalUnitCount ?? otdr.shipmentCountWithValidTracking
  );

  // ── Policy Compliance — 10 named fields with `defectsCount` ────────────
  out.policyCategories = POLICY_FIELD_MAP.map((m) => {
    const node = pm[m.field] ?? {};
    const count = pickNumber(node.defectsCount) ?? 0;
    // Amazon emits status: GOOD | BAD | NONE. Map BAD → CRITICAL because
    // hitting any of these on Amazon's policy categories really is critical
    // (deactivation risk).
    const rawStatus = String(node.status ?? "").toUpperCase();
    const status: "OK" | "WARNING" | "CRITICAL" =
      rawStatus === "BAD"
        ? "CRITICAL"
        : rawStatus === "WARNED"
          ? "WARNING"
          : count > 0
            ? "WARNING"
            : "OK";
    return {
      code: m.code,
      displayName: m.displayName,
      count,
      status,
      // The V2 report only gives aggregate counts — per-listing detail
      // requires the Listings Issues API, which we don't call here yet.
      issues: [],
    };
  });

  return out;
}

function blankReport(): ParsedReport {
  return {
    accountHealthRating: null,
    accountHealthRatingStatus: null,
    orderDefectRate: null,
    odrOrders60d: null,
    negativeFeedbackRate: null,
    negativeFeedbackCount: null,
    atozClaimsRate: null,
    atozClaimsCount: null,
    chargebackRate: null,
    chargebackCount: null,
    odrSellerFulfilled: null,
    odrSellerFulfilledOrders: null,
    odrFulfilledByAmazon: null,
    odrFulfilledByAmazonOrders: null,
    negativeFeedbackSF: null,
    negativeFeedbackFBA: null,
    atozClaimsRateSF: null,
    atozClaimsRateFBA: null,
    chargebackRateSF: null,
    chargebackRateFBA: null,
    lateShipmentRate10d: null,
    lsr10dLate: null,
    lsr10dTotal: null,
    lateShipmentRate30d: null,
    lsr30dLate: null,
    lsr30dTotal: null,
    preFulfillmentCancelRate: null,
    cancelCancelled: null,
    cancelTotal: null,
    validTrackingRate: null,
    vtrTracked: null,
    vtrTotal: null,
    onTimeDeliveryRate: null,
    otdrOnTime: null,
    otdrTotal: null,
    policyCategories: [],
  };
}

function ratioToPct(r: number | null): number | null {
  if (r == null) return null;
  // Round to 2 decimal places so we don't store hundred-digit float artifacts.
  return Math.round(r * 10000) / 100;
}

/**
 * Of the entries in lateShipmentRateList, pick the one with the shortest
 * date range (that's the 10-day window). The list usually has 2 entries:
 * 10-day and 30-day.
 */
function pickShortestWindow(list: any[]): any | null {
  if (!list.length) return null;
  let best: any = null;
  let bestSpan = Infinity;
  for (const item of list) {
    const from = item?.reportingDateRange?.reportingDateFrom;
    const to = item?.reportingDateRange?.reportingDateTo;
    if (!from || !to) continue;
    const span =
      new Date(to).getTime() - new Date(from).getTime();
    if (span < bestSpan) {
      bestSpan = span;
      best = item;
    }
  }
  return best;
}

interface PolicyFieldMap {
  field: string;        // path under pm
  code: string;         // our canonical category
  displayName: string;
}

// Maps Amazon's report field names → our PolicyViolationCategory codes.
const POLICY_FIELD_MAP: PolicyFieldMap[] = [
  { field: "suspectedIntellectualPropertyViolations", code: "SUSPECTED_IP",            displayName: "Suspected Intellectual Property Violations" },
  { field: "receivedIntellectualPropertyComplaints",  code: "RECEIVED_IP_COMPLAINTS",  displayName: "Received Intellectual Property Complaints" },
  { field: "productAuthenticityCustomerComplaints",   code: "PRODUCT_AUTHENTICITY",    displayName: "Product Authenticity Customer Complaints" },
  { field: "productConditionCustomerComplaints",      code: "PRODUCT_CONDITION",       displayName: "Product Condition Customer Complaints" },
  { field: "foodAndProductSafetyIssues",              code: "FOOD_SAFETY",             displayName: "Food and Product Safety Issues" },
  { field: "listingPolicyViolations",                 code: "LISTING_POLICY",          displayName: "Listing Policy Violations" },
  { field: "restrictedProductPolicyViolations",       code: "RESTRICTED_PRODUCT",      displayName: "Restricted Product Policy Violations" },
  { field: "customerProductReviewsPolicyViolations",  code: "CUSTOMER_REVIEWS_POLICY", displayName: "Customer Product Reviews Policies" },
  { field: "otherPolicyViolations",                   code: "OTHER_POLICY",            displayName: "Other Policy Violations" },
  { field: "documentRequests",                        code: "REGULATORY_COMPLIANCE",   displayName: "Regulatory Compliance" },
];

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function pickNumber(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function deriveZone(
  ahr: number
): "AT_RISK_OF_DEACTIVATION" | "AT_RISK" | "GOOD" {
  if (ahr < 200) return "AT_RISK_OF_DEACTIVATION";
  if (ahr < 400) return "AT_RISK";
  return "GOOD";
}
