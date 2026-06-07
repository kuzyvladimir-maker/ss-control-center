"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  Search,
  X,
  Check,
  ShoppingCart,
} from "lucide-react";
import { Btn, FilterTabs, PageHead, type FilterTab } from "@/components/kit";
import { cn } from "@/lib/utils";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import {
  ProcurementList,
  type ProcurementOrderCard,
  type CancellationFlag,
} from "./components/ProcurementList";
import type {
  CardAction,
  ActionResult,
} from "./components/ProcurementCard";

type SortKey = "shipBy" | "title";

const SORT_TABS: FilterTab<SortKey>[] = [
  { id: "shipBy", label: "По срочности" },
  { id: "title", label: "По названию" },
];

type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";

/** Calendar-day bucket for the ship-by date, in the user's local timezone.
 *  Mirrors what Veeqo shows in its order list (Today / Tomorrow / 2 days). */
function shipByBucket(iso: string | null): ShipByBucket | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diffDays = Math.floor(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === 2) return "dayafter";
  return "later";
}

const SHIP_BY_OPTIONS: Array<{
  id: ShipByBucket;
  label: string;
  /** Tailwind classes for the button when active. */
  activeCls: string;
}> = [
  {
    id: "overdue",
    label: "Просрочено",
    activeCls: "border-danger bg-danger-tint text-danger",
  },
  {
    id: "today",
    label: "Сегодня",
    activeCls: "border-warn-strong bg-warn-tint text-warn-strong",
  },
  {
    id: "tomorrow",
    label: "Завтра",
    activeCls: "border-info bg-info-tint text-info",
  },
  {
    id: "dayafter",
    label: "Послезавтра",
    activeCls: "border-green bg-green-soft text-green-ink",
  },
  {
    id: "later",
    label: "Позже",
    activeCls: "border-rule-strong bg-bg-elev text-ink",
  },
];

const ACTION_PATH: Record<CardAction["kind"], string> = {
  bought: "bought",
  partial: "partial",
  undo: "undo",
};

export default function ProcurementPage() {
  const [cards, setCards] = useState<ProcurementOrderCard[]>([]);
  const [prioritiesBySku, setPrioritiesBySku] = useState<
    Record<string, string[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("shipBy");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  // Live Walmart-side cancellation flags keyed by Veeqo order number
  // (== Walmart customerOrderId). Populated by a parallel call to
  // /api/procurement/walmart-cancellations after each items load and
  // each refresh — Vladimir's requirement that a cancellation check
  // runs every time data refreshes, so he never buys inventory for an
  // order the buyer is trying to cancel.
  const [cancellationFlags, setCancellationFlags] = useState<
    Record<string, CancellationFlag>
  >({});
  const [search, setSearch] = useState("");
  // Quick filter by sales channel (toggle: click = on, click again = off).
  // null = show all channels.
  const [channelFilter, setChannelFilter] = useState<"amazon" | "walmart" | null>(
    null
  );
  // Quick filter by ship-by date bucket. null = show all dates.
  const [shipByFilter, setShipByFilter] = useState<ShipByBucket | null>(null);

  // Pull-to-refresh on mobile. Returns easedPull in px (0..120).
  // Threshold 80 → release at that distance triggers a reload.
  const easedPull = usePullToRefresh(() => {
    void load();
  });

  // Bulk-select state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
    errors: number;
  } | null>(null);

  const toggleSelect = useCallback((lineItemId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineItemId)) next.delete(lineItemId);
      else next.add(lineItemId);
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/procurement/items");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newCards: ProcurementOrderCard[] = data.cards ?? [];
      setCards(newCards);
      setLastSync(new Date());

      // Background-load store priorities for the SKUs we just received.
      // Failure is non-fatal — the page still works without store chips.
      const skus = Array.from(
        new Set(newCards.map((c) => c.sku).filter(Boolean))
      );
      if (skus.length > 0) {
        try {
          const params = new URLSearchParams();
          for (const s of skus) params.append("sku", s);
          const r = await fetch(
            `/api/procurement/sku-stores?${params.toString()}`
          );
          if (r.ok) {
            const j = (await r.json()) as {
              prioritiesBySku?: Record<string, string[]>;
            };
            setPrioritiesBySku(j.prioritiesBySku ?? {});
          }
        } catch {
          /* non-fatal */
        }
      } else {
        setPrioritiesBySku({});
      }

      // Walmart-side cancellation sweep. We only need to check Walmart
      // channel orders (other channels have their own cancellation
      // surfaces). Non-fatal: if Walmart's API hiccups the page still
      // renders, the operator just won't see the red banner.
      const walmartOrderNumbers = Array.from(
        new Set(
          newCards
            .filter((c) => (c.channel ?? "").toLowerCase() === "walmart")
            .map((c) => c.orderNumber)
            .filter(Boolean),
        ),
      );
      if (walmartOrderNumbers.length > 0) {
        try {
          const r = await fetch("/api/procurement/walmart-cancellations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderNumbers: walmartOrderNumbers }),
          });
          if (r.ok) {
            const j = (await r.json()) as {
              results?: Record<string, CancellationFlag>;
            };
            setCancellationFlags(j.results ?? {});
          } else {
            setCancellationFlags({});
          }
        } catch {
          setCancellationFlags({});
        }
      } else {
        setCancellationFlags({});
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Click-handler for the "Cancel on Walmart" button in the
   * CancellationBanner. Hits the cancel-order endpoint (which uses
   * Walmart reason code CUSTOMER_CHANGED_MIND) and, on success, removes
   * every line tied to that orderNumber from the local card list so
   * the entire order block disappears from the procurement queue.
   */
  const handleCancelWalmartOrder = useCallback(
    async (orderNumber: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/procurement/walmart-cancel-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!r.ok || body.ok === false) {
          return {
            ok: false,
            error: body.error ?? `HTTP ${r.status}`,
          };
        }
        // Drop the cancelled order from the local list — Vladimir's
        // viewing intent is "procurement work to do", and a cancelled
        // order isn't work anymore.
        setCards((prev) => prev.filter((c) => c.orderNumber !== orderNumber));
        // Reflect the new state in the flag so the banner stays
        // showing the cancelled-state badge until the row leaves.
        setCancellationFlags((prev) => {
          const next = { ...prev };
          if (next[orderNumber]) {
            next[orderNumber] = {
              ...next[orderNumber],
              intentToCancel: false,
              isCancelled: true,
              status: "Cancelled",
            };
          }
          return next;
        });
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Network error",
        };
      }
    },
    [],
  );

  /**
   * Mark every selected line item as "bought" — sequentially, since each
   * call reads-then-writes order state and parallel calls on the same
   * order would race. Errors are counted and reported but don't stop the
   * batch; the user gets a final tally.
   */
  const handleBulkBought = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkProgress({ done: 0, total: ids.length, errors: 0 });

    let errors = 0;
    for (let i = 0; i < ids.length; i++) {
      const lineItemId = ids[i]!;
      const card = cards.find((c) => c.lineItemId === lineItemId);
      if (!card) {
        errors++;
        setBulkProgress({ done: i + 1, total: ids.length, errors });
        continue;
      }
      try {
        const r = await fetch(
          `/api/procurement/items/${encodeURIComponent(lineItemId)}/bought`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: card.orderId }),
          }
        );
        if (!r.ok) {
          errors++;
        } else {
          // Mark this card as bought in local state immediately
          setCards((prev) =>
            prev.map((c) =>
              c.lineItemId === lineItemId
                ? { ...c, status: { kind: "bought" }, remaining: 0 }
                : c
            )
          );
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(lineItemId);
            return next;
          });
        }
      } catch {
        errors++;
      }
      setBulkProgress({ done: i + 1, total: ids.length, errors });
    }

    // Hold the final tally for a moment so the user sees the result
    setTimeout(() => setBulkProgress(null), 2500);
  }, [selected, cards]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /**
   * Apply an action optimistically, then call the server. On failure the
   * UI reverts to the previous status. Cards that become "bought" stay
   * visible until the next refresh — that's the spec ("карточка не
   * исчезает, она просто меняет визуальный статус").
   */
  const handleAction = useCallback(
    async (
      lineItemId: string,
      orderId: string,
      action: CardAction
    ): Promise<ActionResult> => {
      // Snapshot for rollback
      let previousStatus: ProcurementOrderCard["status"] = null;
      let previousRemaining = 0;

      const optimistic = (() => {
        if (action.kind === "bought") {
          return { kind: "bought" as const };
        }
        if (action.kind === "partial") {
          return { kind: "remain" as const, remaining: action.remaining };
        }
        return null;
      })();

      setCards((prev) =>
        prev.map((c) => {
          if (c.lineItemId !== lineItemId) return c;
          previousStatus = c.status;
          previousRemaining = c.remaining;
          return {
            ...c,
            status: optimistic,
            remaining:
              action.kind === "partial"
                ? action.remaining
                : action.kind === "bought"
                  ? 0
                  : c.quantityOrdered,
          };
        })
      );

      try {
        const res = await fetch(
          `/api/procurement/items/${encodeURIComponent(
            lineItemId
          )}/${ACTION_PATH[action.kind]}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              action.kind === "partial"
                ? { orderId, remaining: action.remaining }
                : { orderId }
            ),
          }
        );
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok) {
          // Revert
          setCards((prev) =>
            prev.map((c) =>
              c.lineItemId === lineItemId
                ? { ...c, status: previousStatus, remaining: previousRemaining }
                : c
            )
          );
          return {
            ok: false,
            error: json.error ?? `HTTP ${res.status}`,
          };
        }
        return { ok: true };
      } catch (e: unknown) {
        // Revert
        setCards((prev) =>
          prev.map((c) =>
            c.lineItemId === lineItemId
              ? { ...c, status: previousStatus, remaining: previousRemaining }
              : c
          )
        );
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Network error",
        };
      }
    },
    []
  );

  // Filter by channel chip + ship-by chip, then by smart search query.
  // Search is tokenised: every whitespace-separated token must hit at
  // least one searchable field (productTitle, SKU, order#, customer,
  // store, channel). Matches the /shipping page's search behaviour so
  // multi-term queries like "kinder amazon" filter the way operators
  // type them.
  const filteredCards = useMemo(() => {
    let arr = cards;
    if (channelFilter) {
      arr = arr.filter((c) => c.channel.toLowerCase().includes(channelFilter));
    }
    if (shipByFilter) {
      arr = arr.filter((c) => shipByBucket(c.shipBy) === shipByFilter);
    }
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      arr = arr.filter((c) => {
        const haystack = [
          c.productTitle,
          c.sku,
          c.orderNumber,
          c.customerName,
          c.storeName,
          c.channel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        for (const t of tokens) {
          if (!haystack.includes(t)) return false;
        }
        return true;
      });
    }
    return arr;
  }, [cards, search, channelFilter, shipByFilter]);

  // Sort cards: by ship-by ascending (urgent first) OR by title alphabetically.
  // Cards with no ship-by sink to the bottom in the shipBy view.
  const sortedCards = useMemo(() => {
    const arr = [...filteredCards];
    if (sort === "shipBy") {
      arr.sort((a, b) => {
        const aT = a.shipBy
          ? new Date(a.shipBy).getTime()
          : Number.POSITIVE_INFINITY;
        const bT = b.shipBy
          ? new Date(b.shipBy).getTime()
          : Number.POSITIVE_INFINITY;
        if (aT !== bT) return aT - bT;
        // Same ship-by → keep order grouping intact via orderId
        return a.orderId.localeCompare(b.orderId);
      });
    } else {
      arr.sort((a, b) =>
        a.productTitle.localeCompare(b.productTitle, undefined, {
          sensitivity: "base",
        })
      );
    }
    return arr;
  }, [filteredCards, sort]);

  // Distinct order count — Vladimir compares this against Veeqo's "orders" count
  const orderCount = useMemo(() => {
    const ids = new Set(cards.map((c) => c.orderId));
    return ids.size;
  }, [cards]);

  const filteredOrderCount = useMemo(() => {
    const ids = new Set(filteredCards.map((c) => c.orderId));
    return ids.size;
  }, [filteredCards]);

  // Card-counts per ship-by bucket — shown as a small number on each chip
  // so Vladimir sees urgency at a glance without applying the filter.
  // Counted distinct orders, not line items, to mirror the procurement list
  // grouping.
  const shipByCounts = useMemo(() => {
    const counts: Record<ShipByBucket, Set<string>> = {
      overdue: new Set(),
      today: new Set(),
      tomorrow: new Set(),
      dayafter: new Set(),
      later: new Set(),
    };
    // Apply channel filter only — search shouldn't change urgency overview
    const base = channelFilter
      ? cards.filter((c) =>
          c.channel.toLowerCase().includes(channelFilter)
        )
      : cards;
    for (const c of base) {
      const b = shipByBucket(c.shipBy);
      if (b) counts[b].add(c.orderId);
    }
    return {
      overdue: counts.overdue.size,
      today: counts.today.size,
      tomorrow: counts.tomorrow.size,
      dayafter: counts.dayafter.size,
      later: counts.later.size,
    };
  }, [cards, channelFilter]);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-12 pt-5 sm:px-6">
      {/* Pull-to-refresh indicator. Sits below the App Shell Header and
          fades in / scales up as the user pulls. Past the 80px threshold
          the icon flips so the gesture feels confirmed before release. */}
      {easedPull > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 flex justify-center"
          style={{ top: "calc(var(--topbar-height) + 8px)" }}
        >
          <div
            className="flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 shadow-md ring-1 ring-rule"
            style={{
              opacity: Math.min(1, easedPull / 40),
              transform: `translateY(${Math.min(28, easedPull / 4)}px)`,
            }}
          >
            <RefreshCw
              size={14}
              className={cn(
                "transition-transform duration-200",
                easedPull >= 80 && "rotate-180 text-green"
              )}
            />
            <span>
              {easedPull >= 80
                ? "Отпусти чтобы обновить"
                : "Потяни чтобы обновить"}
            </span>
          </div>
        </div>
      )}
      <PageHead
        title="Procurement"
        subtitle={
          <>
            {search || channelFilter || shipByFilter ? (
              <>
                <span className="font-medium text-ink-2">
                  {filteredOrderCount} из {orderCount} заказов
                </span>
                <span className="text-ink-4">·</span>
                <span>
                  {filteredCards.length} из {cards.length} товаров
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-ink-2">
                  {orderCount} заказов
                </span>
                <span className="text-ink-4">·</span>
                <span>{cards.length} товаров</span>
              </>
            )}
            {lastSync && (
              <>
                <span className="text-ink-4">·</span>
                <span className="font-mono text-[11.5px]">
                  Обновлено {lastSync.toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </>
            )}
          </>
        }
      />

      {/* Sticky filter toolbar — search, channel/ship-by chips, sort tabs,
          and a persistent "Обновить" button. Sticks under the Header so all
          of this is reachable at any scroll depth. */}
      <div className="sticky top-0 z-20 -mx-4 mb-3 border-b border-rule bg-bg/95 px-4 pb-2 pt-2 backdrop-blur-sm sm:-mx-6 sm:px-6">
        {/* Row 1: Search + persistent refresh */}
        <div className="flex items-center gap-2">
          <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2.5 md:min-h-0 md:py-2">
            <Search size={15} className="text-ink-3" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by product, SKU, order #, customer, store, channel…"
              className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink md:h-6 md:w-6"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-rule bg-surface px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-bg-elev hover:text-ink disabled:opacity-60 md:h-9"
            aria-label="Обновить список"
            title="Обновить"
          >
            <RefreshCw
              size={14}
              className={cn(loading && "animate-spin")}
            />
            <span className="hidden sm:inline">Обновить</span>
          </button>
        </div>

        {/* Row 2: Quick filter chips — channels + ship-by, single horizontal
            scrollable row so they all fit on a 380px iPhone. */}
        <div className="-mx-4 mt-2 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
          {/* Brand-coloured channel toggles — matches the visual language of
              the Shipping Labels page so the same chip means the same thing
              everywhere. Amazon: orange wordmark with the smile underline;
              Walmart: blue wordmark with the yellow spark. */}
          <button
            type="button"
            onClick={() =>
              setChannelFilter((prev) => (prev === "amazon" ? null : "amazon"))
            }
            aria-pressed={channelFilter === "amazon"}
            title="Только Amazon заказы"
            className={cn(
              "group relative shrink-0 rounded-md border px-3.5 pb-2 pt-1.5 text-[13px] font-semibold leading-none transition",
              channelFilter === "amazon"
                ? "border-[#ff9900] bg-[#ff9900]/10 text-[#232f3e] shadow-sm"
                : "border-rule bg-surface text-ink-2 hover:border-[#ff9900]/60 hover:text-ink-1"
            )}
          >
            <span className="lowercase tracking-tight">amazon</span>
            <span
              className={cn(
                "absolute bottom-1 left-3.5 right-3.5 h-[3px] rounded-full transition",
                channelFilter === "amazon"
                  ? "bg-[#ff9900]"
                  : "bg-[#ff9900]/40 group-hover:bg-[#ff9900]/70"
              )}
            />
          </button>
          <button
            type="button"
            onClick={() =>
              setChannelFilter((prev) => (prev === "walmart" ? null : "walmart"))
            }
            aria-pressed={channelFilter === "walmart"}
            title="Только Walmart заказы"
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-[13px] font-bold leading-none tracking-tight transition",
              channelFilter === "walmart"
                ? "border-[#0071dc] bg-[#0071dc] text-white shadow-sm"
                : "border-rule bg-surface text-[#0071dc] hover:border-[#0071dc]/60"
            )}
          >
            <span className="text-[15px] leading-none text-[#ffc220]">✲</span>
            <span>Walmart</span>
          </button>

          {/* Divider */}
          <span className="mx-1 h-4 w-px shrink-0 bg-rule" aria-hidden />

          {/* "Все" — резетит ship-by фильтр; всегда показан, активен когда
              shipByFilter == null. */}
          <button
            type="button"
            onClick={() => setShipByFilter(null)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[12px] font-medium transition-colors",
              shipByFilter === null
                ? "border-rule-strong bg-bg-elev text-ink"
                : "border-rule bg-surface text-ink-2 hover:bg-bg-elev"
            )}
            aria-pressed={shipByFilter === null}
          >
            Все дни
          </button>
          {SHIP_BY_OPTIONS.map((opt) => {
            const count = shipByCounts[opt.id];
            const active = shipByFilter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() =>
                  setShipByFilter((prev) => (prev === opt.id ? null : opt.id))
                }
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium transition-colors",
                  active
                    ? opt.activeCls
                    : "border-rule bg-surface text-ink-2 hover:bg-bg-elev"
                )}
                aria-pressed={active}
              >
                {opt.label}
                {count > 0 && (
                  <span
                    className={cn(
                      "tabular text-[10.5px] font-semibold",
                      active ? "" : "text-ink-3"
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Row 3: Sort tabs */}
        <FilterTabs
          tabs={SORT_TABS}
          active={sort}
          onChange={setSort}
          className="mt-2"
        />
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-tint px-3 py-2 text-[13px] text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Не удалось загрузить</div>
            <div className="text-[12px] opacity-80">{error}</div>
          </div>
        </div>
      )}

      {loading && cards.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-rule bg-surface px-4 py-12 text-[13px] text-ink-3">
          <Loader2 size={16} className="animate-spin" />
          Загружаем список из Veeqo…
        </div>
      ) : !loading && cards.length === 0 && !error ? (
        <div className="rounded-lg border border-rule bg-surface px-4 py-12 text-center text-[13px] text-ink-3">
          Список пуст — всё закуплено
        </div>
      ) : (
        <ProcurementList
          cards={sortedCards}
          onAction={handleAction}
          prioritiesBySku={prioritiesBySku}
          selected={selected}
          onToggleSelect={toggleSelect}
          onPrioritiesSaved={(sku, storeNames) =>
            setPrioritiesBySku((prev) => ({ ...prev, [sku]: [...storeNames] }))
          }
          cancellationFlags={cancellationFlags}
          onCancelWalmartOrder={handleCancelWalmartOrder}
        />
      )}

      {/* Bulk action bar — appears when 1+ selected */}
      {(selected.size > 0 || bulkProgress) && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-surface px-4 py-3 shadow-[0_-8px_24px_-12px_rgba(21,32,27,0.18)]"
          style={{
            paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
          }}
        >
          <div className="mx-auto flex max-w-[820px] items-center gap-2">
            {bulkProgress ? (
              <>
                <Loader2
                  size={15}
                  className={cn(
                    "shrink-0",
                    bulkProgress.done < bulkProgress.total &&
                      "animate-spin text-green"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ink">
                    {bulkProgress.done < bulkProgress.total
                      ? `Сохранение… ${bulkProgress.done} из ${bulkProgress.total}`
                      : bulkProgress.errors === 0
                        ? `Готово — ${bulkProgress.total} отмечено`
                        : `${bulkProgress.total - bulkProgress.errors} отмечено, ${bulkProgress.errors} с ошибкой`}
                  </div>
                  {bulkProgress.errors > 0 && (
                    <div className="text-[11.5px] tabular text-danger">
                      Ошибки в Veeqo — обнови страницу и проверь, что
                      успело записаться
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <ShoppingCart size={15} className="shrink-0 text-ink-2" />
                <div className="min-w-0 flex-1 text-[13px] font-semibold text-ink">
                  Выбрано: {selected.size}{" "}
                  {selected.size === 1
                    ? "товар"
                    : selected.size < 5
                      ? "товара"
                      : "товаров"}
                </div>
                <Btn
                  variant="ghost"
                  size="md"
                  onClick={clearSelection}
                  icon={<X size={14} />}
                >
                  Снять
                </Btn>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={handleBulkBought}
                  icon={<Check size={14} />}
                >
                  Купил всё
                </Btn>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
