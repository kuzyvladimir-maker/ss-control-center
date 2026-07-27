// Sanity checks for the accrual meter math (pure). No DB.
// Run: npx tsx scripts/check-finance-accrual.ts
import { dailyOwedRate, daysBetween, daysBefore, accrualAmount } from "@/lib/finance/accrual";
import { monthlyAmount, installmentMonthly } from "@/lib/finance/expenses";

let failures = 0;
function eq(label: string, got: number, want: number, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
}
function round2(n: number) { return Math.round(n * 100) / 100; }

// Smooth daily owed rate = monthly cost ÷ 30.44 (same basis for every frequency).
eq("owed rate monthly 110", dailyOwedRate(110, "monthly"), 110 / 30.44);
eq("owed rate weekly 55", dailyOwedRate(55, "weekly"), monthlyAmount(55, "weekly") / 30.44);
eq("owed rate daily 150 (salary)", dailyOwedRate(150, "daily"), monthlyAmount(150, "daily") / 30.44);
eq("owed rate yearly 120", dailyOwedRate(120, "yearly"), (120 / 12) / 30.44);

eq("daysBetween 7", daysBetween("2026-06-01", "2026-06-08"), 7);
eq("daysBetween same day 0", daysBetween("2026-06-08", "2026-06-08"), 0);
eq("daysBefore 7 of 06-08", daysBefore("2026-06-08", 7) === "2026-06-01" ? 1 : 0, 1);

// Smooth accrual: monthly cost × days/30.44.
eq("internet $110/mo over 7d", accrualAmount(110, "2026-06-01", "2026-06-08"), round2(7 * 110 / 30.44));
eq("salary $150/day → monthly smooth over 7d", accrualAmount(monthlyAmount(150, "daily"), "2026-06-01", "2026-06-08"), round2(7 * monthlyAmount(150, "daily") / 30.44));

// No double-count: second call from cursor==today adds nothing.
eq("no double count (today→today)", accrualAmount(110, "2026-06-08", "2026-06-08"), 0);
eq("first call > 0", accrualAmount(110, "2026-06-01", "2026-06-08") > 0 ? 1 : 0, 1);

// Installment averaged monthly drives its owed accrual.
eq("biweekly $500 ≈ $1083/mo", installmentMonthly(500, "biweekly"), round2(500 * 26 / 12));
eq("installment $1000/mo owed over 7d", accrualAmount(installmentMonthly(1000, "monthly"), "2026-06-01", "2026-06-08"), round2(7 * 1000 / 30.44));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
