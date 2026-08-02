import { createHash } from "node:crypto";

import {
  normalizeIdentityTokens,
  parseCanonicalSize,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import { buildCanonicalProductVariantKey } from "./canonical-product-variant";
import {
  compileProductTruthAmazonCatalogListingEvidence,
  renderProductTruthAmazonCatalogCapture,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  type ProductTruthAmazonCatalogCapture,
  type ProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogListingEvidence,
} from "./product-truth-amazon-catalog-evidence";
import {
  compileProductTruthDirectRetailerIdentityEvidence,
  renderProductTruthDirectRetailerIdentityEvidence,
  type ProductTruthDirectRetailerIdentityEvidence,
} from "./product-truth-direct-retailer-identity-evidence";
import {
  compileProductTruthAmazonImageAssessment,
  renderProductTruthAmazonImageAssessment,
  type ProductTruthAmazonImageAssessment,
} from "./product-truth-amazon-image-assessment";
import {
  compileProductTruthAmazonImageCapturePlan,
  compileProductTruthAmazonImageVerification,
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageVerification,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
  type ProductTruthAmazonImageVerification,
} from "./product-truth-amazon-image-evidence";
import {
  compileProductTruthAmazonListingDecomposition,
  renderProductTruthAmazonListingDecomposition,
  type ProductTruthAmazonListingDecomposition,
} from "./product-truth-amazon-listing-decomposition";
import {
  normalizeProductTruthBridgeGtin,
  PRODUCT_TRUTH_AMAZON_COMPONENT_GRAPH_EVIDENCE_VERSION,
  productTruthAmazonComponentGraphEvidenceCore,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthAmazonComponentGraphEvidenceRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export interface ProductTruthAmazonComponentGraphAdjudication {
  listingKey: string;
  donorProductId: string;
  offerId: string;
  componentIndex: number;
  retailPackageQuantity: number;
  /** Physical package form confirmed during the byte-bound image review. */
  packageForm?: string;
  targetIdentity: CanonicalProductIdentity;
  reviewedImageFiles: string[];
  adjudicatedAt: string;
}

export interface ProductTruthAmazonMixedComponentGraphAdjudicationComponent {
  donorProductId: string;
  offerId: string;
  componentIndex: number;
  retailPackageQuantity: number;
  unitCountPerRetailPackage: number;
  listingVariantLabel: string;
  packageForm: string;
  targetIdentity: CanonicalProductIdentity;
}

export interface ProductTruthAmazonMixedComponentGraphAdjudication {
  listingKey: string;
  components: ProductTruthAmazonMixedComponentGraphAdjudicationComponent[];
  reviewedImageFiles: string[];
  adjudicatedAt: string;
}

export interface ProductTruthAmazonComponentGraphSourceSet {
  legacySnapshot: ProductTruthLegacyBridgeSnapshot;
  legacySnapshotJson: string;
  legacySnapshotSha256: string;
  catalogPlan: ProductTruthAmazonCatalogCapturePlan;
  catalogPlanJson: string;
  catalogPlanSha256: string;
  catalogCapture: ProductTruthAmazonCatalogCapture;
  catalogCaptureJson: string;
  catalogCaptureSha256: string;
  catalogRawResponses: ReadonlyMap<string, { json: string; value: unknown }>;
  catalogEvidence: ProductTruthAmazonCatalogListingEvidence;
  catalogEvidenceJson: string;
  catalogEvidenceSha256: string;
  decomposition: ProductTruthAmazonListingDecomposition;
  decompositionJson: string;
  decompositionSha256: string;
  imagePlan: ProductTruthAmazonImageCapturePlan;
  imagePlanJson: string;
  imagePlanSha256: string;
  imageCapture: ProductTruthAmazonImageCapture;
  imageCaptureJson: string;
  imageCaptureSha256: string;
  imageVerification: ProductTruthAmazonImageVerification;
  imageVerificationJson: string;
  imageVerificationSha256: string;
  imageAssessment: ProductTruthAmazonImageAssessment;
  imageAssessmentJson: string;
  imageAssessmentSha256: string;
  imageBytesByFile: ReadonlyMap<string, Uint8Array>;
  directRetailerEvidence: ProductTruthDirectRetailerIdentityEvidence;
  directRetailerEvidenceJson: string;
  directRetailerEvidenceSha256: string;
  directRetailerHtmlBytes: Uint8Array;
}

export function resolveProductTruthAmazonComponentPackageForm(input: {
  adjudicatedPackageForm?: string | null;
  targetForm?: string | null;
  directRetailerForm?: string | null;
}): string {
  const adjudicated = input.adjudicatedPackageForm?.trim().toLowerCase() ?? "";
  const target = input.targetForm?.trim().toLowerCase() ?? "";
  const direct = input.directRetailerForm?.trim().toLowerCase() ?? "";
  const packageForm = adjudicated || target || direct;
  if (
    packageForm !== "carton"
    || (target.length > 0 && target !== packageForm)
    || (direct.length > 0 && direct !== packageForm)
  ) {
    fail("AMAZON_COMPONENT_GRAPH_PACKAGE_FORM_REJECTED", packageForm || "missing");
  }
  return packageForm;
}

export class ProductTruthAmazonComponentGraphEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthAmazonComponentGraphEvidenceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthAmazonComponentGraphEvidenceError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("AMAZON_COMPONENT_GRAPH_INSTANT_INVALID", label);
  }
  return value;
}

function canonicalSource(input: {
  label: string;
  json: string;
  sha256: string;
  rendered: string;
}): void {
  if (
    !/^[a-f0-9]{64}$/u.test(input.sha256)
    || input.json !== input.rendered
    || sha256(input.json) !== input.sha256
  ) fail("AMAZON_COMPONENT_GRAPH_SOURCE_MISMATCH", input.label);
}

function singularToken(token: string): string {
  if (/^[a-z]+(?:ches|shes|xes|zes)$/u.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function identityTokens(value: string | null | undefined): string[] {
  return normalizeIdentityTokens(value).map(singularToken).sort();
}

function containsTokens(haystack: string, needle: string | null | undefined): boolean {
  const available = new Set(identityTokens(haystack));
  const required = identityTokens(needle);
  return required.length > 0 && required.every((token) => available.has(token));
}

function sameTitle(left: string, right: string): boolean {
  return JSON.stringify(identityTokens(left)) === JSON.stringify(identityTokens(right));
}

function titleContainsSize(title: string, size: string): boolean {
  const target = parseCanonicalSize(size);
  if (!target) return false;
  const candidates = [...title.matchAll(
    /(?:^|\b)(\d+(?:\.\d+)?|\.\d+)\s*(fl\.?\s*oz\.?|floz|fluid\s*oz|fluid\s*ounces?|kilograms?|kgs?|kg|grams?|g|pounds?|lbs?|lb|ounces?|oz|milliliters?|millilitres?|ml|liters?|litres?|l|counts?|cts?|pieces?|pcs?)\b/giu,
  )];
  return candidates.some((match) => {
    const parsed = parseCanonicalSize(match[0]?.trim());
    return parsed
      && parsed.dimension === target.dimension
      && Math.abs(parsed.baseAmount - target.baseAmount)
        <= Math.max(parsed.baseAmount, target.baseAmount) * 0.001;
  });
}

function assertRecompiledSources(source: ProductTruthAmazonComponentGraphSourceSet): void {
  canonicalSource({
    label: "legacySnapshot",
    json: source.legacySnapshotJson,
    sha256: source.legacySnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(source.legacySnapshot),
  });
  canonicalSource({
    label: "catalogPlan",
    json: source.catalogPlanJson,
    sha256: source.catalogPlanSha256,
    rendered: renderProductTruthAmazonCatalogCapturePlan(source.catalogPlan),
  });
  canonicalSource({
    label: "catalogCapture",
    json: source.catalogCaptureJson,
    sha256: source.catalogCaptureSha256,
    rendered: renderProductTruthAmazonCatalogCapture(source.catalogCapture),
  });
  const catalogEvidence = compileProductTruthAmazonCatalogListingEvidence({
    compiledAt: source.catalogEvidence.compiledAt,
    plan: source.catalogPlan,
    planJson: source.catalogPlanJson,
    planSha256: source.catalogPlanSha256,
    capture: source.catalogCapture,
    captureJson: source.catalogCaptureJson,
    captureSha256: source.catalogCaptureSha256,
    rawResponses: source.catalogRawResponses,
  });
  canonicalSource({
    label: "catalogEvidence",
    json: source.catalogEvidenceJson,
    sha256: source.catalogEvidenceSha256,
    rendered: renderProductTruthAmazonCatalogListingEvidence(catalogEvidence),
  });
  const decomposition = compileProductTruthAmazonListingDecomposition({
    compiledAt: source.decomposition.compiledAt,
    plan: source.catalogPlan,
    planJson: source.catalogPlanJson,
    planSha256: source.catalogPlanSha256,
    evidence: source.catalogEvidence,
    evidenceJson: source.catalogEvidenceJson,
    evidenceSha256: source.catalogEvidenceSha256,
    legacySnapshot: source.legacySnapshot,
    legacySnapshotJson: source.legacySnapshotJson,
    legacySnapshotSha256: source.legacySnapshotSha256,
  });
  canonicalSource({
    label: "decomposition",
    json: source.decompositionJson,
    sha256: source.decompositionSha256,
    rendered: renderProductTruthAmazonListingDecomposition(decomposition),
  });
  const imagePlan = compileProductTruthAmazonImageCapturePlan({
    generatedAt: source.imagePlan.generatedAt,
    catalogPlan: source.catalogPlan,
    catalogPlanJson: source.catalogPlanJson,
    catalogPlanSha256: source.catalogPlanSha256,
    catalogEvidence: source.catalogEvidence,
    catalogEvidenceJson: source.catalogEvidenceJson,
    catalogEvidenceSha256: source.catalogEvidenceSha256,
  });
  canonicalSource({
    label: "imagePlan",
    json: source.imagePlanJson,
    sha256: source.imagePlanSha256,
    rendered: renderProductTruthAmazonImageCapturePlan(imagePlan),
  });
  const imageVerification = compileProductTruthAmazonImageVerification({
    verifiedAt: source.imageVerification.verifiedAt,
    plan: source.imagePlan,
    planJson: source.imagePlanJson,
    planSha256: source.imagePlanSha256,
    capture: source.imageCapture,
    captureJson: source.imageCaptureJson,
    captureSha256: source.imageCaptureSha256,
    imageBytesByFile: source.imageBytesByFile,
  });
  canonicalSource({
    label: "imageCapture",
    json: source.imageCaptureJson,
    sha256: source.imageCaptureSha256,
    rendered: renderProductTruthAmazonImageCapture(source.imageCapture),
  });
  canonicalSource({
    label: "imageVerification",
    json: source.imageVerificationJson,
    sha256: source.imageVerificationSha256,
    rendered: renderProductTruthAmazonImageVerification(imageVerification),
  });
  const assessment = compileProductTruthAmazonImageAssessment({
    assessedAt: source.imageAssessment.assessedAt,
    imagePlan: source.imagePlan,
    imagePlanJson: source.imagePlanJson,
    imagePlanSha256: source.imagePlanSha256,
    imageCapture: source.imageCapture,
    imageCaptureJson: source.imageCaptureJson,
    imageCaptureSha256: source.imageCaptureSha256,
    imageVerification: source.imageVerification,
    imageVerificationJson: source.imageVerificationJson,
    imageVerificationSha256: source.imageVerificationSha256,
    imageBytesByFile: source.imageBytesByFile,
    decomposition: source.decomposition,
    decompositionJson: source.decompositionJson,
    decompositionSha256: source.decompositionSha256,
  });
  canonicalSource({
    label: "imageAssessment",
    json: source.imageAssessmentJson,
    sha256: source.imageAssessmentSha256,
    rendered: renderProductTruthAmazonImageAssessment(assessment),
  });
  const direct = source.directRetailerEvidence;
  const recompiledDirect = compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: direct.targetCanonicalVariantId,
    donorProductId: direct.donorProductId,
    offerId: direct.offerId,
    retailer: direct.retailerContent.retailer,
    productUrl: direct.retailerContent.productUrl,
    finalUrl: direct.retailerContent.finalUrl,
    httpStatus: direct.retailerContent.httpStatus,
    capturedAt: direct.capturedAt,
    htmlFile: direct.retailerContent.htmlFile,
    htmlBytes: source.directRetailerHtmlBytes,
  });
  canonicalSource({
    label: "directRetailerEvidence",
    json: source.directRetailerEvidenceJson,
    sha256: source.directRetailerEvidenceSha256,
    rendered: renderProductTruthDirectRetailerIdentityEvidence(recompiledDirect),
  });
}

export function compileProductTruthAmazonComponentGraphEvidence(input: {
  adjudication: ProductTruthAmazonComponentGraphAdjudication;
  source: ProductTruthAmazonComponentGraphSourceSet;
}): ProductTruthAmazonComponentGraphEvidenceRow {
  assertRecompiledSources(input.source);
  const adjudication = input.adjudication;
  const adjudicatedAt = canonicalInstant(adjudication.adjudicatedAt, "adjudicatedAt");
  const listing = input.source.legacySnapshot.listings.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const target = input.source.catalogPlan.targets.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const evidence = input.source.catalogEvidence.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const decomposition = input.source.decomposition.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const assessment = input.source.imageAssessment.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const donor = input.source.legacySnapshot.donors.find(
    (row) => row.id === adjudication.donorProductId,
  );
  const offer = input.source.legacySnapshot.offers.find(
    (row) => row.id === adjudication.offerId,
  );
  const direct = input.source.directRetailerEvidence;
  const variant = buildCanonicalProductVariantKey(adjudication.targetIdentity);
  const directForm = direct.retailerContent.packageFormEvidence?.normalizedForm ?? null;
  const packageForm = resolveProductTruthAmazonComponentPackageForm({
    adjudicatedPackageForm: adjudication.packageForm,
    targetForm: adjudication.targetIdentity.form,
    directRetailerForm: directForm,
  });
  const listingImages = input.source.imageCapture.entries.filter(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const listingImageFiles = new Set(listingImages.map((row) => row.imageFile));
  const reviewed = [...new Set(adjudication.reviewedImageFiles)].sort();
  const outerSignals = decomposition?.signals.filter(
    (signal) => signal.kind === "CATALOG_OUTER_COUNT"
      || signal.kind === "TITLE_OUTER_COUNT",
  ) ?? [];
  const baseSize = parseCanonicalSize(adjudication.targetIdentity.size);
  const totalSignals = decomposition?.signals.filter(
    (signal) => signal.kind === "TITLE_TOTAL_COUNT",
  ) ?? [];
  if (
    !listing
    || listing.channel !== "amazon"
    || listing.productIdentityJson !== null
    || input.source.legacySnapshot.components.some((row) => row.sku === listing.sku)
    || !target
    || !evidence
    || !decomposition
    || !assessment
    || target.asin !== evidence.asin
    || target.asin !== decomposition.asin
    || target.asin !== assessment.asin
    || decomposition.status !== "CANDIDATES_REQUIRE_EXACT_ADJUDICATION"
    || assessment.status !== "EXACT_ADJUDICATION_REQUIRED"
    || !decomposition.candidates.some(
      (candidate) => candidate.donorProductId === adjudication.donorProductId,
    )
    || !donor
    || !donor.title
    || !offer
    || offer.donorProductId !== donor.id
    || offer.id !== direct.offerId
    || donor.id !== direct.donorProductId
    || !offer.isFirstParty
    || offer.via !== "direct"
    || !offer.productUrl
    || offer.productUrl !== direct.retailerContent.productUrl
    || offer.retailer.toLowerCase() !== direct.retailerContent.retailer
    || offer.retailerProductId !== direct.retailerContent.retailerProductId
    || direct.targetCanonicalVariantId !== variant.canonicalVariantId
    || normalizeProductTruthBridgeGtin(direct.retailerContent.normalizedGtin14)
      !== direct.retailerContent.normalizedGtin14
    || !titleContainsSize(
      direct.retailerContent.title,
      String(adjudication.targetIdentity.size ?? ""),
    )
    || !sameTitle(donor.title, direct.retailerContent.title)
    || !containsTokens(direct.retailerContent.title, adjudication.targetIdentity.brand)
    || !containsTokens(direct.retailerContent.title, adjudication.targetIdentity.productLine)
    || !containsTokens(target.listingTitle, adjudication.targetIdentity.brand)
    || !containsTokens(target.listingTitle, adjudication.targetIdentity.productLine)
    || adjudication.componentIndex !== 0
    || !Number.isInteger(adjudication.retailPackageQuantity)
    || adjudication.retailPackageQuantity < 1
    || outerSignals.length < 2
    || outerSignals.some(
      (signal) => Number(signal.value) !== adjudication.retailPackageQuantity,
    )
    || (
      baseSize?.dimension === "COUNT"
      && (
        totalSignals.length !== 1
        || Number(totalSignals[0]?.value)
          !== baseSize.baseAmount * adjudication.retailPackageQuantity
      )
    )
    || reviewed.length < 1
    || reviewed.some((file) => !listingImageFiles.has(file))
    || !reviewed.some((file) => /-MAIN\./iu.test(file))
    || listingImages.length !== assessment.verifiedImageCount
    || Date.parse(adjudicatedAt) < Date.parse(direct.capturedAt)
  ) fail("AMAZON_COMPONENT_GRAPH_ADJUDICATION_REJECTED", adjudication.listingKey);

  const core: Omit<
    ProductTruthAmazonComponentGraphEvidenceRow,
    "evidenceRowSha256"
  > = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_COMPONENT_GRAPH_EVIDENCE_VERSION,
    listingKey: listing.listingKey,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    asin: target.asin,
    listingTitle: target.listingTitle,
    componentIndex: adjudication.componentIndex,
    retailPackageQuantity: adjudication.retailPackageQuantity,
    donorProductId: donor.id,
    offerId: offer.id,
    targetIdentity: adjudication.targetIdentity,
    targetCanonicalVariantId: variant.canonicalVariantId,
    normalizedGtin14: direct.retailerContent.normalizedGtin14,
    retailer: direct.retailerContent.retailer,
    retailerProductId: direct.retailerContent.retailerProductId,
    retailerProductUrl: direct.retailerContent.productUrl,
    retailerTitle: direct.retailerContent.title,
    packageForm,
    reviewedImageFiles: reviewed,
    adjudicatedAt,
    adjudication: {
      reviewer: "CODEX_VISUAL_AND_STRUCTURED_EVIDENCE_REVIEW",
      catalogBasePackageMatchesRetailer: true,
      listingOuterQuantityProven: true,
      exactVariantContradictionObserved: false,
      contentTransferAuthorized: false,
    },
    source: {
      amazonCatalogPlanSha256: input.source.catalogPlanSha256,
      amazonCatalogEvidenceSha256: input.source.catalogEvidenceSha256,
      amazonDecompositionSha256: input.source.decompositionSha256,
      amazonImagePlanSha256: input.source.imagePlanSha256,
      amazonImageCaptureSha256: input.source.imageCaptureSha256,
      amazonImageVerificationSha256: input.source.imageVerificationSha256,
      amazonImageAssessmentSha256: input.source.imageAssessmentSha256,
      directRetailerIdentityEvidenceSha256:
        input.source.directRetailerEvidenceSha256,
      directRetailerHtmlSha256: direct.retailerContent.htmlSha256,
      legacySnapshotSha256: input.source.legacySnapshotSha256,
    },
    safety: {
      networkCallsDuringCompilation: 0,
      modelCallsDuringCompilation: 0,
      providerCallsDuringCompilation: 0,
      paidCallsDuringCompilation: 0,
      databaseWritesDuringCompilation: 0,
      marketplaceMutationsDuringCompilation: 0,
    },
  };
  return {
    ...core,
    evidenceRowSha256: productTruthOperationalSha256(
      productTruthAmazonComponentGraphEvidenceCore(
        core as ProductTruthAmazonComponentGraphEvidenceRow,
      ),
    ),
  };
}

function normalizedLabel(value: string): string {
  return identityTokens(value).join(" ");
}

function exactNumericSignals(input: {
  decomposition: ProductTruthAmazonListingDecomposition["entries"][number];
  kind: ProductTruthAmazonListingDecomposition["entries"][number]["signals"][number]["kind"];
}): number[] {
  return input.decomposition.signals
    .filter((signal) => signal.kind === input.kind)
    .map((signal) => Number(signal.value))
    .filter((value) => Number.isFinite(value));
}

function sameCommonAmazonSources(
  left: ProductTruthAmazonComponentGraphSourceSet,
  right: ProductTruthAmazonComponentGraphSourceSet,
): boolean {
  return left.legacySnapshotSha256 === right.legacySnapshotSha256
    && left.catalogPlanSha256 === right.catalogPlanSha256
    && left.catalogCaptureSha256 === right.catalogCaptureSha256
    && left.catalogEvidenceSha256 === right.catalogEvidenceSha256
    && left.decompositionSha256 === right.decompositionSha256
    && left.imagePlanSha256 === right.imagePlanSha256
    && left.imageCaptureSha256 === right.imageCaptureSha256
    && left.imageVerificationSha256 === right.imageVerificationSha256
    && left.imageAssessmentSha256 === right.imageAssessmentSha256;
}

export function validateProductTruthAmazonMixedComponentGraphTopology(input: {
  listingKey: string;
  listingTitle: string;
  reviewedOcr: string;
  catalogFlavorValue: string;
  components: Array<{
    listingVariantLabel: string;
    retailPackageQuantity: number;
    unitCountPerRetailPackage: number;
  }>;
  catalogOuterCount: number;
  titleOuterCount: number;
  titleBaseCount: number;
  titleTotalCount: number;
}): { outerCount: number; baseCount: number; totalCount: number } {
  const labels = input.components.map((component) => normalizedLabel(
    component.listingVariantLabel,
  ));
  const catalogLabels = input.catalogFlavorValue.split(",")
    .map(normalizedLabel)
    .sort();
  const baseCounts = input.components.map(
    (component) => component.unitCountPerRetailPackage,
  );
  const outerCount = input.components.reduce(
    (total, component) => total + component.retailPackageQuantity,
    0,
  );
  const totalCount = input.components.reduce(
    (total, component, index) =>
      total + component.retailPackageQuantity * baseCounts[index]!,
    0,
  );
  if (
    input.components.length < 2
    || input.components.some(
      (component) =>
        !Number.isInteger(component.retailPackageQuantity)
        || component.retailPackageQuantity < 1,
    )
    || labels.some((label) => label.length === 0)
    || new Set(labels).size !== labels.length
    || JSON.stringify([...labels].sort()) !== JSON.stringify(catalogLabels)
    || labels.some((label) => !containsTokens(input.listingTitle, label))
    || labels.some((label) => !containsTokens(input.reviewedOcr, label))
    || baseCounts.some((value) => !Number.isInteger(value) || value < 1)
    || new Set(baseCounts).size !== 1
    || input.catalogOuterCount !== outerCount
    || input.titleOuterCount !== outerCount
    || input.titleBaseCount !== baseCounts[0]
    || input.titleTotalCount !== totalCount
  ) fail("AMAZON_MIXED_COMPONENT_GRAPH_TOPOLOGY_REJECTED", input.listingKey);
  return { outerCount, baseCount: baseCounts[0]!, totalCount };
}

/**
 * Compile a complete heterogeneous Amazon variety-pack graph. Every component
 * remains identity-only: retailer content is not transferred by this proof.
 * The graph is accepted only when the structured outer count, title outer
 * count, title base count, title total count, catalog flavor set, reviewed
 * image OCR, and the sum of all component quantities agree.
 */
export function compileProductTruthAmazonMixedComponentGraphEvidence(input: {
  adjudication: ProductTruthAmazonMixedComponentGraphAdjudication;
  sources: ProductTruthAmazonComponentGraphSourceSet[];
}): ProductTruthAmazonComponentGraphEvidenceRow[] {
  const adjudication = input.adjudication;
  const adjudicatedAt = canonicalInstant(adjudication.adjudicatedAt, "adjudicatedAt");
  const components = [...adjudication.components].sort(
    (left, right) => left.componentIndex - right.componentIndex,
  );
  const sources = [...input.sources];
  if (
    components.length < 2
    || sources.length !== components.length
    || components.some((component, index) => component.componentIndex !== index)
  ) fail("AMAZON_MIXED_COMPONENT_GRAPH_INVALID", adjudication.listingKey);

  for (const source of sources) assertRecompiledSources(source);
  const common = sources[0]!;
  if (sources.some((source) => !sameCommonAmazonSources(common, source))) {
    fail("AMAZON_MIXED_COMPONENT_GRAPH_SOURCE_MISMATCH", adjudication.listingKey);
  }

  const listing = common.legacySnapshot.listings.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const target = common.catalogPlan.targets.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const evidence = common.catalogEvidence.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const decomposition = common.decomposition.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const assessment = common.imageAssessment.entries.find(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const listingImages = common.imageCapture.entries.filter(
    (row) => row.listingKey === adjudication.listingKey,
  );
  const listingImageFiles = new Set(listingImages.map((row) => row.imageFile));
  const reviewed = [...new Set(adjudication.reviewedImageFiles)].sort();
  const reviewedOcr = listingImages
    .filter((row) => reviewed.includes(row.imageFile))
    .flatMap((row) => row.ocr.map((observation) => observation.text))
    .join(" ");
  const catalogFlavorSignals = decomposition?.signals.filter(
    (signal) => signal.kind === "CATALOG_FLAVOR",
  ) ?? [];
  const catalogOuter = decomposition
    ? exactNumericSignals({ decomposition, kind: "CATALOG_OUTER_COUNT" })
    : [];
  const titleOuter = decomposition
    ? exactNumericSignals({ decomposition, kind: "TITLE_OUTER_COUNT" })
    : [];
  const titleBase = decomposition
    ? exactNumericSignals({ decomposition, kind: "TITLE_COUNT" })
    : [];
  const titleTotal = decomposition
    ? exactNumericSignals({ decomposition, kind: "TITLE_TOTAL_COUNT" })
    : [];

  if (
    !listing
    || listing.channel !== "amazon"
    || listing.productIdentityJson !== null
    || common.legacySnapshot.components.some((row) => row.sku === listing.sku)
    || !target
    || !evidence
    || !decomposition
    || !assessment
    || target.asin !== evidence.asin
    || target.asin !== decomposition.asin
    || target.asin !== assessment.asin
    || decomposition.status !== "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE"
    || assessment.status !== "EXPLICIT_RETAILER_ACQUISITION_REQUIRED"
    || reviewed.length < 1
    || reviewed.some((file) => !listingImageFiles.has(file))
    || !reviewed.some((file) => /-MAIN\./iu.test(file))
    || listingImages.length !== assessment.verifiedImageCount
    || catalogOuter.length !== 1
    || titleOuter.length !== 1
    || titleBase.length !== 1
    || titleTotal.length !== 1
    || catalogFlavorSignals.length !== 1
  ) fail("AMAZON_MIXED_COMPONENT_GRAPH_REJECTED", adjudication.listingKey);
  validateProductTruthAmazonMixedComponentGraphTopology({
    listingKey: adjudication.listingKey,
    listingTitle: target.listingTitle,
    reviewedOcr,
    catalogFlavorValue: String(catalogFlavorSignals[0]!.value),
    components: components.map((component) => ({
      listingVariantLabel: component.listingVariantLabel,
      retailPackageQuantity: component.retailPackageQuantity,
      unitCountPerRetailPackage: component.unitCountPerRetailPackage,
    })),
    catalogOuterCount: catalogOuter[0]!,
    titleOuterCount: titleOuter[0]!,
    titleBaseCount: titleBase[0]!,
    titleTotalCount: titleTotal[0]!,
  });

  const rows: ProductTruthAmazonComponentGraphEvidenceRow[] = [];
  const donorIds = new Set<string>();
  const variantIds = new Set<string>();
  for (const component of components) {
    const source = sources.find(
      (candidate) => candidate.directRetailerEvidence.donorProductId
        === component.donorProductId
        && candidate.directRetailerEvidence.offerId === component.offerId,
    );
    const donor = common.legacySnapshot.donors.find(
      (row) => row.id === component.donorProductId,
    );
    const offer = common.legacySnapshot.offers.find(
      (row) => row.id === component.offerId,
    );
    const direct = source?.directRetailerEvidence;
    const variant = buildCanonicalProductVariantKey(component.targetIdentity);
    const directForm = direct?.retailerContent.packageFormEvidence?.normalizedForm ?? null;
    const packageForm = component.packageForm.trim().toLowerCase();
    const targetForm = String(component.targetIdentity.form ?? "")
      .trim().toLowerCase();
    if (
      !source
      || !donor
      || !donor.title
      || !offer
      || !direct
      || offer.donorProductId !== donor.id
      || offer.id !== direct.offerId
      || donor.id !== direct.donorProductId
      || !offer.isFirstParty
      || offer.via !== "direct"
      || !offer.productUrl
      || offer.productUrl !== direct.retailerContent.productUrl
      || offer.retailer.toLowerCase() !== direct.retailerContent.retailer
      || offer.retailerProductId !== direct.retailerContent.retailerProductId
      || direct.targetCanonicalVariantId !== variant.canonicalVariantId
      || normalizeProductTruthBridgeGtin(direct.retailerContent.normalizedGtin14)
        !== direct.retailerContent.normalizedGtin14
      || packageForm !== "carton"
      || (targetForm.length > 0 && targetForm !== packageForm)
      || (directForm !== null && directForm !== packageForm)
      || !titleContainsSize(
        direct.retailerContent.title,
        String(component.targetIdentity.size ?? ""),
      )
      || !sameTitle(donor.title, direct.retailerContent.title)
      || !containsTokens(direct.retailerContent.title, component.targetIdentity.brand)
      || !containsTokens(
        direct.retailerContent.title,
        component.targetIdentity.productLine,
      )
      || !containsTokens(
        direct.retailerContent.title,
        component.listingVariantLabel,
      )
      || Date.parse(adjudicatedAt) < Date.parse(direct.capturedAt)
      || donorIds.has(donor.id)
      || variantIds.has(variant.canonicalVariantId)
    ) fail("AMAZON_MIXED_COMPONENT_ADJUDICATION_REJECTED", component.donorProductId);
    donorIds.add(donor.id);
    variantIds.add(variant.canonicalVariantId);

    const core: Omit<ProductTruthAmazonComponentGraphEvidenceRow, "evidenceRowSha256"> = {
      schemaVersion: PRODUCT_TRUTH_AMAZON_COMPONENT_GRAPH_EVIDENCE_VERSION,
      listingKey: listing.listingKey,
      storeIndex: listing.storeIndex,
      sku: listing.sku,
      asin: target.asin,
      listingTitle: target.listingTitle,
      componentIndex: component.componentIndex,
      retailPackageQuantity: component.retailPackageQuantity,
      donorProductId: donor.id,
      offerId: offer.id,
      targetIdentity: component.targetIdentity,
      targetCanonicalVariantId: variant.canonicalVariantId,
      normalizedGtin14: direct.retailerContent.normalizedGtin14,
      retailer: direct.retailerContent.retailer,
      retailerProductId: direct.retailerContent.retailerProductId,
      retailerProductUrl: direct.retailerContent.productUrl,
      retailerTitle: direct.retailerContent.title,
      packageForm,
      reviewedImageFiles: reviewed,
      adjudicatedAt,
      adjudication: {
        reviewer: "CODEX_VISUAL_AND_STRUCTURED_EVIDENCE_REVIEW",
        catalogBasePackageMatchesRetailer: true,
        listingOuterQuantityProven: true,
        exactVariantContradictionObserved: false,
        contentTransferAuthorized: false,
      },
      source: {
        amazonCatalogPlanSha256: source.catalogPlanSha256,
        amazonCatalogEvidenceSha256: source.catalogEvidenceSha256,
        amazonDecompositionSha256: source.decompositionSha256,
        amazonImagePlanSha256: source.imagePlanSha256,
        amazonImageCaptureSha256: source.imageCaptureSha256,
        amazonImageVerificationSha256: source.imageVerificationSha256,
        amazonImageAssessmentSha256: source.imageAssessmentSha256,
        directRetailerIdentityEvidenceSha256: source.directRetailerEvidenceSha256,
        directRetailerHtmlSha256: direct.retailerContent.htmlSha256,
        legacySnapshotSha256: source.legacySnapshotSha256,
      },
      safety: {
        networkCallsDuringCompilation: 0,
        modelCallsDuringCompilation: 0,
        providerCallsDuringCompilation: 0,
        paidCallsDuringCompilation: 0,
        databaseWritesDuringCompilation: 0,
        marketplaceMutationsDuringCompilation: 0,
      },
    };
    rows.push({
      ...core,
      evidenceRowSha256: productTruthOperationalSha256(
        productTruthAmazonComponentGraphEvidenceCore(
          core as ProductTruthAmazonComponentGraphEvidenceRow,
        ),
      ),
    });
  }
  return rows;
}

export function renderProductTruthAmazonComponentGraphEvidence(
  value: ProductTruthAmazonComponentGraphEvidenceRow,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthAmazonComponentGraphEvidenceSha256(
  value: ProductTruthAmazonComponentGraphEvidenceRow,
): string {
  return productTruthLegacyBridgeBytesSha256(
    renderProductTruthAmazonComponentGraphEvidence(value),
  );
}
