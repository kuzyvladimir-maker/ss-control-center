/**
 * Reusable page header — title + subtitle + actions.
 * Subtitle slot accepts ReactNode so pages can drop in date / week chips.
 */

import { cn } from "@/lib/utils";

interface PageHeadProps {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  syncChip?: React.ReactNode;
}

export function PageHead({
  title,
  subtitle,
  actions,
  syncChip,
  className,
}: PageHeadProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-4 pb-4",
        className
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1
            className="font-semibold text-ink"
            style={{ fontSize: 26, letterSpacing: "-0.025em", lineHeight: 1.1 }}
          >
            {title}
          </h1>
          {syncChip}
        </div>
        {subtitle && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** Used as separator between subtitle bits. */
export function Sep() {
  return <span className="text-ink-4">·</span>;
}

/** Last-sync chip — green-soft pill with mono text. */
export function SyncChip({ when }: { when: string | Date | null | undefined }) {
  if (!when) return null;
  const date = typeof when === "string" ? new Date(when) : when;
  if (isNaN(date.getTime())) return null;
  const minsAgo = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  const label =
    minsAgo === 0
      ? "Synced just now"
      : minsAgo < 60
        ? `Synced ${minsAgo}m ago`
        : `Synced ${Math.round(minsAgo / 60)}h ago`;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-green-soft px-2 py-0.5 text-[11px] font-mono text-green-ink">
      <span className="live-dot" /> {label}
    </span>
  );
}
