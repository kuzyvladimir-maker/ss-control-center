/**
 * Chip-style filter for the Stores page. Drives the `?chain=` and
 * `?tier=` query params via Link navigation so server pagination keeps
 * working.
 */

"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

const TIERS = ["TIER_1", "TIER_2", "TIER_3", "TIER_4", "TIER_5"] as const;

export function StoreChainFilter({
  chains,
  activeChain,
  activeTier,
}: {
  chains: string[];
  activeChain: string | null;
  activeTier: string | null;
}) {
  function chainHref(c: string | null) {
    const params = new URLSearchParams();
    if (c) params.set("chain", c);
    if (activeTier) params.set("tier", activeTier);
    const qs = params.toString();
    return qs ? `/bundle-factory/stores?${qs}` : "/bundle-factory/stores";
  }
  function tierHref(t: string | null) {
    const params = new URLSearchParams();
    if (activeChain) params.set("chain", activeChain);
    if (t) params.set("tier", t);
    const qs = params.toString();
    return qs ? `/bundle-factory/stores?${qs}` : "/bundle-factory/stores";
  }

  return (
    <div className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <Chip href={chainHref(null)} active={!activeChain}>
        All chains
      </Chip>
      {chains.map((c) => (
        <Chip
          key={c}
          href={chainHref(c)}
          active={activeChain === c}
          tone="chain"
        >
          {c}
        </Chip>
      ))}
      <span className="mx-1 h-4 w-px shrink-0 bg-rule" aria-hidden />
      <Chip href={tierHref(null)} active={!activeTier}>
        All tiers
      </Chip>
      {TIERS.map((t) => (
        <Chip
          key={t}
          href={tierHref(t)}
          active={activeTier === t}
          tone="tier"
        >
          {t.replace("_", " ")}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  href,
  active,
  children,
  tone = "neutral",
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  tone?: "neutral" | "chain" | "tier";
}) {
  const activeStyle =
    tone === "tier"
      ? "border-silver-line bg-silver-tint text-ink"
      : "border-green-soft2 bg-green-soft text-green-ink";
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[12px] font-medium transition-colors",
        active
          ? activeStyle
          : "border-rule bg-surface text-ink-2 hover:bg-bg-elev hover:text-ink"
      )}
      aria-pressed={active}
    >
      {children}
    </Link>
  );
}
