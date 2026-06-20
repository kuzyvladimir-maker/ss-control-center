"use client";

/**
 * Fund detail — balance + ledger. Shows allocations (credits from payout
 * distribution), manual spends (debits now), and planned expenses (debits that
 * hit the balance only when marked Paid). Balance can go negative.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowLeft, AlertCircle, Trash2, Check, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund { id: string; name: string; group: string; balance: number }
interface Entry { id: string; type: string; amount: number; description: string | null; status: string; dueDate: string | null; createdAt: string }

const TYPE_LABEL: Record<string, string> = {
  allocation: "Allocation", spend: "Spend", planned_expense: "Planned expense", adjustment: "Manual credit",
};

export default function FundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [fund, setFund] = useState<Fund | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [plannedTotal, setPlannedTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spend, setSpend] = useState({ amount: "", description: "" });
  const [plan, setPlan] = useState({ amount: "", description: "", dueDate: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setFund(r.fund); setEntries(r.entries ?? []); setPlannedTotal(r.plannedTotal ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function add(kind: "spend" | "planned", data: { amount: string; description: string; dueDate?: string }) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount === 0) { setError("Enter an amount"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...data }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      if (kind === "spend") setSpend({ amount: "", description: "" }); else setPlan({ amount: "", description: "", dueDate: "" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function entryAction(entryId: string, action: "pay" | "delete") {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryId, action }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{fund?.name ?? "Fund"}</h1>
          <p className="text-sm text-muted-foreground">{fund?.group} fund — ledger of allocations, spends and planned expenses.</p>
        </div>
        <Link href="/finance"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back</Button></Link>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card><CardContent className="py-4">
          <div className="text-xs uppercase text-muted-foreground">Balance</div>
          <div className={cn("text-3xl font-semibold", (fund?.balance ?? 0) < 0 ? "text-destructive" : "text-emerald-600")}>{usd(fund?.balance ?? 0)}</div>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <div className="text-xs uppercase text-muted-foreground">Planned (unpaid)</div>
          <div className="text-3xl font-semibold text-amber-600">{usd(plannedTotal)}</div>
          <div className="text-xs text-muted-foreground">After paying all planned: {usd((fund?.balance ?? 0) + plannedTotal)}</div>
        </CardContent></Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Record a spend (debits now)</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-28" value={spend.amount} onChange={(e) => setSpend({ ...spend, amount: e.target.value })} /></div>
            <div className="flex-1"><label className="block text-xs text-muted-foreground">Description</label><Input value={spend.description} onChange={(e) => setSpend({ ...spend, description: e.target.value })} placeholder="e.g. Uline boxes" /></div>
            <Button onClick={() => add("spend", spend)} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Plan an expense (debits when paid)</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-24" value={plan.amount} onChange={(e) => setPlan({ ...plan, amount: e.target.value })} /></div>
            <div className="flex-1"><label className="block text-xs text-muted-foreground">Description</label><Input value={plan.description} onChange={(e) => setPlan({ ...plan, description: e.target.value })} placeholder="e.g. China shipment" /></div>
            <div><label className="block text-xs text-muted-foreground">Due</label><Input type="date" className="w-36" value={plan.dueDate} onChange={(e) => setPlan({ ...plan, dueDate: e.target.value })} /></div>
            <Button onClick={() => add("planned", plan)} disabled={busy} variant="outline">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Ledger ({entries.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Due</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-muted-foreground">{e.createdAt.slice(0, 10)}</td>
                  <td className="px-3 py-2">{TYPE_LABEL[e.type] ?? e.type}</td>
                  <td className="px-3 py-2">{e.description ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.dueDate ?? "—"}</td>
                  <td className={cn("px-3 py-2 text-right font-medium tabular-nums", e.amount < 0 ? "text-destructive" : "text-emerald-600")}>{usd(e.amount)}</td>
                  <td className="px-3 py-2">{e.status === "planned" ? <span className="text-xs text-amber-600">planned</span> : <span className="text-xs text-muted-foreground">applied</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {e.status === "planned" && <Button size="sm" variant="outline" onClick={() => entryAction(e.id, "pay")} disabled={busy}><Check className="mr-1 h-3 w-3" />Paid</Button>}
                      {e.type !== "allocation" && <Button size="sm" variant="ghost" onClick={() => entryAction(e.id, "delete")} disabled={busy}><Trash2 className="h-3 w-3 text-destructive" /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No entries yet. Allocations appear here after you distribute payouts; add spends/planned expenses above.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
