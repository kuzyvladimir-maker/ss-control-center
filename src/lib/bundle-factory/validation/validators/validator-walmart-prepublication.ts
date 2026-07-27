/** Account/SKU entitlement, current spec, condition, brand and shelf-life gate. */

import type { ValidatorFn } from "../types";
import {
  SSCC_MIN_REMAINING_SHELF_LIFE_DAYS,
  WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS,
  WALMART_CATALOG_SEARCH_MAX_AGE_MS,
  WALMART_FULFILLMENT_EVIDENCE_MAX_AGE_MS,
  WALMART_POLICY_VERSION,
  WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  WALMART_RECALL_CHECK_MAX_AGE_MS,
  WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
  WALMART_SELLER_ACCOUNT_HEALTH_MAX_AGE_MS,
  WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS,
  WALMART_SPEC_MAX_AGE_MS,
  getPath,
  hasText,
  isFreshIsoDate,
  isIngestibleProduct,
  isMissingRequiredValue,
  isPositiveInteger,
  isRecord,
  isSha256,
  parseWalmartAttributes,
  recordArray,
  sha256WalmartJson,
} from "../walmart-prepublication-policy";

function sameText(left: unknown, right: unknown): boolean {
  return String(left ?? "").trim().toLowerCase() ===
    String(right ?? "").trim().toLowerCase();
}

function normalizeCountry(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["us", "usa", "united states", "united states of america"].includes(normalized)) {
    return "US";
  }
  return normalized.toUpperCase();
}

export const validatorWalmartPrepublication: ValidatorFn = async ({
  sku,
  master_bundle,
  bundle_components,
}) => {
  if (sku.channel !== "WALMART") {
    return {
      validator_id: "validator-walmart-prepublication",
      passed: true,
      details: { skipped: true, reason: "non_walmart_channel" },
    };
  }

  const parsed = parseWalmartAttributes(sku.attributes);
  const walmart = parsed.walmart;
  const truth = parsed.product_truth_manifest;
  const evidence = parsed.walmart_prepublication;
  const failures = [...parsed.errors];
  if (!master_bundle) failures.push("MasterBundle is missing");

  if (walmart) {
    if (walmart.contract_version !== WALMART_PUBLIC_CONTRACT_SCHEMA) {
      failures.push(`unsupported attributes.walmart contract ${String(walmart.contract_version)}`);
    }
    if (!isRecord(walmart.public_attributes)) {
      failures.push("attributes.walmart.public_attributes is missing or malformed");
    }
    if (!hasText(walmart.product_type) || walmart.product_type !== sku.item_type) {
      failures.push("public product_type does not match ChannelSKU.item_type");
    }
    if (!hasText(walmart.country_of_origin_substantial_transformation)) {
      failures.push("countryOfOriginSubstantialTransformation is missing");
    } else if (
      normalizeCountry(walmart.country_of_origin_substantial_transformation) !==
      normalizeCountry(sku.country_of_origin)
    ) {
      failures.push("public country of origin differs from verified ChannelSKU value");
    }
    if (!isRecord(walmart.offer_handoff)) {
      failures.push("offer_handoff is missing or malformed");
    } else {
      if (!isPositiveInteger(walmart.offer_handoff.quantity)) {
        failures.push("offer_handoff.quantity must be positive");
      }
      if (!hasText(walmart.offer_handoff.fulfillment_center_id)) {
        failures.push("offer_handoff.fulfillment_center_id is missing");
      }
      if (
        !Number.isInteger(walmart.offer_handoff.fulfillment_lag_time) ||
        walmart.offer_handoff.fulfillment_lag_time < 0
      ) {
        failures.push("offer_handoff.fulfillment_lag_time is invalid");
      }
    }
  }

  if (!evidence) {
    failures.push("walmart_prepublication evidence is missing");
  } else {
    if (evidence.schema_version !== WALMART_PREPUBLICATION_EVIDENCE_SCHEMA) {
      failures.push(`unsupported prepublication schema ${String(evidence.schema_version)}`);
    }
    if (evidence.policy_version !== WALMART_POLICY_VERSION) {
      failures.push(
        `policy version ${String(evidence.policy_version)} != current ${WALMART_POLICY_VERSION}`,
      );
    }
    if (!isFreshIsoDate(evidence.generated_at, WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS)) {
      failures.push("prepublication evidence is stale, invalid, or future-dated");
    }
    if (!isPositiveInteger(evidence.store_index)) {
      failures.push("prepublication store_index must be positive");
    }
    if (evidence.sku !== sku.sku) failures.push("prepublication SKU mismatch");
    if (truth && evidence.store_index !== truth.listing_scope?.store_index) {
      failures.push("prepublication and Product Truth store_index differ");
    }

    const catalog = isRecord(evidence.catalog_search) ? evidence.catalog_search : null;
    if (!catalog) {
      failures.push("catalog_search evidence is missing or malformed");
    } else {
      if (!isFreshIsoDate(catalog.searched_at, WALMART_CATALOG_SEARCH_MAX_AGE_MS)) {
        failures.push("catalog_search evidence is stale or invalid");
      }
      if (catalog.query_gtin !== sku.upc) failures.push("catalog_search GTIN differs from SKU UPC");
      if (!hasText(catalog.evidence_ref)) failures.push("catalog_search evidence_ref is missing");
      if (catalog.result === "EXACT_MATCH") {
        if (catalog.setup_method !== "MATCH_EXISTING" || !hasText(catalog.walmart_item_id)) {
          failures.push("EXACT_MATCH must use MATCH_EXISTING with Walmart item ID");
        }
        failures.push(
          "initial 1-2 SKU pilot blocks EXACT_MATCH; existing-catalog matching requires the separate MP_ITEM_MATCH adapter phase",
        );
      } else if (catalog.result === "NO_EXACT_MATCH") {
        if (catalog.setup_method !== "FULL_ITEM" || catalog.walmart_item_id != null) {
          failures.push("NO_EXACT_MATCH must use FULL_ITEM without Walmart item ID");
        }
      } else {
        failures.push("catalog_search result is unsupported");
      }
    }

    const approvals = recordArray(evidence.category_approvals);
    const sellerHealth = isRecord(evidence.seller_account_health)
      ? evidence.seller_account_health
      : null;
    if (
      !sellerHealth ||
      sellerHealth.status !== "HEALTHY_AND_ACCEPTING_NEW_ITEMS" ||
      sellerHealth.store_index !== evidence.store_index ||
      !isSha256(sellerHealth.seller_account_fingerprint_sha256) ||
      !isFreshIsoDate(
        sellerHealth.verified_at,
        WALMART_SELLER_ACCOUNT_HEALTH_MAX_AGE_MS,
      ) ||
      !hasText(sellerHealth.evidence_ref)
    ) {
      failures.push("seller account health/publish eligibility evidence is missing or stale");
    }

    const fulfillment = isRecord(evidence.fulfillment_compliance)
      ? evidence.fulfillment_compliance
      : null;
    if (
      !fulfillment ||
      fulfillment.method !== "SELLER_FULFILLED" ||
      fulfillment.inventory_owned_by_seller !== true ||
      fulfillment.direct_retailer_fulfillment !== false ||
      fulfillment.competitor_branded_packaging !== false ||
      fulfillment.third_party_promotional_materials !== false ||
      !hasText(fulfillment.fulfillment_center_id) ||
      !Number.isInteger(fulfillment.fulfillment_lag_time) ||
      Number(fulfillment.fulfillment_lag_time) < 0 ||
      !["NOT_REQUIRED", "APPROVED"].includes(
        String(fulfillment.lag_exemption_status),
      ) ||
      (Number(fulfillment.fulfillment_lag_time) > 2 &&
        fulfillment.lag_exemption_status !== "APPROVED") ||
      !isFreshIsoDate(
        fulfillment.verified_at,
        WALMART_FULFILLMENT_EVIDENCE_MAX_AGE_MS,
      ) ||
      !hasText(fulfillment.evidence_ref) ||
      !walmart ||
      !isRecord(walmart.offer_handoff) ||
      fulfillment.fulfillment_center_id !==
        walmart.offer_handoff.fulfillment_center_id ||
      fulfillment.fulfillment_lag_time !==
        walmart.offer_handoff.fulfillment_lag_time
    ) {
      failures.push("seller-fulfilled policy evidence is missing, stale, or inconsistent with offer handoff");
    }

    if (!approvals) {
      failures.push("category_approvals is malformed");
    } else {
      for (const approval of approvals) {
        if (
          !hasText(approval.scope) ||
          !["APPROVED", "NOT_REQUIRED"].includes(String(approval.status)) ||
          !isFreshIsoDate(approval.verified_at, WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS) ||
          !hasText(approval.evidence_ref)
        ) {
          failures.push(`category approval ${String(approval.scope)} is incomplete or stale`);
        }
      }
      const ingestible = isIngestibleProduct({
        category: master_bundle?.category,
        itemType: sku.item_type,
        components: bundle_components,
      });
      if (
        ingestible &&
        !approvals.some(
          (approval) =>
            approval.scope === "INGESTIBLE_PRODUCTS" &&
            approval.status === "APPROVED",
        )
      ) {
        failures.push("ingestible product requires APPROVED INGESTIBLE_PRODUCTS evidence");
      }
    }

    const policyReview = isRecord(evidence.sku_policy_review)
      ? evidence.sku_policy_review
      : null;
    if (
      !policyReview ||
      policyReview.status !== "CLEARED" ||
      !isFreshIsoDate(policyReview.reviewed_at, WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS) ||
      !hasText(policyReview.evidence_ref)
    ) {
      failures.push("SKU prohibited/restricted policy review is missing or stale");
    }

    const recall = isRecord(evidence.recall_check) ? evidence.recall_check : null;
    if (
      !recall ||
      recall.status !== "CLEAR" ||
      !isFreshIsoDate(recall.checked_at, WALMART_RECALL_CHECK_MAX_AGE_MS) ||
      !hasText(recall.source) ||
      !hasText(recall.evidence_ref)
    ) {
      failures.push("recall clearance is missing or stale");
    }

    const rights = isRecord(evidence.brand_rights) ? evidence.brand_rights : null;
    if (
      !rights ||
      !sameText(rights.brand, master_bundle?.brand) ||
      !["BRAND_OWNER", "AUTHORIZED_RESELLER", "LEGITIMATE_RESALE"].includes(
        String(rights.basis),
      ) ||
      !isFreshIsoDate(rights.verified_at, WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS) ||
      !hasText(rights.evidence_ref)
    ) {
      failures.push("brand-rights evidence is missing, stale, or for another brand");
    } else if (
      catalog?.setup_method === "FULL_ITEM" &&
      !["BRAND_OWNER", "AUTHORIZED_RESELLER"].includes(String(rights.basis))
    ) {
      failures.push("FULL_ITEM creation requires brand-owner or authorized-reseller evidence");
    }

    const productIdentifier = isRecord(evidence.product_identifier)
      ? evidence.product_identifier
      : null;
    if (
      !productIdentifier ||
      productIdentifier.identifier_type !== "UPC" ||
      productIdentifier.value !== sku.upc ||
      productIdentifier.checksum_valid !== true ||
      !hasText(productIdentifier.pool_acquired_from) ||
      !hasText(productIdentifier.pool_recorded_owner) ||
      productIdentifier.registry_status !== "VERIFIED" ||
      !sameText(
        productIdentifier.registry_registrant_name,
        productIdentifier.pool_recorded_owner,
      ) ||
      !sameText(productIdentifier.aligned_brand, master_bundle?.brand) ||
      productIdentifier.brand_alignment_status !== "VERIFIED" ||
      !/^[a-f0-9]{64}$/.test(
        String(productIdentifier.seller_account_fingerprint_sha256 ?? ""),
      ) ||
      productIdentifier.seller_assignment_authority_status !== "VERIFIED" ||
      !isFreshIsoDate(
        productIdentifier.verified_at,
        WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS,
      ) ||
      !hasText(productIdentifier.evidence_ref)
    ) {
      failures.push(
        "product identifier registry, brand alignment, or seller assignment authority evidence is missing or stale",
      );
    } else if (
      sellerHealth &&
      productIdentifier.seller_account_fingerprint_sha256 !==
        sellerHealth.seller_account_fingerprint_sha256
    ) {
      failures.push("seller account health and product identifier account bindings differ");
    }

    const condition = isRecord(evidence.condition) ? evidence.condition : null;
    if (
      !condition ||
      condition.value !== "New" ||
      !isFreshIsoDate(condition.verified_at, WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS)
    ) {
      failures.push("pilot item condition must be freshly verified as New");
    }

    const expiration = isRecord(evidence.expiration) ? evidence.expiration : null;
    const ingestible = isIngestibleProduct({
      category: master_bundle?.category,
      itemType: sku.item_type,
      components: bundle_components,
    });
    if (!expiration) {
      failures.push("expiration evidence is missing or malformed");
    } else if (ingestible) {
      if (expiration.applicable !== true) failures.push("ingestible item must be expiration-controlled");
      if (
        typeof expiration.shelf_life_days !== "number" ||
        expiration.shelf_life_days < SSCC_MIN_REMAINING_SHELF_LIFE_DAYS
      ) {
        failures.push("shelf_life_days is below the SSCC pilot safety floor");
      }
      if (
        typeof expiration.minimum_days_remaining_at_ship !== "number" ||
        expiration.minimum_days_remaining_at_ship < SSCC_MIN_REMAINING_SHELF_LIFE_DAYS
      ) {
        failures.push("minimum remaining shelf life at ship is below 30 days");
      }
      if (
        !hasText(expiration.lot_check_procedure_ref) ||
        !hasText(expiration.source_ref) ||
        !isFreshIsoDate(expiration.verified_at, WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS)
      ) {
        failures.push("expiration source/lot-control evidence is missing or stale");
      }
      if (
        bundle_components.some(
          (component) =>
            typeof component.expiration_days === "number" &&
            component.expiration_days < SSCC_MIN_REMAINING_SHELF_LIFE_DAYS,
        )
      ) {
        failures.push("a recipe component has less than 30 days remaining shelf life");
      }
    } else if (
      !hasText(expiration.source_ref) ||
      !isFreshIsoDate(expiration.verified_at, WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS)
    ) {
      failures.push("non-ingestible expiration applicability evidence is missing or stale");
    }

    const spec = isRecord(evidence.item_spec) ? evidence.item_spec : null;
    if (!spec || !walmart) {
      failures.push("item_spec/public Walmart contract is missing or malformed");
    } else {
      const expectedFeed = "MP_ITEM";
      const expectedVersion = WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION;
      if (spec.feed_type !== expectedFeed || spec.version !== expectedVersion) {
        failures.push(`item spec must use ${expectedFeed} ${expectedVersion}`);
      }
      if (
        walmart.spec_version !== spec.version ||
        walmart.product_type !== spec.product_type ||
        spec.product_type !== sku.item_type
      ) {
        failures.push("public contract, evidence and ChannelSKU product type/spec differ");
      }
      if (
        !isFreshIsoDate(spec.retrieved_at, WALMART_SPEC_MAX_AGE_MS) ||
        !isFreshIsoDate(walmart.spec_fetched_at, WALMART_SPEC_MAX_AGE_MS)
      ) {
        failures.push("Get Spec evidence is stale or invalid");
      }
      if (
        !isSha256(spec.schema_sha256) ||
        spec.schema_sha256 !== walmart.spec_schema_hash
      ) {
        failures.push("Get Spec schema hash is missing or differs from public contract");
      }
      if (
        !isSha256(spec.attributes_sha256) ||
        !isRecord(walmart.public_attributes) ||
        spec.attributes_sha256 !== sha256WalmartJson(walmart.public_attributes)
      ) {
        failures.push("validated Walmart public-attributes hash mismatch");
      }
      if (
        spec.validation_status !== "PASSED" ||
        !Array.isArray(spec.required_attributes) ||
        spec.required_attributes.length === 0 ||
        !Array.isArray(spec.missing_required_attributes) ||
        spec.missing_required_attributes.length > 0
      ) {
        failures.push("live item-spec required-attribute validation did not pass cleanly");
      } else {
        const envelope: Record<string, unknown> = {
          ...walmart.public_attributes,
          sku: sku.sku,
          productName: sku.title,
          brand: master_bundle?.brand,
          price: sku.price_cents / 100,
          mainImageUrl: sku.main_image_url,
          productType: walmart.product_type,
          countryOfOriginSubstantialTransformation:
            walmart.country_of_origin_substantial_transformation,
        };
        const missing = spec.required_attributes.filter(
          (path) => !hasText(path) || isMissingRequiredValue(getPath(envelope, path)),
        );
        if (missing.length > 0) {
          failures.push(`required Walmart attributes absent from payload: ${missing.join(", ")}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      validator_id: "validator-walmart-prepublication",
      passed: false,
      severity: "error",
      message: `Walmart pre-publication gate failed: ${failures.join("; ")}.`,
      details: {
        policy_version: evidence?.policy_version ?? null,
        spec_version: evidence?.item_spec?.version ?? null,
        failures,
      },
    };
  }
  return {
    validator_id: "validator-walmart-prepublication",
    passed: true,
    details: {
      policy_version: evidence?.policy_version,
      spec_version: evidence?.item_spec.version,
      setup_method: evidence?.catalog_search.setup_method,
      store_index: evidence?.store_index,
      approval_is_separate: true,
    },
  };
};
