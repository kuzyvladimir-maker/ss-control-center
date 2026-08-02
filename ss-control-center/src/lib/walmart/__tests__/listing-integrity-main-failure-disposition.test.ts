import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  walmartListingIntegrityControlSha256,
} from "../listing-integrity-control-plane";
import {
  buildWalmartListingIntegrityMainFailureDisposition,
  verifyWalmartListingIntegrityMainFailureDisposition,
} from "../listing-integrity-main-failure-disposition";
import {
  parseWalmartListingIntegrityQuarantinedCase,
} from "../listing-integrity-operations";

const H = (value: string | Uint8Array) => (
  createHash("sha256").update(value).digest("hex")
);

function seal<T extends Record<string, unknown>>(body: T) {
  return { ...body, body_sha256: walmartListingIntegrityControlSha256(body) };
}

function receipt(overrides: { qualifiedAt?: string; main?: string } = {}) {
  const qualifiedAt = overrides.qualifiedAt ?? "2026-08-01T23:12:26.000Z";
  const listing = {
    channel: "WALMART_US",
    store_index: 1,
    sku: "FaisalX-1144",
    listing_key: "walmart:1:FaisalX-1144",
    item_id: "8394316918",
  };
  const qualification = seal({
    schema_version: "walmart-listing-integrity-repair-live-qualification/v2",
    qualification_id: "live-qualification-main-final",
    qualified_at: qualifiedAt,
    verdict: "FAIL",
    listing,
    plan_id: "plan-main",
    plan_body_sha256: H("plan"),
    permit_authorization_sha256: H("permit"),
    feed_id: "feed-main",
    feed_terminal_at: "2026-08-01T17:12:25.210Z",
    apply_custody: {
      request_payload_sha256: H("payload"),
      terminal_feed_status_payload_sha256: H("feed-status"),
    },
    facets: {
      attributes: "PASS",
      bullets: "PASS",
      description: "PASS",
      exact_listing_identity: "PASS",
      exact_repair_target: "FAIL",
      fresh_authenticated_live_reread: "PASS",
      gallery: "PASS",
      main: overrides.main ?? "FAIL",
      pack_count: "PASS",
      product_and_variant: "PASS",
      published_and_indexed: "PASS",
      terminal_apply_custody: "PASS",
      title: "PASS",
      unchanged_fields_preserved: "FAIL",
    },
    main_equivalence: {
      live_sha256: H("old-main"),
      target_sha256: H("target-main"),
      encoded_bytes_exact: false,
      equivalent: false,
      dhash_distance: 28,
      maximum_dhash_distance: 2,
      psnr_millidb: 0,
      minimum_psnr_millidb: 38000,
    },
    live_capture: {
      created_at: qualifiedAt,
      intake_index_body_sha256: H("intake"),
      image_sha256: [H("old-main"), H("gallery")],
    },
    propagation: {
      failure_not_before: "2026-08-01T23:12:25.210Z",
      reread_before_failure_window: false,
      recheck_same_sku_without_write: false,
    },
    next_sku_unblocked: false,
    next_action: "OWNER_REVIEW_REPLAN",
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
  });
  const value = seal({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "qualify",
    status: "FAIL",
    execution_package_artifact_sha256: H("package"),
    permit_authorization_sha256: H("permit"),
    listing,
    qualification,
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
    external_effects: {
      network_calls: "BOUNDED_LIVE_REREAD",
      model_calls: 0,
      paid_provider_calls: 0,
      database_writes: 0,
      walmart_content_writes: 0,
    },
  });
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

test("seals an exact post-SLA MAIN failure without granting replay", () => {
  const result = buildWalmartListingIntegrityMainFailureDisposition({
    operator_receipt_bytes: receipt(),
    expected_listing: {
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      store_index: 1,
    },
    expected_execution_package_sha256: H("package"),
    expected_owner_permit_sha256: H("permit"),
    expected_plan_body_sha256: H("plan"),
    expected_frozen_release_id_sha256: H("release"),
    created_at: "2026-08-01T23:12:27.000Z",
  });
  assert.equal(result.status, "QUARANTINED_UNRESOLVED");
  assert.equal(result.main_evidence.live_main_sha256, H("old-main"));
  assert.equal(result.main_evidence.target_main_sha256, H("target-main"));
  assert.equal(result.failed_qualification.propagation_window_complete, true);
  assert.equal(result.sequence.next_listing_unblocked, true);
  assert.equal(result.classification.same_payload_reapply_allowed, false);
  assert.doesNotThrow(() => verifyWalmartListingIntegrityMainFailureDisposition(result));
  const parsed = parseWalmartListingIntegrityQuarantinedCase({
    disposition: result,
    dispositionFileSha256: H("disposition-file"),
    dispositionPath: "/immutable/quarantine/FaisalX-1144/failure-disposition.json",
  });
  assert.equal(parsed.outcome, "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN");
  assert.equal(parsed.listingKey, "walmart:1:FaisalX-1144");
});

test("rejects a pre-SLA or non-MAIN terminal disposition", () => {
  const common = {
    expected_listing: {
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      store_index: 1,
    },
    expected_execution_package_sha256: H("package"),
    expected_owner_permit_sha256: H("permit"),
    expected_plan_body_sha256: H("plan"),
    expected_frozen_release_id_sha256: H("release"),
    created_at: "2026-08-01T23:12:27.000Z",
  };
  assert.throws(
    () => buildWalmartListingIntegrityMainFailureDisposition({
      ...common,
      operator_receipt_bytes: receipt({
        qualifiedAt: "2026-08-01T23:12:24.000Z",
      }),
    }),
    /FAILURE_WINDOW_OPEN/,
  );
  assert.throws(
    () => buildWalmartListingIntegrityMainFailureDisposition({
      ...common,
      operator_receipt_bytes: receipt({ main: "PASS" }),
    }),
    /FAILURE_NOT_CLASSIFIABLE/,
  );
});

test("rejects tampered disposition bytes", () => {
  const result = buildWalmartListingIntegrityMainFailureDisposition({
    operator_receipt_bytes: receipt(),
    expected_listing: {
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      store_index: 1,
    },
    expected_execution_package_sha256: H("package"),
    expected_owner_permit_sha256: H("permit"),
    expected_plan_body_sha256: H("plan"),
    expected_frozen_release_id_sha256: H("release"),
    created_at: "2026-08-01T23:12:27.000Z",
  });
  const tampered = structuredClone(result);
  tampered.main_evidence.live_main_sha256 = H("different-main");
  assert.throws(
    () => verifyWalmartListingIntegrityMainFailureDisposition(tampered),
    /SEAL_MISMATCH/,
  );
});
