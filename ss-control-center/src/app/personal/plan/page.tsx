"use client";

/**
 * Payoff plan — avalanche (highest APR first) or snowball (smallest balance first)
 * over the registry's known balances, with a constant monthly budget. The math is
 * the pure `simulatePayoff` (src/lib/finance/payoff.ts): the same inputs always
 * give the same plan. It is a model only — nothing is paid from here.
 *
 * Included by default: known balances that are being paid, current, past due, in
 * collections or in a tax window. Excluded by default (toggle to include): disputes
 * (contested), court (the court sets the schedule), "needs check" (balance not
 * confirmed) and unknown balances.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Liability } from "@/lib/finance/registry";
import { simulatePayoff, type PayoffDebt, type Strategy } from "@/lib/finance/payoff";
import { AsOf, Kpi, OwnerTag, PersonalNav, StandingBadge, monthLabel, usd, usd2 } from "@/components/personal/registry-ui";

const EXCLUDE_REASON: Record<string, string> = {
  dispute: "Dispute — amount contested",
  court: "Court — the court sets the schedule",
  check: "Balance not confirmed",
};
interface PlanEvent { id: string; title: string; date: string; endDate: string | null; time: string | null; kind: string; amount: number | null; status: string; source: string | null; cardId: string | null; debtId: string | null }
const STORE = "personal:plan:v1";

function defaultExcluded(l: Liability): string | null {
  if (l.balance == null) return "Balance unknown";
  return EXCLUDE_REASON[l.standing] ?? null;
}

export default function PayoffPlanPage() {
  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [ls, setLs] = useState<Liability[] | null>(null);
  const [today, setToday] = useState<string>(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("avalanche");
  const [budget, setBudget] = useState<string>("");
  const [include, setInclude] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/personal/registry").then((x) => x.json());
      if (!r.liabilities) throw new Error(r.error ?? "failed to load");
      const rows: Liability[] = r.liabilities.filter((l: Liability) => l.counted && (l.balance == null || l.balance > 0));
      setLs(rows); setToday(r.today); setEvents((r.events ?? []).filter((e: PlanEvent) => !["done", "cancelled"].includes(e.status)));
      let saved: { strategy?: Strategy; budget?: string; include?: Record<string, boolean> } = {};
      try { saved = JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { /* storage unavailable */ }
      const inc: Record<string, boolean> = {};
      for (const l of rows) inc[l.id] = l.balance != null && (saved.include?.[l.id] ?? defaultExcluded(l) == null);
      setInclude(inc);
      if (saved.strategy === "avalanche" || saved.strategy === "snowball") setStrategy(saved.strategy);
      const mins = rows.filter((l) => inc[l.id]).reduce((s, l) => s + (l.monthlyPayment ?? 0), 0);
      setBudget(saved.budget ?? String(Math.ceil(mins / 50) * 50));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!ls) return;
    try { localStorage.setItem(STORE, JSON.stringify({ strategy, budget, include })); } catch { /* storage unavailable */ }
  }, [ls, strategy, budget, include]);

  const startYm = useMemo(() => {
    const [y, m] = today.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }, [today]);

  const debts: PayoffDebt[] = useMemo(() => (ls ?? []).filter((l) => include[l.id] && l.balance != null).map((l) => ({
    id: l.id, label: l.label, balance: l.balance!, apr: l.apr, minPayment: l.monthlyPayment,
    firstPayment: events.filter((e) => e.kind === "payment" && (e.cardId ?? e.debtId) === l.id && e.date.startsWith(startYm)).reduce((sum, e) => sum + (e.amount ?? 0), 0),
  })), [ls, include, events, startYm]);
  const b = Number.isFinite(Number(budget)) ? Math.max(0, Number(budget)) : 0;
  const plan = useMemo(() => simulatePayoff(debts, b, strategy, startYm), [debts, b, strategy, startYm]);
  const other = useMemo(() => simulatePayoff(debts, b, strategy === "avalanche" ? "snowball" : "avalanche", startYm), [debts, b, strategy, startYm]);
  const byId = new Map((ls ?? []).map((l) => [l.id, l]));
  const urgent = (ls ?? []).filter((l) => ["court", "past_due", "collections", "window"].includes(l.standing) || l.kind === "tax" && !!l.nextDueDate);
  const datedPriorities = events.filter((e) => e.date <= `${startYm}-31` || ["window", "mediation", "hearing"].includes(e.kind));
  const excluded = (ls ?? []).filter((l) => !include[l.id]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">Payoff plan</h1>
        <p className="text-[13px] text-ink-3">A model of paying everything off with one monthly budget. Minimums first, the rest to the top of the list. Nothing is paid from this page.</p>
      </div>
      <PersonalNav active="/personal/plan" />
      {error && <div className="rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-[13px] text-danger">{error}</div>}
      {!ls && !error && <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}

      {ls && (
        <>
          <Card className="border-warn/40">
            <CardHeader className="pb-2"><CardTitle className="text-[14px]">Address first — legal dates, arrears, collections and tax windows</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-[13px]">
              <p className="text-ink-3">These obligations take priority over either payoff strategy. The model below does not replace court schedules or decisions on disputed claims.</p>
              <div className="grid gap-2 sm:grid-cols-2">{urgent.map((l) => <div key={l.id} className="rounded border border-rule p-2">
                <div className="flex flex-wrap items-center gap-2"><StandingBadge standing={l.standing} /><span>{l.label}</span><OwnerTag owner={l.owner} /></div>
                <div className="mt-1 text-ink-3">Balance {l.balance == null ? "unknown" : usd2(l.balance)} · {l.nextDueDate ?? "Next date not set"}</div>
                {l.standingNote && <p className="text-[12px] text-ink-3">{l.standingNote}</p>}
                <AsOf asOf={l.balanceAsOf} source={l.balanceSource} />
              </div>)}</div>
              {datedPriorities.map((e) => <div key={e.id} className="border-t border-rule pt-2">
                <div className="flex flex-wrap gap-2"><b>{e.date}{e.endDate ? ` – ${e.endDate}` : ""} {e.time ?? ""}</b><span>{e.title}</span><b>{e.amount != null ? usd2(e.amount) : ["window", "mediation", "hearing", "deadline"].includes(e.kind) ? "Action / deadline" : "Amount not set"}</b><OwnerTag owner={byId.get(e.cardId ?? e.debtId ?? "")?.owner} /></div>
                <AsOf asOf={e.source?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]} source={e.source} />
              </div>)}
              <p className="text-[12px] text-ink-3">Dated full-payment commitments for included debts replace their minimum in the first model month. Other dates and unknown amounts still require separate funding in the 60-day calendar.</p>
            </CardContent>
          </Card>
          {/* Inputs — the two choices that drive the plan. */}
          <Card>
            <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-end">
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-3">Strategy</div>
                <div className="inline-flex flex-wrap rounded-md border border-rule p-0.5">
                  {(["avalanche", "snowball"] as Strategy[]).map((s) => (
                    <button key={s} onClick={() => setStrategy(s)} className={cn("rounded px-3 py-1.5 text-[13px]", strategy === s ? "bg-green text-white" : "text-ink-2 hover:bg-bg-elev")}>
                      {s === "avalanche" ? "Avalanche — highest APR first" : "Snowball — smallest balance first"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-48">
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-ink-3">Monthly budget</label>
                <Input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
              </div>
              <div className="text-[12px] text-ink-3">
                Known recurring minimums of the included debts: <span className="font-medium text-ink">{usd2(plan.minimumsTotal)}</span> / mo · first month {monthLabel(startYm)} requires {usd2(plan.firstMonthRequired)} including dated commitments
              </div>
            </CardContent>
          </Card>

          {!plan.feasible && (
            <div className="rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-[13px] text-danger">
              The budget does not cover the first month’s known minimums and dated commitments — shortfall {usd2(plan.shortfall)}.
            </div>
          )}
          {plan.commitmentAboveBalance > 0 && <div className="rounded-md border border-warn/40 bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">Dated commitments exceed recorded balances by {usd2(plan.commitmentAboveBalance)}. The model reserves the full cash commitment without increasing the recorded debt. Reconcile the statement and balance sources.</div>}
          {plan.aprUnknown.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">
              APR is not set for {plan.aprUnknown.length} of {debts.length} debts — their interest is not modeled; actual cost and payoff dates may differ{strategy === "avalanche" ? ", and avalanche puts them last" : ""}. Add APRs on the Obligations page.
            </div>
          )}
          {plan.minimumUnknown.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn-tint px-3 py-2 text-[13px] text-warn-strong">
              Minimum payments are not set for {plan.minimumUnknown.length} included debts. This scenario reserves only known minimums; it cannot confirm that your budget covers every required payment. Add the missing payments on the Obligations page.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Modeled payoff" value={debts.length === 0 ? "No debts selected" : plan.feasible ? (plan.debtFreeDate ? monthLabel(plan.debtFreeDate) : "not within 50 years") : "—"} hint={plan.months ? `${plan.months} months · selected debts only` : undefined} tone="green" />
            <Kpi label="Interest (modeled)" value={plan.feasible ? usd(plan.totalInterest) : "—"} hint="only debts with an APR" />
            <Kpi label="Total paid" value={plan.feasible ? usd(plan.totalPaid) : "—"} hint={`${debts.length} debts · ${usd(debts.reduce((s, d) => s + d.balance, 0))} now`} />
            <Kpi label={other.strategy === "avalanche" ? "Avalanche instead" : "Snowball instead"}
              value={other.feasible && other.months ? `${other.months} mo · ${usd(other.totalInterest)}` : "—"}
              hint={other.feasible && plan.feasible && other.months && plan.months ? `${other.totalInterest - plan.totalInterest >= 0 ? "+" : ""}${usd(other.totalInterest - plan.totalInterest)} interest` : undefined} />
          </div>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-[14px]">Order — {strategy === "avalanche" ? "highest APR first" : "smallest balance first"}</CardTitle></CardHeader>
            <CardContent className="space-y-0.5">
              <div className="hidden grid-cols-[1.5rem_2fr_0.8fr_1fr_0.6fr_0.8fr_0.9fr_0.8fr] gap-2 px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-4 md:grid">
                <span /><span>Obligation</span><span>Owner</span><span className="text-right">Balance</span><span className="text-right">APR</span><span className="text-right">Min / mo</span><span className="text-right">Paid off</span><span className="text-right">Interest</span>
              </div>
              {plan.order.map((p, i) => {
                const l = byId.get(p.id);
                return (
                  <div key={p.id} className="grid grid-cols-2 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-elev md:grid-cols-[1.5rem_2fr_0.8fr_1fr_0.6fr_0.8fr_0.9fr_0.8fr]">
                    <input type="checkbox" checked onChange={() => setInclude((s) => ({ ...s, [p.id]: false }))} title="Exclude from the plan" />
                    <div className="min-w-0 text-[13px] text-ink"><div className="flex flex-wrap items-center gap-2"><span className="text-ink-4">{i + 1}.</span> {p.label} {l && <StandingBadge standing={l.standing} />}</div>{l && <AsOf asOf={l.balanceAsOf} source={l.balanceSource} />}</div>
                    <OwnerTag owner={l?.owner} />
                    <span className="text-right text-[13px] tabular text-ink">{usd2(p.startBalance)}</span>
                    <span className={cn("text-right text-[13px] tabular", p.apr == null ? "text-ink-4" : "text-ink-2")}>{p.apr != null ? `${p.apr}%` : "not set"}</span>
                    <span className={cn("text-right text-[13px] tabular", p.minPayment != null ? "text-ink-2" : "text-ink-4")}>{p.minPayment != null ? usd2(p.minPayment) : "not set"}</span>
                    <span className="text-right text-[13px] tabular text-ink">{p.payoffDate ? monthLabel(p.payoffDate) : "—"}</span>
                    <span className="text-right text-[13px] tabular text-ink-3">{p.apr != null ? usd2(p.interestPaid) : "—"}</span>
                  </div>
                );
              })}
              {plan.order.length === 0 && <p className="py-4 text-center text-[13px] text-ink-3">Nothing included — tick a debt below.</p>}
            </CardContent>
          </Card>

          {excluded.length > 0 && (
            <Card className="border-dashed">
              <CardHeader className="pb-1"><CardTitle className="text-[14px] text-ink-2">Not in the plan · {excluded.length}</CardTitle></CardHeader>
              <CardContent className="space-y-0.5">
                {excluded.map((l) => (
                  <label key={l.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-elev", l.balance == null && "opacity-60")}>
                    <input type="checkbox" checked={false} disabled={l.balance == null} onChange={() => setInclude((s) => ({ ...s, [l.id]: true }))} />
                    <span className="flex-1 text-ink-2">{l.label} <StandingBadge standing={l.standing} className="ml-1" /></span>
                    <span className="text-[12px] text-ink-4">{defaultExcluded(l) ?? "Excluded by you"}</span>
                    <span className="w-28 text-right tabular text-ink-3">{l.balance == null ? "unknown" : usd2(l.balance)}</span>
                  </label>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
