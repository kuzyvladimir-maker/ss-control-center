import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
  WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
  WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
  assembleWalmartListingRepairOwnerAuthorization,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  type WalmartListingRepairConsumptionLedgerBinding,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairOneSkuPermitSignedBody,
  type WalmartListingRepairSequenceAuthorization,
} from "../listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
  createWalmartListingRepairCustodyApplyEvidenceAdapter,
  type WalmartListingRepairApplyEvidenceReference,
} from "../listing-integrity-remediation-apply-evidence-adapter.ts";
import {
  createWalmartListingRepairArtifactCustody,
  loadWalmartListingRepairSucceededTerminalArtifacts,
  readWalmartListingRepairArtifactCustodyEvidence,
  type WalmartListingRepairArtifactCustody,
} from "../listing-integrity-remediation-artifacts.ts";
import {
  bootstrapWalmartListingRepairConsumptionLedger,
  claimWalmartListingRepairPermit,
  consumeWalmartListingRepairPermit,
  readWalmartListingRepairPermitLedgerEvidence,
  recordWalmartListingRepairPermitAccepted,
  terminalizeWalmartListingRepairPermit,
  type WalmartListingRepairPermitTerminalReceipt,
} from "../listing-integrity-remediation-ledger.ts";
import type {
  WalmartListingSurgicalBaselineReference,
} from "../listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";
import {
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
} from "../listing-integrity-remediation-writer.ts";

const H = (char: string): string => char.repeat(64);
const SELLER = H("a");
const FEED_ID = "feed-adapter-1";

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
  if (encoded === undefined) throw new Error("fixture rejects undefined");
  return encoded;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function seal<T extends Record<string, unknown>>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function planFixture(): {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  sequence: WalmartListingRepairSequenceAuthorization;
} {
  const baselineSurface: WalmartListingSurface = {
    title: "Exact Product Pack of 1",
    description: "Exact product description",
    bullets: ["Exact product"],
    attribute_claims: [],
    unmapped_attributes: [],
  };
  const images = [
    {
      slot: "main" as const,
      source_url: "https://images.example.test/exact-main.jpg",
      sha256: H("1"),
    },
    {
      slot: "gallery-1" as const,
      source_url: "https://images.example.test/exact-gallery.jpg",
      sha256: H("2"),
    },
  ];
  const target = {
    surface: { ...baselineSurface, title: "Exact Product Pack of 6" },
    images,
  };
  const sequenceAuthorizationSha = H("b");
  const body = {
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: "repair-plan-adapter-1",
    created_at: "2026-07-20T12:00:00.000Z",
    expires_at: "2026-07-20T13:00:00.000Z",
    verifier_engine_release_sha256: H("2"),
    apply_engine_release_sha256: H("3"),
    sequence: {
      authorization_sha256: sequenceAuthorizationSha,
      sequence_id: "sequence-adapter-1",
      sequence_epoch: "epoch-adapter-1",
      position: 0,
      population_artifact_sha256: H("4"),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-ADAPTER-1",
      listing_key: "walmart:1:SKU-ADAPTER-1",
      item_id: "123456789",
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      captured_at: "2026-07-20T11:55:00.000Z",
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "baseline-report-adapter-1",
      report_body_sha256: H("5"),
      input_body_sha256: H("6"),
      captured_at: "2026-07-20T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(baselineSurface),
      images_sha256: walmartListingIntegritySha256(images),
      buyer_payload_sha256: H("7"),
      surface_payload_sha256: H("8"),
      source_evidence_inventory_sha256: H("9"),
      live_capture_exchange_sha256: H("d"),
      authenticated_capture_nonce_sha256: H("e"),
    },
    product_truth: {
      expected_sha256: H("1"),
      product_truth_snapshot_id: "truth-snapshot-adapter-1",
      product_truth_snapshot_body_sha256: H("2"),
      product_truth_snapshot_file_sha256: H("3"),
      truth_revision_id: "truth-revision-adapter-1",
      truth_revision_body_sha256: H("4"),
      truth_approval_sha256: H("5"),
    },
    target: {
      ...target,
      target_sha256: walmartListingIntegritySha256(target),
    },
    changed_fields: ["title" as const],
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
  const plan = seal(body) as SealedWalmartListingRepairPlan;
  const identity = {
    channel: "WALMART_US" as const,
    store_index: 1,
    sku: plan.listing.sku,
    listing_key: plan.listing.listing_key,
    item_id: plan.listing.item_id,
  };
  const sequence: WalmartListingRepairSequenceAuthorization = {
    schema_version: WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: "fixture-key",
    owner_public_key_spki_sha256: H("3"),
    signed_body: {
      action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
      environment: "TEST_FIXTURE_ONLY",
      sequence_id: plan.sequence.sequence_id,
      sequence_epoch: plan.sequence.sequence_epoch,
      issued_at: "2026-07-20T11:45:00.000Z",
      expires_at: "2026-07-20T14:00:00.000Z",
      approved_by: "owner-fixture",
      decision_ref: "decision-fixture",
      seller_account_fingerprint_sha256: SELLER,
      population_artifact_sha256: plan.sequence.population_artifact_sha256,
      frozen_verifier_engine_release_sha256: plan.verifier_engine_release_sha256,
      capture_authority_public_key_spki_sha256: H("4"),
      ordered_listings: [identity],
      claims: {
        exact_ordered_population: true,
        source_aware_rebuild_required: true,
        next_sku_requires_rebuilt_pass: true,
        marketplace_writes_authorized: false,
        sequence_is_not_a_write_permit: true,
        mass_apply_allowed: false,
      },
    },
    signature_base64: Buffer.alloc(64).toString("base64"),
    signature_sha256: H("5"),
    authorization_sha256: sequenceAuthorizationSha,
  };
  return { plan, baseline: { surface: baselineSurface, images }, sequence };
}

function permitFixture(input: {
  binding: WalmartListingRepairConsumptionLedgerBinding;
  plan: SealedWalmartListingRepairPlan;
  requestManifest: Uint8Array;
  requestPayload: Uint8Array;
  targetImageCertificate: Uint8Array;
  suffix?: string;
}): WalmartListingRepairOneSkuPermit {
  const suffix = input.suffix ?? "one";
  const body: WalmartListingRepairOneSkuPermitSignedBody = {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: "TEST_FIXTURE_ONLY",
    permit_id: `permit-adapter-${suffix}`,
    issued_at: "2026-07-20T12:06:00.000Z",
    expires_at: "2026-07-20T12:30:00.000Z",
    approved_by: "owner-test",
    decision_ref: `decision-${suffix}`,
    sequence_authorization_sha256: input.plan.sequence.authorization_sha256,
    sequence_id: input.plan.sequence.sequence_id,
    sequence_epoch: input.plan.sequence.sequence_epoch,
    sequence_position: input.plan.sequence.position,
    listing: {
      channel: "WALMART_US",
      store_index: input.plan.listing.store_index,
      sku: input.plan.listing.sku,
      listing_key: input.plan.listing.listing_key,
      item_id: input.plan.listing.item_id,
    },
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    target_sha256: input.plan.target.target_sha256,
    target_image_certificate_sha256: sha256(input.targetImageCertificate),
    baseline_capture_exchange_sha256: input.plan.baseline.live_capture_exchange_sha256,
    product_truth: {
      expected_sha256: input.plan.product_truth.expected_sha256,
      product_truth_snapshot_id: input.plan.product_truth.product_truth_snapshot_id,
      product_truth_snapshot_body_sha256:
        input.plan.product_truth.product_truth_snapshot_body_sha256,
      truth_revision_id: input.plan.product_truth.truth_revision_id,
      truth_revision_body_sha256: input.plan.product_truth.truth_revision_body_sha256,
      truth_approval_sha256: input.plan.product_truth.truth_approval_sha256,
    },
    apply_engine_release_sha256: input.plan.apply_engine_release_sha256,
    request_manifest_sha256: sha256(input.requestManifest),
    request_payload_sha256: sha256(input.requestPayload),
    consumption_ledger: input.binding,
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
  };
  return assembleWalmartListingRepairOwnerAuthorization({
    envelope: walmartListingRepairOneSkuPermitSigningEnvelope({
      key_id: "test-key",
      owner_public_key_spki_sha256: H("c"),
      signed_body: body,
    }),
    signature_base64: Buffer.alloc(64, suffix.charCodeAt(0) % 255).toString("base64"),
  });
}

function httpReceipt(payload: Uint8Array, input: {
  feedId?: string;
  correlation: string;
  capturedAt: string;
}): Buffer {
  return jsonBytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: input.feedId ? "FEED_STATUS_GET" : "MAINTENANCE_POST",
    method: input.feedId ? "GET" : "POST",
    path: input.feedId
      ? `/v3/feeds/${encodeURIComponent(input.feedId)}` : "/v3/feeds",
    query: input.feedId ? { includeDetails: "true" } : { feedType: "MP_MAINTENANCE" },
    feed_id: input.feedId ?? null,
    status: 200,
    content_type: "application/json",
    content_length: payload.byteLength,
    request_correlation_id_sha256: input.correlation,
    captured_at: input.capturedAt,
  });
}

async function treeFingerprint(root: string): Promise<string> {
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return "ABSENT";
  const rows: Array<Record<string, unknown>> = [];
  async function walk(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const target = path.join(directory, name);
      const info = await lstat(target);
      const relative = path.relative(root, target);
      if (info.isDirectory()) {
        rows.push({ relative, kind: "directory", mode: info.mode & 0o777 });
        await walk(target);
      } else {
        const bytes = await readFile(target);
        rows.push({
          relative,
          kind: "file",
          mode: info.mode & 0o777,
          nlink: info.nlink,
          byte_length: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  }
  rows.push({ relative: ".", kind: "directory", mode: rootInfo.mode & 0o777 });
  await walk(root);
  return sha256(canonicalJson(rows));
}

interface Fixture {
  base: string;
  artifactRoot: string;
  ledgerRoot: string;
  binding: WalmartListingRepairConsumptionLedgerBinding;
  permit: WalmartListingRepairOneSkuPermit;
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  sequence: WalmartListingRepairSequenceAuthorization;
  sink: WalmartListingRepairArtifactCustody;
  terminal: WalmartListingRepairPermitTerminalReceipt;
  reference: WalmartListingRepairApplyEvidenceReference;
  feedStatusPayload: Buffer;
}

async function completedFixture(t: TestContext): Promise<Fixture> {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, "wm-apply-adapter-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const artifactRoot = path.join(base, "artifacts");
  const ledgerRoot = path.join(base, "ledger");
  const bootstrapped = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: ledgerRoot,
    now: "2026-07-20T11:40:00.000Z",
  });
  const { plan, baseline, sequence } = planFixture();
  const targetImageCertificate = jsonBytes({ bad: true });
  const requestManifest = jsonBytes({
    prepared_at: "2026-07-20T12:05:00.000Z",
  });
  const requestPayload = jsonBytes({ payload: 1 });
  const permit = permitFixture({
    binding: bootstrapped.binding,
    plan,
    requestManifest,
    requestPayload,
    targetImageCertificate,
  });
  const responsePayload = jsonBytes({ feedId: FEED_ID });
  const responseHttp = httpReceipt(responsePayload, {
    correlation: H("9"),
    capturedAt: "2026-07-20T12:09:00.000Z",
  });
  const feedStatusPayload = jsonBytes({
    feedId: FEED_ID,
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: {
      itemIngestionStatus: [{ sku: plan.listing.sku, ingestionStatus: "SUCCESS" }],
    },
  });
  const feedStatusHttp = httpReceipt(feedStatusPayload, {
    feedId: FEED_ID,
    correlation: H("f"),
    capturedAt: "2026-07-20T12:11:00.000Z",
  });
  const sink = await createWalmartListingRepairArtifactCustody({
    custody_root: artifactRoot,
    permit,
  });
  await sink.persist("PREPARED_REQUEST", {
    "request-manifest.json": requestManifest,
    "request-payload.json": requestPayload,
    "target-image-certificate.json": targetImageCertificate,
    "surgical-schema-contract.json": jsonBytes({ schema_contract: 1 }),
    "surgical-get-spec-receipt.json": jsonBytes({ get_spec_receipt: 1 }),
    "surgical-live-item-receipt.json": jsonBytes({ live_item_receipt: 1 }),
    "surgical-get-spec-request.bin": jsonBytes({ get_spec_request: 1 }),
    "surgical-get-spec-response.bin": jsonBytes({ get_spec_response: 1 }),
    "surgical-live-item-response.bin": jsonBytes({ live_item_response: 1 }),
  });
  await sink.persist("POST_RESPONSE", {
    "response-http.json": responseHttp,
    "response-payload.bin": responsePayload,
    "accepted-feed-id.txt": Buffer.from(FEED_ID, "utf8"),
  });
  const feedStem = sha256(canonicalJson({
    schema_version: "walmart-listing-repair-feed-status-call/v1",
    feed_id: FEED_ID,
    correlation_id_sha256: H("f"),
    request_manifest_sha256: sha256(requestManifest),
    request_payload_sha256: sha256(requestPayload),
  }));
  await sink.persist("FEED_STATUS", {
    [`feed-status-${feedStem}.http.json`]: feedStatusHttp,
    [`feed-status-${feedStem}.payload.bin`]: feedStatusPayload,
  });

  const requesting = await consumeWalmartListingRepairPermit({
    state_directory: ledgerRoot,
    expected_binding: bootstrapped.binding,
    permit_authorization_sha256: permit.authorization_sha256,
    request_manifest_sha256: sha256(requestManifest),
    request_payload_sha256: sha256(requestPayload),
    claimed_at: "2026-07-20T12:07:00.000Z",
    requesting_at: "2026-07-20T12:08:00.000Z",
  });
  const accepted = await recordWalmartListingRepairPermitAccepted({
    state_directory: ledgerRoot,
    expected_binding: bootstrapped.binding,
    requesting,
    accepted_at: "2026-07-20T12:10:00.000Z",
    apply_id: "apply-adapter-1",
    feed_id: FEED_ID,
    response_http_receipt_sha256: sha256(responseHttp),
    response_payload_sha256: sha256(responsePayload),
  });
  const terminal = await terminalizeWalmartListingRepairPermit({
    state_directory: ledgerRoot,
    expected_binding: bootstrapped.binding,
    prior: accepted,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: "2026-07-20T12:11:00.000Z",
      apply_id: accepted.apply_id,
      marketplace_write_calls: 1,
      feed_id: FEED_ID,
      response_http_receipt_sha256: sha256(responseHttp),
      response_payload_sha256: sha256(responsePayload),
      feed_status_http_receipt_sha256: sha256(feedStatusHttp),
      feed_status_payload_sha256: sha256(feedStatusPayload),
      error_code: null,
    },
  });
  const ledger = await readWalmartListingRepairPermitLedgerEvidence({
    state_directory: ledgerRoot,
    expected_binding: bootstrapped.binding,
    permit_authorization_sha256: permit.authorization_sha256,
  });
  const artifacts = await readWalmartListingRepairArtifactCustodyEvidence({
    custody_root: artifactRoot,
    permit,
  });
  assert.equal(ledger.state, "SUCCEEDED");
  const reference: WalmartListingRepairApplyEvidenceReference = {
    schema_version: WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
    permit_authorization_sha256: permit.authorization_sha256,
    ledger_identity_sha256: ledger.identity_sha256,
    ledger_terminal_sha256: ledger.terminal_sha256!,
    ledger_head_sha256: ledger.head_sha256,
    artifact_custody_identity_sha256: artifacts.identity_artifact_sha256,
    artifact_custody_inventory_sha256: artifacts.inventory_sha256,
  };
  return {
    base,
    artifactRoot,
    ledgerRoot,
    binding: bootstrapped.binding,
    permit,
    plan,
    baseline,
    sequence,
    sink,
    terminal,
    reference,
    feedStatusPayload,
  };
}

test("factory accepts only two distinct fixed absolute custody roots", () => {
  assert.throws(
    () => createWalmartListingRepairCustodyApplyEvidenceAdapter({
      custody_root: "relative/artifacts",
      ledger_state_directory: "/tmp/exact-ledger",
    }),
    /exact normalized absolute non-root path/i,
  );
  assert.throws(
    () => createWalmartListingRepairCustodyApplyEvidenceAdapter({
      custody_root: "/tmp/same-custody",
      ledger_state_directory: "/tmp/same-custody",
    }),
    /must be distinct roots/i,
  );
});

test("reference drift is rejected before either missing custody root can be bootstrapped", async (t) => {
  const fx = await completedFixture(t);
  const missingArtifacts = path.join(fx.base, "missing-artifacts");
  const missingLedger = path.join(fx.base, "missing-ledger");
  const adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
    custody_root: missingArtifacts,
    ledger_state_directory: missingLedger,
  });
  await assert.rejects(
    adapter.verify({
      reference: { ...fx.reference, permit_authorization_sha256: H("0") },
      sequence: fx.sequence,
      permit: fx.permit,
      plan: fx.plan,
      baseline: fx.baseline,
    }),
    /belongs to another permit/i,
  );
  assert.equal(await treeFingerprint(missingArtifacts), "ABSENT");
  assert.equal(await treeFingerprint(missingLedger), "ABSENT");
  await assert.rejects(
    loadWalmartListingRepairSucceededTerminalArtifacts({
      custody_root: missingArtifacts,
      permit: fx.permit,
      terminal: fx.terminal,
    }),
  );
  assert.equal(await treeFingerprint(missingArtifacts), "ABSENT");
});

test("current non-SUCCEEDED HEAD is rejected read-only before artifact custody access", async (t) => {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, "wm-apply-adapter-claimed-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const ledgerRoot = path.join(base, "ledger");
  const artifactRoot = path.join(base, "missing-artifacts");
  const bootstrapped = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: ledgerRoot,
    now: "2026-07-20T11:40:00.000Z",
  });
  const { plan, baseline, sequence } = planFixture();
  const permit = permitFixture({
    binding: bootstrapped.binding,
    plan,
    requestManifest: jsonBytes({ manifest: 1 }),
    requestPayload: jsonBytes({ payload: 1 }),
    targetImageCertificate: jsonBytes({ bad: true }),
  });
  const claim = await claimWalmartListingRepairPermit({
    state_directory: ledgerRoot,
    expected_binding: bootstrapped.binding,
    permit_authorization_sha256: permit.authorization_sha256,
    claimed_at: "2026-07-20T12:07:00.000Z",
  });
  const before = await treeFingerprint(ledgerRoot);
  const adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
    custody_root: artifactRoot,
    ledger_state_directory: ledgerRoot,
  });
  await assert.rejects(
    adapter.verify({
      reference: {
        schema_version: WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
        permit_authorization_sha256: permit.authorization_sha256,
        ledger_identity_sha256: bootstrapped.binding.identity_artifact_sha256,
        ledger_terminal_sha256: H("1"),
        ledger_head_sha256: claim.ledger_head_sha256,
        artifact_custody_identity_sha256: H("2"),
        artifact_custody_inventory_sha256: H("3"),
      },
      sequence,
      permit,
      plan,
      baseline,
    }),
    /does not contain one terminal SUCCEEDED result/i,
  );
  assert.equal(await treeFingerprint(ledgerRoot), before);
  assert.equal(await treeFingerprint(artifactRoot), "ABSENT");
});

test("SUCCEEDED custody is loaded by reference and mapped into the real pure verifier with zero writes", async (t) => {
  const fx = await completedFixture(t);
  const beforeLedger = await treeFingerprint(fx.ledgerRoot);
  const beforeArtifacts = await treeFingerprint(fx.artifactRoot);
  const adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
    custody_root: fx.artifactRoot,
    ledger_state_directory: fx.ledgerRoot,
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    "custody_root", "ledger_state_directory", "verify",
  ]);
  assert.deepEqual(Object.keys(fx.reference).sort(), [
    "artifact_custody_identity_sha256",
    "artifact_custody_inventory_sha256",
    "ledger_head_sha256",
    "ledger_identity_sha256",
    "ledger_terminal_sha256",
    "permit_authorization_sha256",
    "schema_version",
  ]);
  await assert.rejects(
    adapter.verify({
      reference: fx.reference,
      sequence: fx.sequence,
      permit: fx.permit,
      plan: fx.plan,
      baseline: fx.baseline,
    }),
    /target image certificate semantic validation failed/i,
  );
  assert.equal(await treeFingerprint(fx.ledgerRoot), beforeLedger);
  assert.equal(await treeFingerprint(fx.artifactRoot), beforeArtifacts);
});

test("stale current-HEAD and artifact-inventory references fail before pure verification", async (t) => {
  await t.test("ledger HEAD drift", async (subtest) => {
    const fx = await completedFixture(subtest);
    const other = permitFixture({
      binding: fx.binding,
      plan: fx.plan,
      requestManifest: jsonBytes({ other_manifest: 1 }),
      requestPayload: jsonBytes({ other_payload: 1 }),
      targetImageCertificate: jsonBytes({ other_certificate: 1 }),
      suffix: "other",
    });
    await claimWalmartListingRepairPermit({
      state_directory: fx.ledgerRoot,
      expected_binding: fx.binding,
      permit_authorization_sha256: other.authorization_sha256,
      claimed_at: "2026-07-20T12:12:00.000Z",
    });
    const before = await treeFingerprint(fx.ledgerRoot);
    const adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
      custody_root: fx.artifactRoot,
      ledger_state_directory: fx.ledgerRoot,
    });
    await assert.rejects(
      adapter.verify({
        reference: fx.reference,
        sequence: fx.sequence,
        permit: fx.permit,
        plan: fx.plan,
        baseline: fx.baseline,
      }),
      /reference differs from the current permit\/ledger\/artifact custody/i,
    );
    assert.equal(await treeFingerprint(fx.ledgerRoot), before);
  });

  await t.test("artifact inventory drift", async (subtest) => {
    const fx = await completedFixture(subtest);
    const extraPayload = jsonBytes({
      feedId: FEED_ID,
      feedStatus: "PROCESSED",
      itemDetails: {
        itemIngestionStatus: [{ sku: fx.plan.listing.sku, ingestionStatus: "SUCCESS" }],
      },
    });
    const correlation = H("8");
    const extraHttp = httpReceipt(extraPayload, {
      feedId: FEED_ID,
      correlation,
      capturedAt: "2026-07-20T12:12:00.000Z",
    });
    const stem = sha256(canonicalJson({
      schema_version: "walmart-listing-repair-feed-status-call/v1",
      feed_id: FEED_ID,
      correlation_id_sha256: correlation,
      request_manifest_sha256: fx.permit.signed_body.request_manifest_sha256,
      request_payload_sha256: fx.permit.signed_body.request_payload_sha256,
    }));
    await fx.sink.persist("FEED_STATUS", {
      [`feed-status-${stem}.http.json`]: extraHttp,
      [`feed-status-${stem}.payload.bin`]: extraPayload,
    });
    const before = await treeFingerprint(fx.artifactRoot);
    const adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
      custody_root: fx.artifactRoot,
      ledger_state_directory: fx.ledgerRoot,
    });
    await assert.rejects(
      adapter.verify({
        reference: fx.reference,
        sequence: fx.sequence,
        permit: fx.permit,
        plan: fx.plan,
        baseline: fx.baseline,
      }),
      /reference differs from the current permit\/ledger\/artifact custody/i,
    );
    assert.equal(await treeFingerprint(fx.artifactRoot), before);
  });
});
