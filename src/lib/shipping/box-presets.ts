// Box size presets shared between the Shipping UI and server-side rate
// resolution. The UI lets the operator pick a preset label ("M", "7×7×6") or
// type a custom "LxWxH"; PackingProfile.boxSize / SkuShippingData store either
// form. resolveBoxDimensions() turns whatever was stored back into numeric
// L/W/H so the Walmart rate API (which needs real numbers) can quote it.

export interface BoxPreset {
  label: string;
  l: number;
  w: number;
  h: number;
}

export const BOX_PRESETS: BoxPreset[] = [
  { label: "XS", l: 11, w: 6, h: 8 },
  { label: "S", l: 12, w: 12, h: 10 },
  { label: "M", l: 13, w: 13, h: 15 },
  { label: "L", l: 18, w: 13, h: 14 },
  { label: "XL", l: 24, w: 13, h: 16 },
  { label: "5×5×5", l: 5, w: 5, h: 5 },
  { label: "6×6×6", l: 6, w: 6, h: 6 },
  { label: "7×7×6", l: 7, w: 7, h: 6 },
  { label: "10×8×6", l: 10, w: 8, h: 6 },
  { label: "12×12×6", l: 12, w: 12, h: 6 },
  { label: "12×12×8", l: 12, w: 12, h: 8 },
];

/** Normalise a dimension/label string: "×" → "x", lowercase, trim. */
function norm(s: string): string {
  return s.replace(/×/g, "x").toLowerCase().trim();
}

/**
 * Turn a stored boxSize ("12x12x6", "7×7×6", "M", "S", …) into numeric L/W/H.
 * Returns null when it can't be resolved (unknown preset, junk).
 */
export function resolveBoxDimensions(
  boxSize: string | null | undefined,
): { length: number; width: number; height: number } | null {
  if (!boxSize) return null;
  // Custom "LxWxH" (accepts x or ×).
  const m = norm(boxSize).match(
    /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/,
  );
  if (m) {
    return { length: Number(m[1]), width: Number(m[2]), height: Number(m[3]) };
  }
  // Preset label.
  const preset = BOX_PRESETS.find((p) => norm(p.label) === norm(boxSize));
  if (preset) return { length: preset.l, width: preset.w, height: preset.h };
  return null;
}
