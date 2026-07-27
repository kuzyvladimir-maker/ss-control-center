/**
 * Amazon Settlement Reports — the authoritative source for per-order
 * adjustment attribution.
 *
 * Why this exists alongside finances.ts:
 *   * /finances/v0/financialEvents (Phase A) gives a real-time stream of
 *     AdjustmentEvent rows, but PostageBilling_* events carry no
 *     order-id / SellerSKU — the "carrier reweigh recharge" arrives
 *     anonymous.
 *   * Settlement Reports (this module, Phase B) bundle the same events
 *     with order-id and shipment-id populated. Cross-referencing the
 *     Order rows in the same TSV yields a SKU for almost every
 *     adjustment.
 *
 * Both sources produce the SAME externalId (see buildAdjustmentExternalId
 * in finances.ts), so settlement-sourced inserts UPSERT into the same
 * ShippingAdjustment rows that Phase A already created — enriching them
 * with order/SKU rather than duplicating.
 *
 * Report cadence: Amazon emits a settlement report every 1-2 weeks per
 * account. Both flavours are returned:
 *   GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2  ← TSV with header row
 *   GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE     ← TSV, slightly older format
 * We pick the V2 variant; the older one has the same data but predates
 * some columns like merchant-adjustment-item-id.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { spApiGet } from "./client";
import {
  getReportDocumentUrl,
  downloadReport,
} from "./reports";
import type { ParsedAdjustment } from "./finances";

export const SETTLEMENT_REPORT_TYPE =
  "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2";

export interface SettlementReportMeta {
  reportId: string;
  reportType: string;
  processingStatus: string;
  reportDocumentId: string;
  dataStartTime: string;
  dataEndTime: string;
}

/** List V2 settlement reports for a store, optionally filtered by date. */
export async function listSettlementReports(
  storeId: string,
  options: { createdSince?: string; createdUntil?: string } = {}
): Promise<SettlementReportMeta[]> {
  const params: Record<string, string> = {
    reportTypes: SETTLEMENT_REPORT_TYPE,
  };
  if (options.createdSince) params.createdSince = options.createdSince;
  if (options.createdUntil) params.createdUntil = options.createdUntil;

  const r = await spApiGet("/reports/2021-06-30/reports", { storeId, params });
  const reports = (r.reports ?? r.payload?.reports ?? []) as any[];
  return reports
    .filter((rep) => rep.processingStatus === "DONE" && rep.reportDocumentId)
    .map((rep) => ({
      reportId: rep.reportId,
      reportType: rep.reportType,
      processingStatus: rep.processingStatus,
      reportDocumentId: rep.reportDocumentId,
      dataStartTime: rep.dataStartTime,
      dataEndTime: rep.dataEndTime,
    }));
}

/**
 * Parsed TSV row. Field names are the kebab-case headers Amazon emits
 * exactly (we just camelize the common ones).
 */
export interface SettlementRow {
  transactionType: string;     // Order | Refund | other-transaction
  orderId: string;             // e.g. 114-1234567-1234567
  adjustmentId: string;
  shipmentId: string;
  amountType: string;          // ItemPrice | ItemFees | other-transaction | …
  amountDescription: string;   // Principal | Adjustment | Shipping label purchase | …
  amount: number;              // signed USD
  postedDate: string;          // YYYY-MM-DD
  postedDateTime: string;      // "YYYY-MM-DD HH:MM:SS UTC" → ISO via normalizeTime
  sku: string;
  quantityPurchased: string;
}

/** Map UTC settlement timestamp to the ISO 8601 Z form Phase A uses. */
function normalizeTime(ts: string): string {
  // "2026-05-27 11:35:23 UTC" → "2026-05-27T11:35:23Z"
  return ts.replace(" ", "T").replace(" UTC", "Z").trim();
}

/**
 * Parse the full settlement TSV. Returns:
 *   * `rows`: every line as a SettlementRow
 *   * `orderToSku`: order-id → first SKU seen, lifted from
 *     "Order|ItemPrice|Principal" rows — these have exactly one SKU per
 *     order line item, which is the linkage we use to attach a SKU to
 *     order-less adjustment rows (they share an order-id).
 *   * `orderToProductName`: best-effort name from the same rows when
 *     Amazon includes it (rare in the V2 TSV — usually blank, kept for
 *     future-proofing).
 */
export function parseSettlementTsv(tsv: string): {
  rows: SettlementRow[];
  orderToSku: Map<string, string>;
  orderToProductName: Map<string, string>;
} {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return {
      rows: [],
      orderToSku: new Map(),
      orderToProductName: new Map(),
    };
  }

  const headers = lines[0].split("\t");
  const idx = (name: string) => headers.indexOf(name);

  const colTx = idx("transaction-type");
  const colOrder = idx("order-id");
  const colAdjId = idx("adjustment-id");
  const colShipment = idx("shipment-id");
  const colAmtType = idx("amount-type");
  const colAmtDesc = idx("amount-description");
  const colAmount = idx("amount");
  const colPostedDate = idx("posted-date");
  const colPostedTime = idx("posted-date-time");
  const colSku = idx("sku");
  const colQty = idx("quantity-purchased");

  const rows: SettlementRow[] = [];
  const orderToSku = new Map<string, string>();
  const orderToProductName = new Map<string, string>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < headers.length) continue;

    const row: SettlementRow = {
      transactionType: cols[colTx] || "",
      orderId: cols[colOrder] || "",
      adjustmentId: cols[colAdjId] || "",
      shipmentId: cols[colShipment] || "",
      amountType: cols[colAmtType] || "",
      amountDescription: cols[colAmtDesc] || "",
      amount: parseFloat(cols[colAmount] || "0"),
      postedDate: cols[colPostedDate] || "",
      postedDateTime: cols[colPostedTime] || "",
      sku: cols[colSku] || "",
      quantityPurchased: cols[colQty] || "",
    };
    rows.push(row);

    // Build order→SKU index from the canonical Order rows. Principal +
    // Shipping rows both have it; Principal first wins (one per line item).
    if (row.orderId && row.sku) {
      if (
        !orderToSku.has(row.orderId) &&
        row.transactionType === "Order" &&
        (row.amountDescription === "Principal" ||
          row.amountDescription === "Shipping")
      ) {
        orderToSku.set(row.orderId, row.sku);
      }
    }
  }

  return { rows, orderToSku, orderToProductName };
}

/** Maps settlement-row amount-description → our adjustmentType enum. */
const SETTLEMENT_DESC_MAP: Record<
  string,
  { type: ParsedAdjustment["type"]; rawType: string } | null
> = {
  Adjustment: {
    type: "WeightAdjustment",
    rawType: "PostageBilling_PostageAdjustment",
  },
  ShippingServicesRefund: {
    type: "WeightAdjustmentRefund",
    rawType: "PostageRefund_PostageAdjustment",
  },
  // Original label charge — recorded as ReturnShipping bucket only when the
  // transaction is a Refund row; the bulk "Shipping label purchase"
  // entries are routine outgoing-label costs and aren't adjustments.
  // (We don't surface those as adjustments to avoid double-counting against
  // the carrier reweigh figures.)
};

/**
 * Extract the subset of settlement rows that represent shipping
 * adjustments + look up their SKU via the orderToSku map.
 */
export function extractAdjustmentRecords(
  parsed: {
    rows: SettlementRow[];
    orderToSku: Map<string, string>;
  },
  storeId: string
): Array<{
  /** Same shape Phase A produces — fed straight into the upsert. */
  externalId: string;
  channel: "Amazon";
  storeId: string;
  currency: string;
  orderId: string | null;
  amazonOrderId: string | null;
  adjustmentDate: string;
  adjustmentType: ParsedAdjustment["type"];
  rawType: string;
  adjustmentAmount: number;
  adjustmentReason: string;
  sku: string | null;
}> {
  const out: ReturnType<typeof extractAdjustmentRecords> = [];

  for (const row of parsed.rows) {
    const mapping = SETTLEMENT_DESC_MAP[row.amountDescription];
    if (!mapping) continue;

    const postedDateIso = normalizeTime(
      row.postedDateTime || `${row.postedDate} 00:00:00 UTC`
    );
    const sku = row.sku || parsed.orderToSku.get(row.orderId) || null;
    const orderId = row.orderId || null;

    // Externalid must match Phase A's formula for upsert-merge.
    const amountCents = Math.round(row.amount * 100);
    const externalId = `amazon:${storeId}:${mapping.rawType}:${postedDateIso}:${amountCents}`;

    out.push({
      externalId,
      channel: "Amazon",
      storeId,
      currency: "USD",
      orderId,
      amazonOrderId: orderId,
      adjustmentDate: row.postedDate || postedDateIso.slice(0, 10),
      adjustmentType: mapping.type,
      rawType: mapping.rawType,
      adjustmentAmount: row.amount,
      adjustmentReason: row.amountDescription,
      sku,
    });
  }

  return out;
}

/**
 * Convenience: list → download → parse → extract for one store.
 *
 * Two-pass over the report set so that an Adjustment row in settlement N
 * can pick up its SKU from an Order row in settlement N-1: the first pass
 * downloads every TSV and accumulates a cross-report orderToSku map; the
 * second pass extracts adjustments against the merged map.
 *
 * Without this, only ~15% of adjustments get a SKU (the carrier
 * recharge often arrives in the settlement period AFTER the original
 * shipment was settled).
 */
export async function fetchSettlementAdjustments(
  storeId: string,
  daysBack = 60
): Promise<{
  reports: SettlementReportMeta[];
  adjustments: ReturnType<typeof extractAdjustmentRecords>;
}> {
  const reports = await listSettlementReports(storeId, {
    createdSince: new Date(Date.now() - daysBack * 86400_000).toISOString(),
  });

  // Dedup by reportDocumentId — Amazon sometimes lists the same period
  // twice (once per V1/V2 flavour) but we already filtered to V2.
  const seen = new Set<string>();
  const unique = reports.filter((r) => {
    if (seen.has(r.reportDocumentId)) return false;
    seen.add(r.reportDocumentId);
    return true;
  });

  // Pass 1: download every TSV once, parse, merge orderToSku maps.
  const parsedReports: Array<ReturnType<typeof parseSettlementTsv>> = [];
  const mergedOrderToSku = new Map<string, string>();

  for (const rep of unique) {
    try {
      const url = await getReportDocumentUrl(storeId, rep.reportDocumentId);
      const tsv = await downloadReport(url);
      const parsed = parseSettlementTsv(tsv);
      parsedReports.push(parsed);
      for (const [order, sku] of parsed.orderToSku) {
        if (!mergedOrderToSku.has(order)) mergedOrderToSku.set(order, sku);
      }
    } catch (e) {
      console.warn(
        `[settlement-reports] ${storeId} ${rep.reportDocumentId}: ${
          e instanceof Error ? e.message : e
        }`
      );
      parsedReports.push({
        rows: [],
        orderToSku: new Map(),
        orderToProductName: new Map(),
      });
    }
  }

  // Pass 2: extract adjustments, swapping in the merged map so adjustments
  // for orders shipped in an earlier period still get a SKU.
  const all: ReturnType<typeof extractAdjustmentRecords> = [];
  for (const parsed of parsedReports) {
    const merged = {
      rows: parsed.rows,
      orderToSku: mergedOrderToSku,
    };
    all.push(...extractAdjustmentRecords(merged, storeId));
  }

  return { reports: unique, adjustments: all };
}
