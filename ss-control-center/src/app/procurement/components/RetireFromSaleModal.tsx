"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Search,
  Loader2,
  AlertCircle,
  Check,
  Ban,
  ExternalLink,
} from "lucide-react";
import { Btn } from "@/components/kit";
import { cleanProductQuery } from "@/lib/procurement/clean-product-query";

interface RetireFromSaleModalProps {
  /** Original procurement product title — used for the initial query and shown in header. */
  productTitle: string;
  /** Source order id (purchase order) — recorded on each audit row as triggeredFrom. */
  triggeredFromOrderId?: string | null;
  onClose: () => void;
}

interface SearchMatch {
  sku: string;
  itemId: string;
  title: string;
  lifecycleStatus: string;
  publishedStatus: string;
  alreadyRetired: boolean;
  retiredAt: string | null;
}

interface ExecuteResult {
  sku: string;
  ok: boolean;
  error?: string;
  walmartStatus?: number;
}

/**
 * "Снять с продажи" modal. Opens from the Procurement card ⋮ menu.
 *
 *   1. Auto-fills the search box with a cleaned version of the procurement
 *      title (Pack/size noise stripped) — Vladimir can edit before searching.
 *   2. Hits POST /api/walmart/retire-listing/search → reads the Walmart
 *      catalog mirror (sub-second).
 *   3. Lists every matching SKU with per-row "Снять" button and a footer
 *      "Снять все найденные" master button.
 *   4. Each Снять sets inventory=0 on Walmart and writes an audit row to
 *      WalmartListingRetirement.
 *
 * Already-retired SKUs (open WalmartListingRetirement rows) are shown
 * greyed-out with a "Уже снят" badge so the same SKU can't be re-zeroed
 * by mistake.
 */
export function RetireFromSaleModal({
  productTitle,
  triggeredFromOrderId,
  onClose,
}: RetireFromSaleModalProps) {
  const initialQuery = useMemo(
    () => cleanProductQuery(productTitle),
    [productTitle],
  );
  const [query, setQuery] = useState(initialQuery);
  const [reason, setReason] = useState("");
  const [includeUnpublished, setIncludeUnpublished] = useState(false);

  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);

  const [executing, setExecuting] = useState<Set<string>>(new Set());
  const [executeResults, setExecuteResults] = useState<Map<string, ExecuteResult>>(
    new Map(),
  );
  const [bulkConfirm, setBulkConfirm] = useState(false);

  // Auto-run the initial search so the modal opens with results already in
  // place — saves Vladimir a click when the cleaned query is what he wanted.
  useEffect(() => {
    void runSearch(initialQuery, includeUnpublished);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(q: string, includeUnp: boolean) {
    const cleaned = q.trim();
    if (!cleaned) {
      setSearchError("Введи название для поиска");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setMatches(null);
    setCacheNote(null);
    setExecuteResults(new Map());
    setBulkConfirm(false);
    try {
      const res = await fetch("/api/walmart/retire-listing/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: cleaned,
          limit: 100,
          includeUnpublished: includeUnp,
        }),
      });
      const data = (await res.json()) as {
        matches?: SearchMatch[];
        cacheLastSyncedAt?: string | null;
        totalInCache?: number;
        error?: string;
      };
      if (!res.ok) {
        setSearchError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setMatches(data.matches ?? []);
      if (data.cacheLastSyncedAt) {
        const synced = new Date(data.cacheLastSyncedAt);
        const ageHours = Math.round(
          (Date.now() - synced.getTime()) / (1000 * 60 * 60),
        );
        setCacheNote(
          `Каталог обновлён ${ageHours < 1 ? "недавно" : `~${ageHours} ч. назад`} (${data.totalInCache ?? "?"} SKU всего)`,
        );
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSearching(false);
    }
  }

  async function executeSkus(skus: string[]) {
    if (skus.length === 0) return;
    setExecuting((prev) => {
      const next = new Set(prev);
      for (const s of skus) next.add(s);
      return next;
    });
    try {
      const res = await fetch("/api/walmart/retire-listing/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skus,
          reason: reason.trim() || undefined,
          triggeredFrom: triggeredFromOrderId
            ? `procurement:${triggeredFromOrderId}`
            : undefined,
          searchQuery: query.trim(),
        }),
      });
      const data = (await res.json()) as {
        results?: ExecuteResult[];
        error?: string;
      };
      if (!res.ok) {
        // Mark every requested SKU as failed with the top-level error.
        setExecuteResults((prev) => {
          const next = new Map(prev);
          for (const s of skus) {
            next.set(s, { sku: s, ok: false, error: data.error ?? `HTTP ${res.status}` });
          }
          return next;
        });
        return;
      }
      setExecuteResults((prev) => {
        const next = new Map(prev);
        for (const r of data.results ?? []) next.set(r.sku, r);
        return next;
      });
      // Locally mark successful SKUs as already retired so the row greys out.
      setMatches((prev) =>
        prev
          ? prev.map((m) =>
              data.results?.find((r) => r.sku === m.sku && r.ok)
                ? { ...m, alreadyRetired: true, retiredAt: new Date().toISOString() }
                : m,
            )
          : prev,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error";
      setExecuteResults((prev) => {
        const next = new Map(prev);
        for (const s of skus) next.set(s, { sku: s, ok: false, error: msg });
        return next;
      });
    } finally {
      setExecuting((prev) => {
        const next = new Set(prev);
        for (const s of skus) next.delete(s);
        return next;
      });
      setBulkConfirm(false);
    }
  }

  const eligible = (matches ?? []).filter((m) => !m.alreadyRetired);
  const eligibleSkus = eligible.map((m) => m.sku);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl bg-surface ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Ban size={14} className="text-danger" />
              Снять с продажи на Walmart
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
              {productTitle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink"
            aria-label="Закрыть"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search controls */}
        <div className="border-b border-rule px-4 py-3">
          <label
            htmlFor="retire-query"
            className="text-[11px] font-medium text-ink-3"
          >
            Поиск в каталоге Walmart
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="retire-query"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runSearch(query, includeUnpublished);
                }
              }}
              placeholder="название товара…"
              className="h-9 flex-1 rounded-md border border-rule bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-silver-line"
            />
            <Btn
              variant="default"
              size="sm"
              loading={searching}
              icon={<Search size={13} />}
              onClick={() => runSearch(query, includeUnpublished)}
            >
              Найти
            </Btn>
          </div>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-3">
            <input
              type="checkbox"
              checked={includeUnpublished}
              onChange={(e) => setIncludeUnpublished(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-rule"
            />
            Включать также UNPUBLISHED
          </label>
          {cacheNote && (
            <div className="mt-1 text-[10.5px] text-ink-4">{cacheNote}</div>
          )}
        </div>

        {/* Results */}
        <div className="min-h-[120px] flex-1 overflow-y-auto px-4 py-3">
          {searching && (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
              <Loader2 size={14} className="animate-spin" /> Ищу в каталоге…
            </div>
          )}
          {searchError && (
            <div className="inline-flex items-start gap-1.5 rounded-md bg-danger-tint px-2 py-1.5 text-[12px] text-danger">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{searchError}</span>
            </div>
          )}
          {!searching && matches !== null && matches.length === 0 && (
            <div className="text-[12.5px] text-ink-3">
              Ничего не найдено. Попробуй сократить запрос или включить
              UNPUBLISHED.
            </div>
          )}
          {matches !== null && matches.length > 0 && (
            <>
              <div className="mb-2 flex items-baseline justify-between text-[11.5px] text-ink-3">
                <span>
                  Найдено: <span className="font-medium text-ink">{matches.length}</span>{" "}
                  {eligible.length < matches.length && (
                    <span className="text-ink-4">
                      (из них {eligible.length} ещё не снято)
                    </span>
                  )}
                </span>
              </div>
              <div className="divide-y divide-rule/60 rounded-md border border-rule/60">
                {matches.map((m) => {
                  const isBusy = executing.has(m.sku);
                  const result = executeResults.get(m.sku);
                  const justDone = result?.ok === true;
                  const justFailed = result && result.ok === false;
                  return (
                    <div
                      key={m.sku}
                      className={`flex items-start gap-2 px-2.5 py-2 ${
                        m.alreadyRetired && !justDone ? "opacity-55" : ""
                      } ${justDone ? "bg-green-soft/40" : ""}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                          <span className="truncate">{m.title || "(без названия)"}</span>
                          {m.itemId && (
                            <a
                              href={`https://www.walmart.com/ip/${m.itemId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-ink-4 hover:text-ink-2"
                              title="Открыть на Walmart.com"
                            >
                              <ExternalLink size={11} />
                            </a>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] tabular text-ink-3">
                          <span>SKU: {m.sku}</span>
                          <span className="text-ink-4">·</span>
                          <span>{m.publishedStatus}</span>
                          {m.lifecycleStatus && (
                            <>
                              <span className="text-ink-4">·</span>
                              <span>{m.lifecycleStatus}</span>
                            </>
                          )}
                          {(m.alreadyRetired || justDone) && (
                            <>
                              <span className="text-ink-4">·</span>
                              <span className="font-medium text-green-ink">
                                Снят
                                {m.retiredAt
                                  ? ` ${new Date(m.retiredAt).toLocaleDateString("ru-RU")}`
                                  : ""}
                              </span>
                            </>
                          )}
                          {justFailed && result?.error && (
                            <>
                              <span className="text-ink-4">·</span>
                              <span className="text-danger">{result.error}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <Btn
                        variant={justDone ? "ghost" : "default"}
                        size="sm"
                        loading={isBusy}
                        disabled={m.alreadyRetired || justDone || isBusy}
                        icon={justDone ? <Check size={12} /> : <Ban size={12} />}
                        onClick={() => executeSkus([m.sku])}
                      >
                        {justDone ? "Снят" : "Снять"}
                      </Btn>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer: reason + bulk action */}
        <div className="border-t border-rule px-4 py-3">
          <label
            htmlFor="retire-reason"
            className="text-[11px] font-medium text-ink-3"
          >
            Причина (опционально, сохранится в логе)
          </label>
          <input
            id="retire-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="напр. поставщик прекратил поставки"
            className="mt-1 h-9 w-full rounded-md border border-rule bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-silver-line"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Btn variant="ghost" size="sm" onClick={onClose}>
              Закрыть
            </Btn>
            {eligibleSkus.length > 1 &&
              (bulkConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-warn-strong">
                    Снять все {eligibleSkus.length} SKU?
                  </span>
                  <Btn
                    variant="ghost"
                    size="sm"
                    onClick={() => setBulkConfirm(false)}
                  >
                    Отмена
                  </Btn>
                  <Btn
                    variant="primary"
                    size="sm"
                    loading={executing.size > 0}
                    icon={<Ban size={12} />}
                    onClick={() => executeSkus(eligibleSkus)}
                  >
                    Да, снять все
                  </Btn>
                </div>
              ) : (
                <Btn
                  variant="default"
                  size="sm"
                  disabled={executing.size > 0}
                  icon={<Ban size={12} />}
                  onClick={() => setBulkConfirm(true)}
                >
                  Снять все найденные ({eligibleSkus.length})
                </Btn>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
