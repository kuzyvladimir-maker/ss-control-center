import { createHash } from "node:crypto";

import { buildDeterministicWalmartMultipackContent } from "./walmart-new-sku-engine";
import {
  minimumWalmartNewSkuPriceForTargetMargin,
  walmartNewSkuComparableSignal,
} from "./walmart-new-sku-economics";

export const WALMART_NEW_SKU_OWNER_PREVIEW_SCHEMA =
  "walmart-new-sku-owner-preview-gallery/1.0.0" as const;

export interface WalmartNewSkuOwnerPreviewSource {
  generatedAt: string;
  sourcePlanPath: string;
  sourcePlanSha256: string;
  donorProductId: string;
  canonicalVariantId: string;
  manufacturerUpc: string;
  productName: string;
  brand: string;
  flavor: string | null;
  size: string;
  category: string;
  unitNetWeightOz: number;
  unitPriceCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
  description: string;
  ingredients: string;
  mainImageUrl: string;
  imageUrls: string[];
  packCounts: Array<2 | 3>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function exactHttpsUrl(value: string, label: string): string {
  const url = new URL(requiredText(value, label));
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

export function buildWalmartNewSkuOwnerPreviewGallery(
  input: WalmartNewSkuOwnerPreviewSource,
) {
  const generatedAtMs = Date.parse(input.generatedAt);
  if (
    !Number.isFinite(generatedAtMs) ||
    new Date(generatedAtMs).toISOString() !== input.generatedAt
  ) {
    throw new Error("generatedAt must be canonical ISO UTC");
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourcePlanSha256)) {
    throw new Error("sourcePlanSha256 must be lowercase SHA-256");
  }
  if (!/^cpv1:[a-f0-9]{64}$/.test(input.canonicalVariantId)) {
    throw new Error("canonicalVariantId must be a canonical cpv1 key");
  }
  if (!/^\d{12,14}$/.test(input.manufacturerUpc)) {
    throw new Error("manufacturerUpc must contain 12-14 digits");
  }
  if (
    !Number.isSafeInteger(input.unitPriceCents) ||
    input.unitPriceCents <= 0 ||
    !Number.isSafeInteger(input.packagingCostCents) ||
    input.packagingCostCents <= 0 ||
    !Number.isSafeInteger(input.shippingLabelCents) ||
    input.shippingLabelCents <= 0 ||
    !Number.isFinite(input.unitNetWeightOz) ||
    input.unitNetWeightOz <= 0
  ) {
    throw new Error("preview economics and unit weight must be positive");
  }
  const packCounts = [...new Set(input.packCounts)].sort();
  if (
    packCounts.length === 0 ||
    packCounts.some((count) => count !== 2 && count !== 3)
  ) {
    throw new Error("preview packCounts must contain only 2 or 3");
  }
  const mainImageUrl = exactHttpsUrl(input.mainImageUrl, "mainImageUrl");
  const imageUrls = [...new Set([
    mainImageUrl,
    ...input.imageUrls.map((url, index) =>
      exactHttpsUrl(url, `imageUrls[${index}]`)
    ),
  ])].slice(0, 8);
  if (imageUrls.length < 2) {
    throw new Error("at least two exact-variant preview images are required");
  }
  const productName = requiredText(input.productName, "productName");
  const brand = requiredText(input.brand, "brand");
  const description = requiredText(input.description, "description");
  const ingredients = requiredText(input.ingredients, "ingredients");
  const source = {
    source_plan_path: requiredText(input.sourcePlanPath, "sourcePlanPath"),
    source_plan_sha256: input.sourcePlanSha256,
    donor_product_id: requiredText(input.donorProductId, "donorProductId"),
    canonical_variant_id: input.canonicalVariantId,
    manufacturer_upc: input.manufacturerUpc,
    authority:
      "SEALED_PRODUCT_TRUTH_PREVIEW_ONLY_NOT_PUBLICATION_EVIDENCE" as const,
  };
  const listingPreviews = packCounts.map((packCount) => {
    const content = buildDeterministicWalmartMultipackContent({
      component: {
        product_name: productName,
        manufacturer_brand: brand,
        flavor: input.flavor,
        qty: packCount,
      },
      packCount,
    });
    const economics = minimumWalmartNewSkuPriceForTargetMargin({
      goodsCostCents: input.unitPriceCents * packCount,
      packagingCostCents: input.packagingCostCents,
      shippingLabelCents: input.shippingLabelCents,
    });
    const linearizedComparableCents = input.unitPriceCents * packCount;
    const comparison = walmartNewSkuComparableSignal({
      itemPriceCents: economics.item_price_cents,
      linearizedComparableCents,
    });
    const preview = {
      preview_id: `wm-preview-${packCount}-${sha256({
        donor_product_id: source.donor_product_id,
        canonical_variant_id: source.canonical_variant_id,
        pack_count: packCount,
      }).slice(0, 12)}`,
      pack_count: packCount,
      product_name: productName,
      brand,
      flavor: input.flavor,
      size_each: requiredText(input.size, "size"),
      total_net_weight_oz: Number(
        (input.unitNetWeightOz * packCount).toFixed(2),
      ),
      category: requiredText(input.category, "category"),
      title: content.title,
      bullets: content.bullets,
      description: content.description,
      source_description_preview: description,
      ingredients,
      price_cents: economics.item_price_cents,
      economics,
      comparable: {
        exact_component_unit_price_cents: input.unitPriceCents,
        linearized_comparable_cents: linearizedComparableCents,
        ...comparison,
        disposition: "WARNING_ONLY_NOT_CANDIDATE_REJECTION" as const,
      },
      gallery: {
        unit_image_urls: imageUrls,
        main_visualization:
          "DUPLICATED_EXACT_DONOR_UNIT_IMAGE_PREVIEW_ONLY" as const,
        represented_unit_count: packCount,
        publication_rights_status:
          "NOT_CLEARED_PREVIEW_ONLY" as const,
      },
      publication_readiness: {
        status: "BLOCKED_PREVIEW_ONLY" as const,
        blockers: [
          "FRESH_EXACT_PRODUCT_TRUTH_EVIDENCE_REQUIRED",
          "COUNT_ACCURATE_RIGHTS_CLEARED_IMAGES_REQUIRED",
          "CURRENT_POLICY_RECALL_ACCOUNT_AND_ITEM_SPEC_CHECKS_REQUIRED",
          "UPC_NOT_RESERVED",
          "OWNER_LIVE_PUBLICATION_PERMIT_NOT_GRANTED",
        ],
      },
    };
    return {
      ...preview,
      preview_sha256: sha256(preview),
    };
  });
  const artifact = {
    schema_version: WALMART_NEW_SKU_OWNER_PREVIEW_SCHEMA,
    generated_at: input.generatedAt,
    channel: "WALMART_US" as const,
    source,
    rules: {
      target_margin_bps: 3_000,
      referral_fee_bps: 1_500,
      comparable_is_informational_not_hard_reject: true,
      walmart_pricing_rule_can_still_unpublish: true,
      marketplace_mutated: false,
      database_mutated: false,
      upc_reserved: false,
    },
    listing_previews: listingPreviews,
  };
  return {
    ...artifact,
    artifact_sha256: sha256(artifact),
  };
}
