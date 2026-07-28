// Uncrustables box-planner — recipe engine for mixed-flavor Uncrustables
// bundles. Extracted from the proven preview→publish batches (2026-07-22/23,
// 10 listings live on store1). This is the first Bundle Factory piece of the
// approved pipeline embedding: it owns WHAT a valid bundle recipe is; rendering
// and the publish conveyor consume its output.
//
// Owner's rational cooler count bands (frozen packing constraints):
//   S ≤30 (comfort 28) / M 48–54 / L 60–66 / XL 90–135.
//   Dead zones — a total there wastes cooler space or does not fit: 31–47,
//   55–59, 67–89. The planner refuses recipes landing in a dead zone.
//
// Renderable-scene constraints, proven over the published MAINs: at most
// 4 flavors, 11 cartons, 4 rows, 4 cartons per row. The one scene that
// exceeded them (5 flavors / 13 cartons) failed 8 consecutive renders; every
// scene within them has rendered correctly under the frozen prompt contract.

export type UncrustablesFlavor = {
  /** Exact component/product name — resolvable by BOTH the donor matcher and
   *  the merged authenticity registry. Never invent new spellings. */
  component: string;
  /** Retail carton size with reviewed package art in the merged registry. */
  cartonSize: 4 | 8 | 10;
  /** Short name used in the listing title. */
  titleName: string;
  /** Full phrase used in the "Includes N …" bullet and the description. */
  bulletPhrase: string;
  /** Name used in "Packed in original retail boxes: …". */
  boxPhrase: string;
};

export const UNCRUSTABLES_FLAVORS: Record<string, UncrustablesFlavor> = Object.fromEntries(
  (
    [
      { component: "Peanut Butter", cartonSize: 4, titleName: "Peanut Butter", bulletPhrase: "Peanut Butter", boxPhrase: "Peanut Butter" },
      { component: "Peanut Butter & Strawberry Jam", cartonSize: 4, titleName: "Strawberry Jam", bulletPhrase: "Peanut Butter & Strawberry Jam", boxPhrase: "Strawberry Jam" },
      { component: "Peanut Butter & Grape Jelly", cartonSize: 4, titleName: "Grape Jelly", bulletPhrase: "Peanut Butter & Grape Jelly", boxPhrase: "Grape Jelly" },
      { component: "Peanut Butter & Raspberry Spread", cartonSize: 4, titleName: "Raspberry", bulletPhrase: "Peanut Butter & Raspberry Spread", boxPhrase: "Raspberry" },
      { component: "Peanut Butter & Honey Spread", cartonSize: 10, titleName: "Honey", bulletPhrase: "Peanut Butter & Honey Spread", boxPhrase: "Honey Spread" },
      { component: "Peanut Butter & Chocolate Flavored Spread", cartonSize: 10, titleName: "Chocolate", bulletPhrase: "Peanut Butter & Chocolate Flavored Spread", boxPhrase: "Chocolate Flavored Spread" },
      { component: "Chocolate Flavored Hazelnut Spread", cartonSize: 4, titleName: "Chocolate Hazelnut", bulletPhrase: "Chocolate Flavored Hazelnut Spread", boxPhrase: "Chocolate Hazelnut" },
      { component: "Peanut Butter & Mixed Berry Spread", cartonSize: 4, titleName: "Berry Burst Mixed Berry", bulletPhrase: "Berry Burst Peanut Butter & Mixed Berry Spread", boxPhrase: "Berry Burst" },
      { component: "Peanut Butter & Blackberry Spread", cartonSize: 4, titleName: "Blackberry Boom", bulletPhrase: "Blackberry Boom Peanut Butter & Blackberry Spread", boxPhrase: "Blackberry Boom" },
      { component: "Whole Wheat Peanut Butter & Strawberry Jam", cartonSize: 4, titleName: "Whole Wheat Strawberry Jam", bulletPhrase: "Whole Wheat Peanut Butter & Strawberry Jam (reduced sugar)", boxPhrase: "Whole Wheat Strawberry Jam" },
      { component: "Whole Wheat Peanut Butter & Grape Jelly", cartonSize: 4, titleName: "Whole Wheat Grape", bulletPhrase: "Whole Wheat Peanut Butter & Grape Spread (reduced sugar, on wheat bread)", boxPhrase: "Whole Wheat Grape Spread" },
      { component: "Peanut Butter & Blueberry", cartonSize: 8, titleName: "Burstin' Blueberry", bulletPhrase: "Burstin' Blueberry Peanut Butter & Blueberry Spread (12g protein per sandwich)", boxPhrase: "Burstin' Blueberry" },
      { component: "Morning Protein Peanut Butter & Mixed Berry Spread", cartonSize: 8, titleName: "Beamin' Berry Blend", bulletPhrase: "Beamin' Berry Blend Morning Protein Peanut Butter & Mixed Berry Spread (12g protein per sandwich)", boxPhrase: "Beamin' Berry Blend" },
      { component: "Peanut Butter & Strawberry Jam Protein", cartonSize: 8, titleName: "Bright-Eyed Berry", bulletPhrase: "Bright-Eyed Berry Peanut Butter & Strawberry Jam (12g protein per sandwich)", boxPhrase: "Bright-Eyed Berry" },
      { component: "Peanut Butter & Apple Cinnamon Jelly Protein", cartonSize: 8, titleName: "Up & Apple", bulletPhrase: "Up & Apple Peanut Butter & Apple Cinnamon Jelly (12g protein per sandwich)", boxPhrase: "Up & Apple" },
    ] as UncrustablesFlavor[]
  ).map((f) => [f.component, f])
);

export const RATIONAL_COUNT_BANDS = [
  { name: "S", min: 4, max: 30, comfort: 28 },
  { name: "M", min: 48, max: 54 },
  { name: "L", min: 60, max: 66 },
  { name: "XL", min: 90, max: 135 },
] as const;

export function rationalBandFor(total: number) {
  return RATIONAL_COUNT_BANDS.find((b) => total >= b.min && total <= b.max) ?? null;
}

export const RENDER_LIMITS = { maxFlavors: 4, maxCartons: 11, maxRows: 4, maxCartonsPerRow: 4 };

export type RecipeComponent = { flavor: string; qty: number };
export type Recipe = { slug: string; comps: RecipeComponent[] };

/** Validate a recipe against flavor catalog, carton math, rational bands and
 *  renderable-scene limits. Returns [] when the recipe is plannable. */
export function validateRecipe(comps: RecipeComponent[]): string[] {
  const errors: string[] = [];
  if (comps.length > RENDER_LIMITS.maxFlavors) errors.push(`too many flavors: ${comps.length} > ${RENDER_LIMITS.maxFlavors}`);

  let totalCartons = 0;
  const cartonCounts: number[] = [];
  for (const c of comps) {
    const f = UNCRUSTABLES_FLAVORS[c.flavor];
    if (!f) { errors.push(`unknown flavor: ${c.flavor}`); continue; }
    if (c.qty % f.cartonSize !== 0) { errors.push(`${c.flavor}: qty ${c.qty} not divisible by carton size ${f.cartonSize}`); continue; }
    const n = c.qty / f.cartonSize;
    cartonCounts.push(n);
    totalCartons += n;
  }
  if (errors.length) return errors;

  const total = comps.reduce((s, c) => s + c.qty, 0);
  if (!rationalBandFor(total)) errors.push(`total ${total} falls in a dead zone (allowed: ≤30, 48–54, 60–66, 90–135)`);
  if (totalCartons > RENDER_LIMITS.maxCartons) errors.push(`too many cartons: ${totalCartons} > ${RENDER_LIMITS.maxCartons}`);

  // Mirror the render script's row builder: single-carton flavors share one
  // row, every multi-carton flavor stands in its own row.
  const singles = cartonCounts.filter((n) => n === 1).length;
  const multis = cartonCounts.filter((n) => n > 1);
  const rows = (singles ? 1 : 0) + multis.length;
  if (rows > RENDER_LIMITS.maxRows) errors.push(`too many rows: ${rows} > ${RENDER_LIMITS.maxRows}`);
  if (singles > RENDER_LIMITS.maxCartonsPerRow) errors.push(`singles row too wide: ${singles} > ${RENDER_LIMITS.maxCartonsPerRow}`);
  for (const n of multis) if (n > RENDER_LIMITS.maxCartonsPerRow) errors.push(`a row of ${n} cartons exceeds the proven maximum of ${RENDER_LIMITS.maxCartonsPerRow}`);

  return errors;
}

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function joinAnd(parts: string[], oxford: boolean): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}${oxford ? "," : ""} and ${parts[parts.length - 1]}`;
}

/** Generate title/bullets/description in the exact style of the published
 *  cohort (factual, no promo adjectives, no emojis, storage instruction
 *  phrased as "Keep frozen" — never a shipping claim). */
export function buildListingCopy(comps: RecipeComponent[]): { title: string; bullets: string[]; description: string } {
  const total = comps.reduce((s, c) => s + c.qty, 0);
  const flavors = comps.map((c) => ({ ...UNCRUSTABLES_FLAVORS[c.flavor], qty: c.qty }));

  const title = `Smucker's Uncrustables Frozen Sandwich Variety Pack, ${joinAnd(flavors.map((f) => f.titleName), false)}, ${total} Count`;

  const includesList = joinAnd(flavors.map((f) => `${f.qty} ${f.bulletPhrase}`), true);
  const boxesList = joinAnd(
    flavors.map((f) => {
      const n = f.qty / f.cartonSize;
      return `${NUM_WORDS[n]} ${f.cartonSize}-count box${n > 1 ? "es" : ""} of ${f.boxPhrase}`;
    }),
    true
  );

  const bullets = [
    `Includes ${total} individually wrapped frozen sandwiches: ${includesList}.`,
    `Packed in original retail boxes: ${boxesList}.`,
    "Each sandwich is sealed in its original individual wrapper on soft crustless bread.",
    "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating; once thawed, consume within 8 hours. Do not refreeze.",
    "An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components.",
  ];

  const description = [
    `This variety pack contains ${total} individually wrapped Smucker's Uncrustables frozen sandwiches in ${NUM_WORDS[flavors.length]} ${flavors.length > 1 ? "varieties" : "variety"}: ${includesList}.`,
    `The sandwiches arrive in their original retail boxes: ${boxesList}. Each sandwich is made on soft crustless bread and sealed in its own wrapper by the original manufacturer.`,
    "Keep frozen. Thaw at room temperature for 30 to 60 minutes before eating and consume within 8 hours of thawing. An insulated foam cooler with frozen gel packs is included as packaging.",
  ].join("\n\n");

  return { title, bullets, description };
}
