"use client";

/**
 * Financial Plan (FP) — two tabs:
 *   • Income — money in (payout + Net Proceeds breakdown) AND distribution of the
 *     new payout into funds (reserve restock → waterfall → commit).
 *   • Funds  — every fund with its balance + a 30-day mini balance chart, plus the
 *     grand total across all funds. Click a fund for its ledger / bills.
 * Cash basis, one global pool.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Play, CheckCircle2, AlertCircle, Settings2, FileText, Receipt, Wand2, PlusCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BUCKET_META, BUCKET_ORDER, type Bucket } from "@/lib/finance/settlement";
import { ReceiptScanner } from "@/components/finance/ReceiptScanner";

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund { id: string; name: string; group: string; allocationType: string; value: number; priority: number; balance: number; active: boolean; series: number[] }
interface PayoutLine { bucket: string; amount: number; count: number }
interface Payout { id: string; marketplace: string; entity: string | null; periodStart: string | null; periodEnd: string | null; depositDate: string | null; netAmount: number; distributed: boolean; lines: PayoutLine[] }
interface AllocationLine { fundId: string; name: string; group: string; amount: number }
interface RunResult { preview: boolean; distribution: { totalIn: number; reserve: number; reserveRate: number; distributable: number; allocations: AllocationLine[]; free: number }; reserveFellBack: boolean; payoutCount: number }

export default function FinancialPlanPage() {
  const [tab, setTab] = useState<"income" | "funds">("income");
  const [funds, setFunds] = useState<Fund[]>([]);
  const [fundsTotal, setFundsTotal] = useState(0);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [config, setConfig] = useState<{ method: string; manualPct: number; windowWeeks: number } | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pulled, setPulled] = useState<{ marketplace: string; period: string | null; net: number }[]>([]);
  const [manualAmt, setManualAmt] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [scope, setScope] = useState<"pending" | "all">("pending");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, p, c] = await Promise.all([
        fetch("/api/finance/funds/history?days=30").then((r) => r.json()),
        fetch("/api/finance/payouts").then((r) => r.json()),
        fetch("/api/finance/config").then((r) => r.json()),
      ]);
      setFunds(h.funds ?? []); setFundsTotal(h.total ?? 0);
      setPayouts(p.payouts ?? []); setConfig(c);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function getReport() {
    setBusy("report"); setError(null); setNote(null); setPulled([]);
    try {
      const r = await fetch("/api/finance/payouts?ingest=1", { method: "POST" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "Get Report failed");
      const periods = (r.results ?? []).flatMap((x: { marketplace: string; periods: { period: string | null; net: number }[] }) => x.periods.map((p) => ({ marketplace: x.marketplace, period: p.period, net: p.net })));
      const created = (r.results ?? []).reduce((s: number, x: { created: number }) => s + x.created, 0);
      setPulled(periods);
      setNote(created === 0 ? "Get Report: no new closed periods (already up to date)." : `Get Report: ${created} new closed period(s) pulled.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function addManualPayout() {
    const amt = Number(manualAmt);
    if (!Number.isFinite(amt) || amt === 0) { setError("Enter a payout amount"); return; }
    setBusy("manual"); setError(null);
    try {
      const r = await fetch("/api/finance/payouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ netAmount: amt, entity: manualLabel.trim() || "Manual income", note: manualLabel.trim() }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "add failed");
      setManualAmt(""); setManualLabel(""); setNote(`Manual income ${usd(amt)} added — distribute it below.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function autoAllocate() {
    setBusy("auto"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/funds/auto-allocate", { method: "POST" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      const parts = (r.allocations ?? []).filter((a: { pct: number }) => a.pct > 0).map((a: { fund: string; pct: number }) => `${a.fund} ${a.pct}%`).join(", ");
      setNote(`Fund % set from monthly needs (total $${r.totalMonthlyNeed}/mo): ${parts}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function doRun(preview: boolean) {
    setBusy(preview ? "preview" : "commit"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "run failed");
      setRun(r);
      if (!preview) { setNote("Distribution committed — funds updated."); await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function saveConfig(next: Partial<{ manualPct: number }>) {
    if (!config) return;
    setConfig({ ...config, ...next });
    await fetch("/api/finance/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
  }

  const scoped = scope === "pending" ? payouts.filter((p) => !p.distributed) : payouts;
  const breakdown = new Map<string, number>();
  for (const p of scoped) for (const l of p.lines) breakdown.set(l.bucket, (breakdown.get(l.bucket) ?? 0) + l.amount);
  const statementRows = BUCKET_ORDER.map((b) => ({ bucket: b as Bucket, amount: Math.round((breakdown.get(b) ?? 0) * 100) / 100 })).filter((r) => Math.abs(r.amount) > 0.005);
  const income = statementRows.filter((r) => BUCKET_META[r.bucket].nature === "income");
  const costs = statementRows.filter((r) => BUCKET_META[r.bucket].nature === "cost");
  const neutral = statementRows.filter((r) => ["wash", "timing", "mixed"].includes(BUCKET_META[r.bucket].nature));
  const netProceeds = Math.round(scoped.reduce((s, p) => s + p.netAmount, 0) * 100) / 100;
  const maxAbs = Math.max(1, ...statementRows.map((r) => Math.abs(r.amount)));
  const pendingNet = Math.round(payouts.filter((p) => !p.distributed).reduce((s, p) => s + p.netAmount, 0) * 100) / 100;

  const latestByAccount = new Map<string, Payout>();
  for (const p of [...payouts].sort((a, b) => (a.periodEnd ?? "").localeCompare(b.periodEnd ?? ""))) latestByAccount.set(`${p.marketplace}:${p.entity ?? ""}`, p);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Financial Plan</h1>
          <p className="text-sm text-muted-foreground">Cash basis, one global pool. Money in → distribute into funds → pay bills from funds.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={getReport} disabled={busy != null}>{busy === "report" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}Get Report</Button>
          <Link href="/finance/expenses"><Button variant="outline" size="sm"><Receipt className="mr-1 h-4 w-4" />Expense items</Button></Link>
          <Link href="/finance/funds"><Button variant="outline" size="sm"><Settings2 className="mr-1 h-4 w-4" />Manage funds</Button></Link>
          <Button onClick={load} variant="outline" size="sm"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {([["income", "Income & distribution"], ["funds", "Funds"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cn("border-b-2 px-4 py-2 text-sm font-medium", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}
      {note && (
        <Card className="border-emerald-500"><CardContent className="py-3 text-sm">
          <div className="flex items-center gap-2 text-emerald-600"><CheckCircle2 className="h-4 w-4" />{note}</div>
          {pulled.length > 0 && <ul className="mt-2 space-y-0.5 text-muted-foreground">{pulled.map((p, i) => (<li key={i} className="capitalize">• {p.marketplace} — period {p.period ?? "—"} — payout <b className="text-foreground">{usd(p.net)}</b></li>))}</ul>}
        </CardContent></Card>
      )}

      {tab === "income" && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Kpi label="To distribute" value={usd(pendingNet)} accent={pendingNet >= 0 ? "pos" : "neg"} />
            <Kpi label="Payouts waiting" value={String(payouts.filter((p) => !p.distributed).length)} />
            <Kpi label="Periods pulled" value={String(payouts.length)} />
            <Kpi label="Reserve %" value={config ? `${Math.round(config.manualPct * 100)}%` : "—"} />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Add income manually</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-2">
                <div><label className="block text-xs text-muted-foreground">Amount $</label><Input type="number" className="w-32" value={manualAmt} onChange={(e) => setManualAmt(e.target.value)} placeholder="0.00" /></div>
                <div className="flex-1"><label className="block text-xs text-muted-foreground">Label (optional)</label><Input value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} placeholder="e.g. Leftover from previous payouts" /></div>
                <Button onClick={addManualPayout} disabled={busy != null}>{busy === "manual" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-1 h-4 w-4" />}Add income</Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Money you received outside the auto-pulled marketplace payouts (e.g. leftover cash). It joins the pool to distribute into funds below.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Latest payout per account</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[...latestByAccount.values()].map((p) => (
                  <div key={p.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground"><span className="capitalize">{p.marketplace}</span><span>{p.distributed ? "distributed" : "to distribute"}</span></div>
                    <div className="truncate text-sm font-medium">{p.entity ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{p.periodStart ?? "—"} → {p.periodEnd ?? p.depositDate ?? "—"}</div>
                    <div className="text-lg font-semibold">{usd(p.netAmount)}</div>
                  </div>
                ))}
                {latestByAccount.size === 0 && <p className="text-sm text-muted-foreground">No payouts yet. Click <b>Get Report</b>.</p>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Net Proceeds — what the marketplace paid (breakdown)</CardTitle>
                <div className="flex rounded-md border text-xs">
                  {(["pending", "all"] as const).map((s) => (<button key={s} onClick={() => setScope(s)} className={cn("px-3 py-1", scope === s ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>{s === "pending" ? "To distribute" : "All history"}</button>))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {statementRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{scope === "pending" ? "Nothing waiting — all pulled periods are distributed." : "No payouts yet."} Click <b>Get Report</b>.</p>
              ) : (
                <div className="space-y-4">
                  <StatementGroup title="Income" rows={income} maxAbs={maxAbs} tone="pos" />
                  <StatementGroup title="Costs" rows={costs} maxAbs={maxAbs} tone="neg" />
                  {neutral.length > 0 && <StatementGroup title="Pass-through / timing" rows={neutral} maxAbs={maxAbs} tone="muted" />}
                  <div className="flex items-center justify-between border-t pt-3 text-base font-semibold"><span>Net proceeds</span><span className={netProceeds >= 0 ? "text-emerald-600" : "text-destructive"}>{usd(netProceeds)}</span></div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Pulled periods ({payouts.length})</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Channel</th><th className="px-3 py-2">Account</th><th className="px-3 py-2">Period</th><th className="px-3 py-2 text-right">Net payout</th><th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Payout % of sales</th><th className="px-3 py-2 text-right">Fees</th><th className="px-3 py-2">Status</th></tr></thead>
                <tbody>
                  {payouts.map((p) => {
                    const sales = p.lines.filter((l) => ["sales", "shipping_income"].includes(l.bucket)).reduce((s, l) => s + l.amount, 0);
                    const fees = p.lines.filter((l) => BUCKET_META[l.bucket as Bucket]?.nature === "cost").reduce((s, l) => s + l.amount, 0);
                    const pctOfSales = sales > 0 ? (p.netAmount / sales) * 100 : null;
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-3 py-2 capitalize">{p.marketplace}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.entity ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.periodStart ?? "—"} → {p.periodEnd ?? p.depositDate ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-medium">{usd(p.netAmount)}</td>
                        <td className="px-3 py-2 text-right text-emerald-600">{usd(sales)}</td>
                        <td className={cn("px-3 py-2 text-right tabular-nums", pctOfSales != null && pctOfSales < 50 ? "text-destructive" : "text-muted-foreground")}>{pctOfSales != null ? `${pctOfSales.toFixed(1)}%` : "—"}</td>
                        <td className="px-3 py-2 text-right text-destructive">{usd(fees)}</td>
                        <td className="px-3 py-2">{p.distributed ? <span className="text-xs text-muted-foreground">distributed</span> : <span className="text-xs text-amber-600">to distribute</span>}</td>
                      </tr>
                    );
                  })}
                  {payouts.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No periods pulled yet.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Distribution — same tab as income */}
          <Card>
            <CardHeader><CardTitle className="text-base">Distribute the new payout into funds</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs text-muted-foreground">Reserve % (restock: COGS+shipping+packaging)</label>
                  <div className="flex items-center gap-1"><Input type="number" min={0} max={100} className="w-24" value={config ? Math.round(config.manualPct * 100) : 0} onChange={(e) => saveConfig({ manualPct: (Number(e.target.value) || 0) / 100 })} /><span className="text-sm text-muted-foreground">%</span></div>
                </div>
                <Button onClick={autoAllocate} disabled={busy != null} variant="outline">{busy === "auto" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}Auto-set % from needs</Button>
                <Button onClick={() => doRun(true)} disabled={busy != null} variant="outline">{busy === "preview" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}Preview</Button>
                <Button onClick={() => doRun(false)} disabled={busy != null || !run || run.preview === false}>{busy === "commit" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}Commit</Button>
              </div>
              {run && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="mb-2 flex flex-wrap gap-4 text-muted-foreground">
                    <span>In: <b className="text-foreground">{usd(run.distribution.totalIn)}</b></span>
                    <span>Reserve ({Math.round(run.distribution.reserveRate * 100)}%): <b className="text-foreground">{usd(run.distribution.reserve)}</b></span>
                    <span>Distributable: <b className="text-foreground">{usd(run.distribution.distributable)}</b></span>
                    <span>Free: <b className="text-foreground">{usd(run.distribution.free)}</b></span>
                    <span>{run.preview ? "PREVIEW — not committed" : "COMMITTED"}</span>
                  </div>
                  <table className="w-full">
                    <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-1">Fund</th><th>Group</th><th className="text-right">Amount</th></tr></thead>
                    <tbody>{run.distribution.allocations.map((a) => (<tr key={a.fundId} className="border-t"><td className="py-1">{a.name}</td><td className="text-muted-foreground">{a.group}</td><td className="text-right font-medium">{usd(a.amount)}</td></tr>))}</tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {tab === "funds" && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="border-primary"><CardContent className="py-4"><div className="text-xs uppercase text-muted-foreground">All funds total</div><div className={cn("text-3xl font-semibold", fundsTotal < 0 ? "text-destructive" : "text-emerald-600")}>{usd(fundsTotal)}</div></CardContent></Card>
            <Card className="sm:col-span-2"><CardContent className="py-3">
              <ReceiptScanner funds={funds.map((f) => ({ id: f.id, name: f.name }))} defaultFundId={funds.find((f) => f.group === "RESERVE")?.id ?? funds[0]?.id} onSaved={load} />
              <p className="mt-2 text-xs text-muted-foreground">Scan a purchase → debit a fund. Resale buys → Restock reserve; other buys → pick the fund.</p>
            </CardContent></Card>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {funds.map((f) => (
              <Link key={f.id} href={`/finance/funds/${f.id}`} className={cn("rounded-lg border p-4 transition hover:border-primary hover:bg-muted/40", !f.active && "opacity-50")}>
                <div className="flex items-center justify-between"><span className="text-xs uppercase text-muted-foreground">{f.group}</span><span className="text-[10px] text-muted-foreground">{f.allocationType === "percent" ? `${f.value}%` : usd(f.value)}</span></div>
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className={cn("text-2xl font-semibold", f.balance < 0 && "text-destructive")}>{usd(f.balance)}</div>
                <Sparkline data={f.series} />
                <div className="text-[10px] text-muted-foreground">last 30 days</div>
              </Link>
            ))}
            {funds.length === 0 && <p className="text-sm text-muted-foreground">No funds yet — add some on Manage funds.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) return <div className="h-9" />;
  const w = 180, h = 36, pad = 3;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = data[data.length - 1] >= data[0];
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="my-1 block">
      <polyline points={pts} fill="none" stroke={up ? "#10b981" : "#f43f5e"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StatementGroup({ title, rows, maxAbs, tone }: { title: string; rows: { bucket: Bucket; amount: number }[]; maxAbs: number; tone: "pos" | "neg" | "muted" }) {
  if (rows.length === 0) return null;
  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
  const barColor = tone === "pos" ? "bg-emerald-500" : tone === "neg" ? "bg-rose-500" : "bg-muted-foreground/40";
  const textColor = tone === "pos" ? "text-emerald-600" : tone === "neg" ? "text-destructive" : "text-muted-foreground";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-medium uppercase text-muted-foreground"><span>{title}</span><span className={textColor}>{usd(subtotal)}</span></div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.bucket} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-sm">{BUCKET_META[r.bucket].label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted"><div className={cn("h-full", barColor)} style={{ width: `${Math.min(100, (Math.abs(r.amount) / maxAbs) * 100)}%` }} /></div>
            <span className={cn("w-24 shrink-0 text-right text-sm tabular-nums", textColor)}>{usd(r.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: "pos" | "neg" }) {
  return (
    <Card><CardContent className="py-4">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold", accent === "pos" && "text-emerald-600", accent === "neg" && "text-destructive")}>{value}</div>
    </CardContent></Card>
  );
}
