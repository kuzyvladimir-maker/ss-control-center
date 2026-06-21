"use client";

/**
 * Debts — lives inside the Debt-repayment fund. Add company debts (amount,
 * description, date first incurred); see the total owed. The fund accumulates
 * money; paying a debt debits the fund and reduces what's owed. Listing debts
 * does NOT make the fund negative — it's a separate ledger of obligations.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Trash2, Plus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Debt { id: string; amount: number; paid: number; monthlyPayment: number | null; description: string | null; dateIncurred: string | null; status: string }

export function Debts({ fundId, onChanged }: { fundId: string; onChanged?: () => void }) {
  const [debts, setDebts] = useState<Debt[]>([]);
  const [totalRemaining, setTotalRemaining] = useState(0);
  const [totalOriginal, setTotalOriginal] = useState(0);
  const [monthlyDue, setMonthlyDue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ amount: "", description: "", dateIncurred: "", monthlyPayment: "" });
  const [payAmt, setPayAmt] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/finance/debts?fundId=${fundId}`).then((x) => x.json());
      setDebts(r.debts ?? []); setTotalRemaining(r.totalRemaining ?? 0); setTotalOriginal(r.totalOriginal ?? 0); setMonthlyDue(r.monthlyDue ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [fundId]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount === 0) { setError("Enter the debt amount"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/debts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", fundId, amount, description: draft.description, dateIncurred: draft.dateIncurred || null, monthlyPayment: draft.monthlyPayment || null }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setDraft({ amount: "", description: "", dateIncurred: "", monthlyPayment: "" }); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function pay(d: Debt) {
    const remaining = Math.round((d.amount - d.paid) * 100) / 100;
    const dflt = d.monthlyPayment ? Math.min(d.monthlyPayment, remaining) : remaining;
    const amount = Number(payAmt[d.id] ?? dflt);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a payment amount"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/debts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pay", debtId: d.id, amount }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setPayAmt((p) => { const n = { ...p }; delete n[d.id]; return n; });
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function del(id: string) { await fetch(`/api/finance/debts?id=${id}`, { method: "DELETE" }); await load(); }

  return (
    <div className="space-y-3">
      {error && <p className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}

      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-muted-foreground">Total owed (remaining): <b className="text-destructive">{usd(totalRemaining)}</b></span>
        {monthlyDue > 0 && <span className="text-muted-foreground">Monthly due: <b className="text-foreground">{usd(monthlyDue)}</b></span>}
        <span className="text-muted-foreground">Original total: <b className="text-foreground">{usd(totalOriginal)}</b></span>
      </div>

      {/* Add a debt */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
        <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-28" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>
        <div className="flex-1"><label className="block text-xs text-muted-foreground">Description</label><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="e.g. Working loan / 2024 tax installment" /></div>
        <div><label className="block text-xs text-muted-foreground">Monthly $ (installment)</label><Input type="number" className="w-28" value={draft.monthlyPayment} onChange={(e) => setDraft({ ...draft, monthlyPayment: e.target.value })} placeholder="optional" /></div>
        <div><label className="block text-xs text-muted-foreground">Date incurred</label><Input type="date" className="w-40" value={draft.dateIncurred} onChange={(e) => setDraft({ ...draft, dateIncurred: e.target.value })} /></div>
        <Button onClick={add} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
      </div>

      {/* Debts table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Debt</th><th className="px-3 py-2">Date incurred</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Monthly</th><th className="px-3 py-2 text-right">Paid</th><th className="px-3 py-2 text-right">Remaining</th><th className="px-3 py-2">Pay</th><th className="px-3 py-2"></th></tr></thead>
          <tbody>
            {debts.map((d) => {
              const remaining = Math.round((d.amount - d.paid) * 100) / 100;
              const settled = remaining <= 0.005;
              return (
                <tr key={d.id} className={cn("border-b last:border-0", settled && "opacity-50")}>
                  <td className="px-3 py-2">{d.description ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.dateIncurred ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(d.amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{d.monthlyPayment ? usd(d.monthlyPayment) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{usd(d.paid)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums text-destructive">{usd(remaining)}</td>
                  <td className="px-3 py-2">
                    {settled ? <span className="text-xs text-emerald-600">settled</span> : (
                      <div className="flex items-center gap-1">
                        <Input type="number" className="w-24" value={payAmt[d.id] ?? String(d.monthlyPayment ? Math.min(d.monthlyPayment, remaining) : remaining)} onChange={(e) => setPayAmt({ ...payAmt, [d.id]: e.target.value })} />
                        <Button size="sm" variant="outline" onClick={() => pay(d)} disabled={busy}><Check className="mr-1 h-3 w-3" />Pay</Button>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2"><Button variant="ghost" size="sm" onClick={() => del(d.id)} disabled={busy}><Trash2 className="h-4 w-4 text-destructive" /></Button></td>
                </tr>
              );
            })}
            {debts.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No debts yet. Add them above (amount, monthly installment, description, date).</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
