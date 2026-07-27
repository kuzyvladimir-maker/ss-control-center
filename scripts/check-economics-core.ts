// Sanity checks for the Economics pure core (Phase 7.0). No DB needed.
// Run: npx tsx scripts/check-economics-core.ts
import { amazonReferralFee, walmartReferralFee } from "@/lib/economics/fee-tables";
import { computeProfit } from "@/lib/economics/compute-profit";
import { coolerForWeight, iceCost, packagingForSku } from "@/lib/economics/packaging";

let failures = 0;
function eq(label: string, got: number, want: number, tol = 0.005) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, want ${want}`);
}
function assert(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// --- Amazon grocery $15 threshold (8% ≤ $15, 15% above) ---
eq("amazon grocery $14.99 → 8%", amazonReferralFee("grocery_food", 14.99), 1.2);
eq("amazon grocery $15.01 → 15%", amazonReferralFee("grocery_food", 15.01), 2.25);
eq("amazon home_kitchen flat 15%", amazonReferralFee("home_kitchen", 100), 15);
eq("amazon other min fee $0.30", amazonReferralFee("other", 1), 0.3);

// --- Walmart grocery $10 threshold ---
eq("walmart grocery $9.99 → 8%", walmartReferralFee("grocery_food", 9.99), 0.8);
eq("walmart grocery $20 → 15%", walmartReferralFee("grocery_food", 20), 3);

// --- Packaging: weight→cooler + ice ---
assert("cooler ≤6lb = S", coolerForWeight(5) === "S");
assert("cooler 10lb = M", coolerForWeight(10) === "M");
assert("cooler 16lb = L", coolerForWeight(16) === "L");
assert("cooler 25lb = XL", coolerForWeight(25) === "XL");
eq("ice for 10lb = 0.8*10*0.10", iceCost(10), 0.8);

// Double-count guard: includesPackaging → 0
const guarded = packagingForSku({ weightLb: 10, includesPackaging: true, category: "Frozen" });
eq("includesPackaging → packaging 0", guarded.packaging, 0);

// Frozen 10lb → M shell($9) + ice($0.80) + box($1) = $10.80
const frozen = packagingForSku({ weightLb: 10, includesPackaging: false, category: "Frozen" });
eq("frozen 10lb packaging", frozen.packaging, 10.8);
assert("frozen 10lb cooler M", frozen.cooler === "M");

// Dry → plain box, no cooler
const dry = packagingForSku({ weightLb: 3, includesPackaging: false, category: "Dry" });
eq("dry packaging = box", dry.packaging, 1.5);
assert("dry cooler null", dry.cooler === null);

// --- Pack-qty: COGS must be perUnit × packSize (whole-listing), not per-unit ---
// perUnit $4, pack of 3 → COGS $12 against a $30 item.
const packed = computeProfit({
  sku: "PACK3",
  marketplace: "amazon",
  itemPrice: 30,
  shippingCharged: 0,
  cogs: 4 * 3,
  packaging: 0,
  ownShipping: 0,
  category: "grocery_food",
});
// referral on $30 grocery = 15% = $4.50; profit = 30 − 12 − 4.50 = 13.50
eq("pack-3 profit", packed.profit, 13.5);
eq("pack-3 referral", packed.referralFee, 4.5);
assert("pack-3 margin ~45%", Math.abs(packed.marginPct - 0.45) < 0.001);

// --- Full Jimmy Dean-style example (revenue = item+shipping) ---
// item $30 + ship $30 = $60 revenue; grocery >$15 → 15% = $9; COGS $22; label $32.
// NOTE: this uses our ESTIMATED 15% referral, which is deliberately more
// conservative than Sellerboard's ACTUAL fee — proves estimate≠actual on purpose.
const jd = computeProfit({
  sku: "JD12",
  marketplace: "amazon",
  itemPrice: 30,
  shippingCharged: 30,
  cogs: 22,
  packaging: 0, // Sellerboard frozen COGS already includes packaging
  ownShipping: 32,
  category: "grocery_food",
});
eq("jimmy dean revenue", jd.revenue, 60);
eq("jimmy dean referral (est 15%)", jd.referralFee, 9);
eq("jimmy dean profit", jd.profit, -3);
assert("jimmy dean flagged below_target_margin", jd.flags.includes("below_target_margin"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
