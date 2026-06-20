"use client";

/**
 * Fund detail — balance + BILLS + ledger.
 *
 * Bills = the fund's expense items (presets from the Expenses catalog) turned into
 * payable bills for the period. Unpaid bills are RED and hang there even if the
 * fund can't cover them (the balance can go negative). Paying one (with the actual
 * amount) turns it GREEN and debits the fund. Three actions per bill: Paid / Not
 * paid (revert) / Delete (if it's no longer relevant).
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowLeft, AlertCircle, Trash2, Check, RotateCcw, Plus, ListPlus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ReceiptScanner } from "@/components/finance/ReceiptScanner";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund { id: string; name: string; group: string; balance: number }
interface Entry { id: string; type: string; amount: number; description: string | null; status: string; dueDate: string | null; createdAt: string }
interface Preset { id: string; name: string; amount: number; frequency: string }

const TYPE_LABEL: Record<string, string> = { allocation: "Allocation", spend: "Spend", planned_expense: "Bill", adjustment: "Manual credit" };

export default function FundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [fund, setFund] = useState<Fund | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [billAmt, setBillAmt] = useState<Record<string, string>>({});
  const [plannedTotal, setPlannedTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spend, setSpend] = useState({ amount: "", description: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setFund(r.fund); setEntries(r.entries ?? []); setPresets(r.presets ?? []); setPlannedTotal(r.plannedTotal ?? 0);
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
  async function patch(body: object) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/finance/funds/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const bills = entries.filter((e) => e.type === "planned_expense").sort((a, b) => (a.status === b.status ? 0 : a.status === "planned" ? -1 : 1));
  const unpaidTotal = bills.filter((b) => b.status === "planned").reduce((s, b) => s + b.amount, 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{fund?.name ?? "Fund"}</h1>
          <p className="text-sm text-muted-foreground">{fund?.group} fund — accumulates from payout distribution; bills are paid out of it.</p>
        </div>
        <Link href="/finance"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back</Button></Link>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">Balance</div><div className={cn("text-3xl font-semibold", (fund?.balance ?? 0) < 0 ? "text-destructive" : "text-emerald-600")}>{usd(fund?.balance ?? 0)}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">Unpaid bills</div><div className="text-3xl font-semibold text-destructive">{usd(unpaidTotal)}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">After paying bills</div><div className={cn("text-3xl font-semibold", ((fund?.balance ?? 0) + unpaidTotal) < 0 ? "text-destructive" : "")}>{usd((fund?.balance ?? 0) + unpaidTotal)}</div></CardContent></Card>
      </div>

      {/* Bills — the payable items for this period */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Bills to pay</CardTitle>
            <div className="flex items-center gap-2">
              <Link href="/finance/expenses" className="text-xs text-primary hover:underline">Manage expense items →</Link>
              <Button size="sm" variant="outline" onClick={() => post({ kind: "generate_bills" })} disabled={busy}><ListPlus className="mr-1 h-4 w-4" />Generate from presets</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {bills.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">No bills yet. Click <b>Generate from presets</b> to turn this fund&apos;s expense items into payable bills, or add presets on the <Link href="/finance/expenses" className="text-primary hover:underline">Expenses</Link> page.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Bill</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th></tr></thead>
              <tbody>
                {bills.map((bl) => {
                  const unpaid = bl.status === "planned";
                  return (
                    <tr key={bl.id} className={cn("border-b last:border-0", unpaid ? "bg-rose-50/50" : "bg-emerald-50/40")}>
                      <td className="px-3 py-2">{bl.description ?? "—"}</td>
                      <td className="px-3 py-2">
                        {unpaid
                          ? <Input type="number" className="w-28" value={billAmt[bl.id] ?? String(Math.abs(bl.amount))} onChange={(e) => setBillAmt({ ...billAmt, [bl.id]: e.target.value })} />
                          : <span className="tabular-nums">{usd(bl.amount)}</span>}
                      </td>
                      <td className="px-3 py-2">{unpaid ? <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">UNPAID</span> : <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">PAID</span>}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {unpaid
                            ? <Button size="sm" onClick={() => patch({ entryId: bl.id, action: "pay", amount: Number(billAmt[bl.id] ?? Math.abs(bl.amount)) })} disabled={busy}><Check className="mr-1 h-3 w-3" />Paid</Button>
                            : <Button size="sm" variant="outline" onClick={() => patch({ entryId: bl.id, action: "unpay" })} disabled={busy}><RotateCcw className="mr-1 h-3 w-3" />Not paid</Button>}
                          <Button size="sm" variant="ghost" onClick={() => patch({ entryId: bl.id, action: "delete" })} disabled={busy}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Presets reference — add a single bill from a preset */}
      {presets.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Expense presets in this fund</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Frequency</th><th className="px-3 py-2"></th></tr></thead>
              <tbody>
                {presets.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 tabular-nums">{usd(p.amount)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.frequency}</td>
                    <td className="px-3 py-2"><Button size="sm" variant="outline" onClick={() => post({ kind: "planned", amount: p.amount, description: p.name })} disabled={busy}><Plus className="mr-1 h-3 w-3" />Add as bill</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Scan a receipt → spend from this fund */}
      <Card>
        <CardHeader><CardTitle className="text-base">Scan a purchase receipt (debits this fund)</CardTitle></CardHeader>
        <CardContent>
          {fund && <ReceiptScanner funds={[{ id: fund.id, name: fund.name }]} defaultFundId={fund.id} onSaved={load} />}
        </CardContent>
      </Card>

      {/* Manual spend */}
      <Card>
        <CardHeader><CardTitle className="text-base">Record an ad-hoc spend (debits now)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-28" value={spend.amount} onChange={(e) => setSpend({ ...spend, amount: e.target.value })} /></div>
          <div className="flex-1"><label className="block text-xs text-muted-foreground">Description</label><Input value={spend.description} onChange={(e) => setSpend({ ...spend, description: e.target.value })} placeholder="e.g. extra supplies" /></div>
          <Button onClick={() => { const a = Number(spend.amount); if (Number.isFinite(a) && a !== 0) { post({ kind: "spend", amount: a, description: spend.description }); setSpend({ amount: "", description: "" }); } }} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
        </CardContent>
      </Card>

      {/* Full ledger */}
      <Card>
        <CardHeader><CardTitle className="text-base">Ledger ({entries.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Status</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-muted-foreground">{e.createdAt.slice(0, 10)}</td>
                  <td className="px-3 py-2">{TYPE_LABEL[e.type] ?? e.type}</td>
                  <td className="px-3 py-2">{e.description ?? "—"}</td>
                  <td className={cn("px-3 py-2 text-right font-medium tabular-nums", e.amount < 0 ? "text-destructive" : "text-emerald-600")}>{usd(e.amount)}</td>
                  <td className="px-3 py-2">{e.status === "planned" ? <span className="text-xs text-destructive">unpaid</span> : <span className="text-xs text-muted-foreground">applied</span>}</td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No movements yet. Money arrives here when you distribute a payout; bills debit it when paid.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
