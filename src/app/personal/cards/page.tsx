"use client";

/**
 * Personal credit cards — the centre of the personal pool. Each card tracks its
 * balance, limit (→ utilization), APR (→ monthly interest), minimum-payment rule,
 * and due day (→ the dashboard calendar). Pay a card to debit its fund and lower the
 * balance. Grouped by owner (Vladimir / Anna).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, PlusCircle, ArrowLeft, Trash2, Pencil, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usd2 = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface CC {
  id: string; owner: string | null; issuer: string; name: string | null; last4: string | null;
  creditLimit: number; currentBalance: number; statementBalance: number; apr: number | null;
  minPaymentFixed: number; minPaymentPct: number; statementDay: number | null; dueDay: number | null;
  autopay: string; fundId: string | null; active: boolean;
  minPayment: number; utilization: number; monthlyInterest: number;
}
interface Totals { count: number; totalBalance: number; totalLimit: number; overallUtilization: number; totalMinPayment: number; monthlyInterest: number }

const EMPTY = { owner: "Vladimir", issuer: "", name: "", creditLimit: "", currentBalance: "", apr: "", minPaymentPct: "2", minPaymentFixed: "35", statementDay: "", dueDay: "" };

export default function PersonalCardsPage() {
  const [cards, setCards] = useState<CC[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [payId, setPayId] = useState<string | null>(null);
  const [payAmt, setPayAmt] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/personal/cards").then((x) => x.json());
      setCards(r.cards ?? []); setTotals(r.totals ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addCard() {
    if (!form.issuer && !form.name) { setError("Enter an issuer or card name"); return; }
    setBusy("add"); setError(null);
    try {
      const r = await fetch("/api/personal/cards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setForm({ ...EMPTY }); setShowAdd(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  function startEdit(c: CC) {
    setEditId(c.id); setPayId(null);
    setEdit({ owner: c.owner ?? "", issuer: c.issuer, name: c.name ?? "", creditLimit: String(c.creditLimit || ""), currentBalance: String(c.currentBalance || ""), statementBalance: String(c.statementBalance || ""), apr: c.apr != null ? String(c.apr) : "", minPaymentPct: String(c.minPaymentPct || ""), minPaymentFixed: String(c.minPaymentFixed || ""), statementDay: c.statementDay != null ? String(c.statementDay) : "", dueDay: c.dueDay != null ? String(c.dueDay) : "" });
  }
  async function saveEdit(id: string) {
    setBusy("edit"); setError(null);
    try {
      const r = await fetch("/api/personal/cards", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...edit }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setEditId(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function del(id: string) {
    if (!confirm("Delete this card?")) return;
    setBusy("del"); setError(null);
    try { await fetch(`/api/personal/cards?id=${id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function pay(id: string) {
    const a = Number(payAmt);
    if (!Number.isFinite(a) || a <= 0) { setError("Enter a payment amount"); return; }
    setBusy("pay"); setError(null);
    try {
      const r = await fetch(`/api/personal/cards/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "payment", amount: a }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setPayId(null); setPayAmt(""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  const owners = [...new Set(cards.map((c) => c.owner ?? "—"))];

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-5">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/personal" className="mb-1 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" /> Personal Finance</Link>
          <h1 className="text-xl font-semibold text-ink">Credit cards</h1>
        </div>
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}><PlusCircle className="h-4 w-4" /> Add card</Button>
      </div>

      {error && <div className="rounded-md border border-warn-line bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">{error}</div>}

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Total balance" value={usd(totals?.totalBalance ?? 0)} />
        <Kpi label="Total limit" value={totals && totals.totalLimit > 0 ? usd(totals.totalLimit) : "—"} />
        <Kpi label="Utilization" value={totals && totals.totalLimit > 0 ? `${Math.round(totals.overallUtilization * 100)}%` : "—"} warn={!!totals && totals.totalLimit > 0 && totals.overallUtilization > 0.3} />
        <Kpi label="Minimums / mo" value={usd(totals?.totalMinPayment ?? 0)} />
        <Kpi label="Interest / mo" value={usd(totals?.monthlyInterest ?? 0)} />
      </div>

      {showAdd && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-[14px]">New card</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Owner"><select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]"><option>Vladimir</option><option>Anna</option></select></Field>
              <Field label="Issuer"><Input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="Chase" /></Field>
              <Field label="Card name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Freedom" /></Field>
              <Field label="Balance"><Input value={form.currentBalance} onChange={(e) => setForm({ ...form, currentBalance: e.target.value })} placeholder="0" inputMode="decimal" /></Field>
              <Field label="Credit limit"><Input value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} placeholder="0" inputMode="decimal" /></Field>
              <Field label="APR %"><Input value={form.apr} onChange={(e) => setForm({ ...form, apr: e.target.value })} placeholder="24.99" inputMode="decimal" /></Field>
              <Field label="Min %"><Input value={form.minPaymentPct} onChange={(e) => setForm({ ...form, minPaymentPct: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Min floor $"><Input value={form.minPaymentFixed} onChange={(e) => setForm({ ...form, minPaymentFixed: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Statement day"><Input value={form.statementDay} onChange={(e) => setForm({ ...form, statementDay: e.target.value })} placeholder="1-31" inputMode="numeric" /></Field>
              <Field label="Due day"><Input value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })} placeholder="1-31" inputMode="numeric" /></Field>
            </div>
            <Button size="sm" className="mt-3" onClick={addCard} disabled={!!busy}>{busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />} Save card</Button>
          </CardContent>
        </Card>
      )}

      {owners.map((owner) => (
        <Card key={owner}>
          <CardHeader className="pb-2"><CardTitle className="text-[14px]">{owner}</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <div className="hidden grid-cols-[1.6fr_1fr_1fr_0.8fr_0.8fr_0.7fr_auto] gap-2 px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-4 sm:grid">
              <span>Card</span><span className="text-right">Balance</span><span className="text-right">Limit</span><span className="text-right">Util</span><span className="text-right">Min</span><span className="text-right">Due</span><span />
            </div>
            {cards.filter((c) => (c.owner ?? "—") === owner).map((c) => (
              <div key={c.id} className="rounded-md border border-rule/60 px-2 py-2 sm:border-0 sm:py-0">
                <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1.6fr_1fr_1fr_0.8fr_0.8fr_0.7fr_auto] sm:py-1.5">
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-[13px] font-medium text-ink">{c.name || c.issuer}</div>
                    <div className="text-[11px] text-ink-4">{c.issuer}{c.apr ? ` · ${c.apr}% APR` : ""}</div>
                  </div>
                  <span className="text-right text-[13px] tabular text-ink">{usd(c.currentBalance)}</span>
                  <span className="text-right text-[13px] tabular text-ink-3">{c.creditLimit > 0 ? usd(c.creditLimit) : "—"}</span>
                  <span className={cn("text-right text-[13px] tabular", c.creditLimit > 0 && c.utilization > 0.3 ? "text-warn-strong" : "text-ink-3")}>{c.creditLimit > 0 ? `${Math.round(c.utilization * 100)}%` : "—"}</span>
                  <span className="text-right text-[13px] tabular text-ink-3">{usd(c.minPayment)}</span>
                  <span className="text-right text-[13px] tabular text-ink-3">{c.dueDay ?? "—"}</span>
                  <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
                    <button onClick={() => { setPayId(payId === c.id ? null : c.id); setPayAmt(String(c.minPayment || "")); setEditId(null); }} className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-green-ink" title="Pay"><DollarSign className="h-4 w-4" /></button>
                    <button onClick={() => startEdit(c)} className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-ink" title="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => del(c.id)} className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-warn-strong" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>

                {payId === c.id && (
                  <div className="flex flex-wrap items-end gap-2 border-t border-rule py-2">
                    <div className="w-28"><label className="mb-1 block text-[11px] text-ink-3">Pay amount</label><Input value={payAmt} onChange={(e) => setPayAmt(e.target.value)} inputMode="decimal" /></div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setPayAmt(String(c.minPayment || 0))}>Min</Button>
                      <Button size="sm" variant="ghost" onClick={() => setPayAmt(String(c.statementBalance || 0))}>Statement</Button>
                      <Button size="sm" variant="ghost" onClick={() => setPayAmt(String(c.currentBalance || 0))}>Full</Button>
                    </div>
                    <Button size="sm" onClick={() => pay(c.id)} disabled={!!busy}>{busy === "pay" ? <Loader2 className="h-4 w-4 animate-spin" /> : <DollarSign className="h-4 w-4" />} Pay</Button>
                    <span className="text-[11px] text-ink-4">Debits the Credit Cards fund.</span>
                  </div>
                )}

                {editId === c.id && (
                  <div className="border-t border-rule py-2">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                      <Field label="Balance"><Input value={edit.currentBalance} onChange={(e) => setEdit({ ...edit, currentBalance: e.target.value })} inputMode="decimal" /></Field>
                      <Field label="Statement"><Input value={edit.statementBalance} onChange={(e) => setEdit({ ...edit, statementBalance: e.target.value })} inputMode="decimal" /></Field>
                      <Field label="Limit"><Input value={edit.creditLimit} onChange={(e) => setEdit({ ...edit, creditLimit: e.target.value })} inputMode="decimal" /></Field>
                      <Field label="APR %"><Input value={edit.apr} onChange={(e) => setEdit({ ...edit, apr: e.target.value })} inputMode="decimal" /></Field>
                      <Field label="Min %"><Input value={edit.minPaymentPct} onChange={(e) => setEdit({ ...edit, minPaymentPct: e.target.value })} inputMode="decimal" /></Field>
                      <Field label="Statement day"><Input value={edit.statementDay} onChange={(e) => setEdit({ ...edit, statementDay: e.target.value })} inputMode="numeric" /></Field>
                      <Field label="Due day"><Input value={edit.dueDay} onChange={(e) => setEdit({ ...edit, dueDay: e.target.value })} inputMode="numeric" /></Field>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => saveEdit(c.id)} disabled={!!busy}>{busy === "edit" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-rule bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={cn("mt-0.5 text-[18px] font-semibold tabular", warn ? "text-warn-strong" : "text-ink")}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[11px] text-ink-3">{label}</label>{children}</div>;
}
