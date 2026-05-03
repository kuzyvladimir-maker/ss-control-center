"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2, AlertCircle } from "lucide-react";
import { Btn, FilterTabs, PageHead, type FilterTab } from "@/components/kit";
import {
  ProcurementList,
  type ProcurementOrderCard,
} from "./components/ProcurementList";

type SortKey = "shipBy" | "title";

const SORT_TABS: FilterTab<SortKey>[] = [
  { id: "shipBy", label: "По срочности" },
  { id: "title", label: "По названию" },
];

export default function ProcurementPage() {
  const [cards, setCards] = useState<ProcurementOrderCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("shipBy");
  const [lastSync, setLastSync] = useState<Date | null>(null);

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
      setCards(data.cards ?? []);
      setLastSync(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  // Sort cards: by ship-by ascending (urgent first) OR by title alphabetically.
  // Cards with no ship-by sink to the bottom in the shipBy view.
  const sortedCards = useMemo(() => {
    const arr = [...cards];
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
  }, [cards, sort]);

  // Distinct order count — Vladimir compares this against Veeqo's "orders" count
  const orderCount = useMemo(() => {
    const ids = new Set(cards.map((c) => c.orderId));
    return ids.size;
  }, [cards]);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-12 pt-5 sm:px-6">
      <PageHead
        title="Procurement"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {orderCount} заказов
            </span>
            <span className="text-ink-4">·</span>
            <span>{cards.length} товаров</span>
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
        <ProcurementList cards={sortedCards} />
      )}
    </div>
  );
}
