"use client";

/**
 * Timesheet (табель) — lives inside the Salaries fund. Mark each salary
 * employee's worked days; salary = worked days × per-day rate (weekly/monthly/
 * yearly rates are converted to per-day). "Create salary bills" turns each
 * employee's pay into a bill in the Salaries fund, to mark paid there.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ReceiptText, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Emp { id: string; name: string; amount: number; frequency: string; perDay: number; workedDates: string[]; days: number; pay: number }

function currentMonth() { return new Date().toISOString().slice(0, 7); }
function daysInMonth(month: string) { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function shiftMonth(month: string, delta: number) { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function dateStr(month: string, day: number) { return `${month}-${String(day).padStart(2, "0")}`; }
function isWeekend(month: string, day: number) { const wd = new Date(`${dateStr(month, day)}T00:00:00`).getDay(); return wd === 0 || wd === 6; }

export function Timesheet({ onBillsCreated }: { onBillsCreated?: () => void }) {
  const [month, setMonth] = useState(currentMonth());
  const [emps, setEmps] = useState<Emp[]>([]);
  const [worked, setWorked] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
    try { await fetch("/api/finance/timesheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "toggle", expenseId: empId, date: d }) }); }
    catch { load(); }
  }

  async function createBills() {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/timesheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_bills", month }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      const parts = (r.result ?? []).map((x: { name: string; days: number; pay: number }) => `${x.name} ${x.days}d=${usd(x.pay)}`).join("; ");
      setNote(`Created ${r.created} salary bill(s) below. ${parts}`);
      onBillsCreated?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const dayList = Array.from({ length: daysInMonth(month) }, (_, i) => i + 1);
  const payFor = (e: Emp) => Math.round((worked[e.id]?.size ?? 0) * e.perDay * 100) / 100;
  const totalPay = emps.reduce((s, e) => s + payFor(e), 0);

  return (
    <div className="space-y-3">
      {error && <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}
      {note && <p className="flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" />{note}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium">{month}</span>
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Total this month: <b className="text-foreground">{usd(totalPay)}</b></span>
          <Button onClick={createBills} disabled={busy || emps.length === 0}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ReceiptText className="mr-1 h-4 w-4" />}Create salary bills</Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        {emps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No salary employees. Add them on the <Link href="/finance/expenses" className="text-primary hover:underline">Expenses</Link> page (category Salaries).</p>
        ) : (
          <table className="text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-background px-2 py-1 text-left">Employee</th>
                {dayList.map((d) => (<th key={d} className={cn("w-7 px-0 py-1 text-center font-normal", isWeekend(month, d) && "text-muted-foreground/50")}>{d}</th>))}
                <th className="px-2 py-1 text-right">Days</th>
                <th className="px-2 py-1 text-right">Pay</th>
              </tr>
            </thead>
            <tbody>
              {emps.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="sticky left-0 bg-background px-2 py-1 text-left">
                    <div className="whitespace-nowrap font-medium">{e.name}</div>
                    <div className="text-[10px] text-muted-foreground">{usd(e.perDay)}/day ({e.frequency})</div>
                  </td>
                  {dayList.map((d) => {
                    const on = worked[e.id]?.has(dateStr(month, d));
                    return (
                      <td key={d} className="px-0 py-0.5 text-center">
                        <button onClick={() => toggle(e.id, d)} className={cn("h-6 w-6 rounded text-[10px]", on ? "bg-emerald-500 text-white" : isWeekend(month, d) ? "bg-muted/40 text-muted-foreground/40 hover:bg-muted" : "bg-muted hover:bg-muted-foreground/20")}>{on ? "✓" : ""}</button>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-right font-medium">{worked[e.id]?.size ?? 0}</td>
                  <td className="px-2 py-1 text-right font-medium">{usd(payFor(e))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
