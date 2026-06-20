"use client";

/**
 * Finance — Manage funds (CRUD). Define the buckets the weekly distribution
 * waterfall fills: group (FP1 life-support → FP2 growth), percent or absolute,
 * priority (lower fills first), optional per-run cap. RESERVE + FREE are system
 * funds (the reserve % is set on the main Finance page; FREE catches leftovers).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2, ArrowLeft, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fund {
  id: string; name: string; group: string; allocationType: string;
  value: number; priority: number; cap: number | null; balance: number;
  active: boolean; isSystem: boolean;
}

const GROUPS = ["FP1", "FP2", "RESERVE", "FREE"];
const TYPES = ["percent", "absolute"];

export default function ManageFundsPage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", group: "FP1", allocationType: "percent", value: 10, priority: 50, cap: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/finance/funds").then((x) => x.json());
      setFunds(r.funds ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addFund() {
    if (!draft.name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/finance/funds", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, cap: draft.cap === "" ? null : Number(draft.cap) }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setDraft({ name: "", group: "FP1", allocationType: "percent", value: 10, priority: 50, cap: "" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function patch(id: string, data: Partial<Fund>) {
    await fetch("/api/finance/funds", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...data }),
    });
    await load();
  }

  async function del(id: string) {
    const r = await fetch(`/api/finance/funds?id=${id}`, { method: "DELETE" }).then((x) => x.json());
    if (r.error) { setError(r.error); return; }
    await load();
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Manage funds</h1>
          <p className="text-sm text-muted-foreground">Waterfall order = priority (lower fills first). Percent funds draw from the post-reserve pool.</p>
        </div>
        <Link href="/finance"><Button variant="outline" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back</Button></Link>
      </div>

      {error && <Card className="border-destructive"><CardContent className="flex items-center gap-2 py-3 text-destructive"><AlertCircle className="h-4 w-4" />{error}</CardContent></Card>}

      {/* Add fund */}
      <Card>
        <CardHeader><CardTitle className="text-base">Add fund</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name"><Input className="w-44" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Payroll" /></Field>
            <Field label="Group"><Select value={draft.group} options={GROUPS} onChange={(v) => setDraft({ ...draft, group: v })} /></Field>
            <Field label="Type"><Select value={draft.allocationType} options={TYPES} onChange={(v) => setDraft({ ...draft, allocationType: v })} /></Field>
            <Field label={draft.allocationType === "percent" ? "Value %" : "Value $"}><Input type="number" className="w-24" value={draft.value} onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) || 0 })} /></Field>
            <Field label="Priority"><Input type="number" className="w-20" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })} /></Field>
            <Field label="Cap $ (opt)"><Input type="number" className="w-24" value={draft.cap} onChange={(e) => setDraft({ ...draft, cap: e.target.value })} /></Field>
            <Button onClick={addFund} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Funds table */}
      <Card>
        <CardHeader><CardTitle className="text-base">{funds.length} funds</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-3 py-2">Priority</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Group</th><th className="px-3 py-2">Allocation</th><th className="px-3 py-2">Cap</th><th className="px-3 py-2 text-right">Balance</th><th className="px-3 py-2">Active</th><th className="px-3 py-2"></th></tr>
            </thead>
            <tbody>
              {funds.sort((a, b) => a.priority - b.priority).map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <Input type="number" className="w-16" defaultValue={f.priority} onBlur={(e) => { const v = Number(e.target.value); if (v !== f.priority) patch(f.id, { priority: v }); }} disabled={f.isSystem} />
                  </td>
                  <td className="px-3 py-2">{f.name}{f.isSystem && <span className="ml-1 text-[10px] text-muted-foreground">(system)</span>}</td>
                  <td className="px-3 py-2 text-muted-foreground">{f.group}</td>
                  <td className="px-3 py-2">
                    {f.group === "RESERVE" ? <span className="text-muted-foreground">reserve % (main page)</span>
                      : f.group === "FREE" ? <span className="text-muted-foreground">leftover</span>
                      : <Input type="number" className="w-24" defaultValue={f.value} onBlur={(e) => { const v = Number(e.target.value); if (v !== f.value) patch(f.id, { value: v }); }} />}
                    {f.group !== "RESERVE" && f.group !== "FREE" && <span className="ml-1 text-xs text-muted-foreground">{f.allocationType === "percent" ? "%" : "$"}</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{f.cap != null ? usd(f.cap) : "—"}</td>
                  <td className="px-3 py-2 text-right font-medium">{usd(f.balance)}</td>
                  <td className="px-3 py-2"><input type="checkbox" checked={f.active} onChange={(e) => patch(f.id, { active: e.target.checked })} /></td>
                  <td className="px-3 py-2">{!f.isSystem && <Button variant="ghost" size="sm" onClick={() => del(f.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs text-muted-foreground">{label}</label>{children}</div>;
}
function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
