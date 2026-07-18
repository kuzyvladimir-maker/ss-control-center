/**
 * Deterministic Uncrustables frozen-kit main image.
 *
 * AI is used only to create the reusable empty Salutem cooler template. Every
 * food carton in a per-listing hero is copied from a real, reviewed donor main
 * photo. This prevents fabricated-flavor and garbled-packaging failures, but
 * the empty-cooler v1/v2 kit and cutout composition were rejected in owner
 * review. The module is therefore experimental and fail-closed by default.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";

import { prisma } from "@/lib/prisma";
import {
  extractProduct,
  fetchImageBuffer,
  highResImageUrl,
} from "@/lib/walmart/multipack/composite";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";
import type { Variant } from "./variation-matrix";
import { parsePackUnits } from "./donor-dedup";
import {
  boxesForComponent,
  photoScore,
  sameFlavor,
  shortFlavorLabel,
} from "./composite-image";
import {
  qaCoolerHeroImage,
  type CoolerHeroQaResult,
} from "./audit/cooler-hero-qa";

export const EMPTY_COOLER_TEMPLATE_URL =
  "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v1.png";

const CANVAS = 2048;
const MAX_VISIBLE_BOXES = 6;

export interface CoolerHeroPlanItem {
  flavor: string;
  donor_id: string;
  donor_title: string;
  source_url: string;
  source_reviewed: boolean;
  retail_pack: number;
  recipe_qty: number;
  logical_boxes: number;
  visible_boxes: number;
  candidate_count: number;
}

export interface CoolerHeroBuildResult {
  ok: boolean;
  image_url: string | null;
  image_sha256?: string;
  plan: CoolerHeroPlanItem[];
  expected_flavors: string[];
  visible_boxes: number;
  total_units: number;
  attempts: number;
  qa?: CoolerHeroQaResult;
  cost_cents: 0;
  error?: string;
}

/** Manufacturer-facing carton names for the 12g-protein line. Retail catalog
 * titles describe the filling, while the genuine cartons use these official
 * names. Both are accepted by QA; without the alias, real Beamin' Berry boxes
 * were incorrectly classified as fabricated. */
export function packageQaFlavorLabel(name: string): string {
  const lower = name.toLowerCase();
  if (/(morning protein|12g protein)/.test(lower) && lower.includes("mixed berry")) {
    return "Beamin' Berry Blend (Morning Protein Peanut Butter & Mixed Berry Spread)";
  }
  if (/(morning protein|12g protein)/.test(lower) && lower.includes("strawberry")) {
    return "Bright-Eyed Berry (Morning Protein Peanut Butter & Strawberry Jam)";
  }
  if (/(morning protein|12g protein)/.test(lower) && lower.includes("apple cinnamon")) {
    return "Up & Apple (Morning Protein Peanut Butter & Apple Cinnamon Jelly)";
  }
  // Current genuine cartons use consumer-facing names that differ from some
  // retailer catalog titles. Spell out the equivalence so strict vision QA
  // does not reject the right physical product merely because a catalog still
  // says "whole wheat ... jam" while the carton says "reduced sugar ...
  // spread". These aliases are exact reviewed package identities, not fuzzy
  // flavor substitutions.
  if (lower.includes("whole wheat") && lower.includes("strawberry")) {
    return "Reduced Sugar Peanut Butter & Strawberry Spread (same product as Whole Wheat Peanut Butter & Strawberry Jam)";
  }
  if (lower.includes("whole wheat") && lower.includes("grape")) {
    return "Reduced Sugar Peanut Butter & Grape Spread (same product as Whole Wheat Peanut Butter & Grape Jelly)";
  }
  if (lower.includes("blueberry")) {
    return "Burstin' Blueberry (Peanut Butter & Blueberry Spread, 12g Protein)";
  }
  if (lower.includes("blackberry")) {
    return "Blackberry Boom (Peanut Butter & Blackberry Spread)";
  }
  if (lower.includes("mixed berry")) {
    return "Berry Burst (Peanut Butter & Mixed Berry Spread)";
  }
  // These are separate genuine products with different fillings and package
  // art. Never let vision QA accept one as a substitute for the other.
  if (
    lower.includes("peanut butter") &&
    lower.includes("chocolate") &&
    lower.includes("hazelnut")
  ) {
    return "Peanut Butter & Chocolate Flavored Hazelnut Spread";
  }
  if (lower.includes("chocolate") && lower.includes("hazelnut")) {
    return "Chocolate Flavored Hazelnut Spread";
  }
  if (
    lower.includes("peanut butter") &&
    lower.includes("chocolate flavored spread")
  ) {
    return "Peanut Butter & Chocolate Flavored Spread";
  }
  return shortFlavorLabel(name);
}

interface Candidate {
  id: string;
  title: string;
  url: string;
  reviewed: boolean;
  pack: number;
  logicalBoxes: number;
  exact: boolean;
  primary: boolean;
}

interface DonorImageCandidate {
  id: string;
  title: string | null;
  mainImageUrl: string | null;
  needsReview: boolean;
}

let donorPoolPromise: Promise<DonorImageCandidate[]> | null = null;
const fetchedImageCache = new Map<string, Promise<Buffer>>();
const extractedProductCache = new Map<string, Promise<Buffer>>();
const uploadedHeroCache = new Map<string, Promise<string>>();
const coolerHeroQaCache = new Map<string, Promise<CoolerHeroQaResult>>();

function retryableCache<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

function fetchImageCached(url: string): Promise<Buffer> {
  return retryableCache(fetchedImageCache, url, () => fetchImageBuffer(url));
}

function extractProductCached(url: string): Promise<Buffer> {
  return retryableCache(extractedProductCache, url, async () => {
    const raw = await fetchImageCached(url);
    return makeBorderWhiteTransparent(await extractProduct(raw));
  });
}

function qaCoolerHeroCached(
  key: string,
  args: Parameters<typeof qaCoolerHeroImage>[0],
): Promise<CoolerHeroQaResult> {
  const existing = coolerHeroQaCache.get(key);
  if (existing) return existing;
  const pending = qaCoolerHeroImage(args)
    .then((result) => {
      // Reuse only a positively verified verdict. A timeout/unavailable model
      // or a failed visual check must be retried rather than poisoning every
      // SKU that happens to render the same pixels.
      if (!result.pass || !result.verified) coolerHeroQaCache.delete(key);
      return result;
    })
    .catch((error) => {
      coolerHeroQaCache.delete(key);
      throw error;
    });
  coolerHeroQaCache.set(key, pending);
  return pending;
}

async function donorPool(): Promise<DonorImageCandidate[]> {
  if (!donorPoolPromise) {
    donorPoolPromise = prisma.donorProduct.findMany({
      where: {
        OR: [
          { brand: { in: ["Uncrustables", "Smucker's", "Smuckers", "Smucker’s"] } },
          { title: { contains: "Uncrustables" } },
        ],
      },
      select: {
        id: true,
        title: true,
        mainImageUrl: true,
        needsReview: true,
      },
    }).catch((error) => {
      donorPoolPromise = null;
      throw error;
    });
  }
  return donorPoolPromise;
}

/** Allocate a bounded number of visible cartons proportionally while showing
 * every flavor at least once. Exported for deterministic tests. */
export function allocateVisibleBoxes(weights: number[], maxVisible = MAX_VISIBLE_BOXES): number[] {
  if (weights.length === 0) return [];
  if (weights.length > maxVisible) {
    throw new Error(`${weights.length} flavors exceed the ${maxVisible}-box hero capacity`);
  }
  const normalized = weights.map((w) => Math.max(1, Math.round(w)));
  const target = Math.min(maxVisible, normalized.reduce((sum, w) => sum + w, 0));
  const allocation = normalized.map(() => 1);
  const totalWeight = normalized.reduce((sum, w) => sum + w, 0);
  while (allocation.reduce((sum, n) => sum + n, 0) < target) {
    let best = 0;
    let bestDeficit = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < normalized.length; i++) {
      const ideal = (normalized[i] / totalWeight) * target;
      const deficit = ideal - allocation[i];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = i;
      }
    }
    allocation[best]++;
  }
  return allocation;
}

function candidatePack(title: string, fallback: unknown): number {
  const parsed = parsePackUnits(title);
  if (parsed && parsed >= 2) return parsed;
  if (Array.isArray(fallback)) {
    const explicit = fallback.find((n): n is number => typeof n === "number" && n >= 2);
    if (explicit) return explicit;
  }
  return 4;
}

export async function resolveCoolerHeroPlan(
  variant: Variant,
  offsets: Record<string, number> = {},
): Promise<CoolerHeroPlanItem[]> {
  const comp = variant.composition ?? [];
  if (comp.length === 0) throw new Error("empty composition");

  const pool = await donorPool();

  const provisional: Array<Omit<CoolerHeroPlanItem, "visible_boxes">> = [];
  for (const component of comp) {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const donor of pool) {
      const title = donor.title ?? "";
      const url = donor.mainImageUrl?.trim() ?? "";
      if (!url || donor.needsReview || !/^https:\/\//i.test(url)) continue;
      if (!sameFlavor(component.product_name, title)) continue;
      const hiRes = highResImageUrl(url);
      if (seen.has(hiRes)) continue;
      seen.add(hiRes);
      const pack = candidatePack(title, component.retail_pack_sizes);
      candidates.push({
        id: donor.id,
        title,
        url: hiRes,
        reviewed: !donor.needsReview,
        pack,
        logicalBoxes: boxesForComponent(component.qty, pack),
        exact: component.qty % pack === 0,
        primary: donor.id === component.research_pool_id,
      });
    }
    candidates.sort((a, b) =>
      (Number(b.exact) - Number(a.exact))
      || (photoScore(a.url) - photoScore(b.url))
      || (Number(b.primary) - Number(a.primary))
      || (a.logicalBoxes - b.logicalBoxes)
      || a.id.localeCompare(b.id));
    if (candidates.length === 0) {
      throw new Error(`no reviewed front-facing donor image for \"${component.product_name}\"`);
    }
    const offset = Math.min(offsets[component.research_pool_id] ?? 0, candidates.length - 1);
    const chosen = candidates[offset];
    provisional.push({
      flavor: component.product_name,
      donor_id: chosen.id,
      donor_title: chosen.title,
      source_url: chosen.url,
      source_reviewed: chosen.reviewed,
      retail_pack: chosen.pack,
      recipe_qty: component.qty,
      logical_boxes: chosen.logicalBoxes,
      candidate_count: candidates.length,
    });
  }

  const visible = allocateVisibleBoxes(provisional.map((p) => p.logical_boxes));
  return provisional.map((p, i) => ({ ...p, visible_boxes: visible[i] }));
}

interface PlacedBox {
  left: number;
  top: number;
  buffer: Buffer;
}

/** Remove only the near-white background connected to the crop border. This
 * keeps every original carton pixel (including white label elements) but avoids
 * pasting a visible white rectangle over the cooler and neighboring cartons. */
export async function makeBorderWhiteTransparent(productCrop: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(productCrop)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const background = new Uint8Array(width * height);
  const stack: number[] = [];
  const isNearWhite = (pixel: number) => {
    const i = pixel * channels;
    return data[i] >= 245 && data[i + 1] >= 245 && data[i + 2] >= 245;
  };
  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (background[pixel] || !isNearWhite(pixel)) return;
    background[pixel] = 1;
    stack.push(pixel);
  };
  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  while (stack.length > 0) {
    const pixel = stack.pop()!;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
  for (let pixel = 0; pixel < background.length; pixel++) {
    if (background[pixel]) data[pixel * channels + 3] = 0;
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function makeRow(
  boxes: Buffer[],
  boxHeight: number,
  openLeft: number,
  openRight: number,
  baseY: number,
  overlap: number,
  rotation: number,
): Promise<PlacedBox[]> {
  if (boxes.length === 0) return [];
  const tiles = await Promise.all(boxes.map(async (box, index) => {
    const meta = await sharp(box).metadata();
    const aspect = (meta.width ?? 1) / (meta.height ?? 1);
    let buffer = await sharp(box)
      .resize(Math.max(1, Math.round(boxHeight * aspect)), boxHeight, { fit: "fill" })
      .png()
      .toBuffer();
    const angle = boxes.length > 1 ? (index % 2 === 0 ? -rotation : rotation) : 0;
    if (angle !== 0) {
      buffer = await sharp(buffer)
        .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();
    }
    const rotated = await sharp(buffer).metadata();
    return { buffer, width: rotated.width ?? boxHeight, height: rotated.height ?? boxHeight };
  }));
  const rawWidth = tiles.slice(0, -1)
    .reduce((sum, tile) => sum + tile.width * (1 - overlap), 0)
    + tiles[tiles.length - 1].width;
  const scale = Math.min(1, (openRight - openLeft) / rawWidth);
  const scaled = await Promise.all(tiles.map(async (tile) => {
    const width = Math.max(1, Math.round(tile.width * scale));
    const height = Math.max(1, Math.round(tile.height * scale));
    return {
      buffer: await sharp(tile.buffer).resize(width, height, { fit: "fill" }).png().toBuffer(),
      width,
      height,
    };
  }));
  const rowWidth = scaled.slice(0, -1)
    .reduce((sum, tile) => sum + tile.width * (1 - overlap), 0)
    + scaled[scaled.length - 1].width;
  let x = (openLeft + openRight) / 2 - rowWidth / 2;
  return scaled.map((tile) => {
    const placed = {
      buffer: tile.buffer,
      left: Math.round(x),
      top: Math.round(baseY - tile.height),
    };
    x += tile.width * (1 - overlap);
    return placed;
  });
}

/** Compose already-extracted real carton pixels into the locked cooler
 * geometry. The front of the cooler is re-applied last so cartons sit behind
 * the physical rim instead of floating over it. */
export async function composeCoolerHero(
  coolerTemplate: Buffer,
  extractedBoxes: Buffer[],
  layout: "v1" | "v2" = "v1",
): Promise<Buffer> {
  if (extractedBoxes.length === 0) throw new Error("no product cartons to compose");
  const cooler = await sharp(coolerTemplate)
    .resize(CANVAS, CANVAS, { fit: "cover" })
    .png()
    .toBuffer();
  const frontCount = Math.min(2, extractedBoxes.length);
  // Historical v1 has two gel packs inside and two outside; v2 has a larger
  // empty cavity. Both layouts are rejected experiments, retained only for
  // forensic comparison behind the explicit opt-in at the public entry point.
  const back = layout === "v1"
    ? await makeRow(extractedBoxes.slice(frontCount), 360, 360, 1300, 706, 0.28, 2.5)
    : await makeRow(extractedBoxes.slice(frontCount), 470, 300, 1700, 710, 0.34, 2.5);
  const front = layout === "v1"
    ? await makeRow(extractedBoxes.slice(0, frontCount), 560, 520, 1500, 970, 0.22, 2.5)
    : await makeRow(extractedBoxes.slice(0, frontCount), 620, 330, 1650, 900, 0.12, 2.5);
  const layers: sharp.OverlayOptions[] = [
    ...back.map((p) => ({ input: p.buffer, left: p.left, top: p.top })),
    ...front.map((p) => ({ input: p.buffer, left: p.left, top: p.top })),
  ];
  const rimY = layout === "v1" ? 840 : 685;
  const foreground = await sharp(cooler)
    .extract({ left: 0, top: rimY, width: CANVAS, height: CANVAS - rimY })
    .png()
    .toBuffer();
  layers.push({ input: foreground, left: 0, top: rimY });
  return sharp(cooler).composite(layers).png().toBuffer();
}

async function buildAttempt(args: {
  variant: Variant;
  r2_slug: string;
  stamp: string;
  attempt: number;
  offsets: Record<string, number>;
  cooler_template_url: string;
}): Promise<{
  image: Buffer;
  url: string;
  sha256: string;
  plan: CoolerHeroPlanItem[];
}> {
  const plan = await resolveCoolerHeroPlan(args.variant, args.offsets);
  const extractedByPlan = await Promise.all(
    plan.map((item) => extractProductCached(item.source_url)),
  );
  const interleaved: Buffer[] = [];
  const left = plan.map((p) => p.visible_boxes);
  while (left.some((n) => n > 0)) {
    for (let i = 0; i < left.length; i++) {
      if (left[i] > 0) {
        interleaved.push(extractedByPlan[i]);
        left[i]--;
      }
    }
  }
  const template = await fetchImageCached(args.cooler_template_url);
  const image = await composeCoolerHero(
    template,
    interleaved,
    args.cooler_template_url.includes("empty-cooler-v2") ? "v2" : "v1",
  );
  const sha256 = createHash("sha256").update(image).digest("hex");
  // The renderer is deterministic: several SKUs can legitimately produce the
  // same count-free composition. Store that byte-identical image once under an
  // immutable content-addressed key instead of uploading one duplicate per SKU.
  const url = await retryableCache(uploadedHeroCache, sha256, () =>
    uploadToR2(
      image,
      `bf-cooler-real/sha256/${sha256}.png`,
    )
  );
  return { image, url, sha256, plan };
}

export async function buildCoolerHeroWithQA(args: {
  variant: Variant;
  r2_slug: string;
  stamp: string;
  max_attempts?: number;
  cooler_template_url?: string;
  /**
   * Required acknowledgement for the rejected empty-cooler v1/v2 experiment.
   * Production callers must use the approved GPT Image anchor/reference flow.
   */
  experimental_opt_in?: boolean;
}): Promise<CoolerHeroBuildResult> {
  if (args.experimental_opt_in !== true) {
    return {
      ok: false,
      image_url: null,
      plan: [],
      expected_flavors: [],
      visible_boxes: 0,
      total_units: 0,
      attempts: 0,
      cost_cents: 0,
      error:
        "deterministic empty-cooler v1/v2 is experimental and blocked without explicit opt-in",
    };
  }
  const maxAttempts = args.max_attempts ?? 3;
  const offsets: Record<string, number> = {};
  let last: CoolerHeroBuildResult = {
    ok: false,
    image_url: null,
    plan: [],
    expected_flavors: [],
    visible_boxes: 0,
    total_units: 0,
    attempts: 0,
    cost_cents: 0,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const built = await buildAttempt({
        variant: args.variant,
        r2_slug: args.r2_slug,
        stamp: args.stamp,
        attempt,
        offsets,
        cooler_template_url: args.cooler_template_url ?? EMPTY_COOLER_TEMPLATE_URL,
      });
      const expectedFlavors = built.plan.map((p) => packageQaFlavorLabel(p.flavor));
      const visibleBoxes = built.plan.reduce((sum, p) => sum + p.visible_boxes, 0);
      const qaKey = [
        built.sha256,
        String(visibleBoxes),
        ...[...expectedFlavors].sort(),
      ].join("|");
      const qa = await qaCoolerHeroCached(qaKey, {
        image_buffer: built.image,
        image_url: built.url,
        expected_flavors: expectedFlavors,
        expected_visible_boxes: visibleBoxes,
      });
      last = {
        ok: qa.pass && qa.verified,
        image_url: built.url,
        image_sha256: built.sha256,
        plan: built.plan,
        expected_flavors: expectedFlavors,
        visible_boxes: visibleBoxes,
        total_units: built.plan.reduce((sum, p) => sum + p.recipe_qty, 0),
        attempts: attempt,
        qa,
        cost_cents: 0,
        ...(qa.pass ? {} : { error: qa.hard_fails.join("; ") || "cooler hero QA failed" }),
      };
      if (last.ok) return last;

      // Advance every flavor to its next reviewed front photo. The resolver
      // clamps at the end, so a flavor with one candidate remains unchanged.
      for (const component of args.variant.composition) {
        offsets[component.research_pool_id] = (offsets[component.research_pool_id] ?? 0) + 1;
      }
    } catch (error) {
      return {
        ...last,
        attempts: attempt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return last;
}
