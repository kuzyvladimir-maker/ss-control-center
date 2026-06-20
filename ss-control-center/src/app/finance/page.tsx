"use client";

/**
 * Finance — Funds (Phase 1). The financial-planning cockpit:
 *   money in (marketplace payouts, net) → reserve (restock: COGS+shipping+packaging)
 *   → waterfall into FP1/FP2 funds → free. Cash basis, one global business pool.
 *
 * This page: pool totals, reserve config, ingest payouts, preview + commit a
 * distribution run, and current fund balances. Fund CRUD lives at /finance/funds.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, DownloadCloud, Play, CheckCircle2, AlertCircle, Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund {
  id: string;
  name: string;
  group: string;
  allocationType: string;
  value: number;
  priority: number;
  cap: number | null;
  balance: number;
  active: boolean;
  isSystem: boolean;
}
interface PayoutTotals { count: number; undistributedCount: number; undistributedNet: number }
interface AllocationLine { fundId: string; name: string; group: string; amount: number }
interface RunResult {
  preview: boolean;
  distribution: { totalIn: number; reserve: number; reserveRate: number; distributable: number; allocations: AllocationLine[]; free: number };
  reserveMethod: string;
  reserveFellBack: boolean;
  payoutCount: number;
  runId?: string;
}

export default function FinancePage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [totals, setTotals] = useState<PayoutTotals | null>(null);
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
        fetch("/api/finance/payouts?undistributed=1").then((r) => r.json()),
        fetch("/api/finance/config").then((r) => r.json()),
      ]);
      setFunds(f.funds ?? []);
      setTotals(p.totals ?? null);
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function ingest() {
    setBusy("ingest"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/payouts?ingest=1", { method: "POST" }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "ingest failed");
      const created = (r.results ?? []).reduce((s: number, x: { created: number }) => s + x.created, 0);
      setNote(`Ingest done: ${created} new payouts.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function addManualPayout() {
    const amt = Number(manualAmt);
    if (!Number.isFinite(amt) || amt === 0) { setError("Enter a payout amount"); return; }
    setBusy("manual"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/payouts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ netAmount: amt }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "add failed");
      setManualAmt(""); setNote(`Manual payout ${usd(amt)} added.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function doRun(preview: boolean) {
    setBusy(preview ? "preview" : "commit"); setError(null); setNote(null);
    try {
      const r = await fetch("/api/finance/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ preview }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "run failed");
      setRun(r);
      if (!preview) { setNote("Distribution committed — balances updated."); await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function saveConfig(next: Partial<{ method: string; manualPct: number; windowWeeks: number }>) {
    if (!config) return;
    const merged = { ...config, ...next };
    setConfig(merged);
    await fetch("/api/finance/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Finance — Funds</h1>
          <p className="text-sm text-muted-foreground">
            Money in (marketplace payouts, net) → reserve restock → waterfall into funds. Cash basis, one global pool.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/finance/funds"><Button variant="outline" size="sm"><Settings2 className="mr-1 h-4 w-4" />Manage funds</Button></Link>
          <Button onClick={load} variant="outline" size="sm"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>
      )}
      {note && (
        <Card className="border-emerald-500"><CardContent className="flex items-center gap-2 py-3 text-emerald-600"><CheckCircle2 className="h-4 w-4" />{note}</CardContent></Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Kpi label="Undistributed payouts" value={totals ? String(totals.undistributedCount) : "—"} />
        <Kpi label="Money in (net)" value={totals ? usd(totals.undistributedNet) : "—"} />
        <Kpi label="Reserve %" value={config ? `${(config.manualPct * 100).toFixed(0)}%` : "—"} />
        <Kpi label="Active funds" value={String(funds.filter((f) => f.active).length)} />
      </div>

      {/* Actions + reserve config */}
      <Card>
        <CardHeader><CardTitle className="text-base">Run weekly distribution</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Reserve % (manual)</label>
              <div className="flex items-center gap-1">
                <Input
                  type="number" min={0} max={100} className="w-24"
                  value={config ? Math.round(config.manualPct * 100) : 0}
                  onChange={(e) => saveConfig({ manualPct: (Number(e.target.value) || 0) / 100 })}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
            <Button onClick={ingest} disabled={busy != null} variant="outline">
              {busy === "ingest" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <DownloadCloud className="mr-1 h-4 w-4" />}
              Ingest payouts
            </Button>
            <div>
              <label className="block text-xs text-muted-foreground">Add payout manually ($)</label>
              <div className="flex items-center gap-1">
                <Input type="number" className="w-28" value={manualAmt} onChange={(e) => setManualAmt(e.target.value)} placeholder="0.00" />
                <Button onClick={addManualPayout} disabled={busy != null} variant="outline" size="sm">
                  {busy === "manual" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                </Button>
              </div>
            </div>
            <Button onClick={() => doRun(true)} disabled={busy != null} variant="outline">
              {busy === "preview" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}
              Preview
            </Button>
            <Button onClick={() => doRun(false)} disabled={busy != null || !run || run.preview === false}>
              {busy === "commit" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
              Commit
            </Button>
          </div>

          {run && (
            <div className="rounded-md border p-3 text-sm">
              <div className="mb-2 flex flex-wrap gap-4 text-muted-foreground">
                <span>In: <b className="text-foreground">{usd(run.distribution.totalIn)}</b></span>
                <span>Reserve ({(run.distribution.reserveRate * 100).toFixed(0)}%): <b className="text-foreground">{usd(run.distribution.reserve)}</b></span>
                <span>Distributable: <b className="text-foreground">{usd(run.distribution.distributable)}</b></span>
                <span>Free: <b className="text-foreground">{usd(run.distribution.free)}</b></span>
                <span>Payouts: <b className="text-foreground">{run.payoutCount}</b></span>
                {run.reserveFellBack && <span className="text-amber-600">reserve: manual fallback</span>}
                <span>{run.preview ? "PREVIEW" : "COMMITTED"}</span>
              </div>
              <table className="w-full">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="py-1">Fund</th><th>Group</th><th className="text-right">Amount</th></tr>
                </thead>
                <tbody>
                  {run.distribution.allocations.map((a) => (
                    <tr key={a.fundId} className="border-t">
                      <td className="py-1">{a.name}</td>
                      <td className="text-muted-foreground">{a.group}</td>
                      <td className="text-right font-medium">{usd(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
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
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase text-muted-foreground">{f.group}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {f.allocationType === "percent" ? `${f.value}%` : usd(f.value)}
                  </span>
                </div>
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className="text-lg font-semibold">{usd(f.balance)}</div>
              </div>
            ))}
            {funds.length === 0 && <p className="text-sm text-muted-foreground">No funds yet — add some on the Manage funds page.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card><CardContent className="py-4">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </CardContent></Card>
  );
}
