"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoxPresetPicker } from "./components/BoxPresetPicker";
import { MergeGroupCard } from "./components/MergeGroupCard";
import { WeightInput, toLbs, type WeightUnit } from "./components/WeightInput";
import {
  Btn,
  StoreAvatar,
  storeKeyFor,
  TypeTag,
} from "@/components/kit";
import { cn } from "@/lib/utils";
import { utcToPacificYMD, effectiveBusinessDay } from "@/lib/shipping/dates";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ChannelToggle } from "@/lib/channel-brands";
// DYMO Connect Web Service path was tried (port 41951 HTTPS / 41952 HTTP) but
// the local DYMO Label service only enumerates older LabelWriter models
// (e.g. 450) — it doesn't see the 5XL that's wired in via the macOS CUPS
// driver. Rather than fight the SDK, we open the PDF in a new tab and let
// the operator Cmd+P → DYMO 5XL through the native print dialog. The
// dymo-print.ts helpers are kept around in case a future DYMO Connect
// install reports the 5XL on a reachable port.
import FrozenRiskBadge, {
  type ShippingFrozenAlert,
} from "@/components/shipping/FrozenRiskBadge";
import { PhotoLightbox } from "@/app/procurement/components/PhotoLightbox";

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
  // The shipping speed the buyer chose, from Veeqo's delivery_method.name
  // ("Standard", "Expedited", "Second Day", "Next Day", …). Shown next to
  // the customer-paid-shipping amount. Null when Veeqo didn't carry one.
  customerShippingService?: string | null;
  currency: string;
  // Walmart-direct flow: when true, this order's label is rate-shopped +
  // bought via Walmart (not Veeqo), keyed by walmartPurchaseOrderId.
  isWalmart?: boolean;
  walmartPurchaseOrderId?: string | null;
  // Veeqo channel.type_code lowercased — "amazon", "walmart", "ebay",
  // "tiktok", "shopify", "direct" (merged), etc. Drives the dynamic
  // channel-filter chips at the top of the page.
  channelKind?: string | null;
  // Shipping recipient (Veeqo deliver_to) — name + city/state shown on the
  // row so the operator can sanity-check the destination without opening
  // Veeqo. Each can be null when Veeqo's address is missing the field.
  // `shipToState` (not `state`) to avoid colliding with the state-machine
  // `state: State` above.
  customerName?: string | null;
  city?: string | null;
  shipToState?: string | null;
  // Street + ZIP + buyer email are NOT rendered on the row — they travel
  // with the payload so the smart search can match on them (looking an
  // order up by ZIP or street is a real operator workflow).
  shipToZip?: string | null;
  shipToAddress?: string | null;
  customerEmail?: string | null;
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
  // Set once a label is bought against this plan item. Optional because a
  // live Walmart quote is folded into the same map before any purchase.
  // Fed into the smart search so a tracking number finds the LIVE row, not
  // just its archive copy.
  trackingNumber?: string | null;
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
  // Purchase identifiers (present in the /plan response). Surfaced on the type
  // so a ship-date re-quote can build a full RateOverride from the recommended
  // rate it returns.
  serviceType?: string | null;
  subCarrierId?: string | null;
  serviceCarrier?: string | null;
  carrierId?: string | null;
  remoteShipmentId?: string | null;
  totalNetCharge?: string | null;
  baseRate?: string | null;
}

interface PlanResponse {
  planId: string;
  date: string;
  orders: PlanItem[];
}

/**
 * The box + weight the operator just saved in the Edit-package dialog.
 *
 * Handed to the re-quote so the row can show the new packaging IMMEDIATELY —
 * before (and even if) the carrier quote comes back. Without it a failed or
 * rate-limited re-quote left the cell reading "Set weight/size" again, which
 * is indistinguishable from "my Save did nothing".
 */
interface SavedPackage {
  length: number;
  width: number;
  height: number;
  weight: number;
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
  // Physical ship day the operator forced when picking this rate (inline
  // picker / rate modal). Drives the buy's dispatch-date dance.
  physicalShipDate?: string | null;
}

// One group of same-address orders the operator could merge, as returned by
// GET /api/shipping/merge. `mergeable` is false when a member hasn't been
// marked Placed — those are shown rather than hidden, because "these two would
// ship together once the goods are bought" is a procurement signal.
interface MergeCandidate {
  signature: string;
  channelKind: string;
  storeName: string | null;
  recipient: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  orders: Array<{ id: string; orderNumber: string; storeName: string | null }>;
  mergeable: boolean;
  blockedOrderNumbers: string[];
}

// A group the operator has already merged. It owns the combined package and,
// once bought, the single tracking number mirrored onto every member.
export interface MergeGroup {
  id: string;
  checksum: string;
  channelKind: string;
  storeName: string | null;
  primaryOrderId: string;
  productType: string | null;
  boxSize: string | null;
  weight: number | null;
  status: string;
  trackingNumber: string | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
  labelPdfUrl: string | null;
  members: Array<{
    id: string;
    orderId: string;
    orderNumber: string;
    allocationId: string | null;
    walmartPurchaseOrderId: string | null;
    shipmentSyncedAt: string | null;
    shipmentSyncError: string | null;
  }>;
}

interface MergeState {
  groupCount: number;
  orderCount: number;
  readyCount: number;
  candidates: MergeCandidate[];
  groups: MergeGroup[];
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
  // New for the auto-print feature: when Print mode is ON, the client
  // takes pdfBase64 → renders to PNG → POSTs to DYMO Connect, and on a
  // successful DYMO response calls /api/shipping/mark-label-printed
  // with driveFileId to move the file into the sibling Printed/ folder.
  // Both fields are optional — older buys / non-Drive-saved labels
  // won't have them, and the toggle silently skips printing in that case.
  pdfBase64?: string | null;
  driveFileId?: string | null;
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

/**
 * One result from /api/shipping/search — an order found ANYWHERE, at any
 * status, including ones this page never loads (shipped / delivered /
 * cancelled / refunded). Shape mirrors the route's SearchHit exactly.
 */
interface ArchiveHit {
  key: string;
  sources: string[];
  orderNumber: string;
  veeqoOrderId: string | null;
  channel: string | null;
  channelKind: string | null;
  status: string;
  statusLabel: string;
  statusTone: "ok" | "warn" | "danger" | "neutral";
  orderDate: string | null;
  shipBy: string | null;
  deliverBy: string | null;
  customerName: string | null;
  customerEmail: string | null;
  address: string | null;
  total: number | null;
  currency: string;
  items: {
    sku: string | null;
    title: string;
    quantity: number;
    imageUrl: string | null;
  }[];
  tracking: { number: string; carrier: string | null; service: string | null }[];
  labelPdfUrl: string | null;
  walmartPurchaseOrderId: string | null;
  storeName: string | null;
}

/** From this many characters the archive (all-status) search kicks in. */
const ARCHIVE_MIN_CHARS = 3;

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

// Same as todayInET, but advances Sat/Sun/federal-holiday to the next
// business day. The warehouse doesn't physically ship on those days,
// so defaulting the Ship-date picker to a non-business day misleads
// the operator (they read "Ship 6/07" on a Sunday-load and assume
// physical pickup is Sunday). Vladimir's call 2026-06-07: the picker
// must show 6/08 in that scenario.
function nextWarehouseShipDay(): string {
  return effectiveBusinessDay(todayInET());
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
// Label PDF helpers (bulk print → one strip)
// ─────────────────────────────────────────────────────────────────────────

// Decode a base64 string (the label PDF bytes the buy API returns) into a
// byte array we can wrap in a Blob.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Open PDF bytes in a new browser tab. window.open after an await commonly
// trips popup blockers; the anchor-click trick is the standard workaround
// that Chrome treats as a user-initiated navigation, not an auto popup.
function openPdfInTab(bytes: Uint8Array<ArrayBuffer>): void {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Concatenate several label PDFs (base64) into a single multi-page PDF so
// the operator prints one continuous strip on the DYMO instead of clicking
// through N separate tabs. pdf-lib is dynamic-imported to keep it out of
// the initial page bundle — it's only needed at buy time.
async function mergePdfsFromBase64(
  base64List: string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  for (const b64 of base64List) {
    const src = await PDFDocument.load(base64ToBytes(b64));
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  // Copy into a plain ArrayBuffer-backed view so it's a valid Blob part.
  return new Uint8Array(await merged.save());
}

// ─────────────────────────────────────────────────────────────────────────
// Identical-selection detection (warn on same product / different quantity)
// ─────────────────────────────────────────────────────────────────────────

// Product identity of an order, ignoring quantity — the sorted set of SKUs
// (falling back to the title when a SKU is missing). Two orders share this
// key when they contain the same products, regardless of how many units.
function orderProductKey(o: DashboardOrder): string {
  return o.items
    .map((it) => it.sku || it.productTitle)
    .sort()
    .join(" + ");
}

// Per-order signature INCLUDING quantity. Orders with the same product key
// but different qty signatures are the dangerous case the operator asked us
// to catch: "I thought all 5 were 1 unit, but one was actually 2."
function orderQtySignature(o: DashboardOrder): string {
  return o.items
    .map((it) => `${it.sku || it.productTitle}×${it.quantity}`)
    .sort()
    .join(" + ");
}

// Looks for selected orders that are the SAME product but DIFFERENT
// quantities. Returns a human-readable warning block per offending product
// group, or [] when every shared-product group has matching quantities.
// Different products in the selection are normal bulk-buy and never warn.
function detectQuantityMismatch(orders: DashboardOrder[]): string[] {
  const byProduct = new Map<string, DashboardOrder[]>();
  for (const o of orders) {
    const key = orderProductKey(o);
    const group = byProduct.get(key);
    if (group) group.push(o);
    else byProduct.set(key, [o]);
  }
  const warnings: string[] = [];
  for (const group of byProduct.values()) {
    if (group.length < 2) continue;
    const sigs = new Set(group.map(orderQtySignature));
    if (sigs.size <= 1) continue; // all identical → no warning
    const title = group[0].items[0]?.productTitle ?? orderProductKey(group[0]);
    const lines = group
      .map(
        (o) =>
          `  • ${o.orderNumber}: ${o.items
            .map((it) => `${it.quantity}× ${it.productTitle}`)
            .join(", ")}`,
      )
      .join("\n");
    warnings.push(`"${title}"\n${lines}`);
  }
  return warnings;
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
    nextWarehouseShipDay(),
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
        // Set true when Walmart 429-d (or otherwise refused) the
        // labels-lookup. Buy must be disabled on this row until a
        // successful re-quote — otherwise a 429 lets the operator
        // accidentally buy a second label on an already-bought order.
        labelLookupFailed?: boolean;
        labelLookupError?: string | null;
      }
    >
  >({});
  const [markingShipped, setMarkingShipped] = useState<string | null>(null);
  // In-flight Mark-as-Placed button (waiting_placed rows). Same shape as
  // markingShipped — stops double-clicks while the Placed tag write
  // round-trips to Veeqo.
  const [markingPlaced, setMarkingPlaced] = useState<string | null>(null);
  // In-flight Rollback button. Stops double-clicks while we strip Placed.
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  // In-flight Discard Label button. Stops double-clicks during cancel.
  const [discardingLabel, setDiscardingLabel] = useState<string | null>(null);
  // Auto-print toggle. When ON, every successful label buy opens the PDF
  // in a new browser tab so the operator can Cmd+P → DYMO 5XL through the
  // macOS print dialog, and the Drive file is moved into the sibling
  // Printed/ subfolder optimistically (toggling Print is the operator's
  // commitment that they'll print every bought label). Persists across
  // reloads in localStorage.
  const [printMode, setPrintMode] = useState<boolean>(false);
  // Initial localStorage hydration runs in an effect — server-rendered
  // markup must stay deterministic so we can't read it during useState.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("shipping.printMode");
      if (saved === "on") setPrintMode(true);
    } catch {
      /* private-mode browser, no localStorage — toggle just won't persist */
    }
  }, []);
  // Persist toggle on every change.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "shipping.printMode",
        printMode ? "on" : "off",
      );
    } catch {
      /* see above */
    }
  }, [printMode]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Defaults to Today: that's the day being worked, and landing on "All"
  // meant scrolling past later-day rows before reaching any of them. Overdue
  // and Need-Attention rows from OTHER days are not hidden by this — they are
  // pinned above the filtered list (see `filteredOrders`), because a filter
  // silently swallowing something urgent is exactly the failure this page
  // can't afford.
  const [bucketFilter, setBucketFilter] = useState<ShipByBucket | null>(
    "today",
  );

  // Orders bought during THIS session, with the state they had immediately
  // before the purchase.
  //
  // Item 4: after printing, the row must stay exactly where it was — the
  // operator loses their place otherwise. Two things used to move it: the
  // state flips to `bought`, which sorts last, and for Walmart the row also
  // becomes "awaiting ship-confirm" and leaves the tab entirely. Ranking a
  // just-bought row by its PRE-buy state keeps every sort input unchanged, so
  // it simply stays put and picks up a "Printed" mark instead. Cleared by a
  // full reload, which is when the row is allowed to move on.
  const [justBought, setJustBought] = useState<Record<string, State>>({});
  // "Ships later" — narrow the list to orders whose label prints today but
  // whose package physically leaves on a later business day (Ship Date Trick).
  const [deferredOnly, setDeferredOnly] = useState(false);
  // Separate scope for Walmart label-bought-but-not-shipped orders.
  // When "awaiting", everything else is hidden; when "active", these
  // are hidden so they don't crowd the buy-flow list.
  const [viewScope, setViewScope] = useState<"active" | "awaiting">(
    "active",
  );
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  // Channel scope — dynamic. null shows every channel; setting it to a
  // channel kind ("amazon" / "walmart" / "ebay" / "tiktok" / "shopify" /
  // "direct" / etc) restricts the dashboard. The toggle chips at the top
  // are built from the actual channels present in today's orders, so a
  // new marketplace auto-appears once its first open order shows up.
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  // Walmart label source toggle. Default = "api" (Walmart's Buy-with-Walmart
  // API direct, the only path that produces Walmart-branded labels and
  // counts toward Walmart's seller metrics correctly). Operator can flip to
  // "veeqo" when Walmart's API is throttled/down — Veeqo's pool of carriers
  // (Amazon Shipping V2) still has rates for the same orders, and /api/
  // shipping/plan generates plan items for Walmart orders just like Amazon
  // ones. Per-session persistence keeps the choice across reloads.
  const [walmartBuySource, setWalmartBuySource] = useState<"api" | "veeqo">(
    "api",
  );
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("shipping.walmartBuySource");
      if (saved === "veeqo" || saved === "api") setWalmartBuySource(saved);
    } catch {
      /* private mode — toggle just won't persist */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "shipping.walmartBuySource",
        walmartBuySource,
      );
    } catch {
      /* see above */
    }
  }, [walmartBuySource]);
  // Frozen / Dry product-type filter. "all" shows everything; "Frozen" or
  // "Dry" keeps orders whose first item matches (mixed orders only match
  // when every item is the same type).
  const [typeFilter, setTypeFilter] = useState<"all" | "Frozen" | "Dry" | "Untyped">(
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
    "urgency" | "cost" | "edd" | "deadline" | "product"
  >("urgency");
  // Smart free-text search — matched against order#, customer, ship-to,
  // city, state, store, channel, SKU and product title.
  //
  // Search is a MODE, not another filter: the moment there is a query,
  // every other filter (channel / day bucket / Frozen-Dry / store / state
  // / awaiting-scope) is bypassed, because the operator searching for an
  // order has no idea which tab it happens to live in. Anything below 3
  // characters only narrows the loaded list; from 3 characters up we also
  // hit /api/shipping/search, which answers across EVERY order status —
  // shipped, delivered, cancelled, refunded — the ones the dashboard
  // never loads.
  const [searchQuery, setSearchQuery] = useState("");
  const [archive, setArchive] = useState<{
    query: string;
    loading: boolean;
    hits: ArchiveHit[];
    error: string | null;
    truncated: boolean;
    degraded: string[];
  }>({
    query: "",
    loading: false,
    hits: [],
    error: null,
    truncated: false,
    degraded: [],
  });
  // Debounced archive lookup. 250ms is short enough that it feels like
  // type-ahead and long enough that a 15-character tracking number costs
  // one request instead of fifteen. Every keystroke aborts the in-flight
  // request, so a slow answer for "111-71" can never overwrite the answer
  // for the full number the operator has already finished typing.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < ARCHIVE_MIN_CHARS) {
      setArchive({
        query: "",
        loading: false,
        hits: [],
        error: null,
        truncated: false,
        degraded: [],
      });
      return;
    }
    const ctrl = new AbortController();
    setArchive((a) => ({ ...a, loading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/shipping/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        const json = await res.json();
        if (ctrl.signal.aborted) return;
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        setArchive({
          query: q,
          loading: false,
          hits: Array.isArray(json.hits) ? json.hits : [],
          error: null,
          truncated: Boolean(json.truncated),
          degraded: Array.isArray(json.degraded) ? json.degraded : [],
        });
      } catch (e) {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        setArchive({
          query: q,
          loading: false,
          hits: [],
          error: errMsg(e),
          truncated: false,
          degraded: [],
        });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [searchQuery]);
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

  // Merge Orders — orders heading to the SAME address that can ship in one box
  // on one label. The merge happens here, not in Veeqo: merging there bypasses
  // the Placed gate, so a label could be bought for goods that were never
  // procured and the order would silently leave the Procurement queue.
  // See docs/wiki/merge-orders-veeqo-mechanics.md.
  const [merge, setMerge] = useState<MergeState | null>(null);
  // Merge mode narrows the list to just the candidates and turns the bulk
  // action into "Merge selected" — the operator's flow is: see the banner,
  // open it, tick the orders, merge.
  const [mergeMode, setMergeMode] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  // Groups whose label was bought in THIS session. A merged group follows the
  // same rule as an ordinary bought row: it holds its place so the operator
  // can print the label and see the tracking, and a deliberate Refresh is what
  // lets it settle out of the queue (owner, 2026-08-05). The server keeps
  // serving bought groups for a while — this set is what decides whether the
  // page still shows one.
  const [sessionBoughtGroups, setSessionBoughtGroups] = useState<Set<string>>(
    () => new Set(),
  );

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
  // Discard-label confirmation — discarding voids an already-bought label
  // (carrier refund, irreversible), so we gate it behind an explicit
  // confirm dialog instead of firing on the first click. Holds the order
  // awaiting confirmation; null when the dialog is closed.
  const [discardConfirm, setDiscardConfirm] = useState<DashboardOrder | null>(
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
    async (
      o: DashboardOrder,
      shipByDate: string,
      // Set right after the operator saved a new box/weight. Two jobs: it is
      // sent to Walmart as an explicit package override (so the quote cannot
      // possibly use the old packaging), and it seeds the row's PACKAGE cell
      // so the saved values are visible even if the quote itself fails.
      savedBox?: SavedPackage | null,
    ) => {
      if (!o.walmartPurchaseOrderId) return;
      // When the operator opted out of Walmart-direct, Walmart-channel
      // orders flow through the same /plan + /buy pipeline as Amazon —
      // their plan row already has carrier/service/price. Skipping the
      // /walmart/rates probe here avoids spurious labelLookupFailed
      // errors that would block the Buy button.
      if (walmartBuySource !== "api") return;
      setRequoting((p) => ({ ...p, [o.orderNumber]: true }));
      // A rate-less placeholder that carries ONLY the package we just saved.
      // status "stop" with no notes renders as a plain "Awaiting rate" row —
      // it can never look buyable (Buy is gated on a pending rate + buy info).
      const packageOnlyRate = (box: SavedPackage): PlanItem => ({
        id: `wm-${o.orderNumber}`,
        orderNumber: o.orderNumber,
        carrier: null,
        service: null,
        price: null,
        edd: null,
        status: "stop",
        notes: null,
        weight: box.weight,
        boxSize: `${box.length}x${box.width}x${box.height}`,
        productType: null,
        labelDate: null,
        physicalShipDate: null,
        shipDateTrickApplied: false,
        datesMatch: true,
        actualShipDay: null,
        allocationId: null,
      });
      if (savedBox) {
        setWalmartRates((p) => ({
          ...p,
          [o.orderNumber]: packageOnlyRate(savedBox),
        }));
      }
      // Clearing the buy info is never optional on a failure — it is what
      // keeps the Buy button disabled while we have no verified rate. The
      // rate entry, on the other hand, is kept when it holds the package the
      // operator just saved, so the row doesn't fall back to "Set weight/size".
      const dropBuyInfo = () =>
        setWalmartBuyInfo((p) => {
          const n = { ...p };
          delete n[o.orderNumber];
          return n;
        });
      const dropMaps = () => {
        setWalmartRates((p) => {
          if (savedBox) {
            // Keep showing the saved package instead of blanking the cell.
            return { ...p, [o.orderNumber]: packageOnlyRate(savedBox) };
          }
          const n = { ...p };
          delete n[o.orderNumber];
          return n;
        });
        dropBuyInfo();
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
            // Quote against exactly what was just saved. Belt-and-braces
            // against any read-back lag between the save and this call.
            ...(savedBox
              ? {
                  length: savedBox.length,
                  width: savedBox.width,
                  height: savedBox.height,
                  weight: savedBox.weight,
                  dimUnit: "IN",
                  weightUnit: "LB",
                }
              : {}),
          }),
        });
        // A gateway timeout / HTML error page makes this throw — handled by
        // the catch below, which now tells the operator instead of leaving
        // the row exactly as it was.
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
            labelLookupFailed: !!j.labelLookupFailed,
            labelLookupError: j.labelLookupError ?? null,
          },
        }));
        // Already bought / shipped → clear the rate so the row shows that
        // state (walmartStatus above drives the "bought / not shipped" UI).
        if (j.alreadyBought || j.orderStatus === "Shipped") {
          dropMaps();
          return;
        }
        // Walmart returned a PACKAGE but no buyable rate (0 rates / nothing
        // selected) even though dims are fine — typically an OVERDUE order
        // (ship-by already passed) where no service can still hit the
        // deliver-by from today's ship date. Show the package we DO know plus
        // a clear reason, instead of a vague "Awaiting rate" + a false "Set
        // weight/size" (the order HAS dimensions). Keep walmartBuyInfo cleared
        // so Buy stays disabled.
        if (j.box && !j.selected) {
          clearError();
          setWalmartBuyInfo((p) => {
            const n = { ...p };
            delete n[o.orderNumber];
            return n;
          });
          const overdue =
            o.shipBy && shipByDate && o.shipBy < shipByDate.slice(0, 10);
          const reason =
            `No Walmart rate delivers by ${o.deliverBy ? fmtDate(o.deliverBy) : "the deadline"} ` +
            `when shipping ${fmtDate(shipByDate)}. ` +
            (overdue
              ? `This order's ship-by (${fmtDate(o.shipBy)}) has passed — it can't be shipped on time.`
              : `No service is fast enough — try an earlier ship date.`);
          const wb = j.box;
          setWalmartRates((p) => ({
            ...p,
            [o.orderNumber]: {
              id: `wm-${o.orderNumber}`,
              orderNumber: o.orderNumber,
              carrier: null,
              service: null,
              price: null,
              edd: null,
              status: "stop",
              notes: reason,
              weight: typeof wb.weight === "number" ? wb.weight : null,
              boxSize: `${wb.length}x${wb.width}x${wb.height}`,
              productType: null,
              labelDate: null,
              physicalShipDate: null,
              shipDateTrickApplied: false,
              datesMatch: true,
              actualShipDay: null,
              allocationId: null,
            },
          }));
          return;
        }
        if (!j.selected || !j.box) {
          dropMaps();
          // Walmart answered, but with no package and no rate — in practice
          // that's the label-lookup having failed (429 / timeout), which the
          // route reports via labelLookupFailed. The row already renders that
          // state, but a re-quote fired right after a Save looked like the
          // Save was ignored, so say what happened.
          if (savedBox) {
            setWalmartRateErrors((p) => ({
              ...p,
              [o.orderNumber]:
                j.labelLookupError ||
                "Walmart didn't return a rate for this package — press Refresh to try again. The box and weight ARE saved.",
            }));
          }
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
            edd: s.deliveryDate ? utcToPacificYMD(s.deliveryDate) : null,
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
            edd: s.deliveryDate ? utcToPacificYMD(s.deliveryDate) : null,
            shipByDate: usedShipDate,
          },
        }));
      } catch (e) {
        // Network drop, gateway timeout, HTML error page — anything that
        // stopped us from getting a JSON answer. The rate the operator was
        // looking at stays put (a transient error shouldn't blank the row),
        // but silence here is what made a failed re-quote after Save look
        // like "I pressed Save and nothing happened". Say it out loud.
        console.warn("[walmart requote] failed for", o.orderNumber, e);
        dropBuyInfo();
        setWalmartRateErrors((p) => ({
          ...p,
          [o.orderNumber]: savedBox
            ? "The box and weight are saved, but Walmart didn't answer the rate request (timeout). Press Refresh to re-quote."
            : "Walmart didn't answer the rate request (timeout). Press Refresh to re-quote.",
        }));
      } finally {
        setRequoting((p) => ({ ...p, [o.orderNumber]: false }));
      }
    },
    [walmartBuySource],
  );

  /**
   * Lightweight label probe for Walmart need_attention rows. We don't have
   * SkuShippingData/PackingProfile for these so the full rate-quote path
   * would 422 with "no saved package" — but they STILL might have a label
   * sitting on Walmart's side (Vladimir bought it manually in Seller Center).
   * One Walmart API call per order, no DB lookups, no rate-shopping.
   */
  const probeWalmartLabel = useCallback(
    async (o: DashboardOrder) => {
      if (!o.walmartPurchaseOrderId) return;
      try {
        const res = await fetch("/api/shipping/walmart/check-label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchaseOrderId: o.walmartPurchaseOrderId }),
        });
        const j = await res.json();
        if (!j?.ok || !j.alreadyBought || !j.existingLabel) return;
        // Populate walmartStatus so isAwaitingShipConfirm sees the row and
        // it flows to the Awaiting tab (or, when orderStatus === "Shipped",
        // gets hidden entirely by the isWalmartShipped channelOrders prune).
        setWalmartStatus((p) => ({
          ...p,
          [o.orderNumber]: {
            alreadyBought: true,
            orderStatus: j.orderStatus ?? null,
            existingLabel: {
              trackingNumber: j.existingLabel.trackingNumber,
              carrierName: j.existingLabel.carrierName,
              trackingUrl: j.existingLabel.trackingUrl ?? undefined,
            },
          },
        }));
      } catch {
        /* probe is best-effort — silent on failure */
      }
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // A deliberate refresh is when just-bought rows are allowed to settle into
    // their real state (bought / awaiting ship-confirm) and move. Merged
    // groups settle the same way: once bought, Refresh takes them out of the
    // queue exactly like it takes out a bought order.
    setJustBought({});
    setSessionBoughtGroups(new Set());
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
        // need_attention Walmart rows (no SkuShippingData / no PackingProfile)
        // never reach the full rate-quote path — but a label may already be
        // sitting on Walmart's side if Vladimir bought it manually in Seller
        // Center. Probe each one cheaply (single getLabelsByPurchaseOrder per
        // PO) so manual labels show up in the Awaiting ship-confirm tab
        // instead of being stuck at "Add SKU data".
        const needAttnWalmart = dashJson.orders.filter(
          (o) =>
            o.state === "need_attention" &&
            o.isWalmart &&
            o.walmartPurchaseOrderId,
        );
        // A fresh dashboard load is a clean slate — clear stale per-order
        // ship-date overrides and re-quote everything at the page-level date
        // (read via the ref so this []-dep callback need not depend on it).
        setShipDateByOrder({});
        setWalmartRates({});
        setWalmartBuyInfo({});
        setWalmartStatus({});
        await Promise.all([
          ...readyWalmart.map((o) =>
            quoteWalmartOrder(o, shipDateGlobalRef.current),
          ),
          ...needAttnWalmart.map((o) => probeWalmartLabel(o)),
        ]);
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
  }, [quoteWalmartOrder, probeWalmartLabel]);

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
  const loadMerge = useCallback(async () => {
    try {
      const res = await fetch("/api/shipping/merge");
      if (!res.ok) return;
      const json = (await res.json()) as MergeState;
      setMerge(json);
    } catch {
      /* non-fatal — the rest of the page works without merge information */
    }
  }, []);
  useEffect(() => {
    loadMerge();
  }, [loadMerge]);

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
    // Advance Sat/Sun/holiday to the next business day — the picker
    // mustn't promise an impossible physical handoff. Vladimir's call
    // 2026-06-07.
    const safe = effectiveBusinessDay(date);
    setShipDateGlobal(safe);
    setShipDateByOrder({});
    for (const o of readyWalmartOrders) quoteWalmartOrder(o, safe);
  }

  // Re-quote a Veeqo (Amazon/eBay/…) order at a forced ship date and store the
  // recommended rate as an override, so the card shows the rate for the new day
  // AND Buy purchases it dispatching on that day. Veeqo derives each rate's EDD
  // (and weekend surcharges) from dispatch_date, so the rate genuinely changes
  // with the ship date — the plan route does the PUT-dispatch→re-quote→restore
  // and returns the recommendation; here we just persist it as the override.
  const requoteAmazonOrder = useCallback(
    async (o: DashboardOrder, shipDate?: string, savedBox?: SavedPackage | null) => {
      setRequoting((p) => ({ ...p, [o.orderNumber]: true }));
      // The row reads its weight / box / rate out of `plan` — the batch
      // response from the last full load. This per-card re-quote used to
      // update ONLY rateOverrides, so after saving a new box the PACKAGE cell
      // kept showing the old value (or "Set weight/size" when there was none),
      // and the fix only appeared after a full Refresh. That is the "I press
      // Save, it spins, nothing changes" the owner reported. Merge the freshly
      // quoted item back into `plan` so the row shows the new packaging.
      const mergeIntoPlan = (item: PlanItem) =>
        setPlan((prev) => {
          if (!prev) return prev;
          const has = prev.orders.some(
            (x) => x.orderNumber === item.orderNumber,
          );
          return {
            ...prev,
            orders: has
              ? prev.orders.map((x) =>
                  x.orderNumber === item.orderNumber ? item : x,
                )
              : [...prev.orders, item],
          };
        });
      // Fill in the package we just saved when the plan item came back without
      // one (e.g. the order stopped for another reason) — the operator's edit
      // did land, and the cell should say so.
      const withSavedBox = (item: PlanItem): PlanItem =>
        savedBox
          ? {
              ...item,
              weight: item.weight ?? savedBox.weight,
              boxSize:
                item.boxSize ??
                `${savedBox.length}x${savedBox.width}x${savedBox.height}`,
            }
          : item;
      // Same, but the saved values WIN. Used when we're patching the row we
      // already had on screen (which by definition still holds the pre-edit
      // package) rather than a freshly quoted item from the server.
      const forceSavedBox = (item: PlanItem): PlanItem =>
        savedBox
          ? {
              ...item,
              weight: savedBox.weight,
              boxSize: `${savedBox.length}x${savedBox.width}x${savedBox.height}`,
            }
          : item;
      try {
        // shipDate present → quote at exactly that forced day (skips the auto
        // Monday-shift; used by the date picker). Absent → let the engine
        // decide (incl. Monday-shift); used after a weight/box change so only
        // THIS order re-quotes instead of the whole list.
        const url = shipDate
          ? `/api/shipping/plan?orderIds=${encodeURIComponent(
              o.orderId,
            )}&shipDate=${shipDate}`
          : `/api/shipping/plan?orderIds=${encodeURIComponent(o.orderId)}`;
        const r = await fetch(url);
        const j = (await r.json()) as PlanResponse & { error?: string };
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        const item = (j.orders ?? []).find(
          (it) => it.orderNumber === o.orderNumber,
        );
        // Whatever came back — rate or stop — is newer than what the row is
        // showing, so put it on the row.
        if (item) mergeIntoPlan(withSavedBox(item));
        if (item && item.status !== "stop" && item.totalNetCharge) {
          // Valid rate → make it the override (the buy applies it over a fresh
          // re-fetch, so carrier/price/EDD + ship day all stay consistent).
          setRateOverrides((prev) => ({
            ...prev,
            [o.orderId]: {
              carrier: item.carrier ?? null,
              service: item.service ?? null,
              serviceType: item.serviceType ?? null,
              subCarrierId: item.subCarrierId ?? null,
              serviceCarrier: item.serviceCarrier ?? null,
              carrierId: item.carrierId ?? null,
              remoteShipmentId: item.remoteShipmentId ?? null,
              totalNetCharge: item.totalNetCharge ?? null,
              baseRate: item.baseRate ?? null,
              edd: item.edd ?? null,
              price: item.price ?? null,
              physicalShipDate: item.physicalShipDate ?? shipDate ?? null,
            },
          }));
          setBuyErrors((prev) => {
            if (!(o.orderId in prev)) return prev;
            const next = { ...prev };
            delete next[o.orderId];
            return next;
          });
        } else {
          // No on-time rate — drop any stale override and surface the reason so
          // the row doesn't keep showing the old rate.
          setRateOverrides((prev) => {
            if (!(o.orderId in prev)) return prev;
            const next = { ...prev };
            delete next[o.orderId];
            return next;
          });
          setBuyErrors((prev) => ({
            ...prev,
            [o.orderId]:
              item?.notes ||
              (shipDate
                ? `No rate delivers in time when shipping ${fmtDate(shipDate)}.`
                : "No on-time rate for this order."),
          }));
        }
        // The plan didn't return this order at all (it only returns orders in
        // the "ready" set). The save still happened, so show it rather than
        // leaving the cell on the old value / "Set weight/size".
        if (!item && savedBox) {
          setPlan((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              orders: prev.orders.map((x) =>
                x.orderNumber === o.orderNumber ? forceSavedBox(x) : x,
              ),
            };
          });
        }
      } catch (e) {
        console.warn("[requote] failed for", o.orderNumber, e);
        // Don't leave a package edit looking like it vanished when the
        // re-quote request itself failed.
        if (savedBox) {
          setPlan((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              orders: prev.orders.map((x) =>
                x.orderNumber === o.orderNumber ? forceSavedBox(x) : x,
              ),
            };
          });
          setBuyErrors((prev) => ({
            ...prev,
            [o.orderId]:
              "Box and weight are saved, but the re-quote failed (timeout). Press Refresh to get a fresh rate.",
          }));
        }
      } finally {
        setRequoting((p) => ({ ...p, [o.orderNumber]: false }));
      }
    },
    [],
  );

  // Change one order's ship date (overrides the global for that order only).
  // BOTH channels now re-quote against the new dispatch day: Walmart through
  // its own API, Veeqo/Amazon through the plan route (the old "Veeqo returns a
  // fixed quote regardless of dispatch date" assumption was wrong — EDDs and
  // weekend surcharges DO move, which is exactly why the Frozen Monday-shift
  // re-quotes). The recommended rate becomes the row's override.
  function changeOrderShipDate(o: DashboardOrder, date: string) {
    if (!date) return;
    const safe = effectiveBusinessDay(date);
    setShipDateByOrder((p) => ({ ...p, [o.orderNumber]: safe }));
    if (o.isWalmart) quoteWalmartOrder(o, safe);
    else void requoteAmazonOrder(o, safe);
  }

  // Orders narrowed to the selected channel. Every count and the list below
  // derive from this, so flipping the Amazon/Walmart toggle re-computes the
  // whole dashboard. "all" passes everything through unchanged.
  //
  // Walmart-direct shipped rows are pruned at the very top so they don't
  // leak into ANY downstream view. Walmart bypasses Veeqo on the buy +
  // ship flow, so the Veeqo order stays at `awaiting_fulfillment` forever
  // even after the package goes out — without this prune they keep showing
  // in "Ready to buy" totals + the active list.
  const channelOrders = useMemo(() => {
    const live = orders.filter((o) => {
      if (!o.isWalmart) return true;
      const ws = walmartStatus[o.orderNumber];
      return !(ws && ws.orderStatus === "Shipped");
    });
    if (!channelFilter) return live;
    // For the Walmart chip, match on Veeqo's channel kind (or the
    // isWalmart DB flag as a fallback). The DB flag alone misses
    // orders that haven't been synced into WalmartOrder yet — e.g.
    // a fresh order since the last orders-walmart cron run — even
    // though they obviously belong to the Walmart channel. Using
    // channelKind catches every SIRIUS-store order; the DB flag is
    // still what the buy / probe paths key off (they need the
    // purchaseOrderId, which only exists once the row is in DB).
    if (channelFilter === "walmart") {
      return live.filter(
        (o) => o.isWalmart || (o.channelKind ?? "").toLowerCase() === "walmart",
      );
    }
    return live.filter(
      (o) => !o.isWalmart && (o.channelKind ?? "") === channelFilter,
    );
  }, [orders, channelFilter, walmartStatus]);

  // Unique channel kinds present in today's orders → drives the dynamic
  // chip row at the top. Sorted with amazon/walmart first (most common
  // for this account) so they stay in the same spot when other channels
  // come and go.
  const availableChannels = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      if (o.isWalmart) set.add("walmart");
      else if (o.channelKind) set.add(o.channelKind);
    }
    const arr = [...set];
    const priority = (k: string) =>
      k === "amazon" ? 0 : k === "walmart" ? 1 : 2;
    arr.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    return arr;
  }, [orders]);

  // For each channel kind, collect the unique Veeqo channel.name(s) that
  // back it. When a kind has exactly one name we show THAT name on the
  // chip (e.g. "NAN health" instead of generic "Shopify") so the operator
  // sees the marketplace identity the way they think about it. Walmart
  // and Amazon stay on their brand-styled wordmarks via CHANNEL_BRANDS.
  const channelNamesByKind = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const o of orders) {
      const kind = o.isWalmart ? "walmart" : (o.channelKind ?? "");
      if (!kind) continue;
      const name = o.channel?.trim();
      if (!name) continue;
      let s = m.get(kind);
      if (!s) {
        s = new Set();
        m.set(kind, s);
      }
      s.add(name);
    }
    return m;
  }, [orders]);

  // Store ids that carry Walmart orders — used to split the "By store"
  // breakdown by channel. Each Veeqo store maps to exactly one marketplace,
  // but the Walmart store is named "SIRIUS TRADING INTERNATIONAL LLC", so we
  // key off the per-order isWalmart flag rather than the store name.
  const walmartStoreIds = useMemo(
    () => new Set(orders.filter((o) => o.isWalmart).map((o) => o.storeId)),
    [orders],
  );

  // Walmart-only: label bought but order not yet marked Shipped. These
  // are pulled into a dedicated "Awaiting ship-confirm" tab so they
  // don't visually mix with rows still awaiting label purchase. Source
  // of truth is the per-order rate-quote response (walmartStatus[...]).
  const isAwaitingShipConfirm = useCallback(
    (o: DashboardOrder) => {
      if (!o.isWalmart) return false;
      // A Walmart label bought in this session flips the order to "awaiting
      // ship-confirm", which would move the row out of the tab the operator is
      // working in the instant they printed it. Hold it in place until the next
      // reload — item 4 is precisely about not losing that context.
      if (o.orderId in justBought) return false;
      const ws = walmartStatus[o.orderNumber];
      if (!ws) return false;
      return ws.alreadyBought === true && ws.orderStatus !== "Shipped";
    },
    [walmartStatus, justBought],
  );

  const awaitingShipConfirmCount = useMemo(
    () => channelOrders.filter(isAwaitingShipConfirm).length,
    [channelOrders, isAwaitingShipConfirm],
  );

  // Scoped base — the orders that COULD appear in the list once bucket /
  // state / type filters are applied. We compute ALL the secondary counts
  // (time buckets, product type, state) from this base so every chip count
  // matches what actually shows up when clicked. Without this, Overdue 1
  // could be a row that's in the awaiting-ship-confirm bucket — clicking
  // Overdue would then return an empty list.
  const scopedOrders = useMemo(() => {
    if (viewScope === "awaiting")
      return channelOrders.filter(isAwaitingShipConfirm);
    return channelOrders.filter((o) => !isAwaitingShipConfirm(o));
  }, [channelOrders, viewScope, isAwaitingShipConfirm]);

  // "By store" breakdown — derived from `scopedOrders` (same pool the
  // KPI tiles + bucket "All" + type-filter "All types" use), so the
  // sum of per-store `all` counts always equals the KPI total. Earlier
  // versions read from `data.storeBreakdown` (server, no client-side
  // Shipped probe) and then from `channelOrders` (full set including
  // awaiting-ship-confirm) — both diverged from the rest of the page
  // by an awkward 2-37 row count.
  const storeBreakdown = useMemo(() => {
    const live = scopedOrders;
    type Row = {
      storeId: string;
      storeName: string;
      channel: string;
      all: number;
      readyToBuy: number;
      needAttention: number;
      waitingPlaced: number;
      boughtToday: number;
    };
    const m = new Map<string, Row>();
    for (const o of live) {
      let row = m.get(o.storeId);
      if (!row) {
        row = {
          storeId: o.storeId,
          storeName: o.storeName,
          channel: o.channel ?? "",
          all: 0,
          readyToBuy: 0,
          needAttention: 0,
          waitingPlaced: 0,
          boughtToday: 0,
        };
        m.set(o.storeId, row);
      }
      row.all++;
      if (o.state === "ready_to_buy") row.readyToBuy++;
      else if (o.state === "need_attention") row.needAttention++;
      else if (o.state === "waiting_placed") row.waitingPlaced++;
      else if (o.state === "bought") row.boughtToday++;
    }
    return [...m.values()].sort((a, b) =>
      a.storeName.localeCompare(b.storeName),
    );
  }, [scopedOrders]);

  // Time-bucket counts derive from scopedOrders (current viewScope).
  // viewScope is set explicitly via the AWAITING split tile ("No label"
  // vs "Label bought"), so the bucket row adapts: in the active scope
  // it shows overdue/today/tomorrow of rows still needing a label; in
  // the awaiting scope it shows the same for rows whose label is bought.
  // The grand-total context (matches Walmart SC's Unshipped) lives in
  // the AWAITING tile's top half.
  const bucketCounts = useMemo(() => {
    const c: Record<ShipByBucket, number> = {
      overdue: 0,
      today: 0,
      tomorrow: 0,
      dayafter: 0,
      later: 0,
    };
    for (const o of scopedOrders) if (o.timeBucket) c[o.timeBucket] += 1;
    return c;
  }, [scopedOrders]);

  // Frozen / Dry / Untyped tab counts in ONE pass over scopedOrders, memoized.
  // Previously the JSX ran three separate `scopedOrders.filter(...).length`
  // passes on every render (e.g. each search keystroke), each with an inner
  // `.every()`/`.some()` — wasted work for a value that only changes with
  // scopedOrders.
  const typeCounts = useMemo(() => {
    let frozen = 0,
      dry = 0,
      untyped = 0;
    for (const o of scopedOrders) {
      if (o.items.length === 0) continue;
      if (o.items.every((i) => i.knownType === "Frozen")) frozen += 1;
      else if (o.items.every((i) => i.knownType === "Dry")) dry += 1;
      if (
        o.items.some((i) => i.knownType !== "Frozen" && i.knownType !== "Dry")
      )
        untyped += 1;
    }
    return { frozen, dry, untyped };
  }, [scopedOrders]);

  // Index plan rows by orderNumber so the OrderRow can pick up carrier /
  // price / EDD without an extra lookup at render time. Plan keys on
  // orderNumber (Amazon-format), same as dashboard, so the merge is clean.
  const planByOrderNumber = useMemo(() => {
    // In the default "api" mode, a Walmart row must reflect the WALMART quote
    // ONLY — never the Veeqo plan rate. The plan route quotes Walmart orders
    // through Veeqo too (a different carrier pool, against an UNVERIFIED
    // package), and that phantom rate (a) showed a misleading "Rate ready —
    // confirm to buy" on rows whose Walmart quote actually failed for missing
    // dimensions, (b) MASKED the real "set the box/weight" error (it only
    // renders when the plan isn't pending), and (c) isn't even buyable
    // (Walmart buy needs dims; the Veeqo buy path is blocked for Walmart). So
    // skip the Veeqo plan for Walmart rows here. When the operator has flipped
    // the toggle to "veeqo", Walmart DOES buy through Veeqo, so keep it.
    const skipVeeqoForWalmart = walmartBuySource === "api";
    const walmartNums = skipVeeqoForWalmart
      ? new Set(orders.filter((o) => o.isWalmart).map((o) => o.orderNumber))
      : new Set<string>();
    const m = new Map<string, PlanItem>();
    if (plan)
      for (const p of plan.orders) {
        if (walmartNums.has(p.orderNumber)) continue;
        m.set(p.orderNumber, p);
      }
    // Walmart rate entries overlay/extend the plan so Walmart rows show
    // carrier / cost / EDD / package through the same rendering path.
    for (const [num, p] of Object.entries(walmartRates)) m.set(num, p);
    return m;
  }, [plan, walmartRates, orders, walmartBuySource]);

  // Orders whose label is printed today but whose package physically leaves on
  // a LATER day (Frozen Ship Date Trick — typically the next business day, e.g.
  // Monday for a Friday label). Same predicate the row's Label/Physical chip
  // uses, hoisted here so the "Ships later" filter and the chip can never
  // disagree: a manual ship-date override wins over the batch plan's flag.
  const deferredShipNums = useMemo(() => {
    const s = new Set<string>();
    for (const o of orders) {
      const p = planByOrderNumber.get(o.orderNumber);
      if (!p) continue;
      const labelDate = p.labelDate ?? p.actualShipDay;
      const overridePhysical = rateOverrides[o.orderId]?.physicalShipDate ?? null;
      const deferred = overridePhysical
        ? overridePhysical !== labelDate
        : p.shipDateTrickApplied === true;
      if (deferred) s.add(o.orderNumber);
    }
    return s;
  }, [orders, planByOrderNumber, rateOverrides]);

  const deferredCount = useMemo(
    () => scopedOrders.filter((o) => deferredShipNums.has(o.orderNumber)).length,
    [scopedOrders, deferredShipNums],
  );

  // Ids of every order that is a merge candidate right now. Drives both the
  // merge-mode filter and which checkboxes are offered.
  const mergeCandidateIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of merge?.candidates ?? []) {
      for (const o of c.orders) set.add(o.id);
    }
    return set;
  }, [merge]);

  // The groups the page actually shows. Open ones always; a bought one only
  // until the next Refresh — or for as long as one of its orders failed to
  // receive the tracking, because that is a real problem and hiding it would
  // leave a marketplace order reading as late with nobody watching.
  const visibleGroups = useMemo(
    () =>
      (merge?.groups ?? []).filter(
        (g) =>
          g.status !== "bought" ||
          sessionBoughtGroups.has(g.id) ||
          g.members.some((m) => m.shipmentSyncError),
      ),
    [merge, sessionBoughtGroups],
  );

  // Orders already inside a visible group — they render under the group card,
  // not as loose rows, so the operator can't act on half a shipment.
  const groupedOrderIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of visibleGroups) {
      for (const m of g.members) set.add(m.orderId);
    }
    return set;
  }, [visibleGroups]);

  // The state a row is RANKED by. A row bought in this session keeps the state
  // it had a moment before the purchase, so every sort input stays identical
  // and printing cannot move the row (item 4).
  const rankState = useCallback(
    (o: DashboardOrder): State => justBought[o.orderId] ?? o.state,
    [justBought],
  );

  // Rows that sit above everything else regardless of the day filter and
  // regardless of the sort the operator picked (items 7 + 8).
  //
  // Owner's rule, 2026-07-30: overdue outranks need-attention. A missed ship-by
  // is already costing account metrics, whereas a need-attention row can't be
  // bought until it's resolved no matter where it sits.
  //
  //   0 = overdue AND needs attention   1 = overdue
  //   2 = needs attention               3 = ordinary row
  //
  // Just-printed rows are ranked on their pre-buy state, so they hold their
  // exact position — including a pinned one — rather than sliding away the
  // moment the label comes out of the printer.
  const pinRank = useCallback(
    (o: DashboardOrder): number => {
      const overdue = o.timeBucket === "overdue";
      const attention = rankState(o) === "need_attention";
      if (overdue && attention) return 0;
      if (overdue) return 1;
      if (attention) return 2;
      return 3;
    },
    [rankState],
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
    // Tokenise the smart-search query — every whitespace-separated token
    // must hit at least one searchable field on the row. That makes
    // multi-term queries work the way an operator types them:
    //   "kinder 30303" → orders for customer Kinder in ZIP 30303.
    const tokens = searchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    // Search is a MODE. With a query on, every narrowing filter is
    // bypassed and the base pool widens from `channelOrders` (already
    // channel-filtered) to every loaded order — an operator looking for
    // one order does not know, and should not have to know, which tab it
    // is sitting in. Merge-mode and open merge groups are the two
    // exceptions below: those aren't filters, they're safety rails around
    // buying a label for half a shipment.
    const searching = tokens.length > 0;
    // Merge mode is a MODE, exactly like search — not one more filter on top
    // of the day/type/store tabs. It has to be: candidates are grouped by
    // delivery address, and two orders to one address routinely sit in
    // different day buckets, different stores, even different channels. With
    // the ordinary filters still applied, the operator opened merge mode from
    // a banner that said "3 orders can ship together" and got an empty list
    // and no way to tick anything (observed 2026-08-05: candidates due 08-07
    // while the Today tab was active). So merge mode widens the pool to every
    // loaded order and narrows it by ONE thing — being a candidate.
    const merging = mergeMode;
    const wideOpen = searching || merging;
    return (wideOpen ? orders : channelOrders)
      .filter((o) => {
        // viewScope (set by the AWAITING split tile) is the source of
        // truth for active vs awaiting-ship-confirm partitioning. Every
        // count downstream (buckets, types, stores) now respects it,
        // so the bucket-filter no longer needs its old escape hatch.
        const awaiting = isAwaitingShipConfirm(o);
        if (!wideOpen) {
          if (viewScope === "awaiting") {
            if (!awaiting) return false;
          } else if (awaiting) {
            return false;
          }
        }
        if (bucketFilter && !wideOpen) {
          // "Today" swallows "Overdue": an order whose ship-by already passed
          // is still due today (more so than today's own), and operators were
          // losing them by living on the Today tab. The Overdue tab remains
          // for isolating them.
          const inBucket =
            bucketFilter === "today"
              ? o.timeBucket === "today" || o.timeBucket === "overdue"
              : o.timeBucket === bucketFilter;
          // Urgent rows survive the day filter and are pinned above the list.
          // The page now opens on Today by default, and a day filter that can
          // hide an overdue or blocked order is how those get missed — the
          // filter narrows the ordinary work, never the exceptions.
          if (!inBucket && pinRank(o) === 3) return false;
        }
        // Orders inside an open group live under their group card. Showing
        // them loose as well would let someone buy half a shipment.
        if (groupedOrderIds.has(o.orderId)) return false;
        // Merge mode: only the candidates, so ticking is unambiguous.
        if (mergeMode && !mergeCandidateIds.has(o.orderId)) return false;
        if (
          deferredOnly &&
          !wideOpen &&
          !deferredShipNums.has(o.orderNumber)
        )
          return false;
        if (storeFilter && !wideOpen && o.storeId !== storeFilter)
          return false;
        if (stateFilter !== "all" && !wideOpen && o.state !== stateFilter)
          return false;
        if (typeFilter !== "all" && !wideOpen) {
          const types = o.items.map((i) => i.knownType);
          if (types.length === 0) return false;
          if (typeFilter === "Untyped") {
            // "Untyped" = at least one item without a Frozen/Dry tag.
            // These typically end up in need_attention=no_type (Amazon)
            // but the operator wants to be able to surface them
            // directly from the type filter when reconciling counts.
            if (types.every((t) => t === "Frozen" || t === "Dry")) return false;
          } else {
            if (!types.every((t) => t === typeFilter)) return false;
          }
        }
        if (tokens.length > 0) {
          // Build a single haystack string per order so every token can be
          // tested with one indexOf instead of an inner loop over fields.
          const haystack = [
            o.orderNumber,
            o.storeName,
            o.channel,
            o.channelKind,
            o.customerName,
            o.customerEmail,
            o.shipToAddress,
            o.city,
            o.shipToState,
            o.shipToZip,
            o.walmartPurchaseOrderId,
            // Tracking of a label already bought in this session — so the
            // operator can paste a tracking number and land on the live row
            // instead of only on the archive copy of it.
            planByOrderNumber.get(o.orderNumber)?.trackingNumber,
            ...o.items.map((i) => `${i.sku} ${i.productTitle}`),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          for (const t of tokens) {
            if (!haystack.includes(t)) return false;
          }
        }
        return true;
      })
      .slice()
      .sort((a, b) => {
        // Urgency block first (overdue+attention → overdue → attention), then
        // the ordinary actionability order inside each block.
        const dp = pinRank(a) - pinRank(b);
        if (dp !== 0) return dp;
        const ds = stateRank[rankState(a)] - stateRank[rankState(b)];
        if (ds !== 0) return ds;
        const ab = a.timeBucket ? bucketRank[a.timeBucket] : 99;
        const bb = b.timeBucket ? bucketRank[b.timeBucket] : 99;
        return ab - bb;
      });
  }, [
    orders,
    channelOrders,
    planByOrderNumber,
    bucketFilter,
    deferredOnly,
    deferredShipNums,
    storeFilter,
    stateFilter,
    typeFilter,
    viewScope,
    isAwaitingShipConfirm,
    searchQuery,
    pinRank,
    rankState,
    mergeMode,
    mergeCandidateIds,
    groupedOrderIds,
  ]);

  // How many of the leading rows are pinned by urgency — the render inserts a
  // separator after them so the operator can see where the exceptions end and
  // the day's ordinary work begins.
  const pinnedCount = useMemo(
    () => filteredOrders.filter((o) => pinRank(o) < 3).length,
    [filteredOrders, pinRank],
  );

  const selectableIds = useMemo(
    () =>
      new Set(
        filteredOrders
          .filter((o) => {
            // Merge mode repurposes the checkbox column: the target is every
            // merge candidate, not just what's buyable. A candidate whose goods
            // aren't purchased yet is still tickable — the API refuses the
            // merge and says which order is blocking, which is more useful than
            // a checkbox that silently won't tick.
            if (mergeMode) return mergeCandidateIds.has(o.orderId);
            // In the awaiting-ship-confirm tab, selectable = bought Walmart
            // rows waiting to be flipped to Shipped (the bulk Mark-shipped
            // target). Everywhere else, selectable = ready_to_buy (the
            // bulk-buy target). Mutually exclusive sets so the same checkbox
            // column does both jobs cleanly.
            if (viewScope === "awaiting") return isAwaitingShipConfirm(o);
            return o.state === "ready_to_buy";
          })
          .map((o) => o.orderId)
      ),
    [
      filteredOrders,
      viewScope,
      isAwaitingShipConfirm,
      mergeMode,
      mergeCandidateIds,
    ]
  );

  // KPI tiles — derived from `scopedOrders` so the math on the page is
  // self-consistent: KPI total = bucket-row All = type-row All-types,
  // and clicking READY TO BUY actually narrows the list to the same
  // number of rows the tile claims. The previous channelOrders-based
  // version made the tiles "stable" during the Walmart probe pass but
  // diverged from every other count on the page (e.g. Ready 49 while
  // bucket-All said 42).
  // Trade-off: the AWAITING FULFILLMENT tile may briefly tick down as
  // the client probes complete and reclassify Walmart rows that have
  // labels bought into the "Awaiting ship-confirm" bucket — that's
  // expected; the 37 rows didn't disappear, they're under the dedicated
  // tab. The sidebar shows the un-scoped total so the operator can
  // still see "all open work" at a glance.
  const totals = useMemo(() => {
    const all = scopedOrders.length;
    const ready = scopedOrders.filter(
      (o) => o.state === "ready_to_buy",
    ).length;
    const attention = scopedOrders.filter(
      (o) => o.state === "need_attention",
    ).length;
    const waiting = scopedOrders.filter(
      (o) => o.state === "waiting_placed",
    ).length;
    return { all, ready, attention, waiting };
  }, [scopedOrders]);

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
      // Item 8: the urgency block stays on top under EVERY sort. Sorting by
      // cost or EDD used to scatter overdue and need-attention rows through
      // the list, which is where they got missed. The chosen sort orders the
      // ordinary rows below them.
      const dp = pinRank(a) - pinRank(b);
      if (dp !== 0) return dp;
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
      if (sortBy === "product") {
        // Alphabetical by the first line item's product title — groups
        // identical products together so the operator can multi-select and
        // bulk-buy a run of the same item in one pass.
        const at = a.items[0]?.productTitle ?? "";
        const bt = b.items[0]?.productTitle ?? "";
        return at.localeCompare(bt);
      }
      // deadline
      return time(a.deliverBy) - time(b.deliverBy);
    });
    return rows;
  }, [filteredOrders, sortBy, planByOrderNumber, pinRank]);

  // ── Search mode ───────────────────────────────────────────────────────
  // `searchActive` = there is a query, so the filters are bypassed and the
  // banner explains it. `archiveEnabled` = the query is long enough that
  // /api/shipping/search has been asked for every-status matches too.
  const searchActive = searchQuery.trim().length > 0;
  const archiveEnabled = searchQuery.trim().length >= ARCHIVE_MIN_CHARS;

  // Archive hits that are NOT already on screen as a live row. An order in
  // today's queue is far more useful in its normal row (with rates, buy
  // button, packing state) than as a flat archive record, so the live row
  // wins and the duplicate is dropped.
  const archiveOnlyHits = useMemo(() => {
    if (!archiveEnabled) return [];
    const shown = new Set(
      displayedOrders.map((o) => o.orderNumber.trim().toUpperCase()),
    );
    return archive.hits.filter(
      (h) => !shown.has(h.orderNumber.trim().toUpperCase()),
    );
  }, [archive.hits, archiveEnabled, displayedOrders]);

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

  /**
   * Bulk Mark as Shipped — for the awaiting-ship-confirm tab. Loops the
   * selected Walmart purchase orders one-by-one through
   * /api/shipping/walmart/mark-shipped. We don't parallelise because the
   * Walmart shipping API rate-limits per-account aggressively and one bad
   * row shouldn't take the whole batch down.
   */
  async function markShippedSelected() {
    if (selected.size === 0) return;
    setBuying(true);
    const orderById = new Map<string, DashboardOrder>();
    for (const o of filteredOrders) orderById.set(o.orderId, o);
    let ok = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const o = orderById.get(id);
      if (!o || !o.isWalmart || !o.walmartPurchaseOrderId) continue;
      setBuyMsg(`Marking ${o.orderNumber} shipped (${ok + failed + 1}/${selected.size})…`);
      try {
        const r = await fetch("/api/shipping/walmart/mark-shipped", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchaseOrderId: o.walmartPurchaseOrderId }),
        });
        const j = await r.json();
        if (!r.ok || j?.ok === false) {
          failed++;
          const msg = j?.error || `HTTP ${r.status}`;
          errors.push(`${o.orderNumber}: ${msg}`);
          setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
        } else {
          ok++;
          // Optimistic flip to Shipped — same reasoning as the single-row
          // markShipped handler. Without it the row keeps reappearing
          // after refresh until the dashboard probe re-fetches the
          // order status from Walmart.
          setWalmartStatus((prev) => ({
            ...prev,
            [o.orderNumber]: {
              ...(prev[o.orderNumber] ?? { alreadyBought: true, existingLabel: null }),
              orderStatus: "Shipped",
            },
          }));
        }
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${o.orderNumber}: ${msg}`);
        setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
      }
    }
    setBuyMsg(
      failed === 0
        ? `Marked ${ok} order(s) shipped`
        : `Marked ${ok} shipped, ${failed} failed — see card errors`,
    );
    setBuying(false);
    setSelected(new Set());
    await load();
  }

  // Auto-print helper. Given a successful buy result (which carries
  // pdfBase64 + driveFileId), opens the PDF in a new browser tab so the
  // operator can Cmd+P through macOS to the DYMO 5XL, and asks the server
  // to move the Drive file into the sibling Printed/ subfolder.
  //
  // No-op when print mode is off or the buy didn't return pdfBase64
  // (older flows / non-Drive-saved labels).
  //
  // The Printed/ move is optimistic — toggling Print on is the operator's
  // signal that every bought label will be printed. If they cancel out of
  // the print dialog, the file can be moved back manually in Drive.
  // Optimistically move a printed label's Drive file into the sibling
  // Printed/ subfolder. Best-effort — never block on it.
  const markLabelPrintedOnDrive = useCallback(
    async (driveFileId: string | null | undefined): Promise<void> => {
      if (!driveFileId) return;
      try {
        await fetch("/api/shipping/mark-label-printed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driveFileId }),
        });
      } catch {
        /* non-fatal — the PDF tab is already open, the move is cosmetic */
      }
    },
    [],
  );

  const printAndMark = useCallback(
    async (success: BuyReportSuccess): Promise<void> => {
      if (!printMode) return;
      if (!success.pdfBase64) return;
      openPdfInTab(base64ToBytes(success.pdfBase64));
      await markLabelPrintedOnDrive(success.driveFileId);
    },
    [printMode, markLabelPrintedOnDrive],
  );

  // Print step for a bulk buy. With Print mode ON and two or more labels
  // bought, all label PDFs are concatenated into ONE multi-page PDF that
  // opens in a single tab — the operator prints one continuous strip on the
  // DYMO instead of clicking through a tab per order. A single label (or a
  // merge failure) falls back to opening labels individually. Either way,
  // each Drive file is moved to Printed/.
  const printBought = useCallback(
    async (successes: BuyReportSuccess[]): Promise<void> => {
      if (!printMode) return;
      const withPdf = successes.filter((s) => s.pdfBase64);
      if (withPdf.length === 0) return;
      if (withPdf.length === 1) {
        await printAndMark(withPdf[0]);
        return;
      }
      try {
        const merged = await mergePdfsFromBase64(
          withPdf.map((s) => s.pdfBase64 as string),
        );
        openPdfInTab(merged);
      } catch {
        // Merge failed — still give the operator every label, one tab each.
        for (const s of withPdf) await printAndMark(s);
        return;
      }
      for (const s of withPdf) await markLabelPrintedOnDrive(s.driveFileId);
    },
    [printMode, printAndMark, markLabelPrintedOnDrive],
  );

  // Optimistic local mutation after a successful Buy. Replaces the
  // `await load()` reload that used to instantly hide the just-bought
  // row — Vladimir wants to SEE what he bought (the tracking number,
  // the Mark-as-Shipped button) until he refreshes manually.
  //
  // Amazon orders: set state = "bought" so isBought renders the green
  // "Label already purchased" line and the Buy button hides.
  //
  // Walmart orders: populate walmartStatus so wmBought renders the
  // "Label bought — TRACKING · not yet marked shipped" line + the
  // Mark-as-Shipped button (same UI the awaiting-ship-confirm tab uses).
  const applyBoughtLocally = useCallback(
    (boughtList: BuyReportSuccess[]) => {
      if (boughtList.length === 0) return;
      const boughtByNumber = new Map(
        boughtList.map((b) => [b.orderNumber, b]),
      );

      // Remember what each row was BEFORE the purchase, so it keeps ranking
      // (and therefore its position) exactly as it did a moment ago.
      setData((prev) => {
        if (!prev) return prev;
        const preStates: Record<string, State> = {};
        for (const o of prev.orders) {
          if (boughtByNumber.has(o.orderNumber)) preStates[o.orderId] = o.state;
        }
        if (Object.keys(preStates).length > 0) {
          setJustBought((p) => ({ ...p, ...preStates }));
        }
        return prev;
      });

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          orders: prev.orders.map((o) =>
            boughtByNumber.has(o.orderNumber)
              ? { ...o, state: "bought" as const }
              : o,
          ),
        };
      });

      // Find which boughts are for Walmart orders (by matching against the
      // current data) and populate walmartStatus for them. Walmart-direct
      // buys don't flip Veeqo status, so without this the row would lose
      // its Buy button but get nothing back (no Mark-as-Shipped button).
      setData((prev) => {
        if (!prev) return prev;
        const walmartUpdates: typeof walmartStatus = {};
        for (const o of prev.orders) {
          const b = boughtByNumber.get(o.orderNumber);
          if (!b || !o.isWalmart) continue;
          walmartUpdates[o.orderNumber] = {
            alreadyBought: true,
            orderStatus: "Acknowledged",
            existingLabel: {
              trackingNumber: b.tracking,
              carrierName: b.carrier ?? "",
            },
          };
        }
        if (Object.keys(walmartUpdates).length > 0) {
          setWalmartStatus((wsPrev) => ({ ...wsPrev, ...walmartUpdates }));
        }
        return prev;
      });
    },
    [],
  );

  async function mergeSelected() {
    if (selected.size < 2) {
      setMergeMsg("Tick at least two orders to merge");
      return;
    }
    setMerging(true);
    setMergeMsg(null);
    try {
      const res = await fetch("/api/shipping/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: [...selected] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setSelected(new Set());
      // A merged group changes what the list should show, so refresh both the
      // groups and the orders behind them.
      await Promise.all([loadMerge(), load()]);
      setMergeMode(false);
      setMergeMsg(
        json.deadlineWarning ??
          (json.spansStores
            ? "Merged — note this group spans two seller accounts."
            : "Merged. Set the type, weight and box on the group, then buy."),
      );
    } catch (e) {
      setMergeMsg(errMsg(e));
    } finally {
      setMerging(false);
    }
  }

  async function updateMergeGroup(
    groupId: string,
    patch: Record<string, unknown>,
  ) {
    const res = await fetch("/api/shipping/merge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId, ...patch }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    await loadMerge();
  }

  async function dissolveMergeGroup(groupId: string) {
    const res = await fetch(
      `/api/shipping/merge?groupId=${encodeURIComponent(groupId)}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    await Promise.all([loadMerge(), load()]);
  }

  async function buySelected() {
    if (selected.size === 0) return;

    // Identical-selection guard. The operator multi-selects a run of the
    // SAME product to print one strip; warn if any shared-product group has
    // mismatched quantities (e.g. four orders of 1 unit and one of 2) so a
    // wrong-count label isn't bought by accident. Different products in the
    // selection are normal bulk-buy and never warn.
    const selectedOrders = filteredOrders.filter((o) =>
      selected.has(o.orderId),
    );
    const mismatches = detectQuantityMismatch(selectedOrders);
    if (mismatches.length > 0) {
      const proceed = window.confirm(
        "Heads up — some selected orders are the SAME product but have " +
          "DIFFERENT quantities:\n\n" +
          mismatches.join("\n\n") +
          "\n\nThat usually means one of these would get a label for the " +
          "wrong number of units. Buy them anyway?",
      );
      if (!proceed) return;
    }

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
      // Walmart orders go through Walmart's Buy-with-Walmart API ONLY
      // when the source toggle says so. With toggle=veeqo they fall into
      // the same /plan + /buy pipeline as Amazon — Veeqo's rate quote
      // already covers them.
      if (o.isWalmart && walmartBuySource === "api") walmartOrders.push(o);
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
          // Hard guard: if the latest rate-quote couldn't confirm the
          // order had no label (Walmart 429 / lookup error), skip this
          // row in a bulk buy. Server-side /walmart/buy will also
          // refuse, but skipping here gives the operator a clearer
          // per-row reason in the bulk report.
          const ws = walmartStatus[o.orderNumber];
          if (ws?.labelLookupFailed) {
            errors.push({
              orderNumber: o.orderNumber,
              itemId: o.orderId,
              error: `Can't verify if label already bought (${ws.labelLookupError ?? "Walmart lookup failed"}). Re-quote before buying.`,
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
            const success: BuyReportSuccess = {
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
              pdfBase64: j.pdfBase64 ?? null,
              driveFileId: j.driveFileId ?? null,
            };
            bought.push(success);
            // Printing is deferred to a single merge-and-open step after
            // both legs finish (see printBought below) so identical runs
            // come out as one strip.
          } catch (e) {
            errors.push({
              orderNumber: o.orderNumber,
              itemId: o.orderId,
              error: errMsg(e),
            });
          }
        }
      }

      // ── Amazon leg (existing plan + buy flow) ─────────────────────
      if (amazonIds.length > 0) {
        // Reuse the plan the page already loaded whenever it covers the whole
        // selection. Re-planning re-quotes EVERY selected order at Veeqo (a
        // multi-second round trip each, doubled for Frozen rows by the Monday
        // re-quote) — and then /buy re-quotes them a second time before
        // purchase. That unconditional re-plan is why buying five orders
        // together took minutes while buying the same five one at a time was
        // far quicker: the single-row Buy has always reused the loaded plan.
        //
        // Staleness is safe here: /buy re-quotes live against the current
        // allocation package before it purchases and refuses outright if the
        // chosen service no longer matches, so a stale plan item can only
        // produce a refused buy the operator retries — never a wrong label.
        const orderIdByNumber = new Map<string, string>();
        for (const id of amazonIds) {
          const o = orderById.get(id);
          if (o) orderIdByNumber.set(o.orderNumber, id);
        }
        // Same buyability rule the single-row Buy uses: normally "pending",
        // plus an algorithm-stopped row rescued by a manual rate override.
        const isBuyable = (p: { orderNumber: string; status: string }) => {
          const oid = orderIdByNumber.get(p.orderNumber);
          if (!oid) return false;
          return (
            p.status === "pending" ||
            (!!rateOverrides[oid] && p.status === "stop")
          );
        };

        let planId: string | null = plan?.planId ?? null;
        let planOrders = (plan?.orders ?? []).filter(isBuyable);
        // Only pay for a fresh plan when the loaded one doesn't cover
        // everything selected (e.g. a row that just left need_attention).
        if (!planId || planOrders.length < orderIdByNumber.size) {
          setBuyMsg(`Generating plan for ${amazonIds.length} Amazon order(s)…`);
          const ids = amazonIds.join(",");
          const planRes = await fetch(`/api/shipping/plan?orderIds=${ids}`);
          const planJson = await planRes.json();
          if (!planRes.ok)
            throw new Error(planJson?.error || "Failed to plan labels");
          planId = planJson.planId as string;
          planOrders = ((planJson.orders ?? []) as PlanItem[]).filter(
            isBuyable,
          );
        }

        const itemIds: string[] = planOrders.map((p) => p.id);
        if (planId && itemIds.length > 0) {
          setBuyMsg(`Buying ${itemIds.length} Amazon label(s)…`);
          // Map plan item → the row's manual rate override, if any.
          const overridesByItemId: Record<string, RateOverride> = {};
          for (const planOrder of planOrders) {
            const oid = orderIdByNumber.get(planOrder.orderNumber);
            const ov = oid ? rateOverrides[oid] : undefined;
            if (ov) overridesByItemId[planOrder.id] = ov;
          }
          const buyRes = await fetch("/api/shipping/buy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              planId,
              itemIds,
              overrides: overridesByItemId,
              // Walmart orders buy via Walmart by default. The Veeqo buy path
              // is only allowed for them when the operator explicitly flips
              // the Walmart source toggle to "veeqo" (Vladimir 2026-06-10).
              allowWalmartViaVeeqo: walmartBuySource === "veeqo",
            }),
          });
          const buyJson = await buyRes.json();
          if (!buyRes.ok)
            throw new Error(buyJson?.error || "Failed to buy labels");
          for (const b of (buyJson.bought ?? []) as BuyReportSuccess[]) {
            bought.push(b);
          }
          // Printing is deferred to the merge-and-open step after both legs
          // finish (see printBought below).
          for (const e of (buyJson.errors ?? []) as BuyReportError[]) {
            errors.push(e);
          }
        }
      }

      // ── Print ─────────────────────────────────────────────────────
      // One merge-and-open pass for everything bought across both legs.
      // ≥2 labels → a single combined PDF (one strip on the DYMO); a
      // single label opens on its own. No-op when Print mode is off.
      await printBought(bought);

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
      // Optimistic local update — bought rows stay visible with their
      // tracking + Mark-as-Shipped (Walmart) / "Label already purchased"
      // (Amazon) state. Operator hits Refresh when they want them gone.
      applyBoughtLocally(bought);
    } catch (e) {
      setBuyMsg(errMsg(e));
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
    // A loading toast we transform in place into the success/error result —
    // unmissable feedback, unlike the old tiny grey page-level buyMsg span
    // (which for a bought Amazon order rendered the error nowhere at all).
    const toastId = toast.loading(`Discarding label for ${o.orderNumber}…`);
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });
    try {
      // Pass the optimistic walmartStatus tracking as a fallback hint —
      // Walmart's getLabelsByPurchaseOrder occasionally takes minutes to
      // index a freshly-bought label, and the server's lookup-based
      // path then fails with "No Walmart label found" while the UI is
      // already showing the tracking. With the fallback the server can
      // discard directly by carrier+tracking.
      const ws = walmartStatus[o.orderNumber];
      const fallbackTracking = ws?.existingLabel?.trackingNumber ?? null;
      const fallbackCarrier = ws?.existingLabel?.carrierName ?? null;
      const r = await fetch("/api/shipping/discard-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: o.orderId,
          fallbackTracking,
          fallbackCarrier,
        }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || "Failed to discard label");
      }
      toast.success(
        `${o.orderNumber}: label discarded (refund 24-72h). Ready to re-quote.`,
        { id: toastId },
      );
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${o.orderNumber}: ${msg}`, { id: toastId });
      // Keep the inline error too (shows on wmBought / isReady rows).
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
      // Optimistically flip the row to Shipped in local state so it
      // disappears from the active/awaiting lists immediately (the
      // channelOrders filter prunes isWalmartShipped). Without this the
      // row keeps showing until the next dashboard refresh + label probe
      // re-fetches the order status from Walmart.
      setWalmartStatus((prev) => ({
        ...prev,
        [o.orderNumber]: {
          ...(prev[o.orderNumber] ?? { alreadyBought: true, existingLabel: null }),
          orderStatus: "Shipped",
        },
      }));
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

  /**
   * Add the Placed tag in Veeqo without going through the /procurement
   * workflow — for cases where the Procurement step doesn't apply
   * (Veeqo-merged orders inherit Placed from their source orders;
   * Shopify / NAN / other channels Vladimir doesn't source from
   * suppliers). After success the row advances from waiting_placed to
   * ready_to_buy on the next dashboard refresh, so we await load() to
   * surface it immediately.
   */
  async function markPlaced(o: DashboardOrder) {
    setMarkingPlaced(o.orderId);
    setBuyMsg(`Marking ${o.orderNumber} as Placed…`);
    setBuyErrors((prev) => {
      if (!(o.orderId in prev)) return prev;
      const next = { ...prev };
      delete next[o.orderId];
      return next;
    });
    try {
      const r = await fetch("/api/shipping/mark-placed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: o.orderId }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      setBuyMsg(`${o.orderNumber} marked Placed`);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setMarkingPlaced(null);
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
    //
    // The walmartBuySource toggle gates this path — when the operator
    // flipped to "veeqo", Walmart orders fall through to the regular
    // Amazon-style /api/shipping/buy flow that uses Veeqo's rates.
    if (o.isWalmart && walmartBuySource === "api") {
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
        const success: BuyReportSuccess = {
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
          pdfBase64: j.pdfBase64 ?? null,
          driveFileId: j.driveFileId ?? null,
        };
        setBuyReport({
          scope: "single",
          total: 1,
          bought: [success],
          errors: [],
        });
        setBuyMsg(`Bought ${o.orderNumber} (Walmart) — not yet marked shipped`);
        // The label IS bought. Reflect it in the row right away (tracking +
        // Mark-as-Shipped) via the optimistic update — no full reload needed.
        applyBoughtLocally([success]);
        // Printing is a post-purchase convenience. It (and any refresh) must
        // NEVER turn a completed buy into a "failed" message — a print/reload
        // hiccup here is exactly what showed "Buy failed — [object Object]" on
        // an order whose Walmart label was already bought. Swallow it.
        try {
          await printAndMark(success);
        } catch (printErr) {
          console.warn(
            "[buy] print after Walmart buy failed (non-fatal — label IS bought):",
            printErr,
          );
        }
      } catch (e) {
        const msg = errMsg(e);
        setBuyMsg(msg);
        setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
      } finally {
        setBuyingRow(null);
      }
      return;
    }

    try {
      // A manual rate override lets the operator buy even when the algorithm
      // stopped the order (e.g. no rate meets the deadline). In that case we
      // accept the order's plan item regardless of its "stop" status — the
      // buy API rescues a stopped-but-overridden item, and the override
      // carries every rate identifier the purchase needs.
      const ov = rateOverrides[o.orderId];
      const buyable = (p: { orderNumber: string; status: string }) =>
        p.orderNumber === o.orderNumber &&
        (p.status === "pending" || (!!ov && p.status === "stop"));
      let planId = plan?.planId ?? null;
      let planItemId = plan?.orders.find(buyable)?.id ?? null;
      if (!planId || !planItemId) {
        const r = await fetch(
          `/api/shipping/plan?orderIds=${encodeURIComponent(o.orderId)}`
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to plan");
        planId = j.planId;
        const item = (j.orders ?? []).find(buyable);
        if (!item)
          throw new Error(
            ov
              ? "Override is missing rate details — re-pick the rate and try again"
              : "No buyable rate found for this order",
          );
        planItemId = item.id;
      }
      const buyRes = await fetch("/api/shipping/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          itemIds: [planItemId],
          overrides: ov && planItemId ? { [planItemId]: ov } : undefined,
          // See note above — Walmart→Veeqo buy only on the explicit toggle.
          allowWalmartViaVeeqo: walmartBuySource === "veeqo",
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
      // Commit the success in the UI FIRST (clear the override, flip the row
      // to bought) so a print/refresh hiccup afterwards can't undo it.
      setRateOverrides((prev) => {
        const next = { ...prev };
        delete next[o.orderId];
        return next;
      });
      // Optimistic local update — row stays visible until manual refresh
      // so the operator can see what they just bought.
      applyBoughtLocally(bought);
      // Print + move Drive file if print mode is on — post-purchase, so a
      // failure here must NOT mark a completed buy as failed.
      try {
        for (const b of bought) {
          await printAndMark(b);
        }
      } catch (printErr) {
        console.warn(
          "[buy] print after buy failed (non-fatal — label IS bought):",
          printErr,
        );
      }
    } catch (e) {
      const msg = errMsg(e);
      setBuyMsg(msg);
      setBuyErrors((prev) => ({ ...prev, [o.orderId]: msg }));
    } finally {
      setBuyingRow(null);
    }
  }

  // One order row, wired to everything on this page. Extracted so a merged
  // group can render its members as the SAME rows the queue shows — the owner
  // wants a merged parcel to read like an ordinary order, not like a summary
  // of one. `groupRole` tells the row it belongs to a group: it then drops
  // the controls that act on a single order (buy, ship date, rollback,
  // discard, package/rate cells), because the group owns all of those.
  const renderOrderRow = (
    o: DashboardOrder,
    groupRole: "primary" | "sibling" | null = null,
  ) => (
    <OrderRow
      order={o}
      groupRole={groupRole}
      overdue={o.timeBucket === "overdue"}
      printedInSession={o.orderId in justBought}
      plan={planByOrderNumber.get(o.orderNumber) ?? null}
      planLoading={planLoading}
      selected={selected.has(o.orderId)}
      selectable={selectableIds.has(o.orderId)}
      buying={buyingRow === o.orderId}
      buyError={buyErrors[o.orderId] ?? null}
      walmartStatus={walmartStatus[o.orderNumber] ?? null}
      walmartRateError={walmartRateErrors[o.orderNumber] ?? null}
      markingShipped={markingShipped === o.orderId}
      onMarkShipped={() => markShipped(o)}
      markingPlaced={markingPlaced === o.orderId}
      onMarkPlaced={() => markPlaced(o)}
      rollingBack={rollingBack === o.orderId}
      onRollback={() => rollbackProcurement(o)}
      discardingLabel={discardingLabel === o.orderId}
      onDiscardLabel={() => setDiscardConfirm(o)}
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
  );

  return (
    // `shipping-scale` carries the module's type scale (see globals.css). Every
    // operator-facing size below reads from those variables rather than a
    // hardcoded px value, so the density of the whole page is one edit.
    <div className="shipping-scale space-y-3">
      {/* Command bar — title, smart search and Refresh, PINNED to the top
          of the scroll area. Vladimir works this page by scrolling a long
          list; the two controls he reaches for mid-scroll (search, and
          re-pull from Veeqo) used to scroll away with the header, so both
          now ride along. The negative margins let the bar span the full
          content width and paint over the rows sliding underneath it. */}
      <div className="sticky top-0 z-30 -mx-4 border-b border-rule bg-bg/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 shrink-0 items-baseline gap-2">
            <h1
              className="font-semibold text-ink"
              style={{ fontSize: 19, letterSpacing: "-0.02em", lineHeight: 1.1 }}
            >
              Shipping labels
            </h1>
            <span className="hidden whitespace-nowrap text-[11px] text-ink-3 xl:inline">
              {data?.refreshedAt
                ? new Date(data.refreshedAt).toLocaleTimeString()
                : "Loading…"}
            </span>
          </div>

          {/* Smart search. Everything on the row is searchable: order
              number, customer, street, city, ZIP, store, SKU, product,
              tracking. From 3 characters it ALSO queries the archive
              (every status — shipped, delivered, cancelled). */}
          <div className="relative min-w-[200px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search: order number, tracking, name, address, ZIP, SKU, product…"
              className="w-full rounded-md border border-rule bg-surface px-9 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-[#0071dc] focus:outline-none"
            />
            {archive.loading && (
              <Loader2
                size={13}
                className="absolute right-8 top-1/2 -translate-y-1/2 animate-spin text-ink-3"
              />
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-ink"
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <Btn
            icon={<RefreshCw size={13} />}
            // Refresh re-reads the merged groups too. Without it a group
            // merged (or bought) elsewhere only appeared after a full page
            // reload, and the bought one the operator just settled out of the
            // queue would come back on the next mount instead.
            onClick={() => {
              void load();
              void loadMerge();
            }}
            loading={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Btn>
        </div>

        {/* One line telling the operator exactly what the search is doing
            — that it deliberately ignores every filter above, and that it
            reaches past today's queue into every status. Without it, a hit
            list that contradicts the active Frozen/Today/Walmart filters
            reads like a bug. */}
        {searchActive && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1 rounded bg-green-soft px-1.5 py-0.5 font-medium text-green-ink">
              <Search size={11} /> Searching every order
            </span>
            <span>
              filters (channel, day, type, store) are not applied
              {archiveEnabled
                ? " · including shipped, delivered and cancelled"
                : ` · from ${ARCHIVE_MIN_CHARS} characters we search the archive too`}
            </span>
            <span className="tabular">
              found: {displayedOrders.length} in the queue
              {archiveEnabled ? ` · ${archiveOnlyHits.length} in the archive` : ""}
            </span>
            {archive.error && (
              <span className="text-danger">archive: {archive.error}</span>
            )}
            {archive.degraded.length > 0 && (
              <span className="text-warn-strong">
                source unavailable: {archive.degraded.join(", ")}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger-tint px-4 py-3 text-[12px] text-danger">
          {error}
        </div>
      )}

      {/* Merge Orders. The banner is the entry point the owner asked for:
          a line at the top saying orders could ship together, which opens a
          filtered view where they're ticked and merged. */}
      {merge && merge.groupCount > 0 && (
        <MergeBanner
          merge={merge}
          active={mergeMode}
          onToggle={() => {
            setMergeMode((v) => !v);
            setSelected(new Set());
            setMergeMsg(null);
          }}
        />
      )}

      {mergeMsg && (
        <div className="rounded border border-rule bg-surface-tint px-3 py-2 text-[length:var(--ship-meta)] text-ink-2">
          {mergeMsg}
        </div>
      )}

      {/* Channel scope — one chip per channel kind present in today's
          orders. Brand-coloured for known marketplaces (amazon/walmart get
          full wordmark styling; ebay/tiktok/shopify get their brand colour
          on a generic chip); other channels render as neutral pills.
          Flips every count below (KPI cards, store breakdown, bucket/type
          tabs, list) to the chosen marketplace. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
          Channel
        </span>
        {availableChannels.map((kind) => {
          // When this kind has exactly one Veeqo channel.name behind it
          // (e.g. "shopify" → just "NAN health"), use that real name on
          // the chip — sidesteps the generic "Shopify" label for the
          // common single-account case.
          //
          // EXCEPT for amazon/walmart: their chips are brand-styled
          // wordmarks and the operator thinks of them as marketplaces,
          // not as the legal entity Veeqo stores them under (Walmart
          // shows up as "SIRIUS TRADING INTERNATIONAL LLC" in Veeqo,
          // but "Walmart" is what we want on the chip).
          const names = channelNamesByKind.get(kind);
          const overrideLabel =
            kind !== "amazon" && kind !== "walmart" && names && names.size === 1
              ? [...names][0]
              : undefined;
          return (
            <ChannelToggle
              key={kind}
              channel={kind}
              overrideLabel={overrideLabel}
              active={channelFilter === kind}
              onClick={() => {
                setChannelFilter((c) => (c === kind ? null : kind));
                setStoreFilter(null);
              }}
            />
          );
        })}
        {channelFilter !== null && (
          <button
            type="button"
            onClick={() => setChannelFilter(null)}
            className="ml-0.5 text-[11px] text-ink-3 underline-offset-2 hover:text-ink-1 hover:underline"
          >
            show all
          </button>
        )}

        {/* Walmart label source toggle. Default = API (Walmart's own Buy-
            with-Walmart). Operator can flip to Veeqo as a fallback when
            Walmart's API is throttled. Only meaningful when there are
            Walmart orders in the list — but always rendered so the
            current setting is visible. */}
        <button
          type="button"
          onClick={() =>
            setWalmartBuySource((s) => (s === "api" ? "veeqo" : "api"))
          }
          title={
            walmartBuySource === "api"
              ? "Walmart labels buy through Walmart's own API (Buy-with-Walmart). Click to switch to Veeqo as a fallback."
              : "Walmart labels currently buy through VEEQO (Amazon Shipping rates). Click to switch back to Walmart API."
          }
          className={cn(
            "ml-2 rounded-md border px-2 py-0.5 text-[11px] font-medium transition",
            walmartBuySource === "api"
              ? "border-green-soft bg-green-soft text-green-ink hover:bg-green-tint"
              : "border-warn-strong bg-warn-tint text-warn-strong hover:bg-warn-strong/20",
          )}
        >
          Walmart: {walmartBuySource === "api" ? "API" : "Veeqo"}
        </button>

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
          {/* Quick presets — each advances past Sat/Sun/holiday so the
              picker can never land on a day the warehouse isn't open.
              "Today" on a Sunday lands on Monday; "+1" on a Friday
              lands on Monday too (skips Sat+Sun). */}
          <div className="flex items-center gap-1">
            {[
              { label: "Today", date: nextWarehouseShipDay() },
              {
                label: "+1",
                date: effectiveBusinessDay(addDaysISO(todayInET(), 1)),
              },
              {
                label: "+2",
                date: effectiveBusinessDay(addDaysISO(todayInET(), 2)),
              },
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

      {/* Totals — one dense strip instead of four tall tiles. Same four
          numbers, same click-to-filter behaviour, ~110px of vertical space
          returned to the order list. The AWAITING segment still carries its
          split (No label / Label bought) as two inline sub-buttons, shown
          only when there is something in the label-bought bucket. */}
      <div className="flex flex-wrap items-stretch gap-1 rounded-lg border border-rule bg-surface p-1">
        <StatSeg
          label="Awaiting"
          value={channelOrders.length}
          icon={<Package size={13} />}
          active={
            stateFilter === "all" &&
            viewScope === "active" &&
            awaitingShipConfirmCount === 0
          }
          onClick={() => setStateFilter("all")}
          title="Everything not yet shipped"
        />
        {awaitingShipConfirmCount > 0 && (
          <div className="flex items-center gap-1 border-l border-rule pl-1">
            <StatSeg
              small
              label="No label"
              value={channelOrders.length - awaitingShipConfirmCount}
              active={viewScope === "active"}
              onClick={() => {
                setViewScope("active");
                setBucketFilter(null);
                setStateFilter("all");
              }}
              title="Orders without a label yet — needs purchase"
            />
            <StatSeg
              small
              label="Label bought"
              value={awaitingShipConfirmCount}
              active={viewScope === "awaiting"}
              onClick={() => {
                setViewScope("awaiting");
                setBucketFilter(null);
                setStateFilter("all");
              }}
              title="Label purchased — Walmart not yet marked Shipped"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1 border-l border-rule pl-1">
          <StatSeg
            label="Ready to buy"
            value={totals.ready}
            icon={<CheckCircle size={13} />}
            active={stateFilter === "ready_to_buy"}
            onClick={() =>
              setStateFilter(
                stateFilter === "ready_to_buy" ? "all" : "ready_to_buy",
              )
            }
          />
          <StatSeg
            label="Need attention"
            value={totals.attention}
            icon={<AlertTriangle size={13} />}
            tone={totals.attention > 0 ? "warn" : undefined}
            active={stateFilter === "need_attention"}
            onClick={() =>
              setStateFilter(
                stateFilter === "need_attention" ? "all" : "need_attention",
              )
            }
          />
          <StatSeg
            label="Procurement"
            value={totals.waiting}
            icon={<Loader2 size={13} />}
            active={stateFilter === "waiting_placed"}
            onClick={() =>
              setStateFilter(
                stateFilter === "waiting_placed" ? "all" : "waiting_placed",
              )
            }
            title="Waiting for procurement"
          />
        </div>
      </div>

      {/* Store breakdown — uses the client-side `storeBreakdown` derived
          above (NOT `data.storeBreakdown`), so the per-store totals stay
          in sync with the KPI tiles after Walmart probe results land. */}
      {data && storeBreakdown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
            Store
          </span>
          {storeBreakdown
            .filter((s) => {
              // Walmart-only / non-Walmart split is the one we can do
              // store-side; other channel filters fall through to "show
              // all stores" because the dashboard rolls store totals
              // across all marketplaces.
              if (!channelFilter) return true;
              if (channelFilter === "walmart")
                return walmartStoreIds.has(s.storeId);
              // For any other channel (amazon, ebay, tiktok…) hide the
              // Walmart store but keep the rest.
              return !walmartStoreIds.has(s.storeId);
            })
            .map((s) => (
              <button
                key={s.storeId}
                type="button"
                onClick={() =>
                  setStoreFilter(storeFilter === s.storeId ? null : s.storeId)
                }
                title={`${s.storeName} — ${s.all} total · ${s.readyToBuy} ready to buy · ${s.needAttention} need attention`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors",
                  storeFilter === s.storeId
                    ? "border-green bg-green-soft text-green-ink"
                    : "border-rule bg-surface hover:border-silver-line",
                )}
              >
                <StoreAvatar
                  store={storeKeyFor({
                    marketplace: s.channel,
                    storeName: s.storeName,
                  })}
                  size="sm"
                />
                <span className="max-w-[150px] truncate font-medium">
                  {s.storeName}
                </span>
                <span className="tabular font-semibold">{s.all}</span>
                <span className="tabular text-ink-3">/{s.readyToBuy}</span>
                {s.needAttention > 0 && (
                  <span className="tabular font-semibold text-warn-strong">
                    ⚠{s.needAttention}
                  </span>
                )}
              </button>
            ))}
          {storeFilter && (
            <button
              type="button"
              onClick={() => setStoreFilter(null)}
              className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink-1 hover:underline"
            >
              show all
            </button>
          )}
        </div>
      )}

      {/* Bucket filter — viewScope selection moved into the AWAITING tile
          above (No label / Label bought segments), so this row is purely
          time-bucket. Counts roll up the FULL channelOrders set so they
          mirror Walmart Seller Center's overdue / today tally regardless
          of label-bought state. */}
      {data && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-rule bg-surface px-2 py-1.5">
          {/* Day buckets. "Today" also serves the overdue rows (see
              filteredOrders), so its count includes them — the badge always
              equals the number of rows the tab actually shows. */}
          <Seg
            label="All"
            count={scopedOrders.length}
            active={bucketFilter === null}
            onClick={() => setBucketFilter(null)}
          />
          {BUCKET_TABS.map((b) => (
            <Seg
              key={b.id}
              label={b.label}
              count={
                b.id === "today"
                  ? bucketCounts.today + bucketCounts.overdue
                  : (bucketCounts[b.id] ?? 0)
              }
              // Overdue only turns red when there is something to act on.
              tone={
                b.id === "overdue" && bucketCounts.overdue > 0
                  ? "danger"
                  : undefined
              }
              active={bucketFilter === b.id}
              onClick={() =>
                setBucketFilter(bucketFilter === b.id ? null : b.id)
              }
            />
          ))}

          <div className="mx-1 h-5 w-px bg-rule" />

          {/* Product type — Frozen / Dry / Untyped. Operates on the items
              array (every item must match). Counts come from the already-
              loaded orders, no extra API call. Untyped exists so Frozen +
              Dry + Untyped sums to All — Vladimir flagged math that didn't
              add up (22 = 21 + 0 was missing 1 untyped row). */}
          <Seg
            label="All types"
            count={scopedOrders.length}
            active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          />
          <Seg
            label="Frozen"
            count={typeCounts.frozen}
            active={typeFilter === "Frozen"}
            onClick={() =>
              setTypeFilter(typeFilter === "Frozen" ? "all" : "Frozen")
            }
          />
          <Seg
            label="Dry"
            count={typeCounts.dry}
            active={typeFilter === "Dry"}
            onClick={() => setTypeFilter(typeFilter === "Dry" ? "all" : "Dry")}
          />
          <Seg
            label="Untyped"
            count={typeCounts.untyped}
            active={typeFilter === "Untyped"}
            onClick={() =>
              setTypeFilter(typeFilter === "Untyped" ? "all" : "Untyped")
            }
          />

          {/* Isolates the Ship-Date-Trick rows: label bought today, package
              handed to the carrier on a later business day. These are the
              ones the warehouse must HOLD, so the operator needs to see them
              as their own worklist. */}
          <label
            className={cn(
              "ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
              deferredOnly
                ? "bg-warn-tint text-warn-strong"
                : "text-ink-2 hover:bg-bg-elev hover:text-ink",
            )}
            title="Show only orders whose label prints today but which physically ship on a later business day (Frozen Ship Date Trick)"
          >
            <input
              type="checkbox"
              checked={deferredOnly}
              onChange={(e) => setDeferredOnly(e.target.checked)}
            />
            📦 Ships later
            <span
              className={cn(
                "inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular",
                deferredOnly
                  ? "bg-warn-strong text-white"
                  : "bg-bg-elev text-ink-3",
              )}
            >
              {deferredCount}
            </span>
          </label>
        </div>
      )}

      {/* Action bar — checkbox + bulk button. In the active tab the bulk
          button is "Buy selected"; in the awaiting-ship-confirm tab it
          flips to "Mark shipped" so the same checkbox column drives both
          flows without a separate UI. */}
      <div className="flex items-center justify-between rounded-md border border-rule bg-surface px-3 py-2">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={
              selectableIds.size > 0 && selected.size === selectableIds.size
            }
            onChange={toggleAll}
          />
          {mergeMode
            ? `Select the orders to merge (${selected.size}/${selectableIds.size})`
            : viewScope === "awaiting"
              ? `Select all awaiting (${selected.size}/${selectableIds.size})`
              : `Select all ready (${selected.size}/${selectableIds.size})`}
        </label>
        <div className="flex items-center gap-2">
          {/* Sort — like Veeqo's sortable columns. */}
          <label className="flex items-center gap-1 text-[11px] text-ink-3">
            Sort
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as
                    | "urgency"
                    | "cost"
                    | "edd"
                    | "deadline"
                    | "product",
                )
              }
              className="rounded border border-rule bg-surface px-1.5 py-1 text-[11.5px] text-ink focus:border-[#0071dc] focus:outline-none"
            >
              <option value="urgency">Urgency</option>
              <option value="cost">Label cost</option>
              <option value="edd">Delivery (EDD)</option>
              <option value="deadline">Deadline</option>
              <option value="product">Product name</option>
            </select>
          </label>
          {buyMsg && (
            <span className="text-[11px] text-ink-3">{buyMsg}</span>
          )}
          {/* Print mode toggle. When ON, every successful Buy opens the
              PDF in a new browser tab (so the operator can Cmd+P → DYMO
              5XL through the macOS print dialog) and moves the Drive
              file to the sibling Printed/ subfolder. Hidden in the
              awaiting-ship-confirm view where buy isn't the active
              action. */}
          {viewScope !== "awaiting" && (
            <label
              className="flex items-center gap-1.5 text-[11.5px] text-ink-2"
              title={
                printMode
                  ? "Print: ON · bought labels auto-open in a new tab — Cmd+P to DYMO 5XL · Drive file moves to Printed/"
                  : "Print mode is OFF — bought labels are saved to Drive only"
              }
            >
              <input
                type="checkbox"
                checked={printMode}
                onChange={(e) => setPrintMode(e.target.checked)}
              />
              <span>Print</span>
              {printMode && (
                <span className="rounded bg-green-soft px-1 py-0.5 text-[10px] font-medium text-green-ink">
                  auto-open
                </span>
              )}
            </label>
          )}
          {viewScope === "awaiting" ? (
            <Btn
              variant="primary"
              icon={<CheckCircle size={13} />}
              onClick={markShippedSelected}
              loading={buying}
              disabled={selected.size === 0}
            >
              {buying
                ? "Marking shipped…"
                : `Mark shipped (${selected.size})`}
            </Btn>
          ) : mergeMode ? (
            <Btn
              variant="primary"
              icon={<Package size={13} />}
              onClick={mergeSelected}
              loading={merging}
              disabled={selected.size < 2}
            >
              {merging ? "Merging…" : `Merge (${selected.size})`}
            </Btn>
          ) : (
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
          )}
        </div>
      </div>

      {/* Order list. The search box itself now lives in the pinned command
          bar at the top of the page. */}
      <div className="space-y-2">
        {/* Merged groups live IN the queue, at the top of it — a merged group
            is just another parcel waiting for a label, so it belongs with the
            rows it competes with for the operator's attention, not in a
            separate zone above the filters. Its member orders are hidden as
            loose rows (groupedOrderIds), so nobody can buy half a shipment. */}
        {visibleGroups.map((g) => (
            <MergeGroupCard
              key={g.id}
              group={g}
              orders={orders}
              onUpdate={(patch: Record<string, unknown>) =>
                updateMergeGroup(g.id, patch)
              }
              onRefresh={loadMerge}
              onBought={() =>
                setSessionBoughtGroups((prev) => new Set(prev).add(g.id))
              }
              onDissolve={() => dissolveMergeGroup(g.id)}
              renderMember={(orderId, role) => {
                const o = orders.find((x) => x.orderId === orderId);
                return o ? renderOrderRow(o, role) : null;
              }}
            />
          ))}

        {loading && !data ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-10 text-center text-[12px] text-ink-3">
            Fetching orders from Veeqo…
          </div>
        ) : displayedOrders.length === 0 ? (
          visibleGroups.length > 0 ? null : (
          <div className="rounded-md border border-rule bg-surface px-4 py-8 text-center text-[12px] text-ink-3">
            {searchActive
              ? archive.loading
                ? `Searching every order for "${searchQuery}"…`
                : archiveOnlyHits.length > 0
                  ? `Nothing in the shipping queue — see the archive hits below.`
                  : `Nothing found for "${searchQuery}".`
              : "No orders match the current filter."}
          </div>
          )
        ) : (
          displayedOrders.map((o, idx) => (
            <Fragment key={o.orderId}>
              {/* Boundary between the pinned urgency block and the day's
                  ordinary work. Only drawn when there is something on both
                  sides of it. */}
              {idx === pinnedCount &&
                pinnedCount > 0 &&
                idx < displayedOrders.length && (
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-px flex-1 bg-rule" />
                    <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
                      {bucketFilter === "today"
                        ? "Today"
                        : bucketFilter
                          ? BUCKET_TABS.find((t) => t.id === bucketFilter)
                              ?.label
                          : "All orders"}
                    </span>
                    <div className="h-px flex-1 bg-rule" />
                  </div>
                )}
              {renderOrderRow(o)}
            </Fragment>
          ))
        )}
      </div>

      {/* Archive results — orders that are NOT in today's fulfillment queue:
          already shipped, delivered, cancelled, refunded. This is the half
          of the search the operator asked for by name: find an order by its
          label / number / address and see what the product was.
          Read-only on purpose — these orders are done, there is nothing to
          buy here. */}
      {archiveEnabled && (archive.loading || archiveOnlyHits.length > 0) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 pt-2">
            <div className="h-px flex-1 bg-rule" />
            <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
              Archive · every status
              {archiveOnlyHits.length > 0 && ` · ${archiveOnlyHits.length}`}
            </span>
            <div className="h-px flex-1 bg-rule" />
          </div>
          {archive.loading && archiveOnlyHits.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-md border border-rule bg-surface px-4 py-6 text-[12px] text-ink-3">
              <Loader2 size={13} className="animate-spin" />
              Searching Veeqo and our own database…
            </div>
          ) : (
            archiveOnlyHits.map((h) => <ArchiveRow key={h.key} hit={h} />)
          )}
          {archive.truncated && (
            <div className="px-1 text-[11.5px] text-ink-3">
              Showing the first {archiveOnlyHits.length} matches — narrow the
              query if the one you want isn&apos;t here.
            </div>
          )}
        </div>
      )}

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
          orders={orders}
          plans={planByOrderNumber}
          onClose={() => setBuyReport(null)}
        />
      )}
      {editPackageModal && (
        <EditPackageDialog
          order={editPackageModal}
          plan={planByOrderNumber.get(editPackageModal.orderNumber) ?? null}
          planLoading={planLoading}
          onClose={(refresh, saved) => {
            const ord = editPackageModal;
            const num = ord.orderNumber;
            setEditPackageModal(null);
            if (refresh) {
              // Weight/box changed → re-quote ONLY this order, not the whole
              // list. The new dims were persisted to the catalog by
              // edit-package, so the plan route re-pushes them and quotes
              // fresh. (Previously this called full load(), re-quoting every
              // ready order — slow when you only touched one.)
              //
              // `saved` is what the operator just entered. It's handed down so
              // the row shows the new package straight away and the quote runs
              // against exactly those numbers — a slow or failed re-quote can
              // no longer make a successful Save look like it did nothing.
              if (ord.isWalmart) {
                setRequoting((p) => ({ ...p, [num]: true }));
                quoteWalmartOrder(
                  ord,
                  effectiveShipDate(num),
                  saved ?? null,
                ).finally(() => setRequoting((p) => ({ ...p, [num]: false })));
              } else {
                // Pass the manually-forced ship date if one is set; otherwise
                // let the engine decide (incl. the Frozen Monday-shift).
                void requoteAmazonOrder(ord, shipDateByOrder[num], saved ?? null);
              }
            }
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
            setShipDateByOrder((p) => ({
              ...p,
              [num]: effectiveBusinessDay(d),
            }));
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
                  edd: rate.deliveryDate
                    ? utcToPacificYMD(rate.deliveryDate)
                    : null,
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
                  edd: rate.deliveryDate
                    ? utcToPacificYMD(rate.deliveryDate)
                    : null,
                  shipByDate: pickedShipDate,
                },
              };
            });
            setShipDateByOrder((p) => ({
              ...p,
              [num]: effectiveBusinessDay(pickedShipDate),
            }));
            setPickRateModal(null);
          }}
        />
      )}
      {pickRateModal && !pickRateModal.isWalmart && (
        <PickRateDialog
          order={pickRateModal}
          plan={planByOrderNumber.get(pickRateModal.orderNumber) ?? null}
          initialShipDate={effectiveShipDate(pickRateModal.orderNumber)}
          onShipDateChange={(d) =>
            setShipDateByOrder((p) => ({
              ...p,
              [pickRateModal.orderNumber]: d,
            }))
          }
          onClose={() => setPickRateModal(null)}
          onPick={(override) => {
            setRateOverrides((prev) => ({
              ...prev,
              [pickRateModal.orderId]: override,
            }));
            // Keep the row's ship-date chip in sync with the picked date.
            if (override.physicalShipDate) {
              setShipDateByOrder((p) => ({
                ...p,
                [pickRateModal.orderNumber]: override.physicalShipDate as string,
              }));
            }
            setPickRateModal(null);
          }}
        />
      )}

      {/* Discard-label confirmation. Discarding voids an already-bought
          label (carrier refund, ~24-72h, irreversible), so we require an
          explicit confirm before firing. */}
      <Dialog
        open={!!discardConfirm}
        onOpenChange={(open) => {
          if (!open) setDiscardConfirm(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard shipping label?</DialogTitle>
            <DialogDescription>
              {discardConfirm
                ? `Order ${discardConfirm.orderNumber}: the bought label will be cancelled with the carrier (refund typically 24-72h). The order stays in Shipping Labels so you can re-quote a fresh label. This can't be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDiscardConfirm(null)}
              disabled={!!discardingLabel}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const o = discardConfirm;
                setDiscardConfirm(null);
                if (o) void discardLabel(o);
              }}
              disabled={!!discardingLabel}
            >
              Discard label
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

/* Channel brand styling (CHANNEL_BRANDS / ChannelToggle) now lives in the
 * shared kit at @/lib/channel-brands so Sales Overview + Dashboard render
 * channels with the same thematic colours. ChannelToggle is imported above. */

/**
 * One segment of the totals strip. Replaces the old 4-up grid of tall
 * KpiCards: same numbers, same click-to-filter, one line instead of a
 * 110px-tall row of cards. The page is a work queue — the queue itself
 * deserves the vertical space, not the tiles above it.
 */
function StatSeg({
  label,
  value,
  icon,
  active,
  onClick,
  tone,
  small,
  title,
}: {
  label: string;
  value: number;
  icon?: ReactNode;
  active?: boolean;
  onClick: () => void;
  tone?: "warn";
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
        active
          ? "bg-green-soft text-green-ink"
          : "text-ink-2 hover:bg-bg-elev hover:text-ink",
      )}
    >
      {icon && (
        <span
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded",
            tone === "warn"
              ? "bg-warn-tint text-warn-strong"
              : active
                ? "bg-green text-green-cream"
                : "bg-bg-elev text-ink-3",
          )}
        >
          {icon}
        </span>
      )}
      <span className="leading-tight">
        <span
          className={cn(
            "block font-mono uppercase tracking-[0.10em] text-ink-3",
            small ? "text-[9.5px]" : "text-[10px]",
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "block font-semibold tabular",
            small ? "text-[14px]" : "text-[17px]",
            tone === "warn" && value > 0 ? "text-warn-strong" : "text-ink",
          )}
        >
          {value}
        </span>
      </span>
    </button>
  );
}

/**
 * One chip in the merged filter row (day bucket + product type). Same
 * visual language as the kit's FilterTabs, but rendered inline so both
 * filter groups fit on a single line instead of stacking two bordered
 * panels.
 */
function Seg({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  tone?: "danger";
}) {
  const danger = tone === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
        danger
          ? active
            ? "bg-danger text-white"
            : "bg-danger-tint text-danger hover:bg-danger hover:text-white"
          : active
            ? "bg-green-soft text-green-ink"
            : "text-ink-2 hover:bg-bg-elev hover:text-ink",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular",
            danger
              ? active
                ? "bg-white/25 text-white"
                : "bg-danger text-white"
              : active
                ? "bg-green text-green-cream"
                : "bg-bg-elev text-ink-3",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * One archive search result — an order that is NOT in today's fulfillment
 * queue (shipped / delivered / cancelled / refunded), rendered read-only.
 * Deliberately flat and dense: the operator is here to CONFIRM something
 * ("what was in that order?", "which tracking went to that address?"),
 * not to act, so every field that answers such a question is on screen at
 * once and nothing is behind an expander.
 */
function ArchiveRow({ hit }: { hit: ArchiveHit }) {
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);

  // The one word the operator needs before anything else. A search by
  // product name returns orders in every state at once — some shipped, some
  // cancelled, some not even bought yet — so "did this one go out?" has to be
  // answerable from across the room, not by reading a small status chip.
  // Three outcomes only; the exact marketplace status rides along in smaller
  // text next to it when it says something more specific.
  const headline =
    hit.statusTone === "danger"
      ? "CANCELLED"
      : hit.status === "delivered"
        ? "DELIVERED"
        : hit.statusTone === "ok"
          ? "SHIPPED"
          : "NOT SHIPPED";
  const headlineCls =
    hit.statusTone === "danger"
      ? "bg-danger text-white"
      : hit.statusTone === "ok"
        ? "bg-green text-green-cream"
        : "bg-warn-strong text-white";
  const cardCls =
    hit.statusTone === "danger"
      ? "border-danger/40 bg-danger-tint/30"
      : hit.statusTone === "ok"
        ? "border-green/40 bg-green-soft/25"
        : "border-warn-strong/40 bg-warn-tint/25";

  // Same hero treatment as the live order rows: one big square, or a grid
  // when a merged order carries several different products. Dedupe by URL,
  // cap at 4.
  const heroImages: { url: string; title: string }[] = [];
  const seenHeroUrls = new Set<string>();
  for (const it of hit.items) {
    if (!it.imageUrl || seenHeroUrls.has(it.imageUrl)) continue;
    seenHeroUrls.add(it.imageUrl);
    heroImages.push({ url: it.imageUrl, title: it.title });
    if (heroImages.length >= 4) break;
  }

  const date = hit.orderDate ? new Date(hit.orderDate) : null;
  const dateLabel =
    date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : null;

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-[length:var(--ship-row)]",
        cardCls,
      )}
    >
      {lightboxImageUrl && (
        <PhotoLightbox
          src={lightboxImageUrl}
          alt=""
          onClose={() => setLightboxImageUrl(null)}
        />
      )}

      <div className="flex items-stretch gap-4">
        {heroImages.length === 0 ? (
          <div className="shrink-0 self-stretch aspect-square min-h-[160px] rounded-lg border border-rule bg-bg-elev" />
        ) : heroImages.length === 1 ? (
          <button
            type="button"
            onClick={() => setLightboxImageUrl(heroImages[0].url)}
            aria-label="Open product photo fullscreen"
            className="relative shrink-0 self-stretch aspect-square min-h-[160px] cursor-zoom-in overflow-hidden rounded-lg border border-rule bg-surface"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImages[0].url}
              alt=""
              className="absolute inset-0 h-full w-full object-contain p-2"
              loading="lazy"
            />
          </button>
        ) : (
          <div
            className={cn(
              "grid shrink-0 self-stretch aspect-square min-h-[160px] gap-px overflow-hidden rounded-lg border border-rule bg-rule",
              heroImages.length === 2
                ? "grid-cols-2 grid-rows-1"
                : "grid-cols-2 grid-rows-2",
            )}
          >
            {heroImages.map((img, idx) => (
              <button
                key={img.url}
                type="button"
                onClick={() => setLightboxImageUrl(img.url)}
                aria-label={`Open product photo: ${img.title}`}
                title={img.title}
                className={cn(
                  "relative cursor-zoom-in overflow-hidden bg-surface",
                  heroImages.length === 3 && idx === 0 ? "col-span-2" : "",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-contain p-1.5"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "rounded px-2 py-1 text-[length:var(--ship-order-no)] font-bold uppercase tracking-wide",
                headlineCls,
              )}
            >
              {headline}
            </span>
            {/* The precise marketplace status, when it carries more than the
                headline already did (e.g. "Label bought" under NOT SHIPPED). */}
            {hit.statusLabel.toUpperCase() !== headline && (
              <span className="text-[length:var(--ship-meta)] font-medium text-ink-2">
                {hit.statusLabel}
              </span>
            )}
            <span className="font-mono text-[length:var(--ship-order-no)] text-ink">
              {hit.orderNumber}
            </span>
            <CopyOrderNumber value={hit.orderNumber} />
            {hit.channel && (
              <span className="text-[length:var(--ship-meta)] text-ink-3">
                · {hit.channel}
              </span>
            )}
            {dateLabel && (
              <span className="text-[length:var(--ship-date)] text-ink-3">
                · {dateLabel}
              </span>
            )}
            {/* Recipient. Older Amazon rows in our DB have no buyer name —
                render just the address rather than a lonely em dash that
                reads like a missing field. */}
            {(hit.customerName || hit.address) && (
              <span className="inline-flex items-center gap-1 rounded bg-bg-elev px-1.5 py-0.5 text-[length:var(--ship-button)] text-ink-2">
                <User size={10} className="text-ink-3" />
                {hit.customerName && <span>{hit.customerName}</span>}
                {hit.address && (
                  <span className="text-ink-3">
                    {hit.customerName ? "· " : ""}
                    {hit.address}
                  </span>
                )}
              </span>
            )}
            {hit.labelPdfUrl && (
              <a
                href={hit.labelPdfUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-[length:var(--ship-button)] text-[#0071dc] underline-offset-2 hover:underline"
              >
                Label PDF
              </a>
            )}
          </div>

          {hit.items.length > 0 ? (
            <ul className="mt-1.5 space-y-2">
              {hit.items.map((i, idx) => (
                <li key={`${i.sku ?? "no-sku"}-${idx}`} className="text-ink-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="text-[length:var(--ship-product)] font-bold leading-snug text-ink">
                      {i.title}
                    </span>
                    <QtyBadge qty={i.quantity} big />
                  </div>
                  {i.sku && (
                    <div className="mt-0.5 font-mono text-[length:var(--ship-sub)] text-ink-3">
                      {i.sku}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1.5 text-[length:var(--ship-meta)] text-ink-3">
              The order contents weren&apos;t kept in our database — open the order in Veeqo.
            </div>
          )}

          {/* Same cell grid the live rows use, so the eye lands in the same
              places on both kinds of row. */}
          <div className="mt-2.5 grid gap-2 text-[length:var(--ship-row)] sm:grid-cols-2 lg:grid-cols-4">
            <Cell
              label="Order total"
              value={
                typeof hit.total === "number" && hit.total > 0
                  ? fmt$(hit.total)
                  : "—"
              }
            />
            <Cell label="Ship by" value={hit.shipBy ? fmtDate(hit.shipBy) : "—"} />
            <Cell
              label="Deliver by"
              value={hit.deliverBy ? fmtDate(hit.deliverBy) : "—"}
            />
            {/* Fourth cell earns its place: the Walmart PO when there is one
                (that's the id used everywhere on Walmart's side), otherwise
                the precise marketplace status — the channel and date already
                sit in the header line, so repeating them here would waste it. */}
            {hit.walmartPurchaseOrderId ? (
              <Cell
                label="Walmart PO"
                value={hit.walmartPurchaseOrderId}
                valueClass="text-ink font-mono text-[length:var(--ship-sub)]"
              />
            ) : (
              <Cell label="Status" value={hit.statusLabel} />
            )}
          </div>

          {hit.tracking.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
                Tracking
              </span>
              {hit.tracking.map((t) => (
                <span
                  key={t.number}
                  className="inline-flex items-center gap-1.5 rounded border border-rule bg-surface px-2 py-1 font-mono text-[length:var(--ship-cell-value)] text-ink"
                  title={[t.carrier, t.service].filter(Boolean).join(" · ")}
                >
                  {t.carrier && (
                    <span className="font-sans text-[length:var(--ship-sub)] text-ink-3">
                      {t.carrier}
                    </span>
                  )}
                  {t.number}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ChannelToggle now lives in @/lib/channel-brands (imported at top) so the
// Sales Overview page reuses the identical brand-styled chip.

// ─────────────────────────────────────────────────────────────────────────
// Order row
// ─────────────────────────────────────────────────────────────────────────

function OrderRow({
  order,
  groupRole = null,
  overdue,
  printedInSession,
  plan,
  planLoading,
  selected,
  selectable,
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
  markingPlaced,
  onMarkPlaced,
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
  /** Set when this row is a member of a merged group. The row then shows all
   *  its ORDER facts as usual and drops every control that acts on this order
   *  alone — package, rate, buy, ship date, rollback, discard — because the
   *  group owns the single physical parcel those would act on. */
  groupRole?: "primary" | "sibling" | null;
  /** Ship-by already passed. Item 7: these carry a red fill so they read as
   *  exceptions at a glance, not just as another row near the top. */
  overdue: boolean;
  /** A label was bought for this row during this session. Item 4: the row
   *  holds its position and is marked, instead of jumping or disappearing. */
  printedInSession: boolean;
  plan: PlanItem | null;
  planLoading: boolean;
  selected: boolean;
  /** True when this row is in the parent's `selectableIds` set — i.e. the
   *  bulk action button would act on it. Drives checkbox visibility:
   *  in the active tab that's `ready_to_buy` rows; in the awaiting tab
   *  it's `isAwaitingShipConfirm` rows (manually-bought labels included). */
  selectable: boolean;
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
    labelLookupFailed?: boolean;
    labelLookupError?: string | null;
  } | null;
  /** Last error from /api/shipping/walmart/rates for this order, if any —
   *  e.g. "No saved package for RizwanX-3579:1". Rendered in the Buy area
   *  so the operator knows what to fix instead of seeing "Awaiting rate". */
  walmartRateError: string | null;
  markingShipped: boolean;
  onMarkShipped: () => void;
  markingPlaced: boolean;
  onMarkPlaced: () => void;
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
  // This row is one member of a merged parcel. Everything it says about the
  // ORDER stays; everything that would act on its own box goes.
  const inGroup = groupRole != null;

  // Click a product thumbnail to view it fullscreen — same lightbox the
  // Procurement module uses, so the operator can read package text/expiry.
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);

  // Label cost recommendation comes from /api/shipping/plan. If plan is
  // still in flight (planLoading) we show a spinner; if plan is in but
  // this order has status="stop", we show the stop reason from the plan.
  const planPending = plan && plan.status === "pending";
  const planStop = plan && plan.status !== "pending" && plan.notes;

  // A re-quote is in flight for THIS order (operator changed the package, or
  // a Walmart ship-date re-quote is running). Drives the spinner on the
  // money/carrier cells so the operator knows the price shown is being
  // recomputed and isn't a stale value from before the edit.
  const isRequoting = requoting === true;

  // The price actually in effect: a manual rate override wins over the
  // algorithm's pick. Without this the Carrier cell showed the operator's
  // chosen rate while Label cost kept displaying the old algorithmic price —
  // they looked inconsistent. Both the displayed cost and the margin use it.
  const effectivePrice = rateOverride?.price ?? plan?.price ?? null;

  // Margin sanity: customer paid X for shipping, label costs Y. Positive
  // margin = we made money on shipping; negative = we ate the difference.
  const shippingMargin =
    effectivePrice != null
      ? order.customerPaidShipping - effectivePrice
      : null;

  // Walmart purchase/ship state (Veeqo still says "ready" because buying via
  // Walmart doesn't flip Veeqo): a label exists but the order isn't shipped
  // yet → show "bought / not shipped" + Mark-as-Shipped; or already Shipped.
  //
  // Both gates require an ACTIONABLE state (ready_to_buy or bought) — without
  // that gate a Walmart order stuck in waiting_placed (procurement not done
  // yet) but with a stale existing-label probe would render Mark-as-Shipped
  // on the dimmed card. The button needs to live alongside a label that
  // genuinely matches the current procurement state, not just any label
  // Walmart's API happens to know about.
  const wmShipped =
    !!order.isWalmart &&
    walmartStatus?.orderStatus === "Shipped" &&
    (isReady || isBought);
  const wmBought =
    !!order.isWalmart &&
    !!walmartStatus?.existingLabel &&
    !wmShipped &&
    (isReady || isBought);

  // Product photos for the row — one per distinct item image, rendered as a
  // big square on the left (same height as the whole info block) so the
  // operator recognises the product at a glance. Most orders have a single
  // product, but a MERGED order (several Veeqo orders combined onto one label
  // for the same recipient) carries several different products — show them ALL
  // so none is hidden behind the first. Dedupe by URL and cap at 4 so the
  // grid stays readable.
  const heroImages: { url: string; title: string }[] = [];
  const seenHeroUrls = new Set<string>();
  for (const it of order.items) {
    if (!it.imageUrl || seenHeroUrls.has(it.imageUrl)) continue;
    seenHeroUrls.add(it.imageUrl);
    heroImages.push({ url: it.imageUrl, title: it.productTitle });
    if (heroImages.length >= 4) break;
  }

  return (
    <div
      className={cn(
        "rounded-md border bg-surface p-3 text-[length:var(--ship-row)]",
        // Order matters. A row printed in this session reads as DONE above
        // everything else — otherwise a just-printed overdue order keeps
        // shouting red and the operator prints it twice. Overdue is next,
        // because a missed ship-by outranks "needs attention" (owner's rule,
        // 2026-07-30) and must be visible as an exception, not just as a row
        // that happens to sit near the top.
        // A group member sits inside the group's own blue card. It keeps the
        // card shape so it reads as a row, but not the loud state fills —
        // the group card is the thing carrying the state now.
        inGroup
          ? "border-info/30 bg-surface"
          : printedInSession
          ? "border-green bg-green-soft/60"
          : overdue
            ? "border-danger bg-danger-tint/40"
            : isAttn
              ? "border-warn-strong/40 bg-warn-tint/30"
              : isWaiting
                ? "border-rule opacity-70"
                : isBought
                  ? "border-green/40 bg-green-soft/30"
                  : "border-rule"
      )}
    >
      {lightboxImageUrl && (
        <PhotoLightbox
          src={lightboxImageUrl}
          alt=""
          onClose={() => setLightboxImageUrl(null)}
        />
      )}

      {/* Two-column layout: a big square product photo on the left (stretched
          to the full height of the info block), and ALL the order info on the
          right. */}
      <div className="flex items-stretch gap-4">
        {/* Large square product image. `self-stretch aspect-square` makes its
            side equal the height of the right-hand info column, so it grows
            with the card. Single product → one image; merged/multi-product
            order → a grid so every product is visible. Click to open fullscreen.
            Plain <img> (Veeqo CDN URLs aren't on next.config's allowed list),
            absolutely positioned so it fills its cell without feeding its
            intrinsic size back into the flex layout. object-contain (not cover)
            shows the WHOLE photo with no cropping; padding keeps it off edges. */}
        {heroImages.length === 0 ? (
          <div className="shrink-0 self-stretch aspect-square min-h-[160px] rounded-lg border border-rule bg-bg-elev" />
        ) : heroImages.length === 1 ? (
          <button
            type="button"
            onClick={() => setLightboxImageUrl(heroImages[0].url)}
            aria-label="Open product photo fullscreen"
            className="relative shrink-0 self-stretch aspect-square min-h-[160px] cursor-zoom-in overflow-hidden rounded-lg border border-rule bg-surface"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImages[0].url}
              alt=""
              className="absolute inset-0 h-full w-full object-contain p-2"
              loading="lazy"
            />
          </button>
        ) : (
          // Merged order: 2 → side by side; 3 → one across the top + two below;
          // 4 → 2×2. The `bg-rule` container shows through the 1px gaps as
          // hairline dividers between products.
          <div
            className={cn(
              "grid shrink-0 self-stretch aspect-square min-h-[160px] gap-px overflow-hidden rounded-lg border border-rule bg-rule",
              heroImages.length === 2
                ? "grid-cols-2 grid-rows-1"
                : "grid-cols-2 grid-rows-2",
            )}
          >
            {heroImages.map((img, idx) => (
              <button
                key={img.url}
                type="button"
                onClick={() => setLightboxImageUrl(img.url)}
                aria-label={`Open product photo: ${img.title}`}
                title={img.title}
                className={cn(
                  "relative cursor-zoom-in overflow-hidden bg-surface",
                  // 3 images: first spans the top row so there's no empty cell.
                  heroImages.length === 3 && idx === 0 ? "col-span-2" : "",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-contain p-1.5"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}

        {/* Right column — every existing order detail. */}
        <div className="min-w-0 flex-1">
      {/* Top row: select + identity + type tag */}
      <div className="flex items-start gap-3">
        {inGroup ? (
          // No checkbox inside a group: the whole parcel is the unit of
          // action, and a tick here would offer to buy half a shipment.
          <div className="mt-1 h-3.5 w-3.5">
            <Package size={14} className="text-info" />
          </div>
        ) : selectable ? (
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
            <span className="font-mono text-[length:var(--ship-order-no)] text-ink">
              {order.orderNumber}
            </span>
            <CopyOrderNumber value={order.orderNumber} />
            {/* Item 4: the row stays exactly where it was after printing, so it
                needs to say plainly that it's done — otherwise a row sitting in
                its old place looks like work still to do. */}
            {printedInSession && (
              <span className="inline-flex items-center gap-1 rounded bg-green px-1.5 py-0.5 text-[length:var(--ship-badge)] font-semibold text-white">
                <CheckCircle size={12} />
                Printed
              </span>
            )}
            {overdue && !printedInSession && (
              <span className="rounded bg-danger px-1.5 py-0.5 text-[length:var(--ship-badge)] font-semibold text-white">
                Overdue
              </span>
            )}
            <span className="text-[length:var(--ship-meta)] text-ink-3">
              · {order.storeName}
            </span>
            {order.shipBy && (
              <span className="text-[length:var(--ship-date)] text-ink-3">
                · Ship by {fmtDate(order.shipBy)}
              </span>
            )}
            {/* Shipping recipient — name + city/state — so the operator can
                sanity-check the destination on the row without opening Veeqo.
                Compact chip; full address still lives in Veeqo. */}
            {(order.customerName || order.city || order.shipToState) && (
              <span className="inline-flex items-center gap-1 rounded bg-bg-elev px-1.5 py-0.5 text-[length:var(--ship-button)] text-ink-2">
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
              !inGroup &&
              (order.isWalmart ? !wmBought && !wmShipped : true) && (
                <span className="inline-flex items-center gap-1 text-[length:var(--ship-meta)] text-ink-3">
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
                      // Ship date is the thing the operator scans for on every
                      // row — keep it a notch bigger and bolder than the rest
                      // of the meta line.
                      "rounded border bg-surface px-1.5 py-0.5 text-[length:var(--ship-date)] font-medium leading-none focus:border-[#0071dc] focus:outline-none",
                      shipDateOverridden
                        ? "border-[#0071dc] text-[#0071dc]"
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
              // The Physical chip MUST anchor on plan.actualShipDay
              // (== legacyActualShipDay in the route — the very day
              // selectBestRate used as the rate anchor), not on
              // plan.physicalShipDate. The latter is set to labelDate
              // in the non-trick branch, which on a Sunday load means
              // Sun even though the warehouse hands off Mon. Showing
              // Sun here would lie about when the package physically
              // leaves and would contradict the Ship-date picker
              // (which now also advances Sat/Sun to next business day).
              const labelDate = plan.labelDate ?? plan.actualShipDay;
              // A manual ship-date override (inline picker / rate modal) carries
              // its own physical ship day. Prefer THAT so the chip never
              // disagrees with the date picker after a re-quote; fall back to
              // the batch plan's day when there's no override.
              const overridePhysical = rateOverride?.physicalShipDate ?? null;
              const physicalShipDate =
                overridePhysical ?? plan.actualShipDay ?? plan.physicalShipDate;
              if (!labelDate && !physicalShipDate) return null;

              // Show the dual Label/Physical chip whenever the physical day
              // differs from the Amazon label date — via an override OR the
              // route's explicit Ship-Date-Trick flag.
              const trickApplied = overridePhysical
                ? overridePhysical !== labelDate
                : plan.shipDateTrickApplied === true;

              if (!trickApplied) {
                return (
                  <span
                    className="text-[length:var(--ship-date)] font-medium text-ink-2"
                    title="Label date and physical ship date are the same"
                  >
                    · 📦 Ship {fmtDate(physicalShipDate ?? labelDate ?? "")}
                  </span>
                );
              }

              return (
                <>
                  <span
                    className="text-[length:var(--ship-date)] font-medium text-ink-2"
                    title="Date Amazon sees on the label (drives Late Shipment Rate)"
                  >
                    · Label {fmtDate(labelDate ?? "")}
                  </span>
                  <span
                    className="rounded bg-warn-tint px-1.5 py-px text-[length:var(--ship-date)] font-semibold text-warn-strong"
                    title="Physical ship date pushed by Frozen Ship Date Trick — hand to carrier on this date, not today"
                  >
                    · 📦 Physical {fmtDate(physicalShipDate ?? "")}
                  </span>
                </>
              );
            })()}
          </div>

          {/* Items list — each on its own line so multi-item orders read
              clearly. The product photo now lives in the big square on the
              left, so here we drop the thumbnail and give the title and the
              order-count badge a much larger, easier-to-read size. */}
          <ul className="mt-1.5 space-y-2">
            {order.items.map((i) => (
              <li key={i.sku} className="text-ink-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="text-[length:var(--ship-product)] font-bold leading-snug text-ink">
                    {i.productTitle}
                  </span>
                  <QtyBadge qty={i.quantity} big />
                </div>
                <div className="mt-0.5 font-mono text-[length:var(--ship-sub)] text-ink-3">
                  {i.sku}
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
      <div className="mt-2.5 ml-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-6 text-[length:var(--ship-row)]">
        <Cell label="Order total" value={fmt$(order.orderTotal)} />
        <Cell
          label="Customer paid shipping"
          value={fmt$(order.customerPaidShipping)}
          // The shipping tier the buyer actually chose (Standard / Expedited
          // / Second Day / Next Day). Surfaced right under the amount so the
          // operator can see when a customer paid for a faster service than
          // Standard and the label must match that promise. Highlighted when
          // it's anything other than plain Standard / Free / Economy.
          sub={order.customerShippingService ?? undefined}
          subClass={
            order.customerShippingService &&
            isExpeditedService(order.customerShippingService)
              ? "text-warn-strong font-medium"
              : undefined
          }
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
        {(isReady || isBought) && !inGroup && (
          <button
            type="button"
            onClick={onEditPackage}
            title="Edit weight and box size — saves to SKU database and recomputes rate"
            className="rounded bg-surface-tint px-2 py-1.5 text-left hover:bg-bg-elev hover:ring-1 hover:ring-rule transition-colors"
          >
            <div className="flex items-center justify-between gap-1 text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
              <span>Package</span>
              <Pencil size={9} className="text-ink-3" />
            </div>
            <div className="mt-0.5 truncate font-semibold tabular text-ink">
              {isRequoting ? (
                <span className="inline-flex items-center gap-1 text-ink-3">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-[length:var(--ship-badge)] font-normal">updating…</span>
                </span>
              ) : plan?.weight != null ? (
                `${plan.weight} lbs`
              ) : planLoading ? (
                "loading…"
              ) : isReady ? (
                // No saved weight/dims for this SKU. The cell is clickable —
                // make the dash an explicit call to action instead of a bare
                // "—" that looks like missing data with nothing to do.
                <span className="text-[length:var(--ship-meta)] font-medium text-warn-strong">
                  Set weight/size
                </span>
              ) : (
                "—"
              )}
            </div>
            {!isRequoting && plan?.boxSize && (
              <div className="truncate text-[length:var(--ship-sub)] text-ink-3">
                {plan.boxSize}
              </div>
            )}
          </button>
        )}
        {(isReady || isBought) && !inGroup && (
          <Cell
            label={isBought ? "Label cost (bought)" : "Label cost"}
            value={
              isRequoting ? (
                <span className="inline-flex items-center gap-1 text-ink-3">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-[length:var(--ship-badge)] font-normal">recalculating…</span>
                </span>
              ) : planLoading && !plan ? (
                "loading…"
              ) : effectivePrice != null ? (
                fmt$(effectivePrice)
              ) : planStop ? (
                "stopped"
              ) : (
                "—"
              )
            }
            valueClass={
              shippingMargin != null && shippingMargin < 0
                ? "text-danger"
                : "text-ink"
            }
            // Hide the (now stale) margin while a re-quote is running so the
            // operator doesn't read a margin computed against the old price.
            sub={
              !isRequoting && shippingMargin != null
                ? `margin ${shippingMargin >= 0 ? "+" : ""}${fmt$(shippingMargin)}`
                : undefined
            }
          />
        )}
        {(isReady || isBought) && !inGroup && (
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
            <div className="flex items-center justify-between gap-1 text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
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
              {isRequoting ? (
                <span className="inline-flex items-center gap-1 text-ink-3">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-[length:var(--ship-badge)] font-normal">re-quoting…</span>
                </span>
              ) : rateOverride ? (
                rateOverride.service ?? rateOverride.carrier ?? "—"
              ) : plan?.service ? (
                plan.service
              ) : plan?.carrier ? (
                plan.carrier
              ) : planLoading ? (
                "loading…"
              ) : (
                "—"
              )}
            </div>
            <div className="flex items-center justify-between gap-1 text-[length:var(--ship-sub)] text-ink-3">
              <span>
                {(() => {
                  const edd = rateOverride?.edd ?? plan?.edd ?? null;
                  // Transit time in calendar days, anchored to the day the
                  // rate selector actually measured transit from — i.e.
                  // plan.actualShipDay, which is what selectBestRate used
                  // as `actualShipDay` (Sat/Sun → next Mon, weekday →
                  // today, trick → next Mon). Prefer it over
                  // physicalShipDate because on a Sunday-load with no
                  // Monday-shift trick the route still leaves
                  // physicalShipDate = labelDate (= today = Sun) — but
                  // the warehouse won't physically hand off on Sunday, and
                  // selectBestRate filtered Frozen rates with calDays
                  // measured from Mon. Anchoring on Sun would inflate the
                  // badge to "4 days" for a compliant 3-day rate. Falls
                  // back to physicalShipDate (when actualShipDay is
                  // absent for older plans) and finally shipDateGlobal.
                  const transitAnchor =
                    plan?.actualShipDay ??
                    plan?.physicalShipDate ??
                    shipDate;
                  const days =
                    edd && transitAnchor
                      ? Math.round(
                          (new Date(edd).getTime() -
                            new Date(transitAnchor).getTime()) /
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
                  className="text-[length:var(--ship-cell-label)] text-ink-3 hover:text-danger underline"
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
        <div className="mt-2 ml-6 rounded bg-info-tint px-2 py-1.5 text-[length:var(--ship-badge)] text-info">
          Frozen — the agent keeps the cheapest rate that meets two
          conditions: it delivers on/before the marketplace deadline, and
          within the food-safety window (3 calendar days, tightened to 2 when
          it&apos;s hot at the destination). A faster rate is preferred when it
          costs no more than $3 extra. The package physically ships next Monday
          (label still dated today) when Monday is faster in transit at no more
          than $3 extra, or more than 15% cheaper — both options always stay
          inside the food-safety window.
        </div>
      )}

      {/* Action area per state */}
      {isAttn && (
        <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
          <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-warn-strong">
            {order.needAttentionReason
              ? ATTENTION_LABELS[order.needAttentionReason]
              : "Needs review"}
          </span>
          {order.needAttentionReason === "no_type" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[length:var(--ship-button)]"
                onClick={onClassify}
              >
                <Sparkles size={12} className="mr-1" /> Classify with AI
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[length:var(--ship-button)]"
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
              className="h-7 text-[length:var(--ship-button)]"
              onClick={onPacking}
            >
              <Package size={12} className="mr-1" /> Set packing profile
            </Button>
          )}
          {order.needAttentionReason === "no_sku" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[length:var(--ship-button)]"
              onClick={onSku}
            >
              <Package size={12} className="mr-1" /> Add SKU data
            </Button>
          )}
          {order.needAttentionReason === "mixed_order" && (
            <span className="text-[length:var(--ship-badge)] text-ink-3">
              Split the order in Veeqo (Frozen + Dry on one label isn&apos;t
              supported).
            </span>
          )}
          {order.needAttentionReason === "frozen_walmart" && (
            <span className="text-[length:var(--ship-badge)] text-ink-3">
              Frozen items can&apos;t ship via Walmart — cancel or switch
              channel.
            </span>
          )}
          {(order.needAttentionReason === "budget" ||
            order.needAttentionReason === "no_service") && (
            <span className="text-[length:var(--ship-badge)] text-ink-3">
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
          <span className="text-[length:var(--ship-badge)] text-green-ink">
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
            className="h-7 text-[length:var(--ship-button)]"
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
        <div className="mt-1 ml-6 text-[length:var(--ship-badge)] text-green-ink">
          Shipped ✓ (confirmed to Walmart).
        </div>
      )}

      {isReady && !inGroup && !wmBought && !wmShipped && (
        <div className="mt-2 ml-6 flex flex-wrap items-center justify-between gap-2">
          {planStop && rateOverride ? (
            // Algorithm stopped this order (e.g. no rate meets the deadline),
            // but the operator manually picked a rate — let them buy it and
            // just warn that it may ship late. The override is the operator
            // taking responsibility for the deadline miss.
            <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-warn-strong">
              Manual override — no on-time rate found, this label may ship
              late. {plan?.notes}
            </span>
          ) : planStop ? (
            <span className="rounded bg-danger-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-danger">
              {plan?.notes}
            </span>
          ) : buyError ? (
            // Show the last buy failure inline so the operator doesn't
            // think the spinner-then-active-button cycle meant success.
            <span className="rounded bg-danger-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-danger">
              Buy failed — {buyError}
            </span>
          ) : walmartRateError && !planPending ? (
            // Walmart-direct rate call failed (e.g. missing PackingProfile
            // for the qty-specific signature on a Walmart split). Surface
            // the exact reason so the operator can fix it instead of
            // staring at a perpetual "Awaiting rate".
            <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-warn-strong">
              Rate error — {walmartRateError}
            </span>
          ) : walmartStatus?.labelLookupFailed ? (
            // Walmart 429-d (or otherwise refused) the labels-lookup. We
            // can't prove the order doesn't already have a label, so Buy
            // is disabled until a re-quote succeeds. Without this guard a
            // 429 was the source of double-paid labels.
            <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-warn-strong">
              Can&apos;t verify if label already bought —{" "}
              {walmartStatus.labelLookupError ?? "Walmart lookup failed"}.
              Re-quote (Refresh) before buying.
            </span>
          ) : (
            <span className="text-[length:var(--ship-badge)] text-ink-3">
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
            disabled={
              buying ||
              // Buyable when the algorithm has a pending rate, OR the operator
              // manually overrode a stopped order (buy their pick anyway).
              !(planPending || (planStop && rateOverride)) ||
              !!walmartStatus?.labelLookupFailed
            }
            title={
              walmartStatus?.labelLookupFailed
                ? `Can't verify if a label was already bought (${walmartStatus.labelLookupError ?? "Walmart lookup failed"}). Re-quote before buying to avoid a double charge.`
                : planStop && rateOverride
                  ? "Buy your manually-picked rate even though no rate meets the deadline (may ship late)."
                  : undefined
            }
            className="h-7 text-[length:var(--ship-button)]"
          >
            {buying ? (
              <>
                <Loader2 size={12} className="mr-1 animate-spin" />
                Buying…
              </>
            ) : walmartStatus?.labelLookupFailed ? (
              <>
                <ShoppingCart size={12} className="mr-1" /> Buy (re-quote
                first)
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
        <div className="mt-1 ml-6 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[length:var(--ship-badge)] text-ink-3">
            Waiting for procurement (no <code>Placed</code> tag yet).
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onMarkPlaced}
            disabled={markingPlaced}
            title="Add the Placed tag in Veeqo so this order advances to Ready to buy without going through /procurement"
            className="h-7 text-[length:var(--ship-button)]"
          >
            {markingPlaced ? (
              <>
                <Loader2 size={12} className="mr-1 animate-spin" /> Marking…
              </>
            ) : (
              "Mark as Placed"
            )}
          </Button>
        </div>
      )}
      {isBought && (
        <div className="mt-1 ml-6 text-[length:var(--ship-badge)] text-green-ink">
          Label already purchased.
        </div>
      )}

      {/* Universal action row — Rollback / Discard always available on
          every shipping row regardless of channel or state. Rollback
          handles "supplier didn't deliver" (keeps the label); Discard
          handles "order cancelled" (refunds the label). Both Amazon
          and Walmart paths are dispatched server-side.

          Hidden for a group member: there is no per-order label to discard
          (the group bought ONE), and rolling a single member back would
          leave the others pointing at a parcel that no longer exists. Both
          actions belong to the group — un-merge first, then act. */}
      {!inGroup && (
      <div className="mt-3 ml-6 flex flex-wrap items-center gap-2 border-t border-rule pt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onRollback}
          disabled={rollingBack || markingShipped || discardingLabel}
          title="Push the order back to Procurement (keeps the bought label)"
          className="h-7 text-[length:var(--ship-button)]"
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
          className="h-7 text-[length:var(--ship-button)]"
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
      )}
        </div>
        {/* /right column */}
      </div>
      {/* /two-column layout */}
    </div>
  );
}

// Merge Orders entry point: a line at the top of the page saying some orders
// are heading to the same address and could ship in one box. Clicking it turns
// on merge mode, which narrows the list to exactly those orders so they can be
// ticked and merged — the flow the owner described.
//
// Candidates whose goods aren't bought yet are counted separately rather than
// hidden: "these two would ship together once purchased" is worth seeing.
function MergeBanner({
  merge,
  active,
  onToggle,
}: {
  merge: MergeState;
  active: boolean;
  onToggle: () => void;
}) {
  const blocked = merge.groupCount - merge.readyCount;
  const groupWord = merge.groupCount === 1 ? "group" : "groups";
  const blockedNumbers = [
    ...new Set(
      merge.candidates.flatMap((c) => c.blockedOrderNumbers ?? []),
    ),
  ];
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-info bg-info-tint"
          : "border-warn-strong bg-warn-tint hover:bg-warn-tint/70",
      )}
    >
      <Package
        size={16}
        className={cn("shrink-0", active ? "text-info" : "text-warn-strong")}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[length:var(--ship-row)] font-semibold",
            active ? "text-info" : "text-warn-strong",
          )}
        >
          {merge.groupCount} {groupWord} ({merge.orderCount} orders) going to
          the same address
        </div>
        <div className="text-[length:var(--ship-meta)] text-ink-2">
          {merge.readyCount > 0
            ? `${merge.readyCount} ready to merge — one box, one label.`
            : "None ready to merge yet."}
          {blocked > 0 &&
            ` ${blocked} waiting on goods to be purchased first.`}
        </div>
        {/* Name the orders holding a group back. "Waiting on goods" without
            saying WHICH order sends the operator hunting through the queue
            for a row that the day filter may not even be showing. */}
        {blockedNumbers.length > 0 && (
          <div className="text-[length:var(--ship-meta)] text-ink-3">
            Not purchased yet: {blockedNumbers.join(", ")}
          </div>
        )}
      </div>
      <span
        className={cn(
          "shrink-0 rounded border px-2 py-1 text-[length:var(--ship-button)] font-medium",
          active
            ? "border-info text-info"
            : "border-warn-strong text-warn-strong",
        )}
      >
        {active ? "Close" : "Show orders"}
      </span>
    </button>
  );
}


function QtyBadge({ qty, big = false }: { qty: number; big?: boolean }) {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (qty === 1) {
    return (
      <span className={cn("text-ink-3", big ? "text-[16px]" : "text-[12.5px]")}>
        × 1
      </span>
    );
  }
  const isHigh = qty >= 10;
  const isMid = qty >= 4;
  return (
    <span
      title={`${qty} units ordered from one listing — check it`}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-bold tabular leading-none",
        big
          ? "h-9 min-w-[42px] px-3 text-[20px]"
          : "h-5 min-w-[20px] px-1.5 text-[11.5px]",
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

// One-click copy button for an Amazon order number. Lives next to the
// order number in OrderRow; the warehouse pastes it into Amazon Seller
// Central / Veeqo search far more often than they retype it.
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

/** Pull a human-readable message out of anything thrown or returned — an
 *  Error, an API error object ({error}/{message}), a string, else a JSON
 *  dump. Prevents the dreaded "[object Object]" when a non-Error object
 *  reaches a catch (e.g. a rejected fetch payload). */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") return o.message;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/** Compact "5/14" date for dense grid cells. Falls back to the raw value
 *  if parsing fails, so we never blank out useful info. */
/** Money, always two decimals. Shared by the live rows and the archive rows
 *  so a dollar amount reads identically wherever it appears. */
function fmt$(v: number): string {
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

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

/** Parse a calendar-day string into a UTC-midnight timestamp for whole-day
 *  differencing. Every shipping date reaches the UI already normalized to a
 *  marketplace calendar day (Pacific for Veeqo, Walmart-native for Walmart),
 *  so we compare them as bare Y/M/D — never re-interpreting a timezone here.
 *  This is the fix for the off-by-one badges: `new Date("2026-06-16")` is
 *  parsed as UTC midnight and then read back in the operator's local zone
 *  (Eastern), which rolls it to Jun 15 and skews "days left" by a day. We
 *  pull the Y/M/D straight from the string head instead. Falls back to
 *  Date parsing for any non-YMD input (e.g. a stray full ISO). */
function calDayUTC(s: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? null
    : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Days between marketplace deadline and carrier EDD. Negative → carrier
 *  arrives before deadline (good). Positive → late. */
function daysLate(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): number | null {
  if (!deliverBy || !edd) return null;
  const a = calDayUTC(edd);
  const b = calDayUTC(deliverBy);
  if (a == null || b == null) return null;
  return Math.round((a - b) / 86400000);
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
  const deadline = calDayUTC(deliverBy);
  if (deadline == null) return null;
  const today = new Date();
  return Math.round(
    (deadline -
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
  subClass,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  valueClass?: string;
  subClass?: string;
}) {
  return (
    <div className="rounded bg-surface-tint px-2 py-1.5">
      <div className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div
        className={cn(
          // The value is what the operator actually reads — it used to inherit
          // the grid's size and came out the same as its own caption.
          "mt-0.5 truncate text-[length:var(--ship-cell-value)] font-semibold tabular",
          valueClass || "text-ink"
        )}
      >
        {value}
      </div>
      {sub && (
        <div
          className={cn(
            "truncate text-[length:var(--ship-sub)]",
            subClass || "text-ink-3"
          )}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/** Is this Veeqo delivery_method.name a faster-than-standard tier? Used to
 *  highlight the customer's chosen shipping service on the row. Strips
 *  spaces/hyphens first so it catches BOTH Amazon's compact names
 *  ("NextDay", "SecondDay") and Veeqo's spaced titles ("Next Day Air",
 *  "2nd Day"). Everything else (Standard, Free, Economy, Ground) reads as
 *  the normal tier. */
function isExpeditedService(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    n.includes("expedit") ||
    n.includes("nextday") ||
    n.includes("oneday") ||
    n.includes("1day") ||
    n.includes("secondday") ||
    n.includes("2ndday") ||
    n.includes("twoday") ||
    n.includes("2day") ||
    n.includes("priority") ||
    n.includes("overnight") ||
    n.includes("express")
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
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
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
    const w = toLbs(weight, weightUnit);
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
          // weightFedex omitted — backend always derives w × 1.25
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
        <div className="space-y-3 text-[length:var(--ship-row)]">
          <div>
            <div className="font-medium text-ink mb-1">Composition</div>
            <ul className="rounded border border-rule bg-surface-tint p-2 text-ink-2 space-y-0.5">
              {order.items.map((i, idx) => (
                <li key={i.sku || idx}>
                  • {i.productTitle} × {i.quantity}
                  {i.sku ? ` (${i.sku})` : ""}
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
            <BoxPresetPicker
              value={boxSize}
              onSelect={(label) => setBoxSize(label)}
            />
            <div className="mt-1 text-[11px] text-ink-3">
              Selected: <span className="font-mono font-medium text-ink-2">{boxSize}</span>
            </div>
          </div>

          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Weight
            </label>
            <WeightInput
              value={weight}
              onChange={setWeight}
              unit={weightUnit}
              onUnitChange={setWeightUnit}
            />
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
  // Default the marketplace to the order's actual channel rather than
  // hard-coding Amazon. channelKind is the normalised Veeqo type_code
  // ("amazon" / "walmart" / "tiktok" / "ebay" / "shopify" / "direct").
  // Anything we don't recognise falls back to Amazon.
  const [marketplace, setMarketplace] = useState(() => {
    const kind = (order.channelKind ?? "").toLowerCase();
    switch (kind) {
      case "walmart":
        return "Walmart";
      case "tiktok":
        return "TikTok";
      case "ebay":
        return "eBay";
      case "amazon":
        return "Amazon";
      default:
        // Legacy fallback: check the human-readable channel name if
        // channelKind is missing (older dashboard payloads).
        return order.channel?.toLowerCase().includes("walmart")
          ? "Walmart"
          : "Amazon";
    }
  });
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!item) return;
    const L = Number(length);
    const W = Number(width);
    const H = Number(height);
    const wt = toLbs(weight, weightUnit);
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
          // weightFedex omitted — backend derives wt × 1.25 (see fix-sku/route.ts)
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
                <option>TikTok</option>
                <option>eBay</option>
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
          {/* Box preset — picking a chip fills the three L/W/H inputs.
              Typing a new size in the "Custom size" mini-form auto-saves
              it as a new preset AND fills the inputs in one step. */}
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box preset
            </label>
            <BoxPresetPicker
              value={`${length}x${width}x${height}`}
              onSelect={(_label, dims) => {
                setLength(String(dims.length));
                setWidth(String(dims.width));
                setHeight(String(dims.height));
              }}
            />
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
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Weight
            </label>
            <WeightInput
              value={weight}
              onChange={setWeight}
              unit={weightUnit}
              onUnitChange={setWeightUnit}
            />
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
/** One labelled field on the post-buy confirmation card. `big` bumps the value
 *  a step for the field the operator scans hardest (the delivery estimate). */
function ReceiptField({
  label,
  value,
  sub,
  big = false,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  big?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div
        className={cn(
          "break-words font-semibold text-ink",
          big
            ? "text-[length:var(--ship-cell-value)]"
            : "text-[length:var(--ship-meta)]",
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[length:var(--ship-sub)] text-ink-3">{sub}</div>
      )}
    </div>
  );
}

function BuyReportDialog({
  report,
  orders,
  plans,
  onClose,
}: {
  report: BuyReport;
  orders: DashboardOrder[];
  /** orderNumber → plan item, the source of package dims, weight and EDD.
   *  Covers Amazon (Veeqo plan) and Walmart (its own quote) alike. */
  plans: Map<string, PlanItem>;
  onClose: () => void;
}) {
  // orderNumber → its line items, so each purchased row can show WHAT was in
  // the box. Vladimir wants to recall what he bought a label for without
  // leaving the result modal.
  const itemsByOrder = useMemo(() => {
    const m = new Map<string, DashboardItem[]>();
    for (const o of orders) m.set(o.orderNumber, o.items);
    return m;
  }, [orders]);
  // orderNumber → the order itself, for recipient and destination state.
  const orderByNumber = useMemo(() => {
    const m = new Map<string, DashboardOrder>();
    for (const o of orders) m.set(o.orderNumber, o);
    return m;
  }, [orders]);
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
      <DialogContent className="shipping-scale sm:max-w-[620px]">
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
            <div className="space-y-2">
              <div className="font-medium text-ink">Printed</div>
              {report.bought.map((b) => {
                // Everything the operator wants to confirm at a glance: what
                // was printed, how big it is, who it goes to, by whom, and
                // when it lands — without leaving this window (item 3).
                const order = orderByNumber.get(b.orderNumber) ?? null;
                const items = itemsByOrder.get(b.orderNumber) ?? [];
                const plan = plans.get(b.orderNumber) ?? null;
                const hero = items.find((i) => i.imageUrl) ?? items[0] ?? null;
                const destination = [order?.customerName, order?.shipToState]
                  .filter(Boolean)
                  .join(" · ");
                const parcel = [
                  plan?.boxSize,
                  plan?.weight != null ? `${plan.weight} lb` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    key={b.itemId}
                    className="rounded border border-green/50 bg-green-soft/25 p-3"
                  >
                    <div className="flex items-start gap-3">
                      {hero?.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={hero.imageUrl}
                          alt=""
                          className="h-20 w-20 shrink-0 rounded border border-rule bg-surface object-contain"
                        />
                      ) : (
                        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded border border-rule bg-surface-tint">
                          <Package size={22} className="text-ink-3" />
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        {/* Product name is the biggest thing on the card —
                            it's the one field that answers "what did I just
                            print". */}
                        <div className="text-[length:var(--ship-product)] font-bold leading-snug text-ink break-words">
                          {items.length > 1 && (
                            <span className="text-ink-2">
                              {items.length} items ·{" "}
                            </span>
                          )}
                          {hero?.productTitle ?? b.orderNumber}
                        </div>
                        {items.length > 1 && (
                          <ul className="mt-1 space-y-px border-l-2 border-rule pl-2">
                            {items.map((it, idx) => (
                              <li
                                key={idx}
                                className="text-[length:var(--ship-meta)] text-ink-2 break-words"
                              >
                                <span className="font-medium text-ink">
                                  {it.quantity}×
                                </span>{" "}
                                {it.productTitle}
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                          <ReceiptField
                            label="Package"
                            value={parcel || "—"}
                          />
                          <ReceiptField
                            label="Ship to"
                            value={destination || "—"}
                          />
                          <ReceiptField
                            label="Carrier"
                            value={b.service ?? b.carrier ?? "—"}
                            sub={
                              b.price != null
                                ? `$${b.price.toFixed(2)}`
                                : undefined
                            }
                          />
                          <ReceiptField
                            label="Arrives (EDD)"
                            value={plan?.edd ? fmtDate(plan.edd) : "—"}
                            big
                          />
                        </div>
                      </div>
                    </div>

                    {/* Everything below is the operational trail — order
                        number, tracking, and where the PDF actually landed.
                        Kept intact: a silent Drive failure once looked like a
                        success here and the labels existed only on Veeqo. */}
                    <div className="mt-2 border-t border-rule pt-2 text-[length:var(--ship-meta)]">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono text-ink-2">
                          {b.orderNumber}
                        </span>
                        <span className="text-ink-3">
                          Tracking:{" "}
                          <span className="font-mono text-ink-2">
                            {b.tracking}
                          </span>
                        </span>
                        {b.pdfSaved && b.labelPath ? (
                          <a
                            href={b.labelPath}
                            target="_blank"
                            rel="noreferrer"
                            className="text-info underline"
                          >
                            Open PDF
                          </a>
                        ) : (
                          <span className="text-warn-strong">
                            ⚠ PDF not saved locally — re-download from Veeqo
                          </span>
                        )}
                        <span>
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
                        </span>
                      </div>
                      {b.driveError && (
                        <div className="mt-0.5 font-mono text-[length:var(--ship-sub)] text-ink-3">
                          {b.driveError}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
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
  planLoading,
  onClose,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  /** The page is still fetching rates. Distinguishes "values are on their way"
   *  from "this order genuinely has no package on file". */
  planLoading: boolean;
  /** `saved` carries the box+weight that was just written, so the row can show
   *  it immediately and the re-quote can quote against exactly those values. */
  onClose: (refresh: boolean, saved?: SavedPackage | null) => void;
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
  // Weight unit toggle (lbs/oz). Always defaults to lbs since stored
  // weights in PackingProfile/SkuShippingData are lbs — switching to oz
  // changes only the label, never the displayed number (see WeightInput).
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the fields if the plan lands AFTER the dialog was opened.
  //
  // The state above is initialised once, at mount. Opening this dialog before
  // the page finished loading rates therefore left every field blank FOREVER —
  // the plan arrived, the props updated, and the inputs never noticed. That is
  // the "I click Package, wait a minute, close it, open it again and it's
  // instant" the owner reported: the wait was the page's plan load, and
  // reopening was the only thing that re-seeded the fields.
  //
  // Guarded on all four fields still being empty, which is only true when the
  // operator hasn't typed anything — so this can never overwrite input.
  useEffect(() => {
    if (!plan) return;
    if (length !== "" || width !== "" || height !== "" || weight !== "") return;
    const box = parseBox(plan.boxSize);
    if (box.l || box.w || box.h) {
      setLength(box.l);
      setWidth(box.w);
      setHeight(box.h);
      setBoxLabel(
        BOX_PRESETS.some((pr) => pr.label === plan.boxSize)
          ? (plan.boxSize as string)
          : "custom",
      );
    }
    if (plan.weight != null) setWeight(String(plan.weight));
    // `parseBox` is a stable pure local; the field values are read as a
    // "has the operator started typing" guard, not as inputs to re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  async function save() {
    setErr(null);
    // Convert displayed value → lbs. The backend always expects lbs and
    // derives weightFedex = lbs × 1.25 internally for FedEx One Rate
    // (see MASTER_PROMPT_v3.1.md §K), so we don't send weightFedex.
    const w = toLbs(weight, weightUnit);
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
          allocationId,
          channel: order.channel ?? undefined,
          // Explicit flag beats guessing from the channel NAME: a Walmart
          // order has no Veeqo package to push, and mis-detecting it made the
          // API attempt a Veeqo PUT that could fail and block the save.
          isWalmart: !!order.isWalmart,
        };
      } else {
        // No SKU? Push the package dims straight to Veeqo's allocation
        // (no local DB save — SkuShippingData is keyed by SKU). Common
        // for eBay listings: Veeqo shows "SKU: -" so we can't write a
        // SkuShippingData row, but we CAN update the allocation_package
        // so Veeqo's next rate quote uses these dims. Requires the order
        // to have an allocation we can target.
        if (!sku) {
          if (!allocationId) {
            throw new Error(
              "Order has no SKU and no Veeqo allocation — can't save packaging anywhere.",
            );
          }
          body = {
            length: L,
            width: W,
            height: H,
            weight: w,
            allocationId,
            channel: order.channel ?? undefined,
            isWalmart: !!order.isWalmart,
          };
        } else {
          body = {
            sku,
            length: L,
            width: W,
            height: H,
            weight: w,
            allocationId,
            channel: order.channel ?? undefined,
            isWalmart: !!order.isWalmart,
          };
        }
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
      onClose(true, { length: L, width: W, height: H, weight: w });
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

        {/* Say plainly that the current values haven't arrived yet. Blank
            fields used to be indistinguishable from "this SKU has no package
            on file", so the operator sat waiting at a dialog that had nothing
            left to load. */}
        {!plan && planLoading && (
          <div className="flex items-center gap-2 rounded border border-rule bg-surface-tint px-3 py-2 text-[length:var(--ship-meta)] text-ink-2">
            <Loader2 size={14} className="animate-spin text-ink-3" />
            Loading the current weight and box for this order…
          </div>
        )}

        <div className="space-y-3 text-[length:var(--ship-row)]">
          {/* Box preset picker — clicking a chip fills the L/W/H fields
              below. Typing a new size in "Custom size" auto-saves it as
              a new preset AND fills the inputs in one step. */}
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box preset
            </label>
            <BoxPresetPicker
              value={boxLabel === "custom" ? `${length}x${width}x${height}` : boxLabel}
              onSelect={(label, dims) => {
                setBoxLabel(label);
                setLength(String(dims.length));
                setWidth(String(dims.width));
                setHeight(String(dims.height));
              }}
            />
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

          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Weight
            </label>
            <WeightInput
              value={weight}
              onChange={setWeight}
              unit={weightUnit}
              onUnitChange={setWeightUnit}
            />
          </div>

          <div className="rounded border border-rule bg-surface-tint p-2 text-[11px] text-ink-3">
            Saves to{" "}
            {isMulti ? (
              <code className="font-mono">PackingProfile</code>
            ) : (
              <code className="font-mono">SkuShippingData</code>
            )}
            . FedEx One Rate weight (K-column) is derived automatically as{" "}
            <code className="font-mono">weight × 1.25</code> and used only
            when quoting FedEx One Rate. After save the row reloads and
            re-quotes the rate against the new packaging.
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
  initialShipDate,
  onShipDateChange,
  onClose,
  onPick,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  initialShipDate: string;
  onShipDateChange: (d: string) => void;
  onClose: () => void;
  onPick: (override: RateOverride) => void;
}) {
  const [rates, setRates] = useState<VeeqoRateLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // The ship date drives the quote — Veeqo derives each rate's EDD (and any
  // weekend surcharge) from the dispatch day. Changing it re-fetches the list
  // for the new day so the rates recalculate, exactly like the card.
  const [shipDate, setShipDate] = useState<string>(initialShipDate);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/shipping/rates?orderId=${encodeURIComponent(
            order.orderId,
          )}&shipDate=${shipDate}`,
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
  }, [order.orderId, shipDate]);

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
    // Render EDD in America/Los_Angeles to match the plan card + Veeqo's
    // own UI. Eastern adds a day for Veeqo's PT-23:59 timestamps and
    // pushes overrides one calendar day past the real promise date — see
    // veeqoDateToLocal comment in src/lib/veeqo/client.ts.
    const edd = rate.delivery_promise_date
      ? utcToPacificYMD(rate.delivery_promise_date)
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
      // Buy dispatches on the day the rates were quoted against.
      physicalShipDate: shipDate,
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

        {/* Ship date — rates re-quote for the chosen dispatch day. */}
        <div className="flex items-center gap-2 rounded border border-rule bg-bg-elev px-3 py-2">
          <label
            htmlFor="pickrate-shipdate"
            className="text-[12px] font-medium text-ink-2"
          >
            Ship date
          </label>
          <input
            id="pickrate-shipdate"
            type="date"
            value={shipDate}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              const safe = effectiveBusinessDay(v);
              setShipDate(safe); // re-fetches the rate list for the new day
              onShipDateChange(safe); // keep the card's date in sync
            }}
            className="rounded border border-rule bg-surface px-2 py-1 text-[12px] text-ink"
          />
          <span className="text-[11px] text-ink-3">
            rates recalculate for this dispatch day
          </span>
        </div>

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
              // Pacific TZ to match the plan card + Veeqo's UI; Eastern
              // adds a day for Veeqo's PT-23:59 timestamps (see
              // veeqoDateToLocal in src/lib/veeqo/client.ts).
              const edd = rate.delivery_promise_date
                ? utcToPacificYMD(rate.delivery_promise_date)
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
  // Anchor "today" in Eastern (Miami) — same TZ Vladimir reads against
  // Walmart's seller portal. `new Date().toISOString().slice(0,10)` would
  // return the UTC calendar day, which after 8 PM NY is already tomorrow
  // and would preselect a future ship date for evening operators.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
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
              // Walmart returns deliveryDate as a UTC instant near end-of-day
              // (e.g. "2026-06-17T04:59:00Z" is really Jun 16 21:59 PT). It
              // MUST be decoded to the Pacific calendar day — string-slicing
              // the UTC head showed it a day late (Jun 17), which made a rate
              // that actually meets the Jun 16 deadline look like it misses,
              // while Walmart's promise flag still said "on time" → the badge
              // contradicted the EDD on screen. Convert once, use everywhere.
              const eddPT = rate.deliveryDate
                ? utcToPacificYMD(rate.deliveryDate)
                : "";
              // On time vs the marketplace deadline, judged on the SAME dates
              // the operator sees (Pacific EDD vs deliver-by) so the badge can
              // never contradict the displayed dates. Walmart's own promise
              // flag is only a fallback when there's no EDD to compare.
              const onTime =
                deadlineBy && eddPT
                  ? (daysLate(deadlineBy, eddPT) ?? 1) <= 0
                  : rate.deliveryPromiseFulfilled === true
                    ? true
                    : rate.deliveryPromiseFulfilled === false
                      ? false
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
                          {eddPT ? (
                            <span className={onTime === false ? "text-danger" : ""}>
                              {` · EDD ${fmtDate(eddPT)}`}
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

