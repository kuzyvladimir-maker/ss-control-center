/**
 * Phase 2.3 Stage 5 — Main image pipeline orchestrator.
 *
 * Combines image generation + compliance gate Rule 6 (with vision check
 * ACTUALLY running this time) + retry-with-stronger-negatives + per-row
 * persistence + draft status transitions into one entry point.
 *
 * Per-row flow (one GeneratedContent that needs an image):
 *   1. Build a prompt from the variant composition + brand + style rules.
 *   2. generateMainImage(prompt) → preliminary R2 URL.
 *   3. Persist preliminary URL onto the GeneratedContent row.
 *   4. runComplianceGate({ skip_image_check: false }) on the content +
 *      image — only Rule 6 can fire now since Stage 4 already cleared
 *      every text-only rule.
 *   5. CAN_PUBLISH → mark image_generated_at, increment counter, done.
 *   6. BLOCKED on rule-6 → build stronger negative from
 *      detected_logos → retry. Max MAX_IMAGE_RETRIES total attempts.
 *   7. Still BLOCKED after retries → mark manual_review_required=true,
 *      leave compliance_status=BLOCKED.
 *
 * Scope:
 *   By default, only CAN_PUBLISH rows without an image are processed. A forced
 *   regeneration may also retry rows that were blocked by an earlier image
 *   attempt; text-blocked rows remain out of scope.
 *
 * Draft transitions:
 *   - Pipeline entry: status='GENERATED' → 'IMAGE_GENERATING'
 *     (only when the caller is acting on a draft that's at GENERATED;
 *      drafts already in IMAGE_GENERATING/IMAGE_GENERATED stay where
 *      they are so re-runs from the UI don't bounce the badge).
 *   - Pipeline exit: 'IMAGE_GENERATED' only if every target row has a verified
 *     image; otherwise 'ERROR'. Any changed image invalidates downstream
 *     validation and explicit approval before it can be republished.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  generateMainImage,
  type RewriteFeedback,
} from "./image-generation";
import { runComplianceGate } from "./compliance/gate";
import type { BundleComponentInput } from "./compliance/types";
import type { Variant } from "./variation-matrix";
import { logLifecycle } from "./lifecycle-log";
import { NotFoundError, PreconditionError } from "./errors";
import { isOwnBrandPassthrough } from "./own-brand";
import { compositeEligible } from "./composite-image";
import { buildCoolerHeroWithQA } from "./cooler-hero";
import { isColdCategory } from "./category";
import {
  countDistinctBrands,
  resolveAmazonBrowseNode,
} from "./browse-node-resolver";
import {
  resolveReviewedUncrustablesPackageArt,
  type AuthenticityEvidence,
  type UncrustablesPackMode,
} from "./audit/uncrustables-main-authenticity";
import { PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "./audit/uncrustables-main-production-preflight";

export const UNCRUSTABLES_FROZEN_ANCHOR_SHA256 =
  "9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33";

/** EXACT retail-box decomposition (owner's rule 2026-07-07): the main image may
 *  show boxes ONLY when the piece count splits into real retail boxes with NO
 *  remainder (45 = 3×15; 24 with {10,4} = 10+10+4). Returns the box sizes used
 *  (fewest boxes, larger first), or null when impossible. This generic utility
 *  does not authorize the sizes; production uses the reviewed art registry. */
export function composeRetailBoxes(total: number, sizes: number[]): number[] | null {
  const t = Math.round(total);
  const uniq = Array.from(new Set(sizes.filter((s) => Number.isInteger(s) && s >= 2))).sort((a, b) => b - a);
  if (t <= 0 || uniq.length === 0) return null;
  // best[v] = fewest boxes summing exactly to v (prefer larger boxes on ties).
  const best: Array<number[] | null> = Array.from({ length: t + 1 }, () => null);
  best[0] = [];
  for (let v = 1; v <= t; v++) {
    for (const s of uniq) {
      const prev = v >= s ? best[v - s] : null;
      if (prev && (best[v] === null || prev.length + 1 < best[v]!.length)) {
        best[v] = [...prev, s];
      }
    }
  }
  return best[t] ? best[t]!.sort((a, b) => b - a) : null;
}

export interface ReviewedUncrustablesImagePlanComponent {
  research_pool_id: string;
  product_name: string;
  flavor_id: string;
  pack_mode: UncrustablesPackMode;
  retail_pack_size: number;
  visible_package_count: number;
  art_id: string;
  evidence: AuthenticityEvidence[];
}

export type ReviewedUncrustablesImagePlan =
  | {
      ok: true;
      pack_mode: UncrustablesPackMode;
      components: ReviewedUncrustablesImagePlanComponent[];
    }
  | {
      ok: false;
      pack_mode: UncrustablesPackMode;
      errors: string[];
    };

/**
 * Resolve the presentation from immutable reviewed package art. There is no
 * global fallback size and no approximate carton count: every component must
 * resolve to one exact flavor/mode, and retail-carton quantities must divide by
 * that reviewed carton's genuine printed count.
 */
export function planReviewedUncrustablesImage(args: {
  variant: Variant;
  image_mode: UncrustablesImageMode;
}): ReviewedUncrustablesImagePlan {
  const packMode: UncrustablesPackMode =
    args.image_mode === "individual_wraps"
      ? "individual-wrapper"
      : "retail-carton";
  const components: ReviewedUncrustablesImagePlanComponent[] = [];
  const errors: string[] = [];

  if (args.variant.composition.length === 0) {
    return {
      ok: false,
      pack_mode: packMode,
      errors: ["Uncrustables recipe has no components"],
    };
  }

  for (const component of args.variant.composition) {
    const labels = Array.from(new Set([
      component.flavor?.trim(),
      component.product_name.trim(),
    ].filter((label): label is string => !!label)));
    let candidates: Array<
      NonNullable<ReturnType<typeof resolveReviewedUncrustablesPackageArt>>
    > = [];
    try {
      candidates = labels
        .map((label) =>
          resolveReviewedUncrustablesPackageArt(
            PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
            label,
            packMode,
          ),
        )
        .filter((art): art is NonNullable<typeof art> => art !== null);
    } catch (error) {
      errors.push(
        `${component.product_name}: reviewed registry is invalid (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const unique = Array.from(new Map(candidates.map((art) => [art.art_id, art])).values());
    if (unique.length !== 1) {
      errors.push(
        `${component.product_name}: exact reviewed ${packMode} art is ${unique.length === 0 ? "missing" : "ambiguous"}`,
      );
      continue;
    }
    const art = unique[0];
    if (!Number.isInteger(component.qty) || component.qty <= 0) {
      errors.push(`${component.product_name}: recipe quantity must be a positive integer`);
      continue;
    }
    if (component.qty % art.retail_pack_size !== 0) {
      errors.push(
        `${component.product_name}: recipe quantity ${component.qty} is not divisible by reviewed ${art.retail_pack_size}-count carton`,
      );
      continue;
    }
    components.push({
      research_pool_id: component.research_pool_id,
      product_name: component.product_name,
      flavor_id: art.flavor_id,
      pack_mode: art.pack_mode,
      retail_pack_size: art.retail_pack_size,
      visible_package_count: component.qty / art.retail_pack_size,
      art_id: art.art_id,
      evidence: art.evidence,
    });
  }

  if (errors.length > 0 || components.length !== args.variant.composition.length) {
    return { ok: false, pack_mode: packMode, errors };
  }
  return { ok: true, pack_mode: packMode, components };
}

/** Exact byte binding between a candidate donor reference and reviewed art. */
export function referenceBytesMatchReviewedArt(
  bytes: Uint8Array,
  evidence: AuthenticityEvidence[],
): boolean {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return evidence.some((item) => item.sha256.toLowerCase() === digest);
}

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const REFERENCE_FETCH_TIMEOUT_MS = 20_000;

async function fetchReferenceBytes(url: string): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("reference URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("reference URL must use HTTPS");
  }
  const response = await fetch(parsed, {
    cache: "no-store",
    signal: AbortSignal.timeout(REFERENCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`reference fetch returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REFERENCE_BYTES) {
    throw new Error("reference exceeds 25 MiB");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("reference is empty");
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("reference exceeds 25 MiB");
  }
  return bytes;
}

// Per spec: 2 retries on top of the initial attempt = 3 total tries.
const MAX_IMAGE_RETRIES = 3;

export interface RunImageGenerationInput {
  bundle_draft_id: string;
  /** Optional channel subset. Default = all rows on the draft that are
   *  CAN_PUBLISH + main_image_url IS NULL. */
  channels?: string[];
  /** When true, regenerate even if main_image_url is already set
   *  (UI "regenerate one channel" flow). Defaults to false. */
  force?: boolean;
  actor?: string;
}

export interface ChannelImageOutcome {
  channel: string;
  generated_content_id: string;
  /** Final per-row status after the pipeline ran. */
  compliance_status: "CAN_PUBLISH" | "BLOCKED" | "SKIPPED";
  attempts: number;
  image_url: string | null;
  cost_cents: number;
  manual_review_required: boolean;
  /** Logos that the LAST vision check found, even on success — useful
   *  for the UI's "image OK but Vision saw X" badge. */
  detected_logos: string[];
  error?: string;
}

export interface RunImageGenerationResult {
  ok: boolean;
  bundle_draft_id: string;
  outcomes: ChannelImageOutcome[];
  total_cost_cents: number;
  duration_ms: number;
  /** Non-fatal pipeline-level message — typically "no rows to process". */
  note?: string;
}

/** Frozen/refrigerated → cold-chain (needs the Salutem cooler + gel packs).
 *  Defined in ./category (pure) so the Amazon publish path can share it without
 *  importing this whole module; re-exported here for existing callers/tests. */
export { isColdCategory };

/** Approved frozen-hero style anchors. R2-hosted in prod (the worker fetches
 *  them); falls back to the app's public copies when R2 isn't configured. */
export function frozenAnchorUrls(): string[] {
  const r2 = process.env.R2_PUBLIC_URL;
  if (r2) {
    const base = r2.replace(/\/+$/, "");
    return [
      `${base}/prod/frozen-refs/anchor-uncrustables.png`,
      `${base}/prod/frozen-refs/anchor-jimmy-dean.png`,
    ];
  }
  return [
    "https://salutemsolutions.info/bundle-factory/frozen-refs/ref-uncrustables.png",
    "https://salutemsolutions.info/bundle-factory/frozen-refs/ref-jimmy-dean.png",
  ];
}

// Visible for tests so the prompt rendering can be asserted without
// round-tripping through the image worker.
//
// Phase 3 (frozen-hero rebuild, see docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v1.0.md):
// the MAIN image shows the REAL product (genuine goods we resell) — for a cold
// bundle, inside our Salutem-branded cooler with branded "FROZEN GEL PACK"
// pouches (the product we actually sell is the Salutem gift set). The donor
// product photo + the approved hero anchor are passed as visual references so
// the packaging is accurate and the kit matches the approved look.
/** Own-brand (Uncrustables) main-image style. "retail_boxes" = count-accurate
 *  real cartons (default); "individual_wraps" = the individual flavor-coloured
 *  sandwich wrappers. Vladimir wants both, chosen per batch in the UI. */
export type UncrustablesImageMode = "retail_boxes" | "individual_wraps";

/**
 * The empty-cooler deterministic compositor is an experimental recovery tool,
 * not the production Uncrustables MAIN-image default. Its reusable v1/v2 kit
 * was generated without the owner-approved frozen reference and can therefore
 * drift in logo, gel-pack design, and physical product placement.
 *
 * Keep the opt-in pure and explicit so a missing/empty env value always routes
 * production work through the approved GPT Image reference flow below.
 */
export function shouldUseExperimentalDeterministicCoolerHero(args: {
  category: string;
  composite_eligible: boolean;
  explicit_opt_in?: string;
}): boolean {
  return args.explicit_opt_in === "1"
    && isColdCategory(args.category)
    && args.composite_eligible;
}

export function buildImagePrompt(args: {
  brand: string;
  variant: Variant;
  composition_type: string;
  category: string;
  uncrustables_image_mode?: UncrustablesImageMode;
}): string {
  const products = args.variant.composition
    .map((c) => `${c.qty}× ${c.product_name}`)
    .join(", ");

  if (isColdCategory(args.category)) {
    // Own-brand (Uncrustables/Smucker's) → NOT a gift set; the main image must
    // show a count-accurate number of real retail boxes. Gift set → several
    // boxes of the different products + a "GIFT SET" mark on the cooler.
    const ownBrand =
      isOwnBrandPassthrough(args.brand) ||
      args.variant.composition.some((c) => isOwnBrandPassthrough(c.brand));
    const comp = args.variant.composition;
    const totalUnits = comp.reduce((s, c) => s + c.qty, 0);
    const isMix = comp.length > 1;
    // Use the complete selected donor title in the prompt. Short truncation made
    // different flavors share the same prefix; internal flavor ids are likewise
    // not the package text the model must reproduce.
    const recipeFlavorLabel = (component: Variant["composition"][number]) =>
      component.product_name.trim();
    // Frozen MAIN v2 (owner-approved 2026-07-17–18): presentation is explicit,
    // product art/counts come only from the immutable reviewed registry, and an
    // impossible carton division is a hard stop. No global size list, rounding,
    // or carton→wrapper invention is allowed.
    const imageMode = args.uncrustables_image_mode ?? "retail_boxes";
    const reviewedPlan = ownBrand
      ? planReviewedUncrustablesImage({
          variant: args.variant,
          image_mode: imageMode,
        })
      : null;
    if (reviewedPlan && !reviewedPlan.ok) {
      throw new Error(
        `Uncrustables MAIN image plan blocked: ${reviewedPlan.errors.join("; ")}`,
      );
    }
    const useBoxes = ownBrand && imageMode === "retail_boxes";
    const wraps = ownBrand && imageMode === "individual_wraps";
    const plannedComponents = reviewedPlan?.ok ? reviewedPlan.components : [];
    const GENUINE_DONOR_COUNTS =
      `CRITICAL PACK-COUNT RULE: preserve only the genuine retail pack count actually printed on each product's corresponding reviewed donor reference. Copy that donor count exactly; never erase, replace, borrow, or invent it. The aggregate listing quantity is ${totalUnits} sandwiches: NEVER add ${totalUnits} as a carton badge, wrapper badge, cooler label, gel-pack label, or image overlay merely because it is the listing total. It may appear on product packaging only if that exact reviewed donor art genuinely prints the same retail pack count.`;
    // Anti-fabrication (the "Bright-Eyed Berry" failure): the model must never
    // invent a flavor name, sub-name, tagline or box colour.
    const NO_INVENT =
      `CRITICAL: use ONLY the real Smucker's Uncrustables flavor name(s) exactly as printed on the reference product photo(s). Do NOT invent any flavor name, sub-name, tagline, or box colour (for example, never a made-up name like "Bright-Eyed Berry"). Copy the reference packaging faithfully; if unsure, reproduce it verbatim rather than guessing.`;
    const mixBoxSpec = plannedComponents.map((planned, index) => {
      const component = comp[index];
      return `EXACTLY ${planned.visible_package_count} genuine ${planned.retail_pack_size}-count carton${planned.visible_package_count === 1 ? "" : "s"} of ${recipeFlavorLabel(component)} from reference #${index + 2}`;
    }).join(", ");
    const singlePlan = plannedComponents[0];
    const singleBoxLine = singlePlan
      ? `Place EXACTLY ${singlePlan.visible_package_count} real Uncrustables retail carton${singlePlan.visible_package_count === 1 ? "" : "s"} inside the cooler. Every carton must be an exact copy of reviewed reference #2, including its genuine printed ${singlePlan.retail_pack_size}-count badge; ${singlePlan.visible_package_count} × ${singlePlan.retail_pack_size} reconciles exactly to ${totalUnits} sandwiches. Arrange a neat physically seated stack. Never show a generic carton or loose sandwiches mixed with cartons.`
      : `Place the exact real recipe products inside the cooler.`;
    const boxLine = useBoxes
      ? (isMix
          ? `Place this exact reviewed carton plan inside the cooler: ${mixBoxSpec}. The visible carton plan reconciles exactly to ${totalUnits} sandwiches. Reproduce each flavor's genuine Uncrustables carton exactly from ITS reference, including its real wordmark, flavor name, colors, art, and genuine donor count badge. Show every recipe flavor, never merge designs, never add a look-alike flavor, and never show loose sandwiches.`
          : singleBoxLine)
      : wraps
        ? (isMix
            ? `Fill the cooler with EXACTLY ${totalUnits} individually wrapped Smucker's Uncrustables sandwiches in tidy rows: ${comp.map((c, index) => `EXACTLY ${c.qty} wrappers of ${recipeFlavorLabel(c)} from reviewed wrapper reference #${index + 2}`).join(", ")}. One genuine sealed wrapper equals one sandwich. Preserve every flavor's exact real wrapper wordmark, flavor text, colors, and artwork. Show no retail cartons, bare sandwiches, plain wrappers, generic wrappers, merged designs, or extra flavors.`
            : `Fill the cooler with EXACTLY ${totalUnits} individually wrapped Smucker's Uncrustables sandwiches in neat rows. Every unit is one genuine sealed wrapper copied exactly from reviewed wrapper reference #2, including the real wordmark, flavor text, colors, and artwork. Show no retail cartons, bare sandwiches, plain wrappers, generic wrappers, or extra flavors.`)
        : `Place several of the real product boxes inside the cooler, arranged as a gift set.`;
    const presentationLabel = wraps ? "individual-wrapper" : "retail-carton";
    const productRefLine = ownBrand
      ? isMix
        ? `Reference images #2..#${comp.length + 1} are SHA-verified reviewed ${presentationLabel} art for the recipe flavors, in order: ${comp.map((c, i) => `#${i + 2} = "${recipeFlavorLabel(c)}"`).join(", ")}. Copy each flavor only from ITS reference. Do not derive wrapper art from a carton, do not invent look-alike flavors, and do not omit a flavor.`
        : `The SECOND reference image is SHA-verified reviewed ${presentationLabel} art for ${products}. Copy its genuine Smucker's Uncrustables brand, exact flavor name, colors, artwork, and any genuine donor count verbatim. Do not convert a carton into invented wrapper art, do not rebrand, and do not substitute a look-alike.`
      : isMix
        ? `Reference images #2..#${comp.length + 1} are the genuine recipe products in order: ${comp.map((c, i) => `#${i + 2} = "${recipeFlavorLabel(c)}"`).join(", ")}. Copy each product only from its own reference.`
        : `The SECOND reference image is the genuine donor product photo for ${products}. Reproduce its product packaging accurately; do not rebrand or substitute a look-alike.`;
    const coolerLine = ownBrand
      ? `The cooler is the exact white textured EPS insulated shipping cooler from reference #1, at the same realistic 3/4 front angle with its lid leaning behind. Preserve the exact ornate green Salutem emblem, black SALUTEM SOLUTIONS wordmark, and black OUR BEST SOLUTIONS FOR YOU slogan.`
      : `The cooler is a white EPS styrofoam insulated shipping cooler carrying the SALUTEM SOLUTIONS logo AND the printed words "GIFT SET" (realistic 3/4 front angle, lid leaning behind the cooler).`;
    return [
      `A professional e-commerce main listing image on a pure white background, square 1:1.`,
      ownBrand
        ? `This is a frozen multipack assembled and shipped by SALUTEM SOLUTIONS.`
        : `This is a frozen gift set assembled and shipped by SALUTEM SOLUTIONS.`,
      productRefLine,
      `The FIRST reference image is the immutable KIT ANCHOR — copy its exact styrofoam cooler, ornate green emblem, black wordmark/slogan, four gel packs, camera, lighting, and overall layout only; never copy its third-party products.`,
      coolerLine,
      boxLine,
      ...(ownBrand ? [GENUINE_DONOR_COUNTS, NO_INVENT] : []),
      `Show EXACTLY 4 white sealed branded gel packs in the approved layout: two inside the cooler, one on the left and one on the right of the products, plus two standing outside along the front/right presentation area. Every pack keeps the BLUE "FROZEN GEL PACK" header, BLUE "KEEP FROZEN" / "FOR FROZEN SHIPMENTS" wording, ornate green emblem, and black Salutem wordmark/slogan from anchor #1.`,
      `All cartons or wrappers must be physically seated inside the cooler cavity: lower edges occluded behind the front inner rim, shared perspective and lighting, realistic scale and overlap, believable cavity depth, and contact shadows. No floating products, gaps below products, alpha halos, flat pasted edges, or impossible cooler-wall intersections.`,
      `Apply SALUTEM SOLUTIONS branding ONLY to the cooler and the gel packs — NEVER onto the third-party product packaging.`,
      `Subtle frost and cold condensation on the cooler and packs; NO loose ice, NO crushed ice, NO ice cubes.`,
      // The donor photo is often scraped from a retailer site and carries a store
      // badge/watermark; the vision compliance gate (rule 6) rejects any retailer
      // logo. Reproduce ONLY the product packaging, never the store's marks.
      `Reproduce ONLY the product's own packaging. Do NOT copy any retailer logo, store badge, price sticker, "roll-back", corner ribbon, or watermark from the reference photo — no Target, Walmart, Amazon, Costco, Sam's Club or any store branding anywhere in the image.`,
      `No people, no hands, no lifestyle background, no extra props, no overlaid text, no watermarks.`,
    ].join("\n");
  }

  // Shelf-stable → clean gift set of the real products on white, no cooler.
  return [
    `A professional e-commerce main listing image on a pure white background, square 1:1.`,
    `Show the real product shown in the product reference photo: ${products}. Reproduce the actual retail packaging accurately; do NOT rebrand it.`,
    `Arrange the items neatly as a gift set, products filling roughly 85% of the frame, soft even lighting, sharp focus, accurate colour.`,
    `No cooler, no gel packs. No people, no lifestyle background, no extra props, no overlaid text, no watermarks.`,
  ].join("\n");
}

function parseBundleComponents(
  raw: string | null,
  fallback: Variant,
): BundleComponentInput[] {
  // Prefer the variant composition (canonical Stage 3 data) — falls back
  // to draft_components only if the variant is somehow empty.
  if (fallback.composition.length > 0) {
    return fallback.composition.map((c) => ({
      brand: c.brand,
      product_name: c.product_name,
    }));
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((c) => ({
        brand: typeof c.brand === "string" ? c.brand : "",
        product_name:
          typeof c.product_name === "string" ? c.product_name : undefined,
      }));
  } catch {
    return [];
  }
}

export async function runImageGeneration(
  input: RunImageGenerationInput,
): Promise<RunImageGenerationResult> {
  const startMs = Date.now();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
    include: {
      variation_matrix: true,
      generated_content: { orderBy: { channel: "asc" } },
    },
  });
  if (!draft) {
    throw new NotFoundError(`BundleDraft ${input.bundle_draft_id} not found`);
  }
  if (!draft.variation_matrix) {
    throw new PreconditionError(
      `BundleDraft ${draft.id} has no VariationMatrix — content/variant must be set first`,
    );
  }
  const matrix = draft.variation_matrix;
  if (matrix.selected_variant_idx == null) {
    throw new PreconditionError(`BundleDraft ${draft.id} has no selected variant`);
  }

  let variants: Variant[];
  try {
    variants = JSON.parse(matrix.variants_json) as Variant[];
  } catch (e) {
    throw new Error(
      `VariationMatrix.variants_json malformed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const selected = variants[matrix.selected_variant_idx];
  if (!selected) {
    throw new Error(
      `Selected variant idx ${matrix.selected_variant_idx} out of range`,
    );
  }

  // Filter to processable rows.
  const allRows = draft.generated_content;
  const candidateChannels =
    input.channels && input.channels.length > 0
      ? new Set(input.channels)
      : null;

  const rowsToProcess = allRows.filter((r) => {
    if (candidateChannels && !candidateChannels.has(r.channel)) return false;
    const retryableImageBlock =
      input.force &&
      r.compliance_status === "BLOCKED" &&
      r.manual_review_required &&
      r.image_retry_count > 0;
    if (r.compliance_status !== "CAN_PUBLISH" && !retryableImageBlock) return false;
    if (!input.force && r.main_image_url) return false;
    return true;
  });

  if (rowsToProcess.length === 0) {
    return {
      ok: true,
      bundle_draft_id: draft.id,
      outcomes: [],
      total_cost_cents: 0,
      duration_ms: Date.now() - startMs,
      note:
        "No rows to process — every CAN_PUBLISH channel either already has an image, or no channel was requested.",
    };
  }

  // Flip status to IMAGE_GENERATING (only if we're stepping forward from
  // GENERATED — re-runs from later states keep their status).
  const fromStatus = draft.status;
  if (fromStatus === "GENERATED") {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "IMAGE_GENERATING" },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: fromStatus,
      to_status: "IMAGE_GENERATING",
      reason: `Image pipeline started for ${rowsToProcess.length} channel(s)`,
      actor: input.actor ?? "system",
    });
  }

  const outcomes: ChannelImageOutcome[] = [];
  let totalCost = 0;

  // Owner-approved production default: GPT Image receives the reviewed frozen
  // style anchor first, followed by one genuine donor reference per flavor (see
  // the referenceUrls construction below). The deterministic empty-cooler v1/v2
  // compositor is retained only for isolated experiments because its kit and
  // hard-coded cutout layout were explicitly rejected in visual review.
  const deterministicCoolerPath = shouldUseExperimentalDeterministicCoolerHero({
    category: draft.category,
    composite_eligible: compositeEligible({ brand: draft.brand, variant: selected }).eligible,
    explicit_opt_in: process.env.BF_EXPERIMENTAL_DETERMINISTIC_COOLER_HERO,
  });

  if (deterministicCoolerPath) {
    const stamp = Date.now().toString(36);
    const built = await buildCoolerHeroWithQA({
      variant: selected,
      r2_slug: `draft-${draft.id}`,
      stamp,
      experimental_opt_in: true,
    });
    const passed = built.ok && !!built.image_url && !!built.qa?.pass && !!built.qa?.verified;
    if (passed && built.image_url) {
      await prisma.bundleDraft.update({
        where: { id: draft.id },
        data: { draft_main_image_url: built.image_url },
      });
    }
    for (const row of rowsToProcess) {
      if (passed && built.image_url) {
        await prisma.generatedContent.update({
          where: { id: row.id },
          data: {
            main_image_url: built.image_url,
            compliance_status: "CAN_PUBLISH",
            manual_review_required: false,
            image_generated_at: new Date(),
            image_retry_count: built.attempts,
          },
        });
        outcomes.push({
          channel: row.channel,
          generated_content_id: row.id,
          compliance_status: "CAN_PUBLISH",
          attempts: built.attempts,
          image_url: built.image_url,
          cost_cents: 0,
          manual_review_required: false,
          detected_logos: [],
        });
      } else {
        await prisma.generatedContent.update({
          where: { id: row.id },
          data: {
            compliance_status: "BLOCKED",
            manual_review_required: true,
            ...(built.image_url ? { main_image_url: built.image_url } : {}),
          },
        });
        outcomes.push({
          channel: row.channel,
          generated_content_id: row.id,
          compliance_status: "BLOCKED",
          attempts: built.attempts,
          image_url: built.image_url ?? null,
          cost_cents: 0,
          manual_review_required: true,
          detected_logos: [],
          error: built.qa?.hard_fails?.join("; ") || built.error || "deterministic cooler hero QA failed",
        });
      }
    }
  } else {
    const bundleComponents = parseBundleComponents(
      draft.draft_components,
      selected,
    );

    // Resolve the batch's Uncrustables image style (retail boxes vs individual
    // flavor-coloured wraps) from the parent GenerationJob brief. Default: boxes.
    let uncrustablesImageMode: UncrustablesImageMode = "retail_boxes";
    if (draft.generation_job_id) {
      const job = await prisma.generationJob.findUnique({
        where: { id: draft.generation_job_id },
        select: { brief: true },
      });
      try {
        const brief = JSON.parse(job?.brief ?? "{}") as { uncrustables_image_mode?: string };
        if (brief?.uncrustables_image_mode === "individual_wraps") {
          uncrustablesImageMode = "individual_wraps";
        }
      } catch {
        /* keep default */
      }
    }
    // Per-run override (regeneration fixes): BF_UNCR_MODE forces the style.
    if (process.env.BF_UNCR_MODE === "individual_wraps") uncrustablesImageMode = "individual_wraps";
    else if (process.env.BF_UNCR_MODE === "retail_boxes") uncrustablesImageMode = "retail_boxes";

    const ownBrandUncrustables =
      isColdCategory(draft.category) &&
      (isOwnBrandPassthrough(draft.brand) ||
        selected.composition.some((component) =>
          isOwnBrandPassthrough(component.brand),
        ));
    const reviewedImagePlan = ownBrandUncrustables
      ? planReviewedUncrustablesImage({
          variant: selected,
          image_mode: uncrustablesImageMode,
        })
      : null;
    const referenceErrors: string[] = [];
    if (reviewedImagePlan && !reviewedImagePlan.ok) {
      referenceErrors.push(...reviewedImagePlan.errors);
    }
    let basePrompt = "";
    if (referenceErrors.length === 0) {
      try {
        basePrompt = buildImagePrompt({
          brand: draft.brand,
          variant: selected,
          composition_type: draft.composition_type,
          category: draft.category,
          uncrustables_image_mode: uncrustablesImageMode,
        });
      } catch (error) {
        referenceErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Phase 3 references passed to the image worker — ORDER MATTERS. The worker
    // role-labels them by position: ref-1 = the KIT ANCHOR (Salutem cooler +
    // gel-pack look/layout), refs 2..N = the DONOR PHOTO of EACH flavor in
    // composition order (a mix needs every flavor's real colours, or the model
    // renders only the first — Vladimir 2026-07-08). Anchor FIRST so Codex treats
    // it as layout, not product. The worker fetches these URLs.
    const referenceUrls: string[] = [];
    if (isColdCategory(draft.category)) referenceUrls.push(frozenAnchorUrls()[0]);
    // One donor photo per flavor, in the SAME order buildImagePrompt lists them
    // (composition order). Look each donor up by its research_pool_id.
    const donorIds = selected.composition.map((c) => c.research_pool_id).filter(Boolean);
    const donorReferenceUrls: string[] = [];
    if (donorIds.length > 0) {
      const donorRows = await prisma.donorProduct.findMany({
        where: { id: { in: donorIds } },
        select: { id: true, mainImageUrl: true },
      });
      const byId = new Map(donorRows.map((d) => [d.id, d.mainImageUrl]));
      for (const c of selected.composition) {
        const url = byId.get(c.research_pool_id);
        if (url) {
          referenceUrls.push(url);
          donorReferenceUrls.push(url);
        } else {
          referenceErrors.push(`missing ordered donor reference: ${c.product_name}`);
        }
      }
    } else if (selected.composition.length > 0) {
      referenceErrors.push(
        ...selected.composition.map(
          (component) => `missing ordered donor reference: ${component.product_name}`,
        ),
      );
    }
    // Fallback to the draft's primary photo if no component donor resolved.
    // Never use it for Uncrustables: its bytes/presentation are not bound to the
    // reviewed per-flavor registry evidence.
    if (
      !ownBrandUncrustables &&
      referenceUrls.length <= 1 &&
      draft.draft_main_image_url
    ) {
      referenceUrls.push(draft.draft_main_image_url);
    }

    // Byte-level preflight: URL labels and product titles are insufficient.
    // The anchor and every product reference must hash to the exact reviewed
    // evidence before GPT Image sees them. This also prevents a carton-only
    // donor URL from authorizing invented individual-wrapper art.
    if (
      ownBrandUncrustables &&
      reviewedImagePlan?.ok &&
      donorReferenceUrls.length === reviewedImagePlan.components.length
    ) {
      const fetchCache = new Map<string, Promise<Uint8Array>>();
      const bytesFor = (url: string) => {
        const cached = fetchCache.get(url);
        if (cached) return cached;
        const pending = fetchReferenceBytes(url);
        fetchCache.set(url, pending);
        return pending;
      };
      const checks = [
        (async (): Promise<string | null> => {
          const anchorUrl = referenceUrls[0];
          if (!anchorUrl) return "approved frozen-kit anchor is missing";
          try {
            const bytes = await bytesFor(anchorUrl);
            const digest = createHash("sha256").update(bytes).digest("hex");
            return digest === UNCRUSTABLES_FROZEN_ANCHOR_SHA256
              ? null
              : `frozen-kit anchor SHA-256 mismatch (${digest})`;
          } catch (error) {
            return `frozen-kit anchor verification failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        })(),
        ...reviewedImagePlan.components.map(async (planned, index) => {
          const url = donorReferenceUrls[index];
          if (!url) return `${planned.product_name}: reviewed donor URL is missing`;
          try {
            const bytes = await bytesFor(url);
            return referenceBytesMatchReviewedArt(bytes, planned.evidence)
              ? null
              : `${planned.product_name}: donor reference bytes do not match reviewed ${planned.pack_mode} art ${planned.art_id}`;
          } catch (error) {
            return `${planned.product_name}: donor reference verification failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }),
      ];
      const findings = await Promise.all(checks);
      referenceErrors.push(
        ...findings.filter((finding): finding is string => finding !== null),
      );
    }

    for (const row of rowsToProcess) {
      if (referenceErrors.length > 0) {
        const error = `reference/prompt preflight failed: ${referenceErrors.join("; ")}`;
        await prisma.generatedContent.update({
          where: { id: row.id },
          data: {
            compliance_status: "BLOCKED",
            manual_review_required: true,
          },
        });
        outcomes.push({
          channel: row.channel,
          generated_content_id: row.id,
          compliance_status: "BLOCKED",
          attempts: 0,
          image_url: row.main_image_url,
          cost_cents: 0,
          manual_review_required: true,
          detected_logos: [],
          error,
        });
        continue;
      }
      const outcome = await processOneRow({
        row,
        draft_id: draft.id,
        brand: draft.brand,
        title: row.title,
        bullets: safeJsonStringArray(row.bullets_json),
        description: row.description,
        basePrompt,
        bundleComponents,
        referenceUrls,
        actor: input.actor ?? "system",
      });
      outcomes.push(outcome);
      totalCost += outcome.cost_cents;
    }
  }

  // Final draft-level status transition. A new image is mutable listing
  // content: once a MasterBundle exists, every prior validation/approval is
  // stale and must be cleared before another marketplace distribution.
  const successCount = outcomes.filter(
    (o) => o.compliance_status === "CAN_PUBLISH",
  ).length;
  const allDone = await everyTargetRowHasVerifiedImage(draft.id);
  let nextStatus = draft.status;
  const IMAGE_STAGE = ["GENERATED", "IMAGE_GENERATING", "IMAGE_GENERATED", "ERROR"];
  const invalidatesDownstream = successCount > 0 && !!draft.master_bundle_id;
  if (invalidatesDownstream || IMAGE_STAGE.includes(draft.status)) {
    nextStatus = allDone ? "IMAGE_GENERATED" : "ERROR";
  }

  if (nextStatus !== draft.status || invalidatesDownstream) {
    const updateData: {
      status: string;
      image_generated_at?: Date;
      approved_at?: null;
      approved_by?: null;
      approval_notes?: null;
    } = {
      status: nextStatus,
    };
    if (nextStatus === "IMAGE_GENERATED") {
      updateData.image_generated_at = new Date();
    }
    if (invalidatesDownstream) {
      updateData.approved_at = null;
      updateData.approved_by = null;
      updateData.approval_notes = null;
    }
    await prisma.$transaction(async (tx) => {
      await tx.bundleDraft.update({
        where: { id: draft.id },
        data: updateData,
      });
      if (invalidatesDownstream && draft.master_bundle_id) {
        await tx.channelSKU.updateMany({
          where: { master_bundle_id: draft.master_bundle_id },
          data: {
            validation_status: "PENDING",
            validation_errors: null,
            validated_at: null,
            validation_check_id: null,
            available_quantity: null,
            inventory_checked_at: null,
          },
        });
      }
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: nextStatus,
      reason: invalidatesDownstream
        ? `Image changed; prior validation and approval invalidated (${successCount}/${outcomes.length} compliant)`
        : nextStatus === "IMAGE_GENERATED"
          ? `Image pipeline finished — ${successCount}/${outcomes.length} verified`
          : `Image pipeline incomplete — ${successCount}/${outcomes.length} verified`,
      actor: input.actor ?? "system",
      details: {
        total_cost_cents: totalCost,
        outcomes: outcomes.map((o) => ({
          channel: o.channel,
          status: o.compliance_status,
          attempts: o.attempts,
        })),
      },
    });
  }

  return {
    ok: successCount > 0,
    bundle_draft_id: draft.id,
    outcomes,
    total_cost_cents: totalCost,
    duration_ms: Date.now() - startMs,
  };
}

// ── Per-row inner loop ─────────────────────────────────────────────────

interface ProcessOneRowInput {
  row: {
    id: string;
    channel: string;
    title: string;
    bullets_json: string;
    description: string;
    image_retry_count: number;
  };
  draft_id: string;
  brand: string;
  title: string;
  bullets: string[];
  description: string;
  basePrompt: string;
  bundleComponents: BundleComponentInput[];
  referenceUrls: string[];
  actor: string;
}

async function processOneRow(
  args: ProcessOneRowInput,
): Promise<ChannelImageOutcome> {
  const { row, draft_id, brand, basePrompt, bundleComponents } = args;
  const r2Slug = `draft-${draft_id}-${row.channel}`.toLowerCase();
  const isUncrustablesRecipe = bundleComponents.some((component) =>
    /uncrustables/i.test(component.product_name ?? ""),
  );
  const expectedBrandMarks = Array.from(new Set([
    brand,
    ...bundleComponents.map((component) => component.brand),
    ...(isUncrustablesRecipe ? ["Smucker's", "Uncrustables"] : []),
    // The frozen kit is a real part of the photographed bundle. Vision may
    // surface its approved packaging mark alongside the donor product marks.
    ...(/FROZEN GEL PACK|gel packs/i.test(basePrompt)
      ? ["SALUTEM SOLUTIONS", "Salutem"]
      : []),
  ].map((mark) => mark.trim()).filter(Boolean)));

  let attempt = 0;
  let totalCost = 0;
  let lastImageUrl: string | null = null;
  let lastDetectedLogos: string[] = [];
  let lastError: string | undefined;
  let priorFailure: RewriteFeedback | undefined;

  while (attempt < MAX_IMAGE_RETRIES) {
    attempt++;

    const imgResult = await generateMainImage({
      prompt: basePrompt,
      r2_path_slug: r2Slug,
      reference_urls: args.referenceUrls,
      retry_context: priorFailure
        ? { ...priorFailure, attempt }
        : undefined,
    });
    totalCost += imgResult.cost_cents;

    if (imgResult.error && !imgResult.image_url) {
      // Transient worker failures are retryable. Persist every attempt/cost so
      // a killed process leaves an honest checkpoint instead of a phantom try.
      lastError = imgResult.error;
      priorFailure = {
        attempt,
        detected_logos: [],
        failure_reason: imgResult.error,
        expected_brand_marks: expectedBrandMarks,
      };
      await prisma.generatedContent.update({
        where: { id: row.id },
        data: {
          image_generation_cost_cents: { increment: imgResult.cost_cents },
          image_retry_count: attempt,
        },
      });
      continue;
    }
    lastImageUrl = imgResult.image_url;

    // Persist preliminary URL so it's recoverable if the process dies
    // mid-compliance-check.
    await prisma.generatedContent.update({
      where: { id: row.id },
      data: {
        main_image_url: lastImageUrl,
        image_generation_cost_cents: { increment: imgResult.cost_cents },
        image_retry_count: attempt,
      },
    });

    if (!lastImageUrl) {
      // Mock/dev fallback returned null — treat as terminal soft fail.
      lastError = imgResult.error ?? "image generation returned no URL";
      break;
    }

    // Run compliance gate WITH image check this time. Rules 1-5+7-8 will
    // re-pass trivially (text didn't change), only Rule 6 is the real
    // gate here.
    const decision = await runComplianceGate(
      {
        bundle_draft_id: draft_id,
        title: args.title,
        brand,
        bullets: args.bullets,
        description: args.description,
        browse_node: resolveAmazonBrowseNode({
          channel: row.channel,
          distinct_brands: countDistinctBrands(bundleComponents),
        }),
        main_image_url: lastImageUrl,
        bundle_components: bundleComponents,
        skip_image_check: false,
      },
      { autoFix: false, actor: args.actor },
    );
    lastDetectedLogos = decision.detected_logos;

    if (decision.decision === "CAN_PUBLISH") {
      await prisma.generatedContent.update({
        where: { id: row.id },
        data: {
          compliance_status: "CAN_PUBLISH",
          compliance_check_id: decision.compliance_check_id ?? null,
          manual_review_required: false,
          image_generated_at: new Date(),
        },
      });
      return {
        channel: row.channel,
        generated_content_id: row.id,
        compliance_status: "CAN_PUBLISH",
        attempts: attempt,
        image_url: lastImageUrl,
        cost_cents: totalCost,
        manual_review_required: false,
        detected_logos: lastDetectedLogos,
      };
    }

    // BLOCKED — build stronger retry feedback from Rule 6's findings.
    const rule6 = decision.rules.find(
      (r) => r.rule_id === "rule-6-image-vision-check",
    );
    priorFailure = {
      attempt,
      detected_logos: lastDetectedLogos,
      failure_reason: rule6?.reason ?? "image_compliance_failed",
      expected_brand_marks: expectedBrandMarks,
    };
  }

  // Exhausted retries — manual review.
  await prisma.generatedContent.update({
    where: { id: row.id },
    data: {
      compliance_status: "BLOCKED",
      manual_review_required: true,
      image_retry_count: attempt,
      // Keep last preview URL for the manual reviewer to look at; they
      // can either approve override or send back to regenerate.
    },
  });

  return {
    channel: row.channel,
    generated_content_id: row.id,
    compliance_status: "BLOCKED",
    attempts: attempt,
    image_url: lastImageUrl,
    cost_cents: totalCost,
    manual_review_required: true,
    detected_logos: lastDetectedLogos,
    error: lastError,
  };
}

async function everyTargetRowHasVerifiedImage(draftId: string): Promise<boolean> {
  // A BLOCKED/manual-review row is not "done". The old predicate ignored those
  // rows and could advance a completely failed draft to IMAGE_GENERATED.
  const invalid = await prisma.generatedContent.count({
    where: {
      bundle_draft_id: draftId,
      OR: [
        { compliance_status: { not: "CAN_PUBLISH" } },
        { main_image_url: null },
        { manual_review_required: true },
        { image_generated_at: null },
      ],
    },
  });
  return invalid === 0;
}

function safeJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
