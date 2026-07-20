/**
 * Strict visual QA for the deterministic Uncrustables cooler hero.
 *
 * The product cartons in this image are copied from real catalog photos; the
 * vision pass is the final backstop against a bad catalog match, a retailer
 * banner, a missing flavor, or a malformed cooler template. Unlike the legacy
 * composite QA, this gate fails closed when vision is unavailable. A listing
 * image must be verified before it can be published.
 */

import {
  identifyImageViaClaudeCli,
  identifyImageViaCodex,
} from "@/lib/image-gen/codex-worker";
import { fetchImageBuffer } from "@/lib/walmart/multipack/composite";

type VisionIdentifier = typeof identifyImageViaCodex;

// Spread independent QA requests across both subscription-backed vision
// workers. JavaScript increments this synchronously, so concurrent callers get
// alternating primaries without a lock. Each request still fails over to the
// other worker and remains fail-closed when neither returns a result.
let qaLaneCursor = 0;

function nextVisionLanes(): [VisionIdentifier, VisionIdentifier] {
  const codexFirst = qaLaneCursor++ % 2 === 0;
  return codexFirst
    ? [identifyImageViaCodex, identifyImageViaClaudeCli]
    : [identifyImageViaClaudeCli, identifyImageViaCodex];
}

export interface CoolerHeroQaInput {
  image_url?: string;
  image_buffer?: Buffer;
  expected_flavors: string[];
  expected_visible_boxes: number;
  /** Exact visible carton count for every expected flavor/design. */
  expected_flavor_box_counts: Record<string, number>;
}

export interface CoolerHeroQaResult {
  pass: boolean;
  verified: boolean;
  hard_fails: string[];
  warnings: string[];
  observed?: Record<string, unknown>;
  cost_cents: 0;
}

function qaPrompt(input: CoolerHeroQaInput): string {
  const expectedFlavors = Object.keys(input.expected_flavor_box_counts);
  return [
    "You are the final strict QA reviewer for an Amazon frozen-food main image.",
    "The image must show a real Salutem Solutions frozen shipping kit on a pure white background: an open white EPS cooler branded SALUTEM SOLUTIONS, branded FROZEN GEL PACK pouches, and genuine Smucker's Uncrustables retail cartons placed inside the cooler.",
    `The ONLY expected Uncrustables flavor/designs and exact visible carton counts are: ${JSON.stringify(input.expected_flavor_box_counts)}.`,
    "Products must be physically seated inside the cooler behind its front rim, with shared perspective, contact, overlap, cavity depth, and shadows. A floating, pasted-on, haloed, unsupported, or wall-intersecting product is a hard failure.",
    "There must be exactly four correctly branded gel packs: exactly two inside the cooler, one on each side of the product, and exactly two standing outside in front/right. Loose ice, cubes, crushed ice, snow piles, and puddles are forbidden.",
    "The cartons were supposed to be copied from real product photos. Treat any nutrition panel, lifestyle photo, loose sandwich, plain wrapper, invented carton, unreadable/made-up flavor, or unrelated food as a hard failure.",
    "Smucker's and Uncrustables logos on the food cartons are expected. Salutem branding is allowed only on the cooler and gel packs. A retailer website overlay, price badge, watermark, or UI artifact is forbidden. A small retailer-exclusive mark that is physically printed on a genuine carton (for example, 'Only at Target') is truthful source packaging: report it separately but do not call the carton fabricated.",
    "Inspect the actual pixels carefully. Respond ONLY with valid JSON using every key below:",
    JSON.stringify({
      is_real_uncrustables_retail_boxes: true,
      background_is_pure_white: true,
      salutem_cooler_visible_and_branded: true,
      frozen_gel_packs_visible_and_branded: true,
      salutem_branding_only_on_kit: true,
      all_expected_flavors_visible: true,
      only_expected_flavors_visible: true,
      fabricated_or_garbled_product_text: false,
      retailer_ui_overlay_or_watermark: false,
      genuine_retailer_exclusive_mark_on_carton: false,
      unrelated_product_or_lifestyle_panel: false,
      loose_ice_or_loose_sandwich: false,
      products_physically_seated_inside_cooler: true,
      floating_pasted_or_impossibly_intersecting_product: false,
      inside_gel_pack_count: 2,
      outside_gel_pack_count: 2,
      visible_box_count: 0,
      boxes_by_expected_flavor: Object.fromEntries(
        expectedFlavors.map((flavor) => [flavor, 0]),
      ),
      flavors_seen: ["exact flavor text read from cartons"],
      notes: "one short factual sentence",
    }, null, 2),
  ].join("\n\n");
}

function exactFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Pure fail-closed assessment used by the model-backed runner and tests. */
export function evaluateCoolerHeroQaObservation(
  parsed: Record<string, unknown>,
  input: CoolerHeroQaInput,
): { hard_fails: string[]; warnings: string[] } {
  const hard_fails: string[] = [];
  const warnings: string[] = [];
  requiredBoolean(parsed, "is_real_uncrustables_retail_boxes", true, "not genuine Uncrustables retail cartons", hard_fails);
  requiredBoolean(parsed, "background_is_pure_white", true, "background is not pure white", hard_fails);
  requiredBoolean(parsed, "salutem_cooler_visible_and_branded", true, "Salutem branded cooler missing or malformed", hard_fails);
  requiredBoolean(parsed, "frozen_gel_packs_visible_and_branded", true, "branded frozen gel packs missing or malformed", hard_fails);
  requiredBoolean(parsed, "salutem_branding_only_on_kit", true, "Salutem branding appears outside the shipping kit", hard_fails);
  requiredBoolean(parsed, "all_expected_flavors_visible", true, "one or more expected flavors are missing", hard_fails);
  requiredBoolean(parsed, "only_expected_flavors_visible", true, "unexpected Uncrustables flavor is visible", hard_fails);
  requiredBoolean(parsed, "fabricated_or_garbled_product_text", false, "fabricated or garbled product text", hard_fails);
  requiredBoolean(parsed, "retailer_ui_overlay_or_watermark", false, "retailer UI overlay, price badge, or watermark visible", hard_fails);
  requiredBoolean(parsed, "unrelated_product_or_lifestyle_panel", false, "unrelated product, nutrition-only, or lifestyle panel visible", hard_fails);
  requiredBoolean(parsed, "loose_ice_or_loose_sandwich", false, "loose ice or loose sandwich visible", hard_fails);
  requiredBoolean(parsed, "products_physically_seated_inside_cooler", true, "products are not physically seated behind the cooler rim", hard_fails);
  requiredBoolean(parsed, "floating_pasted_or_impossibly_intersecting_product", false, "floating, pasted, unsupported, or intersecting product visible", hard_fails);

  const visible = parsed.visible_box_count;
  if (!exactFiniteInteger(visible)) {
    hard_fails.push("vision did not return an exact box count");
  } else if (visible !== input.expected_visible_boxes) {
    hard_fails.push(
      `vision counted ${visible} boxes; exact recipe presentation requires ${input.expected_visible_boxes}`,
    );
  }

  const insideGelPacks = parsed.inside_gel_pack_count;
  const outsideGelPacks = parsed.outside_gel_pack_count;
  if (!exactFiniteInteger(insideGelPacks) || insideGelPacks !== 2) {
    hard_fails.push(`inside gel-pack count is ${String(insideGelPacks)}; exactly 2 required`);
  }
  if (!exactFiniteInteger(outsideGelPacks) || outsideGelPacks !== 2) {
    hard_fails.push(`outside gel-pack count is ${String(outsideGelPacks)}; exactly 2 required`);
  }

  const byFlavor = parsed.boxes_by_expected_flavor;
  if (!byFlavor || typeof byFlavor !== "object" || Array.isArray(byFlavor)) {
    hard_fails.push("vision did not return exact per-flavor box counts");
  } else {
    const observed = byFlavor as Record<string, unknown>;
    for (const [flavor, expectedCount] of Object.entries(
      input.expected_flavor_box_counts,
    )) {
      const observedCount = observed[flavor];
      if (!exactFiniteInteger(observedCount) || observedCount !== expectedCount) {
        hard_fails.push(
          `${flavor} visible box count is ${String(observedCount)}; exactly ${expectedCount} required`,
        );
      }
    }
    const unexpectedKeys = Object.keys(observed).filter(
      (flavor) => !(flavor in input.expected_flavor_box_counts),
    );
    if (unexpectedKeys.length > 0) {
      hard_fails.push(`unexpected per-flavor count keys: ${unexpectedKeys.join(", ")}`);
    }
  }

  if (parsed.genuine_retailer_exclusive_mark_on_carton === true) {
    warnings.push("genuine retailer-exclusive mark is printed on a source carton");
  } else if (parsed.genuine_retailer_exclusive_mark_on_carton !== false) {
    hard_fails.push("vision did not classify retailer-exclusive carton marks");
  }
  return { hard_fails, warnings };
}

function requiredBoolean(
  parsed: Record<string, unknown>,
  key: string,
  expected: boolean,
  reason: string,
  out: string[],
): void {
  if (parsed[key] !== expected) out.push(reason);
}

async function runOneQaPass(input: CoolerHeroQaInput): Promise<{
  hard_fails: string[];
  warnings: string[];
  observed: Record<string, unknown>;
} | null> {
  try {
    const buf = input.image_buffer
      ?? (input.image_url ? await fetchImageBuffer(input.image_url) : null);
    if (!buf) return null;
    const [primary, fallback] = nextVisionLanes();
    const images = [buf.toString("base64")];
    const prompt = qaPrompt(input);
    const options = { timeoutMs: 200_000 };
    const parsed = await primary(images, prompt, options)
      ?? await fallback(images, prompt, options);
    if (!parsed || typeof parsed !== "object") return null;

    const { hard_fails, warnings } = evaluateCoolerHeroQaObservation(parsed, input);
    return { hard_fails, warnings, observed: parsed };
  } catch {
    return null;
  }
}

export async function qaCoolerHeroImage(input: CoolerHeroQaInput): Promise<CoolerHeroQaResult> {
  const base: CoolerHeroQaResult = {
    pass: false,
    verified: false,
    hard_fails: [],
    warnings: [],
    cost_cents: 0,
  };
  if (!input.image_buffer && !input.image_url) {
    return { ...base, hard_fails: ["no image supplied"] };
  }
  if (input.expected_flavors.length === 0) {
    return { ...base, hard_fails: ["no expected flavors supplied"] };
  }
  const flavorCountEntries = Object.entries(input.expected_flavor_box_counts);
  if (
    flavorCountEntries.length === 0 ||
    flavorCountEntries.some(
      ([flavor, count]) => !flavor.trim() || !Number.isInteger(count) || count < 1,
    ) ||
    flavorCountEntries.reduce((sum, [, count]) => sum + count, 0) !==
      input.expected_visible_boxes
  ) {
    return { ...base, hard_fails: ["invalid exact per-flavor box-count contract"] };
  }

  const first = await runOneQaPass(input);
  if (!first) {
    return { ...base, hard_fails: ["vision unavailable — image remains blocked"] };
  }
  if (first.hard_fails.length === 0) {
    return {
      ...base,
      pass: true,
      verified: true,
      warnings: first.warnings,
      observed: first.observed,
    };
  }

  // Re-check a rejection twice and require a real 2-of-3 majority. Missing
  // votes never turn a failure into a pass.
  const [second, third] = await Promise.all([
    runOneQaPass(input),
    runOneQaPass(input),
  ]);
  const votes = [first, second, third].filter(
    (v): v is NonNullable<typeof v> => v != null,
  );
  if (votes.length < 2) {
    return {
      ...base,
      hard_fails: ["vision unavailable for rejection majority — image remains blocked"],
      observed: first.observed,
    };
  }
  const passing = votes.filter((v) => v.hard_fails.length === 0);
  if (passing.length >= 2) {
    return {
      ...base,
      pass: true,
      verified: true,
      warnings: [...passing[0].warnings, `QA majority-pass (${passing.length}/3)`],
      observed: passing[0].observed,
    };
  }

  const tally = new Map<string, number>();
  for (const vote of votes) {
    for (const fail of new Set(vote.hard_fails)) {
      tally.set(fail, (tally.get(fail) ?? 0) + 1);
    }
  }
  const agreed = [...tally.entries()]
    .filter(([, count]) => count >= 2)
    .map(([reason]) => reason);
  return {
    ...base,
    verified: true,
    hard_fails: agreed.length > 0 ? agreed : first.hard_fails,
    warnings: [`QA majority-fail (${3 - passing.length}/3)`],
    observed: first.observed,
  };
}
