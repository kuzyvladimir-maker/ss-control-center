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

      {/* Performance metrics — single matrix (rows = metrics × cols = stores)
          replaces the old per-store cards. Much denser on a wide screen and
          stays usable on mobile via horizontal scroll, same as Policy table. */}
      <PerformanceMatrix stores={data.stores} />

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

// AHR zones — Amazon's actual policy has a single deactivation threshold
// at 200. Anything ≥ 200 is "Healthy"; Amazon does not warn or downgrade
// accounts within the 200-1000 band. Below 200 is "At Risk of Deactivation"
// (the literal label Amazon uses); below 100 we surface as "Critical" so
// the imminent-risk case stands out visually.
function zoneLabel(ahr: number) {
  if (ahr < 100) return "Critical";
  if (ahr < 200) return "At Risk of Deactivation";
  return "Healthy";
}

function ahrBarClass(ahr: number | null): string {
  if (ahr == null) return "bg-bg-elev";
  if (ahr < 100) return "bg-danger";
  if (ahr < 200) return "bg-warn-strong";
  // `--green-light` (#6FAA8E) — fresh sage between `--green-mid` and
  // `--green-soft2`, added 2026-05-15 specifically for this bar. The
  // brand `--green` and `--green-mid` both read as near-black when
  // stretched into a 2px progress bar; this token reads as healthy
  // without losing the Salutem family.
  return "bg-green-light";
}

function ahrTextClass(ahr: number | null): string {
  if (ahr == null) return "text-ink-3";
  if (ahr < 100) return "text-danger";
  if (ahr < 200) return "text-warn-strong";
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

// Single metric × store matrix. Replaces five per-store cards: rows are the
// Account Health metrics, columns are stores. Customer Service and Shipping
// Performance are separated by section bands. Breaches turn red. Each cell
// also shows the (numerator/denominator) underneath where Amazon supplies it.
type MetricKey =
  | "orderDefectRate"
  | "negativeFeedbackRate"
  | "atozClaimsRate"
  | "chargebackRate"
  | "lateShipmentRate10d"
  | "lateShipmentRate30d"
  | "preFulfillmentCancelRate"
  | "validTrackingRate"
  | "onTimeDeliveryRate";

interface MetricDef {
  key: MetricKey;
  label: string;
  target: string;
  /** Returns true if Amazon's threshold is breached. */
  isBad: (v: number | null | undefined) => boolean;
  /** Returns true if the value is "approaching" the threshold but hasn't
   *  crossed it yet — drives the yellow tint on healthy-but-close cells.
   *  Optional; metrics without a published target leave this off. */
  isWarn?: (v: number | null | undefined) => boolean;
  /** Reads the (X of Y) pair from a snapshot, if Amazon supplied it. */
  fraction: (s: SnapshotLike) => string | null;
}

type SnapshotLike = StoreRow["snapshot"];

function frac(num: number | null | undefined, den: number | null | undefined): string | null {
  if (num == null || den == null) return null;
  return `${num}/${den}`;
}

// Warn margins are ~10% of the threshold value — close enough that the
// operator should pay attention before Amazon raises the alarm.
const METRICS_CUSTOMER: MetricDef[] = [
  {
    key: "orderDefectRate",
    label: "Order defect rate",
    target: "< 1%",
    isBad: (v) => (v ?? 0) >= 1,
    isWarn: (v) => (v ?? 0) >= 0.75 && (v ?? 0) < 1,
    fraction: () => null,
  },
  {
    key: "negativeFeedbackRate",
    label: "Negative feedback",
    target: "",
    isBad: () => false,
    fraction: () => null,
  },
  {
    key: "atozClaimsRate",
    label: "A-to-Z claims",
    target: "",
    isBad: () => false,
    fraction: () => null,
  },
  {
    key: "chargebackRate",
    label: "Chargebacks",
    target: "",
    isBad: () => false,
    fraction: () => null,
  },
];

const METRICS_SHIPPING: MetricDef[] = [
  {
    key: "lateShipmentRate10d",
    label: "Late shipment (10d)",
    target: "< 4%",
    isBad: (v) => (v ?? 0) >= 4,
    isWarn: (v) => (v ?? 0) >= 3 && (v ?? 0) < 4,
    fraction: (s) => frac(s?.lsr10dLate, s?.lsr10dTotal),
  },
  {
    key: "lateShipmentRate30d",
    label: "Late shipment (30d)",
    target: "< 4%",
    isBad: (v) => (v ?? 0) >= 4,
    isWarn: (v) => (v ?? 0) >= 3 && (v ?? 0) < 4,
    fraction: (s) => frac(s?.lsr30dLate, s?.lsr30dTotal),
  },
  {
    key: "preFulfillmentCancelRate",
    label: "Cancel rate (7d)",
    target: "< 2.5%",
    isBad: (v) => (v ?? 0) >= 2.5,
    isWarn: (v) => (v ?? 0) >= 2 && (v ?? 0) < 2.5,
    fraction: (s) => frac(s?.cancelCancelled, s?.cancelTotal),
  },
  {
    key: "validTrackingRate",
    label: "Valid tracking (30d)",
    target: "> 95%",
    isBad: (v) => (v ?? 100) <= 95,
    isWarn: (v) => (v ?? 100) <= 97 && (v ?? 100) > 95,
    fraction: (s) => frac(s?.vtrTracked, s?.vtrTotal),
  },
  {
    key: "onTimeDeliveryRate",
    label: "On-time delivery (14d)",
    target: "> 90%",
    isBad: (v) => v != null && v <= 90,
    isWarn: (v) => v != null && v <= 92 && v > 90,
    fraction: (s) => frac(s?.otdrOnTime, s?.otdrTotal),
  },
];

function PerformanceMatrix({ stores }: { stores: StoreRow[] }) {
  return (
    <Panel>
      <PanelHeader title="Performance metrics" />
      <PanelBody className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="border-b border-rule">
              <tr className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-ink-3">
                <th className="px-4 py-2.5 text-left font-medium">Metric</th>
                <th className="px-3 py-2.5 text-left font-medium">Target</th>
                {stores.map((s) => (
                  <th
                    key={s.storeId}
                    className="px-3 py-2.5 text-center font-medium"
                  >
                    <div className="text-[11px] normal-case tracking-normal text-ink">
                      {s.storeName}
                    </div>
                    <div className="mt-0.5 text-[9.5px] font-normal normal-case tracking-normal text-ink-3">
                      {s.snapshot?.syncedAt
                        ? new Date(s.snapshot.syncedAt).toLocaleDateString()
                        : "never synced"}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionBand label="Customer service (60d)" colSpan={stores.length + 2} />
              {METRICS_CUSTOMER.map((m) => (
                <MetricRow key={m.key} metric={m} stores={stores} />
              ))}
              <SectionBand label="Shipping performance" colSpan={stores.length + 2} />
              {METRICS_SHIPPING.map((m) => (
                <MetricRow key={m.key} metric={m} stores={stores} />
              ))}
            </tbody>
          </table>
        </div>
      </PanelBody>
    </Panel>
  );
}

function SectionBand({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr className="bg-bg-elev">
      <td
        colSpan={colSpan}
        className="px-4 py-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3"
      >
        {label}
      </td>
    </tr>
  );
}

function MetricRow({
  metric,
  stores,
}: {
  metric: MetricDef;
  stores: StoreRow[];
}) {
  return (
    <tr className="border-b border-rule last:border-0">
      <td className="px-4 py-2 text-ink">{metric.label}</td>
      <td className="px-3 py-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
        {metric.target || "—"}
      </td>
      {stores.map((s) => {
        const v = s.snapshot?.[metric.key] as number | null | undefined;
        const f = s.snapshot ? metric.fraction(s.snapshot) : null;
        const bad = metric.isBad(v);
        const warn = !bad && metric.isWarn?.(v);
        // Tint the whole cell so the operator can scan the matrix and
        // see hot spots at a glance. Metrics without a published target
        // (negative feedback / a-to-z / chargebacks) stay untinted —
        // Amazon doesn't publish a hard line and any tint would be noise.
        const hasTarget = !!metric.target;
        const tone: "good" | "warn" | "danger" | "none" =
          !hasTarget || v == null
            ? "none"
            : bad
              ? "danger"
              : warn
                ? "warn"
                : "good";
        return (
          <td
            key={s.storeId}
            className={cn(
              "px-3 py-2 text-center tabular font-medium",
              tone === "danger" && "bg-danger-tint/40 text-danger",
              tone === "warn" && "bg-warn-tint/40 text-warn-strong",
              tone === "good" && "bg-green-soft/60 text-green-ink",
              tone === "none" && "text-ink"
            )}
          >
            {v != null ? `${v.toFixed(2)}%` : <span className="text-ink-3">—</span>}
            {f && (
              <span className="ml-1.5 text-[10.5px] font-normal text-ink-3">
                ({f})
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
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
