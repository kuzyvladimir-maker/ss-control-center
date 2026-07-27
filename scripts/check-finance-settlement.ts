// Sanity checks for settlement decomposition (buckets + Amazon TSV parser).
// Run: npx tsx scripts/check-finance-settlement.ts
import { bucketAmazonRow, bucketWalmartRow, parseAmazonSettlement } from "@/lib/finance/settlement";

let failures = 0;
function is(label: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
}
function eq(label: string, got: number, want: number, tol = 0.005) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
}

// Amazon row categorization
is("Order ItemPrice Principal", bucketAmazonRow("Order", "ItemPrice", "Principal"), "sales");
is("Order ItemPrice Shipping", bucketAmazonRow("Order", "ItemPrice", "Shipping"), "shipping_income");
is("Order ItemPrice Tax", bucketAmazonRow("Order", "ItemPrice", "Tax"), "tax_collected");
is("Refund ItemPrice Principal", bucketAmazonRow("Refund", "ItemPrice", "Principal"), "refunds");
is("Order ItemFees Commission", bucketAmazonRow("Order", "ItemFees", "Commission"), "referral_fee");
is("Order ItemFees FBAPerUnit", bucketAmazonRow("Order", "ItemFees", "FBAPerUnitFulfillmentFee"), "fba_fee");
is("ItemFees ShippingChargeback", bucketAmazonRow("Order", "ItemFees", "ShippingChargeback"), "adjustment");
is("Cost of Advertising", bucketAmazonRow("", "Cost of Advertising", "TransactionTotalAmount"), "ads");
is("Promotion Principal", bucketAmazonRow("Order", "Promotion", "Principal"), "promo");
is("other Storage Fee", bucketAmazonRow("", "other-transaction", "Storage Fee"), "storage_fee");
is("other Shipping label purchase", bucketAmazonRow("", "other-transaction", "Shipping label purchase"), "shipping_cost");
is("other current-reserve", bucketAmazonRow("", "other-transaction", "current-reserve-amount"), "reserve");
is("other Subscription", bucketAmazonRow("", "other-transaction", "Subscription"), "fee_other");
is("other SAFE-T", bucketAmazonRow("", "other-transaction", "SAFE-T reimbursement"), "adjustment");
is("MarketplaceFacilitatorTax", bucketAmazonRow("Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal"), "tax_collected");

// Walmart row categorization
is("WMT Sales", bucketWalmartRow("Sales"), "sales");
is("WMT Refunds", bucketWalmartRow("Refunds"), "refunds");
is("WMT Fees referral", bucketWalmartRow("Fees", "Referral Fee"), "referral_fee");
is("WMT Fees ads", bucketWalmartRow("Fees", "Sponsored Products"), "ads");
is("WMT Adjustments", bucketWalmartRow("Adjustments"), "adjustment");

// Amazon TSV parser
const H = ["settlement-id","settlement-start-date","settlement-end-date","deposit-date","total-amount","currency","transaction-type","amount-type","amount-description","amount"];
const row = (o: Record<string, string>) => H.map((h) => o[h] ?? "").join("\t");
const tsv = [
  H.join("\t"),
  row({ "settlement-id": "S1", "settlement-start-date": "2026-06-01", "settlement-end-date": "2026-06-14", "deposit-date": "2026-06-15", "total-amount": "31.00", currency: "USD" }), // summary
  row({ "settlement-id": "S1", "transaction-type": "Order", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "60" }),
  row({ "settlement-id": "S1", "transaction-type": "Order", "amount-type": "ItemPrice", "amount-description": "Shipping", amount: "30" }),
  row({ "settlement-id": "S1", "transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "Commission", amount: "-9" }),
  row({ "settlement-id": "S1", "transaction-type": "", "amount-type": "other-transaction", "amount-description": "Shipping label purchase", amount: "-32" }),
  row({ "settlement-id": "S1", "transaction-type": "Refund", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "-10" }),
  row({ "settlement-id": "S1", "transaction-type": "", "amount-type": "other-transaction", "amount-description": "current-reserve-amount", amount: "-5" }),
  row({ "settlement-id": "S1", "transaction-type": "", "amount-type": "Cost of Advertising", "amount-description": "TransactionTotalAmount", amount: "-3" }),
].join("\n");

const parsed = parseAmazonSettlement(tsv);
eq("parsed settlement count", parsed.length, 1);
const s = parsed[0];
is("settlementId", s.settlementId, "S1");
is("periodEnd", s.periodEnd ?? "", "2026-06-14");
eq("headerTotal", s.headerTotal ?? 0, 31);
eq("rowSumNet", s.rowSumNet, 31);
eq("netAmount", s.netAmount, 31);
const byBucket = Object.fromEntries(s.lines.map((l) => [l.bucket, l.amount]));
eq("sales", byBucket["sales"], 60);
eq("shipping_income", byBucket["shipping_income"], 30);
eq("referral_fee", byBucket["referral_fee"], -9);
eq("shipping_cost", byBucket["shipping_cost"], -32);
eq("refunds", byBucket["refunds"], -10);
eq("reserve", byBucket["reserve"], -5);
eq("ads", byBucket["ads"], -3);
eq("lines sum == net", s.lines.reduce((a, l) => a + l.amount, 0), 31);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
