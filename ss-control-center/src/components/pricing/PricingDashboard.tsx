"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { KpiCard, Panel, PanelHeader, Btn, StatusChip } from "@/components/kit";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Status = "HIGH" | "LOW" | "OK" | "UNKNOWN";

interface Row {
  store: number;
  sku: string;
  asin: string;
  title: string;
  total: number;
  cooler: string;
  current: number | null;
  target: number;
  ceiling: number;
  floor: number;
  suggested: number;
  deltaPct: number | null;
  status: Status;
}

interface Snapshot {
  updatedAt: string;
  stores: number[];
  counts: { total: number; high: number; low: number; ok: number; unknown: number };
  rows: Row[];
}

const STATUS_CHIP: Record<Status, { variant: "danger" | "warn" | "ok" | "neutral"; label: string }> = {
  HIGH: { variant: "danger", label: "Too high" },
  LOW: { variant: "warn", label: "Too low" },
  OK: { variant: "ok", label: "In range" },
  UNKNOWN: { variant: "neutral", label: "No price" },
};

const FILTERS: Array<{ key: "ALL" | Status; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "HIGH", label: "Too high" },
  { key: "LOW", label: "Too low" },
  { key: "OK", label: "In range" },
];

const money = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

export function PricingDashboard({ storeIndex = 1 }: { storeIndex?: number }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | Status>("ALL");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/pricing/uncrustables${refresh ? "?refresh=1" : ""}`,
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "load failed");
      setSnap(json.snapshot);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = useMemo(
    () => (snap?.rows ?? []).filter((r) => r.store === storeIndex),
    [snap, storeIndex],
  );
  const counts = useMemo(
    () => ({
      total: rows.length,
      high: rows.filter((r) => r.status === "HIGH").length,
      low: rows.filter((r) => r.status === "LOW").length,
      ok: rows.filter((r) => r.status === "OK").length,
    }),
    [rows],
  );
  const shown = useMemo(
    () => (filter === "ALL" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-2">
          {snap
            ? `${counts.total} Uncrustables listings · updated ${new Date(snap.updatedAt).toLocaleString()}`
            : "Pricing guardrails — Uncrustables"}
        </div>
        <Btn variant="outline" onClick={() => load(true)} loading={loading}>
          Refresh from Amazon
        </Btn>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Listings" value={snap ? counts.total : "—"} />
        <KpiCard label="Too high" value={snap ? counts.high : "—"} iconVariant="danger" />
        <KpiCard label="Too low" value={snap ? counts.low : "—"} iconVariant="warn" />
        <KpiCard label="In range" value={snap ? counts.ok : "—"} />
      </div>

      {err && (
        <div className="rounded-md border border-danger/20 bg-danger-tint px-3 py-2 text-[13px] text-danger">
          {err}
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Uncrustables price guardrails"
          count={shown.length}
          right={
            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={
                    "rounded px-2 py-1 text-[12px] " +
                    (filter === f.key
                      ? "bg-green text-green-cream"
                      : "text-ink-2 hover:bg-bg-elev")
                  }
                >
                  {f.label}
                </button>
              ))}
            </div>
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Listing</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Cooler</TableHead>
              <TableHead className="text-right">Current</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Floor / Ceiling</TableHead>
              <TableHead className="text-right">Δ vs target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Policy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => {
              const chip = STATUS_CHIP[r.status];
              return (
                <TableRow key={`${r.store}-${r.sku}`}>
                  <TableCell className="max-w-[320px]">
                    <div className="truncate text-[13px] text-ink" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-[11px] text-ink-2">
                      {r.sku} · store{r.store}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular">{r.total}</TableCell>
                  <TableCell>{r.cooler}</TableCell>
                  <TableCell className="text-right tabular">{money(r.current)}</TableCell>
                  <TableCell className="text-right tabular">{money(r.target)}</TableCell>
                  <TableCell className="text-right tabular text-ink-2">
                    {money(r.floor)} / {money(r.ceiling)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {r.deltaPct == null ? "—" : `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct}%`}
                  </TableCell>
                  <TableCell>
                    <StatusChip variant={chip.variant}>{chip.label}</StatusChip>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-[11px] text-ink-2" title="Base price is canonical; promotions use Amazon Coupons">
                      Base locked
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
            {!shown.length && !loading && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-ink-2">
                  No listings in this view.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
