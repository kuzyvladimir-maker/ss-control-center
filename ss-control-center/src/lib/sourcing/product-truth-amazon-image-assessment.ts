import { createHash } from "node:crypto";

import {
  PRODUCT_TRUTH_AMAZON_IMAGE_VERIFICATION_VERSION,
  compileProductTruthAmazonImageVerification,
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageVerification,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
  type ProductTruthAmazonImageVerification,
} from "./product-truth-amazon-image-evidence";
import {
  PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION,
  renderProductTruthAmazonListingDecomposition,
  type ProductTruthAmazonListingDecomposition,
} from "./product-truth-amazon-listing-decomposition";
import { renderProductTruthOperationalJson } from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_AMAZON_IMAGE_ASSESSMENT_VERSION =
  "product-truth-amazon-image-component-assessment/1.0.0" as const;

export interface ProductTruthAmazonVisiblePackageSignal {
  kind:
    | "VISIBLE_COUNT"
    | "VISIBLE_NET_WEIGHT_OZ"
    | "VISIBLE_INNER_PACKAGE_COUNT"
    | "VISIBLE_SERVINGS_PER_CONTAINER";
  value: number;
  unit: "count" | "ounce" | "package" | "serving";
  rawText: string;
  imageFile: string;
  imageSha256: string;
  ocrObservationSha256: string;
  ocrConfidence: number;
  authority: "BYTE_BOUND_LOCAL_OCR_OBSERVATION";
}

export interface ProductTruthAmazonImageAssessment {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_IMAGE_ASSESSMENT_VERSION;
  assessedAt: string;
  source: {
    imagePlanSha256: string;
    imageCaptureSha256: string;
    imageVerificationSha256: string;
    decompositionSha256: string;
    manifestSha256: string;
    targetSetSha256: string;
  };
  entries: Array<{
    ordinal: number;
    listingKey: string;
    asin: string;
    listingTitle: string;
    verifiedImageCount: number;
    machineBarcodeObservationCount: number;
    visiblePackageSignals: ProductTruthAmazonVisiblePackageSignal[];
    blockerCodes: Array<
      | "CATALOG_STRUCTURE_CONTRADICTORY"
      | "NO_MACHINE_DETECTED_BARCODE"
      | "NO_EXACT_PACK_EXISTING_CATALOG_CANDIDATE"
      | "IMAGE_OCR_NOT_EXACT_IDENTITY_AUTHORITY"
      | "EXACT_COMPONENT_GRAPH_NOT_PROVEN"
    >;
    status:
      | "QUARANTINED_CONTRADICTION"
      | "EXPLICIT_RETAILER_ACQUISITION_REQUIRED"
      | "EXACT_ADJUDICATION_REQUIRED";
    exactComponentGraphProven: false;
    authorizesCanonicalMaterialization: false;
  }>;
  counts: {
    targets: number;
    verifiedImages: number;
    visiblePackageSignals: number;
    machineBarcodeObservations: number;
    quarantinedContradictions: number;
    explicitRetailerAcquisitionRequired: number;
    exactAdjudicationRequired: number;
    exactComponentGraphsProven: 0;
    canonicalMaterializationsAuthorized: 0;
  };
  claims: {
    offlineAssessment: true;
    imageBytesReverified: true;
    ocrIsObservationOnly: true;
    barcodeIsBaseUnitProof: false;
    adjacentPackIsContentDonor: false;
    titleOnlyIdentityProof: false;
    networkCalls: 0;
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    databaseWrites: 0;
    marketplaceMutations: 0;
    authorizesCanonicalMaterialization: false;
  };
}

export class ProductTruthAmazonImageAssessmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthAmazonImageAssessmentError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthAmazonImageAssessmentError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("AMAZON_IMAGE_ASSESSMENT_INSTANT_INVALID", label);
  }
  return value;
}

function exactSha(value: string, label: string): string {
  const normalized = value.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail("AMAZON_IMAGE_ASSESSMENT_SHA_INVALID", label);
  }
  return normalized;
}

function assertCanonical(input: {
  label: string;
  json: string;
  expectedSha256: string;
  canonicalJson: string;
}): string {
  const expected = exactSha(input.expectedSha256, input.label);
  if (sha256(input.json) !== expected || input.json !== input.canonicalJson) {
    fail("AMAZON_IMAGE_ASSESSMENT_SOURCE_MISMATCH", input.label);
  }
  return expected;
}

function packageSignals(input: {
  entry: ProductTruthAmazonImageCapture["entries"][number];
  ocrObservationSha256: string;
}): ProductTruthAmazonVisiblePackageSignal[] {
  const patterns: Array<{
    kind: ProductTruthAmazonVisiblePackageSignal["kind"];
    unit: ProductTruthAmazonVisiblePackageSignal["unit"];
    pattern: RegExp;
  }> = [
    { kind: "VISIBLE_COUNT", unit: "count", pattern: /\b(\d{1,4})\s*COUNT\b/iu },
    { kind: "VISIBLE_NET_WEIGHT_OZ", unit: "ounce", pattern: /\bNET\s+WT\s+(\d+(?:\.\d+)?)\s*OZ\b/iu },
    { kind: "VISIBLE_INNER_PACKAGE_COUNT", unit: "package", pattern: /\bSTAY[- ]FRESH\s+(\d{1,3})\s+PACKAGES?\b/iu },
    { kind: "VISIBLE_SERVINGS_PER_CONTAINER", unit: "serving", pattern: /\b(\d{1,4})\s+SERVINGS?\s+PER\s+CONTAINER\b/iu },
  ];
  return input.entry.ocr.flatMap((observation) => patterns.flatMap((rule) => {
    const match = observation.text.match(rule.pattern);
    if (!match) return [];
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return [];
    return [{
      kind: rule.kind,
      value,
      unit: rule.unit,
      rawText: observation.text,
      imageFile: input.entry.imageFile,
      imageSha256: input.entry.imageSha256,
      ocrObservationSha256: input.ocrObservationSha256,
      ocrConfidence: observation.confidence,
      authority: "BYTE_BOUND_LOCAL_OCR_OBSERVATION" as const,
    }];
  }));
}

export function compileProductTruthAmazonImageAssessment(input: {
  assessedAt: string;
  imagePlan: ProductTruthAmazonImageCapturePlan;
  imagePlanJson: string;
  imagePlanSha256: string;
  imageCapture: ProductTruthAmazonImageCapture;
  imageCaptureJson: string;
  imageCaptureSha256: string;
  imageVerification: ProductTruthAmazonImageVerification;
  imageVerificationJson: string;
  imageVerificationSha256: string;
  imageBytesByFile: ReadonlyMap<string, Uint8Array>;
  decomposition: ProductTruthAmazonListingDecomposition;
  decompositionJson: string;
  decompositionSha256: string;
}): ProductTruthAmazonImageAssessment {
  const assessedAt = exactInstant(input.assessedAt, "assessedAt");
  const imagePlanSha256 = assertCanonical({
    label: "imagePlan",
    json: input.imagePlanJson,
    expectedSha256: input.imagePlanSha256,
    canonicalJson: renderProductTruthAmazonImageCapturePlan(input.imagePlan),
  });
  const imageCaptureSha256 = assertCanonical({
    label: "imageCapture",
    json: input.imageCaptureJson,
    expectedSha256: input.imageCaptureSha256,
    canonicalJson: renderProductTruthAmazonImageCapture(input.imageCapture),
  });
  if (input.imageVerification.schemaVersion !== PRODUCT_TRUTH_AMAZON_IMAGE_VERIFICATION_VERSION) {
    fail("AMAZON_IMAGE_ASSESSMENT_VERIFICATION_INVALID", "schemaVersion");
  }
  const imageVerificationSha256 = assertCanonical({
    label: "imageVerification",
    json: input.imageVerificationJson,
    expectedSha256: input.imageVerificationSha256,
    canonicalJson: renderProductTruthAmazonImageVerification(input.imageVerification),
  });
  const reverified = compileProductTruthAmazonImageVerification({
    verifiedAt: input.imageVerification.verifiedAt,
    plan: input.imagePlan,
    planJson: input.imagePlanJson,
    planSha256: imagePlanSha256,
    capture: input.imageCapture,
    captureJson: input.imageCaptureJson,
    captureSha256: imageCaptureSha256,
    imageBytesByFile: input.imageBytesByFile,
  });
  if (
    renderProductTruthAmazonImageVerification(reverified)
      !== input.imageVerificationJson
  ) fail("AMAZON_IMAGE_ASSESSMENT_VERIFICATION_INVALID", "recompilation mismatch");
  if (
    input.decomposition.schemaVersion
      !== PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION
    || input.decomposition.source.manifestSha256
      !== input.imagePlan.source.manifestSha256
    || input.decomposition.source.targetSetSha256
      !== input.imagePlan.source.targetSetSha256
    || input.decomposition.entries.length
      !== new Set(input.imagePlan.targets.map((row) => row.listingKey)).size
    || input.decomposition.claims.authorizesCanonicalMaterialization
  ) fail("AMAZON_IMAGE_ASSESSMENT_DECOMPOSITION_INVALID", "contract drift");
  const decompositionSha256 = assertCanonical({
    label: "decomposition",
    json: input.decompositionJson,
    expectedSha256: input.decompositionSha256,
    canonicalJson: renderProductTruthAmazonListingDecomposition(input.decomposition),
  });
  const verificationByFile = new Map(input.imageVerification.entries.map((entry) => [
    entry.imageFile,
    entry,
  ]));
  const captureByListing = new Map<string, ProductTruthAmazonImageCapture["entries"]>();
  for (const entry of input.imageCapture.entries) {
    const rows = captureByListing.get(entry.listingKey) ?? [];
    rows.push(entry);
    captureByListing.set(entry.listingKey, rows);
  }
  const entries = input.decomposition.entries.map((decomposition) => {
    const images = captureByListing.get(decomposition.listingKey) ?? [];
    if (!images.length || images.some((entry) => entry.asin !== decomposition.asin)) {
      fail("AMAZON_IMAGE_ASSESSMENT_TARGET_MISMATCH", decomposition.listingKey);
    }
    const visiblePackageSignals = images.flatMap((entry) => {
      const verification = verificationByFile.get(entry.imageFile);
      if (!verification || verification.listingKey !== entry.listingKey) {
        fail("AMAZON_IMAGE_ASSESSMENT_TARGET_MISMATCH", entry.imageFile);
      }
      return packageSignals({
        entry,
        ocrObservationSha256: verification.ocrObservationSha256,
      });
    }).sort((left, right) =>
      left.kind.localeCompare(right.kind, "en-US")
      || left.imageFile.localeCompare(right.imageFile, "en-US"));
    const barcodeCount = images.reduce((sum, entry) => sum + entry.barcodes.length, 0);
    const contradictory = decomposition.status === "CONTRADICTORY_CATALOG_STRUCTURE";
    const noCandidate = decomposition.status === "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE";
    const blockerCodes: ProductTruthAmazonImageAssessment["entries"][number]["blockerCodes"] = [];
    if (contradictory) blockerCodes.push("CATALOG_STRUCTURE_CONTRADICTORY");
    if (barcodeCount === 0) blockerCodes.push("NO_MACHINE_DETECTED_BARCODE");
    if (noCandidate) blockerCodes.push("NO_EXACT_PACK_EXISTING_CATALOG_CANDIDATE");
    blockerCodes.push(
      "IMAGE_OCR_NOT_EXACT_IDENTITY_AUTHORITY",
      "EXACT_COMPONENT_GRAPH_NOT_PROVEN",
    );
    return {
      ordinal: decomposition.ordinal,
      listingKey: decomposition.listingKey,
      asin: decomposition.asin,
      listingTitle: decomposition.listingTitle,
      verifiedImageCount: images.length,
      machineBarcodeObservationCount: barcodeCount,
      visiblePackageSignals,
      blockerCodes,
      status: contradictory
        ? "QUARANTINED_CONTRADICTION" as const
        : noCandidate
          ? "EXPLICIT_RETAILER_ACQUISITION_REQUIRED" as const
          : "EXACT_ADJUDICATION_REQUIRED" as const,
      exactComponentGraphProven: false as const,
      authorizesCanonicalMaterialization: false as const,
    };
  });
  return {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_ASSESSMENT_VERSION,
    assessedAt,
    source: {
      imagePlanSha256,
      imageCaptureSha256,
      imageVerificationSha256,
      decompositionSha256,
      manifestSha256: input.imagePlan.source.manifestSha256,
      targetSetSha256: input.imagePlan.source.targetSetSha256,
    },
    entries,
    counts: {
      targets: entries.length,
      verifiedImages: entries.reduce((sum, entry) => sum + entry.verifiedImageCount, 0),
      visiblePackageSignals: entries.reduce(
        (sum, entry) => sum + entry.visiblePackageSignals.length,
        0,
      ),
      machineBarcodeObservations: entries.reduce(
        (sum, entry) => sum + entry.machineBarcodeObservationCount,
        0,
      ),
      quarantinedContradictions: entries.filter(
        (entry) => entry.status === "QUARANTINED_CONTRADICTION",
      ).length,
      explicitRetailerAcquisitionRequired: entries.filter(
        (entry) => entry.status === "EXPLICIT_RETAILER_ACQUISITION_REQUIRED",
      ).length,
      exactAdjudicationRequired: entries.filter(
        (entry) => entry.status === "EXACT_ADJUDICATION_REQUIRED",
      ).length,
      exactComponentGraphsProven: 0,
      canonicalMaterializationsAuthorized: 0,
    },
    claims: {
      offlineAssessment: true,
      imageBytesReverified: true,
      ocrIsObservationOnly: true,
      barcodeIsBaseUnitProof: false,
      adjacentPackIsContentDonor: false,
      titleOnlyIdentityProof: false,
      networkCalls: 0,
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      databaseWrites: 0,
      marketplaceMutations: 0,
      authorizesCanonicalMaterialization: false,
    },
  };
}

export function renderProductTruthAmazonImageAssessment(
  value: ProductTruthAmazonImageAssessment,
): string {
  return renderProductTruthOperationalJson(value);
}
