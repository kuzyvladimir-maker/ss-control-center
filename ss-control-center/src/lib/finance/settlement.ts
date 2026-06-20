// Settlement decomposition — turns a marketplace settlement/recon into P&L
// buckets ("разложить на молекулы") for the Financial Plan report.
//
// Buckets are the function of (amount-type + amount-description + transaction-type)
// for Amazon, and (transactionType + feeType/description) for Walmart. Taxonomy
// from the fp-report-research workflow (2026-06-20). See docs/wiki/finance-funds.md.

export type Bucket =
  | "sales"
  | "shipping_income"
  | "tax_collected"
  | "refunds"
  | "referral_fee"
  | "fba_fee"
  | "storage_fee"
  | "shipping_cost"
  | "fee_other"
  | "ads"
  | "promo"
  | "adjustment"
  | "reserve"
  | "other";

export type BucketNature = "income" | "cost" | "wash" | "timing" | "mixed";

export const BUCKET_META: Record<Bucket, { label: string; nature: BucketNature }> = {
  sales: { label: "Product sales", nature: "income" },
  shipping_income: { label: "Shipping collected", nature: "income" },
  tax_collected: { label: "Tax (collected/remitted)", nature: "wash" },
  refunds: { label: "Refunds", nature: "cost" },
  referral_fee: { label: "Referral / commission", nature: "cost" },
  fba_fee: { label: "FBA / fulfillment fees", nature: "cost" },
  storage_fee: { label: "Storage fees", nature: "cost" },
  shipping_cost: { label: "Shipping / label cost", nature: "cost" },
  fee_other: { label: "Other marketplace fees", nature: "cost" },
  ads: { label: "Advertising", nature: "cost" },
  promo: { label: "Promotions / discounts", nature: "cost" },
  adjustment: { label: "Adjustments / claims", nature: "mixed" },
  reserve: { label: "Reserve (held/released)", nature: "timing" },
  other: { label: "Other", nature: "mixed" },
};

export const BUCKET_ORDER: Bucket[] = [
  "sales", "shipping_income", "refunds", "referral_fee", "fba_fee",
  "storage_fee", "shipping_cost", "ads", "promo", "fee_other", "adjustment",
  "tax_collected", "reserve", "other",
];

const has = (s: string, ...needles: string[]) => {
  const t = s.toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
};

/** Amazon V2 settlement row → bucket. Order matters; first match wins. */
export function bucketAmazonRow(
  transactionType: string,
  amountType: string,
  amountDescription: string,
): Bucket {
  const tt = (transactionType || "").toLowerCase();
  const at = (amountType || "").toLowerCase();
  const desc = amountDescription || "";

  // Advertising is its own amount-type.
  if (at.includes("advertising")) return "ads";
  // Promotional rebates are their own amount-type (collides w/ ItemPrice descs).
  if (at === "promotion") return "promo";
  // Marketplace-facilitator withheld tax (wash).
  if (at === "itemwithheldtax" || has(desc, "marketplacefacilitator")) return "tax_collected";

  if (at === "itemprice") {
    if (tt === "refund") return "refunds";
    if (has(desc, "tax")) return "tax_collected"; // Tax/ShippingTax/GiftWrapTax
    if (has(desc, "shipping")) return "shipping_income";
    if (has(desc, "giftwrap")) return "shipping_income";
    return "sales"; // Principal / GoodwillPrincipal
  }

  if (at === "itemfees") {
    if (has(desc, "chargeback")) return "adjustment"; // Shipping/GiftwrapChargeback
    if (has(desc, "fba")) return "fba_fee";
    if (has(desc, "commission", "referralfee", "referral", "closingfee")) return "referral_fee";
    return "fee_other";
  }

  // other-transaction (and anything else)
  if (has(desc, "reserve")) return "reserve"; // current/previous reserve
  if (has(desc, "shipping label", "label purchase", "carrier shipping", "postage", "mfnpostage"))
    return "shipping_cost"; // Buy Shipping label cost (Amazon "Shipping charges")
  if (has(desc, "storage", "aged inventory")) return "storage_fee";
  if (has(desc, "reimbursement", "safe-t", "safet", "a-to-z", "atoz", "guarantee",
    "chargeback", "goodwill", "reversal", "adjustment", "balanceadjustment", "failed disbursement"))
    return "adjustment";
  if (has(desc, "subscription", "shipping label", "label purchase", "removal", "disposal",
    "liquidation", "coupon", "deal fee", "lightning", "service fee", "processing fee",
    "inbound transportation"))
    return "fee_other";
  return "other";
}

/** Walmart recon row → bucket. */
export function bucketWalmartRow(
  transactionType: string,
  feeType?: string | null,
  description?: string | null,
): Bucket {
  const tt = (transactionType || "").toLowerCase();
  const ft = `${feeType ?? ""} ${description ?? ""}`;
  if (tt.includes("sale")) return "sales";
  if (tt.includes("refund")) return "refunds";
  if (tt.includes("adjust")) return "adjustment";
  if (tt.includes("fee")) {
    if (has(ft, "sponsor", "advert", " ad ", "ads", "promotion")) return "ads";
    if (has(ft, "ship", "postage", "carrier", "label")) return "shipping_income"; // shipping fee = cost; we net via sign
    if (has(ft, "referral", "commission", "marketplace")) return "referral_fee";
    return "fee_other";
  }
  return "other";
}

// ─── Amazon settlement TSV parser (payout + bucketed breakdown) ─────────────

export interface SettlementLine {
  bucket: Bucket;
  amount: number; // signed, summed
  count: number;
}
export interface ParsedSettlement {
  settlementId: string;
  periodStart: string | null;
  periodEnd: string | null;
  depositDate: string | null;
  currency: string;
  /** Header total-amount = actual bank deposit (preferred net). */
  headerTotal: number | null;
  /** Sum of all detail rows incl reserve (cross-check ≈ headerTotal). */
  rowSumNet: number;
  /** Cash we distribute = headerTotal ?? rowSumNet. */
  netAmount: number;
  lines: SettlementLine[];
}

/**
 * Parse a V2 settlement flat-file TSV into one-or-more settlements (grouped by
 * settlement-id), each with a bucketed breakdown and the net deposit.
 */
export function parseAmazonSettlement(tsv: string): ParsedSettlement[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  const idx = (name: string) => headers.indexOf(name);

  const cSettleId = idx("settlement-id");
  const cStart = idx("settlement-start-date");
  const cEnd = idx("settlement-end-date");
  const cDeposit = idx("deposit-date");
  const cTotal = idx("total-amount");
  const cCurrency = idx("currency");
  const cTxType = idx("transaction-type");
  const cAmtType = idx("amount-type");
  const cAmtDesc = idx("amount-description");
  const cAmount = idx("amount");

  // Amazon emits settlement dates in mixed formats (ISO "2026-06-15 ...",
  // "DD.MM.YYYY ...", or "MM/DD/YYYY ...") depending on locale — normalize to ISO.
  const dateOnly = (s: string | undefined): string | null => {
    if (!s) return null;
    const t = s.trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})/); // DD.MM.YYYY
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return t.slice(0, 10);
  };

  // Group rows by settlement-id.
  const groups = new Map<string, ParsedSettlement & { _buckets: Map<Bucket, SettlementLine> }>();
  const ensure = (sid: string) => {
    let g = groups.get(sid);
    if (!g) {
      g = {
        settlementId: sid,
        periodStart: null, periodEnd: null, depositDate: null,
        currency: "USD", headerTotal: null, rowSumNet: 0, netAmount: 0,
        lines: [], _buckets: new Map(),
      };
      groups.set(sid, g);
    }
    return g;
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const sid = cSettleId >= 0 ? cols[cSettleId] || "" : "";
    if (!sid) continue;
    const g = ensure(sid);

    if (cStart >= 0 && cols[cStart]) g.periodStart = dateOnly(cols[cStart]);
    if (cEnd >= 0 && cols[cEnd]) g.periodEnd = dateOnly(cols[cEnd]);
    if (cDeposit >= 0 && cols[cDeposit]) g.depositDate = dateOnly(cols[cDeposit]);
    if (cCurrency >= 0 && cols[cCurrency]) g.currency = cols[cCurrency];

    const amtType = cAmtType >= 0 ? cols[cAmtType] || "" : "";
    const amtDesc = cAmtDesc >= 0 ? cols[cAmtDesc] || "" : "";
    const amount = cAmount >= 0 ? parseFloat(cols[cAmount] || "0") : 0;

    // Summary/header row: amount-type & amount-description blank, total-amount set.
    if (!amtType && !amtDesc) {
      if (cTotal >= 0 && cols[cTotal]) g.headerTotal = parseFloat(cols[cTotal]) || g.headerTotal;
      continue; // never bucket the summary row
    }

    if (!Number.isFinite(amount) || amount === 0) continue;
    g.rowSumNet += amount;
    const bucket = bucketAmazonRow(cTxType >= 0 ? cols[cTxType] : "", amtType, amtDesc);
    const line = g._buckets.get(bucket) ?? { bucket, amount: 0, count: 0 };
    line.amount += amount;
    line.count += 1;
    g._buckets.set(bucket, line);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return [...groups.values()].map((g) => {
    const lines: SettlementLine[] = [...g._buckets.values()].map((l) => ({
      bucket: l.bucket, amount: round2(l.amount), count: l.count,
    }));
    const rowSumNet = round2(g.rowSumNet);
    const netAmount = g.headerTotal != null ? round2(g.headerTotal) : rowSumNet;
    return {
      settlementId: g.settlementId,
      periodStart: g.periodStart, periodEnd: g.periodEnd, depositDate: g.depositDate,
      currency: g.currency, headerTotal: g.headerTotal != null ? round2(g.headerTotal) : null,
      rowSumNet, netAmount, lines,
    };
  });
}
