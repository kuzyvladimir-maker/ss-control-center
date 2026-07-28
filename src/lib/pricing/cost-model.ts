// Pricing cost-model — Uncrustables (validated 2026-06-15 against real Veeqo
// sales + label costs). See docs/wiki/uncrustables-pricing-model.md.
//
// Reused by the Pricing module page, the sync job, the reprice cron, and the
// one-off scripts so the math lives in exactly one place.
//
// Economics: a frozen Uncrustables order = loose sandwiches repacked into a
// cooler with ice. Cost driver is the TOTAL unit count in the listing title.
// Customer pays the item price + a shipping charge (≈ our label cost) on top.

export type Cooler = "S" | "M" | "L" | "XL";

/** Packaging cost per cooler: cooler shell + ice ($0.10/cube) + $1 cardboard. */
export const PACKAGING: Record<Cooler, number> = {
  S: 7.5, // $6 + 5 ice + $1
  M: 10.9, // $9 + 9 ice + $1
  L: 14.1, // $12 + 11 ice + $1
  XL: 18.9, // $16 + ~19 ice + $1
};

/** Real average label cost we pay, by cooler. S/M/XL = direct calibrated
 *  averages (large samples). L = weight-interpolated (~18lb) from the S/M/XL
 *  regression label≈$3.9+$2.36/lb — direct L orders too sparse to trust. */
export const LABEL: Record<Cooler, number> = { S: 20, M: 32, L: 45, XL: 60 };

/** $ per Uncrustable unit (avg purchase cost, any pack size). */
export const UNIT_COST = 1;

/** Item price = landed × this. Empirically reproduces the item prices of
 *  listings that actually sell (~67% net markup after the 15% Amazon fee,
 *  with the customer also paying shipping ≈ label on top). */
export const TARGET_MULT = 1.5;

/** Guardrails around target (in item-price terms). */
export const CEILING_MULT = TARGET_MULT * 1.02; // >+2% above target = too high
export const FLOOR_MULT = 1.3; // below 1.3× landed = margin too thin = too low

/** Cooler chosen by total unit count (capacity of each cooler). */
export function coolerFor(total: number): Cooler {
  if (total <= 30) return "S";
  if (total <= 60) return "M";
  if (total <= 72) return "L";
  return "XL";
}

/** Extract the TOTAL unit count from a listing title. Prefers "total NN". */
export function parseTotal(title: string): number {
  const t = (title ?? "").toLowerCase();
  const totalMatch = t.match(/total\s*(\d{1,3})/);
  if (totalMatch) return Number(totalMatch[1]);
  // "10 Count – Pack of 6" / "4 ct - Pack of 45" → box size × pack count = TRUE total.
  const packMatch = t.match(/(\d{1,3})\s*(?:ct\b|count).{0,20}?pack of (\d{1,3})/) ||
                    t.match(/pack of (\d{1,3}).{0,20}?(\d{1,3})\s*(?:ct\b|count)/);
  if (packMatch) return Number(packMatch[1]) * Number(packMatch[2]);
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  const kw = /(\d{1,3})\s*(?:count|ct\b|pieces|pcs|pack|sandwich|units)/g;
  while ((m = kw.exec(t))) hits.push(Number(m[1]));
  const plausible = hits.filter((n) => n >= 2 && n <= 200);
  if (plausible.length) return Math.max(...plausible);
  const all = [...t.matchAll(/\b(\d{1,3})\b/g)]
    .map((x) => Number(x[1]))
    .filter((n) => n >= 4 && n <= 200);
  return all.length ? Math.max(...all) : -1;
}

export interface Priced {
  total: number;
  cooler: Cooler;
  landed: number; // product + packaging + label
  target: number; // recommended item price
  ceiling: number; // above this = critically high
  floor: number; // below this = critically low
  /** Suggested .99 price at or just below target, for actually applying. */
  suggested: number;
}

/** Round to the nearest .99 at or just below the target. */
export function round99(target: number): number {
  let p = Math.floor(target) + 0.99;
  if (p > target) p -= 1;
  return Math.round(p * 100) / 100;
}

/** Full cost model for a given title (or explicit total). */
export function priceFor(titleOrTotal: string | number): Priced | null {
  const total =
    typeof titleOrTotal === "number" ? titleOrTotal : parseTotal(titleOrTotal);
  if (!Number.isFinite(total) || total <= 0) return null;
  const cooler = coolerFor(total);
  const landed = total * UNIT_COST + PACKAGING[cooler] + LABEL[cooler];
  const target = Math.round(landed * TARGET_MULT * 100) / 100;
  return {
    total,
    cooler,
    landed: Math.round(landed * 100) / 100,
    target,
    ceiling: Math.round(landed * CEILING_MULT * 100) / 100,
    floor: Math.round(landed * FLOOR_MULT * 100) / 100,
    suggested: round99(target),
  };
}

export type PriceStatus = "HIGH" | "LOW" | "OK" | "UNKNOWN";

/** Classify a current price against the guardrails. */
export function classify(current: number | null, p: Priced | null): PriceStatus {
  if (current == null || !Number.isFinite(current) || !p) return "UNKNOWN";
  if (current > p.ceiling) return "HIGH"; // critically high → losing sales
  if (current < p.floor) return "LOW"; // critically low → margin risk
  return "OK";
}
