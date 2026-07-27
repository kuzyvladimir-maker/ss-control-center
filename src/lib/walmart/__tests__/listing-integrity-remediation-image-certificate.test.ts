import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
} from "../catalog-visual-audit.ts";
import { VISUAL_PREPROCESS_VERSION } from "../catalog-visual-preprocess.ts";
import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  catalogTruthCanonicalSha256,
} from "../catalog-truth-export.ts";
import {
  PRODUCT_TRUTH_EXACT_VARIANT_IMAGE_OBSERVATION_SCHEMA,
  PRODUCT_TRUTH_IMAGE_RIGHTS_EVIDENCE_SCHEMA,
  WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA,
  certifyWalmartListingRepairTargetImages,
  verifyWalmartListingRepairTargetImageCertificateBytes,
  type ExactImageCertificateArtifact,
  type WalmartListingRepairImageCertificateInput,
} from "../listing-integrity-remediation-image-certificate.ts";
import { walmartListingIntegritySha256 } from "../listing-integrity-audit.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  canonicalWalmartListingObservationJson,
  sealWalmartListingObservationBatch,
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../listing-integrity-observation.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../local-visual-ocr.ts";
import { canonicalWalmartListingSurgicalJson } from "../listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";

const NOW = "2026-07-21T12:00:00.000Z";
const LISTING_KEY = "walmart:1:PF-BREAD-6";
const ITEM_ID = "123456789";
const SKU = "PF-BREAD-6";
const COMPONENT_ID = "PF-15GRAIN-22OZ";
const CANONICAL_VARIANT_ID = "variant-pf-15grain-22oz";
const CONTENT_OBSERVATION_ID = "content-pf-15grain-22oz-v4";
const RUN_LOCK_SHA = "d".repeat(64);
const WORKER_BUILD = `sha256:${"c".repeat(64)}` as const;
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");
const RESERVATION_LEDGER = {
  schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  ledger_id: "ledger-11111111-1111-4111-8111-111111111111" as const,
  ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222" as const,
  state_directory_path_sha256: "3".repeat(64),
  directory_identity_sha256: "4".repeat(64),
  identity_artifact_sha256: "5".repeat(64),
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonArtifact(value: unknown): ExactImageCertificateArtifact {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  return { bytes, sha256: sha256(bytes) };
}

function sealedArtifact(body: Record<string, unknown>): ExactImageCertificateArtifact {
  return jsonArtifact({ ...body, body_sha256: walmartListingIntegritySha256(body) });
}

function truthEvidence(
  sourceRefId: string,
  payloadSha: string,
  supports: string[],
) {
  return {
    source_ref_id: sourceRefId,
    source_kind: "sku_reference_catalog",
    locator: `artifact://${sourceRefId}`,
    captured_at: "2026-07-20T11:00:00.000Z",
    payload_sha256: payloadSha,
    supports,
  };
}

function rightsArtifact(index: number): ExactImageCertificateArtifact {
  return sealedArtifact({
    schema_version: PRODUCT_TRUTH_IMAGE_RIGHTS_EVIDENCE_SCHEMA,
    evidence_id: `rights-${index}`,
    basis: "SOURCE_ALLOWED",
    canonical_variant_id: CANONICAL_VARIANT_ID,
    content_observation_id: CONTENT_OBSERVATION_ID,
    scope: "WALMART_US_LISTING",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-12-31T00:00:00.000Z",
    grantor: "manufacturer-authorized-catalog",
    terms_reference: "https://manufacturer.example.com/image-rights",
  });
}

function imageObservationArtifact(input: {
  index: number;
  sourceRefId: string;
  url: string;
  imageSha: string;
  byteSize: number;
  rights: ExactImageCertificateArtifact;
}): ExactImageCertificateArtifact {
  return sealedArtifact({
    schema_version: PRODUCT_TRUTH_EXACT_VARIANT_IMAGE_OBSERVATION_SCHEMA,
    observation_id: `image-observation-${input.index}`,
    immutable: true,
    source_ref_id: input.sourceRefId,
    component_id: COMPONENT_ID,
    canonical_variant_id: CANONICAL_VARIANT_ID,
    content_observation_id: CONTENT_OBSERVATION_ID,
    captured_at: "2026-07-20T12:00:00.000Z",
    fresh_until: "2026-08-19T12:00:00.000Z",
    image: {
      source_url: input.url,
      final_url: input.url,
      redirect_chain: [],
      sha256: input.imageSha,
      byte_size: input.byteSize,
      content_type: "image/png",
      width: 1_500,
      height: 1_500,
    },
    rights: {
      basis: "SOURCE_ALLOWED",
      evidence_id: `rights-${input.index}`,
      evidence_artifact_sha256: input.rights.sha256,
    },
  });
}

function buildTruthSnapshot(observations: Array<{
  sourceRefId: string;
  artifact: ExactImageCertificateArtifact;
}>) {
  const identity = {
    brand_aliases: ["Pepperidge Farm"],
    product_marker_groups: [["Thin Sliced Bread", "Whole Grain Bread"]],
    variant_marker_groups: [["15 Grain"]],
    forbidden_markers: [{ role: "variant", aliases: ["Oatmeal"] }],
  };
  const packageFacts = [
    { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
  ];
  const imageRefs = observations.map((row) => row.sourceRefId);
  const revisionBody = {
    revision_id: "truth-revision-pf-bread-6-v4",
    listing_kind: "multipack",
    category: "GROCERY",
    recipe: {
      recipe_id: "recipe-pf-bread-6-v4",
      composition: "same_product",
      outer_units: 6,
      components: [{
        component_id: COMPONENT_ID,
        quantity: 6,
        identity,
        package_facts: packageFacts,
        source_ref_ids: ["recipe", ...imageRefs],
      }],
      source_ref_ids: ["recipe"],
    },
    structured_record: {
      outer_units: 6,
      components: [{ component_id: COMPONENT_ID, quantity: 6 }],
      source_ref_ids: ["structured"],
    },
    proposed_truth: {
      outer_units: 6,
      identity,
      package_facts: packageFacts,
      truth_source: "manual_verified",
      source_ref_ids: ["truth"],
    },
    source_evidence: [
      truthEvidence("recipe", "1".repeat(64), ["outer_units", "component_truth"]),
      truthEvidence("structured", "2".repeat(64), ["outer_units", "component_truth"]),
      truthEvidence("truth", "3".repeat(64), ["outer_units", "identity", "package_facts"]),
      ...observations.map((row) => truthEvidence(
        row.sourceRefId,
        row.artifact.sha256,
        ["component_truth"],
      )),
    ],
  };
  const revisionBodySha = catalogTruthCanonicalSha256(revisionBody);
  const approvalBody = {
    decision: "approved",
    revision_body_sha256: revisionBodySha,
    approved_at: "2026-07-20T13:00:00.000Z",
    approved_by: "owner-fixture",
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
  };
  const revision = {
    revision_id: revisionBody.revision_id,
    body_sha256: revisionBodySha,
    approval: {
      ...approvalBody,
      approval_sha256: catalogTruthCanonicalSha256(approvalBody),
    },
    superseded_by_revision_id: null,
    listing_kind: revisionBody.listing_kind,
    category: revisionBody.category,
    recipe: revisionBody.recipe,
    structured_record: revisionBody.structured_record,
    proposed_truth: revisionBody.proposed_truth,
    source_evidence: revisionBody.source_evidence,
  };
  const snapshotBody = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: "2026-07-20T14:00:00.000Z",
    producer: "shared_product_truth_platform",
    rows: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      revision,
    }],
  };
  const snapshotBodySha = catalogTruthCanonicalSha256(snapshotBody);
  const snapshot = {
    ...snapshotBody,
    snapshot_id: `product-truth-${snapshotBodySha.slice(0, 16)}`,
    body_sha256: snapshotBodySha,
  };
  return { artifact: jsonArtifact(snapshot), snapshot, revision };
}

function signedWorkerReceipt(input: {
  callKey: string;
  promptSha: string;
  resultSha: string;
  imageShas: string[];
  executionPermit: { sha256: string; body: Record<string, unknown> };
}) {
  const body = {
    issued_at: "2026-07-21T11:00:01.000Z",
    reservation_reserved_at: "2026-07-21T11:00:00.000Z",
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: RUN_LOCK_SHA,
      shard_id: "shard-images-0001",
      call_index: 0,
      call_key: input.callKey,
      prompt_sha256: input.promptSha,
      execution_permit_sha256: input.executionPermit.sha256,
      partition_id: "partition-images-0001",
      image_sha256: input.imageShas,
    },
    result_canonical_sha256: input.resultSha,
    worker_contract: {
      input_image_count: input.imageShas.length,
      vision_provider: "claude_cli_subscription" as const,
      vision_model: "sonnet" as const,
      vision_reasoning_effort: null,
      cli_version: "2.1.202",
      node_version: "v20.20.1",
      runtime_platform: "linux",
      runtime_arch: "x64",
      worker_build: WORKER_BUILD,
      vision_timeout_ms: 180_000,
      reservation_ledger: structuredClone(RESERVATION_LEDGER),
    },
    subscription_policy: {
      auth_mode: "claude_subscription_oauth" as const,
      paid_api_environment_absent: true as const,
      alternate_cloud_routing_absent: true as const,
    },
  };
  return {
    schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
    key_id: "fixture-worker-key",
    public_key_spki_der_base64: WORKER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: WORKER_PUBLIC_SHA,
    body,
    signature_base64: sign(
      null,
      Buffer.from(canonicalWalmartListingObservationJson(body), "utf8"),
      WORKER_KEYS.privateKey,
    ).toString("base64"),
  };
}

function buildVisionBatch(images: Array<{
  slot: "main" | `gallery-${number}`;
  sha256: string;
}>) {
  const bindings = images.map((image) => ({
    listing_key: LISTING_KEY,
    item_id: ITEM_ID,
    slot: image.slot,
    asset_sha256: image.sha256,
    model_view_sha256: image.sha256,
    image_id: walmartListingObservationImageId(image.sha256, image.slot, LISTING_KEY),
  }));
  const result = {
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: bindings.map((binding) => ({
      image_id: binding.image_id,
      visual_role: (binding.slot === "main"
        ? "tiled_main" : "single_product_front") as "tiled_main" | "single_product_front",
      visible_brand_text: "Pepperidge Farm",
      visible_product_text: "Thin Sliced Bread",
      visible_variant_text: "15 Grain",
      visible_size_texts: ["22 oz"],
      external_package_count: { mode: "exact" as const, value: 6, min: null, max: null },
      outer_package_claims: ["Pack of 6"],
      inner_contents_claims: [],
      case_package_claims: [],
      unclear_quantity_claims: [],
      grid_cell_kind: "single_sellable_package" as const,
      front_visibility: "all" as const,
      background: "white" as const,
      multiple_distinct_products: "no" as const,
      readable_identity: "clear" as const,
      evidence: ["Pepperidge Farm 15 Grain Thin Sliced Bread 22 oz"],
      flags: [],
    })),
  };
  const workerContract = {
    worker_build: WORKER_BUILD,
    model: "sonnet" as const,
    reasoning_effort: null,
    cli_version: "2.1.202",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
    vision_timeout_ms: 180_000,
    reservation_ledger: structuredClone(RESERVATION_LEDGER),
  };
  const permitCore = {
    schema_version: WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
    run_lock_sha256: RUN_LOCK_SHA,
    run_id: "run-images-0001",
    partition_id: "partition-images-0001",
    partition_index: 0,
    shard_ids: ["shard-images-0001"],
    preflight_certificate_sha256: "f".repeat(64),
    created_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-22T10:00:00.000Z",
    owner_authorization: { fixture: "owner-authorization" },
    authorization_binding: { fixture: "authorization-binding" },
    allowance_reservation: { fixture: "allowance-reservation" },
  };
  const permitBody = {
    ...permitCore,
    permit_id: `permit-000000-${walmartListingObservationSha256(permitCore).slice(0, 20)}`,
  };
  const executionPermit = {
    sha256: walmartListingObservationSha256(permitBody),
    body: permitBody,
  };
  const promptSha = walmartListingObservationPromptSha256(bindings.map((row) => row.image_id));
  const callKey = walmartListingObservationCallKey({
    run_lock_sha256: RUN_LOCK_SHA,
    shard_id: "shard-images-0001",
    call_index: 0,
    worker_contract: workerContract,
    prompt_sha256: promptSha,
    image_bindings: bindings,
  });
  const resultSha = walmartListingObservationSha256(result);
  const localOcr = bindings.map((binding) => {
    const ocrOutput = {
      schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
      engine: LOCAL_VISUAL_OCR_ENGINE,
      views: [{
        view_role: "full" as const,
        view_sha256: binding.asset_sha256,
        width: 1_500,
        height: 1_500,
        observations: [],
      }],
    };
    return {
      image_id: binding.image_id,
      asset_sha256: binding.asset_sha256,
      full_view_sha256: binding.asset_sha256,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: "e".repeat(64),
      ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
      ocr_output: ocrOutput,
      truncated: false,
      auxiliary_ocr: { ocr_texts: [] },
    };
  });
  const body = {
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: RUN_LOCK_SHA,
    shard_id: "shard-images-0001",
    call_index: 0,
    call_key: callKey,
    created_at: "2026-07-21T11:00:00.000Z",
    provider: "claude_cli_subscription" as const,
    worker_contract: workerContract,
    worker_receipt: signedWorkerReceipt({
      callKey,
      promptSha,
      resultSha,
      imageShas: images.map((image) => image.sha256),
      executionPermit,
    }),
    execution_permit: executionPermit,
    execution: {
      subscription_calls_consumed: 1 as const,
      transport_attempts: 1 as const,
      retries: 0 as const,
      fallbacks: 0 as const,
      paid_api_calls: 0 as const,
      openai_model_calls: 0 as const,
      input_image_count_attested: true as const,
      worker_contract_attested: true as const,
    },
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: bindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: localOcr,
  };
  return sealWalmartListingObservationBatch(body);
}

async function fixture(): Promise<WalmartListingRepairImageCertificateInput> {
  const pngs = await Promise.all([
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#fffdf8" } })
      .png().toBuffer(),
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#f8fdff" } })
      .png().toBuffer(),
  ]);
  const urls = [
    "https://images.example.com/pf-bread-6-main.png",
    "https://images.example.com/pf-bread-6-gallery-1.png",
  ];
  const rights = [rightsArtifact(0), rightsArtifact(1)];
  const observations = pngs.map((bytes, index) => ({
    sourceRefId: `image-source-${index}`,
    artifact: imageObservationArtifact({
      index,
      sourceRefId: `image-source-${index}`,
      url: urls[index]!,
      imageSha: sha256(bytes),
      byteSize: bytes.byteLength,
      rights: rights[index]!,
    }),
  }));
  const truth = buildTruthSnapshot(observations);
  const targetSurface = {
    title: "Pepperidge Farm 15 Grain Thin Sliced Bread, 22 oz, Pack of 6",
    description: "Six exact 22 oz loaves of Pepperidge Farm 15 Grain Thin Sliced Bread.",
    bullets: ["Pack of 6", "22 oz per loaf"],
    attribute_claims: [
      { field_path: "brand", kind: "brand", text: "Pepperidge Farm" },
      { field_path: "variant", kind: "variant", text: "15 Grain" },
      { field_path: "count", kind: "outer_units", value: 6, unit: "count" },
    ],
    unmapped_attributes: [],
  };
  const targetImages = pngs.map((bytes, index) => ({
    slot: (index === 0 ? "main" : "gallery-1") as "main" | "gallery-1",
    source_url: urls[index]!,
    sha256: sha256(bytes),
  }));
  const target = { surface: targetSurface, images: targetImages };
  const planBody = {
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: "plan-pf-bread-6-v1",
    created_at: "2026-07-21T11:00:00.000Z",
    expires_at: "2026-07-22T11:00:00.000Z",
    verifier_engine_release_sha256: "6".repeat(64),
    apply_engine_release_sha256: "7".repeat(64),
    sequence: {
      authorization_sha256: "8".repeat(64),
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      position: 0,
      population_artifact_sha256: "9".repeat(64),
    },
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      captured_at: "2026-07-21T10:30:00.000Z",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product",
    },
    baseline: {
      report_id: "baseline-1",
      report_body_sha256: "a".repeat(64),
      input_body_sha256: "b".repeat(64),
      captured_at: "2026-07-21T10:30:00.000Z",
      overall_verdict: "BAD",
      surface_sha256: "c".repeat(64),
      images_sha256: "d".repeat(64),
      buyer_payload_sha256: "e".repeat(64),
      surface_payload_sha256: "f".repeat(64),
      source_evidence_inventory_sha256: "1".repeat(64),
      live_capture_exchange_sha256: "2".repeat(64),
      authenticated_capture_nonce_sha256: "3".repeat(64),
    },
    product_truth: {
      expected_sha256: "4".repeat(64),
      product_truth_snapshot_id: truth.snapshot.snapshot_id,
      product_truth_snapshot_body_sha256: truth.snapshot.body_sha256,
      product_truth_snapshot_file_sha256: truth.artifact.sha256,
      truth_revision_id: truth.revision.revision_id,
      truth_revision_body_sha256: truth.revision.body_sha256,
      truth_approval_sha256: truth.revision.approval.approval_sha256,
    },
    target: { ...target, target_sha256: walmartListingIntegritySha256(target) },
    changed_fields: ["main", "gallery"],
    execution_policy: {
      signed_one_sku_permit_required: true,
      durable_permit_consumption_required: true,
      exact_raw_walmart_exchange_required: true,
      exact_listing_count: 1,
      max_marketplace_write_calls: 1,
      fresh_live_reread_required: true,
      async_source_aware_rebuild_required: true,
      cached_qualification_is_authority: false,
      next_sku_requires_rebuilt_pass: true,
      mass_apply_allowed: false,
      automatic_reapply_allowed: false,
      propagation_failure_not_before_ms: 21_600_000,
    },
  };
  const plan = sealedArtifact(planBody);
  const vision = jsonArtifact(buildVisionBatch(targetImages.map((image) => ({
    slot: image.slot,
    sha256: image.sha256,
  }))));
  return {
    now: NOW,
    plan,
    listing_projection: jsonArtifact(targetSurface),
    product_truth_snapshot: truth.artifact,
    worker_trust: {
      run_lock_sha256: RUN_LOCK_SHA,
      key_id: "fixture-worker-key",
      public_key_spki_sha256: WORKER_PUBLIC_SHA,
      worker_build: WORKER_BUILD,
      reservation_ledger: structuredClone(RESERVATION_LEDGER),
    },
    targets: pngs.map((bytes, index) => ({
      slot: targetImages[index]!.slot,
      downloaded_bytes: bytes,
      content_type: "image/png",
      requested_url: urls[index]!,
      final_url: urls[index]!,
      redirect_chain: [],
      downloaded_at: "2026-07-21T11:30:00.000Z",
      fresh_until: "2026-07-22T11:30:00.000Z",
      derivation: "DIRECT_EXACT_ASSET",
      represented_outer_unit_count: 6,
      represented_component_id: COMPONENT_ID,
      represented_canonical_variant_id: CANONICAL_VARIANT_ID,
      represented_content_observation_id: CONTENT_OBSERVATION_ID,
      product_truth_source_ref_id: observations[index]!.sourceRefId,
      exact_variant_image_observation: observations[index]!.artifact,
      rights_evidence: rights[index]!,
      vision_observation_batch: vision,
    })),
  };
}

test("certifies exact MAIN/gallery bytes, Product Truth lineage, rights, and signed worker v2 evidence", async () => {
  const input = await fixture();
  const certificate = await certifyWalmartListingRepairTargetImages(input);
  assert.equal(certificate.schema_version, WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA);
  assert.equal(certificate.targets.length, 2);
  assert.deepEqual(certificate.targets.map((row) => row.slot), ["main", "gallery-1"]);
  assert(certificate.targets.every((row) => row.deterministic_visual_verdict === "PASS"));
  assert(certificate.targets.every((row) => row.vision_worker_build === WORKER_BUILD));
  assert.equal(certificate.product_truth.outer_unit_count, 6);
  assert.equal(certificate.policy.authority, "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY");
  const { certificate_id: certificateId, body_sha256: bodySha, ...body } = certificate;
  assert.equal(certificateId, `walmart-image-certificate-${bodySha.slice(0, 20)}`);
  assert.equal(bodySha, walmartListingIntegritySha256(body));
  const exactBytes = Buffer.from(canonicalWalmartListingSurgicalJson(certificate), "utf8");
  const plan = JSON.parse(
    Buffer.from(input.plan.bytes).toString("utf8"),
  ) as SealedWalmartListingRepairPlan;
  const verified = verifyWalmartListingRepairTargetImageCertificateBytes({
    certificate_bytes: exactBytes,
    plan,
    at: NOW,
  });
  assert.deepEqual(verified, certificate);
});

test("real certifier bytes fail closed on mutation, wrong schema, and wrong plan", async () => {
  const input = await fixture();
  const certificate = await certifyWalmartListingRepairTargetImages(input);
  const plan = JSON.parse(
    Buffer.from(input.plan.bytes).toString("utf8"),
  ) as SealedWalmartListingRepairPlan;
  const canonicalBytes = (value: unknown): Buffer => Buffer.from(
    canonicalWalmartListingSurgicalJson(value),
    "utf8",
  );
  const reseal = (value: Record<string, unknown>): Record<string, unknown> => {
    const body = structuredClone(value);
    delete body.certificate_id;
    delete body.body_sha256;
    const bodySha = walmartListingIntegritySha256(body);
    return {
      ...body,
      certificate_id: `walmart-image-certificate-${bodySha.slice(0, 20)}`,
      body_sha256: bodySha,
    };
  };

  const mutated = structuredClone(certificate) as unknown as Record<string, unknown>;
  (mutated.policy as Record<string, unknown>).authority = "WRITE_AUTHORITY";
  assert.throws(
    () => verifyWalmartListingRepairTargetImageCertificateBytes({
      certificate_bytes: canonicalBytes(mutated),
      plan,
      at: NOW,
    }),
    /body SHA mismatch/u,
  );

  const wrongSchemaBody = structuredClone(certificate) as unknown as Record<string, unknown>;
  wrongSchemaBody.schema_version = "attacker-certificate/v1";
  assert.throws(
    () => verifyWalmartListingRepairTargetImageCertificateBytes({
      certificate_bytes: canonicalBytes(reseal(wrongSchemaBody)),
      plan,
      at: NOW,
    }),
    /schema is unsupported/u,
  );

  const wrongPlanBody = structuredClone(plan) as unknown as Record<string, unknown>;
  wrongPlanBody.plan_id = "attacker-plan";
  delete wrongPlanBody.body_sha256;
  const wrongPlan = {
    ...wrongPlanBody,
    body_sha256: walmartListingIntegritySha256(wrongPlanBody),
  } as unknown as SealedWalmartListingRepairPlan;
  assert.throws(
    () => verifyWalmartListingRepairTargetImageCertificateBytes({
      certificate_bytes: canonicalBytes(certificate),
      plan: wrongPlan,
      at: NOW,
    }),
    /plan\/target binding differs/u,
  );
});

test("fails closed on bytes, URL/redirect, lineage, rights, worker trust, count, order, and freshness drift", async () => {
  const mutations: Array<[string, (input: WalmartListingRepairImageCertificateInput) => void]> = [
    ["downloaded bytes", (input) => { input.targets[0]!.downloaded_bytes = Buffer.from("not-image"); }],
    ["query-bearing URL", (input) => {
      input.targets[0]!.requested_url += "?variant=wrong";
      input.targets[0]!.final_url = input.targets[0]!.requested_url;
    }],
    ["redirect", (input) => { input.targets[0]!.redirect_chain = ["https://redirect.example.com/main.png"]; }],
    ["variant lineage", (input) => { input.targets[0]!.represented_canonical_variant_id = "wrong-variant"; }],
    ["rights bytes", (input) => {
      input.targets[0]!.rights_evidence = jsonArtifact({ forged: true });
    }],
    ["worker build", (input) => { input.worker_trust.worker_build = `sha256:${"0".repeat(64)}`; }],
    ["outer count", (input) => { input.targets[0]!.represented_outer_unit_count = 1; }],
    ["slot order", (input) => { input.targets.reverse(); }],
    ["stale download", (input) => { input.now = "2026-07-23T12:00:00.000Z"; }],
  ];
  for (const [label, mutate] of mutations) {
    const input = await fixture();
    mutate(input);
    await assert.rejects(
      certifyWalmartListingRepairTargetImages(input),
      { message: /Walmart target-image certificate rejected/u },
      label,
    );
  }
});

test("mixed/variety composition is an explicit fail-closed integration gap", async () => {
  const input = await fixture();
  const parsed = JSON.parse(Buffer.from(input.plan.bytes).toString("utf8"));
  parsed.listing.composition = "mixed_bundle";
  delete parsed.body_sha256;
  input.plan = sealedArtifact(parsed);
  await assert.rejects(
    certifyWalmartListingRepairTargetImages(input),
    /mixed bundle\/variety is unsupported without component-aware signed vision facts/u,
  );
});
