import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION,
  PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
  PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA,
  PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID,
  PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  type ProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogListingEvidence,
} from "../product-truth-amazon-catalog-evidence";
import {
  PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
  compileProductTruthAmazonImageVerification,
  compileProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageCapture,
  validateProductTruthAmazonImageCapturePlan,
  type ProductTruthAmazonImageCapture,
} from "../product-truth-amazon-image-evidence";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";

const AT = "2026-08-01T17:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const target = {
    ordinal: 1,
    listingKey: "amazon:1:SKU-1",
    storeIndex: 1,
    sku: "SKU-1",
    asin: "B000000001",
    listingTitle: "Acme Product",
    repairLane: "LISTING_IDENTITY_RECOVERY" as const,
    sourceReportId: "report-1",
    sourceCapturedAt: AT,
    sourceContentSha256: "1".repeat(64),
    manifestRowSha256: "2".repeat(64),
    recipeScopeEntrySha256: "3".repeat(64),
  };
  const catalogPlan: ProductTruthAmazonCatalogCapturePlan = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION,
    generatedAt: AT,
    source: {
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: "4".repeat(64),
        listingCount: 1,
      },
      recipeRepairScope: {
        schemaVersion: "product-truth-recipe-repair-scope/1.0.0",
        sha256: "5".repeat(64),
        generatedAt: AT,
      },
    },
    requestContract: {
      api: "Amazon Catalog Items 2022-04-01",
      method: "GET",
      marketplaceId: PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID,
      includedData: PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA,
      concurrency: 1,
      attemptsPerTarget: 1,
      maxTargets: PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS,
    },
    targetSetSha256: sha256(renderProductTruthOperationalJson([target])),
    targets: [target],
    claims: {
      explicitScopeOnly: true,
      readOnlyAmazonApi: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      authorizesCanonicalMaterialization: false,
      identifiersAreBaseUnitProof: false,
    },
  };
  const catalogPlanJson = renderProductTruthAmazonCatalogCapturePlan(catalogPlan);
  const catalogEvidence: ProductTruthAmazonCatalogListingEvidence = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
    compiledAt: AT,
    source: {
      planSha256: sha256(catalogPlanJson),
      captureSha256: "6".repeat(64),
      targetSetSha256: catalogPlan.targetSetSha256,
    },
    entries: [{
      ordinal: 1,
      listingKey: target.listingKey,
      storeIndex: 1,
      sku: target.sku,
      asin: target.asin,
      listingTitle: target.listingTitle,
      repairLane: target.repairLane,
      rawCapture: {
        file: "raw.json", sha256: "7".repeat(64), byteLength: 1, capturedAt: AT,
      },
      catalog: {
        asin: target.asin,
        attributes: {},
        identifiers: [],
        images: [{
          marketplaceId: "ATVPDKIKX0DER",
          images: [
            { variant: "MAIN", width: 500, height: 500, link: "https://m.media-amazon.com/images/I/main-small.jpg" },
            { variant: "MAIN", width: 1000, height: 1000, link: "https://m.media-amazon.com/images/I/main-large.jpg" },
            { variant: "PT01", width: 800, height: 600, link: "https://m.media-amazon.com/images/I/pt01.jpg" },
          ],
        }],
        productTypes: [], relationships: [], summaries: [],
      },
      authority: {
        structuredMarketplaceEvidence: true,
        titleOnlyIdentityProof: false,
        identifiersAreBaseUnitProof: false,
        authorizesCanonicalMaterialization: false,
      },
    }],
    counts: {
      targets: 1, entriesWithIdentifiers: 0, identifierCount: 0,
      entriesWithAttributes: 0, entriesWithImages: 1,
    },
    claims: {
      offlineCompilation: true,
      networkCalls: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      titleOnlyIdentityProof: false,
      identifiersAreBaseUnitProof: false,
      authorizesCanonicalMaterialization: false,
      createsAdditionalCatalog: false,
    },
  };
  const catalogEvidenceJson = renderProductTruthAmazonCatalogListingEvidence(
    catalogEvidence,
  );
  return { catalogPlan, catalogPlanJson, catalogEvidence, catalogEvidenceJson };
}

test("selects only the highest-resolution image for each Amazon variant", () => {
  const source = fixture();
  const plan = compileProductTruthAmazonImageCapturePlan({
    generatedAt: AT,
    catalogPlan: source.catalogPlan,
    catalogPlanJson: source.catalogPlanJson,
    catalogPlanSha256: sha256(source.catalogPlanJson),
    catalogEvidence: source.catalogEvidence,
    catalogEvidenceJson: source.catalogEvidenceJson,
    catalogEvidenceSha256: sha256(source.catalogEvidenceJson),
  });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.targets[0]!.variants[0], "MAIN");
  assert.equal(plan.targets[0]!.declaredWidth, 1000);
  assert.equal(plan.targets[0]!.imageUrl, "https://m.media-amazon.com/images/I/main-large.jpg");
  assert.equal(plan.targets[1]!.variants[0], "PT01");
  validateProductTruthAmazonImageCapturePlan(plan);
  assert.equal(plan.claims.authorizesCanonicalMaterialization, false);
});

test("rejects a non-Amazon CDN image before any capture plan exists", () => {
  const source = fixture();
  const group = source.catalogEvidence.entries[0]!.catalog.images[0] as {
    images: Array<{ link: string }>;
  };
  group.images[0]!.link = "https://images.example.test/wrong.jpg";
  const json = renderProductTruthAmazonCatalogListingEvidence(source.catalogEvidence);
  assert.throws(() => compileProductTruthAmazonImageCapturePlan({
    generatedAt: AT,
    catalogPlan: source.catalogPlan,
    catalogPlanJson: source.catalogPlanJson,
    catalogPlanSha256: sha256(source.catalogPlanJson),
    catalogEvidence: source.catalogEvidence,
    catalogEvidenceJson: json,
    catalogEvidenceSha256: sha256(json),
  }), /AMAZON_IMAGE_URL_INVALID/u);
});

test("rejects image-plan safety drift", () => {
  const source = fixture();
  const plan = compileProductTruthAmazonImageCapturePlan({
    generatedAt: AT,
    catalogPlan: source.catalogPlan,
    catalogPlanJson: source.catalogPlanJson,
    catalogPlanSha256: sha256(source.catalogPlanJson),
    catalogEvidence: source.catalogEvidence,
    catalogEvidenceJson: source.catalogEvidenceJson,
    catalogEvidenceSha256: sha256(source.catalogEvidenceJson),
  });
  plan.requestContract.attemptsPerImage = 2 as 1;
  assert.throws(
    () => validateProductTruthAmazonImageCapturePlan(plan),
    /AMAZON_IMAGE_PLAN_INVALID/u,
  );
});

function captureFixture() {
  const source = fixture();
  const plan = compileProductTruthAmazonImageCapturePlan({
    generatedAt: AT,
    catalogPlan: source.catalogPlan,
    catalogPlanJson: source.catalogPlanJson,
    catalogPlanSha256: sha256(source.catalogPlanJson),
    catalogEvidence: source.catalogEvidence,
    catalogEvidenceJson: source.catalogEvidenceJson,
    catalogEvidenceSha256: sha256(source.catalogEvidenceJson),
  });
  const planJson = renderProductTruthOperationalJson(plan);
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const entries: ProductTruthAmazonImageCapture["entries"] = plan.targets.map(
    (target) => ({
      ordinal: target.ordinal,
      listingKey: target.listingKey,
      storeIndex: target.storeIndex,
      sku: target.sku,
      asin: target.asin,
      variants: target.variants,
      requestedUrl: target.imageUrl,
      finalUrl: target.imageUrl,
      capturedAt: AT,
      imageFile: `${String(target.ordinal).padStart(4, "0")}.jpg`,
      mimeType: "image/jpeg",
      byteLength: bytes.byteLength,
      imageSha256: createHash("sha256").update(bytes).digest("hex"),
      decodedWidth: 1,
      decodedHeight: 1,
      ocr: [{
        text: "ACME",
        confidence: 1,
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
      }],
      barcodes: [],
      observationAuthority: {
        engine: "APPLE_VISION_LOCAL",
        modelCalls: 0,
        barcodeIsBaseUnitProof: false,
        ocrIsExactIdentityProof: false,
        authorizesCanonicalMaterialization: false,
      },
    }),
  );
  const capture: ProductTruthAmazonImageCapture = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
    capturedAt: AT,
    source: {
      imagePlanSha256: sha256(planJson),
      imageSetSha256: plan.imageSetSha256,
      targetCount: plan.targets.length,
    },
    entries,
    counts: {
      planned: entries.length,
      captured: entries.length,
      amazonCdnGetCalls: entries.length,
      retries: 0,
      imagesWithText: entries.length,
      imagesWithBarcodes: 0,
      barcodeObservations: 0,
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
  const captureJson = renderProductTruthAmazonImageCapture(capture);
  const imageBytesByFile = new Map(entries.map((entry) => [entry.imageFile, bytes]));
  return { plan, planJson, capture, captureJson, imageBytesByFile };
}

test("verifies every Amazon image byte and exact plan/capture binding", () => {
  const source = captureFixture();
  const verification = compileProductTruthAmazonImageVerification({
    verifiedAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    capture: source.capture,
    captureJson: source.captureJson,
    captureSha256: sha256(source.captureJson),
    imageBytesByFile: source.imageBytesByFile,
  });
  assert.equal(verification.entries.length, 2);
  assert.equal(verification.claims.everyImageByteVerified, true);
  assert.equal(verification.claims.authorizesCanonicalMaterialization, false);
});

test("rejects a byte-tampered Amazon image", () => {
  const source = captureFixture();
  source.imageBytesByFile.set("0001.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
  assert.throws(() => compileProductTruthAmazonImageVerification({
    verifiedAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    capture: source.capture,
    captureJson: source.captureJson,
    captureSha256: sha256(source.captureJson),
    imageBytesByFile: source.imageBytesByFile,
  }), /AMAZON_IMAGE_BYTES_INVALID/u);
});

test("rejects capture metadata drift even when image bytes still match", () => {
  const source = captureFixture();
  source.capture.entries[0]!.listingKey = "amazon:1:WRONG";
  const captureJson = renderProductTruthAmazonImageCapture(source.capture);
  assert.throws(() => compileProductTruthAmazonImageVerification({
    verifiedAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    capture: source.capture,
    captureJson,
    captureSha256: sha256(captureJson),
    imageBytesByFile: source.imageBytesByFile,
  }), /AMAZON_IMAGE_CAPTURE_INVALID/u);
});
