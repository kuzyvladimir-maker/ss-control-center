/** Exact recipe, content, price and image evidence gate for Walmart drafts. */

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "@/lib/sourcing/canonical-product-match-provenance";
import type { ValidatorFn } from "../types";
import {
  PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
  WALMART_PRICE_EVIDENCE_MAX_AGE_MS,
  computeProductTruthRecipeHash,
  hasText,
  isFreshIsoDate,
  isHttpUrl,
  isIngestibleProduct,
  isPastIsoDate,
  isPositiveInteger,
  isPositiveNumber,
  isRecord,
  isWalmartPilotImageUrl,
  parseWalmartAttributes,
  recordArray,
  type ProductTruthRecipeComponentEvidence,
  type ProductTruthPriceEvidence,
} from "../walmart-prepublication-policy";

function normalized(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function componentMatches(
  actual: {
    product_name: string;
    manufacturer_brand: string;
    manufacturer_upc: string | null;
    flavor: string | null;
    qty: number;
  },
  proof: ProductTruthRecipeComponentEvidence,
): boolean {
  const common =
    actual.qty === proof.qty &&
    normalized(actual.manufacturer_brand) ===
      normalized(proof.manufacturer_brand) &&
    normalized(actual.flavor) === normalized(proof.flavor);
  if (hasText(actual.manufacturer_upc) && hasText(proof.manufacturer_upc)) {
    return common && actual.manufacturer_upc === proof.manufacturer_upc;
  }
  return common && normalized(actual.product_name) === normalized(proof.product_name);
}

export const validatorWalmartProductTruth: ValidatorFn = async ({
  sku,
  master_bundle,
  bundle_components,
}) => {
  if (sku.channel !== "WALMART") {
    return {
      validator_id: "validator-walmart-product-truth",
      passed: true,
      details: { skipped: true, reason: "non_walmart_channel" },
    };
  }

  const parsed = parseWalmartAttributes(sku.attributes);
  const manifest = parsed.product_truth_manifest;
  const walmart = parsed.walmart;
  const failures: string[] = [];
  if (!master_bundle) failures.push("MasterBundle is missing");
  if (!manifest) failures.push("product_truth_manifest is missing");

  const componentRecords = manifest ? recordArray(manifest.components) : null;
  const imageRecords = manifest ? recordArray(manifest.images) : null;
  const components = componentRecords as unknown as ProductTruthRecipeComponentEvidence[] | null;

  if (manifest) {
    if (manifest.schema_version !== PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA) {
      failures.push(`unsupported manifest schema ${String(manifest.schema_version)}`);
    }
    if (!isRecord(manifest.listing_scope)) {
      failures.push("listing_scope is missing or malformed");
    } else {
      if (manifest.listing_scope.channel !== "WALMART") {
        failures.push("listing_scope.channel must be WALMART");
      }
      if (!isPositiveInteger(manifest.listing_scope.store_index)) {
        failures.push("listing_scope.store_index must be positive");
      }
      if (manifest.listing_scope.sku !== sku.sku) {
        failures.push("listing_scope.sku does not match ChannelSKU.sku");
      }
    }
    if (!isPastIsoDate(manifest.verified_at)) {
      failures.push("manifest verified_at is missing, invalid, or future-dated");
    }
    if (!components || components.length === 0) {
      failures.push("manifest components are missing or malformed");
    }
    if (!imageRecords || imageRecords.length === 0) {
      failures.push("top-level image evidence is missing or malformed");
    }
  }

  if (components && components.length > 0) {
    const keys = new Set<string>();
    const observationIds = new Set<string>();
    const ingestible = isIngestibleProduct({
      category: master_bundle?.category,
      itemType: sku.item_type,
      components: bundle_components,
    });

    for (const component of components) {
      const facts = isRecord(component.facts) ? component.facts : null;
      if (!hasText(component.component_key)) {
        failures.push("component_key is missing");
      } else if (keys.has(component.component_key)) {
        failures.push(`duplicate component_key ${component.component_key}`);
      } else {
        keys.add(component.component_key);
      }
      if (!hasText(component.canonical_variant_id)) {
        failures.push(`${component.component_key || "component"} lacks canonical_variant_id`);
      }
      if (
        !hasText(component.donor_product_id) ||
        !hasText(component.variant_decision_id) ||
        component.matcher_version !== CANONICAL_PRODUCT_MATCHER_VERSION ||
        component.matcher_implementation_sha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256 ||
        component.matcher_release_sha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
      ) {
        failures.push(`${component.component_key || "component"} lacks exact identity provenance`);
      }
      if (!isPositiveInteger(component.qty)) {
        failures.push(`${component.component_key || "component"} has invalid qty`);
      }
      if (component.content_role !== "EXACT") {
        failures.push(`${component.component_key || "component"} content_role is not EXACT`);
      }
      if (!hasText(component.content_observation_id)) {
        failures.push(`${component.component_key || "component"} lacks immutable content observation`);
      } else {
        observationIds.add(component.content_observation_id);
      }
      if (!isHttpUrl(component.content_source_url)) {
        failures.push(`${component.component_key || "component"} lacks valid content source URL`);
      }
      if (!isPastIsoDate(component.content_captured_at)) {
        failures.push(`${component.component_key || "component"} has invalid content_captured_at`);
      }
      if (ingestible && !hasText(facts?.ingredients)) {
        failures.push(`${component.component_key || "component"} lacks exact ingredients facts`);
      }
    }

    if (manifest?.recipe_hash !== computeProductTruthRecipeHash(components)) {
      failures.push("recipe_hash does not match canonical variant × quantity recipe");
    }

    if (components.length !== bundle_components.length) {
      failures.push(
        `manifest component count ${components.length} != bundle component count ${bundle_components.length}`,
      );
    } else {
      const unmatched = [...components];
      for (const actual of bundle_components) {
        const index = unmatched.findIndex((proof) => componentMatches(actual, proof));
        if (index < 0) {
          failures.push(`bundle component "${actual.product_name}" has no exact manifest match`);
          continue;
        }
        const proof = unmatched[index];
        const facts = isRecord(proof.facts) ? proof.facts : null;
        if (
          hasText(actual.ingredients) &&
          normalized(actual.ingredients) !== normalized(facts?.ingredients)
        ) {
          failures.push(`ingredients drift for ${proof.component_key}`);
        }
        unmatched.splice(index, 1);
      }
    }

    const recipeTotal = components.reduce(
      (sum, component) => sum + (isPositiveInteger(component.qty) ? component.qty : 0),
      0,
    );
    if (master_bundle && recipeTotal !== master_bundle.pack_count) {
      failures.push(`manifest total ${recipeTotal} != pack_count ${master_bundle.pack_count}`);
    }

    for (const component of components) {
      const price = isRecord(component.price_evidence)
        ? component.price_evidence as unknown as ProductTruthPriceEvidence
        : null;
      if (!price) {
        failures.push(`component ${component.component_key} has no separate price evidence`);
        continue;
      }
        if (
          price.role !== "PRICE" ||
          price.match_tier !== "EXACT_IDENTITY"
        ) {
          failures.push(`${component.component_key} is not exact price evidence`);
        }
        if (!hasText(price.observation_id) || !hasText(price.donor_offer_id)) {
          failures.push(`${component.component_key} lacks immutable offer provenance`);
        }
        if (!isHttpUrl(price.source_url)) {
          failures.push(`${component.component_key} lacks valid offer URL`);
        }
        if (!hasText(price.retailer) || price.first_party !== true) {
          failures.push(`${component.component_key} is not first-party retailer evidence`);
        }
        if (
          !["zip_scoped", "store_scoped"].includes(price.locality_evidence) ||
          (price.locality_evidence === "zip_scoped" &&
            !/^\d{5}(?:-\d{4})?$/.test(String(price.zip ?? "")))
        ) {
          failures.push(`${component.component_key} lacks valid offer locality`);
        }
        if (!isFreshIsoDate(price.observed_at, WALMART_PRICE_EVIDENCE_MAX_AGE_MS)) {
          failures.push(`${component.component_key} price evidence is stale or invalid`);
        }
        if (price.in_stock !== true) {
          failures.push(`${component.component_key} is not confirmed in stock`);
        }
        if (
          !isPositiveNumber(price.package_price) ||
          !isPositiveNumber(price.pack_size_seen) ||
          !isPositiveNumber(price.price_per_unit)
        ) {
          failures.push(`${component.component_key} has invalid price/pack values`);
        } else if (
          Math.abs(
            price.price_per_unit - price.package_price / price.pack_size_seen,
          ) > 0.005
        ) {
          failures.push(`${component.component_key} price_per_unit arithmetic mismatch`);
        }
    }

    if (imageRecords) {
      const mainImages = imageRecords.filter((image) => image.role === "MAIN");
      const imageUrls = new Set<string>();
      if (mainImages.length !== 1) {
        failures.push(`manifest requires exactly one MAIN image; found ${mainImages.length}`);
      }
      for (const image of imageRecords) {
        const depicted = Array.isArray(image.depicted_component_keys)
          ? image.depicted_component_keys.filter(hasText)
          : [];
        const sourceIds = Array.isArray(image.source_content_observation_ids)
          ? image.source_content_observation_ids.filter(hasText)
          : [];
        if (!isWalmartPilotImageUrl(image.url)) {
          failures.push(
            `${String(image.role)} image URL must be a query-free HTTPS JPEG/PNG on an allowed port`,
          );
        } else if (imageUrls.has(image.url)) {
          failures.push(`duplicate listing image URL ${image.url}`);
        } else {
          imageUrls.add(image.url);
        }
        if (depicted.length === 0 || depicted.some((key) => !keys.has(key))) {
          failures.push(`${String(image.role)} image component lineage is incomplete`);
        }
        if (sourceIds.length === 0 || sourceIds.some((id) => !observationIds.has(id))) {
          failures.push(`${String(image.role)} image lacks exact content observation lineage`);
        }
        if (!isPositiveInteger(image.represented_unit_count)) {
          failures.push(`${String(image.role)} image represented_unit_count is invalid`);
        }
        if (
          ![
            "OWNED",
            "LICENSED",
            "SOURCE_ALLOWED",
            "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
          ].includes(String(image.rights_basis)) ||
          !hasText(image.rights_evidence_ref)
        ) {
          failures.push(`${String(image.role)} image lacks rights evidence`);
        }
        if (!isPastIsoDate(image.reviewed_at)) {
          failures.push(`${String(image.role)} image reviewed_at is invalid`);
        }
      }
      const main = mainImages[0];
      if (main) {
        if (main.url !== sku.main_image_url) {
          failures.push("MAIN evidence URL differs from ChannelSKU.main_image_url");
        }
        if (master_bundle && main.represented_unit_count !== master_bundle.pack_count) {
          failures.push(
            `MAIN represents ${String(main.represented_unit_count)} units; expected ${master_bundle.pack_count}`,
          );
        }
        const depicted = new Set(
          Array.isArray(main.depicted_component_keys)
            ? main.depicted_component_keys.filter(hasText)
            : [],
        );
        if ([...keys].some((key) => !depicted.has(key))) {
          failures.push("MAIN does not depict every exact recipe component");
        }
      }
      const secondaryUrls = Array.isArray(walmart?.secondary_image_urls)
        ? walmart.secondary_image_urls
        : null;
      if (!secondaryUrls || secondaryUrls.length === 0) {
        failures.push("at least one public secondary image URL is required for the pilot");
      } else {
        for (const url of secondaryUrls) {
          if (!isWalmartPilotImageUrl(url)) {
            failures.push(
              "public secondary image URL must be a query-free HTTPS JPEG/PNG on an allowed port",
            );
            continue;
          }
          const evidenceRows = imageRecords.filter(
            (image) => image.url === url && image.role !== "MAIN",
          );
          if (evidenceRows.length !== 1) {
            failures.push(
              `public secondary image ${url} requires exactly one top-level evidence row`,
            );
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      validator_id: "validator-walmart-product-truth",
      passed: false,
      severity: "error",
      message: `Walmart Product Truth gate failed: ${failures.join("; ")}.`,
      details: { failures, schema_version: manifest?.schema_version ?? null },
    };
  }
  return {
    validator_id: "validator-walmart-product-truth",
    passed: true,
    details: {
      schema_version: manifest?.schema_version,
      recipe_hash: manifest?.recipe_hash,
      component_count: components?.length,
      price_evidence_count: components?.filter((component) =>
        isRecord(component.price_evidence)).length,
      image_count: imageRecords?.length,
    },
  };
};
