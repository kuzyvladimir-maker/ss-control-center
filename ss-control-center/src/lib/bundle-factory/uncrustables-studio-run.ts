/**
 * Uncrustables Studio — run planning + prompt assembly shared by the
 * /api/bundle-factory/uncrustables/* route handlers (Phase A1-A3 of
 * docs/wiki/uncrustables-studio-integration-plan.md).
 *
 * Composes ONLY existing proven libs — no new render, copy or pricing logic
 * lives here:
 *   - box-planner: validateRecipe + buildListingCopy + rational bands;
 *   - cost-model: priceFor (validated Uncrustables pricing);
 *   - merged authenticity registry: reviewed retail-carton package art;
 *   - donor resolver: exact-variant donor row for each flavor;
 *   - render contract: the frozen PROVEN prompt contract block;
 *   - image-pipeline: the frozen base prompt + Salutem cooler anchor.
 */

import { prisma } from "@/lib/prisma";
import { priceFor } from "@/lib/pricing/cost-model";

import { resolveMergedUncrustablesPackageArt } from "./audit/uncrustables-authenticity-merged";
import {
  UNCRUSTABLES_FLAVORS,
  buildListingCopy,
  rationalBandFor,
  validateRecipe,
  type RecipeComponent,
} from "./uncrustables-box-planner";
import { resolveUncrustablesDonor, type DonorRow } from "./uncrustables-donor-resolver";
import { buildUncrustablesRetailBoxesContract } from "./uncrustables-render-contract";
import { buildImagePrompt, frozenAnchorUrls } from "./image-pipeline";
import { donorUnitPriceCents } from "./donor-dedup";

/** Per-component snapshot stored inside `recipe_json` — everything the board,
 *  the review carton table and the tick prompt builder need. */
export interface StudioRecipeCompSnapshot {
  flavor: string;
  qty: number;
  /** Reviewed retail-carton size of the package art = the printed badge digit. */
  box_size: number;
  /** Number of cartons of this flavor in the scene (qty / box_size). */
  box_count: number;
  donor_id: string | null;
  donor_title: string | null;
  donor_image: string | null;
  unit_price_cents: number | null;
}

/** The full `recipe_json` payload of an UncrustablesStudioCandidate. */
export interface StudioRecipeJson {
  comps: StudioRecipeCompSnapshot[];
  total: number;
  /** Rational count band name (S/M/L/XL) from the box-planner. */
  band: string;
  /** Cooler chosen by the validated pricing model. */
  cooler: string;
  pricing: {
    landed: number;
    target: number;
    floor: number;
    ceiling: number;
    suggested: number;
  };
}

export interface StudioRecipePlan {
  recipe: StudioRecipeJson;
  title: string;
  bullets: string[];
  description: string;
  price_cents: number;
  /** Sum of donor unit prices; null when any component has no unit price. */
  cost_cents: number | null;
  pack_count: number;
}

/** Donor pool query — the exact select proven by the trial-render script.
 *  Loaded once per request and shared across recipes. */
export async function loadUncrustablesDonorPool(): Promise<DonorRow[]> {
  return prisma.donorProduct.findMany({
    where: {
      OR: [
        { brand: { contains: "Uncrustable" } },
        { title: { contains: "Uncrustable" } },
      ],
      needsReview: false,
    },
    select: {
      id: true,
      title: true,
      brand: true,
      productLine: true,
      flavor: true,
      mainImageUrl: true,
      bestPrice: true,
      offers: {
        where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
        select: { price: true, packSizeSeen: true, pricePerUnit: true },
      },
    },
  });
}

/** Resolve reviewed art + donor for every component. Fail-closed: a flavor
 *  without reviewed art or a resolvable donor photo would be silently DROPPED
 *  by the render contract (wrong carton count in the scene), so it is an
 *  error here instead. */
export function resolveStudioComps(
  comps: RecipeComponent[],
  donors: DonorRow[],
): { errors: string[]; snapshots: StudioRecipeCompSnapshot[] } {
  const errors: string[] = [];
  const snapshots: StudioRecipeCompSnapshot[] = [];
  for (const c of comps) {
    const art = resolveMergedUncrustablesPackageArt(c.flavor, "retail-carton");
    if (!art) {
      errors.push(`${c.flavor}: no reviewed retail-carton package art in the merged registry`);
      continue;
    }
    if (c.qty % art.retail_pack_size !== 0) {
      errors.push(
        `${c.flavor}: qty ${c.qty} not divisible by reviewed art carton size ${art.retail_pack_size}`,
      );
      continue;
    }
    const donor = resolveUncrustablesDonor(donors, c.flavor, art.retail_pack_size);
    if (!donor) {
      errors.push(`${c.flavor}: no donor survives disambiguation in the donor pool`);
      continue;
    }
    if (!donor.mainImageUrl) {
      errors.push(`${c.flavor}: resolved donor "${donor.title}" has no main image`);
      continue;
    }
    const unit = donorUnitPriceCents(donor);
    snapshots.push({
      flavor: c.flavor,
      qty: c.qty,
      box_size: art.retail_pack_size,
      box_count: c.qty / art.retail_pack_size,
      donor_id: donor.id,
      donor_title: donor.title,
      donor_image: donor.mainImageUrl,
      unit_price_cents: typeof unit === "number" && unit > 0 ? unit : null,
    });
  }
  return { errors, snapshots };
}

/** Plan one recipe: box-planner validation, art + donor resolution, listing
 *  copy and the validated pricing model. Returns errors OR a complete plan. */
export function planStudioRecipe(
  comps: RecipeComponent[],
  donors: DonorRow[],
): { errors: string[]; plan: StudioRecipePlan | null } {
  const errors = validateRecipe(comps);
  if (errors.length) return { errors, plan: null };

  const resolved = resolveStudioComps(comps, donors);
  if (resolved.errors.length) return { errors: resolved.errors, plan: null };

  const total = comps.reduce((s, c) => s + c.qty, 0);
  const band = rationalBandFor(total);
  const model = priceFor(total);
  if (!band || !model) {
    return { errors: [`total ${total} has no rational band or price model`], plan: null };
  }

  const copy = buildListingCopy(comps);
  const allUnitsKnown = resolved.snapshots.every((s) => s.unit_price_cents != null);
  const costCents = allUnitsKnown
    ? resolved.snapshots.reduce((s, c) => s + c.qty * (c.unit_price_cents as number), 0)
    : null;

  return {
    errors: [],
    plan: {
      recipe: {
        comps: resolved.snapshots,
        total,
        band: band.name,
        cooler: model.cooler,
        pricing: {
          landed: model.landed,
          target: model.target,
          floor: model.floor,
          ceiling: model.ceiling,
          suggested: model.suggested,
        },
      },
      title: copy.title,
      bullets: copy.bullets,
      description: copy.description,
      price_cents: Math.round(model.suggested * 100),
      cost_cents: costCents,
      pack_count: total,
    },
  };
}

/** Assemble the full render prompt for one candidate: frozen base prompt from
 *  the image pipeline + the frozen PROVEN contract block. Throws when the
 *  image pipeline blocks the plan (non-retryable). */
export function buildStudioCandidatePrompt(input: {
  title: string;
  recipe: StudioRecipeJson;
}): { prompt: string; referenceUrls: string[] } {
  const comps = input.recipe.comps;
  const composition = comps.map((c, i) => ({
    research_pool_id: c.donor_id ?? `studio-${i}`,
    product_name: c.flavor,
    flavor: c.flavor,
    brand: "Uncrustables",
    qty: c.qty,
    unit_price_cents: c.unit_price_cents ?? 100,
  }));
  const basePrompt = buildImagePrompt({
    brand: "Uncrustables",
    variant: {
      idx: 0,
      name: input.title,
      composition,
      cost_cents: composition.reduce((s, c) => s + c.qty * c.unit_price_cents, 0),
      suggested_price_cents: Math.round(input.recipe.pricing.suggested * 100),
      margin_cents: 0,
      margin_pct: 0,
      feasibility_score: 100,
      notes: "uncrustables-studio",
    },
    composition_type: comps.length > 1 ? "MIXED_FLAVOR" : "SINGLE_FLAVOR",
    category: "FROZEN",
    uncrustables_image_mode: "retail_boxes",
  });
  const contract = buildUncrustablesRetailBoxesContract({
    comps: comps.map((c) => ({
      flavor: c.flavor,
      qty: c.qty,
      donorImage: c.donor_image,
      artSize: c.box_size,
      frontPanelText: UNCRUSTABLES_FLAVORS[c.flavor]?.frontPanelText ?? null,
    })),
    anchorUrl: frozenAnchorUrls()[0],
  });
  return {
    prompt: `${basePrompt}\n\n${contract.contractText}`,
    referenceUrls: contract.referenceUrls,
  };
}

/** Parse a stored recipe_json column. Throws on malformed rows (they can only
 *  appear through manual DB edits — fail loudly, never render from garbage). */
export function parseStudioRecipeJson(raw: string): StudioRecipeJson {
  const parsed = JSON.parse(raw) as StudioRecipeJson;
  if (!parsed || !Array.isArray(parsed.comps) || !Number.isInteger(parsed.total)) {
    throw new Error("recipe_json is malformed");
  }
  return parsed;
}
