"use client";

import { useEffect, useState } from "react";
import {
  X,
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Btn } from "@/components/kit";
import { STORE_OPTIONS } from "@/lib/procurement/store-list";

interface PriorityEntry {
  storeName: string;
  priority: number;
}

interface StorePriorityPopupProps {
  sku: string;
  productTitle: string;
  onClose: () => void;
  /** Called after a successful save with the new ordered list of stores. */
  onSaved?: (sku: string, storeNames: ReadonlyArray<string>) => void;
}

/**
 * Modal for editing the ordered list of stores Vladimir buys a SKU from.
 *
 * Reorder via ↑/↓ buttons (mobile-friendlier than drag handles).
 * "Add store" pulls from a fixed dropdown of recognised stores so names
 * stay consistent across SKUs. Saves replace the full list in one PUT.
 */
export function StorePriorityPopup({
  sku,
  productTitle,
  onClose,
  onSaved,
}: StorePriorityPopupProps) {
  const [list, setList] = useState<PriorityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(true);
  const [addingStore, setAddingStore] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/procurement/sku-stores/${encodeURIComponent(sku)}`
        );
        const data = (await res.json()) as {
          priorities?: PriorityEntry[];
          dbReady?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setList(data.priorities ?? []);
        setDbReady(data.dbReady !== false);
      } catch (e: unknown) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sku]);

  // Body scroll lock while modal open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const move = (idx: number, dir: -1 | 1) => {
    const next = idx + dir;
    if (next < 0 || next >= list.length) return;
    const arr = [...list];
    [arr[idx]!, arr[next]!] = [arr[next]!, arr[idx]!];
    // Renumber priorities by position
    setList(arr.map((e, i) => ({ ...e, priority: i + 1 })));
  };

  const remove = (idx: number) => {
    setList((prev) =>
      prev
        .filter((_, i) => i !== idx)
        .map((e, i) => ({ ...e, priority: i + 1 }))
    );
  };

  const addStore = () => {
    if (!addingStore) return;
    const name = addingStore;
    if (list.some((e) => e.storeName.toLowerCase() === name.toLowerCase())) {
      setAddingStore("");
      return;
    }
    setList((prev) => [
      ...prev,
      { storeName: name, priority: prev.length + 1 },
    ]);
    setAddingStore("");
  };

  const save = async () => {
    // If Vladimir picked a store from the dropdown but forgot to click
    // "Добавить", treat Save as if Add+Save: include that store as the next
    // priority. Without this people lose their selection on save.
    let toSave = list;
    if (
      addingStore &&
      !list.some(
        (e) => e.storeName.toLowerCase() === addingStore.toLowerCase()
      )
    ) {
      toSave = [
        ...list,
        { storeName: addingStore, priority: list.length + 1 },
      ];
      setList(toSave);
      setAddingStore("");
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/procurement/sku-stores/${encodeURIComponent(sku)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priorities: toSave }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        dbReady?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        if (data.dbReady === false) setDbReady(false);
        return;
      }
      onSaved?.(
        sku,
        toSave.map((e) => e.storeName)
      );
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const availableToAdd = STORE_OPTIONS.filter(
    (s) => !list.some((e) => e.storeName.toLowerCase() === s.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-[440px] overflow-hidden rounded-xl bg-surface ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink">
              Где покупать
            </div>
            <div className="mt-0.5 text-[11.5px] tabular text-ink-3">
              SKU {sku}
            </div>
            <div className="mt-1 truncate text-[12px] text-ink-2">
              {productTitle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink md:h-7 md:w-7"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
              <Loader2 size={14} className="animate-spin" /> Загружаем…
            </div>
          ) : (
            <>
              {!dbReady && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-warn-tint px-2.5 py-2 text-[12px] text-warn-strong">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">
                      База данных ещё не мигрирована
                    </div>
                    <div className="mt-0.5 text-[11px] opacity-90">
                      Чтобы включить эту функцию, нужно один раз запустить{" "}
                      <code className="rounded bg-warn-tint/60 px-1 font-mono">
                        npx prisma db push
                      </code>{" "}
                      против Turso. Сохранение пока не сработает.
                    </div>
                  </div>
                </div>
              )}

              {list.length === 0 ? (
                <div className="rounded-md border border-dashed border-rule px-3 py-4 text-center text-[12.5px] text-ink-3">
                  Магазинов пока не выбрано — добавь первый ниже.
                </div>
              ) : (
                <ul className="divide-y divide-rule">
                  {list.map((entry, idx) => (
                    <li
                      key={entry.storeName}
                      className="flex items-center gap-2 py-2"
                    >
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-green-soft text-[11px] font-mono font-semibold tabular text-green-ink">
                        {idx + 1}
                      </span>
                      <span className="flex-1 truncate text-[13px] font-medium text-ink">
                        {entry.storeName}
                      </span>
                      <button
                        type="button"
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink disabled:opacity-30 md:h-7 md:w-7"
                        aria-label="Move up"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(idx, 1)}
                        disabled={idx === list.length - 1}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-bg-elev hover:text-ink disabled:opacity-30 md:h-7 md:w-7"
                        aria-label="Move down"
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(idx)}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-danger-tint hover:text-danger md:h-7 md:w-7"
                        aria-label="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add store */}
              {availableToAdd.length > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={addingStore}
                    onChange={(e) => setAddingStore(e.target.value)}
                    className="h-9 flex-1 rounded-md border border-rule bg-surface px-2 text-[13px] text-ink outline-none focus:border-silver-line"
                  >
                    <option value="">+ Добавить магазин</option>
                    {availableToAdd.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <Btn
                    variant="default"
                    size="md"
                    icon={<Plus size={13} />}
                    disabled={!addingStore}
                    onClick={addStore}
                  >
                    Добавить
                  </Btn>
                </div>
              )}

              {error && (
                <div className="mt-3 inline-flex items-start gap-1.5 rounded-md bg-danger-tint px-2.5 py-1.5 text-[12px] text-danger">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-rule bg-surface-tint px-4 py-3">
          <Btn variant="ghost" size="md" disabled={saving} onClick={onClose}>
            Отмена
          </Btn>
          <Btn
            variant="primary"
            size="md"
            loading={saving}
            disabled={loading}
            onClick={save}
          >
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
