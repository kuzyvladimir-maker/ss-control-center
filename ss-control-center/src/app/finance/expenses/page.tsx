"use client";

/**
 * Expense items (статьи расходов) — the CATALOG that feeds the funds. Each item
 * has a category (= the fund it belongs to) and a frequency. These items appear
 * automatically as payment presets INSIDE their fund, where you mark them paid
 * (which debits the fund). This page is just the catalog; paying happens in funds.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft, AlertCircle, Trash2, Plus, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const up5 = (n: number) => Math.ceil((n - 1e-9) / 5) * 5; // round up to nearest $5
const WEEKS = 52 / 12, WORKDAYS = 260 / 12;
const monthly = (a: number, f: string) => (f === "daily" ? a * WORKDAYS : f === "weekly" ? a * WEEKS : f === "yearly" ? a / 12 : f === "one_time" ? 0 : a);

interface Expense { id: string; name: string; category: string; amount: number; frequency: string; active: boolean; source: string; accrued?: number; paid?: number }
const CATEGORIES = ["Salaries", "Warehouse & Logistics", "Software", "Subscriptions", "Other"];
const FREQS = ["monthly", "weekly", "daily", "yearly", "one_time"];

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [byCategory, setByCategory] = useState<{ category: string; monthly: number }[]>([]);
  const [monthlyTotal, setMonthlyTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", category: "Salaries", amount: "", frequency: "monthly" });
  const [csv, setCsv] = useState(""); const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/finance/expenses").then((x) => x.json());
      setExpenses(r.expenses ?? []); setByCategory(r.byCategory ?? []); setMonthlyTotal(r.monthlyTotal ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!draft.name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setDraft({ name: "", category: draft.category, amount: "", frequency: "monthly" }); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function patch(id: string, data: Partial<Expense>) { await fetch("/api/finance/expenses", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...data }) }); await load(); }
  async function del(id: string) { await fetch(`/api/finance/expenses?id=${id}`, { method: "DELETE" }); await load(); }
  async function importCsv() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/expenses?import=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csv }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "import failed");
      setCsv(""); setShowImport(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const grouped = CATEGORIES.map((cat) => ({ cat, items: expenses.filter((e) => e.category === cat) })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Expense items</h1>
          <p className="text-sm text-muted-foreground">The catalog of expense line items. Category = the fund. Each item appears as a payment preset inside its fund — pay it there to debit the fund.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowImport((s) => !s)}><Upload className="mr-1 h-4 w-4" />Import CSV</Button>
          <Link href="/finance"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back</Button></Link>
        </div>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}

      {showImport && (
        <Card><CardHeader><CardTitle className="text-base">Import Sellerboard expenses CSV</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder="Paste CSV (Date;Type;Name;Category;Product;Marketplace;Sum;Currency;Ad_spend)…" />
            <Button onClick={importCsv} disabled={busy || !csv.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import"}</Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {byCategory.map((c) => (<Card key={c.category}><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">{c.category}</div><div className="text-xl font-semibold">{usd(c.monthly)}<span className="text-xs text-muted-foreground">/mo</span></div></CardContent></Card>))}
        <Card className="border-primary"><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">Total /mo</div><div className="text-xl font-semibold">{usd(monthlyTotal)}</div></CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle className="text-base">Add expense item</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div><label className="block text-xs text-muted-foreground">Name</label><Input className="w-48" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Claude (AI)" /></div>
          <div><label className="block text-xs text-muted-foreground">Category (fund)</label><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-24" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>
          <div><label className="block text-xs text-muted-foreground">Frequency</label><select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm">{FREQS.map((f) => <option key={f}>{f}</option>)}</select></div>
          <Button onClick={add} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
        </CardContent>
      </Card>

      {grouped.map((g) => {
        const sub = g.items.filter((e) => e.active).reduce((s, e) => s + monthly(e.amount, e.frequency), 0);
        return (
          <Card key={g.cat}>
            <CardHeader><div className="flex items-center justify-between"><CardTitle className="text-base">{g.cat}</CardTitle><span className="text-sm text-muted-foreground">{usd(sub)}/mo</span></div></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Frequency</th><th className="px-3 py-2 text-right">≈ Monthly</th><th className="px-3 py-2 text-right" title="Outstanding balance = accrued − paid (rounded up to $5); pay it inside the fund">Balance</th><th className="px-3 py-2">Active</th><th className="px-3 py-2"></th></tr></thead>
                <tbody>
                  {g.items.map((e) => {
                    const bal = up5(Math.max(0, (e.accrued ?? 0) - (e.paid ?? 0)));
                    return (
                    <tr key={e.id} className={cn("border-b last:border-0", !e.active && "opacity-50")}>
                      <td className="px-3 py-2">{e.name}</td>
                      <td className="px-3 py-2"><Input type="number" className="w-24" defaultValue={e.amount} onBlur={(ev) => { const v = Number(ev.target.value); if (v !== e.amount) patch(e.id, { amount: v }); }} /></td>
                      <td className="px-3 py-2"><select defaultValue={e.frequency} onChange={(ev) => patch(e.id, { frequency: ev.target.value })} className="h-8 rounded-md border bg-background px-1 text-xs">{FREQS.map((f) => <option key={f}>{f}</option>)}</select></td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{usd(up5(monthly(e.amount, e.frequency)))}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums font-medium", bal > 0.005 ? "text-amber-600" : "text-muted-foreground")}>{bal > 0.005 ? usd(bal) : "—"}</td>
                      <td className="px-3 py-2"><input type="checkbox" checked={e.active} onChange={(ev) => patch(e.id, { active: ev.target.checked })} /></td>
                      <td className="px-3 py-2"><Button variant="ghost" size="sm" onClick={() => del(e.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
