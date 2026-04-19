/**
 * Salutem card primitives — different from shadcn/ui Card.
 *
 * Use these for module surfaces. Lighter, hairline-only, designed to
 * sit on the cool off-white page background. shadcn Card still works
 * for legacy code paths.
 */

import { cn } from "@/lib/utils";

export function Panel({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-rule bg-surface",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  count,
  right,
  className,
}: {
  title: React.ReactNode;
  count?: number | string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-rule px-4 py-3",
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="text-[14px] font-semibold text-ink truncate">{title}</div>
        {count !== undefined && (
          <span className="text-[11.5px] tabular text-ink-3">
            {typeof count === "number" ? count : count}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}

export function PanelBody({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-4", className)} {...rest}>
      {children}
    </div>
  );
}
