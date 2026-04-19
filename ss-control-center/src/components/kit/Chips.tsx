/**
 * Salutem chip primitives — TypeTag, StatusChip, CarrierBadge.
 * All visual conventions sourced from design/DESIGN_TOKENS.md §8-10.
 */

import { cn } from "@/lib/utils";

interface ChipBaseProps {
  children: React.ReactNode;
  className?: string;
}

/* ── Frozen / Dry product type tag ───────────────────────────────── */

export function TypeTag({
  type,
  className,
}: {
  type: "Frozen" | "Dry" | string | null | undefined;
  className?: string;
}) {
  if (!type) return null;
  const isFrozen = /frozen/i.test(type);
  const isDry = /dry/i.test(type);
  const palette = isFrozen
    ? { bg: "var(--frozen-tint)", color: "var(--frozen)" }
    : isDry
      ? { bg: "var(--dry-tint)", color: "var(--dry)" }
      : { bg: "var(--bg-elev)", color: "var(--ink-2)" };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        className
      )}
      style={palette}
    >
      <span
        className="inline-block h-1 w-1 rounded-full"
        style={{ background: palette.color }}
      />
      {type}
    </span>
  );
}

/* ── Status chip (Ready / Pending / Hold / Bought / Delivered …) ─── */

type StatusVariant =
  | "ready"
  | "bought"
  | "pending"
  | "hold"
  | "exception"
  | "delivered"
  | "ok"
  | "warn"
  | "danger"
  | "neutral";

const STATUS_PALETTE: Record<StatusVariant, { bg: string; color: string; weight?: number }> = {
  ready:     { bg: "var(--green-soft)", color: "var(--green-ink)" },
  bought:    { bg: "var(--green-soft2)", color: "var(--green-ink)" },
  delivered: { bg: "var(--green-soft)", color: "var(--green-ink)" },
  ok:        { bg: "var(--green-soft)", color: "var(--green-ink)" },
  pending:   { bg: "var(--silver-tint)", color: "var(--silver-dark)" },
  neutral:   { bg: "var(--bg-elev)", color: "var(--ink-2)" },
  hold:      { bg: "var(--warn-tint)", color: "var(--warn)" },
  warn:      { bg: "var(--warn-tint)", color: "var(--warn)" },
  exception: { bg: "var(--warn-tint)", color: "var(--warn-strong)", weight: 600 },
  danger:    { bg: "var(--danger-tint)", color: "var(--danger)" },
};

export function StatusChip({
  variant = "neutral",
  children,
  className,
}: {
  variant?: StatusVariant;
} & ChipBaseProps) {
  const p = STATUS_PALETTE[variant];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] tabular",
        className
      )}
      style={{ background: p.bg, color: p.color, fontWeight: p.weight ?? 500 }}
    >
      {children}
    </span>
  );
}

/** Map a free-form status string to StatusChip variant. */
export function statusVariantFor(status: string | null | undefined): StatusVariant {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (/ready|approved|done/.test(s)) return "ready";
  if (/bought|purchased/.test(s)) return "bought";
  if (/delivered|completed/.test(s)) return "delivered";
  if (/pending|created|new|analyzed/.test(s)) return "pending";
  if (/hold|stop|paused/.test(s)) return "hold";
  if (/exception|critical|failed|error/.test(s)) return "exception";
  if (/cancel|refund|denied|lost/.test(s)) return "danger";
  return "neutral";
}

/* ── Carrier badge (UPS / FedEx / USPS) ──────────────────────────── */

const CARRIER_PALETTE: Record<string, { bg: string; color: string }> = {
  UPS: { bg: "#4C2C0E", color: "#FFB500" },
  FEDEX: { bg: "#4D148C", color: "#FFFFFF" },
  USPS: { bg: "#004B87", color: "#FFFFFF" },
  DHL: { bg: "#FFCC00", color: "#D40511" },
};

export function CarrierBadge({
  carrier,
  className,
}: {
  carrier: string | null | undefined;
  className?: string;
}) {
  if (!carrier) return null;
  const key = carrier.toUpperCase().replace(/[^A-Z]/g, "");
  const p = CARRIER_PALETTE[key];
  if (!p) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider",
          className
        )}
        style={{ background: "var(--bg-elev)", color: "var(--ink-2)" }}
      >
        {carrier}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold",
        className
      )}
      style={{ background: p.bg, color: p.color }}
    >
      {key}
    </span>
  );
}
