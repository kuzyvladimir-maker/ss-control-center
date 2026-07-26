// Golden-parity tests for the extracted render contract
// (uncrustables-render-contract.ts) against scripts/_trial_render.ts.
// The oracle below is the EXACT assembly block copied from the script
// (lines building mapLines/rowLines/frontText) — if either side drifts,
// these tests fail.
//   node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-render-contract.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUncrustablesRetailBoxesContract,
  type RenderContractComponent,
} from "@/lib/bundle-factory/uncrustables-render-contract";
import {
  UNCRUSTABLES_FLAVORS,
  validateRecipe,
} from "@/lib/bundle-factory/uncrustables-box-planner";

const ANCHOR = "https://anchor.example/cooler.png";

// ---------------------------------------------------------------------------
// ORACLE — verbatim copy of the contract assembly from scripts/_trial_render.ts
// (refs/mapLines/rowLines/frontText block). Do not "clean up" this code; it is
// the drift detector for both the script and the library.
// ---------------------------------------------------------------------------
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function scriptOracle(
  r: { comps: Array<{ flavor: string; qty: number }> },
  composition: any[],
  anchorUrl: string,
): { contractText: string; referenceUrls: string[] } {
  const refs: string[] = [anchorUrl];
  const mapLines: string[] = [
    "REFERENCE MAPPING (follow exactly):",
    "Reference 1 is the Salutem Solutions cooler with gel packs — the scene anchor.",
  ];
  const withArt = composition.filter((c: any) => c._donor_image && c._art);
  withArt.forEach((c: any) => {
    refs.push(c._donor_image);
    const boxes = c.qty / c._art.size;
    mapLines.push(
      `Ref ${refs.length} = the ${c._art.size}-count carton of ${c.flavor}; draw exactly ${boxes} of it, its printed "${c._art.size}" badge and its own fruit artwork unchanged.`,
    );
  });

  const singles = withArt.filter((c: any) => c.qty / c._art.size === 1);
  const multis = withArt.filter((c: any) => c.qty / c._art.size > 1);
  const rows: any[][] = [];
  if (singles.length) rows.push(singles);
  multis.forEach((c: any) => rows.push([c]));
  const totalBoxes = withArt.reduce((s: number, c: any) => s + c.qty / c._art.size, 0);
  const rowLines = rows.map((row, i) => {
    const n = row.reduce((s: number, c: any) => s + c.qty / c._art.size, 0);
    const desc = row.map((c: any) => `${c.qty / c._art.size} carton${c.qty / c._art.size > 1 ? "s" : ""} of ${c._art.size}-count ${c.flavor}`).join(" and ");
    const pos = i === 0 ? "back row, tallest" : i === rows.length - 1 ? "front row" : `row ${i + 1}`;
    return `Row ${i + 1} (${pos}): EXACTLY ${n} carton${n > 1 ? "s" : ""} — ${desc}. Count: ${WORDS.slice(0, n).join(", ")}. No other carton in this row.`;
  });
  const frontText = [
    'FRONT TEXT: each front prints its flavor line once, single ampersand, no word repeated, matching its reference photo exactly.',
    'The words "Peanut Butter" are spelled exactly P-e-a-n-u-t B-u-t-t-e-r on EVERY carton — never "Botter", "Batter" or any other vowel.',
    'Each descriptor contains its "&" character exactly ONCE. When the descriptor wraps to a second line, the "&" starts the second line and NEVER also appears at the end of the first line.',
  ];
  if (r.comps.some((c: any) => c.flavor === "Peanut Butter & Chocolate Flavored Spread"))
    frontText.push('The Chocolate carton reads exactly "Peanut Butter & Chocolate Flavored Spread Sandwich" (the word Spread appears once before Sandwich). The "&" symbol MUST appear between "Butter" and "Chocolate" on EVERY chocolate carton — never omit it.');
  if (r.comps.some((c: any) => c.flavor === "Morning Protein Peanut Butter & Mixed Berry Spread"))
    frontText.push("Every Beamin' Berry Blend carton reads exactly \"Peanut Butter & Mixed Berry Spread Sandwich\" — \"Peanut\" P-e-a-n-u-t, \"Mixed\" M-i-x-e-d with a clear X, \"Spread Sandwich\" spelled exactly.");
  if (r.comps.some((c: any) => c.flavor === "Peanut Butter & Honey Spread"))
    frontText.push('The Honey carton reads exactly "Peanut Butter & Honey Spread Sandwich".');
  if (r.comps.some((c: any) => c.flavor === "Peanut Butter & Mixed Berry Spread"))
    frontText.push('The BERRY BURST cartons are PINK with a pattern of blue circles and stars and a "Limited Edition Flavor" roundel, copied exactly from their reference photo — never dark purple, never a plain dot pattern.');
  if (r.comps.some((c: any) => c.flavor === "Whole Wheat Peanut Butter & Strawberry Jam"))
    frontText.push('The red Reduced Sugar Strawberry cartons read exactly "Peanut Butter & Strawberry Spread Sandwich" — the "&" character MUST appear right after "Butter" on every red carton, and the green pill above reads exactly "Reduced Sugar".');
  mapLines.push(
    "ROW LAYOUT CONTRACT (mandatory): the cartons stand in stepped rows from back to front, one flavor per row:",
    ...rowLines,
    `TOTAL cartons: EXACTLY ${totalBoxes}.`,
    "Unfilled row width stays empty (foam/gel pack) — never add cartons to fill space. Every carton front fully visible; none cropped, slivered, or hidden. Cartons stand side by side only — no depth pairs. Same-count cartons share identical dimensions — no wide or stretched boxes.",
    "FRUIT ART: every carton front shows ONLY its own flavor's signature artwork copied from its reference photo (grape cartons show purple grapes, strawberry cartons show strawberries, mixed-berry cartons show strawberries AND blueberries, honey cartons show the wooden honey dipper, chocolate cartons show NO fruit and NO dipper — just the chocolate-filled sandwich). NEVER paint fruit, honey dippers or any art element from a neighboring row's flavor onto a carton, and never drop an element that the reference shows.",
    "GEL PACKS: EXACTLY four in the scene — one standing inside against the left wall, one inside against the right wall, and two leaning outside at the front right. Never add a fifth gel pack or a duplicate behind another.",
    'GEL PACK TEXT: every gel pack prints exactly, letter for letter: "FROZEN GEL PACK" then "KEEP FROZEN" (F-R-O-Z-E-N, never "PROZEN") then "FOR FROZEN SHIPMENTS" then the green lotus then "SALUTEM SOLUTIONS" then "OUR BEST SOLUTIONS FOR YOU".',
    "RETAILER FLAGS: if a reference photo carries a retailer-exclusive roundel (such as \"Only at Walmart\"), OMIT it — draw that corner of the carton plain. Never print any retailer's name or logo anywhere in the image.",
    "SCENE: the open white Salutem Solutions foam cooler from Reference 1 with lid and gel packs IS the stage; rows sit inside/above it. Never a flat catalog lineup on plain white.",
    "NO LOOSE PROPS: never scatter loose fruit, berries, ice, snow or any other prop in or around the cooler. The ONLY objects in the scene are the cartons, the cooler with its lid, and the four gel packs. Fruit exists ONLY as printed artwork on carton faces.",
    "BRANDING: the cooler front and every gel pack carry the EXACT branding from Reference 1 — the green lotus emblem with the words SALUTEM SOLUTIONS and OUR BEST SOLUTIONS FOR YOU. Copy that logo pixel-faithfully. NEVER invent a different logo, monogram, crest or typography.",
    frontText.join(" "),
  );
  return { contractText: mapLines.join("\n"), referenceUrls: refs.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// Fixture builder — stub donor images, art sizes from the box-planner catalog.
// ---------------------------------------------------------------------------
type FixtureComp = { flavor: string; qty: number; image?: string | null };

function fixture(comps: FixtureComp[]) {
  // Script-shaped composition (the oracle input).
  const composition = comps.map((c, i) => ({
    flavor: c.flavor,
    qty: c.qty,
    _donor_image: c.image !== undefined ? c.image : `https://x/${i + 1}.png`,
    _art: { size: UNCRUSTABLES_FLAVORS[c.flavor].cartonSize },
  }));
  // Library-shaped input.
  const libComps: RenderContractComponent[] = composition.map((c) => ({
    flavor: c.flavor,
    qty: c.qty,
    donorImage: c._donor_image,
    artSize: c._art.size,
  }));
  return { recipe: { comps: comps.map((c) => ({ flavor: c.flavor, qty: c.qty })) }, composition, libComps };
}

function assertParity(comps: FixtureComp[]) {
  const { recipe, composition, libComps } = fixture(comps);
  const expected = scriptOracle(recipe, composition, ANCHOR);
  const actual = buildUncrustablesRetailBoxesContract({ comps: libComps, anchorUrl: ANCHOR });
  assert.equal(actual.contractText, expected.contractText);
  assert.deepEqual(actual.referenceUrls, expected.referenceUrls);
  return actual;
}

// ---------------------------------------------------------------------------
// Golden fixtures — real trial-run recipes.
// ---------------------------------------------------------------------------

test("golden parity — l-choc-berry-60 (four multi-carton rows)", () => {
  const comps: FixtureComp[] = [
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
    { flavor: "Peanut Butter & Blueberry", qty: 16 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 16 },
    { flavor: "Peanut Butter & Raspberry Spread", qty: 8 },
  ];
  assert.deepEqual(validateRecipe(comps), []); // box-planner accepts the recipe
  const { contractText } = assertParity(comps);
  // Row builder sanity: all four flavors are multis → four rows, 8 cartons.
  assert.match(contractText, /Row 1 \(back row, tallest\): EXACTLY 2 cartons — 2 cartons of 10-count Peanut Butter & Chocolate Flavored Spread\. Count: one, two\./);
  assert.match(contractText, /Row 4 \(front row\): EXACTLY 2 cartons — 2 cartons of 4-count Peanut Butter & Raspberry Spread\./);
  assert.match(contractText, /TOTAL cartons: EXACTLY 8\./);
  assert.match(contractText, /The Chocolate carton reads exactly/);
});

test("golden parity — s-bigbox-trio-28 (singles share the first row)", () => {
  const comps: FixtureComp[] = [
    { flavor: "Peanut Butter & Honey Spread", qty: 10 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
    { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 8 },
  ];
  assert.deepEqual(validateRecipe(comps), []);
  const { contractText, referenceUrls } = assertParity(comps);
  // All three flavors are single-carton → one shared row of three. A single
  // row takes the i === 0 branch, so it is labeled "back row, tallest".
  assert.match(contractText, /Row 1 \(back row, tallest\): EXACTLY 3 cartons — 1 carton of 10-count Peanut Butter & Honey Spread and 1 carton of 10-count Peanut Butter & Chocolate Flavored Spread and 1 carton of 8-count Peanut Butter & Apple Cinnamon Jelly Protein\. Count: one, two, three\./);
  assert.match(contractText, /TOTAL cartons: EXACTLY 3\./);
  assert.match(contractText, /The Honey carton reads exactly/);
  assert.deepEqual(referenceUrls, [ANCHOR, "https://x/1.png", "https://x/2.png", "https://x/3.png"]);
});

test("golden parity — m-variety-54 (mixed singles row + multi rows, Berry Burst pink line)", () => {
  const comps: FixtureComp[] = [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 10 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 8 },
    { flavor: "Peanut Butter & Mixed Berry Spread", qty: 16 },
  ];
  assert.deepEqual(validateRecipe(comps), []);
  const { contractText } = assertParity(comps);
  // Singles (Chocolate, Strawberry Jam Protein) share Row 1; Honey and Berry
  // Burst multis each get their own row.
  assert.match(contractText, /Row 1 \(back row, tallest\): EXACTLY 2 cartons — 1 carton of 10-count Peanut Butter & Chocolate Flavored Spread and 1 carton of 8-count Peanut Butter & Strawberry Jam Protein\./);
  assert.match(contractText, /Row 3 \(front row\): EXACTLY 4 cartons — 4 cartons of 4-count Peanut Butter & Mixed Berry Spread\. Count: one, two, three, four\./);
  assert.match(contractText, /The BERRY BURST cartons are PINK/);
});

test("golden parity — a component without a donor image is excluded from mapping but keeps its front-text rule", () => {
  const comps: FixtureComp[] = [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Whole Wheat Peanut Butter & Strawberry Jam", qty: 8, image: null },
  ];
  const { contractText } = assertParity(comps);
  assert.doesNotMatch(contractText, /Ref \d+ = the 4-count carton of Whole Wheat/);
  assert.match(contractText, /the green pill above reads exactly "Reduced Sugar"/);
  assert.match(contractText, /TOTAL cartons: EXACTLY 2\./);
});
