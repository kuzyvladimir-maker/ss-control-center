import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  compileProductTruthAmazonImageAssessment,
} from "../product-truth-amazon-image-assessment";
import {
  PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
  PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION,
  compileProductTruthAmazonImageVerification,
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageVerification,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
} from "../product-truth-amazon-image-evidence";
import {
  PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION,
  renderProductTruthAmazonListingDecomposition,
  type ProductTruthAmazonListingDecomposition,
} from "../product-truth-amazon-listing-decomposition";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";

const AT = "2026-08-01T18:00:00.000Z";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const target = {
    ordinal: 1,
    listingKey: "amazon:1:SKU-1",
    storeIndex: 1,
    sku: "SKU-1",
    asin: "B000000001",
    variants: ["MAIN"],
    imageUrl: "https://m.media-amazon.com/images/I/main.jpg",
    declaredWidth: 500,
    declaredHeight: 500,
    sourceEntrySha256: "1".repeat(64),
  };
  const imagePlan: ProductTruthAmazonImageCapturePlan = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION,
    generatedAt: AT,
    source: {
      catalogPlanSha256: "2".repeat(64),
      catalogEvidenceSha256: "3".repeat(64),
      manifestSha256: "4".repeat(64),
      targetSetSha256: "5".repeat(64),
    },
    requestContract: {
      method: "GET",
      allowedHost: "m.media-amazon.com",
      concurrency: 1,
      attemptsPerImage: 1,
      maxImagesPerListing: 10,
      maxImagesTotal: 250,
      maxImageBytes: 10485760,
    },
    imageSetSha256: sha256(renderProductTruthOperationalJson([target])),
    targets: [target],
    claims: {
      explicitCatalogScopeOnly: true,
      amazonCdnReadOnly: true,
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      databaseWrites: 0,
      marketplaceMutations: 0,
      visualObservationIsIdentityProof: false,
      authorizesCanonicalMaterialization: false,
    },
  };
  const imagePlanJson = renderProductTruthAmazonImageCapturePlan(imagePlan);
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const imageCapture: ProductTruthAmazonImageCapture = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
    capturedAt: AT,
    source: {
      imagePlanSha256: sha256(imagePlanJson),
      imageSetSha256: imagePlan.imageSetSha256,
      targetCount: 1,
    },
    entries: [{
      ordinal: 1,
      listingKey: target.listingKey,
      storeIndex: 1,
      sku: target.sku,
      asin: target.asin,
      variants: target.variants,
      requestedUrl: target.imageUrl,
      finalUrl: target.imageUrl,
      capturedAt: AT,
      imageFile: "0001.jpg",
      mimeType: "image/jpeg",
      byteLength: bytes.byteLength,
      imageSha256: sha256(bytes),
      decodedWidth: 500,
      decodedHeight: 500,
      ocr: [
        { text: "48 COUNT", confidence: 1, boundingBox: { x: 0, y: 0.5, width: 0.4, height: 0.1 } },
        { text: "NET WT 38.4 OZ", confidence: 1, boundingBox: { x: 0, y: 0, width: 0.5, height: 0.1 } },
      ],
      barcodes: [],
      observationAuthority: {
        engine: "APPLE_VISION_LOCAL",
        modelCalls: 0,
        barcodeIsBaseUnitProof: false,
        ocrIsExactIdentityProof: false,
        authorizesCanonicalMaterialization: false,
      },
    }],
    counts: {
      planned: 1, captured: 1, amazonCdnGetCalls: 1, retries: 0,
      imagesWithText: 1, imagesWithBarcodes: 0, barcodeObservations: 0,
    },
    claims: {
      localAppleVision: true,
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      databaseWrites: 0,
      marketplaceMutations: 0,
      barcodeIsBaseUnitProof: false,
      ocrIsExactIdentityProof: false,
      authorizesCanonicalMaterialization: false,
    },
  };
  const imageCaptureJson = renderProductTruthAmazonImageCapture(imageCapture);
  const imageBytesByFile = new Map([["0001.jpg", bytes]]);
  const imageVerification = compileProductTruthAmazonImageVerification({
    verifiedAt: AT,
    plan: imagePlan,
    planJson: imagePlanJson,
    planSha256: sha256(imagePlanJson),
    capture: imageCapture,
    captureJson: imageCaptureJson,
    captureSha256: sha256(imageCaptureJson),
    imageBytesByFile,
  });
  const imageVerificationJson = renderProductTruthAmazonImageVerification(
    imageVerification,
  );
  const decomposition: ProductTruthAmazonListingDecomposition = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_LISTING_DECOMPOSITION_VERSION,
    compiledAt: AT,
    source: {
      planSha256: "6".repeat(64), evidenceSha256: "7".repeat(64),
      legacySnapshotSha256: "8".repeat(64),
      manifestSha256: imagePlan.source.manifestSha256,
      targetSetSha256: imagePlan.source.targetSetSha256,
    },
    entries: [{
      ordinal: 1,
      listingKey: target.listingKey,
      storeIndex: 1,
      sku: target.sku,
      asin: target.asin,
      listingTitle: "Acme 48 Count",
      signals: [],
      blockerCodes: [
        "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE",
        "EXACT_COMPONENT_IDENTITY_NOT_PROVEN",
      ],
      status: "NO_ALLOWED_EXISTING_CATALOG_CANDIDATE",
      candidates: [],
      claims: {
        outerIdentifiersUsedAsBaseUnitProof: false,
        titleOnlyIdentityProof: false,
        exactComponentIdentityProven: false,
        authorizesCanonicalMaterialization: false,
      },
    }],
    counts: {
      targets: 1, contradictory: 0, withoutAllowedCandidate: 1,
      candidatesRequireExactAdjudication: 0,
      exactComponentIdentityProven: 0, canonicalMaterializationsAuthorized: 0,
    },
    claims: {
      offlineCompilation: true, existingCatalogOnly: true, clubsExcluded: true,
      bjsExcluded: true, networkCalls: 0, databaseWrites: 0, providerCalls: 0,
      paidCalls: 0, marketplaceMutations: 0, titleOnlyIdentityProof: false,
      outerIdentifiersUsedAsBaseUnitProof: false,
      authorizesCanonicalMaterialization: false, createsAdditionalCatalog: false,
    },
  };
  const decompositionJson = renderProductTruthAmazonListingDecomposition(decomposition);
  return {
    imagePlan, imagePlanJson, imageCapture, imageCaptureJson,
    imageVerification, imageVerificationJson, imageBytesByFile,
    decomposition, decompositionJson,
  };
}

function assess(source: ReturnType<typeof fixture>) {
  return compileProductTruthAmazonImageAssessment({
    assessedAt: AT,
    imagePlan: source.imagePlan,
    imagePlanJson: source.imagePlanJson,
    imagePlanSha256: sha256(source.imagePlanJson),
    imageCapture: source.imageCapture,
    imageCaptureJson: source.imageCaptureJson,
    imageCaptureSha256: sha256(source.imageCaptureJson),
    imageVerification: source.imageVerification,
    imageVerificationJson: source.imageVerificationJson,
    imageVerificationSha256: sha256(source.imageVerificationJson),
    imageBytesByFile: source.imageBytesByFile,
    decomposition: source.decomposition,
    decompositionJson: source.decompositionJson,
    decompositionSha256: sha256(source.decompositionJson),
  });
}

test("records byte-bound visible package facts but requires retailer acquisition", () => {
  const result = assess(fixture());
  assert.equal(result.entries[0]!.status, "EXPLICIT_RETAILER_ACQUISITION_REQUIRED");
  assert.deepEqual(result.entries[0]!.visiblePackageSignals.map((row) => row.value), [48, 38.4]);
  assert.equal(result.counts.exactComponentGraphsProven, 0);
  assert.equal(result.claims.adjacentPackIsContentDonor, false);
});

test("re-verifies image bytes before assessment", () => {
  const source = fixture();
  source.imageBytesByFile.set("0001.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0]));
  assert.throws(() => assess(source), /AMAZON_IMAGE_BYTES_INVALID/u);
});

test("preserves catalog contradictions as quarantine", () => {
  const source = fixture();
  source.decomposition.entries[0]!.status = "CONTRADICTORY_CATALOG_STRUCTURE";
  source.decomposition.entries[0]!.blockerCodes.unshift("OUTER_COUNT_CONFLICT");
  source.decomposition.counts.contradictory = 1;
  source.decomposition.counts.withoutAllowedCandidate = 0;
  source.decompositionJson = renderProductTruthAmazonListingDecomposition(
    source.decomposition,
  );
  const result = assess(source);
  assert.equal(result.entries[0]!.status, "QUARANTINED_CONTRADICTION");
  assert.equal(result.claims.authorizesCanonicalMaterialization, false);
});
