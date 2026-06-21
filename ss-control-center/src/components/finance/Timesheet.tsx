"use client";

/**
 * Timesheet (табель) — lives inside the Salaries fund. Each employee is one salary
 * expense with its own running BALANCE: Accrued (начислено = worked days × per-day
 * rate) − Paid (выплачено) = Owed (остаток), carried forward across plans. Mark
 * worked days in the month grid; press Paid to pay an employee's owed amount (debits
 * the fund). Salaries are driven only here (not by the daily meter).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const up5 = (n: number) => Math.ceil((n - 1e-9) / 5) * 5; // round up to nearest $5

interface Emp { id: string; name: string; amount: number; frequency: string; perDay: number; workedDates: string[]; days: number; monthPay: number; accrued: number; paid: number; owed: number }

function currentMonth() { return new Date().toISOString().slice(0, 7); }
function daysInMonth(month: string) { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function shiftMonth(month: string, delta: number) { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function dateStr(month: string, day: number) { return `${month}-${String(day).padStart(2, "0")}`; }
function isWeekend(month: string, day: number) { const wd = new Date(`${dateStr(month, day)}T00:00:00`).getDay(); return wd === 0 || wd === 6; }

export function Timesheet({ fundId, onChanged }: { fundId: string; onChanged?: () => void }) {
  const [month, setMonth] = useState(currentMonth());
  const [emps, setEmps] = useState<Emp[]>([]);
  const [worked, setWorked] = useState<Record<string, Set<string>>>({});
  const [payAmt, setPayAmt] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/finance/timesheet?month=${month}`).then((x) => x.json());
      setEmps(r.employees ?? []);
      const w: Record<string, Set<string>> = {};
      for (const e of r.employees ?? []) w[e.id] = new Set(e.workedDates);
      setWorked(w);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  async function toggle(empId: string, day: number) {
    const d = dateStr(month, day);
    setWorked((prev) => { const set = new Set(prev[empId] ?? []); if (set.has(d)) set.delete(d); else set.add(d); return { ...prev, [empId]: set }; });
    try {
      await fetch("/api/finance/timesheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "toggle", expenseId: empId, date: d }) });
      await load(); onChanged?.(); // balances (accrued) changed
    } catch { load(); }
  }

  // Manual balance edit (start-of-plan alignment) for a salary employee.
  async function patchBalance(id: string, field: "accrued" | "paid", value: string) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    setBusy(true); setError(null);
    try {
      await fetch("/api/finance/expenses", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, [field]: v }) });
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function pay(e: Emp) {
    const amount = Number(payAmt[e.id] ?? up5(e.owed));
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a payment amount"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${fundId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "pay_expense", expenseId: e.id, amount }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setPayAmt((p) => { const n = { ...p }; delete n[e.id]; return n; });
      await load(); onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }

  const dayList = Array.from({ length: daysInMonth(month) }, (_, i) => i + 1);
  const totalOwed = emps.reduce((s, e) => s + up5(e.owed), 0);

  return (
    <div className="space-y-4">
      {error && <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}

      {/* Per-employee balance: Accrued − Paid = Owed (carries forward) */}
      {emps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No salary employees. Add them on the <Link href="/finance/expenses" className="text-primary hover:underline">Expenses</Link> page (category Salaries).</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2 text-right">Accrued (начислено)</th><th className="px-3 py-2 text-right">Paid (выплачено)</th><th className="px-3 py-2 text-right">Balance (остаток)</th><th className="px-3 py-2">Pay</th></tr></thead>
            <tbody>
              {emps.map((e) => {
                const balance = up5(e.owed); // remaining, rounded up to $5
                const due = balance > 0.005;
                return (
                  <tr key={e.id} className={cn("border-b last:border-0", due && "bg-amber-50/40")}>
                    <td className="px-3 py-2"><div className="font-medium">{e.name}</div><div className="text-[10px] text-muted-foreground">{usd(e.perDay)}/day ({e.frequency})</div></td>
                    <td className="px-3 py-2 text-right"><Input key={`acc-${e.id}-${e.accrued}`} type="number" className="w-24 text-right tabular-nums" defaultValue={String(up5(e.accrued))} onBlur={(ev) => { const v = Number(ev.target.value); if (v !== up5(e.accrued)) patchBalance(e.id, "accrued", ev.target.value); }} disabled={busy} /></td>
                    <td className="px-3 py-2 text-right"><Input key={`paid-${e.id}-${e.paid}`} type="number" className="w-24 text-right tabular-nums" defaultValue={e.paid.toFixed(2)} onBlur={(ev) => { if (Number(ev.target.value) !== e.paid) patchBalance(e.id, "paid", ev.target.value); }} disabled={busy} /></td>
                    <td className={cn("px-3 py-2 text-right font-medium tabular-nums", due ? "text-amber-600" : "text-emerald-600")}>{usd(balance)}</td>
                    <td className="px-3 py-2">
                      {due ? (
                        <div className="flex items-center gap-1">
                          <Input type="number" className="w-24" value={payAmt[e.id] ?? String(balance)} onChange={(ev) => setPayAmt({ ...payAmt, [e.id]: ev.target.value })} />
                          <Button size="sm" onClick={() => pay(e)} disabled={busy}><Check className="mr-1 h-3 w-3" />Paid</Button>
                        </div>
                      ) : <span className="text-xs text-emerald-600">clear</span>}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-muted/20"><td className="px-3 py-2 text-xs uppercase text-muted-foreground">Total owed</td><td /><td /><td className="px-3 py-2 text-right font-semibold tabular-nums text-amber-600">{usd(totalOwed)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Month grid — mark worked days; each tick accrues one per-day rate */}
      {emps.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-sm font-medium">{month}</span>
            <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight className="h-4 w-4" /></Button>
            <span className="ml-2 text-xs text-muted-foreground">Tick worked days — each tick adds one day&apos;s pay to that employee&apos;s Accrued.</span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-background px-2 py-1 text-left">Employee</th>
                  {dayList.map((d) => (<th key={d} className={cn("w-7 px-0 py-1 text-center font-normal", isWeekend(month, d) && "text-muted-foreground/50")}>{d}</th>))}
                  <th className="px-2 py-1 text-right">Days</th>
                  <th className="px-2 py-1 text-right">This month</th>
                </tr>
              </thead>
              <tbody>
                {emps.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="sticky left-0 bg-background px-2 py-1 text-left whitespace-nowrap font-medium">{e.name}</td>
                    {dayList.map((d) => {
                      const on = worked[e.id]?.has(dateStr(month, d));
                      return (
                        <td key={d} className="px-0 py-0.5 text-center">
                          <button onClick={() => toggle(e.id, d)} className={cn("h-6 w-6 rounded text-[10px]", on ? "bg-emerald-500 text-white" : isWeekend(month, d) ? "bg-muted/40 text-muted-foreground/40 hover:bg-muted" : "bg-muted hover:bg-muted-foreground/20")}>{on ? "✓" : ""}</button>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 text-right font-medium">{worked[e.id]?.size ?? 0}</td>
                    <td className="px-2 py-1 text-right font-medium">{usd((worked[e.id]?.size ?? 0) * e.perDay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
