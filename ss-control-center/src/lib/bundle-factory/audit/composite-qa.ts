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
  return (
    `You are a strict Amazon main-image QA reviewer. This should be a clean ` +
    `product photo of real Smucker's Uncrustables frozen sandwich RETAIL BOXES ` +
    `on a pure white background — nothing else.\n\n` +
    `The pack is supposed to contain these flavor(s): ${expectedFlavors.map((f) => `"${f}"`).join(", ")}.\n\n` +
    `Look carefully and answer. Respond ONLY with valid JSON, no preamble:\n` +
    `{\n` +
    `  "is_uncrustables_retail_boxes": true or false,   // real Smucker's Uncrustables cartons (not single sandwiches, not lifestyle)\n` +
    `  "background_is_white": true or false,\n` +
    `  "visible_box_count": <integer>,                  // how many separate boxes you can count\n` +
    `  "flavors_seen": ["...", "..."],                  // flavor names / colours you can read on the boxes\n` +
    `  "all_expected_flavors_present": true or false,   // is EVERY expected flavor visibly represented\n` +
    `  "fabricated_or_garbled_text": true or false,     // any nonsense / made-up flavor / unreadable printed text\n` +
    `  "retailer_or_foreign_logo": true or false,       // any Target/Walmart/Amazon/Costco/Sam's badge, price sticker, watermark, or non-Uncrustables brand\n` +
    `  "notes": "one short sentence"\n` +
    `}`
  );
}

export async function qaCompositeImage(
  input: CompositeQaInput,
): Promise<CompositeQaResult> {
  const base: CompositeQaResult = {
    pass: true, verified: false, hard_fails: [], warnings: [], cost_cents: 0,
  };
  if (!input.image_url) {
    return { ...base, pass: false, hard_fails: ["no image url"] };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const buf = await fetchImageBuffer(input.image_url);
    const b64 = buf.toString("base64");
    parsed = await identifyImageViaClaudeCli([b64], qaPrompt(input.expected_flavors), {
      timeoutMs: 200_000,
    });
  } catch {
    parsed = null;
  }

  // Vision unavailable → don't block a real-photo image; flag unverified.
  if (!parsed || typeof parsed !== "object") {
    return { ...base, pass: true, verified: false, warnings: ["vision unavailable — image not QA-verified (Rule 6 still applies)"] };
  }

  const b = (k: string) => parsed![k] === true;
  const hard_fails: string[] = [];
  const warnings: string[] = [];

  if (parsed.is_uncrustables_retail_boxes === false) {
    hard_fails.push("not real Uncrustables retail boxes");
  }
  if (parsed.background_is_white === false) {
    hard_fails.push("background is not pure white");
  }
  if (b("retailer_or_foreign_logo")) {
    hard_fails.push("retailer/foreign logo or watermark visible");
  }
  if (b("fabricated_or_garbled_text")) {
    hard_fails.push("fabricated or garbled flavor text");
  }
  // Missing flavor only matters for a MIX (>1 expected).
  if (input.expected_flavors.length > 1 && parsed.all_expected_flavors_present === false) {
    hard_fails.push(`not every expected flavor visible (${input.expected_flavors.join(" + ")})`);
  }

  // Box count: we TRUST our own deterministic math; a vision miscount is only a
  // warning (models routinely miscount tiled grids).
  const seen = typeof parsed.visible_box_count === "number" ? parsed.visible_box_count : null;
  if (seen != null && seen !== input.expected_boxes) {
    warnings.push(`vision counted ${seen} boxes, composite placed ${input.expected_boxes}`);
  }

  return {
    pass: hard_fails.length === 0,
    verified: true,
    hard_fails,
    warnings,
    observed: parsed,
    cost_cents: 0,
  };
}
