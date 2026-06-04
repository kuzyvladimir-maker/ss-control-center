"use client";

import { Input } from "@/components/ui/input";

export type WeightUnit = "lbs" | "oz";

interface WeightInputProps {
  /** Raw string in the CURRENT unit (not pre-converted to lbs). */
  value: string;
  onChange: (next: string) => void;
  unit: WeightUnit;
  onUnitChange: (next: WeightUnit) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Weight input with an inline lbs/oz unit toggle.
 *
 * Toggling the unit DOES NOT auto-convert the typed value — only the label
 * changes. That keeps an accidental click from silently inflating the
 * stored weight by 16×. The owning dialog is responsible for converting
 * to lbs at save time (`unit === "oz" ? n / 16 : n`).
 *
 * Reusable across the three places that capture package weight:
 *   - PackingProfileDialog  (per-composition multi-item packing)
 *   - AddSkuToDatabaseDialog (new SKU entry)
 *   - EditPackageDialog      (per-shipment override)
 */
export function WeightInput({
  value,
  onChange,
  unit,
  onUnitChange,
  placeholder,
  disabled,
}: WeightInputProps) {
  return (
    <div className="flex items-stretch gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? (unit === "lbs" ? "2.5" : "40")}
        disabled={disabled}
        className="flex-1"
        inputMode="decimal"
      />
      <div className="flex shrink-0 overflow-hidden rounded border border-rule text-[10.5px] font-medium">
        {(["lbs", "oz"] as const).map((u) => (
          <button
            key={u}
            type="button"
            disabled={disabled}
            onClick={() => onUnitChange(u)}
            className={
              unit === u
                ? "bg-ink px-2 text-surface"
                : "bg-surface px-2 text-ink-3 hover:bg-bg-elev"
            }
            aria-pressed={unit === u}
          >
            {u}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Convert a weight value in the given unit to pounds (the canonical
 *  storage/transport unit on the backend). Returns NaN if not finite. */
export function toLbs(value: string | number, unit: WeightUnit): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return NaN;
  return unit === "oz" ? n / 16 : n;
}
