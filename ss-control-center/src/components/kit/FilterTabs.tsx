/**
 * Filter tab strip — used on Shipping Labels, Adjustments, etc.
 * Tabs render counts in pills next to the label.
 */

import { cn } from "@/lib/utils";

export interface FilterTab<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface FilterTabsProps<T extends string> {
  tabs: FilterTab<T>[];
  active: T;
  onChange: (id: T) => void;
  rightSlot?: React.ReactNode;
  className?: string;
}

export function FilterTabs<T extends string>({
  tabs,
  active,
  onChange,
  rightSlot,
  className,
}: FilterTabsProps<T>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-1">
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
                isActive
                  ? "bg-green-soft text-green-ink"
                  : "text-ink-2 hover:bg-bg-elev hover:text-ink"
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span
                  className={cn(
                    "inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular",
                    isActive
                      ? "bg-green text-green-cream"
                      : "bg-bg-elev text-ink-3"
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {rightSlot && (
        <>
          <div className="flex-1" />
          <div className="flex items-center gap-2">{rightSlot}</div>
        </>
      )}
    </div>
  );
}
