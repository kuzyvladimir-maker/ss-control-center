"use client";

/**
 * Fund detail — cash balance + OWED debt meter + ledger.
 *
 * Owed = each expense item's daily-ticking debt (accrued = monthly cost ÷ 30.44 per
 * day, carried forward). Pressing Paid (full or part) clears that item's debt and
 * debits the fund's cash. This per-item owed total is what drives the plan's
 * "Needed". The Debt/Installment fund uses the Debts table instead.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowLeft, AlertCircle, Trash2, Check, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ReceiptScanner } from "@/components/finance/ReceiptScanner";
import { Timesheet } from "@/components/finance/Timesheet";
import { Debts } from "@/components/finance/Debts";
import { monthlyAmount } from "@/lib/finance/expenses";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
// Round UP to the nearest whole $5 (Vladimir wants clean 5/10/15… amounts).
const up5 = (n: number) => Math.ceil((n - 1e-9) / 5) * 5;

interface Fund { id: string; name: string; group: string; balance: number }
interface Entry { id: string; type: string; amount: number; description: string | null; status: string; dueDate: string | null; createdAt: string }
interface Expense { id: string; name: string; amount: number; frequency: string; accrued: number; paid: number }

const TYPE_LABEL: Record<string, string> = { allocation: "Allocation", spend: "Spend", planned_expense: "Bill", adjustment: "Manual credit", transfer: "Transfer" };

export default function FundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [fund, setFund] = useState<Fund | null>(null);
  const [allFunds, setAllFunds] = useState<{ id: string; name: string }[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [owedTotal, setOwedTotal] = useState(0);
  const [payAmt, setPayAmt] = useState<Record<string, string>>({});
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spend, setSpend] = useState({ amount: "", description: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, all] = await Promise.all([
        fetch(`/api/finance/funds/${id}`).then((x) => x.json()),
        fetch(`/api/finance/funds`).then((x) => x.json()),
      ]);
      if (r.error) throw new Error(r.error);
      setFund(r.fund); setEntries(r.entries ?? []); setExpenses(r.expenses ?? []); setOwedTotal(r.owedTotal ?? 0);
      setAllFunds((all.funds ?? []).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function post(body: object) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  // Manual balance edit (start-of-plan alignment): set an expense's accrued/paid.
  async function patchExpense(expenseId: string, field: "accrued" | "paid", value: string) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/expenses", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: expenseId, [field]: v }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function patch(body: object) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const isSalary = fund?.name === "Salaries" && fund?.group === "FP1";
  const isDebtFund = !!fund && ["debt", "expansion", "installment", "loan"].some((k) => fund.name.toLowerCase().includes(k));

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{fund?.name ?? "Fund"}</h1>
          <p className="text-sm text-muted-foreground">{fund?.group} fund — cash accumulates from payout distribution; its debt ticks daily and is cleared when you press Paid.</p>
        </div>
        <Link href="/finance?tab=funds"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back to funds</Button></Link>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">Balance (cash in fund)</div><div className={cn("text-3xl font-semibold", (fund?.balance ?? 0) < 0 ? "text-destructive" : "text-emerald-600")}>{usd(fund?.balance ?? 0)}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground" title="Outstanding balance = accrued − paid, across this fund's items (rounded up to $5). Carries forward each plan.">Balance owed</div><div className="text-3xl font-semibold text-amber-600">{usd(up5(owedTotal))}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">After clearing debt</div><div className={cn("text-3xl font-semibold", ((fund?.balance ?? 0) - up5(owedTotal)) < 0 ? "text-destructive" : "")}>{usd((fund?.balance ?? 0) - up5(owedTotal))}</div></CardContent></Card>
      </div>

      {isSalary && fund && (
        <Card>
          <CardHeader><CardTitle className="text-base">Timesheet — per-employee balance (accrued / paid / owed)</CardTitle></CardHeader>
          <CardContent><Timesheet fundId={fund.id} onChanged={load} /></CardContent>
        </Card>
      )}

      {isDebtFund && fund && (
        <Card>
          <CardHeader><CardTitle className="text-base">Debts</CardTitle></CardHeader>
          <CardContent><Debts fundId={fund.id} onChanged={load} /></CardContent>
        </Card>
      )}

      {/* Per-expense balance: Accrued (начислено, ticks daily) − Paid (выплачено) =
          Owed (остаток, carries forward). Press Paid to pay one down. Hidden on the
          Debt fund (Debts table) and the Salaries fund (the Timesheet shows balances). */}
      {!isDebtFund && !isSalary && (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Balances — accrued / paid / Balance (rounded up to $5, carries over each plan)</CardTitle>
            <Link href="/finance/expenses" className="text-xs text-primary hover:underline">Manage expense items →</Link>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {expenses.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">No expense items in this fund. Add them on the <Link href="/finance/expenses" className="text-primary hover:underline">Expenses</Link> page — each then accrues its daily debt here and feeds the plan&apos;s &quot;Needed&quot;.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Expense</th><th className="px-3 py-2 text-right">Monthly</th><th className="px-3 py-2 text-right">Accrued</th><th className="px-3 py-2 text-right">Paid</th><th className="px-3 py-2 text-right" title="Outstanding balance = accrued − paid (rounded up to $5)">Balance</th><th className="px-3 py-2">Pay</th></tr></thead>
              <tbody>
                {expenses.map((e) => {
                  const balance = up5(Math.max(0, round2((e.accrued ?? 0) - (e.paid ?? 0)))); // owed, rounded up to $5
                  const due = balance > 0.005;
                  return (
                    <tr key={e.id} className={cn("border-b last:border-0", due ? "bg-amber-50/40" : "")}>
                      <td className="px-3 py-2">{e.name} <span className="text-xs text-muted-foreground">({e.frequency})</span></td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{usd(up5(monthlyAmount(e.amount, e.frequency)))}</td>
                      <td className="px-3 py-2 text-right"><Input key={`acc-${e.id}-${e.accrued}`} type="number" className="w-24 text-right tabular-nums" defaultValue={String(up5(e.accrued ?? 0))} onBlur={(ev) => { const v = Number(ev.target.value); if (v !== up5(e.accrued ?? 0)) patchExpense(e.id, "accrued", String(v)); }} disabled={busy} /></td>
                      <td className="px-3 py-2 text-right"><Input key={`paid-${e.id}-${e.paid}`} type="number" className="w-24 text-right tabular-nums" defaultValue={(e.paid ?? 0).toFixed(2)} onBlur={(ev) => { const v = ev.target.value; if (Number(v) !== (e.paid ?? 0)) patchExpense(e.id, "paid", v); }} disabled={busy} /></td>
                      <td className={cn("px-3 py-2 text-right font-medium tabular-nums", due ? "text-amber-600" : "text-emerald-600")}>{usd(balance)}</td>
                      <td className="px-3 py-2">
                        {due ? (
                          <div className="flex items-center gap-1">
                            <Input type="number" className="w-24" value={payAmt[e.id] ?? String(balance)} onChange={(ev) => setPayAmt({ ...payAmt, [e.id]: ev.target.value })} />
                            <Button size="sm" onClick={() => { const a = Number(payAmt[e.id] ?? balance); if (Number.isFinite(a) && a > 0) { setPayAmt((p) => { const n = { ...p }; delete n[e.id]; return n; }); post({ kind: "pay_expense", expenseId: e.id, amount: a }); } }} disabled={busy}><Check className="mr-1 h-3 w-3" />Paid</Button>
                          </div>
                        ) : <span className="text-xs text-emerald-600">clear</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      )}

      {/* Scan a receipt + ad-hoc spend — not on the Debt fund (debts are paid via the Debts table) */}
      {!isDebtFund && (<>
      <Card>
        <CardHeader><CardTitle className="text-base">Scan a purchase receipt (debits this fund)</CardTitle></CardHeader>
        <CardContent>
          {fund && <ReceiptScanner funds={[{ id: fund.id, name: fund.name }]} defaultFundId={fund.id} onSaved={load} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Record an ad-hoc spend (debits now)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-28" value={spend.amount} onChange={(e) => setSpend({ ...spend, amount: e.target.value })} /></div>
          <div className="flex-1"><label className="block text-xs text-muted-foreground">Description</label><Input value={spend.description} onChange={(e) => setSpend({ ...spend, description: e.target.value })} placeholder="e.g. extra supplies" /></div>
          <Button onClick={() => { const a = Number(spend.amount); if (Number.isFinite(a) && a !== 0) { post({ kind: "spend", amount: a, description: spend.description }); setSpend({ amount: "", description: "" }); } }} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
        </CardContent>
      </Card>
      </>)}

      {/* Full ledger */}
      <Card>
        <CardHeader><CardTitle className="text-base">Ledger ({entries.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Move / delete</th></tr></thead>
            <tbody>
              {entries.map((e) => {
                const movable = e.type === "spend" || e.type === "adjustment";
                return (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="px-3 py-2 text-muted-foreground">{e.createdAt.slice(0, 10)}</td>
                    <td className="px-3 py-2">{TYPE_LABEL[e.type] ?? e.type}</td>
                    <td className="px-3 py-2"><Input key={`desc-${e.id}-${e.description ?? ""}`} className="h-8 w-56 text-sm" defaultValue={e.description ?? ""} onBlur={(ev) => { if (ev.target.value !== (e.description ?? "")) patch({ entryId: e.id, action: "edit", description: ev.target.value }); }} disabled={busy} /></td>
                    <td className="px-3 py-2 text-right"><Input key={`amt-${e.id}-${e.amount}`} type="number" className="h-8 w-28 text-right text-sm tabular-nums" defaultValue={e.amount.toFixed(2)} onBlur={(ev) => { if (Number(ev.target.value) !== e.amount) patch({ entryId: e.id, action: "edit", amount: Number(ev.target.value) }); }} disabled={busy} /></td>
                    <td className="px-3 py-2">{e.status === "planned" ? <span className="text-xs text-destructive">unpaid</span> : <span className="text-xs text-muted-foreground">applied</span>}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        {movable && (
                          <>
                            <select value={moveTo[e.id] ?? id} onChange={(ev) => setMoveTo({ ...moveTo, [e.id]: ev.target.value })} className="h-8 rounded-md border bg-background px-1 text-xs">
                              {allFunds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                            </select>
                            <Button size="sm" variant="outline" disabled={busy || (moveTo[e.id] ?? id) === id} onClick={() => patch({ entryId: e.id, action: "move", targetFundId: moveTo[e.id] })}>Move</Button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch({ entryId: e.id, action: "delete" })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {entries.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No movements yet. Money arrives here when you distribute a payout; bills debit it when paid.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
