/**
 * Real-photo main-image generator for own-brand Uncrustables/Smucker's frozen
 * multipacks — the IP-safe replacement for AI packaging generation.
 *
 * Owner mandate (2026-07-08): "картинки должны генериться 100% теми вкусами,
 * которые есть, ну и на 95% они должны быть похожи на оригинал" — an AI model
 * can invent look-alike flavors / garble printed text, which is a trademark
 * risk. This path never generates packaging: it composites the REAL donor
 * retail-box photos (untouched pixels) into a clean grid on pure white. The
 * flavor is 100% faithful because it IS the real product photo.
 *
 * THE IDEAL PICTURE (what the QA officer checks against):
 *   • Pure-white 1:1 background, no cooler, no props, no overlaid text/badges.
 *   • Real Uncrustables retail boxes the buyer's pack is built from:
 *       SINGLE flavor → EXACTLY N identical real boxes, count-accurate
 *                       (N = pieces ÷ box pack size; must divide evenly).
 *       MIX           → a VARIETY grid of the real boxes of EVERY flavor
 *                       (a mix is repacked loose, so per-flavor piece counts
 *                       need not divide a box; boxes shown ≈ qty ÷ pack, min 1,
 *                       and the exact count lives in the title + info card).
 *   • No fabricated flavor, no printed quantity number, no retailer watermark.
 *
 * Frozen cooler / "ships frozen" story lives on a SECONDARY image, not here
 * (Amazon's main image must be product-on-white; the AI cooler-hero broke that).
 */

import { prisma } from "@/lib/prisma";
import type { Variant } from "./variation-matrix";
import { isOwnBrandPassthrough } from "./own-brand";
import { parsePackUnits } from "./donor-dedup";
import {
  composeUnitGrid,
  extractProduct,
  fetchImageBuffer,
  highResImageUrl,
} from "@/lib/walmart/multipack/composite";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";
import { qaCompositeImage, type CompositeQaResult } from "./audit/composite-qa";

/** Standard Uncrustables retail box sizes, used only when a component carries
 *  no explicit pack size and none can be parsed from its donor title. */
const DEFAULT_PACK = 4;
/** Cap the number of boxes shown so a huge count doesn't shrink each box below
 *  recognisability in a search thumbnail. Above this we still render (real is
 *  real) but the QA officer will flag it as hard to read. */
const MAX_BOXES = 24;

export interface CompositePlanItem {
  flavor: string;
  donor_id: string;
  pack: number;
  qty: number;
  boxes: number;
  /** The actual photo URL used (may be a cleaner same-flavor sibling). */
  photo_url?: string;
  /** How many candidate photos were available for this flavor. */
  candidates?: number;
}

/** Fruit words that distinguish one Uncrustables flavor line from another. */
const FRUIT_WORDS = [
  "raspberry", "grape", "strawberry", "honey", "chocolate", "hazelnut",
  "blueberry", "apple", "cinnamon", "wildberry", "banana",
] as const;
/** Sub-line qualifiers that must MATCH between two photos to be the same flavor
 *  (a Protein box is not the classic box; reduced-sugar / whole-wheat differ). */
const SUBLINE_QUALIFIERS = ["protein", "reduced sugar", "whole wheat"] as const;

function fruitsIn(s: string): string[] {
  const l = (s || "").toLowerCase();
  return FRUIT_WORDS.filter((f) => l.includes(f));
}
function qualifiersIn(s: string): string[] {
  const l = (s || "").toLowerCase().replace(/-/g, " ");
  return SUBLINE_QUALIFIERS.filter((q) => l.includes(q));
}

/** Two product names are the SAME Uncrustables flavor when they share a fruit
 *  AND agree on every sub-line qualifier (protein / reduced-sugar / whole-wheat)
 *  — so a cleaner sibling photo we borrow is truly the same flavor (≥95%
 *  faithful, the owner's IP bar), never a look-alike sub-variant. */
export function sameFlavor(a: string, b: string): boolean {
  const fa = fruitsIn(a), fb = fruitsIn(b);
  if (!fa.length || !fb.length) return false;
  if (!fa.some((f) => fb.includes(f))) return false;
  const qa = new Set(qualifiersIn(a)), qb = new Set(qualifiersIn(b));
  for (const q of SUBLINE_QUALIFIERS) if (qa.has(q) !== qb.has(q)) return false;
  return true;
}

/** Cleanliness rank for a source photo URL (lower = preferred). Target
 *  "scene7" studio shots are reliably clean product-on-white; Walmart "seo"
 *  images frequently carry a "NEW: …" marketing banner baked into the pixels
 *  (which the QA officer rejects); salsify/video frames are the worst. */
export function photoScore(url: string): number {
  const u = (url || "").toLowerCase();
  if (u.includes("target.scene7.com")) return 0;
  if (u.includes("walmartimages.com/asr/")) return 1;
  if (u.includes("m.media-amazon.com") || u.includes("ssl-images-amazon")) return 1;
  if (u.includes("walmartimages.com/seo/")) return 3;
  if (u.includes("salsify") || u.includes("/video/")) return 4;
  return 2;
}

function parseGallery(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface CompositeResult {
  ok: boolean;
  image_url: string | null;
  plan: CompositePlanItem[];
  total_boxes: number;
  total_units: number;
  /** Always 0 — deterministic sharp compositing, no AI, no metered spend. */
  cost_cents: 0;
  error?: string;
}

/** Retail box pack size for a SPECIFIC donor photo: its own title parse first
 *  ("…22.4oz/8ct" → 8), since that reflects the actual box in the photo; then
 *  the composition's retail_pack_sizes (a size-SET, less specific); then 4. */
function packForDonor(donorTitle?: string | null, fallbackRps?: unknown): number {
  const fromTitle = donorTitle ? parsePackUnits(donorTitle) : null;
  if (fromTitle && fromTitle >= 2) return fromTitle;
  if (Array.isArray(fallbackRps)) {
    const first = fallbackRps.find((n): n is number => typeof n === "number" && n >= 2);
    if (first) return first;
  }
  return DEFAULT_PACK;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

/** Whole real boxes to SHOW for a flavor given a chosen box pack. Count-exact
 *  when the pieces divide the pack (pieces ÷ pack); otherwise the nearest whole
 *  number of real boxes (min 1). NEVER null: an own-brand cold draft ALWAYS
 *  renders real boxes — a count-approximate real photo beats a fabricated AI
 *  image (the IP mandate dominates; the exact count lives in the title). */
export function boxesForComponent(qty: number, pack: number): number {
  const p = pack >= 2 ? pack : DEFAULT_PACK;
  return qty % p === 0 ? qty / p : Math.max(1, Math.round(qty / p));
}

/** Is this variant a candidate for the real-photo composite path? Own-brand
 *  Uncrustables/Smucker's with a non-empty composition ALWAYS qualifies — we can
 *  always composite the real boxes (count-exact when a box size divides evenly,
 *  count-approximate otherwise). Never skip: a real photo always beats AI. */
export function compositeEligible(args: {
  brand: string;
  variant: Variant;
}): EligibilityResult {
  const comp = args.variant.composition ?? [];
  if (comp.length === 0) return { eligible: false, reason: "empty composition" };
  const ownBrand =
    isOwnBrandPassthrough(args.brand) ||
    comp.some((c) => isOwnBrandPassthrough(c.brand));
  if (!ownBrand) return { eligible: false, reason: "not own-brand (gift set uses AI path)" };
  return { eligible: true };
}

/**
 * Build the real-photo composite main image and upload it to R2.
 * Returns ok:false (no throw) when a donor photo can't be resolved/fetched — the
 * caller decides what to do (skip / flag). Never fails on count-divisibility:
 * an approximate whole-box count is always rendered from real pixels.
 */
export async function buildCompositeMainImage(args: {
  variant: Variant;
  /** R2 key prefix, typically `draft-<id>-<channel>`. */
  r2Slug: string;
  /** Date stamp for the R2 key (libs don't call Date.now — caller passes it). */
  stamp: string;
  /** Per-flavor photo choice (keyed by research_pool_id): which ranked candidate
   *  to use. The QA-driven retry bumps this when the officer rejects a photo. */
  photoOffsets?: Record<string, number>;
}): Promise<CompositeResult> {
  const comp = args.variant.composition ?? [];
  const plan: CompositePlanItem[] = [];
  const empty: CompositeResult = {
    ok: false, image_url: null, plan: [], total_boxes: 0, total_units: 0, cost_cents: 0,
  };
  if (comp.length === 0) return { ...empty, error: "empty composition" };

  // Load the Uncrustables/Smucker's donor pool once so each flavor can borrow a
  // CLEANER same-flavor sibling photo (Target studio shot) when its own primary
  // photo carries a marketing banner. One query, filtered per flavor in JS.
  const pool = await prisma.donorProduct.findMany({
    where: {
      OR: [
        { brand: { in: ["Uncrustables", "Smucker's", "Smuckers", "Smucker’s"] } },
        { title: { contains: "Uncrustables" } },
      ],
    },
    select: { id: true, title: true, mainImageUrl: true, imageUrls: true },
  });
  const poolById = new Map(pool.map((d) => [d.id, d]));

  interface BoxOption { url: string; pack: number; boxes: number; exact: boolean; score: number; }

  /** Ranked, deduped box options for one flavor. Each candidate photo (the
   *  primary donor's own images + every same-flavor sibling's images) carries
   *  ITS box pack (from its own title). We prefer a photo whose box size divides
   *  the piece count EXACTLY (count-accurate) — e.g. a Target 4-count raspberry
   *  box gives 24 → 6 boxes exactly, where the primary 10-count box can't — then
   *  break ties by cleanliness, then fewer boxes. */
  function boxOptions(c: { product_name: string; research_pool_id: string; qty: number; retail_pack_sizes?: unknown }): BoxOption[] {
    const primary = poolById.get(c.research_pool_id);
    const raw: Array<{ url: string; pack: number }> = [];
    const add = (title: string | null | undefined, rps: unknown, u?: string | null) => {
      if (u) raw.push({ url: highResImageUrl(u), pack: packForDonor(title, rps) });
    };
    if (primary) {
      add(primary.title, c.retail_pack_sizes, primary.mainImageUrl);
      parseGallery(primary.imageUrls).forEach((u) => add(primary.title, c.retail_pack_sizes, u));
    }
    for (const d of pool) {
      if (d.id === c.research_pool_id) continue;
      if (!sameFlavor(c.product_name, d.title ?? "")) continue;
      add(d.title, undefined, d.mainImageUrl);
      parseGallery(d.imageUrls).forEach((u) => add(d.title, undefined, u));
    }
    const seen = new Set<string>();
    return raw
      .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
      .map((r) => ({
        url: r.url, pack: r.pack, boxes: boxesForComponent(c.qty, r.pack),
        exact: c.qty % r.pack === 0, score: photoScore(r.url),
      }))
      .sort((a, b) =>
        (Number(b.exact) - Number(a.exact)) || (a.score - b.score) || (a.boxes - b.boxes));
  }

  // Build the flat unit list: each flavor's extracted real box repeated `boxes`
  // times, flavors kept grouped (so a clean count reads one flavor per row).
  const units: Buffer[] = [];
  let totalBoxes = 0;
  let totalUnits = 0;
  for (const c of comp) {
    const options = boxOptions(c);
    if (options.length === 0) {
      return { ...empty, error: `no donor photo for "${c.product_name}" (${c.research_pool_id})` };
    }
    const offset = args.photoOffsets?.[c.research_pool_id] ?? 0;
    const chosen = options[Math.min(offset, options.length - 1)];
    let extracted: Buffer;
    try {
      const raw = await fetchImageBuffer(chosen.url);
      extracted = await extractProduct(raw);
    } catch (e) {
      return { ...empty, error: `fetch/extract failed for "${c.product_name}": ${e instanceof Error ? e.message : String(e)}` };
    }
    for (let i = 0; i < chosen.boxes; i++) units.push(extracted);
    totalBoxes += chosen.boxes;
    totalUnits += c.qty;
    plan.push({ flavor: c.product_name, donor_id: c.research_pool_id, pack: chosen.pack, qty: c.qty, boxes: chosen.boxes, photo_url: chosen.url, candidates: options.length });
  }

  if (units.length === 0) return { ...empty, error: "no boxes to render" };

  let grid: Buffer;
  try {
    grid = await composeUnitGrid(units, { preExtracted: true });
  } catch (e) {
    return { ...empty, plan, total_boxes: totalBoxes, total_units: totalUnits,
      error: `grid compose failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const slug = args.r2Slug.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "anon";
  const key = `bf-composite/${slug}/main-${args.stamp}.png`;
  let url: string;
  try {
    url = await uploadToR2(grid, key);
  } catch (e) {
    return { ...empty, plan, total_boxes: totalBoxes, total_units: totalUnits,
      error: `R2 upload failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  return {
    ok: true,
    image_url: url,
    plan,
    total_boxes: totalBoxes,
    total_units: totalUnits,
    cost_cents: 0,
    ...(totalBoxes > MAX_BOXES ? { error: `WARN: ${totalBoxes} boxes may be hard to read` } : {}),
  };
}

/** Short flavor label for QA / titles: drop brand + size/pack noise, keep the
 *  distinguishing flavor text (e.g. "Peanut Butter & Raspberry Spread"). */
export function shortFlavorLabel(name: string): string {
  return (name || "")
    .replace(/\s*[-–—].*$/, "")
    .replace(/smucker'?s\s*/i, "")
    .replace(/uncrustables\s*/i, "")
    .replace(/\bfrozen\b/i, "")
    .replace(/\bsandwich(es)?\b/i, "")
    .replace(/\bthaw\s*&?\s*eat\b/i, "")
    .replace(/\b\d+(\.\d+)?\s*(oz|ounce|ct|count|pack|g|lb)\b/gi, "")
    .replace(/[,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 45);
}

export interface CompositeWithQaResult extends CompositeResult {
  /** QA officer's verdict on the final image (or the last attempt). */
  qa?: CompositeQaResult;
  /** Number of build attempts made (photo-offset escalations). */
  attempts: number;
}

/**
 * Build the composite AND run the QA officer, retrying with cleaner candidate
 * photos when the officer rejects one (e.g. a marketing banner baked into a
 * Walmart "seo" photo → advance to the next-cleanest same-flavor sibling).
 *
 * Returns the first QA-passed image; if none passes within `maxAttempts` it
 * returns the last attempt with qa.pass=false so the caller can flag manual
 * review (never publishes a rejected image).
 */
export async function buildCompositeWithQA(args: {
  variant: Variant;
  r2Slug: string;
  stamp: string;
  maxAttempts?: number;
}): Promise<CompositeWithQaResult> {
  const comp = args.variant.composition ?? [];
  const maxAttempts = args.maxAttempts ?? 3;
  const expectedFlavors = comp.map((c) => shortFlavorLabel(c.product_name));
  const offsets: Record<string, number> = {};
  let last: CompositeWithQaResult = {
    ok: false, image_url: null, plan: [], total_boxes: 0, total_units: 0, cost_cents: 0, attempts: 0,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await buildCompositeMainImage({
      variant: args.variant,
      r2Slug: args.r2Slug,
      stamp: `${args.stamp}-a${attempt}`,
      photoOffsets: offsets,
    });
    if (!res.ok || !res.image_url) {
      return { ...res, attempts: attempt }; // hard build failure — can't retry usefully
    }
    const qa = await qaCompositeImage({
      image_url: res.image_url,
      expected_flavors: expectedFlavors,
      expected_boxes: res.total_boxes,
      expected_units: res.total_units,
    });
    last = { ...res, qa, attempts: attempt };
    if (qa.pass) return last;

    // QA rejected — advance every flavor to its next-cleanest candidate photo
    // and rebuild. (Coarse but effective: candidates are cleanliness-sorted.)
    for (const p of res.plan) {
      offsets[p.donor_id] = (offsets[p.donor_id] ?? 0) + 1;
    }
  }
  return last;
}
