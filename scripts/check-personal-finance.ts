// Pure-function checks for the Personal Finance engine. No DB.
//   npx tsx scripts/check-personal-finance.ts
import { distributeFunds } from "../src/lib/finance/distribute";
import { minPayment, utilization, cardTotals } from "../src/lib/finance/cards";
import { buildCalendar, type CalItem } from "../src/lib/finance/calendar";
import type { FundConfig } from "../src/lib/finance/types";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

// A. Personal waterfall: NO reserve (rate 0), FP1 → FP2 → FREE by priority.
const funds: FundConfig[] = [
  { id: "house", name: "Housing", group: "FP1", allocationType: "percent", value: 40, priority: 10, active: true },
  { id: "cards", name: "Credit Cards", group: "FP1", allocationType: "percent", value: 30, priority: 16, active: true },
  { id: "save", name: "Savings", group: "FP2", allocationType: "percent", value: 10, priority: 30, active: true },
  { id: "free", name: "Free", group: "FREE", allocationType: "percent", value: 0, priority: 999, active: true },
];
const d = distributeFunds(5000, 0, funds);
eq("reserve is 0 (personal)", d.reserve, 0);
eq("distributable = full income", d.distributable, 5000);
eq("Housing 40%", d.allocations.find((a) => a.fundId === "house")?.amount, 2000);
eq("Cards 30%", d.allocations.find((a) => a.fundId === "cards")?.amount, 1500);
eq("Savings 10%", d.allocations.find((a) => a.fundId === "save")?.amount, 500);
eq("Free gets the rest", d.free, 1000);

// B. Minimum payment = max(fixed, balance×pct), capped at balance.
eq("min: pct wins (40)", minPayment({ currentBalance: 2000, minPaymentFixed: 35, minPaymentPct: 2 }), 40);
eq("min: floor wins (35)", minPayment({ currentBalance: 1000, minPaymentFixed: 35, minPaymentPct: 2 }), 35);
eq("min: capped at balance", minPayment({ currentBalance: 10, minPaymentFixed: 35, minPaymentPct: 2 }), 10);
eq("min: zero balance", minPayment({ currentBalance: 0, minPaymentFixed: 35, minPaymentPct: 2 }), 0);

// C. Utilization.
eq("util 0.30", utilization({ currentBalance: 3000, creditLimit: 10000 }), 0.3);
eq("util no limit → 0", utilization({ currentBalance: 3000, creditLimit: 0 }), 0);

// D. Portfolio totals.
const t = cardTotals([
  { currentBalance: 2000, creditLimit: 10000, minPaymentFixed: 35, minPaymentPct: 2 },
  { currentBalance: 11400, creditLimit: 20000, minPaymentFixed: 35, minPaymentPct: 2 },
]);
eq("totalBalance", t.totalBalance, 13400);
eq("overallUtilization 0.45", t.overallUtilization, 0.45);
eq("totalMinPayment (40 + 228)", t.totalMinPayment, 268);

// E. Calendar: month-end clamp + next-occurrence within window.
const items: CalItem[] = [
  { kind: "card", label: "Card", amount: 40, dueDay: 7 },
  { kind: "bill", label: "Rent", amount: 100, dueDay: 31 },
];
const cal = buildCalendar(items, "2026-06-21", 45);
eq("calendar has 3 occurrences", cal.length, 3);
eq("first is June 30 (31→last day)", cal[0].date, "2026-06-30");
eq("second is July 7 (card)", cal[1].date, "2026-07-07");

console.log(failures === 0 ? "\n✓ ALL PASS" : `\n✗ ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
