/**
 * Hero "green card" — forest-green surface with cream text and two
 * decorative circles rendered via ::before and ::after. Used for big
 * flagship callouts: Dashboard shipping progress, Account Health overall
 * health, Customer Hub priority queue, etc.
 *
 * The component is intentionally layout-agnostic — children define the
 * content. We only provide the brand surface.
 */

import { cn } from "@/lib/utils";

interface HeroGreenCardProps {
  children: React.ReactNode;
  className?: string;
  /**
   * By default the card renders two soft circles in the top-right via
   * absolutely-positioned divs. Pass `plain` to skip the decoration.
   */
  plain?: boolean;
}

export function HeroGreenCard({ children, className, plain }: HeroGreenCardProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[14px] p-5",
        className
      )}
      style={{
        background: "var(--green)",
        color: "var(--green-cream)",
      }}
    >
      {!plain && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(240,232,208,0.16) 0%, rgba(240,232,208,0) 70%)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-28 top-8 h-56 w-56 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(240,232,208,0.08) 0%, rgba(240,232,208,0) 70%)",
            }}
          />
        </>
      )}
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * Cream-toned text divider inside a hero green card. Matches
 * `--green-cream` color at 24% opacity — visible but quiet.
 */
export function HeroDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-px w-full", className)}
      style={{ background: "rgba(240, 232, 208, 0.24)" }}
    />
  );
}

/** Muted cream label — for micro-headers inside hero green cards. */
export function HeroLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "font-mono text-[10.5px] uppercase tracking-[0.14em]",
        className
      )}
      style={{ color: "rgba(240, 232, 208, 0.72)" }}
    >
      {children}
    </div>
  );
}
