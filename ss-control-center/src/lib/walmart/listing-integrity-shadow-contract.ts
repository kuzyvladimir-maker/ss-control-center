export interface ListingIntegrityShadowImage {
  slot: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  role: string;
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
  visualAttestationStatus: "PENDING";
  limitations: string[];
}

export interface ListingIntegrityShadowData {
  mode: "SHADOW_READ_ONLY";
  engine: {
    closedLoopTestsPassed: number;
    focusedTestsPassed: number;
    shadowTestsPassed: number;
    historicalCases: number;
    walmartWrites: 0;
  };
  cases: ListingIntegrityShadowCase[];
  gates: {
    liveCanary: "LOCKED";
    massRun: "LOCKED";
    next: string;
  };
}
