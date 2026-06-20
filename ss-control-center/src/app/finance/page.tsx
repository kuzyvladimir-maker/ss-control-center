"use client";

/**
 * Financial Plan (FP) — the weekly financial-planning cockpit.
 *
 * Flow: Get Report (pulls last CLOSED marketplace settlement periods we haven't
 * pulled yet, via API) → decompose each payout into a Net-Proceeds statement
 * (sales / shipping / refunds / fees / ads / reserve …) → reserve restock →
 * waterfall the cash into funds (FP1 → FP2 → free). Cash basis, one global pool.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, RefreshCw, DownloadCloud, Play, CheckCircle2, AlertCircle, Settings2, FileText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BUCKET_META, BUCKET_ORDER, type Bucket } from "@/lib/finance/settlement";

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund { id: string; name: string; group: string; allocationType: string; value: number; priority: number; cap: number | null; balance: number; active: boolean; isSystem: boolean }
interface PayoutLine { bucket: string; amount: number; count: number }
interface Payout { id: string; marketplace: string; entity: string | null; externalId: string; periodStart: string | null; periodEnd: string | null; depositDate: string | null; netAmount: number; distributed: boolean; lines: PayoutLine[] }
interface AllocationLine { fundId: string; name: string; group: string; amount: number }
interface RunResult { preview: boolean; distribution: { totalIn: number; reserve: number; reserveRate: number; distributable: number; allocations: AllocationLine[]; free: number }; reserveFellBack: boolean; payoutCount: number }

export default function FinancialPlanPage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [breakdown, setBreakdown] = useState<Record<string, number>>({});
  const [totals, setTotals] = useState<{ totalNet: number; undistributedNet: number; undistributedCount: number } | null>(null);
  const [config, setConfig] = useState<{ method: string; manualPct: number; windowWeeks: number } | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [manualAmt, setManualAmt] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [f, p, c] = await Promise.all([
        fetch("/api/finance/funds").then((r) => r.json()),
        fetch("/api/finance/payouts").then((r) => r.json()),
        fetch("/api/finance/config").then((r) => r.json()),
      ]);
      setFunds(f.funds ?? []);
      setPayouts(p.payouts ?? []);
      setBreakdown(p.breakdown ?? {});
      setTotals(p.totals ?? null);
      setConfig(c);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function getReport() {
    setBusy("report"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/payouts?ingest=1", { method: "POST" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "Get Report failed");
      const created = (r.results ?? []).reduce((s: number, x: { created: number }) => s + x.created, 0);
      const errs = (r.results ?? []).flatMap((x: { errors: string[] }) => x.errors);
      setNote(`Get Report: ${created} new closed period(s) pulled.${errs.length ? ` ${errs.length} warning(s).` : ""}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function addManualPayout() {
    const amt = Number(manualAmt);
    if (!Number.isFinite(amt) || amt === 0) { setError("Enter a payout amount"); return; }
    setBusy("manual"); setError(null);
    try {
      const r = await fetch("/api/finance/payouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ netAmount: amt }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "add failed");
      setManualAmt(""); setNote(`Manual payout ${usd(amt)} added.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function doRun(preview: boolean) {
    setBusy(preview ? "preview" : "commit"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "run failed");
      setRun(r);
      if (!preview) { setNote("Distribution committed — balances updated."); await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function saveConfig(next: Partial<{ manualPct: number }>) {
    if (!config) return;
    setConfig({ ...config, ...next });
    await fetch("/api/finance/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
  }

  // Statement aggregation across all pulled payouts.
  const statementRows = BUCKET_ORDER
    .map((b) => ({ bucket: b as Bucket, amount: breakdown[b] ?? 0 }))
    .filter((r) => Math.abs(r.amount) > 0.005);
  const income = statementRows.filter((r) => BUCKET_META[r.bucket].nature === "income");
  const costs = statementRows.filter((r) => BUCKET_META[r.bucket].nature === "cost");
  const neutral = statementRows.filter((r) => ["wash", "timing", "mixed"].includes(BUCKET_META[r.bucket].nature));
  const netProceeds = statementRows.reduce((s, r) => s + r.amount, 0);
  const maxAbs = Math.max(1, ...statementRows.map((r) => Math.abs(r.amount)));

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Financial Plan</h1>
          <p className="text-sm text-muted-foreground">
            Get Report → decompose marketplace payouts (Net Proceeds) → reserve restock → waterfall into funds. Cash basis, one global pool.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={getReport} disabled={busy != null}>
            {busy === "report" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
            Get Report
          </Button>
          <Link href="/finance/funds"><Button variant="outline" size="sm"><Settings2 className="mr-1 h-4 w-4" />Manage funds</Button></Link>
          <Button onClick={load} variant="outline" size="sm"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}
      {note && <Card className="border-emerald-500"><CardContent className="flex items-center gap-2 py-3 text-emerald-600"><CheckCircle2 className="h-4 w-4" />{note}</CardContent></Card>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Kpi label="Net proceeds (pulled)" value={usd(netProceeds)} accent={netProceeds >= 0 ? "pos" : "neg"} />
        <Kpi label="Undistributed money" value={totals ? usd(totals.undistributedNet) : "—"} />
        <Kpi label="Periods pulled" value={String(payouts.length)} />
        <Kpi label="Reserve %" value={config ? `${Math.round(config.manualPct * 100)}%` : "—"} />
      </div>

      {/* Net Proceeds statement (the molecule breakdown) */}
      <Card>
        <CardHeader><CardTitle className="text-base">Net Proceeds — statement breakdown (all pulled periods)</CardTitle></CardHeader>
        <CardContent>
          {statementRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payouts yet. Click <b>Get Report</b> to pull the last closed Amazon/Walmart settlement periods, or add a manual payout below.</p>
          ) : (
            <div className="space-y-4">
              <StatementGroup title="Income" rows={income} maxAbs={maxAbs} tone="pos" />
              <StatementGroup title="Costs" rows={costs} maxAbs={maxAbs} tone="neg" />
              {neutral.length > 0 && <StatementGroup title="Pass-through / timing" rows={neutral} maxAbs={maxAbs} tone="muted" />}
              <div className="flex items-center justify-between border-t pt-3 text-base font-semibold">
                <span>Net proceeds</span>
                <span className={netProceeds >= 0 ? "text-emerald-600" : "text-destructive"}>{usd(netProceeds)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-period payouts */}
      <Card>
        <CardHeader><CardTitle className="text-base">Pulled periods ({payouts.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-3 py-2">Channel</th><th className="px-3 py-2">Period</th><th className="px-3 py-2">Entity</th><th className="px-3 py-2 text-right">Net payout</th><th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Fees</th><th className="px-3 py-2">Status</th></tr>
            </thead>
            <tbody>
              {payouts.map((p) => {
                const sales = p.lines.filter((l) => ["sales", "shipping_income"].includes(l.bucket)).reduce((s, l) => s + l.amount, 0);
                const fees = p.lines.filter((l) => BUCKET_META[l.bucket as Bucket]?.nature === "cost").reduce((s, l) => s + l.amount, 0);
                return (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2 capitalize">{p.marketplace}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.periodStart ?? "—"} → {p.periodEnd ?? p.depositDate ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.entity ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-medium">{usd(p.netAmount)}</td>
                    <td className="px-3 py-2 text-right text-emerald-600">{usd(sales)}</td>
                    <td className="px-3 py-2 text-right text-destructive">{usd(fees)}</td>
                    <td className="px-3 py-2">{p.distributed ? <span className="text-xs text-muted-foreground">distributed</span> : <span className="text-xs text-amber-600">pending</span>}</td>
                  </tr>
                );
              })}
              {payouts.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No periods pulled yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Fund distribution */}
      <Card>
        <CardHeader><CardTitle className="text-base">Distribute into funds</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-muted-foreground">Reserve % (restock: COGS+shipping+packaging)</label>
              <div className="flex items-center gap-1">
                <Input type="number" min={0} max={100} className="w-24" value={config ? Math.round(config.manualPct * 100) : 0} onChange={(e) => saveConfig({ manualPct: (Number(e.target.value) || 0) / 100 })} />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground">Add payout manually ($)</label>
              <div className="flex items-center gap-1">
                <Input type="number" className="w-28" value={manualAmt} onChange={(e) => setManualAmt(e.target.value)} placeholder="0.00" />
                <Button onClick={addManualPayout} disabled={busy != null} variant="outline" size="sm">{busy === "manual" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}</Button>
              </div>
            </div>
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
                <span>{run.preview ? "PREVIEW" : "COMMITTED"}</span>
              </div>
              <table className="w-full">
                <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-1">Fund</th><th>Group</th><th className="text-right">Amount</th></tr></thead>
                <tbody>{run.distribution.allocations.map((a) => (<tr key={a.fundId} className="border-t"><td className="py-1">{a.name}</td><td className="text-muted-foreground">{a.group}</td><td className="text-right font-medium">{usd(a.amount)}</td></tr>))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fund balances */}
      <Card>
        <CardHeader><CardTitle className="text-base">Fund balances</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {funds.sort((a, b) => a.priority - b.priority).map((f) => (
              <div key={f.id} className={cn("rounded-md border p-3", !f.active && "opacity-50")}>
                <div className="flex items-center justify-between"><span className="text-xs uppercase text-muted-foreground">{f.group}</span><span className="text-[10px] text-muted-foreground">{f.allocationType === "percent" ? `${f.value}%` : usd(f.value)}</span></div>
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className="text-lg font-semibold">{usd(f.balance)}</div>
              </div>
            ))}
            {funds.length === 0 && <p className="text-sm text-muted-foreground">No funds yet — add some on Manage funds.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatementGroup({ title, rows, maxAbs, tone }: { title: string; rows: { bucket: Bucket; amount: number }[]; maxAbs: number; tone: "pos" | "neg" | "muted" }) {
  if (rows.length === 0) return null;
  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
  const barColor = tone === "pos" ? "bg-emerald-500" : tone === "neg" ? "bg-rose-500" : "bg-muted-foreground/40";
  const textColor = tone === "pos" ? "text-emerald-600" : tone === "neg" ? "text-destructive" : "text-muted-foreground";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-medium uppercase text-muted-foreground">
        <span>{title}</span><span className={textColor}>{usd(subtotal)}</span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.bucket} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-sm">{BUCKET_META[r.bucket].label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div className={cn("h-full", barColor)} style={{ width: `${Math.min(100, (Math.abs(r.amount) / maxAbs) * 100)}%` }} />
            </div>
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
