/**
 * Recognisable round avatars for each store.
 * Color/initials mapping is part of the brand language —
 * see design/DESIGN_TOKENS.md §7 "Store avatars".
 */

import { cn } from "@/lib/utils";

export type StoreKey =
  | "salutem"
  | "amzcom"
  | "sirius"
  | "walmart"
  | "retail"
  | "personal"
  | "unknown";

export type StoreSize = "sm" | "md" | "lg";

interface StoreAvatarProps {
  store: StoreKey | string;
  size?: StoreSize;
  className?: string;
}

const PALETTE: Record<StoreKey, { bg: string; text: string; border?: string; initials: string }> = {
  salutem: { bg: "var(--green)", text: "var(--green-cream)", initials: "SS" },
  amzcom: { bg: "var(--green-soft2)", text: "var(--green-ink)", initials: "AZ" },
  sirius: { bg: "var(--silver-dark)", text: "var(--bg)", initials: "SI" },
  walmart: { bg: "var(--silver-tint)", text: "var(--ink)", border: "var(--silver-line)", initials: "WM" },
  retail: { bg: "var(--green-mid)", text: "var(--green-cream)", initials: "RD" },
  personal: { bg: "var(--bg-elev)", text: "var(--ink-2)", initials: "PV" },
  unknown: { bg: "var(--bg-elev)", text: "var(--ink-3)", initials: "?" },
};

const SIZES: Record<StoreSize, { w: number; font: number }> = {
  sm: { w: 22, font: 9 },
  md: { w: 28, font: 10.5 },
  lg: { w: 36, font: 13 },
};

export function StoreAvatar({ store, size = "md", className }: StoreAvatarProps) {
  const key = (store?.toLowerCase() as StoreKey) in PALETTE ? (store.toLowerCase() as StoreKey) : "unknown";
  const p = PALETTE[key];
  const s = SIZES[size];

  return (
    <div
      className={cn(
        "grid place-items-center rounded-full font-semibold tabular shrink-0",
        className
      )}
      style={{
        width: s.w,
        height: s.w,
        fontSize: s.font,
        background: p.bg,
        color: p.text,
        border: p.border ? `1px solid ${p.border}` : undefined,
        letterSpacing: "0.02em",
      }}
    >
      {p.initials}
    </div>
  );
}

/** Map storeIndex (1-5 Amazon) and a marketplace string to StoreKey. */
export function storeKeyFor(opts: {
  marketplace?: string | null;
  storeIndex?: number | null;
  storeName?: string | null;
}): StoreKey {
  const { marketplace, storeIndex, storeName } = opts;
  if (marketplace && /walmart/i.test(marketplace)) return "walmart";
  if (storeIndex === 1) return "salutem";
  if (storeIndex === 2) return "personal";
  if (storeIndex === 3) return "amzcom";
  if (storeIndex === 4) return "sirius";
  if (storeIndex === 5) return "retail";
  if (storeName) {
    const n = storeName.toLowerCase();
    if (n.includes("salutem")) return "salutem";
    if (n.includes("amz")) return "amzcom";
    if (n.includes("sirius")) return "sirius";
    if (n.includes("walmart")) return "walmart";
    if (n.includes("retail")) return "retail";
    if (n.includes("personal") || n.includes("vladimir")) return "personal";
  }
  return "unknown";
}
