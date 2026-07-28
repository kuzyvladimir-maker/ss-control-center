/**
 * Channel brand kit — the single source of truth for how each sales
 * channel (Amazon / Walmart / eBay / TikTok / Shopify / Etsy / Merged)
 * is coloured and labelled across the app.
 *
 * Originally these lived inline in the Shipping Labels page; they're now
 * shared so the Sales Overview (analytics) page and the Dashboard render
 * channels with the SAME thematic colours and the SAME clickable chip.
 *
 * Channel keys are Veeqo `type_code` values (lower-case): "amazon",
 * "walmart", "ebay", "tiktok", "shopify", "etsy", "direct". Note that
 * "direct" is Veeqo's Merged-Orders bucket — it shows as "Merged".
 */
import React from "react";
import { cn } from "@/lib/utils";

export type ChannelBrand = {
  label: string;
  active: string;
  inactive: string;
  prefix?: React.ReactNode;
};

export const CHANNEL_BRANDS: Record<string, ChannelBrand> = {
  amazon: {
    label: "amazon",
    active: "border-[#ff9900] bg-[#ff9900]/10 text-[#232f3e]",
    inactive:
      "border-rule bg-surface text-ink-2 hover:border-[#ff9900]/60 hover:text-ink-1",
  },
  walmart: {
    label: "Walmart",
    active: "border-[#0071dc] bg-[#0071dc] text-white",
    inactive: "border-rule bg-surface text-[#0071dc] hover:border-[#0071dc]/60",
    prefix: <span className="text-[15px] leading-none text-[#ffc220]">✲</span>,
  },
  ebay: {
    label: "eBay",
    active: "border-[#e53238] bg-[#e53238] text-white",
    inactive: "border-rule bg-surface text-[#e53238] hover:border-[#e53238]/60",
  },
  tiktok: {
    label: "TikTok Shop",
    active: "border-black bg-black text-white",
    inactive: "border-rule bg-surface text-ink hover:border-ink",
    prefix: <span className="text-[15px] leading-none text-[#fe2c55]">●</span>,
  },
  shopify: {
    label: "Shopify",
    active: "border-[#95bf47] bg-[#95bf47] text-white",
    inactive: "border-rule bg-surface text-[#5b8b1f] hover:border-[#95bf47]",
  },
  etsy: {
    label: "Etsy",
    active: "border-[#f1641e] bg-[#f1641e] text-white",
    inactive: "border-rule bg-surface text-[#f1641e] hover:border-[#f1641e]/60",
  },
  direct: {
    label: "Merged",
    active: "border-ink bg-ink text-surface",
    inactive: "border-rule bg-surface text-ink-2 hover:border-ink-3",
  },
};

/**
 * Solid brand hex per channel — used for the small dot/legend and the
 * proportional bars in the "By channel" breakdown (where a flat colour,
 * not a Tailwind class pair, is what we need). Falls back to neutral grey.
 */
export const CHANNEL_HEX: Record<string, string> = {
  amazon: "#ff9900",
  walmart: "#0071dc",
  ebay: "#e53238",
  tiktok: "#fe2c55",
  shopify: "#95bf47",
  etsy: "#f1641e",
  direct: "#64748b", // Merged Orders — slate, so it reads as "other/internal"
  other: "#6b7280",
};

export function channelHex(channel: string): string {
  return CHANNEL_HEX[channel] ?? CHANNEL_HEX.other;
}

/**
 * Human label for a channel key. Uses the brand label (so "direct" →
 * "Merged", "ebay" → "eBay") and falls back to a Title-Cased version of
 * the raw key for unknown channels.
 */
export function channelLabel(channel: string, override?: string): string {
  if (override) return override;
  const brand = CHANNEL_BRANDS[channel];
  if (brand) return brand.label;
  return channel.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Clickable channel chip — known marketplaces use their brand colours;
 * unknown channels render with neutral fallback styling but still slot
 * into the same chip shape. Amazon gets a special-cased wordmark with the
 * smile underline. Used as a filter toggle on both Shipping Labels and
 * Sales Overview.
 */
export function ChannelToggle({
  channel,
  overrideLabel,
  active,
  onClick,
}: {
  channel: string;
  /** When set, replaces the brand's default label (e.g. show "NAN health"
   *  instead of "Shopify" when there's only one channel of that kind).
   *  Amazon and Walmart ignore this — their wordmarks are special-cased. */
  overrideLabel?: string;
  active: boolean;
  onClick: () => void;
}) {
  // Amazon gets a special-cased wordmark with the smile underline — too
  // distinctive to fold into the generic chip shape.
  if (channel === "amazon") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title="Show only Amazon orders"
        className={cn(
          "group relative rounded-md border px-3.5 pb-2 pt-1.5 text-[13px] font-semibold leading-none transition",
          active
            ? "border-[#ff9900] bg-[#ff9900]/10 text-[#232f3e] shadow-sm"
            : "border-rule bg-surface text-ink-2 hover:border-[#ff9900]/60 hover:text-ink-1",
        )}
      >
        <span className="lowercase tracking-tight">amazon</span>
        <span
          className={cn(
            "absolute bottom-1 left-3.5 right-3.5 h-[3px] rounded-full transition",
            active
              ? "bg-[#ff9900]"
              : "bg-[#ff9900]/40 group-hover:bg-[#ff9900]/70",
          )}
        />
      </button>
    );
  }

  // Generic brand chip — known marketplaces use their colours; unknown
  // channels render with neutral fallback styling but still slot into
  // the same chip shape.
  const brand: ChannelBrand =
    CHANNEL_BRANDS[channel] ?? {
      label: channel.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      active: "border-ink bg-ink text-surface",
      inactive: "border-rule bg-surface text-ink-2 hover:border-ink-3",
    };
  // Vladimir-side identity (channel.name from Veeqo) wins over the
  // generic kind label when supplied — e.g. "NAN health" instead of
  // "Shopify". Walmart keeps its wordmark + spark; we don't override
  // the prefix glyph for known brands.
  const label = overrideLabel ?? brand.label;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Show only ${label} orders`}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-[13px] font-bold leading-none tracking-tight transition",
        active ? `${brand.active} shadow-sm` : brand.inactive,
      )}
    >
      {brand.prefix}
      <span>{label}</span>
    </button>
  );
}
