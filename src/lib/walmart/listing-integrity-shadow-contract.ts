export interface ListingIntegrityShadowImage {
  slot: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  role: string;
}

export interface ListingIntegrityOwnerRepairReview {
  status: "OWNER_REVIEW_REQUIRED";
  selectedAt: string;
  createdAt: string;
  listingKey: string;
  sku: string;
  itemId: string;
  title: string;
  publishedStatus: string;
  lifecycleStatus: string;
  productTruth: {
    donorProductId: string;
    brand: string;
    product: string;
    variant: string;
    singleUnitSize: string;
    singleUnitInnerCount: number;
    singleUnitUpc: string;
    outerUnits: number;
    totalUnits: number;
    wrongLegacyDonorId: string;
  };
  current: {
    description: string;
    bullets: string[];
    images: ListingIntegrityShadowImage[];
  };
  proposed: {
    description: string;
    bullets: string[];
  };
  changedFields: ["description", "bullets"];
  unchangedFields: string[];
  qualificationPrecheck: "PASS";
  exactImageBytesVerified: true;
  certificationBodySha256: string;
  reviewFileSha256: string;
  certificationFileSha256: string;
  evidenceIndexPath: string;
  evidenceIndexSha256: string;
  approvalInstruction: string;
  walmartWriteAuthorized: false;
  databaseWriteAuthorized: false;
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

export interface ListingIntegrityCompletedOperation {
  listingKey: string;
  sku: string;
  itemId: string;
  feedId: string;
  payloadSha256: string;
  beforeCapturedAt: string;
  afterCapturedAt: string;
  checksPassed: number;
  qualification: "PASS";
  publishedAndActive: true;
  indexingPreserved: true;
  galleryHref: string;
  galleryFileSha256: string;
  verificationFileSha256: string;
}

export interface ListingIntegrityQuarantinedOperation {
  listingKey: string;
  sku: string;
  itemId: string;
  quarantinedAt: string;
  status: "QUARANTINED_UNRESOLVED";
  outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET";
  nextAction: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN";
  listingRepairComplete: false;
  samePayloadReapplyAllowed: false;
  walmartWriteAuthorized: false;
  dispositionBodySha256: string;
  dispositionFileSha256: string;
}

export interface ListingIntegrityControlledPoolRow {
  ordinal: number;
  listingKey: string;
  sku: string;
  itemId: string;
  title: string;
  outerUnits: number | null;
  stage: "PRODUCT_TRUTH_READY";
  nextAction: "FRESH_SOURCE_AWARE_AUDIT";
  deterministicFindings: string[];
  performance: {
    units90: number;
    sales90: number;
    returns90: number;
    returnRate90: number | null;
    computedAt: string | null;
  };
  walmartWriteAuthorized: false;
}

export interface ListingIntegritySourceRequiredRow {
  ordinal: number;
  listingKey: string;
  sku: string;
  itemId: string;
  title: string;
  outerUnits: number | null;
  stage: "SOURCE_REQUIRED";
  nextAction: "ENRICH_EXACT_PRODUCT_TRUTH";
  deterministicFindings: string[];
  productTruthBlockers: string[];
  walmartWriteAuthorized: false;
}

export interface ListingIntegrityOperationsState {
  status: "NOT_READY" | "READ_ONLY_POOL_READY";
  poolId: string | null;
  poolBodySha256: string | null;
  poolFileSha256: string | null;
  poolCreatedAt: string | null;
  poolEvidencePath: string | null;
  strictSequence: true;
  maxApplyInFlight: 1;
  walmartWritesAllowed: false;
  modelCallsAllowed: false;
  sourceCandidateCount: number;
  repairReadyCount: number;
  sourceRequiredCount: number;
  quarantinedCount: number;
  completed: ListingIntegrityCompletedOperation[];
  quarantined: ListingIntegrityQuarantinedOperation[];
  pool: ListingIntegrityControlledPoolRow[];
  sourceRequired: ListingIntegritySourceRequiredRow[];
}

export interface ListingIntegrityShadowData {
  mode: "SHADOW_READ_ONLY";
  ownerRepairReview: ListingIntegrityOwnerRepairReview | null;
  catalog: ListingIntegrityCatalogOverview;
  operations: ListingIntegrityOperationsState;
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
