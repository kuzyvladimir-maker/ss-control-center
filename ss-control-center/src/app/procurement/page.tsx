"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2, AlertCircle, Search, X } from "lucide-react";
import { Btn, FilterTabs, PageHead, type FilterTab } from "@/components/kit";
import {
  ProcurementList,
  type ProcurementOrderCard,
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
  const [search, setSearch] = useState("");

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

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

  // Filter by search query first (case-insensitive substring across
  // title / SKU / order number / customer), then sort.
  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) => {
      return (
        c.productTitle.toLowerCase().includes(q) ||
        c.sku.toLowerCase().includes(q) ||
        c.orderNumber.toLowerCase().includes(q) ||
        (c.customerName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [cards, search]);

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

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-12 pt-5 sm:px-6">
      <PageHead
        title="Procurement"
        subtitle={
          <>
            {search ? (
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
        actions={
          <Btn
            variant="default"
            size="md"
            onClick={load}
            loading={loading}
            icon={!loading && <RefreshCw size={13} />}
          >
            Обновить
          </Btn>
        }
      />

      {/* Search */}
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
        <Search size={15} className="text-ink-3" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск: товар, SKU, номер заказа, клиент…"
          className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <FilterTabs
        tabs={SORT_TABS}
        active={sort}
        onChange={setSort}
        className="mb-3"
      />

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
        />
      )}
    </div>
  );
}
