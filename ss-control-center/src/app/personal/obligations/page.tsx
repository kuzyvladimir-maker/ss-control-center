"use client";

/**
 * Obligations registry — every debt the owner carries, most urgent first, each
 * with its owner, status badge, balance + the date and source of that balance.
 * Cards and debts of BOTH pools: a business-plan debt (Parafin, Amex, EGK…) is
 * still the owner's obligation; it is shown here and paid from the business pool.
 * Rows that no current source confirms are kept at the bottom, not counted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, PlusCircle, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STANDINGS, STANDING_META, type Liability, type RegistryAlert, type RegistryTotals } from "@/lib/finance/registry";
import { AlertsPanel, AsOf, Kpi, OwnerTag, PersonalNav, StandingBadge, dateLong, dateShort, money, usd, usd2 } from "@/components/personal/registry-ui";

interface EventRow { id: string; debtId: string | null; cardId: string | null; date: string; endDate: string | null; time: string | null; kind: string; title: string; amount: number | null; status: string; source: string | null; note: string | null }
interface Registry { today: string; liabilities: Liability[]; totals: RegistryTotals; alerts: RegistryAlert[]; events: EventRow[] }

const FREQ_LABEL: Record<string, string> = { monthly: "/ mo", biweekly: "/ 2 wk", weekly: "/ wk", daily: "/ day" };
const OWNERS = ["Vladimir", "Anna"];

function paymentText(l: Liability) {
  if (l.payment == null) return "not set";
  return `${usd2(l.payment)} ${FREQ_LABEL[l.frequency ?? "monthly"] ?? ""}`;
}
function dueText(l: Liability) {
  if (l.nextDueDate) return `next ${dateShort(l.nextDueDate)}`;
  if (l.dueDay) return `day ${l.dueDay}`;
  return l.frequency && l.frequency !== "monthly" ? "date not fixed" : "no date";
}

export default function ObligationsPage() {
  const [data, setData] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/personal/registry").then((x) => x.json());
      if (!r.liabilities) throw new Error(r.error ?? "failed to load");
      setData(r);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Deep links: /personal/obligations#<id> opens that row; ?status=past_due filters.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("status");
    if (q && (STANDINGS as readonly string[]).includes(q)) setStatus(q);
    const id = window.location.hash.slice(1);
    if (id) setOpen((o) => ({ ...o, [id]: true }));
  }, []);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (data && id) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [data]);

  const counted = useMemo(() => (data?.liabilities ?? []).filter((l) => l.counted && !(l.type === "card" && l.balance === 0)), [data]);
  const notCounted = useMemo(() => (data?.liabilities ?? []).filter((l) => !l.counted), [data]);
  const visible = counted.filter((l) => (owner === "all" || l.owner === owner) && (status === "all" || l.standing === status));
  const eventsFor = (id: string) => (data?.events ?? []).filter((e) => e.debtId === id || e.cardId === id);

  const t = data?.totals;
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Obligations</h1>
          <p className="text-[13px] text-ink-3">Everything owed, most urgent first. Each balance shows its date and source. Business-plan debts are listed too — they are paid from the business pool.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd((s) => !s)}><PlusCircle className="h-4 w-4" /> Add</Button>
      </div>
      <PersonalNav active="/personal/obligations" />

      {error && <div className="rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-[13px] text-danger">{error}</div>}
      {!data && !error && <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}

      {data && t && (
        <>
          <AlertsPanel alerts={data.alerts} />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Total owed (known)" value={usd(t.all.total)} hint={`${t.all.count} obligations · ${t.all.unknown} balance unknown`} tone="danger" />
            {OWNERS.map((o) => (
              <button key={o} onClick={() => setOwner(owner === o ? "all" : o)} className="text-left">
                <Kpi label={`${o}${owner === o ? " · filtered" : ""}`} value={usd(t.byOwner[o]?.total ?? 0)} hint={`${t.byOwner[o]?.count ?? 0} obligations${t.byOwner[o]?.unknown ? ` · ${t.byOwner[o].unknown} unknown` : ""}`} />
              </button>
            ))}
            <Kpi label="Payments / month (known)" value={usd(t.monthlyPayments)} hint={`${t.missingPayment} without a payment set`} />
          </div>

          {showAdd && <AddObligation onDone={() => { setShowAdd(false); load(); }} />}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={owner === "all" && status === "all"} onClick={() => { setOwner("all"); setStatus("all"); }}>All · {counted.length}</Chip>
            {OWNERS.map((o) => <Chip key={o} active={owner === o} onClick={() => setOwner(owner === o ? "all" : o)}>{o}</Chip>)}
            <span className="mx-1 h-4 w-px bg-rule" />
            {STANDINGS.filter((s) => t.byStanding[s]).map((s) => (
              <Chip key={s} active={status === s} onClick={() => setStatus(status === s ? "all" : s)}>
                {STANDING_META[s].label} · {t.byStanding[s].count}
              </Chip>
            ))}
          </div>

          {/* Sections by status, most urgent first */}
          {STANDINGS.map((s) => {
            const rows = visible.filter((l) => l.standing === s);
            if (rows.length === 0) return null;
            const sum = rows.reduce((a, l) => a + (l.balance ?? 0), 0);
            const unknown = rows.filter((l) => l.balance == null).length;
            return (
              <Card key={s}>
                <CardHeader className="flex-row items-center justify-between pb-1">
                  <CardTitle className="flex items-center gap-2 text-[14px]"><StandingBadge standing={s} /> <span className="text-ink-3">{rows.length}</span></CardTitle>
                  <span className="text-[13px] font-medium tabular text-ink">{usd2(sum)}{unknown ? <span className="text-ink-4"> + {unknown} unknown</span> : null}</span>
                </CardHeader>
                <CardContent className="space-y-0.5">
                  <div className="hidden grid-cols-[2fr_0.8fr_1.4fr_1.1fr_0.4fr] gap-3 px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-4 md:grid">
                    <span>Obligation</span><span>Owner</span><span className="text-right">Balance</span><span className="text-right">Payment</span><span />
                  </div>
                  {groupByCreditor(rows).map((g) => g.items.length > 1 ? (
                    <GroupRow key={g.key} title={g.key} items={g.items} open={open} setOpen={setOpen} eventsFor={eventsFor} onSaved={load} />
                  ) : (
                    <LiabilityRow key={g.items[0].id} l={g.items[0]} open={!!open[g.items[0].id]} toggle={() => setOpen((o) => ({ ...o, [g.items[0].id]: !o[g.items[0].id] }))} events={eventsFor(g.items[0].id)} onSaved={load} />
                  ))}
                </CardContent>
              </Card>
            );
          })}

          {notCounted.length > 0 && (
            <Card className="border-dashed">
              <CardHeader className="pb-1">
                <CardTitle className="text-[14px] text-ink-2">Not counted — needs check · {notCounted.length}</CardTitle>
                <p className="text-[12px] text-ink-4">Rows from older data that no current source confirms. Kept for review; excluded from every total.</p>
              </CardHeader>
              <CardContent className="space-y-0.5">
                {notCounted.map((l) => (
                  <LiabilityRow key={l.id} l={l} open={!!open[l.id]} toggle={() => setOpen((o) => ({ ...o, [l.id]: !o[l.id] }))} events={[]} onSaved={load} muted />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function groupByCreditor(rows: Liability[]): Array<{ key: string; items: Liability[] }> {
  const out: Array<{ key: string; items: Liability[] }> = [];
  const idx = new Map<string, number>();
  for (const l of rows) {
    const k = l.type === "debt" && l.creditor ? `${l.creditor}|${l.owner}` : l.id;
    if (!idx.has(k)) { idx.set(k, out.length); out.push({ key: l.type === "debt" && l.creditor ? l.creditor : l.label, items: [] }); }
    out[idx.get(k)!].items.push(l);
  }
  return out;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("rounded-full border px-2.5 py-1 text-[12px] transition-colors",
      active ? "border-green bg-green-soft text-green-ink" : "border-rule text-ink-3 hover:text-ink")}>{children}</button>
  );
}

function GroupRow({ title, items, open, setOpen, eventsFor, onSaved }: {
  title: string; items: Liability[]; open: Record<string, boolean>; setOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  eventsFor: (id: string) => EventRow[]; onSaved: () => void;
}) {
  const key = `group:${title}`;
  const first = items[0];
  const sum = items.reduce((a, l) => a + (l.balance ?? 0), 0);
  const isOpen = !!open[key];
  return (
    <div className="rounded-md border border-rule/60">
      <button onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))} className="grid w-full grid-cols-2 items-center gap-3 px-2 py-2 text-left hover:bg-bg-elev md:grid-cols-[2fr_0.8fr_1.4fr_1.1fr_0.4fr]">
        <div className="col-span-2 md:col-span-1">
          <div className="text-[13px] font-medium text-ink">{title} · {items.length} invoices</div>
          <div className="text-[11px] text-ink-4">{[first.entity, first.pool === "business" ? "Business plan" : null].filter(Boolean).join(" · ")}</div>
        </div>
        <OwnerTag owner={first.owner} />
        <div className="text-right">
          <div className="text-[13px] font-medium tabular text-ink">{usd2(sum)}</div>
          <AsOf asOf={first.balanceAsOf} source={first.balanceSource} />
        </div>
        <div className="text-right text-[12px] text-ink-3">{first.balanceNote ? "being reconciled" : ""}</div>
        <span className="flex justify-end text-ink-4">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      {isOpen && (
        <div className="border-t border-rule/60 pl-3">
          {first.balanceNote && <p className="px-2 pt-2 text-[12px] text-ink-3">{first.balanceNote}</p>}
          {items.map((l) => (
            <LiabilityRow key={l.id} l={l} open={!!open[l.id]} toggle={() => setOpen((o) => ({ ...o, [l.id]: !o[l.id] }))} events={eventsFor(l.id)} onSaved={onSaved} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiabilityRow({ l, open, toggle, events, onSaved, muted }: { l: Liability; open: boolean; toggle: () => void; events: EventRow[]; onSaved: () => void; muted?: boolean }) {
  return (
    <div id={l.id} className={cn("rounded-md", open && "bg-bg-elev/60", muted && "opacity-70")}>
      <button onClick={toggle} className="grid w-full grid-cols-2 items-center gap-3 px-2 py-2 text-left hover:bg-bg-elev md:grid-cols-[2fr_0.8fr_1.4fr_1.1fr_0.4fr]">
        <div className="col-span-2 md:col-span-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink">
            {l.label}
            {l.closed && <span className="rounded bg-bg-elev px-1.5 text-[10px] uppercase text-ink-4">closed</span>}
            {l.alert && <span className="h-1.5 w-1.5 rounded-full bg-danger" title={l.alert} />}
          </div>
          <div className="text-[11px] text-ink-4">
            {[l.type === "card" ? "Credit card" : l.creditor, l.accountRef && l.type === "debt" ? l.accountRef : null, l.entity, l.pool === "business" ? "Business plan" : null].filter(Boolean).join(" · ")}
          </div>
        </div>
        <OwnerTag owner={l.owner} />
        <div className="text-right">
          <div className={cn("text-[13px] font-medium tabular", l.balance == null ? "text-danger" : "text-ink")}>{l.balance == null ? "unknown" : usd2(l.balance)}</div>
          <AsOf asOf={l.balanceAsOf} source={l.balanceSource} />
        </div>
        <div className="text-right">
          <div className="text-[13px] tabular text-ink-2">{paymentText(l)}</div>
          <div className="text-[11px] text-ink-4">{dueText(l)}</div>
        </div>
        <span className="flex justify-end text-ink-4">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      {open && <Details l={l} events={events} onSaved={onSaved} />}
    </div>
  );
}

function Details({ l, events, onSaved }: { l: Liability; events: EventRow[]; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function markEvent(id: string, status: string) {
    setBusy(id); setErr(null);
    try {
      const r = await fetch("/api/personal/registry", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event", id, status }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-2 px-3 pb-3 text-[12px]">
      {l.alert && <p className="rounded-md bg-danger-tint px-2 py-1.5 text-danger">{l.alert}</p>}
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {l.standingNote && <Fact label="Status">{l.standingNote}{l.standingSince ? ` (since ${dateLong(l.standingSince)})` : ""}</Fact>}
        {l.balanceNote && <Fact label="Balance note">{l.balanceNote}</Fact>}
        <Fact label="APR">{l.apr != null ? `${l.apr}%` : "not set"}</Fact>
        {l.type === "card" && <Fact label="Limit">{l.limit != null ? `${usd(l.limit)}${l.utilization != null ? ` · ${Math.round(l.utilization * 100)}% used` : ""}` : "not set"}</Fact>}
        {l.monthlyPayment != null && l.frequency !== "monthly" && <Fact label="Per month">{usd2(l.monthlyPayment)}</Fact>}
        {l.maturityDate && <Fact label="Pay off by">{dateLong(l.maturityDate)}</Fact>}
        <Fact label="Pool">{l.pool === "business" ? "Business plan (paid from the business pool)" : "Personal"}</Fact>
      </div>
      {events.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-4">Dates</div>
          <div className="space-y-0.5">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2">
                <span className="w-28 font-mono text-[11px] text-ink-3">{dateShort(e.date)}{e.endDate ? `–${dateShort(e.endDate)}` : ""}{e.time ? ` ${e.time}` : ""}</span>
                <span className={cn("flex-1", e.status !== "planned" && "text-ink-4 line-through")}>{e.title}</span>
                <span className="tabular text-ink-2">{money(e.amount)}</span>
                {e.status === "planned" ? (
                  <button onClick={() => markEvent(e.id, "done")} disabled={!!busy} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-3 hover:bg-bg-elev hover:text-green-ink">
                    {busy === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Done
                  </button>
                ) : <span className="text-[11px] uppercase text-ink-4">{e.status}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {err && <p className="text-danger">{err}</p>}
      {edit ? <EditForm l={l} onDone={() => { setEdit(false); onSaved(); }} onCancel={() => setEdit(false)} /> : (
        <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>Edit</Button>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-ink-4">{label}: </span><span className="text-ink-2">{children}</span></div>;
}

function EditForm({ l, onDone, onCancel }: { l: Liability; onDone: () => void; onCancel: () => void }) {
  const isCard = l.type === "card";
  const [f, setF] = useState<Record<string, string>>({
    owner: l.owner ?? "", balance: l.balance != null ? String(l.balance) : "", balanceAsOf: l.balanceAsOf ?? "", balanceSource: l.balanceSource ?? "",
    standing: l.standing, payment: l.payment != null ? String(l.payment) : "", dueDay: l.dueDay != null ? String(l.dueDay) : "",
    nextDueDate: l.nextDueDate ?? "", apr: l.apr != null ? String(l.apr) : "", limit: l.limit != null ? String(l.limit) : "",
    standingNote: l.standingNote ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const balanceChanged = f.balance !== (l.balance != null ? String(l.balance) : "");

  async function save() {
    if (!f.owner) { setErr("Owner is required"); return; }
    setBusy(true); setErr(null);
    try {
      // A new balance without a new date/source gets "today · Manual entry" on the server.
      const sameAsOf = f.balanceAsOf === (l.balanceAsOf ?? "") && f.balanceSource === (l.balanceSource ?? "");
      const dated = balanceChanged && sameAsOf ? {} : { balanceAsOf: f.balanceAsOf, balanceSource: f.balanceSource };
      const body = isCard
        ? { type: "card", id: l.id, owner: f.owner, standing: f.standing, minPaymentDue: f.payment, dueDay: f.dueDay, nextDueDate: f.nextDueDate, apr: f.apr, creditLimit: f.limit, standingNote: f.standingNote, ...(balanceChanged ? { currentBalance: f.balance } : {}), ...dated }
        : { type: "debt", id: l.id, owner: f.owner, standing: f.standing, monthlyPayment: f.payment, dueDay: f.dueDay, nextDueDate: f.nextDueDate, apr: f.apr, standingNote: f.standingNote, ...(balanceChanged && f.balance !== "" ? { balance: f.balance } : {}), ...dated };
      const r = await fetch("/api/personal/registry", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const field = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><label className="mb-1 block text-[11px] text-ink-3">{label}</label><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></div>
  );
  return (
    <div className="rounded-md border border-rule bg-surface p-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><label className="mb-1 block text-[11px] text-ink-3">Owner *</label>
          <select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]">
            <option value="">—</option>{OWNERS.map((o) => <option key={o}>{o}</option>)}
          </select></div>
        <div><label className="mb-1 block text-[11px] text-ink-3">Status</label>
          <select value={f.standing} onChange={(e) => setF({ ...f, standing: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]">
            {STANDINGS.map((s) => <option key={s} value={s}>{STANDING_META[s].label}</option>)}
          </select></div>
        {field("balance", "Balance", { inputMode: "decimal", placeholder: "unknown" })}
        {field("balanceAsOf", "Balance as of", { type: "date" })}
        <div className="col-span-2">{field("balanceSource", "Source of the balance", { placeholder: "e.g. Statement 2026-11-05" })}</div>
        {field("payment", isCard ? "Statement minimum" : "Payment per period", { inputMode: "decimal", placeholder: "not set" })}
        {field("dueDay", "Due day (1–31)", { inputMode: "numeric" })}
        {field("nextDueDate", "Next due date", { type: "date" })}
        {field("apr", "APR %", { inputMode: "decimal", placeholder: "not set" })}
        {isCard && field("limit", "Credit limit", { inputMode: "decimal", placeholder: "not set" })}
        <div className="col-span-2 sm:col-span-4">{field("standingNote", "Note")}</div>
      </div>
      {balanceChanged && f.balanceAsOf === (l.balanceAsOf ?? "") && <p className="mt-1.5 text-[11px] text-ink-4">The new balance will be dated today with source “Manual entry” unless you set them.</p>}
      {err && <p className="mt-1.5 text-[12px] text-danger">{err}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AddObligation({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ owner: "", description: "", creditor: "", balance: "", balanceAsOf: new Date().toISOString().slice(0, 10), balanceSource: "", standing: "current", monthlyPayment: "", dueDay: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!f.owner) { setErr("Owner is required"); return; }
    if (!f.description) { setErr("Enter what the obligation is"); return; }
    if (!f.balanceSource) { setErr("Enter where the balance comes from"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/personal/registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "debt", ...f, balance: f.balance === "" ? null : f.balance, paymentFrequency: "monthly" }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "failed");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><label className="mb-1 block text-[11px] text-ink-3">{label}</label><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></div>
  );
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-[14px]">New obligation (personal pool)</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div><label className="mb-1 block text-[11px] text-ink-3">Owner *</label>
            <select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]">
              <option value="">—</option>{OWNERS.map((o) => <option key={o}>{o}</option>)}
            </select></div>
          <div className="col-span-1 sm:col-span-2">{input("description", "What is it *", { placeholder: "e.g. Dental office payment plan" })}</div>
          {input("creditor", "Creditor")}
          {input("balance", "Balance (blank = unknown)", { inputMode: "decimal" })}
          {input("balanceAsOf", "As of", { type: "date" })}
          <div className="col-span-2">{input("balanceSource", "Source *", { placeholder: "e.g. Letter 2026-10-20" })}</div>
          <div><label className="mb-1 block text-[11px] text-ink-3">Status</label>
            <select value={f.standing} onChange={(e) => setF({ ...f, standing: e.target.value })} className="h-9 w-full rounded-md border border-rule bg-bg px-2 text-[13px]">
              {STANDINGS.map((s) => <option key={s} value={s}>{STANDING_META[s].label}</option>)}
            </select></div>
          {input("monthlyPayment", "Payment / month", { inputMode: "decimal" })}
          {input("dueDay", "Due day", { inputMode: "numeric" })}
        </div>
        {err && <p className="mt-1.5 text-[12px] text-danger">{err}</p>}
        <Button size="sm" className="mt-3" onClick={save} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />} Save</Button>
      </CardContent>
    </Card>
  );
}

