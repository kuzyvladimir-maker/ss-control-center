"use client";

/**
 * Выбор периода «с даты — по дату» с быстрыми пресетами. Общий для сводки
 * споров и реестра на /adjustments. Даты — YYYY-MM-DD в America/New_York,
 * пустая граница = без ограничения.
 */
import { cn } from "@/lib/utils";

export interface Period {
  from: string;
  to: string;
  /** id пресета, если период выбран кнопкой; "custom" — даты введены руками */
  preset: PresetId;
}

export type PresetId = "7d" | "30d" | "month" | "prevMonth" | "all" | "custom";

const PRESETS: Array<{ id: Exclude<PresetId, "custom">; label: string }> = [
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "month", label: "Этот месяц" },
  { id: "prevMonth", label: "Прошлый месяц" },
  { id: "all", label: "Всё время" },
];

/** Сегодня в ET как YYYY-MM-DD. */
export function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function shift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function presetPeriod(id: Exclude<PresetId, "custom">): Period {
  const today = todayET();
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (id) {
    case "7d":
      return { from: shift(today, -6), to: today, preset: id };
    case "30d":
      return { from: shift(today, -29), to: today, preset: id };
    case "month":
      return { from: `${y}-${pad(m)}-01`, to: today, preset: id };
    case "prevMonth": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const last = shift(`${y}-${pad(m)}-01`, -1);
      return { from: `${py}-${pad(pm)}-01`, to: last, preset: id };
    }
    case "all":
      return { from: "", to: "", preset: id };
  }
}

/** 2026-10-01 → 01.10.2026 */
export function ruDay(day: string | null | undefined): string {
  if (!day) return "—";
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function presetLabel(id: PresetId): string {
  return id === "custom" ? "свой период" : (PRESETS.find((p) => p.id === id)?.label.toLowerCase() ?? id);
}

export default function PeriodPicker({
  value,
  onChange,
  className,
}: {
  value: Period;
  onChange: (p: Period) => void;
  className?: string;
}) {
  const input =
    "rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink tabular [color-scheme:light] dark:[color-scheme:dark]";
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-rule bg-surface p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(presetPeriod(p.id))}
            className={cn(
              "rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
              value.preset === p.id
                ? "bg-green-soft text-green-ink"
                : "text-ink-2 hover:bg-bg-elev hover:text-ink"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-[12px] text-ink-3">
        с
        <input
          type="date"
          className={input}
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => onChange({ ...value, from: e.target.value, preset: "custom" })}
        />
      </label>
      <label className="flex items-center gap-1 text-[12px] text-ink-3">
        по
        <input
          type="date"
          className={input}
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ ...value, to: e.target.value, preset: "custom" })}
        />
      </label>
    </div>
  );
}
