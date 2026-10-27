// Pure-function checks for the Personal Finance engine. No DB.
//   npx tsx scripts/check-personal-finance.ts
import { distributeFunds } from "../src/lib/finance/distribute";
import { minPayment, knownMinPayment, utilization, cardTotals } from "../src/lib/finance/cards";
import { buildCalendar, type CalItem } from "../src/lib/finance/calendar";
import { cardToLiability, debtToLiability, sortLiabilities, registryTotals, netWorth, collectAlerts } from "../src/lib/finance/registry";
import { orderFor, simulatePayoff, addMonths } from "../src/lib/finance/payoff";
import { buildPersonalCalendar } from "../src/lib/finance/personal-calendar";
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
const partial = cardTotals([{ currentBalance: 100, creditLimit: 200, apr: 0, minPaymentDue: 10 }, { currentBalance: 1000, creditLimit: 0, apr: null }]);
eq("missing limit does not inflate utilization", partial.overallUtilization, 0.5);
eq("incomplete card totals report missing fields", [partial.limitsUnknown, partial.aprsUnknown, partial.minimumsUnknown], [1, 1, 1]);

// E. Calendar: month-end clamp + next-occurrence within window.
const items: CalItem[] = [
  { kind: "card", label: "Card", amount: 40, dueDay: 7 },
  { kind: "bill", label: "Rent", amount: 100, dueDay: 31 },
];
const cal = buildCalendar(items, "2026-06-21", 45);
eq("calendar has 3 occurrences", cal.length, 3);
eq("first is June 30 (31→last day)", cal[0].date, "2026-06-30");
eq("second is July 7 (card)", cal[1].date, "2026-07-07");

// ── Phase 2 (2026-10-27) ────────────────────────────────────────────────────

// F. Statement minimum wins over the rule; unknown minimum is null, not $0.
eq("min: statement minimum wins", minPayment({ currentBalance: 6490.07, minPaymentDue: 225, minPaymentFixed: 35, minPaymentPct: 2 }), 225);
eq("min: statement minimum capped at balance", minPayment({ currentBalance: 8.33, minPaymentDue: 30 }), 8.33);
eq("known min: nothing known → null", knownMinPayment({ currentBalance: 95.84, minPaymentFixed: 0, minPaymentPct: 0 }), null);
eq("known min: zero balance → 0", knownMinPayment({ currentBalance: 0 }), 0);
eq("known min: rule still works", knownMinPayment({ currentBalance: 1000, minPaymentFixed: 35, minPaymentPct: 2 }), 35);

// G. Registry: a debt with an unknown balance stays null and is counted, never summed.
const cardRow = { id: "c1", owner: "Vladimir", issuer: "Wells Fargo", name: "WF Reflect", last4: "8843", creditLimit: 10000, currentBalance: 8846.51, apr: 28.74, minPaymentFixed: 0, minPaymentPct: 0, minPaymentDue: 66, dueDay: 18, active: true, standing: "paying" };
const staleCard = { ...cardRow, id: "c2", name: "Card (due 6)", last4: null, currentBalance: 500, minPaymentDue: null, active: false, standing: "check" };
const debtBase = { scope: "personal", paid: 0, owner: "Vladimir", kind: null, apr: null, monthlyPayment: null, paymentFrequency: null, dueDay: null, status: "open" };
const parafin = debtToLiability({ ...debtBase, id: "d1", scope: "business", amount: 9150, description: "Parafin", owner: "Anna", monthlyPayment: 350, paymentFrequency: "biweekly", standing: "paying" });
const bmw = debtToLiability({ ...debtBase, id: "d2", amount: 0, amountKnown: false, description: "BMW X3", monthlyPayment: 810, standing: "past_due", alert: "past due" });
const court = debtToLiability({ ...debtBase, id: "d3", amount: 11653.16, description: "Amex 01001", owner: "Anna", standing: "court" });
const wf = cardToLiability(cardRow);
const stale = cardToLiability(staleCard);
eq("card label has last4", wf.label, "WF Reflect 8843");
eq("card utilization", wf.utilization, 0.88);
eq("business debt keeps its pool", parafin.pool, "business");
eq("biweekly $350 → $758.33/mo", parafin.monthlyPayment, 758.33);
eq("unknown balance → null", bmw.balance, null);
eq("stale card not counted", stale.counted, false);
const sorted = sortLiabilities([wf, parafin, bmw, court, stale]);
eq("sort: court, past due, then paying by balance", sorted.map((l) => l.id), ["d3", "d2", "d1", "c1", "c2"]);
const rt = registryTotals([wf, parafin, bmw, court, stale]);
eq("totals: 4 counted, 1 unknown", [rt.all.count, rt.all.unknown], [4, 1]);
eq("totals: known sum excludes stale + unknown", rt.all.total, 29649.67);
eq("totals: Anna", rt.byOwner.Anna.total, 20803.16);
eq("totals: business pool", rt.byPool.business.total, 9150);

// H. Net worth = assets − known counted liabilities; overdrawn account is negative.
const nw = netWorth([
  { id: "a1", name: "Savings", owner: "Vladimir", value: 8747.96, active: true },
  { id: "a2", name: "PayPal", owner: "Vladimir", value: -1287.38, active: true },
  { id: "a3", name: "Old", owner: "Vladimir", value: 999, active: false },
], [wf, parafin, bmw, court, stale]);
eq("net worth: assets", nw.assets, 7460.58);
eq("net worth: liabilities", nw.liabilities, 29649.67);
eq("net worth: net", nw.net, -22189.09);
eq("net worth: 1 unknown liability", nw.unknownLiabilities, 1);
eq("net worth: Vladimir net", nw.byOwner.Vladimir.net, -1385.93);
eq("alerts: counted only", collectAlerts([bmw, { ...stale, alert: "x" }], []).map((a) => a.refId), ["d2"]);

// I. Payoff: avalanche pays the highest APR first, snowball the smallest balance.
const pd = [
  { id: "big", label: "Big 25%", balance: 1000, apr: 25, minPayment: 50 },
  { id: "small", label: "Small 10%", balance: 300, apr: 10, minPayment: 25 },
  { id: "nil", label: "No APR", balance: 500, apr: null, minPayment: 25 },
];
eq("avalanche order", orderFor(pd, "avalanche").map((d) => d.id), ["big", "small", "nil"]);
eq("snowball order", orderFor(pd, "snowball").map((d) => d.id), ["small", "nil", "big"]);
const av = simulatePayoff(pd, 300, "avalanche", "2026-11");
const sb = simulatePayoff(pd, 300, "snowball", "2026-11");
eq("avalanche feasible, debt-free", [av.feasible, av.months != null], [true, true]);
eq("avalanche pays less interest than snowball", av.totalInterest <= sb.totalInterest, true);
eq("avalanche: first payoff is the 25% debt", av.order.reduce((m, l) => (l.payoffMonth! < m.payoffMonth! ? l : m)).id, "big");
eq("snowball: first payoff is the smallest", sb.order.reduce((m, l) => (l.payoffMonth! < m.payoffMonth! ? l : m)).id, "small");
eq("paid = balances + interest", av.totalPaid, Math.round((1800 + av.totalInterest) * 100) / 100);
eq("debt-free date in YYYY-MM", av.debtFreeDate, addMonths("2026-11", av.months! - 1));
eq("unknown APR reported", av.aprUnknown, ["nil"]);
const short = simulatePayoff(pd, 80, "avalanche", "2026-11");
eq("budget below minimums → infeasible + shortfall", [short.feasible, short.shortfall], [false, 20]);
eq("same inputs → same plan", JSON.stringify(simulatePayoff(pd, 300, "snowball", "2026-11")), JSON.stringify(sb));
eq("addMonths wraps the year", addMonths("2026-11", 3), "2027-02");
const unknownMinimum = simulatePayoff([{ ...pd[0], minPayment: null }], 300, "avalanche", "2026-11");
eq("unknown minimum is reported, never confirmed zero", unknownMinimum.minimumUnknown, ["big"]);
eq("unknown minimum stays null in plan lines", unknownMinimum.order[0].minPayment, null);
eq("explicit zero minimum is known", simulatePayoff([{ ...pd[0], minPayment: 0 }], 300, "avalanche", "2026-11").minimumUnknown, []);
eq("empty selection is zero months, not 50 years", simulatePayoff([], 0, "snowball", "2026-11").months, 0);

// J. Calendar Phase 2: one-offs, open windows, startFrom, unknown amount, supersedes.
const cal2 = buildCalendar([
  { kind: "card", label: "BJ's", amount: 225, dueDay: 19, refId: "bjs", startFrom: "2026-11-19" },
  { kind: "event", label: "BJ's full statement", amount: 6715.07, date: "2026-11-19", supersedes: "bjs", refId: "ev1" },
  { kind: "card", label: "AAdvantage", amount: 61, dueDay: 1, startFrom: "2026-12-01", refId: "aa" },
  { kind: "event", label: "IRS window", amount: null, date: "2026-10-20", endDate: "2026-11-16", eventKind: "window", refId: "ev2" },
  { kind: "event", label: "Mediation", amount: null, date: "2026-12-10", time: "13:00", refId: "ev3" },
  { kind: "event", label: "Past", amount: 10, date: "2026-10-01", refId: "ev4" },
  { kind: "loan", label: "Moto", amount: null, dueDay: 8, refId: "moto" },
], "2026-10-27", 60);
const at = (ref: string) => cal2.filter((e) => e.refId === ref).map((e) => e.date);
eq("supersedes: BJ's minimum replaced on 11-19", at("bjs"), ["2026-12-19"]);
eq("one-off payment shown", at("ev1"), ["2026-11-19"]);
eq("startFrom skips the covered Nov 1", at("aa"), ["2026-12-01"]);
eq("open window shows from today", at("ev2"), ["2026-10-27"]);
eq("mediation inside 60 days", at("ev3"), ["2026-12-10"]);
eq("past one-off not in the forward calendar", at("ev4"), []);
eq("unknown amount still shown", cal2.filter((e) => e.refId === "moto").map((e) => e.amount), [null, null]);

// K. Actual API read model: source/owner, completion, overdue retention, exact dates.
const calendarCard = { ...cardRow, id: "bjs", name: "BJ's", dueDay: 19, nextDueDate: "2026-11-19", minPaymentDue: 225, balanceAsOf: "2026-10-27", balanceSource: "Plaid 2026-10-27" };
const fullPayment = { id: "full", cardId: "bjs", debtId: null, title: "Full statement", date: "2026-11-19", endDate: null, time: null, kind: "payment", amount: 6715.07, status: "planned", source: "Owner decision 2026-10-26" };
const makeCalendar = (events = [fullPayment], date = "2026-10-27") => buildPersonalCalendar({ cards: [calendarCard], bills: [], loans: [], events }, date, 60);
const fullCal = makeCalendar();
eq("full statement and next month's min counted once", fullCal.totalDue, 6940.07);
eq("event inherits obligation owner", fullCal.entries[0].owner, "Vladimir");
eq("calendar carries amount source", fullCal.entries[0].amountSource, "Owner decision 2026-10-26");
eq("done full statement does not resurrect its minimum", makeCalendar([{ ...fullPayment, status: "done" }]).entries.map((e) => [e.date, e.amount]), [["2026-12-19", 225]]);
eq("cancelled full statement restores regular minimum", makeCalendar([{ ...fullPayment, status: "cancelled" }]).entries.map((e) => e.amount), [225, 225]);
eq("same overdue payment appears once, not as event and card", makeCalendar([fullPayment], "2026-11-20").overdue.map((e) => e.refId), ["full"]);
eq("completed payment not flagged overdue by stale card next date", makeCalendar([{ ...fullPayment, status: "done" }], "2026-11-20").overdue.length, 0);
eq("unresolved event older than 60 days stays visible", makeCalendar([{ ...fullPayment, date: "2026-07-01" }]).overdue.map((e) => e.refId), ["full"]);
eq("missed event stays visible", makeCalendar([{ ...fullPayment, status: "missed", date: "2026-07-01" }]).overdue.length, 1);
const exact = buildPersonalCalendar({ cards: [{ ...calendarCard, dueDay: null }], bills: [], loans: [], events: [] }, "2026-10-27");
eq("exact card date works without a recurring day", exact.entries.map((e) => e.date), ["2026-11-19"]);

console.log(failures === 0 ? "\n✓ ALL PASS" : `\n✗ ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
