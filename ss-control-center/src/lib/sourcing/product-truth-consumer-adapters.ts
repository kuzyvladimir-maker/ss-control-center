import {
  PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION,
  type ProductTruthConsumerGatewayEntry,
  type ProductTruthConsumerGatewayReport,
} from "./product-truth-consumer-gateway";
import {
  productTruthOperationalSha256,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  type ProductTruthPriceOption,
  type ProductTruthRecipeComponent,
} from "./product-truth-read-contract";

export const PRODUCT_TRUTH_BUNDLE_FACTORY_SEED_VERSION =
  "product-truth-bundle-factory-seed/1.0.0" as const;
export const PRODUCT_TRUTH_LISTING_IMPROVEMENT_SEED_VERSION =
  "product-truth-listing-improvement-seed/1.0.0" as const;
export const PRODUCT_TRUTH_UNIT_ECONOMICS_BASIS_VERSION =
  "product-truth-unit-economics-basis/1.0.0" as const;
export const PRODUCT_TRUTH_PROCUREMENT_PLAN_VERSION =
  "product-truth-procurement-plan/1.0.0" as const;

type CanonicalConsumer =
  | "BUNDLE_FACTORY"
  | "LISTING_IMPROVEMENT"
  | "UNIT_ECONOMICS"
  | "PROCUREMENT";

export class ProductTruthConsumerAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsumerAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsumerAdapterError(code, message);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CONSUMER_ADAPTER_INPUT_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    fail("CONSUMER_ADAPTER_INPUT_INVALID", `${label} must be finite and non-negative`);
  }
  return value;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function exactEntry(
  report: ProductTruthConsumerGatewayReport,
  consumer: CanonicalConsumer,
  listingKey: string,
): ProductTruthConsumerGatewayEntry {
  if (
    report.schemaVersion !== PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION
    || report.readContractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION
  ) {
    fail(
      "CONSUMER_ADAPTER_CONTRACT_MISMATCH",
      "gateway/read-contract version is not the canonical release",
    );
  }
  if (report.consumer !== consumer) {
    fail(
      "CONSUMER_ADAPTER_CONSUMER_MISMATCH",
      `expected ${consumer}, received ${report.consumer}`,
    );
  }
  if (
    (report.mode === "SHADOW" && report.outputUse !== "COMPARE_ONLY")
    || (report.mode === "ENFORCED"
      && report.outputUse !== "AUTHORITATIVE_NO_FALLBACK")
  ) {
    fail(
      "CONSUMER_ADAPTER_MODE_INVALID",
      "gateway mode and output-use contract disagree",
    );
  }
  const matches = report.entries.filter((entry) =>
    entry.listingKey === listingKey);
  if (matches.length !== 1) {
    fail(
      "CONSUMER_ADAPTER_SCOPE_INVALID",
      `expected exactly one gateway entry for ${listingKey}`,
    );
  }
  const entry = matches[0];
  if (
    entry.view.consumer !== consumer
    || entry.listingKey !== `${entry.channel}:${entry.storeIndex}:${entry.sku}`
  ) {
    fail(
      "CONSUMER_ADAPTER_SCOPE_INVALID",
      "entry consumer or exact listing scope is inconsistent",
    );
  }
  return entry;
}

function binding(
  report: ProductTruthConsumerGatewayReport,
  entry: ProductTruthConsumerGatewayEntry,
) {
  return {
    gatewayVersion: PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    activationSha256: report.activationSha256,
    ownerApprovalId: report.ownerApprovalId,
    mode: report.mode,
    outputUse: report.outputUse,
    authoritativeManifestSha256: report.authoritativeManifestSha256,
    databaseTargetFingerprint: report.databaseTargetFingerprint,
    listingKey: entry.listingKey,
    channel: entry.channel,
    storeIndex: entry.storeIndex,
    sku: entry.sku,
    readAt: report.readAt,
    asOf: report.asOf,
    maxPriceAgeMs: report.maxPriceAgeMs,
  };
}

function contentBinding(component: ProductTruthRecipeComponent) {
  const content = component.content;
  return {
    componentEvidenceId: component.componentEvidenceId,
    componentIndex: component.componentIndex,
    product: component.product,
    flavor: component.flavor,
    size: component.size,
    quantity: component.qty,
    targetCanonicalVariantId: component.targetCanonicalVariantId,
    evidenceStatus: component.evidenceStatus,
    content: content
      ? {
          canonicalVariantId: content.canonicalVariantId,
          contentObservationId: content.provenance.contentObservationId,
          observationKey: content.provenance.observationKey,
          contentHash: content.provenance.contentHash,
          decisionEvidenceHash: content.provenance.decisionEvidenceHash,
          sourceUrl: content.provenance.sourceUrl,
          sourceApi: content.provenance.sourceApi,
          observedAt: content.provenance.observedAt,
          facts: content.facts,
        }
      : null,
    blockers: unique(component.contentBlockers),
  };
}

function hashBound<T extends object>(value: T): T & { artifactSha256: string } {
  return {
    ...value,
    artifactSha256: productTruthOperationalSha256(value),
  };
}

/**
 * Compiles immutable Product Truth bindings for a future Bundle Factory draft.
 * It does not generate copy/images, create a draft, source donors or publish.
 */
export function compileProductTruthBundleFactorySeed(input: {
  report: ProductTruthConsumerGatewayReport;
  listingKey: string;
}) {
  const entry = exactEntry(input.report, "BUNDLE_FACTORY", input.listingKey);
  if (entry.view.consumer !== "BUNDLE_FACTORY") {
    fail("CONSUMER_ADAPTER_CONSUMER_MISMATCH", "Bundle Factory view is required");
  }
  const components = entry.view.components.map(contentBinding);
  const blockers = unique([
    ...entry.blockers,
    ...entry.view.blockers,
    ...components.flatMap((component) => component.blockers),
    ...components
      .filter((component) => component.content === null)
      .map((component) =>
        `COMPONENT_${component.componentIndex}_EXACT_CONTENT_MISSING`),
  ]);
  const ready =
    entry.ready
    && entry.view.ready
    && components.length > 0
    && blockers.length === 0;
  return hashBound({
    schemaVersion: PRODUCT_TRUTH_BUNDLE_FACTORY_SEED_VERSION,
    binding: binding(input.report, entry),
    ready,
    components,
    blockers,
    claims: {
      readOnly: true,
      exactContentOnly: true,
      priceEvidenceIsNotContent: true,
      draftCreated: false,
      generatedContentCreated: false,
      generatedImagesCreated: false,
      providerCalls: false,
      marketplaceMutations: false,
    } as const,
  });
}

/**
 * Compiles the exact truth side of a listing diff. Channel-specific live-state
 * comparison and any apply action remain outside this pure seed.
 */
export function compileProductTruthListingImprovementSeed(input: {
  report: ProductTruthConsumerGatewayReport;
  listingKey: string;
}) {
  const entry = exactEntry(
    input.report,
    "LISTING_IMPROVEMENT",
    input.listingKey,
  );
  if (entry.view.consumer !== "LISTING_IMPROVEMENT") {
    fail(
      "CONSUMER_ADAPTER_CONSUMER_MISMATCH",
      "Listing Improvement view is required",
    );
  }
  const components = entry.view.components.map(contentBinding);
  const blockers = unique([
    ...entry.blockers,
    ...entry.view.blockers,
    ...components.flatMap((component) => component.blockers),
    ...components
      .filter((component) => component.content === null)
      .map((component) =>
        `COMPONENT_${component.componentIndex}_EXACT_CONTENT_MISSING`),
  ]);
  const readyForPreview =
    entry.ready
    && entry.view.ready
    && components.length > 0
    && blockers.length === 0;
  return hashBound({
    schemaVersion: PRODUCT_TRUTH_LISTING_IMPROVEMENT_SEED_VERSION,
    binding: binding(input.report, entry),
    readyForPreview,
    components,
    blockers,
    claims: {
      readOnly: true,
      exactContentOnly: true,
      liveListingRead: false,
      diffGenerated: false,
      applyAuthorized: false,
      providerCalls: false,
      marketplaceMutations: false,
    } as const,
  });
}

/**
 * Returns a typed acquisition-cost basis only. Packaging/ice remain separate
 * fields and missing/unsourceable values never receive a numeric fallback.
 */
export function compileProductTruthUnitEconomicsBasis(input: {
  report: ProductTruthConsumerGatewayReport;
  listingKey: string;
}) {
  const entry = exactEntry(input.report, "UNIT_ECONOMICS", input.listingKey);
  if (entry.view.consumer !== "UNIT_ECONOMICS") {
    fail("CONSUMER_ADAPTER_CONSUMER_MISMATCH", "Unit Economics view is required");
  }
  const view = entry.view;
  const ready = view.status === "FACT" || view.status === "ESTIMATE";
  const current = view.current;
  if (
    ready
    && (
      !current
      || current.evidenceOutcome !== view.status
      || current.productCost === null
      || !Number.isFinite(current.productCost)
      || current.productCost < 0
    )
  ) {
    fail(
      "CONSUMER_ADAPTER_ECONOMICS_INVALID",
      "typed ready status lacks a matching finite product acquisition cost",
    );
  }
  const blockers = unique([
    ...entry.blockers,
    ...view.blockers,
    ...(view.status === "UNSOURCEABLE" ? ["UNIT_ECONOMICS_UNSOURCEABLE"] : []),
  ]);
  return hashBound({
    schemaVersion: PRODUCT_TRUTH_UNIT_ECONOMICS_BASIS_VERSION,
    binding: binding(input.report, entry),
    status: view.status,
    ready,
    basis: ready && current
      ? {
          kind: view.status,
          skuCostId: current.id,
          productAcquisitionCost: current.productCost,
          packagingCost: current.packagingCost,
          iceCost: current.iceCost,
          totalCostEvidence: current.totalCost,
          currency: current.currency,
          effectiveAt: current.effectiveDate,
          observationKey: current.observationKey,
          recipeHash: current.recipeHash,
          pricePolicyVersion: current.pricePolicyVersion,
          matcherVersion: current.matcherVersion,
          matcherImplementationSha256:
            current.matcherImplementationSha256,
          matcherReleaseSha256: current.matcherReleaseSha256,
          evidenceOutcome: current.evidenceOutcome,
          runId: current.runId,
          approvalId: current.approvalId,
        }
      : null,
    blockers,
    claims: {
      readOnly: true,
      legacyFallback: false,
      olderPositiveFallback: false,
      oneDollarFloorFallback: false,
      zeroCostFallback: false,
      repricingAuthorized: false,
      marketplaceMutations: false,
    } as const,
  });
}

export type ProductTruthInventoryEvidence =
  | {
      status: "KNOWN";
      availableQuantity: number;
      evidenceId: string;
      observedAt: string;
    }
  | {
      status: "UNKNOWN";
      reason: string;
    };

export interface ProductTruthProcurementPlanningInput {
  report: ProductTruthConsumerGatewayReport;
  listingKey: string;
  orderQuantity: number;
  inventoryByCanonicalVariantId?: Readonly<
    Record<string, ProductTruthInventoryEvidence>
  >;
}

function optionPlan(
  option: ProductTruthPriceOption,
  shortage: number,
) {
  if (
    option.packagePrice === null
    || !Number.isFinite(option.packagePrice)
    || option.packagePrice <= 0
    || option.packSizeSeen === null
    || !Number.isSafeInteger(option.packSizeSeen)
    || option.packSizeSeen < 1
  ) return null;
  const packages = Math.ceil(shortage / option.packSizeSeen);
  return {
    observationId: option.observationId,
    observationKey: option.observationKey,
    donorOfferId: option.donorOfferId,
    retailer: option.retailer,
    retailerProductId: option.retailerProductId,
    productUrl: option.productUrl,
    packagePrice: option.packagePrice,
    unitsPerPackage: option.packSizeSeen,
    packages,
    suppliedQuantity: packages * option.packSizeSeen,
    projectedSubtotal: money(packages * option.packagePrice),
    comparableUnitPrice: option.targetComparableUnitPrice,
    currency: option.currency,
    zip: option.locality.zip,
    localityEvidence: option.locality.evidence,
    observedAt: option.freshness.observedAt,
    ageMs: option.freshness.ageMs,
    maxAgeMs: option.freshness.maxAgeMs,
    runId: option.sourceRun.runId,
    approvalId: option.sourceRun.approvalId,
    meteredReceiptId: option.sourceRun.meteredReceiptId,
  };
}

function isPriceOnlyProcurementBlocker(
  blocker: string,
  fullyAllocatedComponentIndexes: ReadonlySet<number>,
): boolean {
  for (const componentIndex of fullyAllocatedComponentIndexes) {
    if (
      blocker === `COMPONENT_${componentIndex}:NO_CURRENT_ELIGIBLE_LOCAL_PRICE`
      || blocker ===
        `COMPONENT_${componentIndex}:MANUAL_COST_NOT_RETAILER_BUY_OPTION`
    ) return true;
  }
  return false;
}

/**
 * Read-only Procurement MVP. It computes demand and reviewable factual options,
 * but deliberately emits no cart/order/purchase instruction.
 */
export function compileProductTruthProcurementPlan(
  input: ProductTruthProcurementPlanningInput,
) {
  const orderQuantity = positiveInteger(input.orderQuantity, "orderQuantity");
  const entry = exactEntry(input.report, "PROCUREMENT", input.listingKey);
  if (entry.view.consumer !== "PROCUREMENT") {
    fail("CONSUMER_ADAPTER_CONSUMER_MISMATCH", "Procurement view is required");
  }
  const components = entry.view.components.map((component) => {
    const recipeMatches = entry.recipe.components.filter((candidate) =>
      candidate.componentIndex === component.componentIndex);
    if (recipeMatches.length !== 1) {
      fail(
        "CONSUMER_ADAPTER_PROCUREMENT_INVALID",
        `component ${component.componentIndex} lacks one exact recipe binding`,
      );
    }
    const recipe = recipeMatches[0];
    const perOrderQuantity = positiveInteger(
      component.requiredQuantity,
      `component ${component.componentIndex} requiredQuantity`,
    );
    if (recipe.quantity !== perOrderQuantity) {
      fail(
        "CONSUMER_ADAPTER_PROCUREMENT_INVALID",
        `component ${component.componentIndex} procurement and recipe quantities differ`,
      );
    }
    const requiredQuantity = positiveInteger(
      perOrderQuantity * orderQuantity,
      `component ${component.componentIndex} total requiredQuantity`,
    );
    const factualVariantIds = unique(
      component.factualOptions.map((option) => option.canonicalVariantId),
    );
    if (factualVariantIds.length > 1) {
      fail(
        "CONSUMER_ADAPTER_PROCUREMENT_INVALID",
        `component ${component.componentIndex} factual offers cross canonical variants`,
      );
    }
    if (
      factualVariantIds.length === 1
      && factualVariantIds[0] !== recipe.targetCanonicalVariantId
    ) {
      fail(
        "CONSUMER_ADAPTER_PROCUREMENT_INVALID",
        `component ${component.componentIndex} factual offer differs from the target recipe variant`,
      );
    }
    const factualCanonicalVariantId = recipe.targetCanonicalVariantId;
    const inventory =
      (factualCanonicalVariantId
        ? input.inventoryByCanonicalVariantId?.[factualCanonicalVariantId]
        : undefined)
      ?? {
        status: "UNKNOWN" as const,
        reason: factualCanonicalVariantId
          ? "NO_EXACT_INVENTORY_EVIDENCE"
          : "NO_FACTUAL_TARGET_VARIANT_EVIDENCE",
      };
    let availableQuantity: number | null = null;
    let shortageQuantity: number | null = null;
    if (inventory.status === "KNOWN") {
      availableQuantity = finiteNonNegative(
        inventory.availableQuantity,
        `component ${component.componentIndex} availableQuantity`,
      );
      shortageQuantity = Math.max(0, requiredQuantity - availableQuantity);
    }
    const options = shortageQuantity === null
      ? []
      : component.factualOptions
          .map((option) => optionPlan(option, shortageQuantity!))
          .filter((option): option is NonNullable<typeof option> =>
            option !== null)
          .sort((left, right) =>
            left.projectedSubtotal - right.projectedSubtotal
            || left.comparableUnitPrice - right.comparableUnitPrice
            || left.retailer.localeCompare(right.retailer, "en-US")
            || left.observationId.localeCompare(right.observationId, "en-US"));
    const selectedForReview =
      shortageQuantity !== null && shortageQuantity > 0
        ? options[0] ?? null
        : null;
    const blockers = unique([
      ...component.blockers.filter((blocker) =>
        shortageQuantity !== 0
        || (
          blocker !== "NO_CURRENT_ELIGIBLE_LOCAL_PRICE"
          && blocker !== "MANUAL_COST_NOT_RETAILER_BUY_OPTION"
        )),
      ...(inventory.status === "UNKNOWN"
        ? [`COMPONENT_${component.componentIndex}_INVENTORY_UNKNOWN`]
        : []),
      ...(shortageQuantity !== null
        && shortageQuantity > 0
        && options.length === 0
        ? [`COMPONENT_${component.componentIndex}_FACTUAL_BUY_OPTION_MISSING`]
        : []),
    ]);
    return {
      componentIndex: component.componentIndex,
      product: component.product,
      factualCanonicalVariantId,
      requiredQuantity,
      inventory,
      availableQuantity,
      shortageQuantity,
      factualOptions: options,
      selectedForReview,
      estimateOptions: component.estimateOptions.map((option) => ({
        observationId: option.observationId,
        retailer: option.retailer,
        productUrl: option.productUrl,
        targetComparableUnitPrice: option.targetComparableUnitPrice,
        eligibility: option.eligibility,
        eligibleForPurchase: false as const,
      })),
      manualCost: component.manualCost
        ? {
            ...component.manualCost,
            eligibleForPurchase: false as const,
          }
        : null,
      blockers,
    };
  });
  const fullyAllocatedComponentIndexes = new Set(
    components
      .filter((component) => component.shortageQuantity === 0)
      .map((component) => component.componentIndex),
  );
  const blockers = unique([
    ...entry.blockers.filter((blocker) =>
      !isPriceOnlyProcurementBlocker(
        blocker,
        fullyAllocatedComponentIndexes,
      )),
    ...entry.view.blockers.filter((blocker) =>
      !isPriceOnlyProcurementBlocker(
        blocker,
        fullyAllocatedComponentIndexes,
      )),
    ...components.flatMap((component) => component.blockers),
  ]);
  const readyForReview =
    components.length > 0
    && blockers.length === 0;
  return hashBound({
    schemaVersion: PRODUCT_TRUTH_PROCUREMENT_PLAN_VERSION,
    binding: binding(input.report, entry),
    orderQuantity,
    readyForReview,
    components,
    blockers,
    claims: {
      readOnly: true,
      inventoryUnknownIsNotZero: true,
      exactInventoryMayResolvePriceOnlyBlocker: true,
      factualOffersOnlyForSelection: true,
      estimateIsNotBuyEvidence: true,
      manualCostIsNotBuyEvidence: true,
      cartCreated: false,
      orderCreated: false,
      purchaseAuthorized: false,
      procurementMutations: false,
      providerCalls: false,
      marketplaceMutations: false,
    } as const,
  });
}
