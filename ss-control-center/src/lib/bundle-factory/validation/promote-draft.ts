/**
 * Phase 2.4 Stage 6 — lazy promotion of BundleDraft → MasterBundle +
 * per-channel ChannelSKU rows.
 *
 * Validation operates on ChannelSKU, but the upstream pipeline (Stages
 * 1-5) lives entirely on BundleDraft + GeneratedContent. This helper
 * bridges the two: for every GeneratedContent row that's
 * compliance_status='CAN_PUBLISH' AND main_image_url is set, we
 * materialise a ChannelSKU. Idempotent — re-running on a draft that
 * already has SKUs skips them.
 *
 * Best-effort. If the UPCPool is exhausted for an unassigned slot we
 * skip that channel and report it as a warning to the caller; the
 * orchestrator surfaces this through the API response so the operator
 * can fill the pool and re-run.
 *
 * One MasterBundle per draft. Subsequent SKUs share that MasterBundle.
 */

import { prisma } from "@/lib/prisma";
import { TURSO_TRANSACTION_OPTIONS } from "../turso-transaction";
import type { Prisma } from "@/generated/prisma/client";
import {
  countDistinctBrands,
  resolveAmazonBrowseNode,
} from "../browse-node-resolver";
import {
  getPricingModel,
  type PricingModel,
} from "../pricing-config";
import { computeListingPrice } from "../listing-pricing";
import {
  buildRichAmazonAttributes,
} from "../attributes/build-amazon-attributes";
import {
  amazonAllergensFromStoredDeclarations,
  allergenDeclarationFromLabel,
  allergenDeclarationIsEmpty,
  declaredAllergenLabelsFromStored,
  normalizeAllergenDeclaration,
  serializeAllergenDeclaration,
  type AllergenDeclaration,
} from "../allergen-declaration";
import {
  mirrorDonorGallery,
  galleryLocatorAttrs,
} from "../attributes/gallery-images";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { frozenShippingGroupGuid } from "../distribution/shipping-templates";
import { isOwnBrandPassthrough } from "../own-brand";
import {
  parseVerifiedPhysicalPackageSpecs,
  physicalPackageFields,
  withVerifiedPhysicalPackageSpecs,
} from "../physical-package-specs";
import { getWalmartClient } from "@/lib/walmart/client";
import { walmartStudioRoiPriceCents } from "../walmart-studio-price";
import { resolveIngredientListImage } from "../walmart-ingredient-list-image";
import {
  fetchWalmartItemSpecSchemaCached,
} from "../distribution/walmart-item-spec";
import {
  WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
  isWalmartPilotImageUrl,
} from "./walmart-prepublication-policy";
import {
  checkUpcAvailability,
} from "../walmart-upc-availability";
import {
  WALMART_DEFAULT_SHIP_NODE_SETTING_KEY,
  WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
  WALMART_STUDIO_LISTING_ATTRIBUTE_KEY,
  WALMART_STUDIO_LISTING_LANE,
  buildWalmartStudioListingEvidence,
  buildWalmartStudioPublicAttributes,
  estimateWalmartStudioShippingPackage,
  resolveWalmartStudioProductType,
} from "../walmart-studio-listing";

export interface PromoteOutcome {
  master_bundle_id: string | null;
  /** Channels for which a new ChannelSKU was created in this call. */
  created_channels: string[];
  /** Channels that already had a ChannelSKU and were left alone. */
  existing_channels: string[];
  /** Channels we wanted to promote but couldn't (no UPC available, or
   *  the GeneratedContent row didn't qualify). */
  skipped: Array<{ channel: string; reason: string }>;
}

/** How many pool numbers to try before giving up on attaching one. */
const MAX_UPC_ATTACH_ATTEMPTS = 12;

const SKU_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude I + O for legibility
const SKU_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function pick(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Salutem SKU shape XX-XXXX-XXXX. Brand prefix derived from brand name. */
function brandPrefix(brand: string): string {
  const norm = brand.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (norm.startsWith("SALUTEM")) return "SV"; // Salutem Vita
  if (norm.startsWith("STARFIT")) return "SF";
  return pick(SKU_LETTERS, 2);
}

/** Per-channel suffix. Walmart → WL, Amazon variants → A1..A5, etc. */
function channelCode(channel: string): string {
  switch (channel) {
    case "AMAZON_PERSONAL":  return "AP";
    case "AMAZON_SALUTEM":   return "AS";
    case "AMAZON_AMZCOM":    return "AC";
    case "AMAZON_SIRIUS":    return "AX";
    case "AMAZON_RETAILER":  return "AR";
    case "WALMART":          return "WM";
    case "EBAY":             return "EB";
    case "TIKTOK_1":         return "T1";
    case "TIKTOK_2":         return "T2";
    default:                 return "GN";
  }
}

function buildSku(brand: string, channel: string, draftId: string): string {
  // XX (brand) - XXXX (channel + 2 chars from draft) - XXXX (random)
  const head = brandPrefix(brand);
  const cc = channelCode(channel);
  const slug = draftId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-2);
  const mid = `${cc}${slug}`.padEnd(4, "X").slice(0, 4);
  const tail = pick(SKU_ALNUM, 4);
  return `${head}-${mid}-${tail}`;
}

/** True when the draft ships to Walmart and nowhere else. */
function targetsWalmartOnly(targetChannels: string | null | undefined): boolean {
  if (!targetChannels?.trim()) return false;
  try {
    const parsed = JSON.parse(targetChannels) as unknown;
    return Array.isArray(parsed)
      && parsed.length > 0
      && parsed.every((channel) => channel === "WALMART");
  } catch {
    return false;
  }
}

/**
 * The item price the Walmart studio engine solved for this draft, if this is a
 * studio draft. `approval_notes` carries the sealed economics the draft page
 * renders; the draft column is the same number and is used as the fallback.
 */
function walmartStudioReviewedPriceCents(
  approvalNotes: string | null | undefined,
  draftSuggestedPriceCents: number | null,
): number | null {
  if (!approvalNotes?.trim()) return null;
  try {
    const parsed = JSON.parse(approvalNotes) as {
      workflow?: unknown;
      economics?: { item_price_cents?: unknown };
    };
    if (parsed.workflow !== "CANONICAL_WALMART_NEW_SKU_DRAFT") return null;
    const price = Number(parsed.economics?.item_price_cents);
    if (Number.isSafeInteger(price) && price > 0) return price;
    return Number.isSafeInteger(draftSuggestedPriceCents) &&
      (draftSuggestedPriceCents ?? 0) > 0
      ? draftSuggestedPriceCents
      : null;
  } catch {
    return null;
  }
}

/**
 * Take a product ID from the pool that Walmart will actually accept.
 *
 * The pool is not exclusively ours — roughly a quarter of the numbers next in
 * line already carry other companies' products — so a number is checked
 * against Walmart's catalogue BEFORE it is attached to a listing, and a taken
 * one is retired and skipped. Owner's instruction 2026-08-05: check, attach if
 * free, take the next if not, and only then push. Doing it here means a
 * listing is never born holding a dead number; the check before the feed is
 * then just a cheap re-confirmation.
 *
 * A number that cannot be checked is not attached: an unanswered question is
 * not permission.
 */
async function reserveUpc(
  draftId: string,
  channel: string,
): Promise<{ id: string; upc: string } | null> {
  // Non-Walmart channels have no catalogue to ask, so they keep the plain
  // first-available behaviour.
  const verifyAgainstWalmart = channel === "WALMART";

  for (let attempt = 0; attempt < MAX_UPC_ATTACH_ATTEMPTS; attempt += 1) {
    // Atomic-ish: pull one AVAILABLE row, claim it. SQLite + Prisma
    // doesn't give us SELECT FOR UPDATE, but the @unique constraint on
    // assigned_to_id provides the race-condition safety net.
    const row = await prisma.uPCPool.findFirst({
      where: { status: "AVAILABLE", assigned_to_id: null },
      orderBy: { acquired_at: "asc" }, // FIFO so oldest pool entries get used
      select: { id: true, upc: true },
    });
    if (!row) return null;

    if (verifyAgainstWalmart) {
      const availability = await checkUpcAvailability(row.upc);
      if (!availability.checked) {
        console.warn(
          `[promote-draft] Walmart could not be asked about ${row.upc}; not attaching an unverified product ID`,
        );
        return null;
      }
      if (availability.taken) {
        const pool = await prisma.uPCPool.findUnique({
          where: { id: row.id },
          select: { notes: true },
        });
        const note = `${new Date().toISOString()} UPC_TAKEN_IN_WALMART_CATALOG: `
          + `item ${availability.existingItemId ?? "unknown"} already uses this product ID`;
        await prisma.uPCPool.update({
          where: { id: row.id },
          data: {
            status: "QUARANTINED",
            notes: pool?.notes ? `${pool.notes}\n${note}` : note,
          },
        });
        continue;
      }
    }

    try {
      await prisma.uPCPool.update({
        where: { id: row.id, status: "AVAILABLE" }, // gated update
        data: {
          status: "RESERVED",
          reserved_for_id: draftId,
          reserved_at: new Date(),
          reserved_until: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return row;
    } catch {
      // Someone else took it between the read and the claim; try the next.
      continue;
    }
  }
  return null;
}

async function ensureMasterBundle(
  draftId: string,
  model: PricingModel,
): Promise<string> {
  const draft = await prisma.bundleDraft.findUniqueOrThrow({
    where: { id: draftId },
    select: {
      master_bundle_id: true,
      draft_name: true,
      brand: true,
      category: true,
      composition_type: true,
      pack_count: true,
      draft_components: true,
      generation_job_id: true,
      approved_at: true,
      draft_main_image_url: true,
      draft_secondary_images: true,
      generated_content: {
        select: { main_image_url: true },
      },
    },
  });

  type SnapshotComponent = {
    research_pool_id?: string;
    product_name?: string;
    brand?: string;
    flavor?: string;
    manufacturer_upc?: string;
    qty?: number;
    unit_price_cents?: number;
    ingredients?: string;
    allergen_declaration?: AllergenDeclaration;
    /** Printed package statement; string for Walmart Product Truth drafts. */
    allergens?: string[] | string;
    storage_temp?: string;
    donor_image_urls?: string[];
  };
  let snapshot: SnapshotComponent[];
  try {
    const parsed = JSON.parse(draft.draft_components) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    snapshot = parsed as SnapshotComponent[];
  } catch (error) {
    throw new Error(
      `Draft ${draftId} has malformed draft_components: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const qtyTotal = snapshot.reduce(
    (sum, component) => sum + (Number.isInteger(component.qty) ? Number(component.qty) : 0),
    0,
  );
  if (
    snapshot.length === 0 ||
    qtyTotal !== draft.pack_count ||
    snapshot.some(
      (component) =>
        !component.product_name ||
        !component.brand ||
        !Number.isInteger(component.qty) ||
        Number(component.qty) <= 0 ||
        !Number.isInteger(component.unit_price_cents) ||
        Number(component.unit_price_cents) <= 0,
    )
  ) {
    throw new Error(
      `Draft ${draftId} recipe integrity failed: ${snapshot.length} components, ${qtyTotal}/${draft.pack_count} units, positive integer costs required`,
    );
  }

  const donorIds = snapshot
    .map((component) => component.research_pool_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const donors = donorIds.length
    ? await prisma.donorProduct.findMany({
        where: { id: { in: donorIds } },
        select: {
          id: true,
          upc: true,
          flavor: true,
          ingredients: true,
          category: true,
          bestPrice: true,
          mainImageUrl: true,
          imageUrls: true,
          offers: {
            where: { isFirstParty: true, via: "direct" },
            orderBy: { pricePerUnit: "asc" },
            take: 1,
            select: { productUrl: true },
          },
        },
      })
    : [];
  const donorById = new Map(donors.map((donor) => [donor.id, donor]));
  const componentRows = snapshot.map((component) => {
    const donor = component.research_pool_id
      ? donorById.get(component.research_pool_id)
      : undefined;
    const ingredients = component.ingredients?.trim() || donor?.ingredients?.trim() || null;
    const upc = component.manufacturer_upc?.trim() || donor?.upc?.trim() || null;
    if (!upc) {
      throw new Error(
        `Draft ${draftId} component "${component.product_name}" has no manufacturer UPC`,
      );
    }
    const images = new Set<string>(component.donor_image_urls ?? []);
    if (donor?.mainImageUrl) images.add(donor.mainImageUrl);
    try {
      const parsed = donor?.imageUrls ? JSON.parse(donor.imageUrls) : [];
      if (Array.isArray(parsed)) {
        for (const url of parsed) if (typeof url === "string" && url.trim()) images.add(url);
      }
    } catch {
      // Snapshot/main image still grounds the recipe when gallery JSON is bad.
    }
    // Drafts built before the structured field existed carry the printed
    // package statement instead. Parse THAT text rather than refusing a
    // listing whose manufacturer declaration we already hold. The parser reads
    // only the explicit "Contains"/"May contain" line and never infers an
    // allergen from ingredients, so the guarantee behind this gate is intact.
    // Prefer the stored declaration, but only if it actually says something:
    // an engine that parsed a structured list with a text-only parser left an
    // EMPTY declaration behind, and `??` happily preferred that emptiness over
    // the usable allergen list sitting next to it.
    const storedDeclaration = allergenDeclarationFromLabel(
      component.allergen_declaration,
    );
    const declarationSource = allergenDeclarationIsEmpty(storedDeclaration)
      ? allergenDeclarationFromLabel(component.allergens)
      : storedDeclaration;
    if (allergenDeclarationIsEmpty(declarationSource)) {
      throw new Error(
        `Draft ${draftId} component "${component.product_name}" has no verified manufacturer allergen declaration`,
      );
    }
    const allergenDeclaration = normalizeAllergenDeclaration(
      declarationSource,
      `Draft ${draftId} component "${component.product_name}" allergen_declaration`,
    );
    return {
      product_name: component.product_name!,
      manufacturer_brand: component.brand!,
      manufacturer_upc: upc,
      flavor: component.flavor ?? donor?.flavor ?? null,
      qty: Number(component.qty),
      unit_price_cents:
        typeof donor?.bestPrice === "number" && donor.bestPrice > 0
          ? Math.round(donor.bestPrice * 100)
          : Number(component.unit_price_cents),
      source_url: donor?.offers[0]?.productUrl ?? null,
      ingredients,
      allergens: serializeAllergenDeclaration(allergenDeclaration),
      storage_temp: component.storage_temp ?? donor?.category ?? null,
      donor_image_urls: JSON.stringify(Array.from(images)),
    };
  });

  // Pull the first image we generated as the master default.
  const firstImage =
    draft.generated_content.find((g) => g.main_image_url)?.main_image_url ??
    draft.draft_main_image_url;
  if (!firstImage?.trim()) {
    throw new Error(
      `Draft ${draftId} has no verified main image; placeholder images are forbidden`,
    );
  }

  // Rehydrate COGS from the current canonical donor per-unit rollup. Legacy
  // drafts may carry the historic pack-price double-division bug, so their
  // draft_cost_cents is not trusted at promotion.
  const estimatedCost = componentRows.reduce(
    (sum, component) => sum + component.qty * component.unit_price_cents,
    0,
  );

  // Cost-buildup price (goods + cooler/ice/box + fees, solved for target margin).
  // Weight is unknown at first promotion (ship-specs entered later) → packaging
  // is estimated; the price re-derives once weight lands and validation re-runs.
  const priceCalc = computeListingPrice(
    {
      brand: draft.brand,
      title: draft.draft_name,
      cogs_cents: estimatedCost,
      weight_lb: null,
      unit_count: draft.pack_count, // count-based cooler (fixes always-M when weight is null)
      category: draft.category,
    },
    model,
  );

  const slugBase = draft.draft_name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "bundle";
  const internalSlug = `${slugBase}-${draftId.slice(-6)}`;

  const secondaryImages = (() => {
    try {
      const parsed = draft.draft_secondary_images
        ? JSON.parse(draft.draft_secondary_images)
        : [];
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  })();

  if (draft.master_bundle_id) {
    const existingId = draft.master_bundle_id;
    await prisma.$transaction(async (tx) => {
      const existingMaster = await tx.masterBundle.findUniqueOrThrow({
        where: { id: existingId },
        select: { packaging_spec: true },
      });
      let priorPackagingSpec: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(existingMaster.packaging_spec) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("packaging_spec must be a JSON object");
        }
        priorPackagingSpec = parsed as Record<string, unknown>;
      } catch {
        throw new Error(
          `MasterBundle ${existingId} has malformed packaging_spec; refusing to discard physical-spec provenance`,
        );
      }
      const persistedComponents = await tx.bundleComponent.findMany({
        where: { master_bundle_id: existingId },
        select: {
          id: true,
          manufacturer_upc: true,
          manufacturer_brand: true,
          flavor: true,
          qty: true,
        },
      });
      if (persistedComponents.length === 0) {
        await tx.bundleComponent.createMany({
          data: componentRows.map((component) => ({
            master_bundle_id: existingId,
            ...component,
          })),
        });
      } else {
        const recipeKey = (component: {
          manufacturer_upc: string | null;
          manufacturer_brand: string;
          flavor: string | null;
          qty: number;
        }) => JSON.stringify([
          component.manufacturer_upc?.trim() ?? "",
          component.manufacturer_brand.trim().toLowerCase(),
          component.flavor?.trim().toLowerCase() ?? "",
          component.qty,
        ]);
        const persistedKeys = persistedComponents.map(recipeKey).sort();
        const expectedKeys = componentRows.map(recipeKey).sort();
        if (JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)) {
          throw new Error(
            `MasterBundle ${existingId} canonical recipe differs from draft ${draftId}; refusing a silent recipe replacement`,
          );
        }
        for (const persisted of persistedComponents) {
          const expected = componentRows.find(
            (component) => recipeKey(component) === recipeKey(persisted),
          );
          if (!expected) continue;
          await tx.bundleComponent.update({
            where: { id: persisted.id },
            data: expected,
          });
        }
      }
      await tx.masterBundle.update({
        where: { id: existingId },
        data: {
          name: draft.draft_name,
          brand: draft.brand,
          category: draft.category,
          composition_type: draft.composition_type,
          pack_count: draft.pack_count,
          generation_job_id: draft.generation_job_id,
          cost_breakdown: JSON.stringify({
            goods_cents: estimatedCost,
            packaging_cents: priceCalc.cost.packaging_cents,
            fba_cents: priceCalc.cost.fba_cents,
            closing_cents: priceCalc.cost.closing_cents,
            shipping_label_cents: priceCalc.cost.own_shipping_cents,
            shipping_in_price: model.shipping_in_price,
            sourcing_overhead_cents: 0,
          }),
          estimated_cost_cents: estimatedCost,
          suggested_price_cents: priceCalc.selling_price_cents,
          packaging_spec: JSON.stringify({
            ...priorPackagingSpec,
            pricing_source: priceCalc.pricing_source,
            cooler_size: priceCalc.cooler_size,
            floor_price_cents: priceCalc.floor_price_cents,
            shipping_in_price: model.shipping_in_price,
          }),
          secondary_images: JSON.stringify(secondaryImages),
          main_image_url: firstImage,
          lifecycle_status: "GENERATED",
        },
      });
      await tx.bundleDraft.update({
        where: { id: draftId },
        data: {
          status: "GENERATED",
          draft_cost_cents: estimatedCost,
          draft_suggested_price_cents: priceCalc.selling_price_cents,
          approved_at: null,
          approved_by: null,
        },
      });
      if (draft.approved_at) {
        await tx.generationJob.updateMany({
          where: {
            id: draft.generation_job_id,
            bundles_approved: { gt: 0 },
          },
          data: { bundles_approved: { decrement: 1 } },
        });
      }
    }, TURSO_TRANSACTION_OPTIONS);
    return existingId;
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.masterBundle.create({
      data: {
        name: draft.draft_name,
        internal_slug: internalSlug,
        brand: draft.brand,
        category: draft.category,
        composition_type: draft.composition_type,
        pack_count: draft.pack_count,
        generation_job_id: draft.generation_job_id,
        cost_breakdown: JSON.stringify({
          goods_cents: estimatedCost,
          packaging_cents: priceCalc.cost.packaging_cents,
          fba_cents: priceCalc.cost.fba_cents,
          closing_cents: priceCalc.cost.closing_cents,
          shipping_label_cents: priceCalc.cost.own_shipping_cents,
          shipping_in_price: model.shipping_in_price,
          sourcing_overhead_cents: 0,
        }),
        estimated_cost_cents: estimatedCost,
        suggested_price_cents: priceCalc.selling_price_cents,
        packaging_spec: JSON.stringify({
          pricing_source: priceCalc.pricing_source,
          cooler_size: priceCalc.cooler_size,
          floor_price_cents: priceCalc.floor_price_cents,
          shipping_in_price: model.shipping_in_price,
        }),
        main_image_url: firstImage,
        secondary_images: JSON.stringify(secondaryImages),
        lifecycle_status: "GENERATED",
        components: { create: componentRows },
      },
      select: { id: true },
    });
    await tx.bundleDraft.update({
      where: { id: draftId },
      data: {
        status: "GENERATED",
        master_bundle_id: created.id,
        draft_cost_cents: estimatedCost,
        draft_suggested_price_cents: priceCalc.selling_price_cents,
        approved_at: null,
        approved_by: null,
      },
    });
    if (draft.approved_at) {
      await tx.generationJob.updateMany({
        where: {
          id: draft.generation_job_id,
          bundles_approved: { gt: 0 },
        },
        data: { bundles_approved: { decrement: 1 } },
      });
    }
    return created.id;
  }, TURSO_TRANSACTION_OPTIONS);
}

/**
 * Materialise ChannelSKU rows from every CAN_PUBLISH+with-image
 * GeneratedContent. Returns what was created vs. what already existed.
 */
export async function promoteDraftToChannelSkus(
  draftId: string,
): Promise<PromoteOutcome> {
  const pricingModel = await getPricingModel();
  const masterBundleId = await ensureMasterBundle(draftId, pricingModel);

  // Auto retail price = pricing model applied to the bundle's COGS. Read the
  // basis straight off the (now-correct) MasterBundle so every SKU prices
  // identically and the margin validator can clear the floor.
  const masterForPrice = await prisma.masterBundle.findUnique({
    where: { id: masterBundleId },
    select: {
      brand: true,
      name: true,
      estimated_cost_cents: true,
      category: true,
      total_weight_oz: true,
      pack_count: true,
      packaging_spec: true,
    },
  });
  const draftPriceRow = await prisma.bundleDraft.findUnique({
    where: { id: draftId },
    select: {
      approval_notes: true,
      draft_suggested_price_cents: true,
      target_channels: true,
    },
  });
  const autoPrice = computeListingPrice(
    {
      brand: masterForPrice?.brand ?? null,
      title: masterForPrice?.name ?? null,
      cogs_cents: masterForPrice?.estimated_cost_cents ?? 0,
      weight_lb: masterForPrice?.total_weight_oz
        ? masterForPrice.total_weight_oz / 16
        : null,
      unit_count: masterForPrice?.pack_count ?? null,
      category: masterForPrice?.category ?? null,
    },
    pricingModel,
  );
  // A Walmart studio draft was already priced by the Walmart economics module
  // against the exact shipping template and the 15% referral fee, and that is
  // the number the owner reviewed on the draft page. Re-solving it with the
  // Amazon cost model (cooler bands, FBA fees) produced a different, lower
  // price at promotion — the page said one thing and the listing would have
  // gone live at another. The reviewed price wins.
  const reviewedPriceCents = walmartStudioReviewedPriceCents(
    draftPriceRow?.approval_notes,
    draftPriceRow?.draft_suggested_price_cents ?? null,
  );
  // A Walmart-only draft is priced by the studio's own rule — return on
  // invested capital against the exact shipping template it was built with.
  // Without this it fell through to the Amazon model (cooler bands, FBA fees)
  // for a marketplace this listing never touches, which priced the first live
  // listing at $37.68 where the rule requires $43.10 — and re-priced it back
  // on every publish, silently undoing any correction.
  const studioRoiPriceCents = targetsWalmartOnly(draftPriceRow?.target_channels)
    ? await walmartStudioRoiPriceCents({
      draftId,
      goodsCostCents: masterForPrice?.estimated_cost_cents ?? 0,
      packageWeightOz:
        parseVerifiedPhysicalPackageSpecs(masterForPrice?.packaging_spec)?.weight_oz
          ?? masterForPrice?.total_weight_oz
          ?? 0,
    }).catch(() => null)
    : null;
  const autoPriceCents =
    studioRoiPriceCents ?? reviewedPriceCents ?? autoPrice.selling_price_cents;
  const canonicalBusinessPrice = isOwnBrandPassthrough(masterForPrice?.brand)
    ? autoPriceCents
    : null;

  // `ensureMasterBundle` can only estimate packaging on the first promotion.
  // Once ship specs supply a weight, persist the re-derived result back to both
  // MasterBundle and draft instead of updating only the channel offer.
  let priorPackagingSpec: Record<string, unknown> = {};
  try {
    const parsed = masterForPrice?.packaging_spec
      ? JSON.parse(masterForPrice.packaging_spec)
      : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("packaging_spec must be a JSON object");
    }
    priorPackagingSpec = parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `MasterBundle ${masterBundleId} has malformed packaging_spec; refusing to discard physical-spec provenance`,
    );
  }
  await prisma.$transaction([
    prisma.masterBundle.update({
      where: { id: masterBundleId },
      data: {
        suggested_price_cents: autoPriceCents,
        cost_breakdown: JSON.stringify({
          goods_cents: masterForPrice?.estimated_cost_cents ?? 0,
          packaging_cents: autoPrice.cost.packaging_cents,
          fba_cents: autoPrice.cost.fba_cents,
          closing_cents: autoPrice.cost.closing_cents,
          shipping_label_cents: autoPrice.cost.own_shipping_cents,
          shipping_in_price: pricingModel.shipping_in_price,
          sourcing_overhead_cents: 0,
        }),
        packaging_spec: JSON.stringify({
          ...priorPackagingSpec,
          pricing_source: autoPrice.pricing_source,
          cooler_size: autoPrice.cooler_size,
          floor_price_cents: autoPrice.floor_price_cents,
          shipping_in_price: pricingModel.shipping_in_price,
        }),
      },
    }),
    prisma.bundleDraft.update({
      where: { id: draftId },
      data: { draft_suggested_price_cents: autoPriceCents },
    }),
  ]);

  const candidates = await prisma.generatedContent.findMany({
    where: {
      bundle_draft_id: draftId,
      compliance_status: "CAN_PUBLISH",
      main_image_url: { not: null },
    },
  });

  const created: string[] = [];
  const existing: string[] = [];
  const skipped: Array<{ channel: string; reason: string }> = [];

  const draft = await prisma.bundleDraft.findUniqueOrThrow({
    where: { id: draftId },
    select: {
      brand: true,
      draft_components: true,
      pack_count: true,
      category: true,
      draft_secondary_images: true,
      target_channels: true,
    },
  });

  // Rich food attributes are derived from the persisted canonical recipe, not
  // composition[0]. Every flavor contributes its ingredient statement and the
  // allergen builder therefore emits the union across the full mix.
  const masterComponents = await prisma.bundleComponent.findMany({
    where: { master_bundle_id: masterBundleId },
    orderBy: { created_at: "asc" },
    select: {
      manufacturer_brand: true,
      flavor: true,
      ingredients: true,
      allergens: true,
    },
  });
  if (masterComponents.length === 0) {
    throw new Error(`MasterBundle ${masterBundleId} has no canonical recipe components`);
  }
  const missingIngredients = masterComponents.filter(
    (component) => !component.ingredients?.trim(),
  );
  if (missingIngredients.length > 0) {
    throw new Error(
      `Cannot promote food listing: ${missingIngredients.length}/${masterComponents.length} recipe components have no manufacturer ingredients`,
    );
  }
  const combinedIngredients = masterComponents.length === 1
    ? masterComponents[0].ingredients!
    : masterComponents
        .map((component) => `${component.flavor ?? component.manufacturer_brand}: ${component.ingredients}`)
        .join("; ");
  // Amazon's allergen field is a closed enum and refuses a label outside it;
  // Walmart takes the declaration as text. A Walmart-only draft must therefore
  // not be blocked because the manufacturer's list uses EU labels such as
  // "celery" or "molluscs" — the declaration still ships in full.
  const walmartOnlyDraft = targetsWalmartOnly(draft.target_channels);
  const declaredAllergenLabels = declaredAllergenLabelsFromStored(
    masterComponents.map((component) => component.allergens),
  );
  // The attribute builder speaks Amazon's closed enum. A Walmart-only draft
  // has no Amazon enum to fill, so it fills none and carries the declaration
  // as the manufacturer's own text below.
  const authoritativeAllergens = walmartOnlyDraft
    ? []
    : amazonAllergensFromStoredDeclarations(
        masterComponents.map((component) => component.allergens),
      );
  let richAttributesJson = JSON.stringify(
    buildRichAmazonAttributes({
      ingredients: combinedIngredients,
      allergens: authoritativeAllergens,
      packCount: draft.pack_count,
      category: draft.category,
    }),
  );
  if (walmartOnlyDraft && declaredAllergenLabels.length > 0) {
    const rich = JSON.parse(richAttributesJson) as Record<string, unknown>;
    rich.allergen_information = [{
      value: declaredAllergenLabels.join(", "),
      marketplace_id: MARKETPLACE_ID,
    }];
    richAttributesJson = JSON.stringify(rich);
  }
  let nutritionImageUrl: string | null = null;
  let hostedGalleryUrls: string[] = [];
  const snapshotComponents = JSON.parse(draft.draft_components) as Array<{
    research_pool_id?: string;
    /** Units of THIS product in the box. A mixed assortment has several rows. */
    qty?: number;
    ingredients?: string;
    allergens?: string[] | string;
    product_truth_component?: Record<string, unknown>;
    walmart_preview?: {
      image?: {
        exact_source_url?: string;
        source_asset_sha256?: string;
        output_sha256?: string;
        represented_unit_count?: number;
        construction_method?: string;
      };
    };
  }>;
  const primaryDonorId = snapshotComponents[0]?.research_pool_id;
  const primaryDonor = primaryDonorId
    ? await prisma.donorProduct.findUnique({
        where: { id: primaryDonorId },
        select: { nutritionFacts: true },
      })
    : null;
  try {
    const nutrition = primaryDonor?.nutritionFacts
      ? JSON.parse(primaryDonor.nutritionFacts)
      : null;
    if (Array.isArray(nutrition)) {
      const hit = nutrition.find(
        (entry) =>
          entry && typeof entry === "object" &&
          /image/i.test(String((entry as { name?: string }).name ?? "")) &&
          /^https?:\/\//.test(String((entry as { value?: string }).value ?? "")),
      );
      if (hit) nutritionImageUrl = String((hit as { value?: string }).value);
    }
  } catch {
    // A nutrition image is optional; ingredient/allergen facts above are not.
  }

  // Secondary GALLERY images (owner: every cold-chain listing needs 5+ gallery
  // infographic/lifestyle photos). Mirror the donor's harvested secondary photos
  // (+ the nutrition label) to R2 and attach them as other_product_image_locator_N
  // in the rich attributes. Best-effort — a mirror failure just leaves the
  // listing with its main image + brand card. Computed once, shared by all SKUs.
  try {
    const rich = JSON.parse(richAttributesJson) as Record<string, unknown>;
    let secondary: string[] = [];
    try {
      const arr = draft.draft_secondary_images
        ? JSON.parse(draft.draft_secondary_images)
        : [];
      if (Array.isArray(arr)) {
        secondary = arr.filter(
          (u): u is string => typeof u === "string" && u.trim().length > 0,
        );
      }
    } catch {
      /* not JSON — no donor gallery */
    }
    const galleryUrls = [nutritionImageUrl, ...secondary].filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    if (galleryUrls.length > 0) {
      const hosted = await mirrorDonorGallery(`draft-${draftId}-gallery`, galleryUrls);
      // Walmart requires at least one secondary image besides MAIN, so an
      // unavailable mirror (missing R2 credentials, a CDN refusal) would sink
      // the whole publish with an obscure contract error. The donor's own
      // packshot URLs are already exact images of this same product on the
      // retailer's CDN; those that Walmart will accept as-is — HTTPS, no
      // query string, .jpg/.png — stand in until the mirror works again.
      const usable = hosted.length > 0
        ? hosted
        : galleryUrls.filter(isWalmartPilotImageUrl);
      if (usable.length > 0) {
        hostedGalleryUrls = usable;
        Object.assign(rich, galleryLocatorAttrs(usable, MARKETPLACE_ID));
        richAttributesJson = JSON.stringify(rich);
      }
    }
  } catch {
    /* gallery best-effort — never block promotion */
  }

  // Frozen shipping: the count-based cooler may select the reviewed shipping
  // template, but it is not evidence of actual packed weight or dimensions.
  // Those fields remain absent until the operator ship-specs workflow records
  // a verified measurement set in MasterBundle.packaging_spec.
  const isCold = /FROZEN|REFRIGERATED|COLD/i.test(draft.category ?? "");
  if (isCold && autoPrice.cooler_size) {
    try {
      const rich = JSON.parse(richAttributesJson) as Record<string, unknown>;
      rich.merchant_shipping_group = [
        { value: frozenShippingGroupGuid(autoPrice.cooler_size), marketplace_id: MARKETPLACE_ID },
      ];
      richAttributesJson = JSON.stringify(rich);
    } catch {
      /* leave attributes as-is if JSON parse fails */
    }
  }
  let verifiedPhysicalSpecs = parseVerifiedPhysicalPackageSpecs(
    masterForPrice?.packaging_spec,
  );

  // Price band born WITH the listing (Vladimir 2026-07-07): min = the ROI-floor
  // price (target ROI on goods+packaging survives), max = the target price.
  // ChannelMAX auto-imports these bounds from the listing, so a listing born
  // with a correct band never needs a manual ChannelMAX fix — the repricer can
  // neither raise it above our target nor drop it below the ROI minimum.
  // amazon-publish merges our_price into this same purchasable_offer entry.
  try {
    const rich = JSON.parse(richAttributesJson) as Record<string, unknown>;
    rich.purchasable_offer = [
      {
        marketplace_id: MARKETPLACE_ID,
        currency: "USD",
        minimum_seller_allowed_price: [
          // The floor can only ever be at or below the listed price. When the
          // Walmart studio price is used, the Amazon-model floor is not a
          // comparable number, so it is clamped rather than trusted.
          {
            schedule: [{
              value_with_tax:
                Math.min(autoPrice.floor_price_cents, autoPriceCents) / 100,
            }],
          },
        ],
        maximum_seller_allowed_price: [
          { schedule: [{ value_with_tax: autoPriceCents / 100 }] },
        ],
      },
    ];
    richAttributesJson = JSON.stringify(rich);
  } catch {
    /* band is best-effort — publish still sets our_price */
  }

  // ---- Walmart studio lane -------------------------------------------------
  // A studio draft was built from ONE exact canonical variant, and the engine
  // recorded the whole chain in the draft snapshot. Promotion carries that
  // chain onto the ChannelSKU so the Walmart validators check evidence rather
  // than absence, and so a reviewer can read the listing's provenance straight
  // off the SKU. Nothing is invented here: every value below is either copied
  // from the snapshot or derived from the manufacturer's declared net mass.
  // The US marketplace value the whole Bundle Factory already declares for
  // these listings (see attributes/fill-map.ts). Kept in one place so the
  // public Walmart block and the ChannelSKU column can never disagree.
  const STUDIO_COUNTRY_OF_ORIGIN = "US";
  const studioComponent = snapshotComponents[0]?.product_truth_component ?? null;
  const studioImage = snapshotComponents[0]?.walmart_preview?.image ?? null;
  const studioProductType = studioComponent
    ? resolveWalmartStudioProductType({
        product_name: String(studioComponent.product_name ?? ""),
        flavor: typeof studioComponent.flavor === "string" ? studioComponent.flavor : null,
      })
    : null;
  const studioIdentity = studioComponent?.canonical_identity as
    | { sizeDimension?: string; sizeBaseAmount?: number; sizeBaseUnit?: string }
    | undefined;
  // Every product in the box contributes its OWN size for its OWN count.
  // Estimating the whole pack from the first flavor was wrong for any
  // assortment whose flavors differ in size: 4 x 10.5 oz + 4 x 18.8 oz weighs
  // 117.2 oz, but the first-flavor estimate claimed 84 oz — or 150.4 oz if the
  // bigger can happened to be listed first (independent review 2026-08-08).
  const studioEstimate = (() => {
    const measurable = snapshotComponents
      .map((entry) => {
        const identity = entry?.product_truth_component?.canonical_identity as
          | { sizeDimension?: string; sizeBaseAmount?: number; sizeBaseUnit?: string }
          | undefined;
        const qty = Number(entry?.qty);
        if (!identity || !Number.isFinite(qty) || qty <= 0) return null;
        return {
          sizeDimension: String(identity.sizeDimension ?? ""),
          sizeBaseAmount: Number(identity.sizeBaseAmount),
          sizeBaseUnit: String(identity.sizeBaseUnit ?? ""),
          packCount: Math.trunc(qty),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (measurable.length === 0) return null;
    // One call for the whole box: the estimator adds the carton and the tare
    // once and picks a box for everything together.
    return estimateWalmartStudioShippingPackage({
      ...measurable[0]!,
      ...(measurable.length > 1 ? { additional: measurable.slice(1) } : {}),
    });
  })();

  // Only the four measurable columns reach the database; `basis` stays in the
  // estimator's return so callers can see where the numbers came from.
  const studioPackage = studioEstimate
    ? {
        package_weight_oz: studioEstimate.package_weight_oz,
        package_length_in: studioEstimate.package_length_in,
        package_width_in: studioEstimate.package_width_in,
        package_height_in: studioEstimate.package_height_in,
      }
    : null;

  // Record the estimate as the bundle's package provenance when nobody has
  // measured the box yet. It is stored under its own source name, so the
  // listing never claims a human weighed it, and the operator's Ship-specs
  // form overwrites it the moment real measurements exist.
  if (studioEstimate && !verifiedPhysicalSpecs) {
    const packagingSpec = withVerifiedPhysicalPackageSpecs(
      masterForPrice?.packaging_spec,
      {
        weight_oz: studioEstimate.package_weight_oz,
        length_in: studioEstimate.package_length_in,
        width_in: studioEstimate.package_width_in,
        height_in: studioEstimate.package_height_in,
      },
      new Date(),
      "STUDIO_NET_MASS_ESTIMATE",
    );
    await prisma.masterBundle.update({
      where: { id: masterBundleId },
      data: {
        packaging_spec: packagingSpec,
        total_weight_oz: studioEstimate.package_weight_oz,
      },
    });
    verifiedPhysicalSpecs = parseVerifiedPhysicalPackageSpecs(packagingSpec);
  }

  // Walmart's item contract must name the exact spec the payload was built
  // against. Fetching it here (once per promotion, cached by the client) means
  // the listing carries live Get Spec evidence instead of a pinned guess. A
  // failed fetch is not fatal at this stage: the studio validators do not read
  // it, and the publish path refuses on its own with a clear contract error.
  // Walmart attaches the offer to one fulfillment center. The account has
  // several ship nodes and inventory is written to all of them, so which one
  // the offer names is the owner's call; it is stored once as a Setting rather
  // than guessed per listing.
  const shipNodeSetting = await prisma.setting.findUnique({
    where: { key: WALMART_DEFAULT_SHIP_NODE_SETTING_KEY },
  });
  const studioFulfillmentCenterId = shipNodeSetting?.value?.trim() || null;

  // Which shipping template this listing sells under is not a fresh choice —
  // the build already sealed one into its work item and PRICED the listing
  // against it. Carrying that exact id forward is what keeps the price and the
  // shipping promise describing the same thing. Promotion used to drop it and
  // write null, so the publish path had no association to assert and refused at
  // the last fence with "requires ... shippingTemplateAssociation".
  const studioWorkItem = await prisma.generationWorkItem.findFirst({
    where: { bundle_draft_id: draftId },
    orderBy: { created_at: "desc" },
    select: { spec_json: true },
  });
  let studioShippingTemplateId: string | null = null;
  if (studioWorkItem?.spec_json) {
    try {
      const spec = JSON.parse(studioWorkItem.spec_json) as {
        shipping_template_id?: unknown;
      };
      if (typeof spec.shipping_template_id === "string"
        && spec.shipping_template_id.trim()) {
        studioShippingTemplateId = spec.shipping_template_id.trim();
      }
    } catch {
      // A malformed work item is treated as no template: fail closed below.
    }
  }

  const masterBundleComponents = await prisma.bundleComponent.findMany({
    where: { master_bundle_id: masterBundleId },
    select: { ingredients: true },
    take: 1,
  });

  // Walmart requires an image of the ingredient list to CREATE a food item.
  // Look for a real photograph of the panel among the donor gallery first, and
  // render the manufacturer's own statement when there is none (owner decision
  // 2026-08-03). A Nutrition Facts crop is a different panel and is never used.
  const studioIngredientsText = (() => {
    // A box holding several products needs EVERY statement, labelled, or the
    // rendered panel would describe one soup and omit the allergens of the
    // other (independent review 2026-08-08).
    const perComponent = snapshotComponents
      .map((entry) => {
        const text = typeof entry?.ingredients === "string" && entry.ingredients.trim()
          ? entry.ingredients.trim()
          : typeof entry?.product_truth_component?.ingredients === "string"
            ? String(entry.product_truth_component.ingredients).trim()
            : "";
        if (!text) return null;
        const name = String(entry?.product_truth_component?.product_name ?? "").trim();
        return { name, text };
      })
      .filter((entry): entry is { name: string; text: string } => entry !== null);

    if (perComponent.length > 1) {
      return perComponent
        .map((entry) => (entry.name ? `${entry.name}: ${entry.text}` : entry.text))
        .join("\n\n");
    }
    if (perComponent.length === 1) return perComponent[0].text;
    // The MasterBundle's own component row carries the catalogued statement.
    const fromBundle = masterBundleComponents[0]?.ingredients;
    return typeof fromBundle === "string" && fromBundle.trim()
      ? fromBundle.trim()
      : null;
  })();

  let studioIngredientImage: string | null = null;
  let studioIngredientImageError: string | null = null;
  if (studioProductType) {
    try {
      const resolved = await resolveIngredientListImage({
        candidateImageUrls: hostedGalleryUrls,
        ingredientsText: studioIngredientsText,
        productKey: String(studioComponent?.product_name ?? draftId),
      });
      studioIngredientImage = resolved?.url ?? null;
      if (!resolved) {
        studioIngredientImageError =
          "no donor photo of the ingredient list and no manufacturer ingredient text to render";
      }
    } catch (error) {
      studioIngredientImageError =
        error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Net content of ONE retail unit, from the manufacturer's declared size.
   *
   * An assortment has no single unit size. Rather than declare one flavor's can
   * as if it were the box, it declares nothing when the sizes disagree — a
   * missing value is caught downstream, a wrong one is not.
   */
  const studioNetContent = (() => {
    const sizes = snapshotComponents
      .map((entry) => entry?.product_truth_component?.canonical_identity as
        | { sizeBaseAmount?: number; sizeBaseUnit?: string }
        | undefined)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const distinct = new Set(
      sizes.map((entry) => `${entry.sizeBaseAmount}|${entry.sizeBaseUnit}`),
    );
    if (distinct.size > 1) return null;
    const amount = Number(studioIdentity?.sizeBaseAmount);
    const unit = String(studioIdentity?.sizeBaseUnit ?? "").trim().toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    // Walmart's enum spells units out in full.
    const unitName = unit === "oz" || unit === "ounce" || unit === "ounces"
      ? "Ounce"
      : unit === "fl oz" || unit === "fluid ounce" || unit === "fluid ounces"
        ? "Fluid Ounces"
        : unit === "lb" || unit === "pound" || unit === "pounds"
          ? "Pound"
          : unit === "g" || unit === "gram" || unit === "grams"
            ? "Gram"
            : unit === "ml" || unit === "milliliter"
              ? "Milliliter"
              : null;
    if (!unitName) return null;
    return { unit: unitName, measure: Number(amount.toFixed(3)) };
  })();

  let studioSpec:
    | { version: string; schema_sha256: string; fetched_at: string }
    | null = null;
  let studioSpecError: string | null = null;
  if (studioProductType) {
    try {
      // Cached and retried: Get Spec answers identically per product type, and
      // one call per draft throttles a batch into failures.
      const fetched = await fetchWalmartItemSpecSchemaCached(getWalmartClient(1), {
        version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
        productType: studioProductType,
      });
      studioSpec = {
        version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
        schema_sha256: fetched.schema_sha256,
        fetched_at: fetched.fetched_at,
      };
    } catch (error) {
      studioSpecError = error instanceof Error ? error.message : String(error);
      console.warn("[promote-draft] Walmart Get Spec unavailable:", studioSpecError);
    }
  }

  /** Per-SKU Walmart attributes; the evidence names its own SKU and image. */
  function walmartStudioAttributesJson(
    skuCode: string,
    mainImageUrl: string,
  ): string | null {
    if (!studioComponent || !studioImage || !studioProductType) return null;
    // Fail closed. Without the spec trio the listing is unpublishable: the
    // public item contract requires spec_version, spec_schema_hash and
    // spec_fetched_at. This used to warn and carry on, so the draft was stored
    // and marked VALIDATED while being impossible to publish, and the operator
    // found out at the POST via "spec_schema_hash must be a SHA-256 hex
    // digest". Refuse here, naming the real cause.
    if (!studioSpec) {
      throw new Error(
        `Walmart Get Spec is unavailable, so this listing cannot be prepared: ${
          studioSpecError ?? "unknown reason"
        }`,
      );
    }
    // Same reasoning: a listing with no shipping template and no ship node
    // cannot be published, and storing it as if it could only moves the failure
    // to the marketplace fence, three steps from the cause.
    if (!studioShippingTemplateId) {
      throw new Error(
        "This listing has no sealed Walmart shipping template from its build, "
          + "so it cannot be prepared for publishing.",
      );
    }
    if (!studioIngredientImage) {
      throw new Error(
        "Walmart requires an image of the ingredient list to create a food "
          + `listing, and none could be produced: ${studioIngredientImageError ?? "unknown reason"}`,
      );
    }
    if (!studioNetContent) {
      throw new Error(
        "This listing has no usable manufacturer net content (amount + unit), "
          + "which Walmart requires to create a food item.",
      );
    }
    if (!studioFulfillmentCenterId) {
      throw new Error(
        `No Walmart ship node is configured (Setting ${WALMART_DEFAULT_SHIP_NODE_SETTING_KEY}), `
          + "so this listing cannot be prepared for publishing.",
      );
    }
    const base = JSON.parse(richAttributesJson) as Record<string, unknown>;
    base.listing_lane = WALMART_STUDIO_LISTING_LANE;
    base.walmart = buildWalmartStudioPublicAttributes({
      packCount: draft.pack_count,
      productType: studioProductType,
      countryOfOrigin: STUDIO_COUNTRY_OF_ORIGIN,
      secondaryImageUrls: hostedGalleryUrls,
      spec: studioSpec,
      fulfillmentCenterId: studioFulfillmentCenterId,
      declaredQuantity: WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
      ingredientListImageUrl: studioIngredientImage!,
      netContent: studioNetContent!,
      // Canned soup. Both are facts about the packaging, taken from the
      // product, and both are required by Walmart to create the item.
      containerMaterial: ["Metal"],
      foodCondition: ["Shelf-Stable"],
    });
    base[WALMART_STUDIO_LISTING_ATTRIBUTE_KEY] = buildWalmartStudioListingEvidence({
      sku: skuCode,
      storeIndex: 1,
      packCount: draft.pack_count,
      verifiedAt: new Date(),
      component: studioComponent,
      // Every flavor, so the evidence and the duplicate check see the real box.
      ...(snapshotComponents.length > 1
        ? {
          components: snapshotComponents
            .map((entry) => ({
              component: entry?.product_truth_component ?? {},
              quantity: Number(entry?.qty),
            }))
            .filter((entry) => Number.isInteger(entry.quantity) && entry.quantity > 0),
        }
        : {}),
      images: [{
        role: "MAIN",
        url: mainImageUrl,
        output_sha256: String(studioImage.output_sha256 ?? ""),
        source_asset_sha256s: [String(studioImage.source_asset_sha256 ?? "")],
        represented_unit_count: Number(studioImage.represented_unit_count),
        construction_method:
          studioImage.construction_method === "EXACT_SOURCE_ASSET"
            ? "EXACT_SOURCE_ASSET"
            : "DETERMINISTIC_EXACT_PIXEL_MULTIPACK",
        exact_source_url: String(studioImage.exact_source_url ?? ""),
      }],
      shippingTemplateId: studioShippingTemplateId,
      fulfillmentCenterId: studioFulfillmentCenterId,
      declaredQuantity: WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
    });
    return JSON.stringify(base);
  }

  // Browse node depends on the bundle's brand mix, not the channel.
  // Pull the MasterBundle's BundleComponents once and compute the
  // distinct-brand count so resolveAmazonBrowseNode can decide.
  const distinctBrands = countDistinctBrands(
    masterComponents.map((component) => ({ brand: component.manufacturer_brand })),
  );

  for (const row of candidates) {
    // Already a ChannelSKU for this MasterBundle × channel?
    const existingSku = await prisma.channelSKU.findFirst({
      where: { master_bundle_id: masterBundleId, channel: row.channel },
      select: {
        id: true,
        sku: true,
        package_weight_oz: true,
        package_length_in: true,
        package_width_in: true,
        package_height_in: true,
      },
    });
    if (existingSku) {
      // Measured operator specs always win; the studio estimate only fills a
      // field nobody has measured yet.
      const verifiedFields = verifiedPhysicalSpecs
        ? physicalPackageFields(verifiedPhysicalSpecs)
        : row.channel === "WALMART" && studioPackage
          ? studioPackage
          : null;
      const walmartAttributes =
        row.channel === "WALMART" && row.main_image_url
          ? walmartStudioAttributesJson(existingSku.sku, row.main_image_url)
          : null;
      await prisma.channelSKU.update({
        where: { id: existingSku.id },
        data: {
          title: row.title,
          bullets: row.bullets_json,
          description: row.description,
          attributes: walmartAttributes ?? richAttributesJson,
          ...(row.channel === "WALMART" && studioProductType
            ? {
                item_type: studioProductType,
                country_of_origin: STUDIO_COUNTRY_OF_ORIGIN,
              }
            : {}),
          price_cents: autoPriceCents,
          ...(canonicalBusinessPrice != null
            ? { business_price_cents: canonicalBusinessPrice }
            : {}),
          main_image_url: row.main_image_url,
          compliance_status: "CAN_PUBLISH",
          compliance_check_id: row.compliance_check_id,
          lifecycle_status: "GENERATED",
          validation_status: "PENDING",
          validated_at: null,
          available_quantity: null,
          inventory_checked_at: null,
          // Preserve channel-specific existing measurements. Only fill a
          // missing field from the exact operator-verified MasterBundle proof.
          ...(verifiedFields && existingSku.package_weight_oz == null
            ? { package_weight_oz: verifiedFields.package_weight_oz }
            : {}),
          ...(verifiedFields && existingSku.package_length_in == null
            ? { package_length_in: verifiedFields.package_length_in }
            : {}),
          ...(verifiedFields && existingSku.package_width_in == null
            ? { package_width_in: verifiedFields.package_width_in }
            : {}),
          ...(verifiedFields && existingSku.package_height_in == null
            ? { package_height_in: verifiedFields.package_height_in }
            : {}),
        },
      });
      existing.push(row.channel);
      continue;
    }
    const upcRow = await reserveUpc(draftId, row.channel);
    if (!upcRow) {
      skipped.push({
        channel: row.channel,
        reason:
          `No product ID could be attached: after ${MAX_UPC_ATTACH_ATTEMPTS} tries `
          + "every candidate was already in Walmart's catalogue, unverifiable, or "
          + "the pool is empty.",
      });
      continue;
    }
    const sku = buildSku(draft.brand, row.channel, draftId);
    try {
      const skuRow = await prisma.channelSKU.create({
        data: {
          master_bundle_id: masterBundleId,
          channel: row.channel,
          sku,
          upc: upcRow.upc,
          upc_pool_id: upcRow.id,
          title: row.title,
          bullets: row.bullets_json,
          description: row.description,
          attributes:
            (row.channel === "WALMART" && row.main_image_url
              ? walmartStudioAttributesJson(sku, row.main_image_url)
              : null) ?? richAttributesJson,
          ...(row.channel === "WALMART" && studioProductType
            ? {
                item_type: studioProductType,
                country_of_origin: STUDIO_COUNTRY_OF_ORIGIN,
              }
            : {}),
          ...(verifiedPhysicalSpecs
            ? physicalPackageFields(verifiedPhysicalSpecs)
            : row.channel === "WALMART" && studioPackage
              ? studioPackage
              : {}),
          channel_browse_node: resolveAmazonBrowseNode({
            channel: row.channel,
            distinct_brands: distinctBrands,
          }),
          price_cents: autoPriceCents, // auto — pricing model × COGS
          ...(canonicalBusinessPrice != null
            ? { business_price_cents: canonicalBusinessPrice }
            : {}),
          main_image_url: row.main_image_url,
          compliance_status: "CAN_PUBLISH",
          compliance_check_id: row.compliance_check_id,
          lifecycle_status: "GENERATED",
        } as Prisma.ChannelSKUUncheckedCreateInput,
        select: { id: true },
      });
      // Flip UPCPool → ASSIGNED.
      await prisma.uPCPool.update({
        where: { id: upcRow.id },
        data: {
          status: "ASSIGNED",
          assigned_to_id: skuRow.id,
          reserved_for_id: null,
          reserved_at: null,
          reserved_until: null,
        },
      });
      created.push(row.channel);
    } catch (e) {
      skipped.push({
        channel: row.channel,
        reason: `create failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      // Best-effort: release the UPC reservation so it's reusable.
      await prisma.uPCPool.update({
        where: { id: upcRow.id },
        data: {
          status: "AVAILABLE",
          reserved_for_id: null,
          reserved_at: null,
          reserved_until: null,
        },
      }).catch(() => {});
    }
  }

  return {
    master_bundle_id: masterBundleId,
    created_channels: created,
    existing_channels: existing,
    skipped,
  };
}
