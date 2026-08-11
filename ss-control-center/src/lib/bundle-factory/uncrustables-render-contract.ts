// Uncrustables retail-boxes render contract — the frozen PROVEN prompt
// contract appended to the base image prompt: REFERENCE MAPPING + ROW LAYOUT
// CONTRACT (spelled-out counts) + FRUIT ART + GEL PACKS + GEL PACK TEXT +
// RETAILER FLAGS + SCENE + NO LOOSE PROPS + BRANDING + FRONT TEXT.
// Extracted verbatim from scripts/_trial_render.ts (the mapLines/rowLines/
// frontText assembly); the script remains the fallback operator path.
// Every string is byte-identical to the script — golden-parity tested in
// __tests__/uncrustables-render-contract.test.ts. Never reword a line here
// without re-proving renders.
//
// Row builder rule (must stay in lockstep with the box-planner's
// validateRecipe() row simulation): single-carton flavors share the first
// row, every multi-carton flavor stands in its own row, in recipe order.

const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export type RenderContractComponent = {
  /** Exact component flavor name (box-planner catalog spelling). */
  flavor: string;
  /** Sandwich count for this flavor. */
  qty: number;
  /** Donor carton photo URL; null/empty excludes the flavor from the mapping. */
  donorImage: string | null;
  /** Reviewed retail carton size of the package art; null excludes likewise. */
  artSize: number | null;
  /** EXACT front-panel wording on the genuine carton, when it differs from the
   *  internal flavor name. Fed to the model so it never prints our catalog
   *  name onto real package art. */
  frontPanelText?: string | null;
};

export type UncrustablesRenderContract = {
  /** The contract block. Callers append it to the base image prompt as
   *  `${basePrompt}\n\n${contractText}`. */
  contractText: string;
  /** Anchor first, then donor carton photos in mapping order; capped at six
   *  (the image generator's reference limit, script convention). */
  referenceUrls: string[];
};

/** Build the retail-boxes prompt contract for one recipe. `anchorUrl` is the
 *  frozen Salutem cooler anchor (Reference 1). */
export function buildUncrustablesRetailBoxesContract(input: {
  comps: RenderContractComponent[];
  anchorUrl: string;
}): UncrustablesRenderContract {
  const refs: string[] = [input.anchorUrl];
  const mapLines: string[] = [
    "REFERENCE MAPPING (follow exactly):",
    "Reference 1 is the Salutem Solutions cooler with gel packs — the scene anchor.",
  ];
  const withArt = input.comps.filter(
    (c): c is RenderContractComponent & { donorImage: string; artSize: number } =>
      Boolean(c.donorImage && c.artSize),
  );
  withArt.forEach((c) => {
    refs.push(c.donorImage);
    const boxes = c.qty / c.artSize;
    mapLines.push(
      `Ref ${refs.length} = the ${c.artSize}-count carton of ${c.flavor}${c.frontPanelText ? `, whose front panel reads exactly "${c.frontPanelText}"` : ""}; draw exactly ${boxes} of it, its printed "${c.artSize}" badge and its own fruit artwork unchanged. Copy the front-panel wording from the reference photo — never print this flavor's internal catalog name if the pack itself says something else.`,
    );
  });

  const singles = withArt.filter((c) => c.qty / c.artSize === 1);
  const multis = withArt.filter((c) => c.qty / c.artSize > 1);
  const rows: (typeof withArt)[] = [];
  if (singles.length) rows.push(singles);
  multis.forEach((c) => rows.push([c]));
  const totalBoxes = withArt.reduce((s, c) => s + c.qty / c.artSize, 0);
  const rowLines = rows.map((row, i) => {
    const n = row.reduce((s, c) => s + c.qty / c.artSize, 0);
    const desc = row.map((c) => `${c.qty / c.artSize} carton${c.qty / c.artSize > 1 ? "s" : ""} of ${c.artSize}-count ${c.flavor}`).join(" and ");
    const pos = i === 0 ? "back row, tallest" : i === rows.length - 1 ? "front row" : `row ${i + 1}`;
    return `Row ${i + 1} (${pos}): EXACTLY ${n} carton${n > 1 ? "s" : ""} — ${desc}. Count: ${WORDS.slice(0, n).join(", ")}. No other carton in this row.`;
  });
  const frontText = [
    'FRONT TEXT: each front prints its flavor line once, single ampersand, no word repeated, matching its reference photo exactly.',
    'The words "Peanut Butter" are spelled exactly P-e-a-n-u-t B-u-t-t-e-r on EVERY carton — never "Botter", "Batter" or any other vowel.',
    'Each descriptor contains its "&" character exactly ONCE. When the descriptor wraps to a second line, the "&" starts the second line and NEVER also appears at the end of the first line.',
  ];
  if (input.comps.some((c) => c.flavor === "Peanut Butter & Chocolate Flavored Spread"))
    frontText.push('The Chocolate carton reads exactly "Peanut Butter & Chocolate Flavored Spread Sandwich" (the word Spread appears once before Sandwich). The "&" symbol MUST appear between "Butter" and "Chocolate" on EVERY chocolate carton — never omit it.');
  if (input.comps.some((c) => c.flavor === "Morning Protein Peanut Butter & Mixed Berry Spread"))
    frontText.push("Every Beamin' Berry Blend carton reads exactly \"Peanut Butter & Mixed Berry Spread Sandwich\" — \"Peanut\" P-e-a-n-u-t, \"Mixed\" M-i-x-e-d with a clear X, \"Spread Sandwich\" spelled exactly.");
  if (input.comps.some((c) => c.flavor === "Peanut Butter & Honey Spread"))
    frontText.push('The Honey carton reads exactly "Peanut Butter & Honey Spread Sandwich".');
  if (input.comps.some((c) => c.flavor === "Peanut Butter & Mixed Berry Spread"))
    frontText.push('The BERRY BURST cartons are PINK with a pattern of blue circles and stars and a "Limited Edition Flavor" roundel, copied exactly from their reference photo — never dark purple, never a plain dot pattern.');
  if (input.comps.some((c) => c.flavor.startsWith("Whole Wheat")))
    frontText.push('Every Whole Wheat (Reduced Sugar) carton keeps its exact reference front text — strawberry variant reads "Peanut Butter & Strawberry Spread Sandwich", grape variant reads "Peanut Butter & Grape Spread Sandwich" — the "&" character MUST appear right after "Butter" on every one, and the green pill above reads exactly "Reduced Sugar" — spelled R-e-d-u-c-e-d S-u-g-a-r on EVERY red carton, never "Sugor", "Sogar" or "Redaced". The pill text must be sharp and letter-perfect even on angled cartons. The Whole Wheat strawberry carton says "Strawberry Spread" — never "Strawberry Jam"; the Whole Wheat grape carton says "Grape Spread" — never "Grape Jelly". Copy the wording from the reference photo, do not substitute a synonym.');
  mapLines.push(
    "ROW LAYOUT CONTRACT (mandatory): the cartons stand in stepped rows from back to front, one flavor per row:",
    ...rowLines,
    `TOTAL cartons: EXACTLY ${totalBoxes}.`,
    "Unfilled row width stays empty (foam/gel pack) — never add cartons to fill space. Every carton front fully visible; none cropped, slivered, or hidden. Cartons stand side by side only — no depth pairs. Same-count cartons share identical dimensions — no wide or stretched boxes.",
    "CARTON SCALE: a bigger retail count is a physically bigger box. A 10-count carton is wider than an 8-count, and an 8-count is wider than a 4-count. Never draw a 4-count box as wide as or wider than an 8- or 10-count box, and never enlarge a carton just because it stands on an upper row — a raised row keeps the same box size as it would have on the floor of the cooler.",
    "ROW FITS THE COOLER: the cooler is wide enough for every carton of a row PLUS the two inside gel packs. Draw the full row — never drop, hide or push a carton out of frame because the row looks tight, and never let a gel pack cover a carton front. If a row of four is specified, four complete carton fronts are visible with the gel packs beside them, not in front of them.",
    "FRUIT ART: every carton front shows ONLY its own flavor's signature artwork copied from its reference photo (grape cartons show purple grapes, strawberry cartons show strawberries, mixed-berry cartons show strawberries AND blueberries, honey cartons show the wooden honey dipper, chocolate cartons show NO fruit and NO dipper — just the chocolate-filled sandwich). NEVER paint fruit, honey dippers or any art element from a neighboring row's flavor onto a carton, and never drop an element that the reference shows.",
    "GEL PACKS: EXACTLY four in the scene — one standing inside against the left wall, one inside against the right wall, and two leaning outside at the front right. Never add a fifth gel pack or a duplicate behind another.",
    'GEL PACK TEXT: every gel pack prints exactly, letter for letter: "FROZEN GEL PACK" then "KEEP FROZEN" (F-R-O-Z-E-N, never "PROZEN") then "FOR FROZEN SHIPMENTS" then the green lotus then "SALUTEM SOLUTIONS" then "OUR BEST SOLUTIONS FOR YOU".',
    'SMUCKER\'S BANNER: the red arched brand banner at the top of EVERY carton reads exactly "SMUCKER\'S" — S-M-U-C-K-E-R, apostrophe, S. The first letter is always S (never B), every character is a LETTER (never the digits 2 or 6), and the apostrophe-S ending is always present. This applies to every carton in every row, including the smallest cartons in the back.',
    'COUNT BADGES: every carton\'s count badge prints a DIGIT — "4", "8" or "10" — copied from its reference photo. The digit 8 is two stacked round loops with NO flat vertical stem; it is never the letter B and never the digit 6. Check every badge, especially on rows with four cartons.',
    "RETAILER FLAGS: if a reference photo carries a retailer-exclusive roundel (such as \"Only at Walmart\"), OMIT it — draw that corner of the carton plain. Never print any retailer's name or logo anywhere in the image.",
    "SCENE: the open white Salutem Solutions foam cooler from Reference 1 with lid and gel packs IS the stage; rows sit inside/above it. Never a flat catalog lineup on plain white.",
    "NO LOOSE PROPS: never scatter loose fruit, berries, ice, snow or any other prop in or around the cooler. The ONLY objects in the scene are the cartons, the cooler with its lid, and the four gel packs. Fruit exists ONLY as printed artwork on carton faces.",
    "BRANDING: the cooler front and every gel pack carry the EXACT branding from Reference 1 — the green lotus emblem with the words SALUTEM SOLUTIONS and OUR BEST SOLUTIONS FOR YOU. Copy that logo pixel-faithfully. NEVER invent a different logo, monogram, crest or typography.",
    frontText.join(" "),
  );
  return { contractText: mapLines.join("\n"), referenceUrls: refs.slice(0, 6) };
}
