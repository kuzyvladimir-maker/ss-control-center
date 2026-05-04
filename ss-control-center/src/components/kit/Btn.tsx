/**
 * Salutem buttons — small, dense, branded.
 *
 * Variants:
 *   default — surface-tint background, ink text
 *   primary — green background, cream text
 *   ghost   — transparent, ink text
 *   danger  — danger background
 *
 * Use for inline page actions where shadcn <Button> is too tall.
 */

import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

type Variant = "default" | "primary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md";

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  default:
    "bg-surface-tint text-ink border border-rule hover:bg-bg-elev hover:border-silver-line disabled:opacity-50",
  outline:
    "bg-surface text-ink border border-silver-line hover:bg-surface-tint disabled:opacity-50",
  primary:
    "bg-green text-green-cream border border-green hover:bg-green-deep hover:border-green-deep disabled:opacity-50",
  ghost:
    "bg-transparent text-ink-2 hover:bg-bg-elev hover:text-ink disabled:opacity-50",
  danger:
    "bg-danger-tint text-danger border border-danger/20 hover:bg-danger hover:text-green-cream disabled:opacity-50",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1",
  md: "h-9 px-3.5 text-[13px] gap-1.5",
};

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  {
    variant = "default",
    size = "sm",
    loading,
    icon,
    children,
    className,
    disabled,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-md font-medium leading-none transition-colors",
        SIZES[size],
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});
