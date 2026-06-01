"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
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
  onSelect: (label: string, dims: { length: number; width: number; height: number }) => void;
  /** Optional className for the outer wrapper. */
  className?: string;
}

/**
 * Editable list of box-size presets. Replaces the hardcoded `<select>` that
 * used to live inline in PackingProfileDialog / SkuDataDialog.
 *
 * UX:
 *   • Fetches all presets from /api/shipping/box-presets on mount.
 *   • Renders each as a clickable chip. Builtins (XS..XL etc) get no delete
 *     handle; custom rows added by the operator show an × that removes them.
 *   • Below the chip row, three inline number inputs (L × W × H) let the
 *     operator type a brand-new size; clicking "Add" POSTs it as a new
 *     preset AND selects it. So a size used once is available next time
 *     without the extra step.
 */
export function BoxPresetPicker({
  value,
  onSelect,
  className,
}: BoxPresetPickerProps) {
  const [presets, setPresets] = useState<BoxPreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addL, setAddL] = useState("");
  const [addW, setAddW] = useState("");
  const [addH, setAddH] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  async function addCustom() {
    setAddError(null);
    const L = Number(addL);
    const W = Number(addW);
    const H = Number(addH);
    if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) {
      setAddError("L, W, H must be positive numbers");
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
      // Refresh list (cheap) so the new chip appears in the row.
      await refresh();
      // Auto-select the newly-added preset so the operator doesn't need
      // to click it after typing.
      onSelect(preset.label, { length: preset.length, width: preset.width, height: preset.height });
      setAddL("");
      setAddW("");
      setAddH("");
    } finally {
      setAdding(false);
    }
  }

  async function deletePreset(p: BoxPreset) {
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

  return (
    <div className={cn("space-y-2", className)}>
      {loadError && (
        <div className="rounded border border-danger/30 bg-danger-tint px-2 py-1 text-[11.5px] text-danger">
          {loadError}
        </div>
      )}
      {!presets && !loadError && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
          <Loader2 size={11} className="animate-spin" /> Загружаем пресеты…
        </div>
      )}
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const isSelected = p.label === value;
            const isDeleting = deletingId === p.id;
            return (
              <span
                key={p.id}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[11.5px] transition",
                  isSelected
                    ? "border-ink bg-ink text-surface"
                    : "border-rule bg-surface text-ink-2 hover:border-ink-3 hover:text-ink",
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    onSelect(p.label, { length: p.length, width: p.width, height: p.height })
                  }
                  title={`${p.length} × ${p.width} × ${p.height} in`}
                  className="font-medium tabular"
                >
                  {p.label}
                </button>
                {!p.builtin && (
                  <button
                    type="button"
                    onClick={() => deletePreset(p)}
                    disabled={isDeleting}
                    title="Удалить пресет"
                    className={cn(
                      "ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full transition",
                      isSelected
                        ? "text-surface/70 hover:bg-surface/15 hover:text-surface"
                        : "text-ink-4 hover:bg-danger-tint hover:text-danger",
                    )}
                  >
                    {isDeleting ? <Loader2 size={9} className="animate-spin" /> : <X size={10} />}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {/* Custom dimensions input. Adding any "L x W x H" pushes it into the
          preset list (deduped on the unique label) and auto-selects it. */}
      <div className="flex flex-wrap items-end gap-1.5 rounded-md border border-dashed border-rule bg-surface-tint px-2 py-1.5">
        <div className="text-[10.5px] uppercase tracking-wide text-ink-3">
          Свой размер
        </div>
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
          className="inline-flex h-7 items-center gap-1 rounded border border-rule bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-50"
        >
          {adding ? <Loader2 size={10} className="animate-spin" /> : <Plus size={11} />}
          {adding ? "Добавляю…" : "Добавить"}
        </button>
        {addError && (
          <div className="w-full text-[11px] text-danger">{addError}</div>
        )}
      </div>
    </div>
  );
}
