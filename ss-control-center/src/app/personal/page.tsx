"use client";

/**
 * Personal Finance — Vladimir's private pool. Same envelope engine as the business
 * Financial Plan (scope=personal), but money in = personal income (owner's draw from
 * the business + manual), and the centre of gravity is credit cards + bills.
 *
 * Waterfall: income → FP1 obligatory envelopes (bills + card minimums) → FP2 goals
 * → Free. NO reserve (taxes are reserved in the business pool — one owner, one tax).
 *
 * Phase 2 (2026-10-27): the headline is the obligations registry — net worth, what
 * is owed, what is already late, and a 60-day payment calendar with every court
 * date, tax window and minimum (see /personal/obligations, /plan, /net-worth).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Play, CheckCircle2, Wand2, PlusCircle, CalendarClock, CreditCard, ArrowRightLeft, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { NetWorth, RegistryAlert, RegistryTotals } from "@/lib/finance/registry";
import type { CardTotals } from "@/lib/finance/cards";
import type { CalEntry } from "@/lib/finance/calendar";
import type { OverduePayment, UndatedPayment } from "@/lib/finance/personal-calendar";
import { AlertsPanel, AsOf, Kpi as RegKpi, PersonalNav, StandingBadge } from "@/components/personal/registry-ui";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usd2 = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${Math.round(r * 100)}%`;
const dateLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

interface Fund { id: string; name: string; group: string; allocationType: string; value: number; priority: number; balance: number; active: boolean }
interface Cal { entries: CalEntry[]; overdue: OverduePayment[]; undated: UndatedPayment[]; totalDue: number; unknownCount: number; windowDays: number }
interface Reg { netWorth: NetWorth; totals: RegistryTotals; alerts: RegistryAlert[] }
interface Income { id: string; depositDate: string | null; netAmount: number; distributed: boolean; source: string }
interface AllocationLine { fundId: string; name: string; group: string; amount: number }
interface RunResult { preview: boolean; distribution: { totalIn: number; distributable: number; allocations: AllocationLine[]; free: number }; payoutCount: number }

const KIND_DOT: Record<string, string> = { card: "bg-[#6B5A8C]", bill: "bg-[#3F6FA0]", loan: "bg-[#B8901F]", event: "bg-danger" };
const FREQ: Record<string, string> = { monthly: "every month", biweekly: "every 2 weeks", weekly: "every week", daily: "every day" };

async function readJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load personal finance (${response.status})`);
  return response.json();
}

export default function PersonalFinancePage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [needs, setNeeds] = useState<Record<string, number>>({});
  const [income, setIncome] = useState<{ incomes: Income[]; totals: { undistributedNet: number; totalNet: number } } | null>(null);
  const [cardT, setCardT] = useState<CardTotals | null>(null);
  const [cal, setCal] = useState<Cal | null>(null);
  const [reg, setReg] = useState<Reg | null>(null);
  const [bizFunds, setBizFunds] = useState<Fund[]>([]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [amt, setAmt] = useState("");
  const [label, setLabel] = useState("");
  const [drawFund, setDrawFund] = useState("");
  const incomeRequest = useRef<{ payload: string; id: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, n, inc, c, cl, bf, rg] = await Promise.all([
        readJson("/api/finance/funds/history?days=30&scope=personal"),
        readJson("/api/finance/funds/needs?scope=personal"),
        readJson("/api/personal/income"),
        readJson("/api/personal/cards"),
        readJson("/api/personal/calendar?window=60"),
        readJson("/api/finance/funds"),
        readJson("/api/personal/registry"),
      ]);
      setFunds(h.funds ?? []); setNeeds(n.needs ?? {});
      setIncome(inc); setCardT(c.totals ?? null); setCal(cl); setReg(rg.netWorth ? rg : null);
      setBizFunds((bf.funds ?? []).filter((f: Fund) => f.group === "FREE" && f.active));
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
      const r = await fetch("/api/personal/income", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestId: (() => {
        const payload = JSON.stringify(body);
        if (incomeRequest.current?.payload !== payload) incomeRequest.current = { payload, id: crypto.randomUUID() };
        return incomeRequest.current.id;
      })() }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      incomeRequest.current = null;
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
        <p className="text-[13px] text-ink-3">Your private pool — what you own, what you owe, and what is due next. Funded by personal income and the business FREE share.</p>
      </div>
      <PersonalNav active="/personal" />

      {error && <div className="rounded-md border border-warn-line bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">{error}</div>}
      {note && <div className="rounded-md border border-rule bg-green-soft px-3 py-2 text-[13px] text-green-ink">{note}</div>}

      {reg && <AlertsPanel alerts={reg.alerts} />}

      {/* Registry headline — every number links to its detail. */}
      {reg && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <RegKpi label="Net worth (known)" value={usd(reg.netWorth.net)} tone={reg.netWorth.net < 0 ? "danger" : "green"} hint={`assets ${usd(reg.netWorth.assets)} − owed ${usd(reg.netWorth.liabilities)}`} href="/personal/net-worth" />
          <RegKpi label="Total owed (known)" value={usd(reg.totals.all.total)} hint={`${reg.totals.all.count} obligations · ${reg.totals.all.unknown} balance unknown`} href="/personal/obligations" />
          <RegKpi label="Late now" value={String(cal?.overdue?.length ?? 0)} tone={(cal?.overdue?.length ?? 0) > 0 ? "danger" : undefined} hint={`court ${reg.totals.byStanding.court?.count ?? 0} · collections ${reg.totals.byStanding.collections?.count ?? 0} · dispute ${reg.totals.byStanding.dispute?.count ?? 0}`} href="/personal/obligations?status=past_due" />
          <RegKpi label={`Scheduled next ${cal?.windowDays ?? 60} days`} value={usd(cal?.totalDue ?? 0)} hint={`${cal?.unknownCount ?? 0} amounts not set · excludes undated payments`} href="#payment-calendar" />
        </div>
      )}

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
        <Kpi label="Envelopes need" value={usd(monthlyObligations)} hint="bills + installments + card minimums owed" />
        <Link href="/personal/cards"><Kpi label="Card debt" value={usd(cardT?.totalBalance ?? 0)} hint={`${cardT?.count ?? 0} cards · tap to manage`} accent /></Link>
        <Link href="/personal/cards"><Kpi label="Card utilization" value={cardT && cardT.totalLimit > 0 ? pct(cardT.overallUtilization) : "—"} hint={cardT && cardT.totalLimit > 0 ? `known limits only · ${cardT.limitsUnknown} not set` : "add limits to compute"} accent /></Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Payment calendar — late items first, then the next 60 days. */}
        <Card id="payment-calendar">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]"><CalendarClock className="h-4 w-4 text-ink-3" /> Payment calendar</CardTitle>
            <span className="text-[12px] text-ink-3">next {cal?.windowDays ?? 60} days · {usd(cal?.totalDue ?? 0)}{cal?.unknownCount ? ` + ${cal.unknownCount} not set` : ""}</span>
          </CardHeader>
          <CardContent className="max-h-[560px] space-y-1 overflow-y-auto">
            {(cal?.overdue?.length ?? 0) > 0 && (
              <div className="mb-2 rounded-md border border-danger/30 bg-danger-tint/60 p-1.5">
                <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-danger"><AlertTriangle className="h-3.5 w-3.5" /> Late now · {cal!.overdue.length}</div>
                {cal!.overdue.map((o) => (
                  <Link key={o.refId} href={o.kind === "event" ? "/personal/obligations" : `/personal/obligations#${o.refId}`} className="block rounded px-1.5 py-1 hover:bg-danger-tint">
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 font-mono text-[11px] text-danger">{o.since ? `since ${dateLabel(o.since)}` : ""}</span>
                      <span className="flex-1 truncate text-[13px] font-medium text-ink">{o.label}{o.owner ? <span className="ml-1 font-normal text-ink-4">· {o.owner}</span> : null}</span>
                      <span className="tabular text-[13px] text-ink">{o.amount != null ? usd2(o.amount) : "amount not set"}</span>
                    </div>
                    <div className="pl-16 text-[11px] text-ink-3">{o.reason}</div>
                    <AsOf asOf={o.amountAsOf} source={o.amountSource} className="pl-16" />
                  </Link>
                ))}
              </div>
            )}
            {(cal?.entries ?? []).length === 0 && <p className="py-6 text-center text-[13px] text-ink-3">No due dates set. Add a due day to bills and cards.</p>}
            {(cal?.entries ?? []).map((e, i) => (
              <div key={i} className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg-elev",
                e.standing === "past_due" && "bg-danger-tint/50", e.eventKind === "window" && "bg-info-tint/60")}>
                <span className="w-12 shrink-0 font-mono text-[11px] text-ink-3">{dateLabel(e.date)}</span>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[e.kind])} />
                <div className="min-w-0 flex-1 break-words text-[13px] text-ink-2">
                  {e.label}
                  {e.time ? <span className="ml-1 text-ink-4">{e.time}</span> : null}
                  {e.endDate ? <span className="ml-1 text-info">open until {dateLabel(e.endDate)}</span> : null}
                  {e.owner ? <span className="ml-1 text-ink-4">· {e.owner}</span> : null}
                  <AsOf asOf={e.amountAsOf} source={e.amountSource} />
                </div>
                {e.standing && e.standing !== "current" && e.standing !== "paying" ? <StandingBadge standing={e.standing} /> : null}
                <span className={cn("tabular text-[13px] font-medium", e.amount == null ? "text-ink-4" : "text-ink")}>{e.amount != null ? usd2(e.amount) : "not set"}</span>
              </div>
            ))}
            {(cal?.undated?.length ?? 0) > 0 && (
              <div className="mt-2 border-t border-rule pt-2">
                <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-4">Recurring, date not fixed</div>
                {cal!.undated.map((u) => (
                  <div key={u.refId} className="flex items-center gap-2.5 px-2 py-1 text-[13px]">
                    <div className="min-w-0 flex-1 text-ink-2">{u.label}{u.owner ? <span className="ml-1 text-ink-4">· {u.owner}</span> : null}<AsOf asOf={u.amountAsOf} source={u.amountSource} />{u.note && <p className="text-[11px] text-ink-4">{u.note}</p>}</div>
                    <span className="tabular text-ink">{usd2(u.amount)} <span className="text-ink-4">{FREQ[u.frequency] ?? u.frequency}</span></span>
                  </div>
                ))}
              </div>
            )}
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
                    <div className="text-[12px] text-ink-3">{cardT?.count ?? 0} cards · known min/mo {usd(cardT?.totalMinPayment ?? 0)} · modeled interest/mo {usd(cardT?.monthlyInterest ?? 0)}</div>
                  </div>
                </div>
                <span className="text-[13px] font-medium text-ink tabular">{usd(cardT?.totalBalance ?? 0)}</span>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>

      <p className="text-[12px] text-ink-3">Business payouts → direct costs → business funds → FREE share → personal income → envelopes. <Link href="/finance" className="underline">Configure the FREE share in Financial Plan</Link>.</p>

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
              <label className="mb-1 block text-[11px] text-ink-3">Owner draw — take from business FREE</label>
              <select value={drawFund} onChange={(e) => setDrawFund(e.target.value)} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px] text-ink">
                <option value="">Select FREE fund…</option>
                {bizFunds.map((f) => <option key={f.id} value={f.id}>{f.name} — {usd(f.balance)}</option>)}
              </select>
            </div>
            <Button size="sm" variant="outline" onClick={() => addIncome("draw")} disabled={!!busy}>
              {busy === "draw" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Draw to personal
            </Button>
          </div>
          <p className="text-[11px] text-ink-4">A draw debits available business FREE and records the same personal income atomically. The automatic share of new FREE is configured in Financial Plan.</p>
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
