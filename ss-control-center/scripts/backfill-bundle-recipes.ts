/**
 * Repair legacy Bundle Factory recipes from the selected VariationMatrix row.
 *
 * Safety:
 *   - DB-only; never calls a marketplace API.
 *   - Dry-run by default.
 *   - Writes require BOTH --apply and the exact confirmation phrase.
 *   - Draft/master/SKU source rows are SHA-guarded inside the transaction.
 *   - Marketplace identity, publication statuses, and timestamps are preserved.
 *   - Changed recipes invalidate approval/compliance/validation/inventory only.
 *
 * Examples:
 *   npx tsx scripts/backfill-bundle-recipes.ts
 *   npx tsx scripts/backfill-bundle-recipes.ts --draft-id=... --verbose
 *   npx tsx scripts/backfill-bundle-recipes.ts \
 *     --apply --confirm=BACKFILL_BUNDLE_RECIPES
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";

import {
  parseDonorEnrichmentManifest,
  projectDonorEnrichment,
  projectSelectedVariantAliases,
  textSha256,
  UNCRUSTABLES_DONOR_MANIFEST_SHA256,
  type DonorEnrichmentManifest,
} from "@/lib/bundle-factory/donor-enrichment";
import {
  parseStoredAllergenDeclaration,
  serializeAllergenDeclaration,
} from "@/lib/bundle-factory/allergen-declaration";

import {
  buildCanonicalRecipe,
  recipeSignature,
  selectedVariantFromJson,
  type CanonicalRecipeComponent,
  type RepairDonor,
} from "@/lib/bundle-factory/recipe-repair";
import {
  assertRecipeBackfillDigest,
  recipeBackfillAuditEvent,
  recipeBackfillChannelSkuInvalidation,
  recipeBackfillDraftInvalidation,
  recipeBackfillGeneratedContentInvalidation,
  recipeBackfillOptimisticDigest,
  recipeBackfillPublicationDigest,
} from "@/lib/bundle-factory/recipe-backfill-safety";

config({ path: ".env.local" });
config({ path: ".env" });

const CONFIRMATION = "BACKFILL_BUNDLE_RECIPES";

const DRAFT_SELECT = {
  id: true,
  updated_at: true,
  generation_job_id: true,
  master_bundle_id: true,
  status: true,
  approved_at: true,
  approved_by: true,
  approval_notes: true,
  published_at: true,
  compliance_status: true,
  compliance_check_id: true,
  compliance_blocked_at: true,
  compliance_blocked_reasons: true,
  draft_name: true,
  brand: true,
  category: true,
  composition_type: true,
  pack_count: true,
  draft_components: true,
  draft_cost_cents: true,
  draft_suggested_price_cents: true,
  variation_matrix: {
    select: {
      id: true,
      updated_at: true,
      variants_json: true,
      selected_variant_idx: true,
    },
  },
  generated_content: {
    select: {
      id: true,
      updated_at: true,
      compliance_status: true,
      compliance_check_id: true,
      manual_review_required: true,
      failed_rule_ids: true,
    },
  },
} as const;

const MASTER_SELECT = {
  id: true,
  updated_at: true,
  lifecycle_status: true,
  total_weight_oz: true,
  estimated_cost_cents: true,
  suggested_price_cents: true,
  packaging_spec: true,
  components: {
    select: {
      id: true,
      updated_at: true,
      product_name: true,
      manufacturer_brand: true,
      manufacturer_upc: true,
      flavor: true,
      qty: true,
      unit_price_cents: true,
      source_url: true,
      ingredients: true,
      allergens: true,
      storage_temp: true,
      donor_image_urls: true,
    },
  },
  channel_skus: {
    select: {
      id: true,
      updated_at: true,
      channel: true,
      sku: true,
      upc: true,
      asin: true,
      walmart_item_id: true,
      ebay_item_id: true,
      tiktok_product_id: true,
      attributes: true,
      price_cents: true,
      business_price_cents: true,
      lifecycle_status: true,
      listing_status: true,
      submission_id: true,
      submitted_at: true,
      processing_at: true,
      live_at: true,
      live_url: true,
      published_at: true,
      last_status_check_at: true,
      distribution_attempt_count: true,
      distribution_errors: true,
      last_error_at: true,
      errors: true,
      compliance_status: true,
      compliance_check_id: true,
      compliance_blocked_at: true,
      compliance_blocked_reasons: true,
      validation_status: true,
      validation_errors: true,
      validated_at: true,
      validation_check_id: true,
      available_quantity: true,
      inventory_checked_at: true,
    },
  },
} as const;

interface Options {
  apply: boolean;
  confirm: string | null;
  brand: string;
  allBrands: boolean;
  includeUnpromoted: boolean;
  draftId: string | null;
  limit: number | null;
  verbose: boolean;
  enrichmentManifest: string | null;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/backfill-bundle-recipes.ts [options]",
    "",
    "Options:",
    "  --brand=NAME           Brand filter (default: Uncrustables).",
    "  --all-brands           Remove the default brand scope.",
    "  --include-unpromoted   Include drafts with no MasterBundle (default: promoted only).",
    "  --draft-id=ID          Inspect one draft only.",
    "  --limit=N              Inspect at most N drafts.",
    "  --enrichment-manifest=PATH",
    "                         Use SHA-pinned reviewed donor allergens. Apply is allowed only",
    "                         after donor/alias enrichment is already exact and complete.",
    "  --verbose              Print unchanged rows and full block reasons.",
    "  --apply                Enable database writes.",
    `  --confirm=${CONFIRMATION}`,
    "                         Mandatory exact phrase together with --apply.",
    "  --help                 Show this help.",
    "",
    "Without --apply the command is read-only. It never calls Amazon/Walmart.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    confirm: null,
    brand: "Uncrustables",
    allBrands: false,
    includeUnpromoted: false,
    draftId: null,
    limit: null,
    verbose: false,
    enrichmentManifest: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--all-brands") {
      options.allBrands = true;
    } else if (arg === "--include-unpromoted") {
      options.includeUnpromoted = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--confirm=")) {
      options.confirm = arg.slice("--confirm=".length);
    } else if (arg.startsWith("--brand=")) {
      options.brand = arg.slice("--brand=".length).trim();
      if (!options.brand) throw new Error("--brand cannot be empty");
    } else if (arg.startsWith("--draft-id=")) {
      options.draftId = arg.slice("--draft-id=".length).trim();
      if (!options.draftId) throw new Error("--draft-id cannot be empty");
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = value;
    } else if (arg.startsWith("--enrichment-manifest=")) {
      options.enrichmentManifest = arg.slice("--enrichment-manifest=".length).trim();
      if (!options.enrichmentManifest) {
        throw new Error("--enrichment-manifest cannot be empty");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (options.apply && options.confirm !== CONFIRMATION) {
    throw new Error(
      `Writes are locked. Re-run with --apply --confirm=${CONFIRMATION}`,
    );
  }
  if (!options.apply && options.confirm) {
    throw new Error("--confirm is only valid together with --apply");
  }
  return options;
}

function loadPinnedEnrichmentManifest(path: string): DonorEnrichmentManifest {
  const raw = readFileSync(resolve(process.cwd(), path));
  const actualDigest = createHash("sha256").update(raw).digest("hex");
  if (actualDigest !== UNCRUSTABLES_DONOR_MANIFEST_SHA256) {
    throw new Error(
      `Reviewed enrichment manifest digest mismatch: expected ` +
        `${UNCRUSTABLES_DONOR_MANIFEST_SHA256}, got ${actualDigest}`,
    );
  }
  const manifest = parseDonorEnrichmentManifest(JSON.parse(raw.toString("utf8")));
  const ledgerRaw = readFileSync(resolve(process.cwd(), manifest.ledger.path));
  const ledgerDigest = createHash("sha256").update(ledgerRaw).digest("hex");
  if (ledgerDigest !== manifest.ledger.sha256) {
    throw new Error(
      `Source ledger digest mismatch: expected ${manifest.ledger.sha256}, got ${ledgerDigest}`,
    );
  }
  return manifest;
}

async function assertReviewedEnrichmentAlreadyApplied(
  prisma: Awaited<typeof import("@/lib/prisma")>["prisma"],
  manifest: DonorEnrichmentManifest,
): Promise<void> {
  const donorIds = manifest.donors.map((entry) => entry.donor_id);
  const donors = await prisma.donorProduct.findMany({
    where: { id: { in: donorIds } },
    select: { id: true, upc: true, ingredients: true },
  });
  if (donors.length !== donorIds.length) {
    throw new Error("Reviewed donor set is incomplete; run enrichment preflight first");
  }
  for (const donor of donors) {
    const projected = projectDonorEnrichment(donor, manifest);
    if (
      projected.upc !== donor.upc ||
      projected.ingredients !== donor.ingredients
    ) {
      throw new Error(
        `Donor ${donor.id} still needs reviewed enrichment; recipe apply is locked`,
      );
    }
  }

  const matrices = await prisma.variationMatrix.findMany({
    where: {
      bundle_draft: {
        brand: { contains: "Uncrustables" },
        master_bundle_id: { not: null },
      },
    },
    select: {
      id: true,
      bundle_draft_id: true,
      selected_variant_idx: true,
      variants_json: true,
    },
  });
  const alias = manifest.aliases[0];
  const targetById = new Map(
    alias.targets.map((target) => [target.variation_matrix_id, target]),
  );
  const foundTargets = new Set<string>();
  for (const matrix of matrices) {
    const projection = projectSelectedVariantAliases(
      selectedVariantFromJson(matrix.variants_json, matrix.selected_variant_idx),
      manifest,
    );
    if (projection.replacements > 0) {
      throw new Error(
        `Matrix ${matrix.id} still contains the deleted donor alias; recipe apply is locked`,
      );
    }
    const target = targetById.get(matrix.id);
    if (!target) continue;
    foundTargets.add(matrix.id);
    if (
      matrix.bundle_draft_id !== target.bundle_draft_id ||
      matrix.selected_variant_idx !== target.selected_variant_idx ||
      textSha256(matrix.variants_json) !== target.post_variants_sha256
    ) {
      throw new Error(`Pinned alias matrix ${matrix.id} is not at reviewed post-state`);
    }
  }
  if (foundTargets.size !== alias.targets.length) {
    throw new Error("One or more pinned alias matrices are missing; recipe apply is locked");
  }
}

function safeJson(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function draftSignature(value: string): string | null {
  const parsed = safeJson(value, null);
  if (!Array.isArray(parsed)) return null;
  const components: Array<{
    manufacturer_upc: string;
    flavor: string;
    qty: number;
  }> = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") return null;
    const component = raw as Record<string, unknown>;
    const upc = typeof component.manufacturer_upc === "string"
      ? component.manufacturer_upc
      : "";
    const flavor = typeof component.flavor === "string" ? component.flavor : "";
    const qty = Number(component.qty);
    if (!upc.trim() || !flavor.trim() || !Number.isInteger(qty) || qty <= 0) {
      return null;
    }
    components.push({ manufacturer_upc: upc, flavor, qty });
  }
  return recipeSignature(components);
}

function persistedSignature(
  components: Array<{
    manufacturer_upc: string | null;
    flavor: string | null;
    qty: number;
  }>,
): string | null {
  if (
    components.some(
      (component) =>
        !component.manufacturer_upc?.trim() ||
        !component.flavor?.trim() ||
        !Number.isInteger(component.qty) ||
        component.qty <= 0,
    )
  ) {
    return null;
  }
  return recipeSignature(
    components.map((component) => ({
      manufacturer_upc: component.manufacturer_upc!,
      flavor: component.flavor!,
      qty: component.qty,
    })),
  );
}

function draftComponentsComplete(
  value: string,
  expected: CanonicalRecipeComponent[],
): boolean {
  const parsed = safeJson(value, null);
  if (!Array.isArray(parsed) || parsed.length !== expected.length) return false;
  return expected.every((component) => {
    const match = parsed.find((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const row = raw as Record<string, unknown>;
      return (
        String(row.manufacturer_upc ?? "").trim() === component.manufacturer_upc &&
        String(row.flavor ?? "").trim().toLowerCase() === component.flavor.toLowerCase() &&
        Number(row.qty) === component.qty
      );
    }) as Record<string, unknown> | undefined;
    if (!match) return false;
    const images = Array.isArray(match.donor_image_urls)
      ? match.donor_image_urls.filter((value): value is string => typeof value === "string")
      : [];
    const allergens = Array.isArray(match.allergens)
      ? match.allergens.filter((value): value is string => typeof value === "string")
      : [];
    return (
      String(match.brand ?? "").trim() === component.brand &&
      String(match.product_name ?? "").trim() === component.product_name &&
      Number(match.unit_price_cents) === component.unit_price_cents &&
      String(match.ingredients ?? "").trim() === component.ingredients &&
      JSON.stringify(match.allergen_declaration ?? null) ===
        JSON.stringify(component.allergen_declaration) &&
      JSON.stringify(allergens) === JSON.stringify(component.allergens) &&
      String(match.storage_temp ?? "").trim() === component.storage_temp &&
      JSON.stringify(images) === JSON.stringify(component.donor_image_urls)
    );
  });
}

function masterComponentsComplete(
  actual: Array<{
    product_name: string;
    manufacturer_brand: string;
    manufacturer_upc: string | null;
    flavor: string | null;
    qty: number;
    unit_price_cents: number;
    ingredients: string | null;
    allergens: string | null;
    storage_temp: string | null;
    donor_image_urls: string;
  }>,
  expected: CanonicalRecipeComponent[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((component) => {
    const row = actual.find(
      (candidate) =>
        candidate.manufacturer_upc?.trim() === component.manufacturer_upc &&
        candidate.flavor?.trim().toLowerCase() === component.flavor.toLowerCase() &&
        candidate.qty === component.qty,
    );
    if (!row) return false;
    const images = safeJson(row.donor_image_urls, []);
    const allergenDeclaration = parseStoredAllergenDeclaration(row.allergens);
    return (
      row.product_name === component.product_name &&
      row.manufacturer_brand === component.brand &&
      row.unit_price_cents === component.unit_price_cents &&
      row.ingredients?.trim() === component.ingredients &&
      JSON.stringify(allergenDeclaration) ===
        JSON.stringify(component.allergen_declaration) &&
      row.storage_temp?.trim() === component.storage_temp &&
      JSON.stringify(images) === JSON.stringify(component.donor_image_urls)
    );
  });
}

function componentRows(components: CanonicalRecipeComponent[]) {
  return components.map((component) => ({
    product_name: component.product_name,
    manufacturer_brand: component.brand,
    manufacturer_upc: component.manufacturer_upc,
    flavor: component.flavor,
    qty: component.qty,
    unit_price_cents: component.unit_price_cents,
    source_url: component.source_url ?? null,
    ingredients: component.ingredients,
    allergens: serializeAllergenDeclaration(component.allergen_declaration),
    storage_temp: component.storage_temp,
    donor_image_urls: JSON.stringify(component.donor_image_urls),
  }));
}

function mergeAttributes(input: {
  current: string;
  rich: Record<string, unknown>;
  floorCents: number;
  priceCents: number;
  marketplaceId: string;
}): string {
  const current = safeJson(input.current, {});
  const attrs = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  Object.assign(attrs, input.rich);
  const priorOffer = Array.isArray(attrs.purchasable_offer) && attrs.purchasable_offer[0]
    && typeof attrs.purchasable_offer[0] === "object"
    ? attrs.purchasable_offer[0] as Record<string, unknown>
    : {};
  attrs.purchasable_offer = [{
    ...priorOffer,
    marketplace_id: input.marketplaceId,
    currency: "USD",
    minimum_seller_allowed_price: [
      { schedule: [{ value_with_tax: input.floorCents / 100 }] },
    ],
    maximum_seller_allowed_price: [
      { schedule: [{ value_with_tax: input.priceCents / 100 }] },
    ],
  }];
  return JSON.stringify(attrs);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const enrichmentManifest = options.enrichmentManifest
    ? loadPinnedEnrichmentManifest(options.enrichmentManifest)
    : null;
  const { prisma } = await import("@/lib/prisma");
  const { getPricingModel } = await import("@/lib/bundle-factory/pricing-config");
  const { computeListingPrice } = await import("@/lib/bundle-factory/listing-pricing");
  const { buildRichAmazonAttributes } = await import(
    "@/lib/bundle-factory/attributes/build-amazon-attributes"
  );
  const { MARKETPLACE_ID } = await import("@/lib/amazon-sp-api/client");

  try {
    if (options.apply && enrichmentManifest) {
      await assertReviewedEnrichmentAlreadyApplied(prisma, enrichmentManifest);
    }
    const where = options.draftId
      ? { id: options.draftId }
      : {
          ...(!options.allBrands ? { brand: { contains: options.brand } } : {}),
          ...(!options.includeUnpromoted
            ? { master_bundle_id: { not: null } }
            : {}),
        };
    const drafts = await prisma.bundleDraft.findMany({
      where,
      orderBy: { created_at: "asc" },
      ...(options.limit ? { take: options.limit } : {}),
      select: DRAFT_SELECT,
    });
    if (
      options.apply &&
      !enrichmentManifest &&
      drafts.some((draft) => /uncrustables/i.test(draft.brand))
    ) {
      throw new Error(
        "Uncrustables recipe apply requires --enrichment-manifest with the pinned " +
          "reviewed contains/may-contain declarations",
      );
    }
    const model = await getPricingModel();
    let ready = 0;
    let blocked = 0;
    let unchanged = 0;
    let applied = 0;

    console.log(
      `Bundle recipe backfill: mode=${options.apply ? "APPLY" : "DRY-RUN"} scope=${options.draftId ?? (options.allBrands ? "all brands" : options.brand)} promoted_only=${!options.includeUnpromoted && !options.draftId} drafts=${drafts.length} enrichment_projection=${enrichmentManifest ? "reviewed" : "none"}`,
    );

    for (const draft of drafts) {
      const selectedVariant = draft.variation_matrix
        ? selectedVariantFromJson(
            draft.variation_matrix.variants_json,
            draft.variation_matrix.selected_variant_idx,
          )
        : null;
      const variant = enrichmentManifest
        ? projectSelectedVariantAliases(selectedVariant, enrichmentManifest).variant
        : selectedVariant;
      const donorIds = Array.from(
        new Set(
          (variant?.composition ?? [])
            .map((component) => component.research_pool_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );
      const donors = donorIds.length
        ? await prisma.donorProduct.findMany({
            where: { id: { in: donorIds } },
            select: {
              id: true,
              brand: true,
              productLine: true,
              flavor: true,
              title: true,
              category: true,
              upc: true,
              ingredients: true,
              bestPrice: true,
              mainImageUrl: true,
              imageUrls: true,
              needsReview: true,
              offers: {
                where: { isFirstParty: true, via: "direct" },
                orderBy: { price: "asc" },
                select: {
                  productUrl: true,
                  price: true,
                  packSizeSeen: true,
                  pricePerUnit: true,
                },
              },
            },
          })
        : [];
      const donorMap = new Map<string, RepairDonor>(
        donors.map((donor) => {
          const base: RepairDonor = {
            ...donor,
            sourceUrl: donor.offers[0]?.productUrl ?? null,
            offers: donor.offers,
          };
          return [
            donor.id,
            enrichmentManifest
              ? projectDonorEnrichment(base, enrichmentManifest)
              : base,
          ];
        }),
      );
      const recipe = buildCanonicalRecipe({
        variant,
        packCount: draft.pack_count,
        donors: donorMap,
      });
      if (!recipe.ok) {
        blocked += 1;
        console.log(
          `BLOCK ${draft.id} ${draft.draft_name}: ${options.verbose ? recipe.errors.join(" | ") : recipe.errors[0]}`,
        );
        continue;
      }

      const master = draft.master_bundle_id
        ? await prisma.masterBundle.findUnique({
            where: { id: draft.master_bundle_id },
            select: MASTER_SELECT,
          })
        : null;
      if (draft.master_bundle_id && !master) {
        blocked += 1;
        console.log(`BLOCK ${draft.id} ${draft.draft_name}: linked MasterBundle is missing`);
        continue;
      }

      const pricing = computeListingPrice(
        {
          brand: draft.brand,
          cogs_cents: recipe.cost_cents,
          weight_lb: master?.total_weight_oz ? master.total_weight_oz / 16 : null,
          unit_count: draft.pack_count,
          category: draft.category,
        },
        model,
      );
      const canonicalSignature = recipeSignature(recipe.components);
      const currentDraftSignature = draftSignature(draft.draft_components);
      const currentMasterSignature = master
        ? persistedSignature(master.components)
        : null;
      const hasChanges =
        currentDraftSignature !== canonicalSignature ||
        !draftComponentsComplete(draft.draft_components, recipe.components) ||
        (master != null && currentMasterSignature !== canonicalSignature) ||
        (master != null && !masterComponentsComplete(master.components, recipe.components)) ||
        draft.draft_cost_cents !== recipe.cost_cents ||
        draft.draft_suggested_price_cents !== pricing.selling_price_cents ||
        (master != null &&
          (master.estimated_cost_cents !== recipe.cost_cents ||
            master.suggested_price_cents !== pricing.selling_price_cents));

      if (!hasChanges) {
        unchanged += 1;
        if (options.verbose) {
          console.log(`OK    ${draft.id} ${draft.draft_name}: already canonical`);
        }
        continue;
      }
      ready += 1;
      console.log(
        `${options.apply ? "APPLY" : "WOULD"} ${draft.id} ${draft.draft_name}: draft ${currentDraftSignature ? "stale" : "missing"}, master ${master ? `${master.components.length} component(s)` : "none"} -> ${recipe.components.length} component(s), ${draft.pack_count} units, $${(recipe.cost_cents / 100).toFixed(2)} COGS, $${(pricing.selling_price_cents / 100).toFixed(2)} price`,
      );
      if (!options.apply) continue;

      const combinedIngredients = recipe.components.length === 1
        ? recipe.components[0].ingredients
        : recipe.components
            .map((component) => `${component.flavor}: ${component.ingredients}`)
            .join("; ");
      const rich = buildRichAmazonAttributes({
        ingredients: combinedIngredients,
        allergens: Array.from(
          new Set(recipe.components.flatMap((component) => component.allergens)),
        ),
        packCount: draft.pack_count,
        category: draft.category,
      });
      const skuAttributes = new Map(
        (master?.channel_skus ?? []).map((sku) => [
          sku.id,
          mergeAttributes({
            current: sku.attributes,
            rich,
            floorCents: pricing.floor_price_cents,
            priceCents: pricing.selling_price_cents,
            marketplaceId: MARKETPLACE_ID,
          }),
        ]),
      );
      const expectedOptimisticDigest = recipeBackfillOptimisticDigest({
        draft,
        master,
      });
      const expectedPublicationDigest = recipeBackfillPublicationDigest({
        draft,
        master,
      });

      try {
        await prisma.$transaction(async (tx) => {
          const currentDraft = await tx.bundleDraft.findUniqueOrThrow({
            where: { id: draft.id },
            select: DRAFT_SELECT,
          });
          const currentMaster = master
            ? await tx.masterBundle.findUnique({
                where: { id: master.id },
                select: MASTER_SELECT,
              })
            : null;
          if (master && !currentMaster) {
            throw new Error(
              `MasterBundle ${master.id} disappeared after the read-only plan; transaction rolled back`,
            );
          }
          assertRecipeBackfillDigest(
            `Draft ${draft.id} recipe source snapshot`,
            expectedOptimisticDigest,
            recipeBackfillOptimisticDigest({
              draft: currentDraft,
              master: currentMaster,
            }),
          );

          const draftUpdated = await tx.bundleDraft.updateMany({
            where: {
              id: draft.id,
              updated_at: currentDraft.updated_at,
              master_bundle_id: currentDraft.master_bundle_id,
              status: currentDraft.status,
              published_at: currentDraft.published_at,
            },
            data: {
              draft_components: JSON.stringify(recipe.components),
              draft_cost_cents: recipe.cost_cents,
              draft_suggested_price_cents: pricing.selling_price_cents,
              ...recipeBackfillDraftInvalidation(),
            },
          });
          if (draftUpdated.count !== 1) {
            throw new Error(
              `Draft ${draft.id} optimistic update failed; transaction rolled back`,
            );
          }
          for (const content of currentDraft.generated_content) {
            const contentUpdated = await tx.generatedContent.updateMany({
              where: { id: content.id, updated_at: content.updated_at },
              data: recipeBackfillGeneratedContentInvalidation(),
            });
            if (contentUpdated.count !== 1) {
              throw new Error(
                `GeneratedContent ${content.id} optimistic update failed; transaction rolled back`,
              );
            }
          }
          if (currentDraft.approved_at) {
            const approvalCounterUpdated = await tx.generationJob.updateMany({
              where: {
                id: draft.generation_job_id,
                bundles_approved: { gt: 0 },
              },
              data: { bundles_approved: { decrement: 1 } },
            });
            if (approvalCounterUpdated.count !== 1) {
              throw new Error(
                `GenerationJob ${draft.generation_job_id} approval counter is inconsistent; transaction rolled back`,
              );
            }
          }

          if (currentMaster) {
            await tx.bundleComponent.deleteMany({
              where: { master_bundle_id: currentMaster.id },
            });
            await tx.bundleComponent.createMany({
              data: componentRows(recipe.components).map((component) => ({
                master_bundle_id: currentMaster.id,
                ...component,
              })),
            });
            const priorPackaging = safeJson(currentMaster.packaging_spec, {});
            const masterUpdated = await tx.masterBundle.updateMany({
              where: {
                id: currentMaster.id,
                updated_at: currentMaster.updated_at,
                lifecycle_status: currentMaster.lifecycle_status,
              },
              data: {
                name: draft.draft_name,
                brand: draft.brand,
                category: draft.category,
                composition_type: draft.composition_type,
                pack_count: draft.pack_count,
                generation_job_id: draft.generation_job_id,
                estimated_cost_cents: recipe.cost_cents,
                suggested_price_cents: pricing.selling_price_cents,
                cost_breakdown: JSON.stringify({
                  goods_cents: recipe.cost_cents,
                  packaging_cents: pricing.cost.packaging_cents,
                  fba_cents: pricing.cost.fba_cents,
                  closing_cents: pricing.cost.closing_cents,
                  shipping_label_cents: pricing.cost.own_shipping_cents,
                  shipping_in_price: model.shipping_in_price,
                  sourcing_overhead_cents: 0,
                }),
                packaging_spec: JSON.stringify({
                  ...(priorPackaging && typeof priorPackaging === "object" && !Array.isArray(priorPackaging)
                    ? priorPackaging as Record<string, unknown>
                    : {}),
                  pricing_source: pricing.pricing_source,
                  cooler_size: pricing.cooler_size,
                  floor_price_cents: pricing.floor_price_cents,
                  shipping_in_price: model.shipping_in_price,
                }),
              },
            });
            if (masterUpdated.count !== 1) {
              throw new Error(
                `MasterBundle ${currentMaster.id} optimistic update failed; transaction rolled back`,
              );
            }
            const currentSkuById = new Map(
              currentMaster.channel_skus.map((sku) => [sku.id, sku]),
            );
            for (const [skuId, attributes] of skuAttributes) {
              const currentSku = currentSkuById.get(skuId);
              if (!currentSku) {
                throw new Error(
                  `ChannelSKU ${skuId} disappeared after the read-only plan; transaction rolled back`,
                );
              }
              const skuUpdated = await tx.channelSKU.updateMany({
                where: {
                  id: skuId,
                  updated_at: currentSku.updated_at,
                  lifecycle_status: currentSku.lifecycle_status,
                  listing_status: currentSku.listing_status,
                  asin: currentSku.asin,
                  submission_id: currentSku.submission_id,
                  submitted_at: currentSku.submitted_at,
                  live_at: currentSku.live_at,
                  published_at: currentSku.published_at,
                },
                data: {
                  attributes,
                  price_cents: pricing.selling_price_cents,
                  ...recipeBackfillChannelSkuInvalidation(),
                },
              });
              if (skuUpdated.count !== 1) {
                throw new Error(
                  `ChannelSKU ${skuId} optimistic update failed; transaction rolled back`,
                );
              }
            }
          }

          const persistedDraft = await tx.bundleDraft.findUniqueOrThrow({
            where: { id: draft.id },
            select: DRAFT_SELECT,
          });
          const persistedMaster = currentMaster
            ? await tx.masterBundle.findUniqueOrThrow({
                where: { id: currentMaster.id },
                select: MASTER_SELECT,
              })
            : null;
          assertRecipeBackfillDigest(
            `Draft ${draft.id} factual publication state`,
            expectedPublicationDigest,
            recipeBackfillPublicationDigest({
              draft: persistedDraft,
              master: persistedMaster,
            }),
          );

          const auditEvent = recipeBackfillAuditEvent({
            currentStatus: currentDraft.status,
            oldDraftSignature: currentDraftSignature,
            oldMasterSignature: currentMasterSignature,
            canonicalSignature,
            componentCount: recipe.components.length,
            packCount: draft.pack_count,
          });
          await tx.listingLifecycleLog.create({
            data: {
              entity_type: "BundleDraft",
              entity_id: draft.id,
              from_status: auditEvent.from_status,
              to_status: auditEvent.to_status,
              trigger: auditEvent.trigger,
              details: JSON.stringify(auditEvent.details),
              user_id: "backfill-bundle-recipes",
            },
          });
        });
        applied += 1;
      } catch (error) {
        blocked += 1;
        console.log(
          `BLOCK ${draft.id} ${draft.draft_name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      `Summary: scanned=${drafts.length} ready=${ready} unchanged=${unchanged} blocked=${blocked} applied=${applied} mode=${options.apply ? "APPLY" : "DRY-RUN"}`,
    );
    if (!options.apply && ready > 0) {
      console.log(
        `No writes made. To apply exactly this workflow, rerun with --apply --confirm=${CONFIRMATION}.`,
      );
    }
    if (blocked > 0) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ?? "";
if (/backfill-bundle-recipes\.(?:ts|js)$/.test(invokedPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
