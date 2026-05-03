/**
 * Try to extract a pack-size multiplier from a marketplace product title.
 *
 * Customers order N "listings", but each listing is often itself a multi-
 * unit pack ("Pack of 7", "Bundle of 2 Cartons", "Set of 12"). On the
 * Procurement page we surface that multiplier so Vladimir knows how many
 * PHYSICAL items to grab off the shelf — qty × packSize.
 *
 * Examples it handles:
 *   "Sara Lee ... Bag - Pack Of 7"               → { size: 7, label: "Pack of 7" }
 *   "Del Monte Peaches Sliced 8.5 oz (Pack of 6)" → { size: 6, label: "Pack of 6" }
 *   "Bundle of 2 Cartons"                         → { size: 2, label: "Bundle of 2" }
 *   "Set of 12 Notebooks"                         → { size: 12, label: "Set of 12" }
 *   "Pack-of-4 ..."                               → { size: 4, label: "Pack of 4" }
 *
 * Returns null when no recognised pattern is found — the UI then falls
 * back to plain "qty шт" display. Erring on the side of "no match" is
 * better than producing a wrong multiplier.
 */
export interface PackSize {
  size: number;
  label: string;
}

const PATTERNS: Array<{ regex: RegExp; nounLabel: string }> = [
  { regex: /\bpack[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Pack of" },
  { regex: /\bbundle[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Bundle of" },
  { regex: /\bset[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Set of" },
  { regex: /\bbox[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Box of" },
  { regex: /\bcase[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Case of" },
  { regex: /\bcount[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Count of" },
];

export function parsePackSize(title: string | null | undefined): PackSize | null {
  if (!title) return null;
  for (const { regex, nounLabel } of PATTERNS) {
    const m = title.match(regex);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 2 && n <= 999) {
        return { size: n, label: `${nounLabel} ${n}` };
      }
    }
  }
  return null;
}
