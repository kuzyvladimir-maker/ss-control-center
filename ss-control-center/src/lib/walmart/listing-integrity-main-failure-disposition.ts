import { createHash } from "node:crypto";

import {
  walmartListingIntegrityControlSha256,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA =
  "walmart-listing-integrity-main-terminal-failure-disposition/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityMainFailureDisposition {
  schema_version: typeof WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA;
  disposition_id: string;
  created_at: string;
  status: "QUARANTINED_UNRESOLVED";
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  accepted_feed: {
    feed_id: string;
    terminal_at: string;
    request_payload_sha256: string;
    feed_status_payload_sha256: string;
    walmart_item_result: "SUCCESS";
  };
  bindings: {
    execution_package_artifact_sha256: string;
    permit_authorization_sha256: string;
    plan_body_sha256: string;
    frozen_release_id_sha256: string;
  };
  failed_qualification: {
    qualification_id: string;
    qualified_at: string;
    qualification_body_sha256: string;
    operator_receipt_body_sha256: string;
    operator_receipt_file_sha256: string;
    propagation_window_complete: true;
    published_and_indexed_preserved: true;
    automatic_reapply_allowed: false;
  };
  main_evidence: {
    live_main_sha256: string;
    target_main_sha256: string;
    live_capture_created_at: string;
    live_capture_intake_index_body_sha256: string;
    encoded_bytes_exact: false;
    equivalent: false;
    dhash_distance: number;
    maximum_dhash_distance: number;
    psnr_millidb: number;
    minimum_psnr_millidb: number;
  };
  classification: {
    outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN";
    likely_platform_cause: "CATALOG_CONTENT_PRIORITY_PROPAGATION_OR_OWNERSHIP";
    cause_proof_level: "LIKELY_NOT_PROVEN";
    same_payload_reapply_allowed: false;
    listing_repair_complete: false;
  };
  sequence: {
    next_listing_unblocked: true;
    quarantined_listing_excluded_from_active_pool: true;
    max_apply_in_flight: 1;
  };
  next_action: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN";
  marketplace_write_authorized: false;
  body_sha256: string;
}

export class WalmartListingIntegrityMainFailureDispositionError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartListingIntegrityMainFailureDispositionError";
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingIntegrityMainFailureDispositionError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_EVIDENCE", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_EVIDENCE", `${label} must be bounded exact text`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail("INVALID_EVIDENCE", `${label} must be lowercase SHA-256`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail("INVALID_EVIDENCE", `${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const timestamp = new Date(parsed);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== parsed) {
    fail("INVALID_EVIDENCE", `${label} must be canonical UTC`);
  }
  return parsed;
}

function sealedRecord(value: unknown, label: string): JsonRecord {
  const parsed = record(value, label);
  const claimed = digest(parsed.body_sha256, `${label}.body_sha256`);
  const body = { ...parsed };
  delete body.body_sha256;
  if (walmartListingIntegrityControlSha256(body) !== claimed) {
    fail("SEAL_MISMATCH", `${label} body seal differs`);
  }
  return parsed;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildWalmartListingIntegrityMainFailureDisposition(input: {
  operator_receipt_bytes: Uint8Array;
  expected_listing: {
    listing_key: string;
    sku: string;
    store_index: number;
  };
  expected_execution_package_sha256: string;
  expected_owner_permit_sha256: string;
  expected_plan_body_sha256: string;
  expected_frozen_release_id_sha256: string;
  created_at: string;
}): WalmartListingIntegrityMainFailureDisposition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(
      input.operator_receipt_bytes,
    ));
  } catch {
    return fail("INVALID_EVIDENCE", "operator receipt must be exact UTF-8 JSON");
  }
  const operator = sealedRecord(decoded, "operator receipt");
  if (operator.schema_version !== "walmart-listing-repair-operator-receipt/v1"
    || operator.command !== "qualify" || operator.status !== "FAIL"
    || operator.marketplace_write_authorized !== false
    || operator.automatic_reapply_allowed !== false) {
    fail("NOT_TERMINAL_FAILURE", "operator receipt is not a terminal no-reapply FAIL");
  }
  const effects = record(operator.external_effects, "operator external_effects");
  if (effects.model_calls !== 0 || effects.paid_provider_calls !== 0
    || effects.database_writes !== 0 || effects.walmart_content_writes !== 0) {
    fail("FORBIDDEN_EFFECT", "terminal Qualification receipt contains forbidden effects");
  }
  if (digest(
    operator.execution_package_artifact_sha256,
    "execution package SHA",
  ) !== digest(input.expected_execution_package_sha256, "expected execution package SHA")
    || digest(operator.permit_authorization_sha256, "permit SHA")
      !== digest(input.expected_owner_permit_sha256, "expected permit SHA")) {
    fail("BINDING_MISMATCH", "operator receipt differs from exact package or permit");
  }

  const listing = record(operator.listing, "operator listing");
  const storeIndex = integer(listing.store_index, "listing.store_index", 1);
  const sku = text(listing.sku, "listing.sku", 512);
  const listingKey = text(listing.listing_key, "listing.listing_key", 768);
  const itemId = text(listing.item_id, "listing.item_id", 128);
  if (listing.channel !== "WALMART_US"
    || storeIndex !== input.expected_listing.store_index
    || sku !== input.expected_listing.sku
    || listingKey !== input.expected_listing.listing_key) {
    fail("IDENTITY_MISMATCH", "operator listing differs from exact control identity");
  }

  const qualification = sealedRecord(operator.qualification, "live Qualification");
  if (qualification.schema_version
      !== "walmart-listing-integrity-repair-live-qualification/v2"
    || qualification.verdict !== "FAIL"
    || qualification.next_action !== "OWNER_REVIEW_REPLAN"
    || qualification.next_sku_unblocked !== false
    || qualification.marketplace_write_authorized !== false
    || qualification.automatic_reapply_allowed !== false
    || digest(qualification.plan_body_sha256, "Qualification plan SHA")
      !== digest(input.expected_plan_body_sha256, "expected plan SHA")) {
    fail("NOT_TERMINAL_FAILURE", "live Qualification is not the expected terminal FAIL");
  }
  const qualifiedAt = instant(qualification.qualified_at, "qualified_at");
  const propagation = record(qualification.propagation, "Qualification propagation");
  const failureNotBefore = instant(propagation.failure_not_before, "failure_not_before");
  if (propagation.reread_before_failure_window !== false
    || propagation.recheck_same_sku_without_write !== false
    || Date.parse(qualifiedAt) < Date.parse(failureNotBefore)) {
    fail("FAILURE_WINDOW_OPEN", "MAIN failure is not after the full propagation window");
  }
  const facets = record(qualification.facets, "Qualification facets");
  if (facets.main !== "FAIL" || facets.exact_repair_target !== "FAIL"
    || facets.published_and_indexed !== "PASS"
    || facets.fresh_authenticated_live_reread !== "PASS"
    || facets.terminal_apply_custody !== "PASS") {
    fail("FAILURE_NOT_CLASSIFIABLE", "failure is not an exact post-SLA MAIN failure");
  }
  const equivalence = record(qualification.main_equivalence, "MAIN equivalence");
  const liveMainSha = digest(equivalence.live_sha256, "live MAIN SHA");
  const targetMainSha = digest(equivalence.target_sha256, "target MAIN SHA");
  if (equivalence.encoded_bytes_exact !== false || equivalence.equivalent !== false
    || liveMainSha === targetMainSha) {
    fail("FAILURE_NOT_CLASSIFIABLE", "MAIN evidence does not prove a different live image");
  }
  const liveCapture = record(qualification.live_capture, "live capture");
  const captureCreatedAt = instant(liveCapture.created_at, "live capture created_at");
  const captureImages = Array.isArray(liveCapture.image_sha256)
    ? liveCapture.image_sha256.map((value, index) => digest(value, `live image ${index}`))
    : fail("INVALID_EVIDENCE", "live capture image_sha256 must be an array");
  if (!captureImages.includes(liveMainSha)
    || Date.parse(captureCreatedAt) > Date.parse(qualifiedAt)) {
    fail("IDENTITY_MISMATCH", "fresh capture does not contain the failed live MAIN");
  }
  const applyCustody = record(qualification.apply_custody, "apply custody");
  const createdAt = instant(input.created_at, "created_at");
  if (Date.parse(createdAt) < Date.parse(qualifiedAt)) {
    fail("INVALID_EVIDENCE", "disposition cannot predate terminal Qualification");
  }
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA,
    created_at: createdAt,
    status: "QUARANTINED_UNRESOLVED" as const,
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku,
      listing_key: listingKey,
      item_id: itemId,
    },
    accepted_feed: {
      feed_id: text(qualification.feed_id, "feed_id", 512),
      terminal_at: instant(qualification.feed_terminal_at, "feed_terminal_at"),
      request_payload_sha256: digest(
        applyCustody.request_payload_sha256,
        "request_payload_sha256",
      ),
      feed_status_payload_sha256: digest(
        applyCustody.terminal_feed_status_payload_sha256,
        "feed_status_payload_sha256",
      ),
      walmart_item_result: "SUCCESS" as const,
    },
    bindings: {
      execution_package_artifact_sha256: digest(
        input.expected_execution_package_sha256,
        "expected execution package SHA",
      ),
      permit_authorization_sha256: digest(
        input.expected_owner_permit_sha256,
        "expected permit SHA",
      ),
      plan_body_sha256: digest(input.expected_plan_body_sha256, "expected plan SHA"),
      frozen_release_id_sha256: digest(
        input.expected_frozen_release_id_sha256,
        "expected frozen release SHA",
      ),
    },
    failed_qualification: {
      qualification_id: text(qualification.qualification_id, "qualification_id", 512),
      qualified_at: qualifiedAt,
      qualification_body_sha256: digest(
        qualification.body_sha256,
        "qualification body SHA",
      ),
      operator_receipt_body_sha256: digest(
        operator.body_sha256,
        "operator receipt body SHA",
      ),
      operator_receipt_file_sha256: sha256(input.operator_receipt_bytes),
      propagation_window_complete: true as const,
      published_and_indexed_preserved: true as const,
      automatic_reapply_allowed: false as const,
    },
    main_evidence: {
      live_main_sha256: liveMainSha,
      target_main_sha256: targetMainSha,
      live_capture_created_at: captureCreatedAt,
      live_capture_intake_index_body_sha256: digest(
        liveCapture.intake_index_body_sha256,
        "live capture intake body SHA",
      ),
      encoded_bytes_exact: false as const,
      equivalent: false as const,
      dhash_distance: integer(equivalence.dhash_distance, "dhash_distance"),
      maximum_dhash_distance: integer(
        equivalence.maximum_dhash_distance,
        "maximum_dhash_distance",
      ),
      psnr_millidb: integer(equivalence.psnr_millidb, "psnr_millidb"),
      minimum_psnr_millidb: integer(
        equivalence.minimum_psnr_millidb,
        "minimum_psnr_millidb",
      ),
    },
    classification: {
      outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN" as const,
      likely_platform_cause:
        "CATALOG_CONTENT_PRIORITY_PROPAGATION_OR_OWNERSHIP" as const,
      cause_proof_level: "LIKELY_NOT_PROVEN" as const,
      same_payload_reapply_allowed: false as const,
      listing_repair_complete: false as const,
    },
    sequence: {
      next_listing_unblocked: true as const,
      quarantined_listing_excluded_from_active_pool: true as const,
      max_apply_in_flight: 1 as const,
    },
    next_action: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN" as const,
    marketplace_write_authorized: false as const,
  };
  const preIdSha = walmartListingIntegrityControlSha256(body);
  const withId = {
    ...body,
    disposition_id: `main-failure-disposition-${preIdSha.slice(0, 24)}`,
  };
  return Object.freeze({
    ...withId,
    body_sha256: walmartListingIntegrityControlSha256(withId),
  });
}

export function verifyWalmartListingIntegrityMainFailureDisposition(
  value: WalmartListingIntegrityMainFailureDisposition,
): void {
  const parsed = record(value, "MAIN failure disposition");
  const body = { ...parsed };
  const claimed = digest(body.body_sha256, "MAIN failure disposition body SHA");
  delete body.body_sha256;
  if (walmartListingIntegrityControlSha256(body) !== claimed
    || value.schema_version !== WALMART_LISTING_INTEGRITY_MAIN_FAILURE_DISPOSITION_SCHEMA
    || value.status !== "QUARANTINED_UNRESOLVED"
    || value.main_evidence.equivalent !== false
    || value.main_evidence.live_main_sha256 === value.main_evidence.target_main_sha256
    || value.failed_qualification.propagation_window_complete !== true
    || value.failed_qualification.published_and_indexed_preserved !== true
    || value.classification.listing_repair_complete !== false
    || value.classification.same_payload_reapply_allowed !== false
    || value.sequence.next_listing_unblocked !== true
    || value.sequence.quarantined_listing_excluded_from_active_pool !== true
    || value.marketplace_write_authorized !== false) {
    fail("SEAL_MISMATCH", "MAIN failure disposition is invalid or not fail-closed");
  }
}
