export interface ListingIntegrityShadowImage {
  slot: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  role: string;
}

export interface ListingIntegrityProductTruthReadiness {
  status:
    | "BLOCKED_SCHEMA_NOT_READY"
    | "BLOCKED_SKU_TRUTH_NOT_READY"
    | "READY"
    | "UNVERIFIED";
  capturedAt: string | null;
  sourceContract: string | null;
  schemaReady: boolean;
  pendingMigrations: number | null;
  listingKey: string | null;
  blockers: string[];
  executionPackageReady: boolean;
  walmartWriteAuthorized: false;
  massRunAuthorized: false;
  sharedPlanPath: string | null;
  sharedPlanSha256: string | null;
  evidencePath: string | null;
  evidenceSha256: string | null;
}

export interface ListingIntegrityShadowCase {
  controlId: string;
  capturedAt: string;
  sku: string;
  itemId: string;
  title: string;
  publishedStatus: string;
  lifecycleStatus: string;
  expectedOuterUnits: number;
  observedMainUnits: number;
  currentImages: ListingIntegrityShadowImage[];
  proposedMain: ListingIntegrityShadowImage & {
    representedOuterUnits: number;
  };
  beforeVerdict: "BAD" | "REVIEW" | "PASS";
  beforeReason: string;
  proposedMainVerdict: "BAD" | "REVIEW" | "PASS";
  qualification: string;
  changedFields: string[];
  evidencePath: string;
  canaryPreviewPath: string;
  byteCustodyStatus: "VERIFIED";
  visualAttestationStatus:
    | "PENDING"
    | "SIGNED_TARGET_PASS_GALLERY_REVIEW_REQUIRED"
    | "SIGNED_SHADOW_VISUAL_PASS";
  visualAttestation?: {
    comparatorVersion: string;
    evidencePath: string;
    currentMainVerdict: "BAD";
    targetMainVerdict: "PASS";
    galleryBadCount: 0;
    galleryReviewCount: number;
    workerBuild: string;
    signedReceiptCount: number;
  };
  ownerVisualReviewStatus: "PENDING" | "APPROVED";
  ownerVisualReview?: {
    reviewedAt: string;
    evidencePath: string;
    reviewSha256: string;
    currentMainAcceptedAsOnePackage: true;
    proposedMainAcceptedAsSixPackages: true;
    galleryAccepted: true;
    walmartWriteAuthorized: false;
  };
  limitations: string[];
}

export interface ListingIntegrityCatalogOverview {
  status: "NOT_CAPTURED" | "CATALOG_PLAN_READY" | "CAPTURE_TEST_READY";
  capturedAt: string | null;
  catalogSyncedAt: string | null;
  censusId: string | null;
  planId: string | null;
  snapshotVerified: boolean;
  evidencePath: string | null;
  censusFileSha256: string | null;
  planFileSha256: string | null;
  catalog: {
    total: number;
    published: number;
    active: number;
    withItemId: number;
    withTitle: number;
    exactOnce: boolean;
    duplicateSkus: number;
  };
  queues: {
    visualTriageReady: number;
    sourceAcquisitionRequired: number;
    statusReview: number;
    blockedSource: number;
    doNotTouch: number;
    deterministicConflicts: number;
  };
  visualScan: {
    listings: number;
    tasks: number;
    partitions: number;
    estimatedModelCallsMax: number;
    capturedPartitions: number;
    capturedAssets: number;
    captureTechnicalErrors: number;
    modelCallsCompleted: number;
    walmartWrites: 0;
  };
  policy: {
    mode: "READ_ONLY_TRIAGE";
    imagesPerCallMax: number;
    callsPerPartitionMax: number;
    buyerVerifiedPassAllowed: false;
    walmartWritesAllowed: false;
  };
}

export interface ListingIntegrityShadowData {
  mode: "SHADOW_READ_ONLY";
  catalog: ListingIntegrityCatalogOverview;
  productTruth: ListingIntegrityProductTruthReadiness;
  engine: {
    closedLoopTestsPassed: number;
    focusedTestsPassed: number;
    visualComparatorTestsPassed: number;
    observationTestsPassed: number;
    workerSecurityTestsPassed: number;
    shadowTestsPassed: number;
    historicalCases: number;
    walmartWrites: 0;
  };
  cases: ListingIntegrityShadowCase[];
  gates: {
    productTruth:
      | "BLOCKED_SCHEMA_NOT_READY"
      | "BLOCKED_SKU_TRUTH_NOT_READY"
      | "READY"
      | "UNVERIFIED";
    liveCanary: "LOCKED";
    massRun: "LOCKED";
    next: string;
  };
}
