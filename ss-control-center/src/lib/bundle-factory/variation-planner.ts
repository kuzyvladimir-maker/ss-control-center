/**
 * Variation planner — the combinatorial matrix behind the mass generator.
 *
 * Turns a set of source products (flavors) + a target listing count into a
 * concrete, ORDERED list of listing specs:
 *
 *   Mode A (own-brand, e.g. Uncrustables): every flavor × every piece count
 *     (24/30/45/90/120), THEN flavor mixes of 2, 3, 4 flavors × counts. Owner:
 *     "single flavors, then all sorts of mixes with 2, 3, 4 flavors."
 *   Mode B (gift-set): one variation per product (+ light mixes) at the pack size.
 *
 * Specs are emitted in priority order (singles first, then 2-mix, 3-mix, …) and
 * capped at `targetCount`, so a request for 200 listings takes the first 200 of
 * the matrix without ever materialising the full C(n,k) explosion.
 *
 * Pure + deterministic → unit-tested (variation-planner.test.ts).
 */

export interface PlannerFlavor {
  id: string;
  label: string;
  /** Retail pack sizes this flavor really ships in (union across the catalog,
   *  e.g. strawberry [15,10,4]) — flows into the MAIN-image exact-box rule. */
  pack_sizes?: number[];
}

export interface VariationSpec {
  /** Flavor/product ids in this listing (1 = single, 2–4 = mix). */
  donor_ids: string[];
  /** Pieces per flavor, in donor_ids order — sums to unit_count. */
  quantities: number[];
  /** Retail pack sizes per flavor, aligned with donor_ids. */
  donor_pack_sizes?: number[][];
  /** Total pieces in the listing. */
  unit_count: number;
  composition_type: "SINGLE_FLAVOR" | "MIXED_FLAVOR";
  /** Human label for the batch step display + draft name hint. */
  label: string;
}

export interface PlanOpts {
  /** How many listings to make (hard cap on the returned matrix). */
  targetCount: number;
  /** Own-brand (Uncrustables-style flavors×counts+mixes) vs gift-set. */
  ownBrand: boolean;
  /** Piece counts per listing. Default: own-brand [24,30,45,90,120]
   *  (24 + 30 are the owner's proven catalog sizes); gift-set [pack]. */
  counts?: number[];
  /** Gift-set pack size when counts not given. Default 6. */
  defaultPack?: number;
  /** Largest flavor mix to generate. Default 4. */
  maxMixSize?: number;
}

/** Split `total` pieces across `n` flavors as evenly as possible (remainder to
 *  the first flavors). e.g. split(45,2) → [23,22]; split(90,3) → [30,30,30]. */
export function splitCount(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => (rem-- > 0 ? base + 1 : base));
}

/** Lazily yield k-combinations of `items` (index order), so we can stop early. */
function* combinations<T>(items: T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k <= 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function planVariations(
  flavors: PlannerFlavor[],
  opts: PlanOpts,
): VariationSpec[] {
  const target = Math.max(1, Math.floor(opts.targetCount));
  const maxMix = Math.max(1, Math.min(4, opts.maxMixSize ?? 4));
  const counts =
    opts.counts && opts.counts.length > 0
      ? opts.counts
      : opts.ownBrand
        ? [24, 30, 45, 90, 120]
        : [Math.max(2, opts.defaultPack ?? 6)];

  const specs: VariationSpec[] = [];
  if (flavors.length === 0) return specs;

  const push = (chosen: PlannerFlavor[], unitCount: number) => {
    if (specs.length >= target) return;
    const n = chosen.length;
    const quantities = n === 1 ? [unitCount] : splitCount(unitCount, n);
    const names = chosen.map((f) => f.label).join(" + ");
    specs.push({
      donor_ids: chosen.map((f) => f.id),
      quantities,
      donor_pack_sizes: chosen.map((f) => f.pack_sizes ?? []),
      unit_count: unitCount,
      composition_type: n === 1 ? "SINGLE_FLAVOR" : "MIXED_FLAVOR",
      label: `${names} — ${unitCount} ct`,
    });
  };

  // 1) Singles: every flavor × every count.
  for (const count of counts) {
    for (const f of flavors) {
      if (specs.length >= target) return specs;
      push([f], count);
    }
  }

  // 2) Mixes: 2..maxMix flavors × every count (own-brand emphasises mixes; gift
  //    sets also benefit from small mixes). Emitted in size order so smaller,
  //    more-sellable mixes come first.
  const doMixes = opts.ownBrand || flavors.length > 1;
  if (doMixes) {
    for (let k = 2; k <= Math.min(maxMix, flavors.length); k++) {
      for (const count of counts) {
        for (const combo of combinations(flavors, k)) {
          if (specs.length >= target) return specs;
          push(combo, count);
        }
      }
    }
  }

  return specs;
}
