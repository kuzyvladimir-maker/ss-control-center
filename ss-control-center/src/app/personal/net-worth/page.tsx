"use client";

/**
 * Net worth = assets − liabilities, per owner. Assets are real accounts and
 * property, each value with its date and source (envelope/fund balances are the
 * same cash, so they are not added). Liabilities are the registry's known balances;
 * obligations whose balance is unknown are listed, never guessed.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, PlusCircle, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Liability, NetWorth, RegistryAlert, RegistryTotals } from "@/lib/finance/registry";
import { AlertsPanel, AsOf, Kpi, OwnerTag, PersonalNav, StandingBadge, usd, usd2 } from "@/components/personal/registry-ui";

interface Asset { id: string; owner: string | null; entity: string | null; name: string; kind: string; institution: string | null; last4: string | null; value: number; valueAsOf: string | null; valueSource: string | null; alert: string | null; active: boolean; notes: string | null }
interface Registry { netWorth: NetWorth; totals: RegistryTotals; assets: Asset[]; liabilities: Liability[]; alerts: RegistryAlert[] }

const KINDS = ["checking", "savings", "cash", "vehicle", "property", "business", "other"];
const OWNERS = ["Vladimir", "Anna"];

export default function NetWorthPage() {
  const [data, setData] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/personal/registry").then((x) => x.json());
      if (!r.netWorth) throw new Error(r.error ?? "failed to load");
      setData(r);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(id: string) {
    if (!confirm("Delete this asset?")) return;
    try {
      const r = await fetch(`/api/personal/registry?type=asset&id=${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Could not delete the asset");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const nw = data?.netWorth;
  const unknown = (data?.liabilities ?? []).filter((l) => l.counted && l.balance == null);
  const assetAlerts = (data?.alerts ?? []).filter((a) => a.refType === "asset");
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Net worth</h1>
          <p className="text-[13px] text-ink-3">Assets minus everything owed. Each value shows its date and source; unknown balances are listed, not guessed.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd((s) => !s)}><PlusCircle className="h-4 w-4" /> Add asset</Button>
      </div>
      <PersonalNav active="/personal/net-worth" />
      {error && <div className="rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-[13px] text-danger">{error}</div>}
      {!data && !error && <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}

      {data && nw && (
        <>
          <AlertsPanel alerts={assetAlerts} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Kpi label="Net worth (known)" value={usd(nw.net)} tone={nw.net < 0 ? "danger" : "green"} hint={nw.unknownLiabilities ? `${nw.unknownLiabilities} debts with unknown balance not included` : undefined} />
            <Kpi label="Assets" value={usd(nw.assets)} hint={`${data.assets.filter((a) => a.active).length} accounts`} />
            <Kpi label="Liabilities (known)" value={usd(nw.liabilities)} hint={`${data.totals.all.count} obligations · tap for details`} href="/personal/obligations" />
          </div>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-[14px]">By owner</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-2 px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-4"><span>Owner</span><span className="text-right">Assets</span><span className="text-right">Liabilities</span><span className="text-right">Net</span></div>
              {Object.entries(nw.byOwner).sort().map(([o, v]) => (
                <div key={o} className="grid grid-cols-4 gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-elev">
                  <OwnerTag owner={o === "—" ? null : o} />
                  <span className="text-right tabular text-ink-2">{usd2(v.assets)}</span>
                  <span className="text-right tabular text-ink-2">{usd2(v.liabilities)}</span>
                  <span className={cn("text-right font-medium tabular", v.net < 0 ? "text-danger" : "text-green-ink")}>{usd2(v.net)}</span>
                </div>
              ))}
              <p className="mt-2 px-2 text-[11px] text-ink-4">Liabilities follow the obligation&apos;s owner (who signed / holds it). Joint taxes are listed under Vladimir.</p>
            </CardContent>
          </Card>

          {showAdd && <AssetForm onDone={() => { setShowAdd(false); load(); }} onCancel={() => setShowAdd(false)} />}

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-[14px]">Assets</CardTitle></CardHeader>
            <CardContent className="space-y-0.5">
              {data.assets.length === 0 && <p className="py-4 text-center text-[13px] text-ink-3">No assets yet — add bank accounts, vehicles, property.</p>}
              {data.assets.map((a) => (
                <div key={a.id} className={cn("rounded-md", !a.active && "opacity-60")}>
                  <div className="grid grid-cols-2 items-center gap-2 px-2 py-1.5 hover:bg-bg-elev md:grid-cols-[2fr_0.8fr_1.6fr_auto]">
                    <div className="col-span-2 md:col-span-1">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">{a.name}{a.last4 ? ` ${a.last4}` : ""}{a.alert && <span className="h-1.5 w-1.5 rounded-full bg-danger" title={a.alert} />}</div>
                      <div className="text-[11px] text-ink-4">{[a.institution, a.kind, a.entity, a.notes].filter(Boolean).join(" · ")}</div>
                    </div>
                    <OwnerTag owner={a.owner} />
                    <div className="text-right">
                      <div className={cn("text-[13px] font-medium tabular", a.value < 0 ? "text-danger" : "text-ink")}>{usd2(a.value)}</div>
                      <AsOf asOf={a.valueAsOf} source={a.valueSource} />
                    </div>
                    <div className="col-span-2 flex justify-end gap-1 md:col-span-1">
                      <button onClick={() => setEditId(editId === a.id ? null : a.id)} className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-ink" title="Edit"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove(a.id)} className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-danger" title="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {editId === a.id && <AssetForm asset={a} onDone={() => { setEditId(null); load(); }} onCancel={() => setEditId(null)} />}
                </div>
              ))}
              <p className="px-2 pt-2 text-[11px] text-ink-4">Envelope (fund) balances are not added — they are the same cash. Vehicles are not valued yet; add them to include.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-[14px]">Liabilities</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-[13px]">
              {(["personal", "business"] as const).map((p) => data.totals.byPool[p] && (
                <Link key={p} href="/personal/obligations" className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-bg-elev">
                  <span className="text-ink-2">{p === "personal" ? "Personal pool" : "Business plan (owner's obligations)"} · {data.totals.byPool[p].count}</span>
                  <span className="tabular font-medium text-ink">{usd2(data.totals.byPool[p].total)}</span>
                </Link>
              ))}
              {unknown.length > 0 && (
                <div className="mt-2 border-t border-rule pt-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-4">Balance unknown — not in the total</div>
                  {unknown.map((l) => (
                    <Link key={l.id} href={`/personal/obligations#${l.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-bg-elev">
                      <span className="flex-1 text-ink-2">{l.label}</span><StandingBadge standing={l.standing} /><OwnerTag owner={l.owner} />
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function AssetForm({ asset, onDone, onCancel }: { asset?: Asset; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    name: asset?.name ?? "", kind: asset?.kind ?? "checking", owner: asset?.owner ?? "", entity: asset?.entity ?? "Personal",
    institution: asset?.institution ?? "", last4: asset?.last4 ?? "", value: asset ? String(asset.value) : "",
    valueAsOf: asset?.valueAsOf ?? new Date().toISOString().slice(0, 10), valueSource: asset?.valueSource ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.name || !f.owner || f.value === "") { setErr("Name, owner and value are required"); return; }
    if (!f.valueSource) { setErr("Enter where the value comes from"); return; }
    setBusy(true); setErr(null);
    try {
      // A new value with the old date/source left as-is is re-dated "today · Manual entry" by the server.
      const stale = asset && f.value !== String(asset.value) && f.valueAsOf === (asset.valueAsOf ?? "") && f.valueSource === (asset.valueSource ?? "");
      const { valueAsOf, valueSource, ...rest } = f;
      const body = asset ? { type: "asset", id: asset.id, ...rest, ...(stale ? {} : { valueAsOf, valueSource }) } : { type: "asset", ...f };
      const r = await fetch("/api/personal/registry", { method: asset ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><label className="mb-1 block text-[11px] text-ink-3">{label}</label><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></div>
  );
  return (
    <div className="m-2 rounded-md border border-rule bg-surface p-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {input("name", "Name *", { placeholder: "e.g. BMW X3" })}
        <div><label className="mb-1 block text-[11px] text-ink-3">Kind</label>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]">{KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
        <div><label className="mb-1 block text-[11px] text-ink-3">Owner *</label>
          <select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]"><option value="">—</option>{OWNERS.map((o) => <option key={o}>{o}</option>)}</select></div>
        {input("entity", "Entity")}
        {input("institution", "Institution")}
        {input("last4", "Last 4")}
        {input("value", "Value *", { inputMode: "decimal" })}
        {input("valueAsOf", "As of", { type: "date" })}
        <div className="col-span-2 sm:col-span-4">{input("valueSource", "Source *", { placeholder: "e.g. Bank app 2026-11-01, KBB estimate 2026-11-01" })}</div>
      </div>
      {err && <p className="mt-1.5 text-[12px] text-danger">{err}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
