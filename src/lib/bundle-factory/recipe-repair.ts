/** Pure helpers used by the explicit legacy-recipe backfill CLI. */

import {
  amazonAllergensFromDeclaration,
  normalizeAllergenDeclaration,
  type AllergenDeclaration,
} from "./allergen-declaration";
import {
  brandTokens,
  canonicalFlavorKey,
  normalizedOfferUnitPriceCents,
} from "./donor-dedup";
import type { Variant, VariantComponent } from "./variation-matrix";

export interface RepairDonor {
  id: string;
  brand: string | null;
  productLine?: string | null;
  flavor: string | null;
  title: string | null;
  category: string | null;
  upc: string | null;
  ingredients: string | null;
  /** Reviewed manufacturer-label declaration. When present, this is
   * authoritative over ingredient-keyword inference. */
  allergenDeclaration?: AllergenDeclaration | null;
  bestPrice: number | null;
  offers?: Array<{
    price: number | null;
    packSizeSeen: number | null;
    pricePerUnit?: number | null;
  }>;
  mainImageUrl: string | null;
  imageUrls: string | null;
  needsReview: boolean;
  sourceUrl?: string | null;
}

export interface CanonicalRecipeComponent extends VariantComponent {
  flavor: string;
  manufacturer_upc: string;
  ingredients: string;
  allergen_declaration: AllergenDeclaration;
  /** Amazon positive allergen tokens derived from `contains` only. */
  allergens: string[];
  storage_temp: string;
  donor_image_urls: string[];
  source_url?: string;
}

export type RecipeBuildResult =
  | {
      ok: true;
      variant: Variant;
      components: CanonicalRecipeComponent[];
      cost_cents: number;
    }
  | { ok: false; errors: string[] };

export function selectedVariantFromJson(
  variantsJson: string,
  selectedIndex: number | null,
): Variant | null {
  if (selectedIndex == null) return null;
  try {
    const parsed = JSON.parse(variantsJson) as unknown;
    if (!Array.isArray(parsed)) return null;
    const variants = parsed.filter(
      (value): value is Variant =>
        value != null && typeof value === "object" && Array.isArray((value as Variant).composition),
    );
    return (
      variants.find((variant) => variant.idx === selectedIndex) ??
      variants[selectedIndex] ??
      null
    );
  } catch {
    return null;
  }
}

function parseGallery(donor: RepairDonor): string[] {
  const gallery = new Set<string>();
  if (donor.mainImageUrl?.trim()) gallery.add(donor.mainImageUrl.trim());
  try {
    const parsed = donor.imageUrls ? JSON.parse(donor.imageUrls) : [];
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === "string" && value.trim()) gallery.add(value.trim());
      }
    }
  } catch {
    // The known main image is still retained; the caller decides whether that
    // is enough for the repair to proceed.
  }
  return Array.from(gallery);
}

/** Legacy catalog rows often predate the structured `flavor` column. Their
 * manufacturer/source title is still a factual catalog field, so derive only
 * the flavor label from that title with the same deterministic normalizer used
 * by new Studio sourcing. This removes brand, size, count and format words; it
 * does not infer a product that is absent from the selected donor title. */
function catalogFlavorLabel(args: {
  productName: string | null | undefined;
  donor: RepairDonor;
  selectedBrand: string | null | undefined;
}): string {
  const key = canonicalFlavorKey(args.productName, {
    brand: args.donor.brand ?? args.selectedBrand,
    productLine: args.donor.productLine,
    extraTokens: brandTokens(
      args.donor.brand,
      args.donor.productLine,
      args.selectedBrand,
      "Smucker's",
      "Uncrustables",
    ),
  });
  return key
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word === "&"
        ? word
        : word.length <= 2
          ? word.toUpperCase()
          : `${word[0].toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

/** Build a fail-closed recipe from the selected VariationMatrix variant.
 * DonorProduct is the authority for UPC, current per-unit cost, ingredients,
 * storage, and gallery; no missing fact is guessed from listing prose. */
export function buildCanonicalRecipe(input: {
  variant: Variant | null;
  packCount: number;
  donors: Map<string, RepairDonor>;
}): RecipeBuildResult {
  const errors: string[] = [];
  if (!input.variant) return { ok: false, errors: ["selected variant is missing or malformed"] };
  if (!Array.isArray(input.variant.composition) || input.variant.composition.length === 0) {
    return { ok: false, errors: ["selected variant has no composition"] };
  }

  const components: CanonicalRecipeComponent[] = [];
  for (const [index, selected] of input.variant.composition.entries()) {
    const label = `component ${index + 1}`;
    if (!selected.research_pool_id?.trim()) {
      errors.push(`${label}: donor id is missing`);
      continue;
    }
    const donor = input.donors.get(selected.research_pool_id);
    if (!donor) {
      errors.push(`${label}: donor ${selected.research_pool_id} not found`);
      continue;
    }
    if (donor.needsReview) errors.push(`${label}: donor is marked needsReview`);
    if (!Number.isInteger(selected.qty) || selected.qty <= 0) {
      errors.push(`${label}: qty must be a positive integer`);
    }
    const brand = donor.brand?.trim() || selected.brand?.trim();
    const productName = donor.title?.trim() || selected.product_name?.trim();
    const flavor =
      donor.flavor?.trim() ||
      selected.flavor?.trim() ||
      catalogFlavorLabel({
        productName,
        donor,
        selectedBrand: selected.brand,
      });
    const upc = donor.upc?.trim() || selected.manufacturer_upc?.trim();
    const ingredients = donor.ingredients?.trim() || selected.ingredients?.trim();
    const storage = donor.category?.trim() || selected.storage_temp?.trim();
    let allergenDeclaration: AllergenDeclaration | null = null;
    let allergens: string[] = [];
    try {
      const explicit = donor.allergenDeclaration ?? selected.allergen_declaration;
      if (explicit) {
        allergenDeclaration = normalizeAllergenDeclaration(
          explicit,
          `${label}.allergen_declaration`,
        );
        allergens = amazonAllergensFromDeclaration(allergenDeclaration);
      } else {
        errors.push(
          `${label}: verified manufacturer allergen declaration is missing`,
        );
      }
    } catch (error) {
      errors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Prefer a current raw retailer price normalized by the factual carton
    // count. If a legacy donor has no usable raw offer, retain the selected
    // variation's already-persisted per-unit snapshot; never reinterpret an
    // ambiguous warehouse-club `bestPrice` as one sandwich.
    const selectedUnitPrice =
      Number.isInteger(selected.unit_price_cents) && selected.unit_price_cents > 0
        ? selected.unit_price_cents
        : null;
    const unitPriceCents =
      normalizedOfferUnitPriceCents(donor) ?? selectedUnitPrice ?? 0;
    const images = parseGallery(donor);

    if (!brand) errors.push(`${label}: manufacturer brand is missing`);
    if (!productName) errors.push(`${label}: product name is missing`);
    if (!flavor) errors.push(`${label}: canonical flavor is missing`);
    if (!upc) errors.push(`${label}: manufacturer UPC is missing`);
    if (!ingredients) errors.push(`${label}: manufacturer ingredients are missing`);
    if (!storage) errors.push(`${label}: storage/category is missing`);
    if (unitPriceCents <= 0) errors.push(`${label}: current donor per-unit cost is missing`);
    if (images.length === 0) errors.push(`${label}: donor image reference is missing`);

    if (
      brand &&
      productName &&
      flavor &&
      upc &&
      ingredients &&
      allergenDeclaration &&
      storage &&
      unitPriceCents > 0 &&
      images.length > 0 &&
      Number.isInteger(selected.qty) &&
      selected.qty > 0
    ) {
      components.push({
        research_pool_id: donor.id,
        product_name: productName,
        brand,
        flavor,
        manufacturer_upc: upc,
        qty: selected.qty,
        unit_price_cents: unitPriceCents,
        ingredients,
        allergen_declaration: allergenDeclaration,
        allergens,
        storage_temp: storage,
        donor_image_urls: images,
        ...(donor.sourceUrl?.trim() ? { source_url: donor.sourceUrl.trim() } : {}),
        ...(selected.retail_pack_sizes?.length
          ? { retail_pack_sizes: selected.retail_pack_sizes }
          : {}),
      });
    }
  }

  const total = components.reduce((sum, component) => sum + component.qty, 0);
  if (total !== input.packCount) {
    errors.push(`selected recipe total ${total} != draft pack_count ${input.packCount}`);
  }
  const flavorKeys = components.map((component) => component.flavor.toLowerCase().trim());
  if (new Set(flavorKeys).size !== flavorKeys.length) {
    errors.push("selected recipe repeats the same canonical flavor in multiple components");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    variant: input.variant,
    components,
    cost_cents: components.reduce(
      (sum, component) => sum + component.qty * component.unit_price_cents,
      0,
    ),
  };
}

export function recipeSignature(
  components: Array<Pick<CanonicalRecipeComponent, "manufacturer_upc" | "flavor" | "qty">>,
): string {
  return JSON.stringify(
    components
      .map((component) => ({
        upc: component.manufacturer_upc.trim(),
        flavor: component.flavor.toLowerCase().replace(/\s+/g, " ").trim(),
        qty: component.qty,
      }))
      .sort((a, b) => `${a.upc}|${a.flavor}`.localeCompare(`${b.upc}|${b.flavor}`)),
  );
}
