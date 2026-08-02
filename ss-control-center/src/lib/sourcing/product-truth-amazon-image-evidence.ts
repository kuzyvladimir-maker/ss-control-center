import { createHash } from "node:crypto";

import {
  PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  validateProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogListingEvidence,
} from "./product-truth-amazon-catalog-evidence";
import { renderProductTruthOperationalJson } from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION =
  "product-truth-amazon-image-capture-plan/1.0.0" as const;
export const PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION =
  "product-truth-amazon-image-capture/1.0.0" as const;
export const PRODUCT_TRUTH_AMAZON_IMAGE_VERIFICATION_VERSION =
  "product-truth-amazon-image-verification/1.0.0" as const;
export const PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING = 10;
export const PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL = 250;

type JsonObject = Record<string, unknown>;

export interface ProductTruthAmazonImagePlanTarget {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  asin: string;
  variants: string[];
  imageUrl: string;
  declaredWidth: number;
  declaredHeight: number;
  sourceEntrySha256: string;
}

export interface ProductTruthAmazonImageCapturePlan {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION;
  generatedAt: string;
  source: {
    catalogPlanSha256: string;
    catalogEvidenceSha256: string;
    manifestSha256: string;
    targetSetSha256: string;
  };
  requestContract: {
    method: "GET";
    allowedHost: "m.media-amazon.com";
    concurrency: 1;
    attemptsPerImage: 1;
    maxImagesPerListing: typeof PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING;
    maxImagesTotal: typeof PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL;
    maxImageBytes: 10485760;
  };
  imageSetSha256: string;
  targets: ProductTruthAmazonImagePlanTarget[];
  claims: {
    explicitCatalogScopeOnly: true;
    amazonCdnReadOnly: true;
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    databaseWrites: 0;
    marketplaceMutations: 0;
    visualObservationIsIdentityProof: false;
    authorizesCanonicalMaterialization: false;
  };
}

export interface ProductTruthAmazonImageTextObservation {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface ProductTruthAmazonImageBarcodeObservation {
  symbology: string;
  payload: string;
  confidence: number;
}

export interface ProductTruthAmazonImageCaptureEntry {
  ordinal: number;
  listingKey: string;
  storeIndex: number;
  sku: string;
  asin: string;
  variants: string[];
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  imageFile: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  imageSha256: string;
  decodedWidth: number;
  decodedHeight: number;
  ocr: ProductTruthAmazonImageTextObservation[];
  barcodes: ProductTruthAmazonImageBarcodeObservation[];
  observationAuthority: {
    engine: "APPLE_VISION_LOCAL";
    modelCalls: 0;
    barcodeIsBaseUnitProof: false;
    ocrIsExactIdentityProof: false;
    authorizesCanonicalMaterialization: false;
  };
}

export interface ProductTruthAmazonImageCapture {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION;
  capturedAt: string;
  source: {
    imagePlanSha256: string;
    imageSetSha256: string;
    targetCount: number;
  };
  entries: ProductTruthAmazonImageCaptureEntry[];
  counts: {
    planned: number;
    captured: number;
    amazonCdnGetCalls: number;
    retries: 0;
    imagesWithText: number;
    imagesWithBarcodes: number;
    barcodeObservations: number;
  };
  claims: {
    localAppleVision: true;
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    databaseWrites: 0;
    marketplaceMutations: 0;
    barcodeIsBaseUnitProof: false;
    ocrIsExactIdentityProof: false;
    authorizesCanonicalMaterialization: false;
  };
}

export interface ProductTruthAmazonImageVerification {
  schemaVersion: typeof PRODUCT_TRUTH_AMAZON_IMAGE_VERIFICATION_VERSION;
  verifiedAt: string;
  source: {
    imagePlanSha256: string;
    imageCaptureSha256: string;
    imageSetSha256: string;
    targetCount: number;
  };
  entries: Array<{
    ordinal: number;
    listingKey: string;
    asin: string;
    variants: string[];
    imageFile: string;
    imageSha256: string;
    byteLength: number;
    ocrObservationSha256: string;
    barcodeObservationSha256: string;
  }>;
  counts: ProductTruthAmazonImageCapture["counts"];
  claims: {
    offlineVerification: true;
    everyImageByteVerified: true;
    everyCaptureEntryPlanBound: true;
    localAppleVisionObservationRecorded: true;
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    networkCalls: 0;
    databaseWrites: 0;
    marketplaceMutations: 0;
    barcodeIsBaseUnitProof: false;
    ocrIsExactIdentityProof: false;
    authorizesCanonicalMaterialization: false;
  };
}

export class ProductTruthAmazonImageEvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthAmazonImageEvidenceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthAmazonImageEvidenceError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail("AMAZON_IMAGE_SHA_INVALID", label);
  }
  return normalized;
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("AMAZON_IMAGE_INSTANT_INVALID", label);
  }
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AMAZON_IMAGE_SOURCE_INVALID", `${label} must be object`);
  }
  return value as JsonObject;
}

function assertCanonical(input: {
  label: string;
  json: string;
  expectedSha256: string;
  canonicalJson: string;
}): string {
  const expected = exactSha(input.expectedSha256, input.label);
  if (input.json !== input.canonicalJson || sha256(input.json) !== expected) {
    fail("AMAZON_IMAGE_SOURCE_BINDING_MISMATCH", input.label);
  }
  return expected;
}

function exactImageUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("AMAZON_IMAGE_URL_INVALID", label);
  }
  if (url.protocol !== "https:" || url.hostname !== "m.media-amazon.com") {
    fail("AMAZON_IMAGE_URL_INVALID", label);
  }
  return url.href;
}

function imageSetSha256(targets: readonly ProductTruthAmazonImagePlanTarget[]): string {
  return sha256(renderProductTruthOperationalJson(targets));
}

function assertImageMime(bytes: Uint8Array, mimeType: string, label: string): void {
  const jpeg = bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a
    && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (
    (mimeType === "image/jpeg" && !jpeg)
    || (mimeType === "image/png" && !png)
    || (mimeType === "image/webp" && !webp)
  ) fail("AMAZON_IMAGE_BYTES_INVALID", `${label} MIME signature`);
}

function assertObservationNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail("AMAZON_IMAGE_CAPTURE_INVALID", label);
  }
}

export function compileProductTruthAmazonImageCapturePlan(input: {
  generatedAt: string;
  catalogPlan: ProductTruthAmazonCatalogCapturePlan;
  catalogPlanJson: string;
  catalogPlanSha256: string;
  catalogEvidence: ProductTruthAmazonCatalogListingEvidence;
  catalogEvidenceJson: string;
  catalogEvidenceSha256: string;
}): ProductTruthAmazonImageCapturePlan {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  validateProductTruthAmazonCatalogCapturePlan(input.catalogPlan);
  const catalogPlanSha256 = assertCanonical({
    label: "catalogPlan",
    json: input.catalogPlanJson,
    expectedSha256: input.catalogPlanSha256,
    canonicalJson: renderProductTruthAmazonCatalogCapturePlan(input.catalogPlan),
  });
  if (
    input.catalogEvidence.schemaVersion !== PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION
    || input.catalogEvidence.source.planSha256 !== catalogPlanSha256
    || input.catalogEvidence.source.targetSetSha256
      !== input.catalogPlan.targetSetSha256
    || input.catalogEvidence.entries.length !== input.catalogPlan.targets.length
    || input.catalogEvidence.counts.targets !== input.catalogPlan.targets.length
    || input.catalogEvidence.claims.networkCalls !== 0
    || input.catalogEvidence.claims.databaseWrites !== 0
    || input.catalogEvidence.claims.providerCalls !== 0
    || input.catalogEvidence.claims.paidCalls !== 0
    || input.catalogEvidence.claims.marketplaceMutations !== 0
    || input.catalogEvidence.claims.authorizesCanonicalMaterialization
  ) fail("AMAZON_IMAGE_EVIDENCE_INVALID", "catalog evidence contract drift");
  const catalogEvidenceSha256 = assertCanonical({
    label: "catalogEvidence",
    json: input.catalogEvidenceJson,
    expectedSha256: input.catalogEvidenceSha256,
    canonicalJson: renderProductTruthAmazonCatalogListingEvidence(
      input.catalogEvidence,
    ),
  });
  const targets: ProductTruthAmazonImagePlanTarget[] = [];
  for (const entry of input.catalogEvidence.entries) {
    const sourceEntrySha256 = sha256(renderProductTruthOperationalJson(entry));
    const bestByVariant = new Map<string, {
      variant: string;
      link: string;
      width: number;
      height: number;
    }>();
    for (const groupValue of entry.catalog.images) {
      const group = object(groupValue, `${entry.listingKey}.imageGroup`);
      if (group.marketplaceId !== "ATVPDKIKX0DER") continue;
      if (!Array.isArray(group.images)) {
        fail("AMAZON_IMAGE_SOURCE_INVALID", `${entry.listingKey}.images`);
      }
      for (const imageValue of group.images) {
        const image = object(imageValue, `${entry.listingKey}.image`);
        if (
          typeof image.variant !== "string"
          || typeof image.link !== "string"
          || !Number.isInteger(image.width)
          || !Number.isInteger(image.height)
          || Number(image.width) < 1
          || Number(image.height) < 1
        ) fail("AMAZON_IMAGE_SOURCE_INVALID", `${entry.listingKey}.image fields`);
        const row = {
          variant: image.variant.trim().toLocaleUpperCase("en-US"),
          link: exactImageUrl(image.link, entry.listingKey),
          width: Number(image.width),
          height: Number(image.height),
        };
        const current = bestByVariant.get(row.variant);
        const area = row.width * row.height;
        const currentArea = current ? current.width * current.height : -1;
        if (
          !current
          || area > currentArea
          || (area === currentArea && row.link.localeCompare(current.link, "en-US") < 0)
        ) bestByVariant.set(row.variant, row);
      }
    }
    const selected = [...bestByVariant.values()].sort((left, right) => {
      if (left.variant === "MAIN" && right.variant !== "MAIN") return -1;
      if (right.variant === "MAIN" && left.variant !== "MAIN") return 1;
      return left.variant.localeCompare(right.variant, "en-US");
    });
    if (selected.length > PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING) {
      fail("AMAZON_IMAGE_LISTING_LIMIT_EXCEEDED", entry.listingKey);
    }
    const mergedByUrl = new Map<string, typeof selected[number] & { variants: string[] }>();
    for (const row of selected) {
      const existing = mergedByUrl.get(row.link);
      if (existing) {
        existing.variants.push(row.variant);
      } else {
        mergedByUrl.set(row.link, { ...row, variants: [row.variant] });
      }
    }
    for (const row of mergedByUrl.values()) {
      targets.push({
        ordinal: targets.length + 1,
        listingKey: entry.listingKey,
        storeIndex: entry.storeIndex,
        sku: entry.sku,
        asin: entry.asin,
        variants: row.variants.sort((left, right) => left.localeCompare(right, "en-US")),
        imageUrl: row.link,
        declaredWidth: row.width,
        declaredHeight: row.height,
        sourceEntrySha256,
      });
    }
  }
  if (!targets.length || targets.length > PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL) {
    fail("AMAZON_IMAGE_TARGET_COUNT_INVALID", `${targets.length}`);
  }
  const plan: ProductTruthAmazonImageCapturePlan = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION,
    generatedAt,
    source: {
      catalogPlanSha256,
      catalogEvidenceSha256,
      manifestSha256: input.catalogPlan.source.manifest.sha256,
      targetSetSha256: input.catalogPlan.targetSetSha256,
    },
    requestContract: {
      method: "GET",
      allowedHost: "m.media-amazon.com",
      concurrency: 1,
      attemptsPerImage: 1,
      maxImagesPerListing: PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING,
      maxImagesTotal: PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL,
      maxImageBytes: 10485760,
    },
    imageSetSha256: imageSetSha256(targets),
    targets,
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
  validateProductTruthAmazonImageCapturePlan(plan);
  return plan;
}

export function validateProductTruthAmazonImageCapturePlan(
  plan: ProductTruthAmazonImageCapturePlan,
): void {
  if (
    plan.schemaVersion !== PRODUCT_TRUTH_AMAZON_IMAGE_PLAN_VERSION
    || plan.targets.length < 1
    || plan.targets.length > PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL
    || plan.targets.some((row, index) => row.ordinal !== index + 1)
    || imageSetSha256(plan.targets) !== plan.imageSetSha256
    || plan.requestContract.method !== "GET"
    || plan.requestContract.allowedHost !== "m.media-amazon.com"
    || plan.requestContract.concurrency !== 1
    || plan.requestContract.attemptsPerImage !== 1
    || plan.requestContract.maxImagesPerListing
      !== PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING
    || plan.requestContract.maxImagesTotal !== PRODUCT_TRUTH_AMAZON_IMAGE_MAX_TOTAL
    || plan.requestContract.maxImageBytes !== 10 * 1024 * 1024
    || !plan.claims.explicitCatalogScopeOnly
    || !plan.claims.amazonCdnReadOnly
    || plan.claims.modelCalls !== 0
    || plan.claims.providerCalls !== 0
    || plan.claims.paidCalls !== 0
    || plan.claims.databaseWrites !== 0
    || plan.claims.marketplaceMutations !== 0
    || plan.claims.visualObservationIsIdentityProof
    || plan.claims.authorizesCanonicalMaterialization
  ) fail("AMAZON_IMAGE_PLAN_INVALID", "request or safety drift");
  const perListing = new Map<string, number>();
  for (const row of plan.targets) {
    exactImageUrl(row.imageUrl, row.listingKey);
    exactSha(row.sourceEntrySha256, `${row.listingKey}.sourceEntrySha256`);
    if (
      !row.variants.length
      || new Set(row.variants).size !== row.variants.length
      || row.variants.some((variant) => !/^[A-Z0-9]+$/u.test(variant))
      || row.listingKey !== `amazon:${row.storeIndex}:${row.sku}`
      || row.asin.length !== 10
      || !Number.isInteger(row.declaredWidth)
      || !Number.isInteger(row.declaredHeight)
      || row.declaredWidth < 1
      || row.declaredHeight < 1
    ) fail("AMAZON_IMAGE_PLAN_INVALID", row.listingKey);
    perListing.set(row.listingKey, (perListing.get(row.listingKey) ?? 0) + 1);
  }
  if ([...perListing.values()].some((count) => count > PRODUCT_TRUTH_AMAZON_IMAGE_MAX_PER_LISTING)) {
    fail("AMAZON_IMAGE_PLAN_INVALID", "per-listing target limit");
  }
  canonicalInstant(plan.generatedAt, "plan.generatedAt");
  exactSha(plan.source.catalogPlanSha256, "source.catalogPlanSha256");
  exactSha(plan.source.catalogEvidenceSha256, "source.catalogEvidenceSha256");
}

export function renderProductTruthAmazonImageCapturePlan(
  value: ProductTruthAmazonImageCapturePlan,
): string {
  return renderProductTruthOperationalJson(value);
}

export function renderProductTruthAmazonImageCapture(
  value: ProductTruthAmazonImageCapture,
): string {
  return renderProductTruthOperationalJson(value);
}

export function compileProductTruthAmazonImageVerification(input: {
  verifiedAt: string;
  plan: ProductTruthAmazonImageCapturePlan;
  planJson: string;
  planSha256: string;
  capture: ProductTruthAmazonImageCapture;
  captureJson: string;
  captureSha256: string;
  imageBytesByFile: ReadonlyMap<string, Uint8Array>;
}): ProductTruthAmazonImageVerification {
  const verifiedAt = canonicalInstant(input.verifiedAt, "verifiedAt");
  validateProductTruthAmazonImageCapturePlan(input.plan);
  const imagePlanSha256 = assertCanonical({
    label: "imagePlan",
    json: input.planJson,
    expectedSha256: input.planSha256,
    canonicalJson: renderProductTruthAmazonImageCapturePlan(input.plan),
  });
  if (
    input.capture.schemaVersion !== PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION
    || input.capture.source.imagePlanSha256 !== imagePlanSha256
    || input.capture.source.imageSetSha256 !== input.plan.imageSetSha256
    || input.capture.source.targetCount !== input.plan.targets.length
    || input.capture.entries.length !== input.plan.targets.length
    || input.capture.claims.localAppleVision !== true
    || input.capture.claims.modelCalls !== 0
    || input.capture.claims.providerCalls !== 0
    || input.capture.claims.paidCalls !== 0
    || input.capture.claims.databaseWrites !== 0
    || input.capture.claims.marketplaceMutations !== 0
    || input.capture.claims.barcodeIsBaseUnitProof
    || input.capture.claims.ocrIsExactIdentityProof
    || input.capture.claims.authorizesCanonicalMaterialization
  ) fail("AMAZON_IMAGE_CAPTURE_INVALID", "source or safety contract drift");
  const imageCaptureSha256 = assertCanonical({
    label: "imageCapture",
    json: input.captureJson,
    expectedSha256: input.captureSha256,
    canonicalJson: renderProductTruthAmazonImageCapture(input.capture),
  });
  canonicalInstant(input.capture.capturedAt, "capture.capturedAt");
  const imageFiles = new Set<string>();
  const entries = input.capture.entries.map((entry, index) => {
    const target = input.plan.targets[index]!;
    if (
      entry.ordinal !== target.ordinal
      || entry.ordinal !== index + 1
      || entry.listingKey !== target.listingKey
      || entry.storeIndex !== target.storeIndex
      || entry.sku !== target.sku
      || entry.asin !== target.asin
      || entry.requestedUrl !== target.imageUrl
      || renderProductTruthOperationalJson(entry.variants)
        !== renderProductTruthOperationalJson(target.variants)
      || entry.observationAuthority.engine !== "APPLE_VISION_LOCAL"
      || entry.observationAuthority.modelCalls !== 0
      || entry.observationAuthority.barcodeIsBaseUnitProof
      || entry.observationAuthority.ocrIsExactIdentityProof
      || entry.observationAuthority.authorizesCanonicalMaterialization
    ) fail("AMAZON_IMAGE_CAPTURE_INVALID", `${target.listingKey} binding`);
    canonicalInstant(entry.capturedAt, `${entry.listingKey}.capturedAt`);
    exactImageUrl(entry.finalUrl, `${entry.listingKey}.finalUrl`);
    exactSha(entry.imageSha256, `${entry.listingKey}.imageSha256`);
    if (
      !/^[A-Za-z0-9._-]+$/u.test(entry.imageFile)
      || imageFiles.has(entry.imageFile)
      || !Number.isInteger(entry.byteLength)
      || entry.byteLength < 1
      || entry.byteLength > input.plan.requestContract.maxImageBytes
      || !Number.isInteger(entry.decodedWidth)
      || !Number.isInteger(entry.decodedHeight)
      || entry.decodedWidth < 1
      || entry.decodedHeight < 1
      || entry.ocr.length > 500
      || entry.barcodes.length > 20
    ) fail("AMAZON_IMAGE_CAPTURE_INVALID", `${entry.listingKey} fields`);
    imageFiles.add(entry.imageFile);
    const bytes = input.imageBytesByFile.get(entry.imageFile);
    if (
      !bytes
      || bytes.byteLength !== entry.byteLength
      || sha256(bytes) !== entry.imageSha256
    ) fail("AMAZON_IMAGE_BYTES_INVALID", entry.imageFile);
    assertImageMime(bytes, entry.mimeType, entry.imageFile);
    for (const [rowIndex, observation] of entry.ocr.entries()) {
      if (!observation.text.trim()) {
        fail("AMAZON_IMAGE_CAPTURE_INVALID", `${entry.imageFile}.ocr[${rowIndex}]`);
      }
      assertObservationNumber(
        observation.confidence,
        `${entry.imageFile}.ocr[${rowIndex}].confidence`,
      );
      const box = observation.boundingBox;
      for (const [field, value] of Object.entries(box)) {
        assertObservationNumber(value, `${entry.imageFile}.ocr[${rowIndex}].${field}`);
      }
      if (
        box.width <= 0 || box.height <= 0
        || box.x + box.width > 1.000000001
        || box.y + box.height > 1.000000001
      ) fail("AMAZON_IMAGE_CAPTURE_INVALID", `${entry.imageFile}.ocr box`);
    }
    for (const [rowIndex, observation] of entry.barcodes.entries()) {
      if (!observation.symbology.trim() || !observation.payload.trim()) {
        fail("AMAZON_IMAGE_CAPTURE_INVALID", `${entry.imageFile}.barcode[${rowIndex}]`);
      }
      assertObservationNumber(
        observation.confidence,
        `${entry.imageFile}.barcode[${rowIndex}].confidence`,
      );
    }
    return {
      ordinal: entry.ordinal,
      listingKey: entry.listingKey,
      asin: entry.asin,
      variants: entry.variants,
      imageFile: entry.imageFile,
      imageSha256: entry.imageSha256,
      byteLength: entry.byteLength,
      ocrObservationSha256: sha256(renderProductTruthOperationalJson(entry.ocr)),
      barcodeObservationSha256: sha256(
        renderProductTruthOperationalJson(entry.barcodes),
      ),
    };
  });
  if (
    input.imageBytesByFile.size !== entries.length
    || [...input.imageBytesByFile.keys()].some((file) => !imageFiles.has(file))
  ) fail("AMAZON_IMAGE_BYTES_INVALID", "image file set mismatch");
  const counts: ProductTruthAmazonImageCapture["counts"] = {
    planned: input.plan.targets.length,
    captured: entries.length,
    amazonCdnGetCalls: entries.length,
    retries: 0,
    imagesWithText: input.capture.entries.filter((entry) => entry.ocr.length > 0).length,
    imagesWithBarcodes: input.capture.entries.filter(
      (entry) => entry.barcodes.length > 0,
    ).length,
    barcodeObservations: input.capture.entries.reduce(
      (sum, entry) => sum + entry.barcodes.length,
      0,
    ),
  };
  if (
    renderProductTruthOperationalJson(counts)
      !== renderProductTruthOperationalJson(input.capture.counts)
  ) fail("AMAZON_IMAGE_CAPTURE_INVALID", "count mismatch");
  return {
    schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_VERIFICATION_VERSION,
    verifiedAt,
    source: {
      imagePlanSha256,
      imageCaptureSha256,
      imageSetSha256: input.plan.imageSetSha256,
      targetCount: input.plan.targets.length,
    },
    entries,
    counts,
    claims: {
      offlineVerification: true,
      everyImageByteVerified: true,
      everyCaptureEntryPlanBound: true,
      localAppleVisionObservationRecorded: true,
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      networkCalls: 0,
      databaseWrites: 0,
      marketplaceMutations: 0,
      barcodeIsBaseUnitProof: false,
      ocrIsExactIdentityProof: false,
      authorizesCanonicalMaterialization: false,
    },
  };
}

export function renderProductTruthAmazonImageVerification(
  value: ProductTruthAmazonImageVerification,
): string {
  return renderProductTruthOperationalJson(value);
}
