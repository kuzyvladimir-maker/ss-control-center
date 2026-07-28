"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BoxPreset {
  id: string;
  label: string;
  length: number;
  width: number;
  height: number;
  builtin: boolean;
}

interface BoxPresetPickerProps {
  /** Currently selected label (label string OR canonical "LxWxH" form). */
  value: string;
  /** Called on pick OR on successful custom-add. Receives the canonical
   *  label string + the dimensions. The caller decides whether to use the
   *  label (PackingProfile.boxSize stores the string) or the dimensions
   *  (SkuShippingData stores L/W/H separately). */
  onSelect: (
    label: string,
    dims: { length: number; width: number; height: number },
  ) => void;
  /** Optional className for the outer wrapper. */
  className?: string;
}

/**
 * Editable box-size dropdown. Closed state shows the currently selected
 * preset; opens to a list where every row has the dimensions next to the
 * label and — for non-builtin rows — a × delete button. The list ends
 * with a "Свой размер L × W × H" mini-form that POSTs a new preset and
 * auto-selects it.
 *
 * Replaces the previously-hardcoded <select> on PackingProfileDialog /
 * SkuDataDialog / EditPackageDialog.
 */
export function BoxPresetPicker({
  value,
  onSelect,
  className,
}: BoxPresetPickerProps) {
  const [presets, setPresets] = useState<BoxPreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [addL, setAddL] = useState("");
  const [addW, setAddW] = useState("");
  const [addH, setAddH] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const r = await fetch("/api/shipping/box-presets");
      const j = await r.json();
      if (!r.ok) {
        setLoadError(j?.error || `HTTP ${r.status}`);
        return;
      }
      setPresets(j.presets ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Network error");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Close on outside click / Escape (standard dropdown behaviour).
  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function addCustom() {
    setAddError(null);
    const L = Number(addL);
    const W = Number(addW);
    const H = Number(addH);
    if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) {
      setAddError("L, W, H должны быть положительными числами");
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/api/shipping/box-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ length: L, width: W, height: H }),
      });
      const j = await r.json();
      if (!r.ok) {
        setAddError(j?.error || `HTTP ${r.status}`);
        return;
      }
      const preset = j.preset as BoxPreset;
      await refresh();
      onSelect(preset.label, {
        length: preset.length,
        width: preset.width,
        height: preset.height,
      });
      setAddL("");
      setAddW("");
      setAddH("");
      setOpen(false);
    } finally {
      setAdding(false);
    }
  }

  async function deletePreset(e: React.MouseEvent, p: BoxPreset) {
    e.stopPropagation();
    if (p.builtin) return;
    if (!confirm(`Удалить пресет «${p.label}»?`)) return;
    setDeletingId(p.id);
    try {
      const r = await fetch(`/api/shipping/box-presets/${p.id}`, {
        method: "DELETE",
      });
      if (r.ok) {
        await refresh();
      }
    } finally {
      setDeletingId(null);
    }
  }

  const selected = presets?.find((p) => p.label === value);

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      {/* Closed-state trigger — looks like a select. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between rounded border border-rule bg-surface px-2 py-1.5 text-left text-[12.5px] text-ink transition hover:border-ink-3",
          open && "border-ink-3",
        )}
      >
        <span className="truncate">
          {selected ? (
            <>
              <span className="font-medium">{selected.label}</span>
              <span className="ml-1.5 text-[11px] text-ink-3">
                ({selected.length} × {selected.width} × {selected.height} in)
              </span>
            </>
          ) : value ? (
            <span className="font-medium">{value}</span>
          ) : (
            <span className="text-ink-3">Выбери размер…</span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-ink-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Open-state menu */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[320px] overflow-y-auto rounded-md border border-rule bg-surface py-1 shadow-lg ring-1 ring-foreground/5">
          {loadError && (
            <div className="px-2 py-1.5 text-[11.5px] text-danger">{loadError}</div>
          )}
          {!presets && !loadError && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11.5px] text-ink-3">
              <Loader2 size={11} className="animate-spin" /> Загружаем пресеты…
            </div>
          )}
          {presets && presets.length === 0 && (
            <div className="px-2 py-1.5 text-[11.5px] text-ink-3">
              Нет пресетов. Добавь свой ниже.
            </div>
          )}
          {presets &&
            presets.map((p) => {
              const isSelected = p.label === value;
              const isDeleting = deletingId === p.id;
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSelect(p.label, {
                      length: p.length,
                      width: p.width,
                      height: p.height,
                    });
                    setOpen(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[12.5px] transition",
                    isSelected
                      ? "bg-ink/10 text-ink"
                      : "text-ink-2 hover:bg-bg-elev hover:text-ink",
                  )}
                >
                  <span className="min-w-[40px] font-medium tabular">{p.label}</span>
                  <span className="flex-1 text-[11px] tabular text-ink-3">
                    {p.length} × {p.width} × {p.height} in
                  </span>
                  {p.builtin ? (
                    <span className="text-[10px] uppercase tracking-wide text-ink-4">
                      builtin
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => deletePreset(e, p)}
                      disabled={isDeleting}
                      title="Удалить пресет"
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-4 hover:bg-danger-tint hover:text-danger"
                    >
                      {isDeleting ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <X size={11} />
                      )}
                    </button>
                  )}
                </div>
              );
            })}

          {/* "Свой размер" — POSTs a new preset and auto-selects it. */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-1 border-t border-rule/60 px-2 py-2"
          >
            <div className="mb-1 text-[10.5px] uppercase tracking-wide text-ink-3">
              Свой размер
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                value={addL}
                onChange={(e) => setAddL(e.target.value)}
                placeholder="L"
                className="h-7 w-14 rounded border border-rule bg-surface px-1.5 text-center text-[12px] tabular outline-none focus:border-ink-3"
              />
              <span className="text-[11px] text-ink-4">×</span>
              <input
                type="number"
                inputMode="decimal"
                value={addW}
                onChange={(e) => setAddW(e.target.value)}
                placeholder="W"
                className="h-7 w-14 rounded border border-rule bg-surface px-1.5 text-center text-[12px] tabular outline-none focus:border-ink-3"
              />
              <span className="text-[11px] text-ink-4">×</span>
              <input
                type="number"
                inputMode="decimal"
                value={addH}
                onChange={(e) => setAddH(e.target.value)}
                placeholder="H"
                className="h-7 w-14 rounded border border-rule bg-surface px-1.5 text-center text-[12px] tabular outline-none focus:border-ink-3"
              />
              <button
                type="button"
                onClick={addCustom}
                disabled={adding}
                className="ml-auto inline-flex h-7 items-center gap-1 rounded border border-rule bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-50"
              >
                {adding ? <Loader2 size={10} className="animate-spin" /> : <Plus size={11} />}
                {adding ? "Добавляю…" : "Добавить"}
              </button>
            </div>
            {addError && (
              <div className="mt-1 text-[11px] text-danger">{addError}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
