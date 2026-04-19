/**
 * Risk / priority pill — LOW / MEDIUM / HIGH / CRITICAL.
 *
 * Used on Customer Hub messages, A-to-Z claims, Frozen SKU risk,
 * and Account Health. Visual: coloured dot prefix + capitalized label.
 */

import { cn } from "@/lib/utils";

type RiskLevel = "low" | "medium" | "high" | "critical";

const PALETTE: Record<RiskLevel, { bg: string; color: string; dot: string }> = {
  low:      { bg: "var(--green-soft)",  color: "var(--green-ink)",   dot: "var(--green)" },
  medium:   { bg: "var(--silver-tint)", color: "var(--silver-dark)", dot: "var(--silver-dark)" },
  high:     { bg: "var(--warn-tint)",   color: "var(--warn-strong)", dot: "var(--warn)" },
  critical: { bg: "var(--danger-tint)", color: "var(--danger)",      dot: "var(--danger)" },
};

export function RiskPill({
  level,
  children,
  className,
  uppercase,
}: {
  level: RiskLevel | string | null | undefined;
  children?: React.ReactNode;
  className?: string;
  uppercase?: boolean;
}) {
  if (!level) return null;
  const key = String(level).toLowerCase() as RiskLevel;
  const p = PALETTE[key] ?? PALETTE.medium;
  const label = children ?? String(level);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium tabular",
        uppercase && "uppercase tracking-wider",
        className
      )}
      style={{ background: p.bg, color: p.color }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: p.dot }}
      />
      {label}
    </span>
  );
}
