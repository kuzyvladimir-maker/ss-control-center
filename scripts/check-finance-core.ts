// Sanity checks for the Funds pure core (Phase 1). No DB needed.
// Run: npx tsx scripts/check-finance-core.ts
import { distributeFunds } from "@/lib/finance/distribute";
import { blendReserveRate } from "@/lib/finance/reserve-rate";
import type { FundConfig } from "@/lib/finance/types";

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

const f = (
  id: string,
  group: FundConfig["group"],
  allocationType: FundConfig["allocationType"],
  value: number,
  priority: number,
  cap: number | null = null,
): FundConfig => ({ id, name: id, group, allocationType, value, priority, cap, active: true });

// --- blendReserveRate ---
eq("blend rate 45% (shipping excluded)", blendReserveRate({ cogs: 40, shipping: 10, packaging: 5, revenue: 100 }), 0.45);
eq("blend rate 0 revenue", blendReserveRate({ cogs: 5, shipping: 0, packaging: 0, revenue: 0 }), 0);
eq("blend rate capped at 1", blendReserveRate({ cogs: 90, shipping: 30, packaging: 10, revenue: 100 }), 1);

// --- Basic waterfall: $1000 in, 50% reserve → $500 distributable ---
const funds = [
  f("reserve", "RESERVE", "percent", 0, 0),
  f("payroll", "FP1", "percent", 40, 10), // 40% of 500 = 200
  f("rent", "FP1", "absolute", 100, 20), // 100
  f("growth", "FP2", "percent", 50, 30), // 50% of 500 = 250, but only 200 left
  f("free", "FREE", "percent", 0, 99),
];
const r = distributeFunds(1000, 0.5, funds);
eq("reserve", r.reserve, 500);
eq("distributable", r.distributable, 500);
const byId = new Map(r.allocations.map((a) => [a.fundId, a.amount]));
eq("reserve fund alloc", byId.get("reserve")!, 500);
eq("payroll 40% of 500", byId.get("payroll")!, 200);
eq("rent absolute 100", byId.get("rent")!, 100);
eq("growth gets remaining 200 (oversubscribed)", byId.get("growth")!, 200);
eq("free leftover 0", byId.get("free")!, 0);
eq("free field", r.free, 0);

// --- Leftover flows to FREE ---
const funds2 = [
  f("reserve", "RESERVE", "percent", 0, 0),
  f("rent", "FP1", "absolute", 100, 10),
  f("free", "FREE", "percent", 0, 99),
];
const r2 = distributeFunds(1000, 0.3, funds2); // reserve 300, distributable 700, rent 100 → free 600
eq("r2 reserve", r2.reserve, 300);
eq("r2 distributable", r2.distributable, 700);
const byId2 = new Map(r2.allocations.map((a) => [a.fundId, a.amount]));
eq("r2 rent", byId2.get("rent")!, 100);
eq("r2 free fund gets 600", byId2.get("free")!, 600);
eq("r2 free field", r2.free, 600);

// --- Cap is respected ---
const funds3 = [f("reserve", "RESERVE", "percent", 0, 0), f("capped", "FP1", "percent", 90, 10, 50)];
const r3 = distributeFunds(1000, 0, funds3); // no reserve; 90% of 1000=900 but cap 50
const byId3 = new Map(r3.allocations.map((a) => [a.fundId, a.amount]));
eq("capped at 50", byId3.get("capped")!, 50);

// --- Inactive funds skipped ---
const funds4 = [
  f("reserve", "RESERVE", "percent", 0, 0),
  { ...f("off", "FP1", "absolute", 100, 10), active: false },
];
const r4 = distributeFunds(1000, 0.2, funds4);
assert("inactive fund not allocated", !r4.allocations.some((a) => a.fundId === "off"));

// --- Zero / negative input safe ---
const r5 = distributeFunds(0, 0.5, funds);
eq("zero in → reserve 0", r5.reserve, 0);
eq("zero in → free 0", r5.free, 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
