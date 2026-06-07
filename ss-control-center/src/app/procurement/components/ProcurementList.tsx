"use client";

import { useState } from "react";
import {
  Zap,
  Calendar,
  Store,
  User,
  AlertOctagon,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Btn } from "@/components/kit";
import {
  ProcurementCard,
  type ProcurementCardData,
  type CardAction,
  type ActionResult,
} from "./ProcurementCard";

export interface ProcurementOrderCard extends ProcurementCardData {
  orderId: string;
  orderNumber: string;
  channel: string;
  storeName: string;
  customerName: string | null;
  shipBy: string | null;
  /** Gross total Veeqo recorded for this order (shipping included). Each
   *  line carries the same value because the order header is rendered
   *  from the first line via the grouping in this component. */
  orderTotal: number | null;
  currency: string | null;
}

/** Live Walmart-side cancellation signal for an order, keyed by Veeqo
 *  order number (== Walmart customerOrderId). Set by the page after it
 *  calls /api/procurement/walmart-cancellations in parallel with /items. */
export interface CancellationFlag {
  intentToCancel: boolean;
  isCancelled: boolean;
  cancellationReason: string | null;
  purchaseOrderId: string;
  status: string;
}

interface ProcurementListProps {
  cards: ProcurementOrderCard[];
  onAction: (
    lineItemId: string,
    orderId: string,
    action: CardAction
  ) => Promise<ActionResult>;
  /** SKU → ordered store names. Empty/missing entry means "not configured". */
  prioritiesBySku?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Set of currently bulk-selected lineItemIds. */
  selected?: ReadonlySet<string>;
  /** Toggle bulk-selection of a single line. */
  onToggleSelect?: (lineItemId: string) => void;
  /** Bubble up new store priorities from the popup so the page can refresh
   *  its cache and every card showing this SKU updates instantly. */
  onPrioritiesSaved?: (sku: string, storeNames: ReadonlyArray<string>) => void;
  /** Walmart cancellation flags keyed by Veeqo orderNumber. Undefined entry
   *  = nothing surfaced for that order (either non-Walmart or check still
   *  pending). */
  cancellationFlags?: Readonly<Record<string, CancellationFlag>>;
  /** Called when the operator clicks "Cancel on Walmart" on the banner.
   *  Hits /api/procurement/walmart-cancel-order with reason
   *  CUSTOMER_CHANGED_MIND. Resolved value is bubbled back so the banner
   *  can show inline success/error. */
  onCancelWalmartOrder?: (
    orderNumber: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

function formatShipBy(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // "Mon, May 5"
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function shipByUrgency(iso: string | null): "today" | "soon" | "later" | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 1) return "today";
  if (diffDays < 2) return "soon";
  return "later";
}

function formatMoney(value: number | null, currency: string | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Bad currency code — fall back to the plain number with the code suffix.
    return `${value.toFixed(2)} ${code}`;
  }
}

interface CancellationBannerProps {
  flag: CancellationFlag;
  orderNumber: string;
  onCancel?: (orderNumber: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Inline banner shown above an order's line items when Walmart reports
 * either an active buyer cancellation request (intentToCancel) or an
 * already-cancelled state. The Cancel button hits the
 * /api/procurement/walmart-cancel-order endpoint which uses Walmart
 * reason code CUSTOMER_CHANGED_MIND (Vladimir's chosen reason for
 * procurement-time cancellations).
 */
function CancellationBanner({
  flag,
  orderNumber,
  onCancel,
}: CancellationBannerProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (flag.isCancelled || done) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule bg-bg-elev px-3 py-2 text-[12px] text-ink-3 sm:px-4">
        <XCircle size={13} className="shrink-0 text-ink-3" />
        <span className="font-medium text-ink-2">
          Cancelled on Walmart
        </span>
        {flag.cancellationReason && (
          <>
            <span className="text-ink-4">·</span>
            <span className="font-mono text-[11px] text-ink-3">
              reason: {flag.cancellationReason}
            </span>
          </>
        )}
        <span className="text-ink-4">·</span>
        <span className="font-mono text-[11px] text-ink-3">
          PO {flag.purchaseOrderId}
        </span>
      </div>
    );
  }

  // intentToCancel === true and not yet actioned
  async function handleCancel() {
    if (!onCancel) return;
    setPending(true);
    setError(null);
    const r = await onCancel(orderNumber);
    setPending(false);
    if (r.ok) {
      setDone(true);
    } else {
      setError(r.error ?? "Walmart rejected the cancel call");
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-danger/40 bg-danger-tint/70 px-3 py-2.5 sm:px-4">
      <div className="flex items-start gap-2">
        <AlertOctagon size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-danger">
            Buyer requested cancellation on Walmart
          </div>
          <div className="mt-0.5 text-[11.5px] text-danger/90">
            Do not buy inventory for this order. Cancel it before Walmart
            auto-cancels (≤48h) — that protects the cancellation-rate
            seller metric.
          </div>
          {flag.cancellationReason && (
            <div className="mt-1 font-mono text-[11px] text-danger/80">
              reason: {flag.cancellationReason}
            </div>
          )}
        </div>
        <Btn
          variant="primary"
          size="sm"
          loading={pending}
          icon={!pending ? <XCircle size={13} /> : undefined}
          onClick={handleCancel}
        >
          {pending ? "Cancelling…" : "Cancel on Walmart"}
        </Btn>
      </div>
      {error && (
        <div className="rounded-md bg-surface px-2 py-1 text-[11.5px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function channelDot(channel: string): string {
  const c = channel.toLowerCase();
  if (c.includes("amazon")) return "bg-warn-tint text-warn-strong";
  if (c.includes("walmart")) return "bg-info-tint text-info";
  if (c.includes("ebay")) return "bg-purple-tint text-purple";
  return "bg-bg-elev text-ink-3";
}

export function ProcurementList({
  cards,
  onAction,
  prioritiesBySku,
  selected,
  onToggleSelect,
  onPrioritiesSaved,
  cancellationFlags,
  onCancelWalmartOrder,
}: ProcurementListProps) {
  // Group by orderId, preserving the order coming from the backend (already
  // sorted by ship-by or by title there).
  const groups: Array<{ orderId: string; items: ProcurementOrderCard[] }> = [];
  const indexById = new Map<string, number>();
  for (const c of cards) {
    const idx = indexById.get(c.orderId);
    if (idx === undefined) {
      indexById.set(c.orderId, groups.length);
      groups.push({ orderId: c.orderId, items: [c] });
    } else {
      groups[idx]!.items.push(c);
    }
  }

  return (
    <div className="space-y-3">
      {groups.map(({ orderId, items }) => {
        const head = items[0]!;
        const ship = formatShipBy(head.shipBy);
        const urgency = shipByUrgency(head.shipBy);
        const totalMoney = formatMoney(head.orderTotal, head.currency);
        const cancelFlag = cancellationFlags?.[head.orderNumber];
        // Visual emphasis when something's off on Walmart's side: the
        // operator must NOT buy inventory for an order the buyer just
        // asked to cancel. Border + tint colour the entire order block
        // so it's impossible to miss while scrolling.
        const flagged = cancelFlag?.intentToCancel ?? false;
        const cancelled = cancelFlag?.isCancelled ?? false;
        return (
          <div
            key={orderId}
            className={cn(
              "overflow-hidden rounded-lg border bg-surface",
              flagged && "border-danger ring-2 ring-danger/30",
              cancelled && !flagged && "border-rule opacity-60",
              !flagged && !cancelled && "border-rule",
            )}
          >
            {/* Order header — small, dense, secondary */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule bg-surface-tint px-3 py-2 text-[11.5px] tabular text-ink-3 sm:px-4">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider",
                  channelDot(head.channel)
                )}
              >
                {head.channel}
              </span>
              <span className="font-mono text-ink-2">#{head.orderNumber}</span>
              {head.customerName && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="inline-flex items-center gap-1">
                    <User size={11} /> {head.customerName}
                  </span>
                </>
              )}
              {head.storeName && head.storeName !== head.channel && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Store size={11} /> {head.storeName}
                  </span>
                </>
              )}
              {head.isPremium && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="inline-flex items-center gap-1 rounded bg-warn-tint px-1.5 py-0.5 font-medium text-warn-strong">
                    <Zap size={10} /> Premium
                  </span>
                </>
              )}
              {ship && (
                <>
                  <span className="text-ink-4">·</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
                      urgency === "today" && "bg-danger-tint text-danger",
                      urgency === "soon" && "bg-warn-tint text-warn-strong",
                      urgency === "later" && "text-ink-2"
                    )}
                  >
                    <Calendar size={10} /> Ship by {ship}
                  </span>
                </>
              )}
              {items.length > 1 && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="font-medium text-ink-2">
                    {items.length} товаров в заказе
                  </span>
                </>
              )}
              {totalMoney && (
                <>
                  <span className="text-ink-4">·</span>
                  <span
                    className="font-medium text-ink"
                    title="Gross order total (includes shipping) — Veeqo total_price"
                  >
                    {totalMoney}
                  </span>
                </>
              )}
            </div>

            {/* Cancellation banner — sits between the order header and
                the line items. Surfaces Walmart's intentToCancel flag
                (the red exclamation in Seller Center) so the operator
                sees it BEFORE deciding to buy inventory, and offers a
                one-click cancel with reason CUSTOMER_CHANGED_MIND. */}
            {cancelFlag && (cancelFlag.intentToCancel || cancelFlag.isCancelled) && (
              <CancellationBanner
                flag={cancelFlag}
                orderNumber={head.orderNumber}
                onCancel={onCancelWalmartOrder}
              />
            )}

            {/* Cards */}
            <div>
              {items.map((c) => (
                <ProcurementCard
                  key={c.lineItemId}
                  card={c}
                  channel={c.channel}
                  orderId={c.orderId}
                  storePriorities={prioritiesBySku?.[c.sku] ?? []}
                  selected={selected?.has(c.lineItemId) ?? false}
                  onToggleSelect={onToggleSelect}
                  onPrioritiesSaved={onPrioritiesSaved}
                  onAction={(lineItemId, action) =>
                    onAction(lineItemId, c.orderId, action)
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
