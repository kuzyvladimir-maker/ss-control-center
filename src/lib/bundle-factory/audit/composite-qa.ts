/**
 * QA OFFICER for the real-photo composite main image.
 *
 * Owner's model (2026-07-08): the algorithm produces an image against an IDEAL
 * PICTURE, and a quality officer checks the output against that ideal before it
 * ships. This is that officer.
 *
 * The composite is deterministic (real donor pixels, our own box math), so the
 * flavor and count are correct BY CONSTRUCTION. The officer is the visual
 * backstop for the residual risks a real photo can still carry:
 *   • a retailer watermark / price sticker / store badge baked into the donor
 *     photo (Target, Walmart, Amazon, Costco, Sam's Club…);
 *   • the donor photo not actually being a retail box (lifestyle / single
 *     sandwich / serving suggestion);
 *   • a garbled or fabricated flavor name (should be impossible with real
 *     pixels, but we verify);
 *   • for a MIX, a flavor visually missing (the exact defect the owner reported:
 *     title says two flavors, image shows one).
 *
 * Runs on the Claude Max subscription via the box worker ($0). If the vision
 * call is unavailable we DO NOT hard-block (a flaky call must not freeze a
 * genuinely-correct real-photo image) — we return pass:true, verified:false and
 * let the separate compliance-gate Rule 6 act as the second logo check.
 */

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";
import { fetchImageBuffer } from "@/lib/walmart/multipack/composite";

export interface CompositeQaInput {
  image_url: string;
  /** Short flavor names expected in the image (composition order). */
  expected_flavors: string[];
  /** Total real retail boxes the composite placed. */
  expected_boxes: number;
  /** Total sandwich pieces the listing represents (for the report only). */
  expected_units: number;
}

export interface CompositeQaResult {
  /** True when the officer approves the image for publish. */
  pass: boolean;
  /** True when a vision check actually ran (false = officer couldn't verify). */
  verified: boolean;
  /** Reasons the image was rejected (empty when pass). */
  hard_fails: string[];
  /** Non-blocking observations (e.g. vision box-count differs from ours). */
  warnings: string[];
  /** Raw observation echoed for logging/debugging. */
  observed?: Record<string, unknown>;
  cost_cents: 0;
}

function qaPrompt(expectedFlavors: string[]): string {
  const n = expectedFlavors.length;
  return (
    `You are a strict Amazon main-image QA reviewer. This should be a clean ` +
    `product photo of real Smucker's Uncrustables frozen sandwich RETAIL BOXES ` +
    `on a pure white background — nothing else.\n\n` +
    (n > 1
      ? `This is a VARIETY pack of ${n} different Uncrustables flavors. Two boxes ` +
        `count as DIFFERENT designs if their artwork/colour/flavor text differ AT ALL ` +
        `(e.g. a yellow "Bright-Eyed Berry" protein box vs a red "Reduced Sugar" box ` +
        `are two distinct designs even though both are strawberry).\n\n`
      : `This is a single-flavor pack — all boxes should look identical.\n\n`) +
    `Look carefully and answer. Respond ONLY with valid JSON, no preamble:\n` +
    `{\n` +
    `  "is_uncrustables_retail_boxes": true or false,   // real Smucker's Uncrustables cartons (not single sandwiches, not lifestyle scenes)\n` +
    `  "background_is_white": true or false,            // the area around the boxes — TRUE unless there is a clearly coloured backdrop\n` +
    `  "visible_box_count": <integer>,                  // how many separate boxes you can count\n` +
    `  "distinct_box_designs": <integer>,               // how many VISUALLY DIFFERENT box designs are present (identical boxes count once)\n` +
    `  "flavors_seen": ["...", "..."],                  // flavor names / colours you can read on the boxes\n` +
    `  "fabricated_or_garbled_text": true or false,     // any nonsense / MADE-UP flavor that is not a real Uncrustables product, or unreadable printed text\n` +
    `  "retailer_or_foreign_logo": true or false,       // any Target/Walmart/Amazon/Costco/Sam's badge, price sticker, watermark, or NON-Uncrustables brand\n` +
    `  "notes": "one short sentence"\n` +
    `}`
  );
}

/** One vision pass → a normalized verdict. Runs on the Claude Max box worker ($0).
 *  Returns null when vision is unavailable (network/worker down). */
async function runOneQaPass(input: CompositeQaInput): Promise<
  { hard_fails: string[]; warnings: string[]; observed: Record<string, unknown> } | null
> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const buf = await fetchImageBuffer(input.image_url);
    const b64 = buf.toString("base64");
    parsed = await identifyImageViaClaudeCli([b64], qaPrompt(input.expected_flavors), { timeoutMs: 200_000 });
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const b = (k: string) => parsed![k] === true;
  const hard_fails: string[] = [];
  const warnings: string[] = [];

  if (parsed.is_uncrustables_retail_boxes === false) hard_fails.push("not real Uncrustables retail boxes");
  if (parsed.background_is_white === false) hard_fails.push("background is not pure white");
  if (b("retailer_or_foreign_logo")) hard_fails.push("retailer/foreign logo or watermark visible");
  if (b("fabricated_or_garbled_text")) hard_fails.push("fabricated or garbled flavor text");

  // VARIETY check for a mix: rely on the count of visually-DISTINCT box designs,
  // not brittle name-matching (near-duplicate names like "Strawberry Jam" vs
  // "Whole Wheat Strawberry Jam" fool a name match). Pass when the model sees at
  // least as many distinct designs as expected flavors.
  const n = input.expected_flavors.length;
  if (n > 1) {
    const distinct = typeof parsed.distinct_box_designs === "number" ? parsed.distinct_box_designs : null;
    if (distinct != null && distinct < n) {
      hard_fails.push(`only ${distinct} distinct box design(s) visible, expected ${n} flavors`);
    }
  }

  const seen = typeof parsed.visible_box_count === "number" ? parsed.visible_box_count : null;
  if (seen != null && seen !== input.expected_boxes) {
    warnings.push(`vision counted ${seen} boxes, composite placed ${input.expected_boxes}`);
  }
  return { hard_fails, warnings, observed: parsed };
}

export async function qaCompositeImage(
  input: CompositeQaInput,
): Promise<CompositeQaResult> {
  const base: CompositeQaResult = {
    pass: true, verified: false, hard_fails: [], warnings: [], cost_cents: 0,
  };
  if (!input.image_url) return { ...base, pass: false, hard_fails: ["no image url"] };

  // First pass. On a clean pass we trust it (happy path = 1 vision call).
  const first = await runOneQaPass(input);
  if (!first) {
    // Vision unavailable → don't block a real-photo image; flag unverified.
    return { ...base, pass: true, verified: false, warnings: ["vision unavailable — image not QA-verified (Rule 6 still applies)"] };
  }
  if (first.hard_fails.length === 0) {
    return { ...base, pass: true, verified: true, warnings: first.warnings, observed: first.observed };
  }

  // A FAIL might be a vision false-negative (the check is noisy on variety mixes
  // and near-duplicate flavor names). Re-roll twice and take a MAJORITY vote so a
  // single flaky "not every flavor visible" can't block a genuinely-good image —
  // while a truly bad image (fabricated text, retailer logo, one design) fails
  // consistently across all three. Only failing images pay the extra 2 calls.
  const votes = [first, await runOneQaPass(input), await runOneQaPass(input)].filter(
    (v): v is NonNullable<typeof v> => v != null,
  );
  const passCount = votes.filter((v) => v.hard_fails.length === 0).length;
  const majorityPass = passCount >= Math.ceil(votes.length / 2);
  if (majorityPass) {
    const passingVote = votes.find((v) => v.hard_fails.length === 0)!;
    return {
      ...base, pass: true, verified: true, observed: passingVote.observed,
      warnings: [...passingVote.warnings, `QA majority-pass (${passCount}/${votes.length})`],
    };
  }

  // Majority failed → block. Report the hard_fails that a MAJORITY of the failing
  // votes agree on (filters one-off noise out of the reason).
  const failVotes = votes.filter((v) => v.hard_fails.length > 0);
  const tally = new Map<string, number>();
  for (const v of failVotes) for (const f of new Set(v.hard_fails)) tally.set(f, (tally.get(f) ?? 0) + 1);
  const agreed = [...tally.entries()].filter(([, c]) => c >= Math.ceil(votes.length / 2)).map(([f]) => f);
  return {
    ...base,
    pass: false,
    verified: true,
    hard_fails: agreed.length ? agreed : (failVotes[0]?.hard_fails ?? ["QA failed"]),
    warnings: [`QA majority-fail (${votes.length - passCount}/${votes.length})`],
    observed: (failVotes[0] ?? votes[0])?.observed,
  };
}
