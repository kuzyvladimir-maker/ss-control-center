export const WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_SCHEMA =
  "walmart-listing-integrity-runtime-status/v1" as const;

export type WalmartListingIntegrityRuntimeState =
  | "NOT_AVAILABLE"
  | "WAITING_PREDECESSOR"
  | "MONITORING_QUALIFICATION"
  | "REQUIRES_DISPOSITION"
  | "ACTIVE_CYCLE"
  | "PAUSED_LIMIT"
  | "QUEUE_COMPLETE"
  | "ERROR";

export interface WalmartListingIntegrityRuntimeStatus {
  schemaVersion: typeof WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_SCHEMA;
  state: WalmartListingIntegrityRuntimeState;
  checkedAt: string | null;
  activeListingKey: string | null;
  activeSku: string | null;
  successor: null | {
    status:
      | "WAITING_FOR_PREDECESSOR_QUALIFICATION"
      | "SUCCESSOR_ACTIVE_CYCLE_PROGRESS"
      | "SUCCESSOR_LIMIT_REACHED"
      | "CONTROL_QUEUE_COMPLETE"
      | "STOPPED_ON_UNSUPPORTED_CONTROL_STATE"
      | "STOPPED_ON_ERROR";
    checkedAt: string;
    pid: number;
    processAlive: boolean;
    lastCycleWalmartWrites: 0 | 1;
  };
  qualification: null | {
    status: "PENDING_PROPAGATION" | "PASS" | "FAIL";
    check: number;
    checkedAt: string;
    monitorAlive: boolean;
    blockingFacets: string[];
    publishedAndIndexedPreserved: boolean;
    failureNotBefore: string | null;
  };
  claims: {
    source: "LOCAL_SHA_CUSTODY_STATUS";
    statusLoaderWalmartReads: 0;
    statusLoaderWalmartWrites: 0;
    mutationControlsExposed: false;
  };
}
