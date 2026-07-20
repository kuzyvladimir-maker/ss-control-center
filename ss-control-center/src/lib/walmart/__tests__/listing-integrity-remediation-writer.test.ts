import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { walmartListingIntegritySha256 } from "../listing-integrity-audit.ts";
import {
  executeWalmartListingRepairOneSku,
  executeWalmartListingRepairOneSkuForTest,
  reconcileWalmartListingRepairRequestingNoNetworkForTest,
  resumeWalmartListingRepairFeedPollForTest,
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
  WALMART_LISTING_REPAIR_SURGICAL_REQUEST_MANIFEST_SCHEMA,
  type BuiltWalmartListingRepairSurgicalRequest,
  type WalmartListingRepairAcceptedReceipt,
  type WalmartListingRepairAcceptedPostEvidence,
  type WalmartListingRepairLedgerTerminalOutcome,
  type WalmartListingRepairOneShotTransport,
  type WalmartListingRepairRequestingReceipt,
  type WalmartListingRepairTransportCounts,
  type WalmartListingRepairWriterDependencies,
  type WalmartListingRepairWriterInput,
} from "../listing-integrity-remediation-writer.ts";
import type {
  WalmartListingRepairOneSkuPermit,
  WalmartListingRepairSequenceAuthorization,
} from "../listing-integrity-remediation-authority.ts";
import type { SealedWalmartListingRepairPlan } from "../listing-integrity-remediation-qualification.ts";

Object.assign(process.env, {
  NODE_ENV: "test",
  WALMART_LISTING_REPAIR_TEST_MODE: "1",
});

const H = {
  sequence: "1".repeat(64),
  population: "2".repeat(64),
  verifier: "3".repeat(64),
  capture: "4".repeat(64),
  target: "5".repeat(64),
  baseline: "6".repeat(64),
  truthExpected: "7".repeat(64),
  truthSnapshot: "8".repeat(64),
  truthRevision: "9".repeat(64),
  truthApproval: "a".repeat(64),
  applyRelease: "b".repeat(64),
  seller: "c".repeat(64),
  ledgerPath: "d".repeat(64),
  ledgerDirectory: "e".repeat(64),
  ledgerIdentity: "f".repeat(64),
  permit: "0".repeat(64),
} as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("undefined");
  return encoded;
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

interface FixtureOptions {
  post?: "SUCCESS" | "NETWORK_UNKNOWN" | "OAUTH_FAIL";
  feed?: "SUCCESS" | "PENDING" | "FAILED";
  accountMismatch?: boolean;
  sendClockExpired?: boolean;
  sequenceExpiredDuringAsyncGate?: boolean;
  readyPositionDriftOnFinal?: boolean;
  underreportReturnedGet?: boolean;
  artifactStore?: Map<string, Uint8Array>;
  correlationNamespace?: string;
}

let fixtureOrdinal = 0;

function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const persisted: Array<{ stage: string; names: string[] }> = [];
  const artifactStore = options.artifactStore ?? new Map<string, Uint8Array>();
  const terminal: WalmartListingRepairLedgerTerminalOutcome[] = [];
  let durableAccepted: WalmartListingRepairAcceptedReceipt | null = null;
  let clockIndex = 0;
  const clocks = options.sequenceExpiredDuringAsyncGate
    ? [
        new Date("2026-07-20T12:00:03.000Z"),
        new Date("2026-07-20T12:00:04.000Z"),
        new Date("2026-07-20T13:00:00.000Z"),
        new Date("2026-07-20T13:00:00.001Z"),
      ]
    : options.sendClockExpired
    ? [
        new Date("2026-07-20T12:00:03.000Z"),
        new Date("2026-07-20T12:00:04.000Z"),
        new Date("2026-07-20T12:10:00.000Z"),
        new Date("2026-07-20T12:10:00.001Z"),
      ]
    : [
        new Date("2026-07-20T12:00:03.000Z"),
        new Date("2026-07-20T12:00:04.000Z"),
        new Date("2026-07-20T12:00:05.000Z"),
        new Date("2026-07-20T12:00:06.000Z"),
        new Date("2026-07-20T12:00:07.000Z"),
        new Date("2026-07-20T12:00:08.000Z"),
      ];
  let lastClock = clocks[0]!;
  const now = () => {
    lastClock = clocks[Math.min(clockIndex, clocks.length - 1)]!;
    clockIndex += 1;
    return new Date(lastClock);
  };

  const listing = {
    channel: "WALMART_US" as const,
    store_index: 1,
    sku: "SKU-REPAIR-1",
    listing_key: "WALMART_US:1:SKU-REPAIR-1",
    item_id: "123456789",
  };
  const target = {
    surface: {
      title: "Exact Bread Pack of 6",
      description: "Six exact loaves.",
      bullets: ["Six loaves", "Exact variant"],
      attribute_claims: [{ field_path: "count", value: 6, unit: "Each" }],
      unmapped_attributes: [],
    },
    images: [
      { slot: "main" as const, source_url: "https://img.test/main.jpg", sha256: "1".repeat(64) },
      { slot: "gallery-1" as const, source_url: "https://img.test/second.jpg", sha256: "2".repeat(64) },
    ],
  };
  const planBody = {
    schema_version: "walmart-listing-integrity-repair-plan/v2" as const,
    plan_id: "repair-plan-1",
    created_at: "2026-07-20T12:00:00.000Z",
    expires_at: "2026-07-20T12:20:00.000Z",
    verifier_engine_release_sha256: H.verifier,
    apply_engine_release_sha256: H.applyRelease,
    sequence: {
      authorization_sha256: H.sequence,
      sequence_id: "repair-sequence-1",
      sequence_epoch: "repair-epoch-1",
      position: 0,
      population_artifact_sha256: H.population,
    },
    listing: {
      ...listing,
      captured_at: "2026-07-20T11:59:00.000Z",
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "baseline-report-1",
      report_body_sha256: "3".repeat(64),
      input_body_sha256: "4".repeat(64),
      captured_at: "2026-07-20T11:59:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: "5".repeat(64),
      images_sha256: "6".repeat(64),
      buyer_payload_sha256: "7".repeat(64),
      surface_payload_sha256: "8".repeat(64),
      source_evidence_inventory_sha256: "9".repeat(64),
      live_capture_exchange_sha256: H.baseline,
      authenticated_capture_nonce_sha256: "a".repeat(64),
    },
    product_truth: {
      expected_sha256: H.truthExpected,
      product_truth_snapshot_id: "truth-snapshot-1",
      product_truth_snapshot_body_sha256: H.truthSnapshot,
      product_truth_snapshot_file_sha256: "d".repeat(64),
      truth_revision_id: "truth-revision-1",
      truth_revision_body_sha256: H.truthRevision,
      truth_approval_sha256: H.truthApproval,
    },
    target: {
      ...target,
      target_sha256: walmartListingIntegritySha256(target),
    },
    changed_fields: ["title", "description", "bullets", "attributes", "main", "gallery"] as const,
    execution_policy: {
      signed_one_sku_permit_required: true as const,
      durable_permit_consumption_required: true as const,
      exact_raw_walmart_exchange_required: true as const,
      exact_listing_count: 1 as const,
      max_marketplace_write_calls: 1 as const,
      fresh_live_reread_required: true as const,
      async_source_aware_rebuild_required: true as const,
      cached_qualification_is_authority: false as const,
      next_sku_requires_rebuilt_pass: true as const,
      mass_apply_allowed: false as const,
      automatic_reapply_allowed: false as const,
      propagation_failure_not_before_ms: 21_600_000 as const,
    },
  };
  const plan = {
    ...planBody,
    body_sha256: walmartListingIntegritySha256(planBody),
  } as unknown as SealedWalmartListingRepairPlan;
  const sequence = {
    schema_version: "walmart-listing-repair-sequence-authorization/v1",
    algorithm: "Ed25519",
    key_id: "test-owner",
    owner_public_key_spki_sha256: "1".repeat(64),
    signed_body: {
      action: "WALMART_LISTING_REPAIR_SEQUENCE_SCOPE",
      environment: "TEST_FIXTURE_ONLY",
      sequence_id: "repair-sequence-1",
      sequence_epoch: "repair-epoch-1",
      issued_at: "2026-07-20T11:55:00.000Z",
      expires_at: "2026-07-20T13:00:00.000Z",
      approved_by: "owner",
      decision_ref: "owner://repair-sequence-1",
      seller_account_fingerprint_sha256: H.seller,
      population_artifact_sha256: H.population,
      frozen_verifier_engine_release_sha256: H.verifier,
      capture_authority_public_key_spki_sha256: H.capture,
      ordered_listings: [listing],
      claims: {
        exact_ordered_population: true,
        source_aware_rebuild_required: true,
        next_sku_requires_rebuilt_pass: true,
        marketplace_writes_authorized: false,
        sequence_is_not_a_write_permit: true,
        mass_apply_allowed: false,
      },
    },
    signature_base64: "x",
    signature_sha256: "2".repeat(64),
    authorization_sha256: H.sequence,
  } as WalmartListingRepairSequenceAuthorization;

  const payload = {
    MPItemFeedHeader: {
      businessUnit: "WALMART_US",
      locale: "en",
      version: "5.0.20260501-19_21_29-api",
    },
    MPItem: [{
      Orderable: { sku: listing.sku, productIdentifiers: { productIdType: "UPC", productId: "012345678905" } },
      Visible: { Bread: { productName: target.surface.title } },
    }],
  };
  const payloadBytes = bytes(payload);
  const requestCorrelationId = "repair-correlation-1";
  const manifestBody = {
    schema_version: WALMART_LISTING_REPAIR_SURGICAL_REQUEST_MANIFEST_SCHEMA,
    method: "POST",
    path: "/v3/feeds",
    feed_type: "MP_MAINTENANCE",
    store_index: 1,
    seller_account_fingerprint_sha256: H.seller,
    listing,
    native_identity: {
      product_identifier: { productIdType: "UPC", productId: "012345678905" },
      product_type: "Bread",
      live_item_response_payload_sha256: "1".repeat(64),
      live_item_receipt_body_sha256: "2".repeat(64),
    },
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    target_sha256: plan.target.target_sha256,
    permit_id: "repair-permit-1",
    apply_engine_release_sha256: H.applyRelease,
    schema_contract_body_sha256: "3".repeat(64),
    schema_mapping_approval_sha256: "4".repeat(64),
    get_spec: {
      request_payload_sha256: "5".repeat(64),
      response_payload_sha256: "6".repeat(64),
      schema_sha256: "7".repeat(64),
      receipt_body_sha256: "8".repeat(64),
      version: "5.0.20260501-19_21_29-api",
      product_type: "Bread",
      product_identifier: { productIdType: "UPC", productId: "012345678905" },
    },
    transport: {
      query: { feedType: "MP_MAINTENANCE" },
      multipart: {
        field_name: "file",
        filename: "SKU-REPAIR-1-maintenance.json",
        content_type: "application/json",
      },
      retries: 0,
      redirects: 0,
    },
    changed_fields: [...plan.changed_fields],
    visible_fields: ["productName"],
    full_target_written: false,
    request_correlation_id_sha256: sha256(requestCorrelationId),
    request_payload_sha256: sha256(payloadBytes),
    prepared_at: "2026-07-20T12:00:01.000Z",
  };
  const manifest = { ...manifestBody, body_sha256: walmartListingIntegritySha256(manifestBody) };
  const manifestBytes = bytes(manifest);
  const built: BuiltWalmartListingRepairSurgicalRequest = {
    payload,
    payload_json: new TextDecoder().decode(payloadBytes),
    payload_bytes: payloadBytes,
    payload_sha256: sha256(payloadBytes),
    request_manifest: manifest,
    request_manifest_json: new TextDecoder().decode(manifestBytes),
    request_manifest_bytes: manifestBytes,
    request_manifest_sha256: sha256(manifestBytes),
    filename: "SKU-REPAIR-1-maintenance.json",
    validation: {
      valid: true,
      exact_listing_count: 1,
      feed_type: "MP_MAINTENANCE",
      changed_fields: [...plan.changed_fields],
    },
  };
  const ledgerBinding = {
    policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0" as const,
    ledger_id: "repair-ledger-1",
    ledger_epoch: "repair-ledger-epoch-1",
    state_directory_path_sha256: H.ledgerPath,
    directory_identity_sha256: H.ledgerDirectory,
    identity_artifact_sha256: H.ledgerIdentity,
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1" as const,
    trusted_single_custody_host_only: true as const,
    distributed_at_most_once_claimed: false as const,
  };
  const permit = {
    schema_version: "walmart-listing-repair-one-sku-permit/v1",
    algorithm: "Ed25519",
    key_id: "test-owner",
    owner_public_key_spki_sha256: "1".repeat(64),
    signed_body: {
      action: "WALMART_LISTING_REPAIR_ONE_SKU_APPLY",
      environment: "TEST_FIXTURE_ONLY",
      permit_id: "repair-permit-1",
      issued_at: "2026-07-20T12:00:02.000Z",
      expires_at: "2026-07-20T12:10:00.000Z",
      approved_by: "owner",
      decision_ref: "owner://repair-permit-1",
      sequence_authorization_sha256: H.sequence,
      sequence_id: "repair-sequence-1",
      sequence_epoch: "repair-epoch-1",
      sequence_position: 0,
      listing,
      plan_id: plan.plan_id,
      plan_body_sha256: plan.body_sha256,
      target_sha256: plan.target.target_sha256,
      baseline_capture_exchange_sha256: H.baseline,
      product_truth: {
        expected_sha256: H.truthExpected,
        product_truth_snapshot_id: "truth-snapshot-1",
        product_truth_snapshot_body_sha256: H.truthSnapshot,
        truth_revision_id: "truth-revision-1",
        truth_revision_body_sha256: H.truthRevision,
        truth_approval_sha256: H.truthApproval,
      },
      apply_engine_release_sha256: H.applyRelease,
      request_manifest_sha256: built.request_manifest_sha256,
      request_payload_sha256: built.payload_sha256,
      consumption_ledger: ledgerBinding,
      claims: {
        exact_listing_count: 1,
        marketplace_write_calls: 1,
        retry_allowed: false,
        automatic_reapply_allowed: false,
        mass_apply_allowed: false,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
    signature_base64: "x",
    signature_sha256: "3".repeat(64),
    authorization_sha256: H.permit,
  } as WalmartListingRepairOneSkuPermit;
  const requesting: WalmartListingRepairRequestingReceipt = {
    authorization_sha256: permit.authorization_sha256,
    state: "REQUESTING",
    claim_id: "claim-1",
    claimed_at: "2026-07-20T12:00:04.000Z",
    requesting_at: "2026-07-20T12:00:04.000Z",
    request_manifest_sha256: built.request_manifest_sha256,
    request_payload_sha256: built.payload_sha256,
    consumption_ledger: ledgerBinding,
  };
  const counts: WalmartListingRepairTransportCounts = {
    oauth_token_calls: 0,
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
    total_http_calls: 0,
  };
  const postBody = bytes({ feedId: "feed-repair-1", status: "RECEIVED" });
  const successFeed = bytes({
    feedId: "feed-repair-1",
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: { itemIngestionStatus: [{ sku: listing.sku, ingestionStatus: "SUCCESS" }] },
  });
  const pendingFeed = bytes({
    feedId: "feed-repair-1",
    feedStatus: "INPROGRESS",
    itemDetails: { itemIngestionStatus: [{ sku: listing.sku, ingestionStatus: "INPROGRESS" }] },
  });
  const failedFeed = bytes({
    feedId: "feed-repair-1",
    feedStatus: "ERROR",
    itemsReceived: 1,
    itemsSucceeded: 0,
    itemsFailed: 1,
    itemDetails: { itemIngestionStatus: [{ sku: listing.sku, ingestionStatus: "DATA_ERROR" }] },
  });
  const transport: WalmartListingRepairOneShotTransport = {
    getAccountBinding: () => ({
      channel: "WALMART_US",
      store_index: 1,
      seller_id: "seller-1",
      seller_account_fingerprint_sha256: options.accountMismatch ? "f".repeat(64) : H.seller,
    }),
    getCallCounts: () => ({ ...counts }),
    postMaintenance: async (request) => {
      events.push("POST");
      assert.equal(request.redirect, "error");
      assert.equal(request.retries, 0);
      if (options.post === "OAUTH_FAIL") {
        counts.oauth_token_calls += 1;
        counts.total_http_calls += 1;
        throw new Error("token failed");
      }
      counts.oauth_token_calls += 1;
      counts.maintenance_post_calls += 1;
      counts.total_http_calls += 2;
      if (options.post === "NETWORK_UNKNOWN") throw new Error("socket reset");
      return { status: 200, headers: { "content-type": "application/json" }, body: postBody };
    },
    getFeedStatus: async (request) => {
      events.push("GET");
      assert.equal(request.feed_id, "feed-repair-1");
      assert.equal(request.path, "/v3/feeds/feed-repair-1");
      assert.equal(request.redirect, "error");
      assert.equal(request.retries, 0);
      if (!options.underreportReturnedGet) {
        counts.feed_status_get_calls += 1;
        counts.total_http_calls += 1;
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: options.feed === "PENDING" ? pendingFeed
          : options.feed === "FAILED" ? failedFeed : successFeed,
      };
    },
  };
  let readyCalls = 0;
  const correlationNamespace = options.correlationNamespace ?? `fixture-${++fixtureOrdinal}`;
  const dependencies: WalmartListingRepairWriterDependencies = {
    payload_builder: { build: async () => built },
    exact_request_verifier: {
      verifyExactBytes: (input) => {
        events.push("VERIFY_EXACT_REQUEST");
        assert.equal(sha256(input.request_payload_bytes), built.payload_sha256);
        assert.equal(sha256(input.request_manifest_bytes), built.request_manifest_sha256);
      },
    },
    ledger: {
      consume: async () => {
        events.push("REQUESTING");
        return requesting;
      },
      loadRequesting: async () => {
        events.push("LOAD_REQUESTING");
        return requesting;
      },
      recordAccepted: async ({ accepted_at, apply_id, feed_id, response_http_receipt_sha256, response_payload_sha256 }) => {
        events.push("ACCEPTED");
        durableAccepted = {
          ...requesting,
          state: "ACCEPTED",
          accepted_at,
          apply_id,
          feed_id,
          response_http_receipt_sha256,
          response_payload_sha256,
          exact_listing_count: 1,
          marketplace_write_calls: 1,
        };
        return durableAccepted;
      },
      loadAccepted: async () => {
        events.push("LOAD_ACCEPTED");
        if (!durableAccepted) throw new Error("accepted missing");
        return durableAccepted;
      },
      terminalize: async ({ outcome }) => {
        events.push(`TERMINAL:${outcome.state}`);
        terminal.push(outcome);
      },
    },
    artifact_sink: {
      persist: async (stage, artifacts) => {
        events.push(`PERSIST:${stage}`);
        persisted.push({ stage, names: Object.keys(artifacts) });
        for (const name of Object.keys(artifacts)) {
          if (artifactStore.has(name)) throw new Error(`immutable artifact overwrite: ${name}`);
        }
        for (const [name, value] of Object.entries(artifacts)) {
          artifactStore.set(name, Uint8Array.from(value));
        }
      },
      loadAccepted: async () => ({
        request_manifest_bytes: artifactStore.get("request-manifest.json")!,
        request_payload_bytes: artifactStore.get("request-payload.json")!,
        response_http_receipt_bytes: artifactStore.get("response-http.json")!,
        response_payload_bytes: artifactStore.get("response-payload.bin")!,
      }),
    },
    rebuild_sequence_ready_proof: async () => {
      readyCalls += 1;
      events.push(`READY:${readyCalls}`);
      return {
        sequence_authorization_sha256: sequence.authorization_sha256,
        sequence_id: sequence.signed_body.sequence_id,
        sequence_epoch: sequence.signed_body.sequence_epoch,
        verifier_engine_release_sha256: H.verifier,
        status: "READY_FOR_ONE_SKU_PLAN",
        next_listing_key: listing.listing_key,
        next_sequence_position: options.readyPositionDriftOnFinal && readyCalls > 1 ? 1 : 0,
        marketplace_write_authorized: false,
        separate_signed_one_sku_permit_required: true,
      };
    },
    read_current_product_truth: async () => ({ ...permit.signed_body.product_truth }),
    open_transport: () => {
      events.push("OPEN_TRANSPORT");
      return transport;
    },
    now,
    wait: async () => undefined,
    random_id: () => `${correlationNamespace}-poll-${counts.feed_status_get_calls + 1}`,
  };
  const writerInput: WalmartListingRepairWriterInput = {
    sequence_authorization: sequence,
    one_sku_permit: permit,
    plan,
    payload_context: {},
    request_correlation_id: requestCorrelationId,
    poll_policy: { max_attempts: 2, delay_ms: 0 },
  };
  const runtime = {
    verifySequence: (_value: unknown, at: Date) => {
      assert.ok(at.getTime() >= Date.parse(sequence.signed_body.issued_at));
      assert.ok(at.getTime() < Date.parse(sequence.signed_body.expires_at));
      return sequence;
    },
    verifyCurrentPermit: (_value: unknown, at: Date) => {
      if (at.getTime() < Date.parse(permit.signed_body.issued_at)
        || at.getTime() >= Date.parse(permit.signed_body.expires_at)) {
        throw new Error("permit not current");
      }
      return permit;
    },
    expected_apply_engine_release_sha256: H.applyRelease,
  };
  return {
    events,
    persisted,
    terminal,
    plan,
    permit,
    sequence,
    built,
    requesting,
    artifactStore,
    dependencies,
    writerInput,
    runtime,
    postBody,
    installAccepted: (accepted: WalmartListingRepairAcceptedPostEvidence) => {
      durableAccepted = accepted.accepted;
      for (const [name, value] of [
        ["request-manifest.json", accepted.request_manifest_bytes],
        ["request-payload.json", accepted.request_payload_bytes],
        ["response-http.json", accepted.response_http_receipt_bytes],
        ["response-payload.bin", accepted.response_payload_bytes],
      ] as const) {
        const existing = artifactStore.get(name);
        if (existing) assert.ok(Buffer.from(existing).equals(Buffer.from(value)));
        else artifactStore.set(name, Uint8Array.from(value));
      }
    },
  };
}

test("writer reaches REQUESTING before transport/OAuth, posts once, and qualifies exact feed success", async () => {
  const f = fixture();
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.marketplace_write_calls, 1);
  assert.equal(result.feed_id, "feed-repair-1");
  assert.equal(result.next_action, "QUALIFY_WITH_FRESH_LIVE_REREAD");
  assert.equal(result.transport_counts?.maintenance_post_calls, 1);
  assert.equal(result.transport_counts?.feed_status_get_calls, 1);
  assert.ok(f.events.indexOf("REQUESTING") < f.events.indexOf("OPEN_TRANSPORT"));
  assert.ok(f.events.indexOf("OPEN_TRANSPORT") < f.events.indexOf("POST"));
  assert.ok(f.events.indexOf("PERSIST:POST_RESPONSE") < f.events.indexOf("ACCEPTED"));
  assert.ok(f.events.indexOf("ACCEPTED") < f.events.indexOf("GET"));
  assert.equal(f.events.filter((row) => row === "POST").length, 1);
  assert.deepEqual(f.terminal.map((row) => row.state), ["SUCCEEDED"]);
  assert.ok(result.exact_evidence.response_payload_bytes);
  assert.ok(result.exact_evidence.feed_status_payload_bytes);
});

test("unknown POST transport outcome is AMBIGUOUS and is never retried", async () => {
  const f = fixture({ post: "NETWORK_UNKNOWN" });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "AMBIGUOUS_POST");
  assert.equal(result.next_action, "MANUAL_POST_RECONCILIATION_NO_RETRY");
  assert.equal(f.events.filter((row) => row === "POST").length, 1);
  assert.equal(f.events.filter((row) => row === "GET").length, 0);
  assert.deepEqual(f.terminal.map((row) => row.state), ["AMBIGUOUS"]);
});

test("OAuth failure before POST is terminal FAILED with zero marketplace writes", async () => {
  const f = fixture({ post: "OAUTH_FAIL" });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.marketplace_write_calls, 0);
  assert.equal(result.reason_code, "OAUTH_FAILED_BEFORE_POST");
  assert.equal(f.terminal[0]?.marketplace_write_calls, 0);
});

test("accepted feed with bounded nonterminal polls becomes GET-only continuation, never ambiguous", async () => {
  const f = fixture({ feed: "PENDING" });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "APPLIED_PROPAGATING");
  assert.equal(result.next_action, "RESUME_EXACT_FEED_GET_ONLY");
  assert.equal(result.continuation?.feed_id, "feed-repair-1");
  assert.equal(f.events.filter((row) => row === "POST").length, 1);
  assert.equal(f.events.filter((row) => row === "GET").length, 2);
  assert.equal(f.terminal.length, 0);
});

test("GET-only continuation loads durable ACCEPTED custody and cannot call POST", async () => {
  const first = fixture({ feed: "PENDING" });
  const pending = await executeWalmartListingRepairOneSkuForTest(
    first.writerInput,
    first.dependencies,
    first.runtime,
  );
  assert.ok(pending.continuation);

  const beforeResumeNames = new Set(
    [...first.artifactStore.keys()].filter((name) => name.startsWith("feed-status-")),
  );
  const resumed = fixture({
    feed: "SUCCESS",
    artifactStore: first.artifactStore,
    correlationNamespace: "resume-process",
  });
  const accepted = pending.continuation as WalmartListingRepairAcceptedPostEvidence;
  // Simulate a fresh process loading the same immutable ledger/artifact custody.
  resumed.installAccepted(accepted);
  const result = await resumeWalmartListingRepairFeedPollForTest({
    writer_input: resumed.writerInput,
  }, resumed.dependencies, resumed.runtime);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(resumed.events.filter((row) => row === "POST").length, 0);
  assert.equal(resumed.events.filter((row) => row === "GET").length, 1);
  assert.ok(resumed.events.includes("LOAD_ACCEPTED"));
  const afterResumeNames = [...resumed.artifactStore.keys()]
    .filter((name) => name.startsWith("feed-status-"));
  assert.equal(afterResumeNames.length, beforeResumeNames.size + 2);
  assert.equal(new Set(afterResumeNames).size, afterResumeNames.length);
});

test("account drift fails after REQUESTING and before OAuth/POST", async () => {
  const f = fixture({ accountMismatch: true });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason_code, "ACCOUNT_BINDING_MISMATCH");
  assert.equal(f.events.filter((row) => row === "POST").length, 0);
  assert.deepEqual(f.terminal.map((row) => row.state), ["FAILED"]);
});

test("permit expiry is rechecked after REQUESTING and immediately before send", async () => {
  const f = fixture({ sendClockExpired: true });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.marketplace_write_calls, 0);
  assert.equal(f.events.filter((row) => row === "POST").length, 0);
  assert.ok(f.events.includes("REQUESTING"));
});

test("sequence expiry during async final gates blocks POST after REQUESTING", async () => {
  const f = fixture({ sequenceExpiredDuringAsyncGate: true });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.marketplace_write_calls, 0);
  assert.equal(f.events.filter((row) => row.startsWith("READY:")).length, 2);
  assert.equal(f.events.filter((row) => row === "POST").length, 0);
});

test("fresh readiness position drift after burn blocks POST", async () => {
  const f = fixture({ readyPositionDriftOnFinal: true });
  const result = await executeWalmartListingRepairOneSkuForTest(
    f.writerInput,
    f.dependencies,
    f.runtime,
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason_code, "SEQUENCE_NOT_READY");
  assert.equal(f.events.filter((row) => row === "POST").length, 0);
});

test("returned feed response must account for exactly one GET", async () => {
  const f = fixture({ underreportReturnedGet: true });
  await assert.rejects(
    executeWalmartListingRepairOneSkuForTest(f.writerInput, f.dependencies, f.runtime),
    /exactly one GET/i,
  );
  assert.equal(f.events.filter((row) => row === "POST").length, 1);
  assert.equal(f.events.filter((row) => row === "GET").length, 1);
  assert.equal(f.terminal.length, 0);
});

test("stranded REQUESTING recovery is no-network manual review and never replays", async () => {
  const f = fixture();
  const result = await reconcileWalmartListingRepairRequestingNoNetworkForTest({
    writer_input: f.writerInput,
  }, { ledger: f.dependencies.ledger }, f.runtime);
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(result.marketplace_write_calls, "UNKNOWN_0_OR_1");
  assert.equal(result.next_action, "MANUAL_POST_RECONCILIATION_NO_RETRY");
  assert.equal(result.automatic_reapply_allowed, false);
  assert.ok(f.events.includes("LOAD_REQUESTING"));
  assert.equal(f.events.filter((row) => row === "OPEN_TRANSPORT").length, 0);
  assert.equal(f.events.filter((row) => row === "POST").length, 0);
  assert.equal(f.events.filter((row) => row === "GET").length, 0);
});

test("production entrypoint is explicit NO-GO until the frozen closure is pinned", async () => {
  const f = fixture();
  await assert.rejects(
    executeWalmartListingRepairOneSku(f.writerInput, f.dependencies),
    /production writer is NO-GO/i,
  );
  assert.equal(f.events.length, 0);
});

test("HTTP receipt fixture is exact raw-byte JSON, not a caller outcome boolean", () => {
  const receipt = bytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    status: 200,
    content_type: "application/json",
    content_length: 2,
    request_correlation_id_sha256: "1".repeat(64),
    captured_at: "2026-07-20T12:00:00.000Z",
  });
  assert.equal(JSON.parse(new TextDecoder().decode(receipt)).status, 200);
});
