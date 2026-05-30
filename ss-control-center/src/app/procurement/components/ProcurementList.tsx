"use client";

import { Zap, Calendar, Store, User } from "lucide-react";
import { cn } from "@/lib/utils";
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
        return (
          <div
            key={orderId}
            className="overflow-hidden rounded-lg border border-rule bg-surface"
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
