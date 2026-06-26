"use client";

/**
 * Personal Finance — Vladimir's private pool. Same envelope engine as the business
 * Financial Plan (scope=personal), but money in = personal income (owner's draw from
 * the business + manual), and the centre of gravity is credit cards + bills.
 *
 * Waterfall: income → FP1 obligatory envelopes (bills + card minimums) → FP2 goals
 * → Free. NO reserve (taxes are reserved in the business pool — one owner, one tax).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Play, CheckCircle2, Wand2, PlusCircle, CalendarClock, CreditCard, ArrowRightLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usd2 = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${Math.round(r * 100)}%`;
const dateLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

interface Fund { id: string; name: string; group: string; allocationType: string; value: number; priority: number; balance: number; active: boolean }
interface CalEntry { date: string; day: number; kind: "card" | "bill" | "loan"; label: string; owner: string | null; amount: number }
interface Income { id: string; depositDate: string | null; netAmount: number; distributed: boolean; source: string }
interface CardTotals { count: number; totalBalance: number; totalLimit: number; overallUtilization: number; totalMinPayment: number; monthlyInterest: number }
interface AllocationLine { fundId: string; name: string; group: string; amount: number }
interface RunResult { preview: boolean; distribution: { totalIn: number; distributable: number; allocations: AllocationLine[]; free: number }; payoutCount: number }

const KIND_DOT: Record<string, string> = { card: "bg-[#6B5A8C]", bill: "bg-[#3F6FA0]", loan: "bg-[#B8901F]" };

export default function PersonalFinancePage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [needs, setNeeds] = useState<Record<string, number>>({});
  const [income, setIncome] = useState<{ incomes: Income[]; totals: { undistributedNet: number; totalNet: number } } | null>(null);
  const [cardT, setCardT] = useState<CardTotals | null>(null);
  const [cal, setCal] = useState<{ entries: CalEntry[]; totalDue: number; windowDays: number } | null>(null);
  const [bizFunds, setBizFunds] = useState<Fund[]>([]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [amt, setAmt] = useState("");
  const [label, setLabel] = useState("");
  const [drawFund, setDrawFund] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, n, inc, c, cl, bf] = await Promise.all([
        fetch("/api/finance/funds/history?days=30&scope=personal").then((r) => r.json()),
        fetch("/api/finance/funds/needs?scope=personal").then((r) => r.json()),
        fetch("/api/personal/income").then((r) => r.json()),
        fetch("/api/personal/cards").then((r) => r.json()),
        fetch("/api/personal/calendar?window=45").then((r) => r.json()),
        fetch("/api/finance/funds").then((r) => r.json()),
      ]);
      setFunds(h.funds ?? []); setNeeds(n.needs ?? {});
      setIncome(inc); setCardT(c.totals ?? null); setCal(cl);
      setBizFunds((bf.funds ?? []).filter((f: Fund) => f.group !== "FREE" && f.group !== "RESERVE"));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const undistributed = income?.totals.undistributedNet ?? 0;
  const monthlyObligations = funds.filter((f) => f.group === "FP1").reduce((s, f) => s + (needs[f.name] ?? 0), 0);

  async function addIncome(action: "manual" | "draw") {
    const a = Number(amt);
    if (!Number.isFinite(a) || a <= 0) { setError("Enter an amount"); return; }
    if (action === "draw" && !drawFund) { setError("Pick a business fund to draw from"); return; }
    setBusy(action); setError(null); setNote(null);
    try {
      const body = action === "draw" ? { action, amount: a, fromFundId: drawFund, note: label } : { action, amount: a, note: label };
      const r = await fetch("/api/personal/income", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setAmt(""); setLabel(""); setDrawFund("");
      setNote(action === "draw" ? `Drew ${usd2(a)} from the business → personal income.` : `Added ${usd2(a)} personal income.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function autoAllocate() {
    setBusy("auto"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/funds/auto-allocate?scope=personal", { method: "POST" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      setNote(`Envelope %s set from each fund's monthly need (${usd(r.totalMonthlyNeed ?? 0)}/mo).`);
      await load();
      await doRun(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function doRun(preview: boolean) {
    setBusy(preview ? "preview" : "commit"); setError(null); if (!preview) setNote(null);
    try {
      const r = await fetch("/api/finance/run?scope=personal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "run failed");
      setRun(r);
      if (!preview) { setNote("Income distributed into the envelopes."); setRun(null); await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">Personal Finance</h1>
        <p className="text-[13px] text-ink-3">Your private pool — income, bills, and credit cards. Separate from the business Financial Plan.</p>
      </div>

      {error && <div className="rounded-md border border-warn-line bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">{error}</div>}
      {note && <div className="rounded-md border border-rule bg-green-soft px-3 py-2 text-[13px] text-green-ink">{note}</div>}

      {/* Primary action band — lead with one clear next step. */}
      <Card className="border-green-line/40 bg-green-soft/40">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] font-medium text-ink">
              {undistributed > 0 ? `${usd2(undistributed)} of income is waiting to be distributed` : "No income waiting — add income below to fund your envelopes"}
            </div>
            <div className="text-[12px] text-ink-3">Income flows into your obligatory envelopes (bills + card minimums) first, then goals, then Free.</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={autoAllocate} disabled={!!busy}>
              {busy === "auto" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Auto-set %
            </Button>
            <Button size="sm" onClick={() => doRun(true)} disabled={!!busy || undistributed <= 0}>
              {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Distribute
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Preview of the distribution waterfall, with a Confirm. */}
      {run?.preview && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-[14px]">Distribution preview — {usd2(run.distribution.totalIn)} in</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {run.distribution.allocations.filter((a) => a.amount > 0).map((a) => (
              <div key={a.fundId} className="flex items-center justify-between text-[13px]">
                <span className="text-ink-2">{a.name} <span className="text-ink-4">· {a.group}</span></span>
                <span className="tabular font-medium text-ink">{usd2(a.amount)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-rule pt-1.5 text-[13px]">
              <span className="text-ink-3">Free / unallocated</span><span className="tabular text-ink-2">{usd2(run.distribution.free)}</span>
            </div>
            <Button size="sm" className="mt-2" onClick={() => doRun(false)} disabled={!!busy}>
              {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirm distribution
            </Button>
          </CardContent>
        </Card>
      )}

      {/* KPI row — every number links to its detail. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Income to distribute" value={usd2(undistributed)} hint={`${usd(income?.totals.totalNet ?? 0)} total recorded`} />
        <Kpi label="Monthly obligations" value={usd(monthlyObligations)} hint="bills + card minimums owed" />
        <Link href="/personal/cards"><Kpi label="Card debt" value={usd(cardT?.totalBalance ?? 0)} hint={`${cardT?.count ?? 0} cards · tap to manage`} accent /></Link>
        <Link href="/personal/cards"><Kpi label="Card utilization" value={cardT && cardT.totalLimit > 0 ? pct(cardT.overallUtilization) : "—"} hint={cardT && cardT.totalLimit > 0 ? "of total limit" : "add limits to compute"} accent /></Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Payment calendar — the headline. */}
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]"><CalendarClock className="h-4 w-4 text-ink-3" /> Payment calendar</CardTitle>
            <span className="text-[12px] text-ink-3">next {cal?.windowDays ?? 45} days · {usd(cal?.totalDue ?? 0)}</span>
          </CardHeader>
          <CardContent className="max-h-[420px] space-y-1 overflow-y-auto">
            {(cal?.entries ?? []).length === 0 && <p className="py-6 text-center text-[13px] text-ink-3">No due dates set. Add a due day to bills and cards.</p>}
            {(cal?.entries ?? []).map((e, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg-elev">
                <span className="w-12 shrink-0 text-[11px] font-mono text-ink-3">{dateLabel(e.date)}</span>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[e.kind])} />
                <span className="flex-1 truncate text-[13px] text-ink-2">{e.label}{e.owner ? <span className="ml-1 text-ink-4">· {e.owner}</span> : null}</span>
                <span className="tabular text-[13px] font-medium text-ink">{usd2(e.amount)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* Envelopes. */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-[14px]">Envelopes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <FundGroup title="Obligatory (FP1)" funds={funds.filter((f) => f.group === "FP1")} needs={needs} />
              {funds.some((f) => f.group === "FP2") && <FundGroup title="Goals (FP2)" funds={funds.filter((f) => f.group === "FP2")} needs={needs} />}
              {funds.some((f) => f.group === "FREE") && <FundGroup title="Free" funds={funds.filter((f) => f.group === "FREE")} needs={needs} />}
            </CardContent>
          </Card>

          {/* Cards summary → manage. */}
          <Link href="/personal/cards" className="block">
            <Card className="transition-colors hover:border-ink-4/30">
              <CardContent className="flex items-center justify-between py-3.5">
                <div className="flex items-center gap-2.5">
                  <CreditCard className="h-5 w-5 text-[#6B5A8C]" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">Credit cards</div>
                    <div className="text-[12px] text-ink-3">{cardT?.count ?? 0} cards · min/mo {usd(cardT?.totalMinPayment ?? 0)} · interest/mo {usd(cardT?.monthlyInterest ?? 0)}</div>
                  </div>
                </div>
                <span className="text-[13px] font-medium text-ink tabular">{usd(cardT?.totalBalance ?? 0)}</span>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>

      {/* Income entry — manual + owner draw bridge. */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-[14px]">Add income</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-32"><label className="mb-1 block text-[11px] text-ink-3">Amount</label><Input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" inputMode="decimal" /></div>
            <div className="min-w-[160px] flex-1"><label className="mb-1 block text-[11px] text-ink-3">Note (optional)</label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. paycheck, Anna salary" /></div>
            <Button size="sm" variant="outline" onClick={() => addIncome("manual")} disabled={!!busy}>
              {busy === "manual" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />} Add income
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t border-rule pt-3">
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-[11px] text-ink-3">Owner draw — take from a business fund</label>
              <select value={drawFund} onChange={(e) => setDrawFund(e.target.value)} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px] text-ink">
                <option value="">Select business fund…</option>
                {bizFunds.map((f) => <option key={f.id} value={f.id}>{f.name} — {usd(f.balance)}</option>)}
              </select>
            </div>
            <Button size="sm" variant="outline" onClick={() => addIncome("draw")} disabled={!!busy}>
              {busy === "draw" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Draw to personal
            </Button>
          </div>
          <p className="text-[11px] text-ink-4">A draw debits the chosen business fund and records the same amount as personal income, in one step.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-rule bg-surface px-3.5 py-3", accent && "transition-colors hover:border-ink-4/40")}>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular text-ink">{value}</div>
      {hint && <div className="text-[11px] text-ink-4">{hint}</div>}
    </div>
  );
}

function FundGroup({ title, funds, needs }: { title: string; funds: Fund[]; needs: Record<string, number> }) {
  if (funds.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-mono uppercase tracking-wider text-ink-3">{title}</div>
      <div className="space-y-1.5">
        {funds.map((f) => {
          const need = needs[f.name] ?? 0;
          const ratio = need > 0 ? Math.min(1, Math.max(0, f.balance) / need) : f.balance > 0 ? 1 : 0;
          return (
            <Link key={f.id} href={`/finance/funds/${f.id}`} className="block rounded-md px-2 py-1.5 hover:bg-bg-elev">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink-2">{f.name}</span>
                <span className="tabular text-ink"><span className={cn(f.balance < 0 && "text-warn-strong")}>{usd2(f.balance)}</span>{need > 0 && <span className="text-ink-4"> / {usd(need)}</span>}</span>
              </div>
              {need > 0 && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-elev">
                  <div className={cn("h-full rounded-full", ratio >= 1 ? "bg-green" : "bg-[#B8901F]")} style={{ width: `${ratio * 100}%` }} />
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
