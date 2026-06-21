// Sanity checks for the accrual meter math (pure). No DB.
// Run: npx tsx scripts/check-finance-accrual.ts
import { dailyAccrualRate, daysBetween, weekdayDatesBetween, accrualAmount } from "@/lib/finance/accrual";

let failures = 0;
function eq(label: string, got: number, want: number, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
}

eq("daily rate monthly 110", dailyAccrualRate(110, "monthly"), 110 / 30.44);
eq("daily rate weekly 55", dailyAccrualRate(55, "weekly"), 55 / 7);
eq("daily rate daily 150", dailyAccrualRate(150, "daily"), 150);
eq("one_time rate 0", dailyAccrualRate(99, "one_time"), 0);

eq("daysBetween 7", daysBetween("2026-06-01", "2026-06-08"), 7);
eq("daysBetween same day 0", daysBetween("2026-06-08", "2026-06-08"), 0);

// 2026-06-01 is a Monday; weekdays strictly after 06-01 through 06-08 = Tue..Fri(2-5) + Mon(8) = 5.
eq("weekdays 06-01→06-08", weekdayDatesBetween("2026-06-01", "2026-06-08").length, 5);

// Salary $150/day, worked days passed explicitly (TimeLog). 5 worked → 750.
const worked5 = new Set(["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"]);
eq("salary accrual 5 worked days", accrualAmount({ amount: 150, frequency: "daily", category: "Salaries" }, "2026-06-01", "2026-06-08", worked5), 750);
// 4 worked days → 600. Worked day == from (06-01) excluded; after today excluded.
const worked4 = new Set(["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05", "2026-06-09"]);
eq("salary accrual range-bounded 3", accrualAmount({ amount: 150, frequency: "daily", category: "Salaries" }, "2026-06-01", "2026-06-08", worked4), 450);

// Internet $110/month over 7 calendar days = 7 × 110/30.44 = 25.30.
eq("internet 7d accrual", accrualAmount({ amount: 110, frequency: "monthly", category: "Warehouse & Logistics" }, "2026-06-01", "2026-06-08"), round2(7 * 110 / 30.44));

// No double-count: accrue 0→8 then 8→8 adds nothing extra.
const a1 = accrualAmount({ amount: 110, frequency: "monthly", category: "x" }, "2026-06-01", "2026-06-08");
const a2 = accrualAmount({ amount: 110, frequency: "monthly", category: "x" }, "2026-06-08", "2026-06-08");
eq("no double count second call 0", a2, 0);
eq("first call > 0", a1 > 0 ? 1 : 0, 1);

function round2(n: number) { return Math.round(n * 100) / 100; }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
