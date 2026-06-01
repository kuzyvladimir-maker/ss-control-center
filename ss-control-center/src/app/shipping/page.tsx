"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Snowflake,
  Package,
  Loader2,
  ShoppingCart,
  Sparkles,
  Pencil,
  Copy,
  Check,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Btn,
  FilterTabs,
  KpiCard,
  PageHead,
  Panel,
  PanelHeader,
  PanelBody,
  StoreAvatar,
  storeKeyFor,
  TypeTag,
} from "@/components/kit";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import FrozenRiskBadge, {
  type ShippingFrozenAlert,
} from "@/components/shipping/FrozenRiskBadge";

// ─────────────────────────────────────────────────────────────────────────
// Types — mirror what /api/shipping/dashboard returns.
// ─────────────────────────────────────────────────────────────────────────

type State = "ready_to_buy" | "need_attention" | "waiting_placed" | "bought";
type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";
type AttentionReason =
  | "no_type"
  | "mixed_order"
  | "frozen_walmart"
  | "no_packing"
  | "no_sku"
  | "budget"
  | "no_service"
  | null;

interface DashboardItem {
  sku: string;
  productId: number | null;
  productTitle: string;
  quantity: number;
  // Thumbnail URL from Veeqo (sellable / product image, whichever path
  // returns the first non-empty value — see dashboard/route.ts:pickImage).
  // Null when Veeqo has no image attached to the listing.
  imageUrl: string | null;
  knownType: "Frozen" | "Dry" | null;
}

interface DashboardOrder {
  orderId: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  channel: string | null;
  shipBy: string | null;
  timeBucket: ShipByBucket | null;
  deliverBy: string | null;
  state: State;
  needAttentionReason: AttentionReason;
  items: DashboardItem[];
  packingSignature: string | null;
  packingProfileFound: boolean | null;
  orderTotal: number;
  customerPaidShipping: number;
  currency: string;
  // Walmart-direct flow: when true, this order's label is rate-shopped +
  // bought via Walmart (not Veeqo), keyed by walmartPurchaseOrderId.
  isWalmart?: boolean;
  walmartPurchaseOrderId?: string | null;
  // Shipping recipient (Veeqo deliver_to) — name + city/state shown on the
  // row so the operator can sanity-check the destination without opening
  // Veeqo. Each can be null when Veeqo's address is missing the field.
  // `shipToState` (not `state`) to avoid colliding with the state-machine
  // `state: State` above.
  customerName?: string | null;
  city?: string | null;
  shipToState?: string | null;
}

interface PlanItem {
  id: string;
  orderNumber: string;
  carrier: string | null;
  service: string | null;
  price: number | null;
  edd: string | null;
  status: string;
  notes: string | null;
  // What the agent fed into the carrier rate lookup. Surface on the row so
  // Vladimir can sanity-check (weight off by 5 lb completely changes which
  // service the algorithm picks).
  weight: number | null;
  boxSize: string | null;
  productType: string | null;
  // v3.3 dual-date model — surface both on the card so Vladimir can
  // see at a glance what Amazon will see (labelDate) and when the
  // warehouse hands the package off (physicalShipDate). They differ
  // when the Frozen Ship Date Trick has fired.
  //   shipDateTrickApplied = !datesMatch
  // We carry both flags so the UI can pick whichever reads better.
  labelDate: string | null;
  physicalShipDate: string | null;
  shipDateTrickApplied: boolean;
  datesMatch: boolean;
  // Legacy column — same value as physicalShipDate for new plans.
  // Kept on the type so older bought rows (planned before the
  // dual-date migration) still render their ship day.
  actualShipDay: string | null;
  // Veeqo allocation id — passed through to /api/shipping/edit-package
  // so the API can also push package dims to Veeqo's allocation_package
  // endpoint, so subsequent rate quotes use the new packaging.
  allocationId: string | null;
}

interface PlanResponse {
  planId: string;
  date: string;
  orders: PlanItem[];
}

// Operator's manual rate override — fields that get sent to /api/shipping/buy
// to override the plan's algorithmic pick at purchase time. Stored in client
// state keyed by Veeqo order id; lost on page refresh.
interface RateOverride {
  carrier: string | null; // sub_carrier_id e.g. "UPS"
  service: string | null; // title e.g. "UPS® Ground"
  serviceType: string | null; // name (full Veeqo service identifier)
  subCarrierId: string | null;
  serviceCarrier: string | null;
  carrierId: string | null;
  remoteShipmentId: string | null;
  totalNetCharge: string | null;
  baseRate: string | null;
  edd: string | null; // YYYY-MM-DD
  price: number | null;
}

interface StoreTotals {
  storeId: string;
  storeName: string;
  channel: string;
  all: number;
  readyToBuy: number;
  needAttention: number;
  waitingPlaced: number;
  boughtToday: number;
}

interface DashboardResponse {
  refreshedAt: string;
  storeBreakdown: StoreTotals[];
  timeBuckets: Record<ShipByBucket, number>;
  orders: DashboardOrder[];
}

const ATTENTION_LABELS: Record<NonNullable<AttentionReason>, string> = {
  no_type: "Product type unknown",
  mixed_order: "Mixed Frozen + Dry items",
  frozen_walmart: "Frozen on Walmart (not allowed)",
  no_packing: "Packing profile missing",
  no_sku: "SKU not in database",
  budget: "Over budget for any service",
  no_service: "No carrier service available",
};

// /api/shipping/buy response shape — mirrored from buy/route.ts so the
// post-buy modal can render an itemised report.
interface BuyReportSuccess {
  orderNumber: string;
  tracking: string;
  itemId: string;
  labelPath: string | null;
  pdfSaved: boolean;
  pdfSource: "drive" | "disk" | "proxy" | "none";
  driveError: string | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
}
interface BuyReportError {
  orderNumber: string;
  error: string;
  itemId: string;
}
interface BuyReport {
  // What the user just tried to do — shapes the title.
  scope: "single" | "bulk";
  total: number;
  bought: BuyReportSuccess[];
  errors: BuyReportError[];
}

const BUCKET_TABS: { id: ShipByBucket; label: string; activeCls: string }[] = [
  { id: "overdue",  label: "Overdue",  activeCls: "border-danger bg-danger-tint text-danger" },
  { id: "today",    label: "Today",    activeCls: "border-warn-strong bg-warn-tint text-warn-strong" },
  { id: "tomorrow", label: "Tomorrow", activeCls: "border-info bg-info-tint text-info" },
  { id: "dayafter", label: "Day after", activeCls: "border-green bg-green-soft text-green-ink" },
  { id: "later",    label: "Later",    activeCls: "border-rule bg-bg-elev text-ink-2" },
];

/**
 * Quick-pick box dimensions for the Add-SKU dialog. Numbers below are the
 * actual Salutem template inventory (confirmed by Vladimir 2026-05-14).
 * If a SKU needs something off-template, operator can still type values
 * manually.
 */
const BOX_PRESETS: { label: string; l: number; w: number; h: number }[] = [
  { label: "XS",     l: 11, w: 6,  h: 8 },
  { label: "S",      l: 12, w: 12, h: 10 },
  { label: "M",      l: 13, w: 13, h: 15 },
  { label: "L",      l: 18, w: 13, h: 14 },
  { label: "XL",     l: 24, w: 13, h: 16 },
  { label: "5×5×5",  l: 5,  w: 5,  h: 5 },
  { label: "6×6×6",  l: 6,  w: 6,  h: 6 },
  { label: "7×7×6",  l: 7,  w: 7,  h: 6 },
  { label: "10×8×6", l: 10, w: 8,  h: 6 },
  { label: "12×12×6", l: 12, w: 12, h: 6 },
  { label: "12×12×8", l: 12, w: 12, h: 8 },
];

// Today's date in America/New_York (the warehouse clock), as YYYY-MM-DD.
// en-CA formats as ISO date, so we get a string that drops straight into a
// <input type="date"> and into the Walmart rate quote. Used as the default
// ship date for the page-level picker.
function todayInET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

// Add N calendar days to a YYYY-MM-DD string (UTC math, returns YYYY-MM-DD).
// Used by the Ship Date preset buttons (Today / +1 / +2).
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────────────────

export default function ShippingLabelsPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  // Per-order plan results when "Refresh rates" runs on a subset (e.g. after
  // an attention reason is fixed, we re-fetch rates only for that one order).
  const [planLoading, setPlanLoading] = useState(false);
  // Walmart orders don't get Veeqo rates — we rate-shop them through Walmart's
  // own API and synthesize PlanItem-shaped entries so the row renders exactly
  // like an Amazon row. `walmartBuyInfo` carries what /api/shipping/walmart/buy
  // needs (PO + chosen carrier/service + dims) keyed by orderNumber.
  const [walmartRates, setWalmartRates] = useState<Record<string, PlanItem>>({});
  // Per-Walmart-order rate-shop errors (e.g. "no PackingProfile for SKU:qty",
  // address invalid, etc.) so the row shows the actual reason instead of
  // sitting on "Awaiting rate" forever.
  const [walmartRateErrors, setWalmartRateErrors] = useState<Record<string, string>>({});
  const [walmartBuyInfo, setWalmartBuyInfo] = useState<
    Record<
      string,
      {
        purchaseOrderId: string;
        carrierName: string;
        serviceType: string;
        length: number;
        width: number;
        height: number;
        weight: number;
        edd: string | null;
        // The ship date this rate was quoted at — passed back to /buy so the
        // label is filed under the day it actually ships, and the buy uses
        // the same dispatch day the operator saw.
        shipByDate: string | null;
      }
    >
  >({});
  // ── Ship-date control ───────────────────────────────────────────────
  // Page-level ship date — "the day I plan to hand packages to the carrier".
  // Defaults to today (ET). Drives every Walmart rate quote (which service /
  // price / EDD comes back depends on the dispatch day) and what the Buy
  // button purchases. Per-order overrides live in shipDateByOrder; the global
  // value applies to any order without its own override.
  const [shipDateGlobal, setShipDateGlobal] = useState<string>(() =>
    todayInET(),
  );
  const [shipDateByOrder, setShipDateByOrder] = useState<
    Record<string, string>
  >({});
  // Orders currently being re-quoted (after a ship-date change) — drives a
  // small spinner on the row so the operator knows the rate is refreshing.
  const [requoting, setRequoting] = useState<Record<string, boolean>>({});
  // load() must not depend on the ship-date state (it's a []-dep useCallback
  // wired to a mount effect — re-creating it would re-pull the whole
  // dashboard on every date tweak). It reads the current global date through
  // this ref instead.
  const shipDateGlobalRef = useRef(shipDateGlobal);
  useEffect(() => {
    shipDateGlobalRef.current = shipDateGlobal;
  }, [shipDateGlobal]);
  // Walmart purchase/ship status keyed by orderNumber — drives the
  // "label bought / not yet shipped" + Mark-as-Shipped row state. Populated
  // from /api/shipping/walmart/rates (which reports an existing label / Shipped
  // status instead of a quote).
  const [walmartStatus, setWalmartStatus] = useState<
    Record<
      string,
      {
        alreadyBought: boolean;
        orderStatus: string | null;
        existingLabel: { trackingNumber: string; carrierName: string; trackingUrl?: string } | null;
      }
    >
  >({});
  const [markingShipped, setMarkingShipped] = useState<string | null>(null);
  // In-flight Rollback button. Stops double-clicks while we strip Placed.
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  // In-flight Discard Label button. Stops double-clicks during cancel.
  const [discardingLabel, setDiscardingLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [bucketFilter, setBucketFilter] = useState<ShipByBucket | null>(null);
  // Separate scope for Walmart label-bought-but-not-shipped orders.
  // When "awaiting", everything else is hidden; when "active", these
  // are hidden so they don't crowd the buy-flow list.
  const [viewScope, setViewScope] = useState<"active" | "awaiting">(
    "active",
  );
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  // Channel scope — Amazon vs Walmart. "all" shows both. The brand-styled
  // toggle buttons at the top flip EVERY count below (KPI cards, store
  // breakdown, bucket/type tabs, the list) to the chosen marketplace. An
  // order is Walmart when isWalmart is set (the dashboard route matches it
  // against the WalmartOrder table); everything else counts as Amazon.
  const [channelFilter, setChannelFilter] = useState<
    "all" | "amazon" | "walmart"
  >("all");
  // Frozen / Dry product-type filter. "all" shows everything; "Frozen" or
  // "Dry" keeps orders whose first item matches (mixed orders only match
  // when every item is the same type).
  const [typeFilter, setTypeFilter] = useState<"all" | "Frozen" | "Dry">(
    "all",
  );
  // KPI card filter. Maps to the same `state` field on each order so a
  // click on "Need attention" or "Ready to buy" filters the list.
  const [stateFilter, setStateFilter] = useState<
    "all" | "ready_to_buy" | "need_attention" | "waiting_placed"
  >("all");
  // List sort. "urgency" = the default actionability order (state → time
  // bucket); the others sort by label cost / carrier EDD / marketplace
  // deadline so the operator can re-order like Veeqo's sortable columns.
  const [sortBy, setSortBy] = useState<
    "urgency" | "cost" | "edd" | "deadline"
  >("urgency");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [buying, setBuying] = useState(false);
  const [buyMsg, setBuyMsg] = useState<string | null>(null);
  const [buyingRow, setBuyingRow] = useState<string | null>(null);
  // Per-order buy errors keyed by orderId — surfaced on the card itself.
  // The page-level buyMsg is small and easy to miss; without inline errors
  // the operator sees "spinner → spinner gone" and assumes success even
  // when the buy endpoint returned errors in its 200-OK payload.
  const [buyErrors, setBuyErrors] = useState<Record<string, string>>({});
  // Post-buy modal — forces the operator to confirm every purchase outcome
  // so labels can't silently fail to print. The dialog is the primary
  // record-of-truth; logs/shipping-buy.jsonl is the audit fallback.
  const [buyReport, setBuyReport] = useState<BuyReport | null>(null);

  // Frozen Analytics v2 alerts (Phase 3 integration). We pull all currently
  // pending alerts at low+ severity and index by orderNumber so each row can
  // surface the predicted risk + recommendations next to its Buy button.
  // Cheap query — typically dozens of rows at most.
  const [frozenAlerts, setFrozenAlerts] = useState<ShippingFrozenAlert[]>([]);

  // Merge Orders banner — groups of awaiting orders that share a delivery
  // signature (same channel/store + recipient + address). Veeqo's public
  // API has no merge endpoint, so the actual merge happens in Veeqo UI
  // via the deep-link in the banner; the banner just makes them visible.
  // See docs/wiki/merge-orders-design.md.
  const [mergeable, setMergeable] = useState<{
    groupCount: number;
    orderCount: number;
    veeqoUrl: string;
    groups: Array<{
      signature: string;
      channelKind: string;
      storeName: string | null;
      recipient: string;
      address: string;
      city: string;
      state: string;
      zip: string;
      orders: Array<{ id: string; orderNumber: string; storeName: string | null }>;
    }>;
  } | null>(null);
  const [mergeableExpanded, setMergeableExpanded] = useState(false);

  // Modal state
  const [classifyModal, setClassifyModal] = useState<DashboardOrder | null>(
    null
  );
  const [manualModal, setManualModal] = useState<DashboardOrder | null>(null);
  const [packingModal, setPackingModal] = useState<DashboardOrder | null>(null);
  const [skuModal, setSkuModal] = useState<DashboardOrder | null>(null);
  // Inline package editor — separate from the no_sku / no_packing
  // attention dialogs because it pre-fills with the CURRENT plan values
  // and writes through SkuShippingData (or PackingProfile for multi-item)
  // without forcing the operator to re-enter dimensions.
  const [editPackageModal, setEditPackageModal] = useState<DashboardOrder | null>(
    null,
  );
  // Manual rate override — pops a dialog listing every available rate from
  // Veeqo so the operator can pick anything outside the algorithm's choice.
  // Lives in React state only (no DB persistence); selected override is
  // sent to /api/shipping/buy as `overrides[itemId]` when the operator
  // clicks Buy. Lost on page refresh — operator just picks again.
  const [pickRateModal, setPickRateModal] = useState<DashboardOrder | null>(
    null,
  );
  const [rateOverrides, setRateOverrides] = useState<
    Record<string, RateOverride>
  >({});

  // Rate-shop ONE Walmart order through Walmart's API at a given ship date and
  // fold the result into the walmartRates / walmartBuyInfo / walmartStatus
  // maps. Stable ([]-deps, functional setState) so load() and the ship-date
  // change handlers can all reuse it without re-creating load. Mirrors the
  // PlanItem shape the bulk pass used to build so the row renders identically.
  const quoteWalmartOrder = useCallback(
    async (o: DashboardOrder, shipByDate: string) => {
      if (!o.walmartPurchaseOrderId) return;
      setRequoting((p) => ({ ...p, [o.orderNumber]: true }));
      const dropMaps = () => {
        setWalmartRates((p) => {
          const n = { ...p };
          delete n[o.orderNumber];
          return n;
        });
        setWalmartBuyInfo((p) => {
          const n = { ...p };
          delete n[o.orderNumber];
          return n;
        });
      };
      const clearError = () =>
        setWalmartRateErrors((p) => {
          if (!p[o.orderNumber]) return p;
          const n = { ...p };
          delete n[o.orderNumber];
          return n;
        });
      try {
        const res = await fetch("/api/shipping/walmart/rates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purchaseOrderId: o.walmartPurchaseOrderId,
            shipByDate,
          }),
        });
        const j = await res.json();
        if (!j?.ok) {
          dropMaps();
          // Surface the actual reason on the card so it doesn't look like
          // the rate is just slow to load — e.g. PackingProfile missing for
          // a Walmart-split PO with qty=1 vs the qty=2 profile we have.
          const msg =
            typeof j?.error === "string" && j.error
              ? j.error
              : `Rate failed (HTTP ${res.status})`;
          setWalmartRateErrors((p) => ({ ...p, [o.orderNumber]: msg }));
          return;
        }
        clearError();
        setWalmartStatus((p) => ({
          ...p,
          [o.orderNumber]: {
            alreadyBought: !!j.alreadyBought,
            orderStatus: j.orderStatus ?? null,
            existingLabel: j.existingLabel ?? null,
          },
        }));
        // Already bought / shipped, or no buyable rate at this date → clear
        // the rate so the row shows the right state instead of a stale price.
        if (j.alreadyBought || j.orderStatus === "Shipped" || !j.selected || !j.box) {
          dropMaps();
          return;
        }
        const s = j.selected;
        const b = j.box;
        const usedShipDate = j.shipByDate ?? shipByDate;
        setWalmartRates((p) => ({
          ...p,
          [o.orderNumber]: {
            id: `wm-${o.orderNumber}`,
            orderNumber: o.orderNumber,
            carrier: s.carrierName ?? null,
            service: s.displayName ?? s.serviceType ?? null,
            price: typeof s.amount === "number" ? s.amount : null,
            edd: s.deliveryDate ?? null,
            status: "pending",
            notes: j.selectionReason ?? null,
            weight: typeof b.weight === "number" ? b.weight : null,
            boxSize: `${b.length}x${b.width}x${b.height}`,
            productType: null,
            // Ship date is shown by the row's own editable input, so leave the
            // dual-date chip fields null (otherwise the row gets a redundant
            // "Ship X" chip next to the date picker).
            labelDate: null,
            physicalShipDate: null,
            shipDateTrickApplied: false,
            datesMatch: true,
            actualShipDay: null,
            allocationId: null,
          },
        }));
        setWalmartBuyInfo((p) => ({
          ...p,
          [o.orderNumber]: {
            purchaseOrderId: o.walmartPurchaseOrderId!,
            carrierName: s.carrierName,
            serviceType: s.serviceType,
            length: b.length,
            width: b.width,
            height: b.height,
            weight: b.weight,
            edd: s.deliveryDate ?? null,
            shipByDate: usedShipDate,
          },
        }));
      } catch {
        /* leave existing rate in place — a transient fetch error shouldn't
           blank the row the operator was looking at */
      } finally {
        setRequoting((p) => ({ ...p, [o.orderNumber]: false }));
      }
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Two-pass load:
      //   1. /api/shipping/dashboard — state, $ fields, time buckets. Cheap.
      //   2. /api/shipping/plan?orderIds=… — carrier / service / price for
      //      every order in ready_to_buy state. Slow (Veeqo rates per
      //      allocation, ~1s each), so run after dashboard renders.
      //
      // Passing orderIds bypasses plan's default "today's dispatch only"
      // filter — without that, orders shipping tomorrow / day-after look
      // ready in the dashboard but show no rates because plan ignored them.
      setPlanLoading(true);
      const dashRes = await fetch("/api/shipping/dashboard");
      if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
      const dashJson = (await dashRes.json()) as DashboardResponse;
      setData(dashJson);
      setLoading(false);

      // ── Walmart-direct rate pass ──────────────────────────────────────
      // Walmart orders (store "SIRIUS …", not "Walmart") get no Veeqo rate.
      // Rate-shop them through Walmart's own API and synthesize plan items.
      // Runs independently of the Veeqo plan below (which may early-return).
      void (async () => {
        const readyWalmart = dashJson.orders.filter(
          (o) => o.state === "ready_to_buy" && o.isWalmart && o.walmartPurchaseOrderId,
        );
        // A fresh dashboard load is a clean slate — clear stale per-order
        // ship-date overrides and re-quote everything at the page-level date
        // (read via the ref so this []-dep callback need not depend on it).
        setShipDateByOrder({});
        setWalmartRates({});
        setWalmartBuyInfo({});
        setWalmartStatus({});
        if (readyWalmart.length === 0) return;
        await Promise.all(
          readyWalmart.map((o) =>
            quoteWalmartOrder(o, shipDateGlobalRef.current),
          ),
        );
      })();

      const readyOrderIds = dashJson.orders
        .filter((o) => o.state === "ready_to_buy")
        .map((o) => o.orderId);

      if (readyOrderIds.length === 0) {
        setPlan(null);
        return;
      }

      try {
        const planRes = await fetch(
          `/api/shipping/plan?orderIds=${readyOrderIds.join(",")}`
        );
        if (planRes.ok) {
          const planJson = (await planRes.json()) as PlanResponse;
          setPlan(planJson);
        }
      } catch {
        /* plan failure is non-fatal — page still shows dashboard */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    } finally {
      setPlanLoading(false);
    }
  }, [quoteWalmartOrder]);

  useEffect(() => {
    load();
  }, [load]);

  // Pull the active frozen-risk alerts so each shipping row can show the
  // recommendation badge inline. Runs once on mount and again whenever the
  // dashboard reload finishes (so a fresh "Run analysis" pass on
  // /frozen-analytics is reflected here too).
  const loadFrozenAlerts = useCallback(async () => {
    try {
      const res = await fetch(
        "/api/frozen/alerts?status=pending&min_level=low&limit=500",
      );
      if (!res.ok) return;
      const json = (await res.json()) as { alerts: ShippingFrozenAlert[] };
      setFrozenAlerts(json.alerts ?? []);
    } catch {
      /* non-fatal — shipping page works without the badge */
    }
  }, []);
  useEffect(() => {
    loadFrozenAlerts();
  }, [loadFrozenAlerts]);

  // Mergeable groups scan — non-blocking, runs in parallel with the
  // main dashboard load. Failure is silent (banner just doesn't show).
  const loadMergeable = useCallback(async () => {
    try {
      const res = await fetch("/api/shipping/mergeable");
      if (!res.ok) return;
      const json = await res.json();
      setMergeable(json);
    } catch {
      /* non-fatal — page works fine without the banner */
    }
  }, []);
  useEffect(() => {
    loadMergeable();
  }, [loadMergeable]);

  // Index alerts by orderNumber for O(1) row lookup. Multiple ship dates for
  // the same order are exceedingly rare in this flow; if it happens, pick
  // the one closest to today (lowest shipDate).
  const frozenAlertByOrder = useMemo(() => {
    const m = new Map<string, ShippingFrozenAlert>();
    for (const a of frozenAlerts) {
      const existing = m.get(a.orderId);
      if (!existing || a.shipDate < existing.shipDate) m.set(a.orderId, a);
    }
    return m;
  }, [frozenAlerts]);

  // ── Derived view ────────────────────────────────────────────────────
  const orders = useMemo(() => data?.orders ?? [], [data]);

  // Ready Walmart orders (the ones a ship-date change re-quotes).
  const readyWalmartOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.state === "ready_to_buy" &&
          o.isWalmart &&
          o.walmartPurchaseOrderId,
      ),
    [orders],
  );

  // The ship date in effect for an order — its own override, else the global.
  const effectiveShipDate = useCallback(
    (orderNumber: string) => shipDateByOrder[orderNumber] ?? shipDateGlobal,
    [shipDateByOrder, shipDateGlobal],
  );

  // Change the page-level ship date: it becomes the new baseline for everyone,
  // so drop per-order overrides and re-quote every ready Walmart order at it.
  // Amazon rows just show the new date + re-derive their "N days" transit
  // (Veeqo rates don't vary by date, so there's nothing to re-quote).
  function changeGlobalShipDate(date: string) {
    if (!date) return;
    setShipDateGlobal(date);
    setShipDateByOrder({});
    for (const o of readyWalmartOrders) quoteWalmartOrder(o, date);
  }

  // Change one order's ship date (overrides the global for that order only).
  // Walmart re-quotes through Walmart's API (rates DO vary by ship date there,
  // and it drives both display and buy). Amazon does NOT re-quote: Veeqo's API
  // returns a fixed quote regardless of dispatch date (verified — price + EDD
  // don't move), so changing the date only re-derives the "N days" transit on
  // the row (EDD − ship date). No Veeqo write, instant.
  function changeOrderShipDate(o: DashboardOrder, date: string) {
    if (!date) return;
    setShipDateByOrder((p) => ({ ...p, [o.orderNumber]: date }));
    if (o.isWalmart) quoteWalmartOrder(o, date);
  }

  // Orders narrowed to the selected channel. Every count and the list below
  // derive from this, so flipping the Amazon/Walmart toggle re-computes the
  // whole dashboard. "all" passes everything through unchanged.
  const channelOrders = useMemo(() => {
    if (channelFilter === "all") return orders;
    const wantWalmart = channelFilter === "walmart";
    return orders.filter((o) => !!o.isWalmart === wantWalmart);
  }, [orders, channelFilter]);

  // Store ids that carry Walmart orders — used to split the "By store"
  // breakdown by channel. Each Veeqo store maps to exactly one marketplace,
  // but the Walmart store is named "SIRIUS TRADING INTERNATIONAL LLC", so we
  // key off the per-order isWalmart flag rather than the store name.
  const walmartStoreIds = useMemo(
    () => new Set(orders.filter((o) => o.isWalmart).map((o) => o.storeId)),
    [orders],
  );

  // Time-bucket counts recomputed locally so the tab badges track the channel
  // filter (the server's data.timeBuckets cover both channels at once).
  const bucketCounts = useMemo(() => {
    const c: Record<ShipByBucket, number> = {
      overdue: 0,
      today: 0,
      tomorrow: 0,
      dayafter: 0,
      later: 0,
    };
    for (const o of channelOrders) if (o.timeBucket) c[o.timeBucket] += 1;
    return c;
  }, [channelOrders]);

  // Walmart-only: label bought but order not yet marked Shipped. These
  // are pulled into a dedicated "Awaiting ship-confirm" tab so they
  // don't visually mix with rows still awaiting label purchase. Source
  // of truth is the per-order rate-quote response (walmartStatus[...]).
  const isAwaitingShipConfirm = useCallback(
    (o: DashboardOrder) => {
      if (!o.isWalmart) return false;
      const ws = walmartStatus[o.orderNumber];
      if (!ws) return false;
      return ws.alreadyBought === true && ws.orderStatus !== "Shipped";
    },
    [walmartStatus],
  );
  const awaitingShipConfirmCount = useMemo(
    () => channelOrders.filter(isAwaitingShipConfirm).length,
    [channelOrders, isAwaitingShipConfirm],
  );

  const filteredOrders = useMemo(() => {
    // Sort by actionability: ready_to_buy → need_attention → waiting_placed
    // → bought. Inside each state, sort by time bucket (overdue first) so the
    // most urgent rows always sit at the top of the list.
    const stateRank: Record<State, number> = {
      ready_to_buy: 0,
      need_attention: 1,
      waiting_placed: 2,
      bought: 3,
    };
    const bucketRank: Record<ShipByBucket, number> = {
      overdue: 0,
      today: 1,
      tomorrow: 2,
      dayafter: 3,
      later: 4,
    };
    return channelOrders
      .filter((o) => {
        // Awaiting-ship-confirm scope is mutually exclusive with the
        // normal active list. In "awaiting" we show ONLY those rows; in
        // "active" we HIDE them so the buy-flow list stays focused.
        const awaiting = isAwaitingShipConfirm(o);
        if (viewScope === "awaiting") {
          if (!awaiting) return false;
        } else if (awaiting) {
          return false;
        }
        if (bucketFilter && o.timeBucket !== bucketFilter) return false;
        if (storeFilter && o.storeId !== storeFilter) return false;
        if (stateFilter !== "all" && o.state !== stateFilter) return false;
        if (typeFilter !== "all") {
          // Match when every classified item in the order is of the chosen
          // type. Unclassified items don't match either filter — those
          // orders are best surfaced via "Need attention" anyway.
          const types = o.items.map((i) => i.knownType);
          if (types.length === 0) return false;
          if (!types.every((t) => t === typeFilter)) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => {
        const ds = stateRank[a.state] - stateRank[b.state];
        if (ds !== 0) return ds;
        const ab = a.timeBucket ? bucketRank[a.timeBucket] : 99;
        const bb = b.timeBucket ? bucketRank[b.timeBucket] : 99;
        return ab - bb;
      });
  }, [
    channelOrders,
    bucketFilter,
    storeFilter,
    stateFilter,
    typeFilter,
    viewScope,
    isAwaitingShipConfirm,
  ]);

  const selectableIds = useMemo(
    () =>
      new Set(
        filteredOrders
          .filter((o) => o.state === "ready_to_buy")
          .map((o) => o.orderId)
      ),
    [filteredOrders]
  );

  const totals = useMemo(() => {
    const all = channelOrders.length;
    const ready = channelOrders.filter(
      (o) => o.state === "ready_to_buy",
    ).length;
    const attention = channelOrders.filter(
      (o) => o.state === "need_attention",
    ).length;
    const waiting = channelOrders.filter(
      (o) => o.state === "waiting_placed",
    ).length;
    return { all, ready, attention, waiting };
  }, [channelOrders]);

  // Index plan rows by orderNumber so the OrderRow can pick up carrier /
  // price / EDD without an extra lookup at render time. Plan keys on
  // orderNumber (Amazon-format), same as dashboard, so the merge is clean.
  const planByOrderNumber = useMemo(() => {
    const m = new Map<string, PlanItem>();
    if (plan) for (const p of plan.orders) m.set(p.orderNumber, p);
    // Walmart rate entries overlay/extend the Veeqo plan so Walmart rows show
    // carrier / cost / EDD / package through the same rendering path.
    for (const [num, p] of Object.entries(walmartRates)) m.set(num, p);
    return m;
  }, [plan, walmartRates]);

  // Final display order. "urgency" keeps filteredOrders' actionability sort;
  // the others re-sort by data that lives in the plan map (cost / EDD) or on
  // the order (deadline). Missing values sort last so populated rows lead.
  const displayedOrders = useMemo(() => {
    if (sortBy === "urgency") return filteredOrders;
    const rows = [...filteredOrders];
    const num = (v: number | null | undefined) =>
      typeof v === "number" ? v : Number.POSITIVE_INFINITY;
    const time = (d: string | null | undefined) => {
      if (!d) return Number.POSITIVE_INFINITY;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    rows.sort((a, b) => {
      if (sortBy === "cost") {
        return (
          num(planByOrderNumber.get(a.orderNumber)?.price) -
          num(planByOrderNumber.get(b.orderNumber)?.price)
        );
      }
      if (sortBy === "edd") {
        return (
          time(planByOrderNumber.get(a.orderNumber)?.edd) -
          time(planByOrderNumber.get(b.orderNumber)?.edd)
        );
      }
      // deadline
      return time(a.deliverBy) - time(b.deliverBy);
    });
    return rows;
  }, [filteredOrders, sortBy, planByOrderNumber]);

  // Sum of the label cost across selected orders (Veeqo plan price + Walmart
  // quote price both live in planByOrderNumber). Shown in the Buy-selected
  // button — "Buy selected (N): $XX.XX" — like Veeqo's bulk-buy button.
  const selectedTotal = useMemo(() => {
    let sum = 0;
    for (const o of filteredOrders) {
      if (!selected.has(o.orderId)) continue;
      const price = planByOrderNumber.get(o.orderNumber)?.price;
      if (typeof price === "number") sum += price;
    }
    return sum;
  }, [filteredOrders, selected, planByOrderNumber]);

  // ── Actions ─────────────────────────────────────────────────────────
  function toggleAll() {
    if (selected.size === selectableIds.size) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  }

  function toggleOne(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  async function buySelected() {
    if (selected.size === 0) return;
    setBuying(true);

    // Partition selection into Walmart vs Amazon. Walmart labels are
    // bought via /api/shipping/walmart/buy directly (skipping Veeqo);
    // Amazon labels go through the /plan + /buy pipeline as before.
    // Without this split, Walmart orders would either be filtered out
    // by /plan (which only quotes Veeqo-handled channels properly) or
    // end up at /api/shipping/buy which doesn't speak Walmart Shipping
    // API at all — that's the "nothing happens on click" the operator
    // reports when their selection is Walmart-heavy.
    const orderById = new Map<string, DashboardOrder>();
    for (const o of filteredOrders) orderById.set(o.orderId, o);
    const walmartOrders: DashboardOrder[] = [];
    const amazonIds: string[] = [];
    for (const id of selected) {
      const o = orderById.get(id);
      if (!o) continue;
      if (o.isWalmart) walmartOrders.push(o);
      else amazonIds.push(id);
    }

    const bought: BuyReportSuccess[] = [];
    const errors: BuyReportError[] = [];

    try {
      // ── Walmart leg ────────────────────────────────────────────────
      if (walmartOrders.length > 0) {
        setBuyMsg(`Buying ${walmartOrders.length} Walmart label(s)…`);
        for (const o of walmartOrders) {
          const info = walmartBuyInfo[o.orderNumber];
          if (!info) {
            errors.push({
              orderNumber: o.orderNumber,
              itemId: o.orderId,
              error:
                "No Walmart rate yet — set the package size/weight, then Refresh.",
            });
            continue;
          }
          try {
            const r = await fetch("/api/shipping/walmart/buy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                purchaseOrderId: info.purchaseOrderId,
                carrierName: info.carrierName,
                serviceType: info.serviceType,
                length: info.length,
                width: info.width,
                height: info.height,
                weight: info.weight,
                edd: info.edd,
                shipByDate:
                  info.shipByDate ?? effectiveShipDate(o.orderNumber),
              }),
            });
            const j = await r.json();
            if (!r.ok || j?.ok === false) {
              errors.push({
                orderNumber: o.orderNumber,
                itemId: o.orderId,
                error: j?.error || "Walmart label purchase failed",
              });
              continue;
            }
            bought.push({
              orderNumber: o.orderNumber,
              tracking: j.trackingNumber ?? "",
              itemId: o.orderId,
              labelPath: j.labelPath ?? null,
              pdfSaved: !!j.pdfSaved,
              pdfSource: j.pdfSaved ? "drive" : "none",
              driveError: j.driveError ?? null,
              carrier: j.carrierName ?? info.carrierName,
              service: j.serviceType ?? info.serviceType,
              price: null,
            });
          } catch (e) {
            errors.push({
              orderNumber: o.orderNumber,
              itemId: o.orderId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // ── Amazon leg (existing plan + buy flow) ─────────────────────
      if (amazonIds.length > 0) {
        setBuyMsg(`Generating plan for ${amazonIds.length} Amazon order(s)…`);
        const ids = amazonIds.join(",");
        const planRes = await fetch(`/api/shipping/plan?orderIds=${ids}`);
        const planJson = await planRes.json();
        if (!planRes.ok)
          throw new Error(planJson?.error || "Failed to plan labels");
        const planId: string = planJson.planId;
        const itemIds: string[] = (planJson.orders ?? [])
          .filter((o: { status: string }) => o.status === "pending")
          .map((o: { id: string }) => o.id);
        if (itemIds.length > 0) {
          setBuyMsg(`Buying ${itemIds.length} Amazon label(s)…`);
          // Map orderId → itemId for any per-row rate overrides.
          const overridesByItemId: Record<string, RateOverride> = {};
          for (const planOrder of planJson.orders ?? []) {
            const ov = rateOverrides[planOrder.orderId];
            if (ov) overridesByItemId[planOrder.id] = ov;
          }
          const buyRes = await fetch("/api/shipping/buy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              planId,
              itemIds,
              overrides: overridesByItemId,
            }),
          });
          const buyJson = await buyRes.json();
          if (!buyRes.ok)
            throw new Error(buyJson?.error || "Failed to buy labels");
          for (const b of (buyJson.bought ?? []) as BuyReportSuccess[]) {
            bought.push(b);
          }
          for (const e of (buyJson.errors ?? []) as BuyReportError[]) {
            errors.push(e);
          }
        }
      }

      // ── Report + cleanup ──────────────────────────────────────────
      const totalAttempted = walmartOrders.length + amazonIds.length;
      if (bought.length === 0 && errors.length === 0) {
        setBuyMsg("Nothing buyable in the selection.");
        return;
      }
      setBuyMsg(`Bought ${bought.length} · ${errors.length} failed`);
      setBuyReport({
        scope: "bulk",
        total: totalAttempted,
        bought,
        errors,
      });
      setSelected(new Set());
      // Clear overrides for orders we just attempted — they're stale for
      // any subsequent purchase.
      setRateOverrides((prev) => {
        const next = { ...prev };
        for (const id of selected) delete next[id];
        return next;
      });
      await load();
    } catch (e) {
      setBuyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(false);
    }
  }

  // Per-row Buy — uses the planId fetched at page load. If the order is
  // missing from that plan (rare: just-resolved attention), we fall back
  // to re-running plan with ?orderIds=ID first.
  // Manually mark a Walmart order Shipped using its purchased label's
  // tracking (POST /api/shipping/walmart/mark-shipped). The 10pm cron does
  // this automatically once the package moves; this is the manual override.
  // Push an order back to Procurement. Strips the `Placed` tag and
  // resets every "bought" line-item status. The shipping label (if any)
  // is left untouched — operator wants to reuse it once they re-source
  // the product. The order disappears from Shipping Labels on next
  // load() because /api/shipping/dashboard filters on Placed.
  async function rollbackProcurement(o: DashboardOrder) {
    setRollingBack(o.orderId);
    setBuyMsg(`Rolling ${o.orderNumber} back to Procurement…`);
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });
    try {
      const r = await fetch("/api/shipping/rollback-procurement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: o.orderId }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || "Failed to rollback");
      }
      setBuyMsg(
        `${o.orderNumber} returned to Procurement (label kept). Re-buy the product, then ship.`,
      );
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setRollingBack(null);
    }
  }

  // Cancel a bought label (Amazon → Veeqo refund, Walmart → discard).
  // Server picks the right path from the order's channel. After success
  // the order stays in Shipping Labels but with no label, so the
  // operator can re-quote / re-buy without leaving the page. Used when
  // a customer cancels OR we cancel the order outright. Does NOT touch
  // Procurement state — the product was already bought, that stays.
  async function discardLabel(o: DashboardOrder) {
    setDiscardingLabel(o.orderId);
    setBuyMsg(`Discarding label for ${o.orderNumber}…`);
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });
    try {
      const r = await fetch("/api/shipping/discard-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: o.orderId }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || "Failed to discard label");
      }
      setBuyMsg(
        `${o.orderNumber}: label discarded (refund 24-72h). Ready to re-quote.`,
      );
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setDiscardingLabel(null);
    }
  }

  async function markShipped(o: DashboardOrder) {
    if (!o.walmartPurchaseOrderId) return;
    setMarkingShipped(o.orderId);
    setBuyMsg(`Marking ${o.orderNumber} shipped…`);
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });
    try {
      const r = await fetch("/api/shipping/walmart/mark-shipped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseOrderId: o.walmartPurchaseOrderId }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || "Failed to mark shipped");
      }
      setBuyMsg(`${o.orderNumber} marked Shipped`);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setMarkingShipped(null);
    }
  }

  async function buyOne(o: DashboardOrder) {
    setBuyingRow(o.orderId);
    setBuyMsg(`Buying label for ${o.orderNumber}…`);
    // Clear any previous error for this row so the spinner replaces it.
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });

    // ── Walmart-direct buy ────────────────────────────────────────────────
    // Buy via Walmart's own API (not Veeqo). Does NOT mark the order Shipped
    // — it stays Acknowledged; the ship-confirm cron (or manual action) marks
    // it shipped once the package moves. PDF is saved to Drive server-side.
    if (o.isWalmart) {
      try {
        const info = walmartBuyInfo[o.orderNumber];
        if (!info) {
          throw new Error(
            "No Walmart rate yet — set the package size/weight, then Refresh.",
          );
        }
        const buyRes = await fetch("/api/shipping/walmart/buy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purchaseOrderId: info.purchaseOrderId,
            carrierName: info.carrierName,
            serviceType: info.serviceType,
            length: info.length,
            width: info.width,
            height: info.height,
            weight: info.weight,
            edd: info.edd,
            // Ship date the rate was quoted at → label is filed under the day
            // it actually ships (falls back to this order's effective date).
            shipByDate: info.shipByDate ?? effectiveShipDate(o.orderNumber),
          }),
        });
        const j = await buyRes.json();
        if (!buyRes.ok || j?.ok === false) {
          throw new Error(j?.error || "Walmart label purchase failed");
        }
        setBuyReport({
          scope: "single",
          total: 1,
          bought: [
            {
              orderNumber: o.orderNumber,
              tracking: j.trackingNumber ?? "",
              itemId: o.orderId,
              labelPath: j.labelPath ?? null,
              pdfSaved: !!j.pdfSaved,
              pdfSource: j.pdfSaved ? "drive" : "none",
              driveError: j.driveError ?? null,
              carrier: j.carrierName ?? info.carrierName,
              service: j.serviceType ?? info.serviceType,
              price: null,
            },
          ],
          errors: [],
        });
        setBuyMsg(`Bought ${o.orderNumber} (Walmart) — not yet marked shipped`);
        await load();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBuyMsg(msg);
        setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
      } finally {
        setBuyingRow(null);
      }
      return;
    }

    try {
      let planId = plan?.planId ?? null;
      let planItemId =
        plan?.orders.find(
          (p) => p.orderNumber === o.orderNumber && p.status === "pending"
        )?.id ?? null;
      if (!planId || !planItemId) {
        const r = await fetch(
          `/api/shipping/plan?orderIds=${encodeURIComponent(o.orderId)}`
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to plan");
        planId = j.planId;
        const item = (j.orders ?? []).find(
          (p: { orderNumber: string; status: string }) =>
            p.orderNumber === o.orderNumber && p.status === "pending"
        );
        if (!item) throw new Error("No buyable rate found for this order");
        planItemId = item.id;
      }
      const ov = rateOverrides[o.orderId];
      const buyRes = await fetch("/api/shipping/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          itemIds: [planItemId],
          overrides: ov && planItemId ? { [planItemId]: ov } : undefined,
        }),
      });
      const buyJson = await buyRes.json();
      if (!buyRes.ok) throw new Error(buyJson?.error || "Failed to buy");
      // The buy endpoint returns 200 even when the individual purchase
      // failed — the failure lands in buyJson.errors. Without this check
      // the UI silently flips back to "ready" and the operator thinks
      // the label was bought.
      const errs: BuyReportError[] = buyJson.errors ?? [];
      const bought: BuyReportSuccess[] = buyJson.bought ?? [];
      // Always surface the per-purchase report — even a single-order buy
      // can have a PDF-save mismatch (label bought, file not written)
      // that the operator must see.
      setBuyReport({
        scope: "single",
        total: 1,
        bought,
        errors: errs,
      });
      if (bought.length === 0 && errs.length > 0) {
        throw new Error(errs[0]?.error || "Veeqo rejected the purchase");
      }
      setBuyMsg(`Bought ${o.orderNumber}`);
      setRateOverrides((prev) => {
        const next = { ...prev };
        delete next[o.orderId];
        return next;
      });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setBuyingRow(null);
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Shipping labels"
        subtitle={
          data?.refreshedAt
            ? `Last refresh: ${new Date(data.refreshedAt).toLocaleString()}`
            : "Loading…"
        }
        actions={
          <Btn
            icon={<RefreshCw size={13} />}
            onClick={load}
            loading={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Btn>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger-tint px-4 py-3 text-[12px] text-danger">
          {error}
        </div>
      )}

      {mergeable && mergeable.groupCount > 0 && (
        <MergeableBanner
          mergeable={mergeable}
          expanded={mergeableExpanded}
          onToggle={() => setMergeableExpanded((v) => !v)}
        />
      )}

      {/* Channel scope — Amazon / Walmart brand toggles. Flips every count
          below (KPI cards, store breakdown, bucket/type tabs, list) to the
          chosen marketplace. Click the active button (or "show all") to
          clear back to both channels. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
          Channel
        </span>
        <ChannelToggle
          channel="amazon"
          active={channelFilter === "amazon"}
          onClick={() => {
            setChannelFilter((c) => (c === "amazon" ? "all" : "amazon"));
            setStoreFilter(null);
          }}
        />
        <ChannelToggle
          channel="walmart"
          active={channelFilter === "walmart"}
          onClick={() => {
            setChannelFilter((c) => (c === "walmart" ? "all" : "walmart"));
            setStoreFilter(null);
          }}
        />
        {channelFilter !== "all" && (
          <button
            type="button"
            onClick={() => setChannelFilter("all")}
            className="ml-0.5 text-[11px] text-ink-3 underline-offset-2 hover:text-ink-1 hover:underline"
          >
            show all
          </button>
        )}

        {/* Page-level ship date — the day you plan to hand packages to the
            carrier. Drives every Walmart rate quote + Buy. Per-row overrides
            still win for individual orders. (Amazon stays on Veeqo's own
            dispatch date — see note in the UI.) */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
            Ship date
          </span>
          <input
            type="date"
            value={shipDateGlobal}
            onChange={(e) => changeGlobalShipDate(e.target.value)}
            title="The day you plan to ship. All Walmart rates re-quote from this date; Buy uses it too."
            className="rounded-md border border-rule bg-surface px-2 py-1 text-[12.5px] text-ink focus:border-[#0071dc] focus:outline-none"
          />
          {/* Quick presets — Today / +1 / +2 days from today (ET). */}
          <div className="flex items-center gap-1">
            {[
              { label: "Today", date: todayInET() },
              { label: "+1", date: addDaysISO(todayInET(), 1) },
              { label: "+2", date: addDaysISO(todayInET(), 2) },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => changeGlobalShipDate(p.date)}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[11px] leading-none transition",
                  shipDateGlobal === p.date
                    ? "border-[#0071dc] bg-[#0071dc]/10 font-medium text-[#0071dc]"
                    : "border-rule bg-surface text-ink-3 hover:border-silver-line hover:text-ink-1",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Totals row — each card toggles the state filter. Clicking the same
          card twice (or "Awaiting fulfillment") returns to the unfiltered
          view. The visual active state mirrors the existing store-filter
          chips below so the filter relationship reads consistently. */}
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          label="Awaiting fulfillment"
          value={totals.all}
          icon={<Package size={14} />}
          onClick={() => setStateFilter("all")}
          active={stateFilter === "all"}
        />
        <KpiCard
          label="Ready to buy"
          value={totals.ready}
          icon={<CheckCircle size={14} />}
          iconVariant="default"
          onClick={() =>
            setStateFilter(
              stateFilter === "ready_to_buy" ? "all" : "ready_to_buy",
            )
          }
          active={stateFilter === "ready_to_buy"}
        />
        <KpiCard
          label="Need attention"
          value={totals.attention}
          icon={<AlertTriangle size={14} />}
          iconVariant={totals.attention > 0 ? "warn" : "default"}
          onClick={() =>
            setStateFilter(
              stateFilter === "need_attention" ? "all" : "need_attention",
            )
          }
          active={stateFilter === "need_attention"}
        />
        <KpiCard
          label="Waiting for procurement"
          value={totals.waiting}
          icon={<Loader2 size={14} />}
          onClick={() =>
            setStateFilter(
              stateFilter === "waiting_placed" ? "all" : "waiting_placed",
            )
          }
          active={stateFilter === "waiting_placed"}
        />
      </div>

      {/* Store breakdown */}
      {data && data.storeBreakdown.length > 0 && (
        <Panel>
          <PanelHeader title="By store" />
          <PanelBody>
            <div className="flex flex-wrap gap-2">
              {data.storeBreakdown
                .filter((s) =>
                  channelFilter === "all"
                    ? true
                    : walmartStoreIds.has(s.storeId) ===
                      (channelFilter === "walmart"),
                )
                .map((s) => (
                <button
                  key={s.storeId}
                  type="button"
                  onClick={() =>
                    setStoreFilter(storeFilter === s.storeId ? null : s.storeId)
                  }
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-[12px] min-w-[160px]",
                    storeFilter === s.storeId
                      ? "border-green bg-green-soft text-green-ink"
                      : "border-rule bg-surface hover:border-silver-line"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <StoreAvatar
                      store={storeKeyFor({
                        marketplace: s.channel,
                        storeName: s.storeName,
                      })}
                      size="sm"
                    />
                    <span className="font-medium truncate">{s.storeName}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-[11px]">
                    <div>
                      <div className="text-ink-3">all</div>
                      <div className="font-semibold tabular">{s.all}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">ready</div>
                      <div className="font-semibold tabular">{s.readyToBuy}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">⚠</div>
                      <div className="font-semibold tabular text-warn-strong">
                        {s.needAttention}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {/* Bucket filter */}
      {data && (
        <FilterTabs
          tabs={[
            {
              id: "all" as const,
              label: "All",
              count: channelOrders.length - awaitingShipConfirmCount,
            },
            ...BUCKET_TABS.map((b) => ({
              id: b.id,
              label: b.label,
              count: bucketCounts[b.id] ?? 0,
            })),
            {
              id: "awaiting" as const,
              label: "Awaiting ship-confirm",
              count: awaitingShipConfirmCount,
            },
          ]}
          active={
            viewScope === "awaiting"
              ? ("awaiting" as const)
              : (bucketFilter ?? ("all" as const))
          }
          onChange={(id) => {
            if (id === "awaiting") {
              setViewScope("awaiting");
              setBucketFilter(null);
            } else {
              setViewScope("active");
              setBucketFilter(id === "all" ? null : (id as ShipByBucket));
            }
          }}
        />
      )}

      {/* Product type filter — Frozen / Dry. Operates on the items array
          (every item must match the chosen type). Counts are derived
          locally from the already-loaded orders so no extra API call. */}
      {data && (
        <FilterTabs
          tabs={[
            {
              id: "all" as const,
              label: "All types",
              count: channelOrders.length,
            },
            {
              id: "Frozen" as const,
              label: "Frozen",
              count: channelOrders.filter(
                (o) =>
                  o.items.length > 0 &&
                  o.items.every((i) => i.knownType === "Frozen"),
              ).length,
            },
            {
              id: "Dry" as const,
              label: "Dry",
              count: channelOrders.filter(
                (o) =>
                  o.items.length > 0 &&
                  o.items.every((i) => i.knownType === "Dry"),
              ).length,
            },
          ]}
          active={typeFilter}
          onChange={(id) => setTypeFilter(id)}
        />
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between rounded-md border border-rule bg-surface px-3 py-2">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={
              selectableIds.size > 0 && selected.size === selectableIds.size
            }
            onChange={toggleAll}
          />
          Select all ready ({selected.size}/{selectableIds.size})
        </label>
        <div className="flex items-center gap-2">
          {/* Sort — like Veeqo's sortable columns. */}
          <label className="flex items-center gap-1 text-[11px] text-ink-3">
            Sort
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as "urgency" | "cost" | "edd" | "deadline",
                )
              }
              className="rounded border border-rule bg-surface px-1.5 py-1 text-[11.5px] text-ink focus:border-[#0071dc] focus:outline-none"
            >
              <option value="urgency">Urgency</option>
              <option value="cost">Label cost</option>
              <option value="edd">Delivery (EDD)</option>
              <option value="deadline">Deadline</option>
            </select>
          </label>
          {buyMsg && (
            <span className="text-[11px] text-ink-3">{buyMsg}</span>
          )}
          <Btn
            variant="primary"
            icon={<ShoppingCart size={13} />}
            onClick={buySelected}
            loading={buying}
            disabled={selected.size === 0}
          >
            {buying
              ? "Buying…"
              : `Buy selected (${selected.size})${
                  selectedTotal > 0 ? `: $${selectedTotal.toFixed(2)}` : ""
                }`}
          </Btn>
        </div>
      </div>

      {/* Order list */}
      <div className="space-y-2">
        {loading && !data ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-10 text-center text-[12px] text-ink-3">
            Fetching orders from Veeqo…
          </div>
        ) : displayedOrders.length === 0 ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-10 text-center text-[12px] text-ink-3">
            No orders match the current filter.
          </div>
        ) : (
          displayedOrders.map((o) => (
            <OrderRow
              key={o.orderId}
              order={o}
              plan={planByOrderNumber.get(o.orderNumber) ?? null}
              planLoading={planLoading}
              selected={selected.has(o.orderId)}
              buying={buyingRow === o.orderId}
              buyError={buyErrors[o.orderId] ?? null}
              walmartStatus={walmartStatus[o.orderNumber] ?? null}
              walmartRateError={walmartRateErrors[o.orderNumber] ?? null}
              markingShipped={markingShipped === o.orderId}
              onMarkShipped={() => markShipped(o)}
              rollingBack={rollingBack === o.orderId}
              onRollback={() => rollbackProcurement(o)}
              discardingLabel={discardingLabel === o.orderId}
              onDiscardLabel={() => discardLabel(o)}
              shipDate={effectiveShipDate(o.orderNumber)}
              shipDateOverridden={o.orderNumber in shipDateByOrder}
              requoting={!!requoting[o.orderNumber]}
              onShipDateChange={(d) => changeOrderShipDate(o, d)}
              frozenAlert={frozenAlertByOrder.get(o.orderNumber) ?? null}
              onToggleSelected={() => toggleOne(o.orderId)}
              onClassify={() => setClassifyModal(o)}
              onManual={() => setManualModal(o)}
              onPacking={() => setPackingModal(o)}
              onSku={() => setSkuModal(o)}
              onEditPackage={() => setEditPackageModal(o)}
              onPickRate={() => setPickRateModal(o)}
              rateOverride={rateOverrides[o.orderId] ?? null}
              onClearOverride={() => {
                setRateOverrides((prev) => {
                  const next = { ...prev };
                  delete next[o.orderId];
                  return next;
                });
              }}
              onBuy={() => buyOne(o)}
            />
          ))
        )}
      </div>

      {classifyModal && (
        <ClassifyAiDialog
          order={classifyModal}
          onClose={(refresh) => {
            setClassifyModal(null);
            if (refresh) load();
          }}
        />
      )}
      {manualModal && (
        <ManualTypeDialog
          order={manualModal}
          onClose={(refresh) => {
            setManualModal(null);
            if (refresh) load();
          }}
        />
      )}
      {packingModal && (
        <PackingProfileDialog
          order={packingModal}
          onClose={(refresh) => {
            setPackingModal(null);
            if (refresh) load();
          }}
        />
      )}
      {skuModal && (
        <SkuDataDialog
          order={skuModal}
          onClose={(refresh) => {
            setSkuModal(null);
            if (refresh) load();
          }}
        />
      )}
      {buyReport && (
        <BuyReportDialog
          report={buyReport}
          onClose={() => setBuyReport(null)}
        />
      )}
      {editPackageModal && (
        <EditPackageDialog
          order={editPackageModal}
          plan={planByOrderNumber.get(editPackageModal.orderNumber) ?? null}
          onClose={(refresh) => {
            setEditPackageModal(null);
            if (refresh) load();
          }}
        />
      )}
      {pickRateModal && pickRateModal.isWalmart && (
        <WalmartPickRateDialog
          order={pickRateModal}
          currentServiceType={
            walmartBuyInfo[pickRateModal.orderNumber]?.serviceType ?? null
          }
          initialShipDate={effectiveShipDate(pickRateModal.orderNumber)}
          deadlineBy={pickRateModal.deliverBy}
          onShipDateChange={(d) => {
            const num = pickRateModal.orderNumber;
            setShipDateByOrder((p) => ({ ...p, [num]: d }));
          }}
          onClose={() => setPickRateModal(null)}
          onPick={(rate, pickedShipDate) => {
            const num = pickRateModal.orderNumber;
            // Update what the row shows AND what Buy will purchase.
            setWalmartRates((prev) => {
              const base = prev[num];
              if (!base) return prev;
              return {
                ...prev,
                [num]: {
                  ...base,
                  carrier: rate.carrierName,
                  service: rate.displayName,
                  price: rate.amount,
                  edd: rate.deliveryDate,
                },
              };
            });
            setWalmartBuyInfo((prev) => {
              const base = prev[num];
              if (!base) return prev;
              return {
                ...prev,
                [num]: {
                  ...base,
                  carrierName: rate.carrierName,
                  serviceType: rate.serviceType,
                  edd: rate.deliveryDate,
                  shipByDate: pickedShipDate,
                },
              };
            });
            setShipDateByOrder((p) => ({ ...p, [num]: pickedShipDate }));
            setPickRateModal(null);
          }}
        />
      )}
      {pickRateModal && !pickRateModal.isWalmart && (
        <PickRateDialog
          order={pickRateModal}
          plan={planByOrderNumber.get(pickRateModal.orderNumber) ?? null}
          onClose={() => setPickRateModal(null)}
          onPick={(override) => {
            setRateOverrides((prev) => ({
              ...prev,
              [pickRateModal.orderId]: override,
            }));
            setPickRateModal(null);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Channel toggle — brand-styled Amazon / Walmart filter buttons. Purely
// presentational; the parent owns the channelFilter state. Active = filled
// in the brand colour; inactive = quiet outline that warms to the brand
// colour on hover. We approximate the wordmarks (Amazon's lowercase name +
// orange smile underline; Walmart's blue name + yellow spark) rather than
// embedding logo assets, which keeps it crisp at any zoom and themeable.
// ─────────────────────────────────────────────────────────────────────────

function ChannelToggle({
  channel,
  active,
  onClick,
}: {
  channel: "amazon" | "walmart";
  active: boolean;
  onClick: () => void;
}) {
  if (channel === "amazon") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title="Show only Amazon orders"
        className={cn(
          "group relative rounded-md border px-3.5 pb-2 pt-1.5 text-[13px] font-semibold leading-none transition",
          active
            ? "border-[#ff9900] bg-[#ff9900]/10 text-[#232f3e] shadow-sm"
            : "border-rule bg-surface text-ink-2 hover:border-[#ff9900]/60 hover:text-ink-1",
        )}
      >
        <span className="lowercase tracking-tight">amazon</span>
        {/* Amazon smile — a rounded orange underline nodding to the logo. */}
        <span
          className={cn(
            "absolute bottom-1 left-3.5 right-3.5 h-[3px] rounded-full transition",
            active
              ? "bg-[#ff9900]"
              : "bg-[#ff9900]/40 group-hover:bg-[#ff9900]/70",
          )}
        />
      </button>
    );
  }
  // Walmart
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title="Show only Walmart orders"
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-[13px] font-bold leading-none tracking-tight transition",
        active
          ? "border-[#0071dc] bg-[#0071dc] text-white shadow-sm"
          : "border-rule bg-surface text-[#0071dc] hover:border-[#0071dc]/60",
      )}
    >
      {/* Walmart spark (the six-point yellow mark). */}
      <span className="text-[15px] leading-none text-[#ffc220]">✲</span>
      <span>Walmart</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Order row
// ─────────────────────────────────────────────────────────────────────────

function OrderRow({
  order,
  plan,
  planLoading,
  selected,
  buying,
  buyError,
  frozenAlert,
  rateOverride,
  onToggleSelected,
  onClassify,
  onManual,
  onPacking,
  onSku,
  onEditPackage,
  onPickRate,
  onClearOverride,
  onBuy,
  walmartStatus,
  walmartRateError,
  markingShipped,
  onMarkShipped,
  rollingBack,
  onRollback,
  discardingLabel,
  onDiscardLabel,
  shipDate,
  shipDateOverridden,
  requoting,
  onShipDateChange,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  planLoading: boolean;
  selected: boolean;
  buying: boolean;
  buyError: string | null;
  frozenAlert: ShippingFrozenAlert | null;
  rateOverride: RateOverride | null;
  onToggleSelected: () => void;
  onClassify: () => void;
  onManual: () => void;
  onPacking: () => void;
  onSku: () => void;
  onEditPackage: () => void;
  onPickRate: () => void;
  onClearOverride: () => void;
  onBuy: () => void;
  walmartStatus: {
    alreadyBought: boolean;
    orderStatus: string | null;
    existingLabel: { trackingNumber: string; carrierName: string; trackingUrl?: string } | null;
  } | null;
  /** Last error from /api/shipping/walmart/rates for this order, if any —
   *  e.g. "No saved package for RizwanX-3579:1". Rendered in the Buy area
   *  so the operator knows what to fix instead of seeing "Awaiting rate". */
  walmartRateError: string | null;
  markingShipped: boolean;
  onMarkShipped: () => void;
  rollingBack: boolean;
  onRollback: () => void;
  discardingLabel: boolean;
  onDiscardLabel: () => void;
  // Ship-date control (Walmart only). shipDate = the effective date for this
  // order; requoting = a re-quote is in flight; onShipDateChange re-quotes.
  shipDate: string;
  shipDateOverridden: boolean;
  requoting: boolean;
  onShipDateChange: (date: string) => void;
}) {
  const isReady = order.state === "ready_to_buy";
  const isAttn = order.state === "need_attention";
  const isWaiting = order.state === "waiting_placed";
  const isBought = order.state === "bought";

  const fmt$ = (v: number) =>
    `$${v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  // Label cost recommendation comes from /api/shipping/plan. If plan is
  // still in flight (planLoading) we show a spinner; if plan is in but
  // this order has status="stop", we show the stop reason from the plan.
  const planPending = plan && plan.status === "pending";
  const planStop = plan && plan.status !== "pending" && plan.notes;

  // Margin sanity: customer paid X for shipping, label costs Y. Positive
  // margin = we made money on shipping; negative = we ate the difference.
  const shippingMargin =
    plan?.price != null
      ? order.customerPaidShipping - plan.price
      : null;

  // Walmart purchase/ship state (Veeqo still says "ready" because buying via
  // Walmart doesn't flip Veeqo): a label exists but the order isn't shipped
  // yet → show "bought / not shipped" + Mark-as-Shipped; or already Shipped.
  const wmShipped =
    !!order.isWalmart && walmartStatus?.orderStatus === "Shipped";
  const wmBought =
    !!order.isWalmart && !!walmartStatus?.existingLabel && !wmShipped;

  return (
    <div
      className={cn(
        "rounded-md border bg-surface p-3 text-[13px]",
        isAttn
          ? "border-warn-strong/40 bg-warn-tint/30"
          : isWaiting
            ? "border-rule opacity-70"
            : isBought
              ? "border-green/40 bg-green-soft/30"
              : "border-rule"
      )}
    >
      {/* Top row: select + identity + type tag */}
      <div className="flex items-start gap-3">
        {isReady ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="mt-1"
          />
        ) : (
          <div className="mt-1 h-3.5 w-3.5">
            {isAttn ? (
              <AlertTriangle size={14} className="text-warn-strong" />
            ) : isBought ? (
              <CheckCircle size={14} className="text-green" />
            ) : (
              <Loader2 size={14} className="text-ink-3" />
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[13px] text-ink">
              {order.orderNumber}
            </span>
            <CopyOrderNumber value={order.orderNumber} />
            <span className="text-[12px] text-ink-3">
              · {order.storeName}
            </span>
            {order.shipBy && (
              <span className="text-[12px] text-ink-3">
                · Ship by {fmtDate(order.shipBy)}
              </span>
            )}
            {/* Shipping recipient — name + city/state — so the operator can
                sanity-check the destination on the row without opening Veeqo.
                Compact chip; full address still lives in Veeqo. */}
            {(order.customerName || order.city || order.shipToState) && (
              <span className="inline-flex items-center gap-1 rounded bg-bg-elev px-1.5 py-0.5 text-[11.5px] text-ink-2">
                <User size={10} className="text-ink-3" />
                {order.customerName ?? "—"}
                {(order.city || order.shipToState) && (
                  <span className="text-ink-3">
                    · {[order.city, order.shipToState].filter(Boolean).join(", ")}
                  </span>
                )}
              </span>
            )}
            {/* Editable ship date (ready-to-buy rows) — the day the operator
                plans to hand the package to the carrier. Walmart re-quotes its
                rates from that day (drives display AND Buy). Amazon does NOT
                re-quote (Veeqo returns a fixed quote regardless of date) — the
                date only re-derives the "N days" transit shown by the EDD. A
                per-order date highlights in blue. */}
            {isReady &&
              (order.isWalmart ? !wmBought && !wmShipped : true) && (
                <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
                  · Ship
                  <input
                    type="date"
                    value={shipDate}
                    onChange={(e) => onShipDateChange(e.target.value)}
                    title={
                      order.isWalmart
                        ? "Ship date for this order — re-quotes Walmart rates from this day. Defaults to the page-level Ship date."
                        : "Ship date — re-derives the transit estimate (the 'N days' next to EDD). Veeqo's price/EDD are a fixed quote that doesn't change by date; Amazon buys on its ship-by date."
                    }
                    className={cn(
                      "rounded border bg-surface px-1.5 py-0.5 text-[12px] leading-none focus:border-[#0071dc] focus:outline-none",
                      shipDateOverridden
                        ? "border-[#0071dc] font-medium text-[#0071dc]"
                        : "border-rule text-ink",
                    )}
                  />
                  {requoting && (
                    <Loader2 size={12} className="animate-spin text-ink-3" />
                  )}
                </span>
              )}
            {plan && (() => {
              // v3.3 §0.1 dual-date display.
              //
              //   Same dates  → single neutral "Ship X" chip.
              //   Different   → "Label X · 📦 Physical Y" with the
              //                 Physical half highlighted because the
              //                 warehouse MUST hold the package until
              //                 that date, even though the printed
              //                 label says X.
              //
              // Falls back to actualShipDay for rows planned before
              // the dual-date migration ran (labelDate / physicalShipDate
              // null but actualShipDay populated).
              const labelDate = plan.labelDate ?? plan.actualShipDay;
              const physicalShipDate =
                plan.physicalShipDate ?? plan.actualShipDay;
              if (!labelDate && !physicalShipDate) return null;

              const trickApplied =
                plan.shipDateTrickApplied ||
                (!!labelDate &&
                  !!physicalShipDate &&
                  labelDate !== physicalShipDate);

              if (!trickApplied) {
                return (
                  <span
                    className="text-[12px] text-ink-3"
                    title="Label date and physical ship date are the same"
                  >
                    · 📦 Ship {fmtDate(physicalShipDate ?? labelDate ?? "")}
                  </span>
                );
              }

              return (
                <>
                  <span
                    className="text-[12px] text-ink-3"
                    title="Date Amazon sees on the label (drives Late Shipment Rate)"
                  >
                    · Label {fmtDate(labelDate ?? "")}
                  </span>
                  <span
                    className="rounded bg-warn-tint px-1.5 py-px text-[12px] font-medium text-warn-strong"
                    title="Physical ship date pushed by Frozen Ship Date Trick — hand to carrier on this date, not today"
                  >
                    · 📦 Physical {fmtDate(physicalShipDate ?? "")}
                  </span>
                </>
              );
            })()}
          </div>

          {/* Items list — each on its own line so multi-item orders read
              clearly. Thumbnail (~40px) on the left helps the operator
              recognise the product without reading the title. */}
          <ul className="mt-1 space-y-1.5">
            {order.items.map((i) => (
              <li
                key={i.sku}
                className="flex items-start gap-2 text-[13px] text-ink-2"
              >
                {i.imageUrl ? (
                  // Plain <img> — Veeqo CDN URLs aren't on next.config's
                  // allowed list and these are small thumbnails not worth
                  // running through next/image optimisation.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={i.imageUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded border border-rule bg-surface object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded border border-rule bg-bg-elev" />
                )}
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">
                    {i.productTitle}
                  </span>{" "}
                  <QtyBadge qty={i.quantity} />{" "}
                  <span className="font-mono text-[11px] text-ink-3">
                    ({i.sku})
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="shrink-0">
          {order.items[0]?.knownType && (
            // Clickable so operators can flip a misclassified Frozen/Dry
            // type without waiting for the order to land in "Need
            // attention". Vladimir caught a real case (Jimmy Dean
            // croissants tagged Dry but actually Frozen) where the
            // existing classify flow only fires on `needAttentionReason
            // === "no_type"` — already-classified rows had no
            // affordance to fix the type.
            <button
              type="button"
              onClick={onManual}
              title="Click to change Frozen/Dry"
              className="cursor-pointer rounded transition hover:ring-1 hover:ring-ink-3/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-2"
            >
              <TypeTag type={order.items[0].knownType} />
            </button>
          )}
        </div>
      </div>

      {/* Frozen Analytics v2 risk badge — only when a pending alert exists
          for this order. Clicking expands the destination weather +
          recommendations. Agree marks the alert applied; Disagree marks it
          ignored. Both feed the learning loop in the Patterns dashboard. */}
      {frozenAlert && (
        <div className="mt-2 ml-6">
          <FrozenRiskBadge alert={frozenAlert} />
        </div>
      )}

      {/* Money + carrier grid. Order total + customer-paid shipping are known
          for every Veeqo order regardless of state, so they always show.
          Label cost / carrier / EDD only appear when /api/shipping/plan has
          a rate for the order (ready_to_buy and just-bought rows). The
          marketplace deadline (Amazon / Walmart deliver-by) sits in its own
          cell so the operator can eyeball whether the carrier's EDD beats it. */}
      <div className="mt-2.5 ml-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-6 text-[12.5px]">
        <Cell label="Order total" value={fmt$(order.orderTotal)} />
        <Cell
          label="Customer paid shipping"
          value={fmt$(order.customerPaidShipping)}
        />
        <Cell
          label="Marketplace deadline"
          value={order.deliverBy ? fmtDate(order.deliverBy) : "—"}
          // When a carrier EDD is known we compare against it ("on time" /
          // "late by N days"). Otherwise we fall back to plain urgency
          // (days until deadline) so the operator can still tell at a glance
          // which orders need fixing first.
          sub={
            plan?.edd
              ? deadlineRiskNote(order.deliverBy, plan.edd)
              : urgencyNote(order.deliverBy)
          }
          valueClass={
            (plan?.edd
              ? deadlineRiskClass(order.deliverBy, plan.edd)
              : urgencyClass(order.deliverBy)) ?? "text-ink"
          }
        />
        {(isReady || isBought) && (
          <button
            type="button"
            onClick={onEditPackage}
            title="Edit weight and box size — saves to SKU database and recomputes rate"
            className="rounded bg-surface-tint px-2 py-1.5 text-left hover:bg-bg-elev hover:ring-1 hover:ring-rule transition-colors"
          >
            <div className="flex items-center justify-between gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-3">
              <span>Package</span>
              <Pencil size={9} className="text-ink-3" />
            </div>
            <div className="mt-0.5 truncate font-semibold tabular text-ink">
              {plan?.weight != null
                ? `${plan.weight} lbs`
                : planLoading
                  ? "loading…"
                  : "—"}
            </div>
            {plan?.boxSize && (
              <div className="truncate text-[10.5px] text-ink-3">
                {plan.boxSize}
              </div>
            )}
          </button>
        )}
        {(isReady || isBought) && (
          <Cell
            label={isBought ? "Label cost (bought)" : "Label cost"}
            value={
              planLoading && !plan
                ? "loading…"
                : plan?.price != null
                  ? fmt$(plan.price)
                  : planStop
                    ? "stopped"
                    : "—"
            }
            valueClass={
              shippingMargin != null && shippingMargin < 0
                ? "text-danger"
                : "text-ink"
            }
            sub={
              shippingMargin != null
                ? `margin ${shippingMargin >= 0 ? "+" : ""}${fmt$(shippingMargin)}`
                : undefined
            }
          />
        )}
        {(isReady || isBought) && (
          // Carrier/service: when an operator override is active we show
          // their chosen rate in green with a "(manual)" tag, plus a Clear
          // button to revert to the algorithmic pick. Pre-purchase only —
          // bought rows still display the captured carrier as before.
          <button
            type="button"
            onClick={isReady ? onPickRate : undefined}
            disabled={!isReady}
            title={isReady ? "Click to change carrier/service manually" : ""}
            className={cn(
              "rounded px-2 py-1.5 text-left transition-colors",
              rateOverride
                ? "bg-green-soft hover:bg-green-soft2 ring-1 ring-green-mid/30"
                : "bg-surface-tint",
              isReady && "hover:bg-bg-elev cursor-pointer",
              !isReady && "cursor-default",
            )}
          >
            <div className="flex items-center justify-between gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-3">
              <span>Carrier</span>
              {isReady && (
                <Pencil
                  size={9}
                  className={rateOverride ? "text-green-ink" : "text-ink-3"}
                />
              )}
            </div>
            <div
              className={cn(
                "mt-0.5 truncate font-semibold tabular",
                rateOverride ? "text-green-ink" : "text-ink",
              )}
            >
              {rateOverride
                ? rateOverride.service ?? rateOverride.carrier ?? "—"
                : plan?.service
                  ? plan.service
                  : plan?.carrier
                    ? plan.carrier
                    : planLoading
                      ? "loading…"
                      : "—"}
            </div>
            <div className="flex items-center justify-between gap-1 text-[10.5px] text-ink-3">
              <span>
                {(() => {
                  const edd = rateOverride?.edd ?? plan?.edd ?? null;
                  // Transit time in calendar days from the (effective) ship
                  // date to the carrier EDD — the "2 days" Veeqo shows.
                  const days =
                    edd && shipDate
                      ? Math.round(
                          (new Date(edd).getTime() -
                            new Date(shipDate).getTime()) /
                            86_400_000,
                        )
                      : null;
                  const daysStr =
                    days != null && days >= 0
                      ? ` · ${days} day${days === 1 ? "" : "s"}`
                      : "";
                  if (rateOverride) {
                    return rateOverride.edd
                      ? `EDD ${fmtDate(rateOverride.edd)}${daysStr} · manual override`
                      : "manual override";
                  }
                  return plan?.edd ? `EDD ${fmtDate(plan.edd)}${daysStr}` : "";
                })()}
              </span>
              {rateOverride && isReady && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearOverride();
                  }}
                  className="text-[10px] text-ink-3 hover:text-danger underline"
                  title="Clear override and revert to the algorithm's pick"
                >
                  clear
                </span>
              )}
            </div>
          </button>
        )}
      </div>

      {/* Frozen rate-selection rationale — explain why the agent didn't
          pick the absolute cheapest rate when the order is Frozen. The
          ≤3-calendar-days rule comes from food-safety constraints
          (MASTER_PROMPT v3.1); without this note the operator sees
          "Vika showed UPS Ground at $39.93" and assumes the agent is
          wrong. */}
      {isReady && plan?.productType === "Frozen" && (
        <div className="mt-2 ml-6 rounded bg-info-tint px-2 py-1.5 text-[11px] text-info">
          Frozen — agent only considers rates that deliver within 3
          calendar days (food safety). Cheaper Ground / Saver options
          are filtered out even if they meet the marketplace deadline.
        </div>
      )}

      {/* Action area per state */}
      {isAttn && (
        <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
          <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[11px] font-medium text-warn-strong">
            {order.needAttentionReason
              ? ATTENTION_LABELS[order.needAttentionReason]
              : "Needs review"}
          </span>
          {order.needAttentionReason === "no_type" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                onClick={onClassify}
              >
                <Sparkles size={12} className="mr-1" /> Classify with AI
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                onClick={onManual}
              >
                Set manually
              </Button>
            </>
          )}
          {order.needAttentionReason === "no_packing" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11.5px]"
              onClick={onPacking}
            >
              <Package size={12} className="mr-1" /> Set packing profile
            </Button>
          )}
          {order.needAttentionReason === "no_sku" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11.5px]"
              onClick={onSku}
            >
              <Package size={12} className="mr-1" /> Add SKU data
            </Button>
          )}
          {order.needAttentionReason === "mixed_order" && (
            <span className="text-[11px] text-ink-3">
              Split the order in Veeqo (Frozen + Dry on one label isn&apos;t
              supported).
            </span>
          )}
          {order.needAttentionReason === "frozen_walmart" && (
            <span className="text-[11px] text-ink-3">
              Frozen items can&apos;t ship via Walmart — cancel or switch
              channel.
            </span>
          )}
          {(order.needAttentionReason === "budget" ||
            order.needAttentionReason === "no_service") && (
            <span className="text-[11px] text-ink-3">
              No carrier rate fits — review manually in Veeqo.
            </span>
          )}
        </div>
      )}

      {/* Ready row: per-row Buy + (when plan stopped) the reason. */}
      {/* Walmart: label bought but not yet marked shipped — show tracking +
          a manual Mark-as-Shipped button (the 10pm cron also does this auto
          once the package moves). */}
      {wmBought && (
        <div className="mt-2 ml-6 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-green-ink">
            Label bought — {walmartStatus?.existingLabel?.carrierName}{" "}
            <span className="font-mono">
              {walmartStatus?.existingLabel?.trackingNumber}
            </span>
            {" · not yet marked shipped"}
            {buyError ? (
              <span className="ml-2 text-danger">— {buyError}</span>
            ) : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onMarkShipped}
            disabled={markingShipped || rollingBack || discardingLabel}
            className="h-7 text-[11.5px]"
          >
            {markingShipped ? (
              <>
                <Loader2 size={12} className="mr-1 animate-spin" />
                Marking…
              </>
            ) : (
              "Mark as Shipped"
            )}
          </Button>
        </div>
      )}
      {wmShipped && (
        <div className="mt-1 ml-6 text-[11px] text-green-ink">
          Shipped ✓ (confirmed to Walmart).
        </div>
      )}

      {isReady && !wmBought && !wmShipped && (
        <div className="mt-2 ml-6 flex flex-wrap items-center justify-between gap-2">
          {planStop ? (
            <span className="rounded bg-danger-tint px-1.5 py-0.5 text-[11px] font-medium text-danger">
              {plan?.notes}
            </span>
          ) : buyError ? (
            // Show the last buy failure inline so the operator doesn't
            // think the spinner-then-active-button cycle meant success.
            <span className="rounded bg-danger-tint px-1.5 py-0.5 text-[11px] font-medium text-danger">
              Buy failed — {buyError}
            </span>
          ) : walmartRateError && !planPending ? (
            // Walmart-direct rate call failed (e.g. missing PackingProfile
            // for the qty-specific signature on a Walmart split). Surface
            // the exact reason so the operator can fix it instead of
            // staring at a perpetual "Awaiting rate".
            <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[11px] font-medium text-warn-strong">
              Rate error — {walmartRateError}
            </span>
          ) : (
            <span className="text-[11px] text-ink-3">
              {planPending
                ? "Rate ready — confirm to buy"
                : planLoading
                  ? "Calculating best rate…"
                  : "Awaiting rate"}
            </span>
          )}
          <Button
            size="sm"
            onClick={onBuy}
            disabled={buying || !planPending}
            className="h-7 text-[11.5px]"
          >
            {buying ? (
              <>
                <Loader2 size={12} className="mr-1 animate-spin" />
                Buying…
              </>
            ) : (
              <>
                <ShoppingCart size={12} className="mr-1" /> Buy label
              </>
            )}
          </Button>
        </div>
      )}

      {isWaiting && (
        <div className="mt-1 ml-6 text-[11px] text-ink-3">
          Waiting for procurement (no <code>Placed</code> tag yet).
        </div>
      )}
      {isBought && (
        <div className="mt-1 ml-6 text-[11px] text-green-ink">
          Label already purchased.
        </div>
      )}

      {/* Universal action row — Rollback / Discard always available on
          every shipping row regardless of channel or state. Rollback
          handles "supplier didn't deliver" (keeps the label); Discard
          handles "order cancelled" (refunds the label). Both Amazon
          and Walmart paths are dispatched server-side. */}
      <div className="mt-3 ml-6 flex flex-wrap items-center gap-2 border-t border-rule pt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onRollback}
          disabled={rollingBack || markingShipped || discardingLabel}
          title="Push the order back to Procurement (keeps the bought label)"
          className="h-7 text-[11.5px]"
        >
          {rollingBack ? (
            <>
              <Loader2 size={12} className="mr-1 animate-spin" />
              Rolling back…
            </>
          ) : (
            "Rollback Purchase"
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDiscardLabel}
          disabled={discardingLabel || markingShipped || rollingBack}
          title="Cancel the bought label (FedEx/Walmart refund, ~24-72h). Order stays in Shipping Labels."
          className="h-7 text-[11.5px]"
        >
          {discardingLabel ? (
            <>
              <Loader2 size={12} className="mr-1 animate-spin" />
              Discarding…
            </>
          ) : (
            "Discard Label"
          )}
        </Button>
      </div>
    </div>
  );
}

// Banner that surfaces mergeable awaiting orders so the operator can
// combine them in Veeqo before buying labels (Veeqo's public API has no
// merge endpoint — see docs/wiki/merge-orders-design.md). Collapsed,
// it's a single warn-tint strip with the counts; expanded, it lists
// every group with recipient + address + order numbers for cross-
// reference against Veeqo's own Mergeable view.
function MergeableBanner({
  mergeable,
  expanded,
  onToggle,
}: {
  mergeable: {
    groupCount: number;
    orderCount: number;
    veeqoUrl: string;
    groups: Array<{
      signature: string;
      channelKind: string;
      storeName: string | null;
      recipient: string;
      address: string;
      city: string;
      state: string;
      zip: string;
      orders: Array<{
        id: string;
        orderNumber: string;
        storeName: string | null;
      }>;
    }>;
  };
  expanded: boolean;
  onToggle: () => void;
}) {
  const pairWord = mergeable.groupCount === 1 ? "group" : "groups";
  return (
    <div className="rounded-md border border-warn/40 bg-warn-tint">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 text-left text-[12.5px] text-ink hover:text-ink-strong"
        >
          <Package size={14} className="text-warn-strong" />
          <span className="font-medium">
            {mergeable.groupCount} mergeable {pairWord}
          </span>
          <span className="text-ink-3">
            ({mergeable.orderCount} orders) — same address across multiple
            orders, combine in Veeqo to buy one label
          </span>
          <span className="text-ink-3">{expanded ? "▴" : "▾"}</span>
        </button>
        <a
          href={mergeable.veeqoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink hover:border-silver-line"
        >
          Open Veeqo Mergeable ↗
        </a>
      </div>
      {expanded && (
        <div className="border-t border-warn/30 px-4 py-3">
          <ul className="space-y-2.5 text-[12px]">
            {mergeable.groups.map((g) => (
              <li key={g.signature} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium capitalize text-ink">
                    {g.recipient || "—"}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="text-ink-2">
                    {g.address}, {g.city}, {g.state} {g.zip}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span className="text-ink-3">
                    {g.channelKind}
                    {g.storeName ? ` / ${g.storeName}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11.5px] text-ink-2">
                  {g.orders.map((o) => (
                    <span key={o.id}>{o.orderNumber}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// One-click copy button for an Amazon order number. Lives next to the
// order number in OrderRow; the warehouse pastes it into Amazon Seller
// Central / Veeqo search far more often than they retype it.
/**
 * Quantity indicator next to a line item. qty=1 fades in (this is the norm);
 * qty>=2 pops in amber, qty>=4 amber+ring, qty>=10 red — matches the visual
 * cue Veeqo uses ("more than one of the same listing is unusual and the
 * operator must spot it before packing"). Vladimir asked for parity with
 * Veeqo's grey/yellow circle so the multi-qty cases jump out of the row.
 */
function QtyBadge({ qty }: { qty: number }) {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (qty === 1) {
    return <span className="text-[12.5px] text-ink-3">× 1</span>;
  }
  const isHigh = qty >= 10;
  const isMid = qty >= 4;
  return (
    <span
      title={`Заказано ${qty} штук с одного листинга — проверь`}
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-bold tabular leading-none",
        isHigh
          ? "bg-danger text-white ring-2 ring-danger/30"
          : isMid
            ? "bg-warn-strong text-white ring-2 ring-warn-tint"
            : "bg-warn-tint text-warn-strong",
      )}
    >
      × {qty}
    </span>
  );
}

function CopyOrderNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={copied ? "Copied!" : `Copy ${value}`}
      className="inline-flex h-4 w-4 items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
    >
      {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />}
    </button>
  );
}

/** Compact "5/14" date for dense grid cells. Falls back to the raw value
 *  if parsing fails, so we never blank out useful info. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  // Pull date parts straight from the string head so we never round-
  // trip through `new Date()` — that's where TZ-related off-by-one
  // bugs happen. Previously, `new Date("2026-05-18T12:00:00")`
  // anchored to local noon worked in most browsers, but for inputs
  // like "2026-05-18T00:00:00.000Z" (which Prisma/Next sometimes
  // produce for date-typed columns) it rendered as 5/17 in NY TZ.
  // Stored values are operationally "ship-day calendar dates" —
  // they have no TZ semantics, just a Y/M/D — so string extraction
  // is the right model.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    return `${month}/${day}`;
  }
  return iso;
}

/** Days between marketplace deadline and carrier EDD. Negative → carrier
 *  arrives before deadline (good). Positive → late. */
function daysLate(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): number | null {
  if (!deliverBy || !edd) return null;
  const a = new Date(edd);
  const b = new Date(deliverBy);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

function deadlineRiskNote(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): string | undefined {
  const d = daysLate(deliverBy, edd);
  if (d == null) return undefined;
  if (d <= -2) return `+${-d} days buffer`;
  if (d <= 0) return "on time";
  return `late by ${d} day${d === 1 ? "" : "s"}`;
}

function deadlineRiskClass(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): string | null {
  const d = daysLate(deliverBy, edd);
  if (d == null) return null;
  if (d > 0) return "text-danger";
  if (d === 0) return "text-warn-strong";
  return "text-green";
}

/** Days from today to the deadline, in calendar days. Negative = past. */
function daysUntilDeadline(deliverBy: string | null | undefined): number | null {
  if (!deliverBy) return null;
  const d = new Date(deliverBy);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  return Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86400000
  );
}

function urgencyNote(
  deliverBy: string | null | undefined
): string | undefined {
  const d = daysUntilDeadline(deliverBy);
  if (d == null) return undefined;
  if (d < 0) return `${-d}d past deadline`;
  if (d === 0) return "due today";
  if (d === 1) return "1 day left";
  return `${d} days left`;
}

function urgencyClass(
  deliverBy: string | null | undefined
): string | null {
  const d = daysUntilDeadline(deliverBy);
  if (d == null) return null;
  if (d < 0) return "text-danger";
  if (d <= 1) return "text-danger";
  if (d <= 3) return "text-warn-strong";
  return "text-green";
}

function Cell({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded bg-surface-tint px-2 py-1.5">
      <div className="text-[10px] font-mono uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate font-semibold tabular",
          valueClass || "text-ink"
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="truncate text-[10.5px] text-ink-3">{sub}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────

interface AiRowResult {
  type: "Frozen" | "Dry";
  confidence: number;
  reasoning: string;
}

/**
 * Per-item AI classification. For multi-item orders runs the AI call in
 * parallel for each line with a non-null productId, then lets the operator
 * confirm or override each row independently. Each row writes to
 * ProductTypeOverride keyed by its OWN productId, so all 3 items of a
 * 3-product order end up with persistent types (the prior single-item
 * dialog only saved item[0] — leaving the dashboard permanently stuck on
 * "no_type" for the other two).
 */
function ClassifyAiDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const classifiableItems = order.items.filter(
    (i): i is DashboardItem & { productId: number } => i.productId !== null,
  );

  // Per-productId state: AI result, loading, error, saved-type.
  const [results, setResults] = useState<Record<number, AiRowResult>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(classifiableItems.map((i) => [i.productId, true])),
  );
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [savedTypes, setSavedTypes] = useState<Record<number, "Frozen" | "Dry">>(
    () =>
      Object.fromEntries(
        classifiableItems
          .filter((i) => i.knownType)
          .map((i) => [i.productId, i.knownType as "Frozen" | "Dry"]),
      ),
  );
  const [savingPid, setSavingPid] = useState<number | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all(
        classifiableItems.map(async (item) => {
          try {
            const r = await fetch("/api/shipping/classify-ai", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ productId: item.productId }),
            });
            const j = await r.json();
            if (cancelled) return;
            if (!r.ok) {
              setErrors((p) => ({ ...p, [item.productId]: j?.error || `HTTP ${r.status}` }));
            } else {
              setResults((p) => ({
                ...p,
                [item.productId]: {
                  type: j.type,
                  confidence: j.confidence,
                  reasoning: j.reasoning,
                },
              }));
            }
          } catch (e) {
            if (cancelled) return;
            setErrors((p) => ({
              ...p,
              [item.productId]: e instanceof Error ? e.message : String(e),
            }));
          } finally {
            if (!cancelled) {
              setLoading((p) => ({ ...p, [item.productId]: false }));
            }
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.orderId]);

  async function save(
    productId: number,
    type: "Frozen" | "Dry",
    source: "ai" | "manual",
  ) {
    setSavingPid(productId);
    try {
      const aiResult = results[productId];
      await fetch("/api/shipping/product-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          type,
          source,
          aiConfidence: source === "ai" ? aiResult?.confidence : undefined,
          aiReasoning: source === "ai" ? aiResult?.reasoning : undefined,
        }),
      });
      setSavedTypes((p) => ({ ...p, [productId]: type }));
      dirtyRef.current = true;
    } finally {
      setSavingPid(null);
    }
  }

  const allSaved =
    classifiableItems.length > 0 &&
    classifiableItems.every((i) => savedTypes[i.productId]);

  return (
    <Dialog open onOpenChange={() => onClose(dirtyRef.current)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>AI Classification</DialogTitle>
          <DialogDescription>
            {classifiableItems.length === 1
              ? classifiableItems[0]!.productTitle
              : `${classifiableItems.length} items — confirm each`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {classifiableItems.map((item) => {
            const pid = item.productId;
            const isLoading = loading[pid];
            const result = results[pid];
            const error = errors[pid];
            const saved = savedTypes[pid];
            const isBusy = savingPid === pid;
            return (
              <div
                key={pid}
                className="flex gap-3 rounded-md border border-rule bg-surface-tint p-2.5"
              >
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded border border-rule bg-bg-elev object-cover"
                  />
                ) : (
                  <div className="h-14 w-14 shrink-0 rounded border border-rule bg-bg-elev" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[12.5px] font-medium text-ink">
                    {item.productTitle}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] tabular text-ink-3">
                    <span>× {item.quantity}</span>
                    <span className="text-ink-4">·</span>
                    <span>SKU {item.sku}</span>
                    {saved && (
                      <>
                        <span className="text-ink-4">·</span>
                        <span className="inline-flex items-center gap-1 font-medium text-green-ink">
                          <Check size={10} /> Saved as {saved}
                        </span>
                      </>
                    )}
                  </div>
                  {isLoading && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
                      <Loader2 size={12} className="animate-spin" /> AI analyzing…
                    </div>
                  )}
                  {error && (
                    <div className="mt-1.5 rounded border border-danger/30 bg-danger-tint px-1.5 py-1 text-[11px] text-danger">
                      {error}
                    </div>
                  )}
                  {result && (
                    <div className="mt-1.5">
                      <div className="flex items-center gap-1.5 text-[11.5px]">
                        {result.type === "Frozen" ? (
                          <Snowflake size={11} className="text-info" />
                        ) : (
                          <Package size={11} className="text-ink-2" />
                        )}
                        <span className="font-semibold text-ink">{result.type}</span>
                        <span className="text-[10px] text-ink-3">
                          {(result.confidence * 100).toFixed(0)}% confident
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] text-ink-3">
                        {result.reasoning}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        <Button
                          size="sm"
                          variant={saved === result.type ? "default" : "outline"}
                          className="h-7 text-[11px]"
                          disabled={isBusy}
                          onClick={() => save(pid, result.type, "ai")}
                        >
                          {isBusy && savedTypes[pid] !== result.type ? (
                            <Loader2 size={10} className="mr-1 animate-spin" />
                          ) : null}
                          Confirm {result.type}
                        </Button>
                        <Button
                          size="sm"
                          variant={
                            saved && saved !== result.type ? "default" : "outline"
                          }
                          className="h-7 text-[11px]"
                          disabled={isBusy}
                          onClick={() =>
                            save(pid, result.type === "Frozen" ? "Dry" : "Frozen", "manual")
                          }
                        >
                          Override to {result.type === "Frozen" ? "Dry" : "Frozen"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(dirtyRef.current)}>
            {allSaved ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Manual product-type set, PER ITEM. The previous version only saved a type
 * for items[0] — for a multi-item order with 3 different products, the
 * other two stayed null and the dashboard kept flagging the order
 * "no_type" forever. Now every line with a productId gets its own
 * Frozen/Dry pick that writes independently to ProductTypeOverride.
 */
function ManualTypeDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const classifiableItems = order.items.filter(
    (i): i is DashboardItem & { productId: number } => i.productId !== null,
  );
  const [savedTypes, setSavedTypes] = useState<Record<number, "Frozen" | "Dry">>(
    () =>
      Object.fromEntries(
        classifiableItems
          .filter((i) => i.knownType)
          .map((i) => [i.productId, i.knownType as "Frozen" | "Dry"]),
      ),
  );
  const [savingPid, setSavingPid] = useState<number | null>(null);
  const dirtyRef = useRef(false);

  async function save(productId: number, type: "Frozen" | "Dry") {
    setSavingPid(productId);
    try {
      await fetch("/api/shipping/product-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, type, source: "manual" }),
      });
      setSavedTypes((p) => ({ ...p, [productId]: type }));
      dirtyRef.current = true;
    } finally {
      setSavingPid(null);
    }
  }

  const allSaved =
    classifiableItems.length > 0 &&
    classifiableItems.every((i) => savedTypes[i.productId]);

  return (
    <Dialog open onOpenChange={() => onClose(dirtyRef.current)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {classifiableItems.length === 1
              ? savedTypes[classifiableItems[0]!.productId]
                ? "Change product type"
                : "Set product type"
              : `Set product type — ${classifiableItems.length} items`}
          </DialogTitle>
          <DialogDescription>
            {classifiableItems.length === 1
              ? classifiableItems[0]!.productTitle
              : "Pick Frozen or Dry for each line independently"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {classifiableItems.map((item) => {
            const pid = item.productId;
            const saved = savedTypes[pid];
            const isBusy = savingPid === pid;
            return (
              <div
                key={pid}
                className="flex items-center gap-3 rounded-md border border-rule bg-surface-tint p-2.5"
              >
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded border border-rule bg-bg-elev object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded border border-rule bg-bg-elev" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[12.5px] font-medium text-ink">
                    {item.productTitle}
                  </div>
                  <div className="mt-0.5 flex items-center gap-x-2 text-[10.5px] tabular text-ink-3">
                    <span>× {item.quantity}</span>
                    <span className="text-ink-4">·</span>
                    <span>SKU {item.sku}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant={saved === "Frozen" ? "default" : "outline"}
                    className="h-8 px-2.5 text-[11.5px]"
                    disabled={isBusy}
                    onClick={() => save(pid, "Frozen")}
                  >
                    {isBusy && saved !== "Frozen" ? (
                      <Loader2 size={11} className="mr-1 animate-spin" />
                    ) : (
                      <Snowflake size={11} className="mr-1 text-info" />
                    )}
                    Frozen
                  </Button>
                  <Button
                    size="sm"
                    variant={saved === "Dry" ? "default" : "outline"}
                    className="h-8 px-2.5 text-[11.5px]"
                    disabled={isBusy}
                    onClick={() => save(pid, "Dry")}
                  >
                    {isBusy && saved !== "Dry" ? (
                      <Loader2 size={11} className="mr-1 animate-spin" />
                    ) : (
                      <Package size={11} className="mr-1 text-ink-2" />
                    )}
                    Dry
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(dirtyRef.current)}>
            {allSaved ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackingProfileDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const [boxSize, setBoxSize] = useState("M");
  const [weight, setWeight] = useState("");
  const [weightFedex, setWeightFedex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const description = order.items
    .map((i) => `${i.productTitle} × ${i.quantity}`)
    .join(" + ");
  const totalQty = order.items.reduce((sum, i) => sum + i.quantity, 0);

  async function save() {
    if (!order.packingSignature) {
      setErr("Order has no packing signature");
      return;
    }
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
      setErr("Weight must be a positive number");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/shipping/packing-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature: order.packingSignature,
          description,
          boxSize,
          weight: w,
          weightFedex: weightFedex
            ? Number(weightFedex)
            : undefined,
          itemCount: order.items.length,
          totalQty,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      onClose(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Packing profile</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[12.5px]">
          <div>
            <div className="font-medium text-ink mb-1">Composition</div>
            <ul className="rounded border border-rule bg-surface-tint p-2 text-ink-2 space-y-0.5">
              {order.items.map((i) => (
                <li key={i.sku}>
                  • {i.productTitle} × {i.quantity} ({i.sku})
                </li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] text-ink-3">
              Signature:{" "}
              <code className="font-mono">{order.packingSignature}</code>
            </div>
          </div>

          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box size
            </label>
            <select
              value={boxSize}
              onChange={(e) => setBoxSize(e.target.value)}
              className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
            >
              <option>XS</option>
              <option>S</option>
              <option>M</option>
              <option>L</option>
              <option>XL</option>
              <option>XXS</option>
              <option>12x12x8</option>
              <option>12x12x6</option>
              <option>7x7x6</option>
              <option>7x5x14</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Weight (lbs)
              </label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="2.5"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                FedEx One Rate (lbs)
              </label>
              <Input
                value={weightFedex}
                onChange={(e) => setWeightFedex(e.target.value)}
                placeholder="auto = weight × 1.25"
              />
            </div>
          </div>

          {err && (
            <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
              {err}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add SKU to the internal SkuShippingData table (the same data layer the
 * plan route reads). Used when the dashboard flagged an order as no_sku.
 *
 * Saving one row at a time per visible SKU keeps it simple — when an order
 * has multiple unknown SKUs the operator gets called back here for each.
 */
function SkuDataDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  // Pick the first SKU as the one we're filling in. The rare case of
  // multiple unknown SKUs in one order will re-open the dialog on the
  // next render after dashboard refresh.
  const item = order.items[0];
  const [productTitle, setProductTitle] = useState(item?.productTitle ?? "");
  const [category, setCategory] = useState<"Frozen" | "Dry">(
    item?.knownType ?? "Dry"
  );
  const [marketplace, setMarketplace] = useState(
    order.channel?.toLowerCase().includes("walmart") ? "Walmart" : "Amazon"
  );
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [weightFedex, setWeightFedex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!item) return;
    const L = Number(length);
    const W = Number(width);
    const H = Number(height);
    const wt = Number(weight);
    if (
      ![L, W, H, wt].every((n) => Number.isFinite(n) && n > 0)
    ) {
      setErr("Length, width, height, weight must all be positive numbers");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/shipping/fix-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: item.sku,
          productTitle,
          marketplace,
          category,
          length: L,
          width: W,
          height: H,
          weight: wt,
          weightFedex: weightFedex ? Number(weightFedex) : wt * 1.25,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      onClose(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add SKU to database</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber} · SKU{" "}
            <code className="font-mono">{item?.sku}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[12.5px]">
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Product title
            </label>
            <Input
              value={productTitle}
              onChange={(e) => setProductTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Marketplace
              </label>
              <select
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value)}
                className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
              >
                <option>Amazon</option>
                <option>Walmart</option>
                <option>Both</option>
              </select>
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as "Frozen" | "Dry")
                }
                className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
              >
                <option>Dry</option>
                <option>Frozen</option>
              </select>
            </div>
          </div>
          {/* Box preset — single dropdown over the L/W/H inputs. Picking
              a preset fills the three fields; the operator can still
              hand-tune after. */}
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box preset
            </label>
            <select
              defaultValue=""
              onChange={(e) => {
                const preset = BOX_PRESETS.find(
                  (p) => p.label === e.target.value
                );
                if (!preset) return;
                setLength(String(preset.l));
                setWidth(String(preset.w));
                setHeight(String(preset.h));
              }}
              className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
            >
              <option value="">Select template…</option>
              {BOX_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} ({p.l}×{p.w}×{p.h} in)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Length (in)
              </label>
              <Input
                value={length}
                onChange={(e) => setLength(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Width (in)
              </label>
              <Input
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Height (in)
              </label>
              <Input
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Weight (lbs)
              </label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="standard"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                FedEx One Rate (lbs)
              </label>
              <Input
                value={weightFedex}
                onChange={(e) => setWeightFedex(e.target.value)}
                placeholder="auto = weight × 1.25"
              />
            </div>
          </div>

          {err && (
            <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
              {err}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// Buy report dialog
//
// Forced acknowledgement after every buy attempt. Lists exactly which
// labels printed, which PDFs landed on disk, and which orders failed —
// so a missed label can't slip through unnoticed (the cost of one
// unshipped order is hours of CS work plus marketplace penalty).
// ─────────────────────────────────────────────────────────────────────────
function BuyReportDialog({
  report,
  onClose,
}: {
  report: BuyReport;
  onClose: () => void;
}) {
  const okCount = report.bought.length;
  const failCount = report.errors.length;
  // Drive success — counted off pdfSource (the real signal), not labelPath
  // (which is set even for the proxy fallback). The old counter showed a
  // green "5/5 saved" when Drive was misconfigured and every PDF actually
  // lived only on Veeqo's CDN — masking the integration outage.
  const driveCount = report.bought.filter((b) => b.pdfSource === "drive").length;
  const proxyOrDiskCount = report.bought.filter(
    (b) => b.pdfSource === "proxy" || b.pdfSource === "disk",
  ).length;
  const allOnDrive = okCount > 0 && driveCount === okCount;
  const allOk = failCount === 0 && allOnDrive;
  const title =
    report.scope === "single"
      ? "Label purchase result"
      : `Bulk purchase — ${report.total} order(s)`;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {allOk
              ? "All labels purchased and PDFs saved."
              : "Review the items below — at least one needs attention."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-[12.5px]">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded border border-rule bg-surface-tint p-2">
              <div className="text-[11px] text-ink-3">Bought</div>
              <div className="text-base font-semibold text-green-ink">
                {okCount}
              </div>
            </div>
            <div className="rounded border border-rule bg-surface-tint p-2">
              <div className="text-[11px] text-ink-3">On Drive</div>
              <div
                className={cn(
                  "text-base font-semibold",
                  driveCount === okCount
                    ? "text-green-ink"
                    : driveCount > 0
                      ? "text-warn-strong"
                      : "text-danger"
                )}
              >
                {driveCount}/{okCount}
              </div>
            </div>
            <div className="rounded border border-rule bg-surface-tint p-2">
              <div className="text-[11px] text-ink-3">Failed</div>
              <div
                className={cn(
                  "text-base font-semibold",
                  failCount === 0 ? "text-ink" : "text-danger"
                )}
              >
                {failCount}
              </div>
            </div>
          </div>

          {proxyOrDiskCount > 0 && (
            <div className="rounded border border-warn-strong bg-warn-tint p-2 text-[12px]">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-warn-strong"
                />
                <div>
                  <div className="font-medium text-warn-strong">
                    {proxyOrDiskCount} of {okCount} labels NOT saved to Drive
                  </div>
                  <div className="text-[11px] text-ink-2 mt-0.5">
                    These PDFs are accessible via fallback URLs but aren&apos;t
                    archived in <code>Shipping Labels</code> folder. Most common
                    cause: <code>GOOGLE_OAUTH_*</code> env vars missing on
                    Vercel. See{" "}
                    <a
                      href="/admin/integrations"
                      className="text-info underline ml-1"
                    >
                      Integrations
                    </a>{" "}
                    or wiki/google-drive-setup.md.
                  </div>
                  {(() => {
                    const firstErr = report.bought.find(
                      (b) => b.driveError,
                    )?.driveError;
                    if (!firstErr) return null;
                    return (
                      <div className="text-[11px] text-ink-3 mt-1 font-mono">
                        {firstErr}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {report.bought.length > 0 && (
            <div>
              <div className="font-medium text-ink mb-1">Purchased</div>
              <ul className="rounded border border-rule bg-surface-tint p-2 space-y-1 max-h-[180px] overflow-y-auto">
                {report.bought.map((b) => (
                  <li key={b.itemId} className="flex items-start gap-2">
                    <CheckCircle
                      size={13}
                      className="mt-0.5 shrink-0 text-green-ink"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12px]">
                        {b.orderNumber}
                      </div>
                      <div className="text-[11px] text-ink-2">
                        {b.service ?? b.carrier ?? ""}
                        {b.price != null && (
                          <span className="text-ink-3">
                            {" · $"}
                            {b.price.toFixed(2)}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-3">
                        Tracking:{" "}
                        <span className="font-mono text-ink-2">
                          {b.tracking}
                        </span>
                      </div>
                      {b.pdfSaved && b.labelPath ? (
                        <a
                          href={b.labelPath}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-info underline"
                        >
                          Open PDF
                        </a>
                      ) : (
                        <div className="text-[11px] text-warn-strong">
                          ⚠ PDF not saved locally — re-download from Veeqo
                        </div>
                      )}
                      <div className="text-[11px] mt-0.5">
                        PDF:{" "}
                        <span
                          className={cn(
                            "font-medium",
                            b.pdfSource === "drive"
                              ? "text-green-ink"
                              : b.pdfSource === "proxy"
                                ? "text-warn-strong"
                                : b.pdfSource === "disk"
                                  ? "text-info"
                                  : "text-danger",
                          )}
                        >
                          {b.pdfSource === "drive"
                            ? "✓ on Drive"
                            : b.pdfSource === "proxy"
                              ? "via Veeqo proxy (not on Drive)"
                              : b.pdfSource === "disk"
                                ? "local disk only"
                                : "missing"}
                        </span>
                        {b.driveError && (
                          <span className="ml-1 text-[10.5px] text-ink-3 font-mono">
                            · {b.driveError}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.errors.length > 0 && (
            <div>
              <div className="font-medium text-ink mb-1">Failed</div>
              <ul className="rounded border border-danger bg-danger-tint p-2 space-y-1 max-h-[180px] overflow-y-auto">
                {report.errors.map((e) => (
                  <li key={e.itemId} className="flex items-start gap-2">
                    <AlertTriangle
                      size={13}
                      className="mt-0.5 shrink-0 text-danger"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12px]">
                        {e.orderNumber}
                      </div>
                      <div className="text-[11px] text-danger break-words">
                        {e.error}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// EditPackageDialog
//
// Inline edit for a row's weight + box. Click on the PACKAGE cell opens
// this. It writes through to the same data layer the plan algorithm
// reads — SkuShippingData for single-item orders, PackingProfile for
// multi-item — and after save calls load() on the page to recompute the
// rate against the new packaging.
// ─────────────────────────────────────────────────────────────────────────
function EditPackageDialog({
  order,
  plan,
  onClose,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  onClose: (refresh: boolean) => void;
}) {
  const isMulti =
    order.items.length > 1 ||
    order.items.some((i) => i.quantity > 1);
  const sku = order.items[0]?.sku ?? "";
  const firstQty = order.items.reduce((s, i) => s + i.quantity, 0);

  // Pre-fill with the current plan values when present, otherwise blank.
  // Box size on the plan comes back as e.g. "13x13x15" or as a preset
  // label ("M"). For multi-item we use the preset dropdown; for single-
  // item we parse the dims so the operator sees the actual numbers.
  const parseBox = (s: string | null | undefined) => {
    if (!s) return { l: "", w: "", h: "" };
    const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
    if (m) return { l: m[1], w: m[2], h: m[3] };
    const preset = BOX_PRESETS.find((p) => p.label === s);
    if (preset)
      return { l: String(preset.l), w: String(preset.w), h: String(preset.h) };
    return { l: "", w: "", h: "" };
  };

  const initialBox = parseBox(plan?.boxSize);
  // boxLabel: preset name from the dropdown ("M", "12x12x6") OR "custom"
  // when the operator wants to enter any dimensions by hand. We seed it
  // from the saved label when it matches a preset, otherwise default to
  // "custom" so the L/W/H fields stay free-edit.
  const initialIsPreset = BOX_PRESETS.some((p) => p.label === plan?.boxSize);
  const [boxLabel, setBoxLabel] = useState<string>(
    initialIsPreset ? (plan?.boxSize as string) : "custom",
  );
  const [length, setLength] = useState(initialBox.l);
  const [width, setWidth] = useState(initialBox.w);
  const [height, setHeight] = useState(initialBox.h);
  const [weight, setWeight] = useState(
    plan?.weight != null ? String(plan.weight) : "",
  );
  const [weightFedex, setWeightFedex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handlePresetChange = (label: string) => {
    setBoxLabel(label);
    if (label === "custom") return; // leave L/W/H as-is for free editing
    const preset = BOX_PRESETS.find((p) => p.label === label);
    if (preset) {
      setLength(String(preset.l));
      setWidth(String(preset.w));
      setHeight(String(preset.h));
    }
  };

  async function save() {
    setErr(null);
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
      setErr("Weight must be a positive number");
      return;
    }

    setSaving(true);
    try {
      // Both paths now require explicit L/W/H — even for multi-item.
      // Pencakers used to be able to save just a preset label, but that
      // left the rate engine guessing at custom-cooler dimensions.
      const L = Number(length);
      const W = Number(width);
      const H = Number(height);
      if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) {
        throw new Error("Length, width, height must all be positive numbers");
      }
      // boxSize string is "LxWxH" for custom, or the preset label
      // ("M", "12x12x6") so the warehouse can still see the friendly
      // name in plan exports.
      const boxSizeStr =
        boxLabel && boxLabel !== "custom" ? boxLabel : `${L}x${W}x${H}`;

      // Allocation id (when known) lets the API also push the new
      // packaging to Veeqo's /allocations/{id}/allocation_package so
      // the next rate quote uses the updated size — otherwise Veeqo
      // would keep returning rates against its own cached packaging.
      const allocationId = plan?.allocationId ?? undefined;

      let body: Record<string, unknown>;
      if (isMulti) {
        if (!order.packingSignature) {
          throw new Error("Order missing packing signature");
        }
        body = {
          signature: order.packingSignature,
          description: order.items
            .map((i) => `${i.productTitle} × ${i.quantity}`)
            .join(" + "),
          itemCount: order.items.length,
          totalQty: firstQty,
          boxSize: boxSizeStr,
          length: L,
          width: W,
          height: H,
          weight: w,
          weightFedex: weightFedex ? Number(weightFedex) : undefined,
          allocationId,
          channel: order.channel ?? undefined,
        };
      } else {
        if (!sku) {
          throw new Error("Order has no SKU");
        }
        body = {
          sku,
          length: L,
          width: W,
          height: H,
          weight: w,
          weightFedex: weightFedex ? Number(weightFedex) : undefined,
          allocationId,
          channel: order.channel ?? undefined,
        };
      }
      const r = await fetch("/api/shipping/edit-package", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      // Local DB save succeeded. Check whether the Veeqo allocation_package
      // push also succeeded — without it, the next rate quote still comes
      // back against the OLD packaging and the operator buys (or gets
      // shown) a rate that won't match what Veeqo will actually charge.
      // Keep the dialog open on Veeqo failure so the operator sees it
      // and can decide whether to retry or fix the packaging in Veeqo
      // directly.
      const j = (await r.json().catch(() => ({}))) as {
        veeqo?: { ok: boolean; reason?: string };
      };
      if (j.veeqo && j.veeqo.ok === false) {
        const reason = j.veeqo.reason || "unknown reason";
        throw new Error(
          `Saved to our DB, but Veeqo did NOT update its packaging — rates will still be quoted against the old size/weight.\n\nVeeqo said: ${reason}\n\nFix the packaging in Veeqo directly, then click Refresh on the shipping page.`,
        );
      }
      onClose(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {isMulti ? "Edit packing profile" : "Edit package"}
          </DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber} ·{" "}
            {isMulti ? (
              <code className="font-mono">{order.packingSignature}</code>
            ) : (
              <code className="font-mono">{sku}</code>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-[12.5px]">
          {/* Box preset dropdown — quick-fills the L/W/H fields below.
              "Custom…" leaves L/W/H untouched so the operator can punch
              in any dimensions (e.g. 24×18×18 for a 4-pack styrofoam
              cooler that doesn't match any standard preset). */}
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box preset
            </label>
            <select
              value={boxLabel}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px] text-ink focus:border-green focus:outline-none"
            >
              <option value="custom">Custom… (enter dimensions below)</option>
              {BOX_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} — {p.l}×{p.w}×{p.h} in
                </option>
              ))}
            </select>
          </div>

          {/* L/W/H always editable. Preset selection prefills these;
              Custom leaves them as-is. */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                L (in)
              </label>
              <Input
                value={length}
                onChange={(e) => {
                  setLength(e.target.value);
                  setBoxLabel("custom");
                }}
                placeholder="13"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                W (in)
              </label>
              <Input
                value={width}
                onChange={(e) => {
                  setWidth(e.target.value);
                  setBoxLabel("custom");
                }}
                placeholder="13"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                H (in)
              </label>
              <Input
                value={height}
                onChange={(e) => {
                  setHeight(e.target.value);
                  setBoxLabel("custom");
                }}
                placeholder="15"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Weight (lbs)
              </label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="2.5"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                FedEx One Rate (lbs)
              </label>
              <Input
                value={weightFedex}
                onChange={(e) => setWeightFedex(e.target.value)}
                placeholder="auto = weight × 1.25"
              />
            </div>
          </div>

          <div className="rounded border border-rule bg-surface-tint p-2 text-[11px] text-ink-3">
            Saves to{" "}
            {isMulti ? (
              <code className="font-mono">PackingProfile</code>
            ) : (
              <code className="font-mono">SkuShippingData</code>
            )}
            . Future plans for this {isMulti ? "composition" : "SKU"} will use
            the new values. After save the row reloads and re-quotes the rate
            against the new packaging.
          </div>

          {err && (
            <div className="whitespace-pre-line rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
              {err}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PickRateDialog
//
// Lists every rate Veeqo offers for this order so the operator can override
// the algorithm's pick. Selecting a row stages a RateOverride in page-level
// state — actual purchase still happens through the regular Buy flow, which
// passes the override to /api/shipping/buy.
// ─────────────────────────────────────────────────────────────────────────
interface VeeqoRateLite {
  name?: string;
  title?: string;
  short_title?: string;
  sub_carrier_id?: string;
  service_carrier?: string;
  service_id?: string;
  carrier?: string;
  remote_shipment_id?: string;
  total_net_charge?: string;
  base_rate?: string;
  delivery_promise_date?: string;
}

function PickRateDialog({
  order,
  plan,
  onClose,
  onPick,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  onClose: () => void;
  onPick: (override: RateOverride) => void;
}) {
  const [rates, setRates] = useState<VeeqoRateLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/shipping/rates?orderId=${encodeURIComponent(order.orderId)}`,
        );
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j?.error || `HTTP ${r.status}`);
        } else {
          setRates(j.rates ?? []);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order.orderId]);

  // Sort rates cheapest-first so the typical pick is at the top.
  const sortedRates = useMemo(() => {
    return [...rates].sort((a, b) => {
      const ap = parseFloat(a.total_net_charge ?? "0") || 0;
      const bp = parseFloat(b.total_net_charge ?? "0") || 0;
      return ap - bp;
    });
  }, [rates]);

  const currentPickName = plan?.service ?? null;

  function pickRate(rate: VeeqoRateLite) {
    const price = parseFloat(rate.total_net_charge ?? "0") || null;
    const edd = rate.delivery_promise_date
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
          .format(new Date(rate.delivery_promise_date))
      : null;
    onPick({
      carrier: rate.sub_carrier_id ?? null,
      service: rate.title ?? null,
      serviceType: rate.name ?? null,
      subCarrierId: rate.sub_carrier_id ?? null,
      serviceCarrier: rate.service_carrier ?? null,
      carrierId: rate.carrier ?? null,
      remoteShipmentId: rate.remote_shipment_id ?? null,
      totalNetCharge: rate.total_net_charge ?? null,
      baseRate: rate.base_rate ?? null,
      edd,
      price,
    });
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Pick rate manually</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber} — choose any rate from Veeqo. The
            algorithm&apos;s current pick is highlighted.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-10 text-[12px] text-ink-3">
            <Loader2 size={16} className="mr-2 animate-spin" /> Fetching rates…
          </div>
        )}

        {err && (
          <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
            {err}
          </div>
        )}

        {!loading && !err && sortedRates.length === 0 && (
          <div className="py-6 text-center text-[12px] text-ink-3">
            Veeqo returned no rates for this order.
          </div>
        )}

        {!loading && !err && sortedRates.length > 0 && (
          <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
            {sortedRates.map((rate, i) => {
              const isCurrent =
                currentPickName != null && rate.title === currentPickName;
              const edd = rate.delivery_promise_date
                ? new Intl.DateTimeFormat("en-CA", {
                    timeZone: "America/New_York",
                  }).format(new Date(rate.delivery_promise_date))
                : "";
              // On time vs late vs the marketplace deadline (deliver-by).
              // null = unknown (no deadline or no EDD → no badge).
              const onTime =
                order.deliverBy && edd
                  ? (daysLate(order.deliverBy, edd) ?? 1) <= 0
                  : null;
              return (
                <li key={`${rate.name}-${i}`}>
                  <button
                    type="button"
                    onClick={() => pickRate(rate)}
                    className={cn(
                      "w-full rounded border px-3 py-2 text-left transition-colors",
                      onTime === false
                        ? "border-danger/40 bg-danger-tint/40 hover:bg-danger-tint/60"
                        : isCurrent
                          ? "border-green bg-green-soft hover:bg-green-soft2"
                          : "border-rule bg-surface hover:bg-bg-elev",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-ink text-[13px]">
                            {rate.title || rate.short_title || rate.name}
                          </span>
                          {onTime === true && (
                            <span className="shrink-0 rounded bg-green-soft px-1.5 py-px text-[10px] font-medium text-green-ink">
                              on time
                            </span>
                          )}
                          {onTime === false && (
                            <span className="shrink-0 rounded bg-danger-tint px-1.5 py-px text-[10px] font-medium text-danger">
                              misses deadline
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] font-mono text-ink-3">
                          {(rate.sub_carrier_id ?? "").toUpperCase()}
                          {edd ? (
                            <span className={onTime === false ? "text-danger" : ""}>
                              {` · EDD ${fmtDate(edd)}`}
                            </span>
                          ) : (
                            ""
                          )}
                          {isCurrent ? " · current pick" : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-semibold text-ink tabular text-[13px]">
                          ${parseFloat(rate.total_net_charge ?? "0").toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Walmart-order rate picker. Unlike PickRateDialog (Veeqo), this fetches rates
// from Walmart's own Ship-with-Walmart API and lets the operator change the
// ship date to re-quote (Walmart rates differ by dispatch day). Picking a rate
// updates both the row display and what the Buy button will purchase.
interface WalmartRateLite {
  carrierName: string;
  serviceType: string;
  displayName: string;
  amount: number | null;
  deliveryDate: string | null;
  deliveryPromiseFulfilled?: boolean;
}

function WalmartPickRateDialog({
  order,
  currentServiceType,
  initialShipDate,
  deadlineBy,
  onShipDateChange,
  onClose,
  onPick,
}: {
  order: DashboardOrder;
  currentServiceType: string | null;
  // The order's current effective ship date — the dialog opens on it.
  initialShipDate?: string;
  // Marketplace deliver-by deadline, for the on-time / late highlight.
  deadlineBy?: string | null;
  // Fired whenever the operator changes the dialog's ship date, so the row +
  // Buy stay in sync even if they close without picking a rate.
  onShipDateChange?: (date: string) => void;
  onClose: () => void;
  onPick: (rate: WalmartRateLite, shipDate: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [shipDate, setShipDate] = useState<string>(
    initialShipDate || (order.shipBy && order.shipBy.slice(0, 10)) || today,
  );
  const [rates, setRates] = useState<WalmartRateLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const fetchRates = useCallback(
    async (date: string) => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch("/api/shipping/walmart/rates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purchaseOrderId: order.walmartPurchaseOrderId,
            shipByDate: date,
          }),
        });
        const j = await r.json();
        if (!r.ok || j?.ok === false) {
          setErr(j?.error || `HTTP ${r.status}`);
          setRates([]);
        } else {
          setRates(j.rates ?? []);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [order.walmartPurchaseOrderId],
  );

  useEffect(() => {
    fetchRates(shipDate);
  }, [fetchRates, shipDate]);

  const sorted = useMemo(
    () => [...rates].sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity)),
    [rates],
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Pick rate manually — Walmart</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber} — rates from Walmart (Ship with Walmart).
            Change the ship date to re-quote.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-[12px]">
          <label className="font-medium text-ink">Ship date</label>
          <input
            type="date"
            value={shipDate}
            onChange={(e) => {
              setShipDate(e.target.value);
              onShipDateChange?.(e.target.value);
            }}
            className="rounded border border-rule bg-surface px-2 py-1 text-[12.5px] focus:border-[#0071dc] focus:outline-none"
          />
          {loading && <Loader2 size={14} className="animate-spin text-ink-3" />}
          {deadlineBy && (
            <span className="ml-auto text-[11px] text-ink-3">
              Deadline {fmtDate(deadlineBy)}
            </span>
          )}
        </div>

        {err && (
          <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
            {err}
          </div>
        )}

        {!loading && !err && sorted.length === 0 && (
          <div className="py-6 text-center text-[12px] text-ink-3">
            Walmart returned no rates for this ship date.
          </div>
        )}

        {!err && sorted.length > 0 && (
          <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
            {sorted.map((rate, i) => {
              const isCurrent =
                currentServiceType != null && rate.serviceType === currentServiceType;
              // Does this rate hit the marketplace deadline? Prefer Walmart's
              // own promise flag; fall back to comparing the rate's EDD with
              // the deliver-by date. null = unknown (no badge).
              const onTime =
                rate.deliveryPromiseFulfilled === true
                  ? true
                  : rate.deliveryPromiseFulfilled === false
                    ? false
                    : deadlineBy && rate.deliveryDate
                      ? (daysLate(deadlineBy, rate.deliveryDate) ?? 1) <= 0
                      : null;
              return (
                <li key={`${rate.serviceType}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onPick(rate, shipDate)}
                    className={cn(
                      "w-full rounded border px-3 py-2 text-left transition-colors",
                      onTime === false
                        ? "border-danger/40 bg-danger-tint/40 hover:bg-danger-tint/60"
                        : isCurrent
                          ? "border-green bg-green-soft hover:bg-green-soft2"
                          : "border-rule bg-surface hover:bg-bg-elev",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-ink text-[13px]">
                            {rate.displayName}
                          </span>
                          {onTime === true && (
                            <span className="shrink-0 rounded bg-green-soft px-1.5 py-px text-[10px] font-medium text-green-ink">
                              on time
                            </span>
                          )}
                          {onTime === false && (
                            <span className="shrink-0 rounded bg-danger-tint px-1.5 py-px text-[10px] font-medium text-danger">
                              misses deadline
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] font-mono text-ink-3">
                          {(rate.carrierName ?? "").toUpperCase()}
                          {rate.deliveryDate ? (
                            <span className={onTime === false ? "text-danger" : ""}>
                              {` · EDD ${fmtDate(rate.deliveryDate)}`}
                            </span>
                          ) : (
                            ""
                          )}
                          {isCurrent ? " · current pick" : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-semibold text-ink tabular text-[13px]">
                        {rate.amount != null ? `$${rate.amount.toFixed(2)}` : "—"}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

