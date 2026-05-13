"use client";

import { useCallback, useEffect, useState } from "react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { KpiCard, Panel, PanelHeader, PanelBody } from "@/components/kit";
import { HeartPulse, AlertTriangle, ShieldCheck } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface Snapshot {
  status: string | null;
  orderDefectRate: number | null;
  negativeFeedbackRate: number | null;
  atozClaimsRate: number | null;
  chargebackRate: number | null;
  lateShipmentRate10d: number | null;
  lateShipmentRate30d: number | null;
  preFulfillmentCancelRate: number | null;
  validTrackingRate: number | null;
  onTimeDeliveryRate: number | null;
  accountHealthRating: number | null;
  accountHealthRatingStatus: string | null;
  lsr10dLate: number | null;
  lsr10dTotal: number | null;
  lsr30dLate: number | null;
  lsr30dTotal: number | null;
  cancelCancelled: number | null;
  cancelTotal: number | null;
  vtrTracked: number | null;
  vtrTotal: number | null;
  otdrOnTime: number | null;
  otdrTotal: number | null;
  syncedAt: string | null;
}

interface PolicyCat {
  category: string;
  displayName: string;
  count: number;
  status: string;
}

interface StoreRow {
  storeId: string;
  storeName: string;
  storeIndex: number | null;
  sellerId: string | null;
  snapshot: Snapshot | null;
  policyCategories: PolicyCat[];
  lastSyncedAt: string | null;
}

interface Response {
  stores: StoreRow[];
  summary: {
    total: number;
    configured: number;
    breaches: number;
    healthy: number;
    worstAhr: { store: string; value: number } | null;
    worstOdr: { store: string; value: number } | null;
    openPolicyViolations: number;
  };
}

export function AmazonHealthTab({ refreshNonce }: { refreshNonce: number }) {
  const { selectedStoreIds, isAllSelected, hasAmazon } = useStoreFilter();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{
    storeId: string;
    category: string;
    displayName: string;
  } | null>(null);

  const filterKey = [...selectedStoreIds].sort().join(",");
  const load = useCallback(async () => {
    if (!hasAmazon) return;
    setLoading(true);
    try {
      const qs = isAllSelected ? "" : `?storeIds=${selectedStoreIds.join(",")}`;
      const r = await fetch(`/api/account-health/amazon${qs}`);
      const j = (await r.json()) as Response;
      setData(j);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, isAllSelected, hasAmazon]);

  useEffect(() => {
    load();
    // Light polling so the snapshot stays fresh while the operator watches
    // the page; cron writes happen every 4 hours but they're not aligned
    // with when the user opens the tab.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load, refreshNonce]);

  if (loading && !data) return <div className="text-[12px] text-ink-3">Loading…</div>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      {/* Hero row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="At risk"
          value={
            data.summary.configured > 0
              ? `${data.summary.breaches} of ${data.summary.configured}`
              : "No data"
          }
          icon={<HeartPulse size={14} />}
          iconVariant={data.summary.breaches > 0 ? "danger" : "default"}
          trend={{
            value:
              data.summary.breaches > 0
                ? "stores need action"
                : "all stores OK",
          }}
        />
        <KpiCard
          label="Lowest AHR"
          value={data.summary.worstAhr ? data.summary.worstAhr.value : "—"}
          icon={<ShieldCheck size={14} />}
          iconVariant={
            data.summary.worstAhr && data.summary.worstAhr.value < 160
              ? "danger"
              : data.summary.worstAhr && data.summary.worstAhr.value < 200
                ? "warn"
                : "default"
          }
          trend={
            data.summary.worstAhr
              ? {
                  value: data.summary.worstAhr.store,
                  subText: zoneLabel(data.summary.worstAhr.value),
                }
              : undefined
          }
        />
        <KpiCard
          label="Open policy violations"
          value={data.summary.openPolicyViolations}
          icon={<AlertTriangle size={14} />}
          iconVariant={
            data.summary.openPolicyViolations > 0 ? "danger" : "default"
          }
          trend={{
            value:
              data.summary.openPolicyViolations > 0
                ? "across all stores"
                : "none",
          }}
        />
      </div>

      {/* AHR per store */}
      <Panel>
        <PanelHeader title="Account Health Rating" />
        <PanelBody className="space-y-4">
          {data.stores.map((s) => (
            <AhrRow key={s.storeId} row={s} />
          ))}
          {data.stores.length === 0 && (
            <div className="text-[12px] text-ink-3">No Amazon stores in current selection.</div>
          )}
        </PanelBody>
      </Panel>

      {/* Policy Compliance */}
      <Panel>
        <PanelHeader title="Policy compliance" />
        <PanelBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="border-b border-rule">
                <tr className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-ink-3">
                  <th className="px-4 py-2.5 text-left font-medium">Category</th>
                  {data.stores.map((s) => (
                    <th
                      key={s.storeId}
                      className="px-4 py-2.5 text-center font-medium"
                    >
                      {s.storeName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.stores[0]?.policyCategories ?? []).map((cat) => (
                  <tr key={cat.category} className="border-b border-rule last:border-0">
                    <td className="px-4 py-2 text-ink">{cat.displayName}</td>
                    {data.stores.map((s) => {
                      const c = s.policyCategories.find(
                        (p) => p.category === cat.category
                      );
                      const count = c?.count ?? 0;
                      const status = c?.status ?? "OK";
                      return (
                        <td
                          key={`${s.storeId}-${cat.category}`}
                          className="px-4 py-2 text-center tabular"
                        >
                          {count > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setDrill({
                                  storeId: s.storeId,
                                  category: cat.category,
                                  displayName: cat.displayName,
                                })
                              }
                              className={cn(
                                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                                status === "CRITICAL"
                                  ? "bg-danger-tint text-danger"
                                  : "bg-warn-tint text-warn-strong"
                              )}
                            >
                              {count}
                              <span aria-hidden>↗</span>
                            </button>
                          ) : (
                            <span className="text-ink-3">0</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>

      {/* Per-store Performance */}
      <div className="grid gap-3 lg:grid-cols-2">
        {data.stores.map((s) => (
          <PerformanceCard key={s.storeId} row={s} />
        ))}
      </div>

      <Sheet open={!!drill} onOpenChange={(open) => !open && setDrill(null)}>
        <SheetContent side="right" className="w-full sm:max-w-[600px]">
          <SheetHeader>
            <SheetTitle>{drill?.displayName ?? "Violations"}</SheetTitle>
            <SheetDescription>
              Listings with this violation type for this store
            </SheetDescription>
          </SheetHeader>
          {drill && (
            <DrillDown storeId={drill.storeId} category={drill.category} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// AHR zones — driven by Amazon's actual deactivation policy:
//   <160  Critical: imminent deactivation risk → red
//   160-199 At Risk of Deactivation → red (same tier, slightly milder)
//   200-399 Warned by Amazon → amber/warn
//   ≥400  Good → green
function zoneLabel(ahr: number) {
  if (ahr < 160) return "Critical";
  if (ahr < 200) return "At Risk of Deactivation";
  if (ahr < 400) return "Warned";
  return "Good";
}

function ahrBarClass(ahr: number | null): string {
  if (ahr == null) return "bg-bg-elev";
  if (ahr < 160) return "bg-danger";
  if (ahr < 200) return "bg-danger/80";
  if (ahr < 400) return "bg-warn-strong";
  return "bg-green";
}

function ahrTextClass(ahr: number | null): string {
  if (ahr == null) return "text-ink-3";
  if (ahr < 200) return "text-danger";
  if (ahr < 400) return "text-warn-strong";
  return "text-green";
}

function AhrRow({ row }: { row: StoreRow }) {
  const ahr = row.snapshot?.accountHealthRating ?? null;
  const pct =
    ahr != null ? Math.min(100, Math.max(0, (ahr / 1000) * 100)) : null;
  const zone = ahr != null ? zoneLabel(ahr) : "—";
  const barCls = ahrBarClass(ahr);
  const numCls = ahrTextClass(ahr);

  return (
    <div>
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-medium text-ink">{row.storeName}</span>
        <span className="tabular">
          <span className={cn("font-semibold", numCls)}>
            {ahr != null ? ahr : "—"}
          </span>
          <span className="ml-1 text-ink-3">/ 1000</span>
          <span className={cn("ml-2 text-[11px]", numCls)}>
            {ahr != null ? zone : "no AHR yet"}
          </span>
        </span>
      </div>
      <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-bg-elev">
        <div
          className={cn("h-full transition-all", barCls)}
          style={{ width: pct != null ? `${pct}%` : "0%" }}
        />
        {/* Threshold marker at 200 (deactivation line) */}
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-ink/40"
          style={{ left: "20%" }}
          aria-hidden
        />
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] font-mono uppercase tracking-wider text-ink-3">
        <span>0</span>
        <span>200</span>
        <span>400</span>
        <span>600</span>
        <span>800</span>
        <span>1000</span>
      </div>
    </div>
  );
}

function PerformanceCard({ row }: { row: StoreRow }) {
  const s = row.snapshot;
  const lateOver10 = (s?.lateShipmentRate10d ?? 0) >= 4;
  const lateOver30 = (s?.lateShipmentRate30d ?? 0) >= 4;
  const cancelOver = (s?.preFulfillmentCancelRate ?? 0) >= 2.5;
  const vtrUnder = (s?.validTrackingRate ?? 100) <= 95;
  const otdrUnder =
    s?.onTimeDeliveryRate != null && s.onTimeDeliveryRate <= 90;

  return (
    <Panel>
      <PanelHeader
        title={row.storeName}
        right={
          <span className="text-[11px] text-ink-3">
            {s?.syncedAt
              ? `Synced ${new Date(s.syncedAt).toLocaleString()}`
              : "Never synced"}
          </span>
        }
      />
      <PanelBody className="space-y-3 text-[12.5px]">
        <Section title="CUSTOMER SERVICE (60d)">
          <Row
            label="Order defect rate"
            target="< 1%"
            value={fmtPct(s?.orderDefectRate)}
            bad={(s?.orderDefectRate ?? 0) >= 1}
          />
          <Row label="Negative feedback" value={fmtPct(s?.negativeFeedbackRate)} />
          <Row label="A-to-Z claims" value={fmtPct(s?.atozClaimsRate)} />
          <Row label="Chargebacks" value={fmtPct(s?.chargebackRate)} />
        </Section>
        <Section title="SHIPPING PERFORMANCE">
          <Row
            label="Late shipment (10d)"
            target="< 4%"
            value={fmtPct(s?.lateShipmentRate10d)}
            bad={lateOver10}
            sub={
              s?.lsr10dLate != null && s?.lsr10dTotal != null
                ? `(${s.lsr10dLate}/${s.lsr10dTotal})`
                : undefined
            }
          />
          <Row
            label="Late shipment (30d)"
            target="< 4%"
            value={fmtPct(s?.lateShipmentRate30d)}
            bad={lateOver30}
            sub={
              s?.lsr30dLate != null && s?.lsr30dTotal != null
                ? `(${s.lsr30dLate}/${s.lsr30dTotal})`
                : undefined
            }
          />
          <Row
            label="Cancel rate (7d)"
            target="< 2.5%"
            value={fmtPct(s?.preFulfillmentCancelRate)}
            bad={cancelOver}
            sub={
              s?.cancelCancelled != null && s?.cancelTotal != null
                ? `(${s.cancelCancelled}/${s.cancelTotal})`
                : undefined
            }
          />
          <Row
            label="Valid tracking (30d)"
            target="> 95%"
            value={fmtPct(s?.validTrackingRate)}
            bad={vtrUnder}
            sub={
              s?.vtrTracked != null && s?.vtrTotal != null
                ? `(${s.vtrTracked}/${s.vtrTotal})`
                : undefined
            }
          />
          <Row
            label="On-time delivery (14d)"
            target="> 90%"
            value={fmtPct(s?.onTimeDeliveryRate)}
            bad={otdrUnder}
            sub={
              s?.otdrOnTime != null && s?.otdrTotal != null
                ? `(${s.otdrOnTime}/${s.otdrTotal})`
                : undefined
            }
          />
        </Section>
      </PanelBody>
    </Panel>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
        {title}
      </div>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  bad,
  sub,
  target,
}: {
  label: string;
  value: string;
  bad?: boolean;
  sub?: string;
  /** Amazon-defined acceptable threshold for this metric, e.g. "< 4%".
   *  Shown next to the label so the operator doesn't have to remember it. */
  target?: string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-ink-2">
        {label}
        {target && (
          <span className="ml-1.5 text-[10.5px] font-mono uppercase text-ink-3">
            target {target}
          </span>
        )}
      </span>
      <span
        className={cn(
          "tabular font-medium",
          bad ? "text-danger" : "text-ink"
        )}
      >
        {value}
        {sub && <span className="ml-1.5 text-[11px] text-ink-3">{sub}</span>}
      </span>
    </div>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}%`;
}

function DrillDown({
  storeId,
  category,
}: {
  storeId: string;
  category: string;
}) {
  const [data, setData] = useState<{
    details: Array<{
      id: string;
      asin: string | null;
      sku: string | null;
      listingTitle: string | null;
      violationType: string;
      severity: string;
      message: string;
      reportedAt: string;
      status: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Reset state from inside the async callback rather than synchronously
    // in the effect body — keeps React 19 compiler happy.
    fetch(`/api/account-health/amazon/violations/${storeId}/${category}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) {
          setData(j);
          setLoading(false);
        }
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [storeId, category]);

  if (loading) return <div className="mt-4 text-[12px] text-ink-3">Loading…</div>;
  if (!data || data.details.length === 0)
    return (
      <div className="mt-4 text-[12px] text-ink-3">
        No detailed listings yet. Real Amazon data lands once the SP-API
        Selling Partner Insights role is approved.
      </div>
    );

  return (
    <div className="mt-4 space-y-2">
      {data.details.map((d) => (
        <div
          key={d.id}
          className="rounded-md border border-rule bg-surface-tint p-3 text-[12px]"
        >
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-ink truncate">
              {d.listingTitle ?? d.asin ?? d.sku ?? "Untitled listing"}
            </span>
            <span
              className={cn(
                "ml-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-mono uppercase",
                d.severity === "CRITICAL"
                  ? "bg-danger-tint text-danger"
                  : "bg-warn-tint text-warn-strong"
              )}
            >
              {d.severity}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-ink-3">
            {d.asin && <span>ASIN {d.asin}</span>}
            {d.sku && <span className="ml-2">SKU {d.sku}</span>}
            <span className="ml-2">{d.violationType}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-ink-2">{d.message}</div>
        </div>
      ))}
    </div>
  );
}
