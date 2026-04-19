/**
 * KPI card — used on Dashboard / Shipping Labels / Adjustments / etc.
 * Supports a sparkline, trend, sub-text, chips, or progress bar in foot.
 */

import { cn } from "@/lib/utils";

interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  icon?: React.ReactNode;
  iconVariant?: "default" | "warn" | "danger";
  trend?: { value: string; positive?: boolean; subText?: string };
  chips?: Array<{ label: string; variant?: "frozen" | "dry" | "urgent" | "neutral" | "ok" }>;
  progress?: { value: number; total: number; spent?: string };
  sparkline?: number[];
  accent?: boolean;
  className?: string;
}

const CHIP_PALETTE: Record<NonNullable<KpiCardProps["chips"]>[number]["variant"] & string, { bg: string; color: string }> = {
  frozen: { bg: "var(--frozen-tint)", color: "var(--frozen)" },
  dry: { bg: "var(--dry-tint)", color: "var(--dry)" },
  urgent: { bg: "var(--warn-tint)", color: "var(--warn-strong)" },
  neutral: { bg: "var(--bg-elev)", color: "var(--ink-2)" },
  ok: { bg: "var(--green-soft)", color: "var(--green-ink)" },
};

const ICON_BG: Record<NonNullable<KpiCardProps["iconVariant"]>, { bg: string; color: string }> = {
  default: { bg: "var(--green-soft)", color: "var(--green-ink)" },
  warn: { bg: "var(--warn-tint)", color: "var(--warn)" },
  danger: { bg: "var(--danger-tint)", color: "var(--danger)" },
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const w = 200;
  const h = 30;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${i * stepX},${h - 3 - ((v - min) / range) * (h - 6)}`)
    .join(" ");
  const last = values[values.length - 1];
  const lastX = (values.length - 1) * stepX;
  const lastY = h - 3 - ((last - min) / range) * (h - 6);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="mt-3 h-7 w-full"
    >
      <polyline
        points={`${points} ${w},${h} 0,${h}`}
        fill="var(--green-soft)"
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke="var(--green)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="2.5" fill="var(--green)" />
    </svg>
  );
}

export function KpiCard({
  label,
  value,
  unit,
  icon,
  iconVariant = "default",
  trend,
  chips,
  progress,
  sparkline,
  accent,
  className,
}: KpiCardProps) {
  const iconPalette = ICON_BG[iconVariant];
  return (
    <div
      className={cn(
        "rounded-lg border border-rule p-4",
        accent ? "bg-green-soft" : "bg-surface",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-ink-3">
          {label}
        </div>
        {icon && (
          <div
            className="grid h-7 w-7 place-items-center rounded-md"
            style={{ background: iconPalette.bg, color: iconPalette.color }}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <div className="kpi-number">{value}</div>
        {unit && (
          <div className="text-[14px] font-medium text-ink-3 tabular">
            {unit}
          </div>
        )}
      </div>

      {sparkline && <Sparkline values={sparkline} />}

      {progress && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-elev">
            <div
              className="h-full rounded-full bg-green"
              style={{
                width: `${Math.min(
                  100,
                  Math.round((progress.value / Math.max(1, progress.total)) * 100)
                )}%`,
              }}
            />
          </div>
          {progress.spent && (
            <div className="mt-2 text-[11.5px] text-ink-3 tabular">
              {progress.spent}
            </div>
          )}
        </div>
      )}

      {trend && (
        <div className="mt-3 flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center text-[11.5px] font-medium tabular",
              trend.positive === false ? "text-warn" : "text-green"
            )}
          >
            {trend.positive === false ? "↓" : "↑"} {trend.value}
          </span>
          {trend.subText && (
            <span className="text-[11.5px] text-ink-3">{trend.subText}</span>
          )}
        </div>
      )}

      {chips && chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((c, i) => {
            const palette = CHIP_PALETTE[c.variant ?? "neutral"];
            return (
              <span
                key={i}
                className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium tabular"
                style={{ background: palette.bg, color: palette.color }}
              >
                {c.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
