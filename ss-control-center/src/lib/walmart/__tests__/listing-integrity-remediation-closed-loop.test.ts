import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { test, type TestContext } from "node:test";

import sharp from "sharp";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
} from "../catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../catalog-visual-preprocess.ts";
import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
} from "../catalog-truth-export.ts";
import { fingerprintGalleryImage } from "../catalog-gallery-audit.ts";
import { resolveExactBuyerPdp } from "../buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../exact-item-resolution.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../local-visual-ocr.ts";
import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
  compileWalmartListingIntegrityReport,
  compileWalmartListingIntegrityReportAgainstSources,
  projectWalmartListingSurfaceFromBuyerPdp,
  sealWalmartListingSurfaceSnapshot,
  verifyWalmartListingIntegrityReportAgainstSources,
  walmartListingIntegrityImageId,
  walmartListingIntegritySha256,
  type SealedWalmartListingIntegrityReport,
  type WalmartListingIntegrityInput,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import {
  WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
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
  type WalmartListingExecutionPermit,
} from "../listing-integrity-observation.ts";
import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
  assembleWalmartListingRepairOwnerAuthorization,
  verifyCurrentWalmartListingRepairOneSkuPermitForTest,
  verifyWalmartListingRepairSequenceAuthorizationForTest,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  walmartListingRepairOwnerSigningMessage,
  walmartListingRepairSequenceSigningEnvelope,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairOneSkuPermitSignedBody,
  type WalmartListingRepairOwnerAuthorization,
  type WalmartListingRepairOwnerSigningEnvelope,
  type WalmartListingRepairSequenceAuthorization,
  type WalmartListingRepairSequenceSignedBody,
} from "../listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
  createWalmartListingRepairCustodyApplyEvidenceAdapter,
  type WalmartListingRepairApplyEvidenceReference,
  type WalmartListingRepairCustodyApplyEvidenceAdapter,
} from "../listing-integrity-remediation-apply-evidence-adapter.ts";
import {
  createWalmartListingRepairArtifactCustody,
  readWalmartListingRepairArtifactCustodyEvidence,
} from "../listing-integrity-remediation-artifacts.ts";
import {
  type WalmartListingRepairExactSourceBundle,
} from "../listing-integrity-remediation-evidence.ts";
import {
  PRODUCT_TRUTH_EXACT_VARIANT_IMAGE_OBSERVATION_SCHEMA,
  PRODUCT_TRUTH_IMAGE_RIGHTS_EVIDENCE_SCHEMA,
  certifyWalmartListingRepairTargetImages,
  verifyWalmartListingRepairTargetImageCertificateBytes,
  type ExactImageCertificateArtifact,
} from "../listing-integrity-remediation-image-certificate.ts";
import {
  bootstrapWalmartListingRepairConsumptionLedger,
  readWalmartListingRepairPermitLedgerEvidence,
} from "../listing-integrity-remediation-ledger.ts";
import {
  createWalmartListingRepairLedgerAdapter,
} from "../listing-integrity-remediation-ledger-adapter.ts";
import {
  parseWalmartListingRepairExecutionPackageBytes,
  renderWalmartListingRepairExecutionPackage,
  sealWalmartListingRepairExecutionPackage,
} from "../listing-integrity-remediation-execution-package.ts";
import {
  createWalmartListingRepairProductionDependencies,
} from "../listing-integrity-remediation-production-dependencies.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
  buildWalmartListingSurgicalRequest,
  canonicalWalmartListingSurgicalJson,
  verifyWalmartListingSurgicalRequestBytes,
  walmartListingSurgicalSha256,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
  type WalmartListingSurgicalSchemaContract,
} from "../listing-integrity-remediation-payload.ts";
import {
  buildWalmartListingRepairPlanForTest,
  evaluateWalmartListingRepairSequenceForTest,
  walmartListingRepairTestRuntime,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairQualificationEvidencePackage,
  type WalmartListingRepairSequenceGateResult,
} from "../listing-integrity-remediation-qualification.ts";
import {
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
  executeWalmartListingRepairOneSkuForTest,
  type WalmartListingRepairOneShotTransport,
  type WalmartListingRepairTransportCounts,
  type WalmartListingRepairWriterDependencies,
} from "../listing-integrity-remediation-writer.ts";
import {
  WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
  WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
  WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
  assembleWalmartListingIntegrityOwnerExecutionAuthorization,
  buildWalmartListingIntegrityAllowanceReservation,
  buildWalmartListingIntegrityExecutionPermitBody,
  buildWalmartListingIntegrityOwnerExecutionAuthorizationBody,
  buildWalmartListingIntegrityPreflightCertificate,
  buildWalmartListingIntegritySourceFreshness,
  parseRunLock,
  parseWalmartListingIntegrityExecutionPermit,
  parseWalmartListingIntegrityPreflightCertificate,
  walmartListingIntegrityObserverPartitionId,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
} from "../../../../scripts/walmart-listing-integrity-engine.mjs";
import {
  parseWalmartListingRepairOperatorArgs,
  runWalmartListingRepairOperator,
} from "../../../../scripts/walmart-listing-repair-operator.ts";

Object.assign(process.env, {
  NODE_ENV: "test",
  WALMART_LISTING_REPAIR_TEST_MODE: "1",
});

const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({ format: "der", type: "spki" });
const OWNER_PUBLIC_SHA = createHash("sha256").update(OWNER_PUBLIC_DER).digest("hex");
const OWNER_KEY_ID = "closed-loop-owner-key";
process.env.WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID = OWNER_KEY_ID;
process.env.WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64 =
  OWNER_PUBLIC_DER.toString("base64");
const TEST_ENV = { ...process.env };

const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");

const RELEASE_SHA = "6".repeat(64);
const APPLY_SHA = "7".repeat(64);
const CAPTURE_FINGERPRINT = OWNER_PUBLIC_SHA;
const SELLER_FINGERPRINT = "9".repeat(64);
const RUN_LOCK_SHA = "d".repeat(64);
const WORKER_BUILD = `sha256:${"c".repeat(64)}` as const;
const SPEC_VERSION = WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION;
const PRODUCT_TYPE = "Food And Beverage";
const SKU = "PF-BREAD-6";
const LISTING_KEY = "walmart:1:PF-BREAD-6";
const ITEM_ID = "123456789";
const COMPONENT_ID = "PF-15GRAIN-22OZ";
const CANONICAL_VARIANT_ID = "variant-pf-15grain-22oz";
const CONTENT_OBSERVATION_ID = "content-pf-15grain-22oz-v4";
const FEED_ID = "feed-closed-loop-1";

const BASE_CAPTURED_AT = "2026-07-21T11:30:00.000Z";
const PLAN_CREATED_AT = "2026-07-21T11:40:00.000Z";
const IMAGE_CERTIFIED_AT = "2026-07-21T12:00:00.000Z";
const PAYLOAD_PREPARED_AT = "2026-07-21T12:01:00.000Z";
const PERMIT_ISSUED_AT = "2026-07-21T12:02:00.000Z";
const POST_CAPTURED_AT = "2026-07-21T12:20:00.000Z";
const RECHECK_CAPTURED_AT = "2026-07-21T12:30:00.000Z";
const QUALIFIED_AT = "2026-07-21T12:35:00.000Z";

const LISTING_ONE = Object.freeze({
  channel: "WALMART_US" as const,
  store_index: 1,
  sku: SKU,
  listing_key: LISTING_KEY,
  item_id: ITEM_ID,
});
const LISTING_TWO = Object.freeze({
  channel: "WALMART_US" as const,
  store_index: 1,
  sku: "NEXT-SKU",
  listing_key: "walmart:1:NEXT-SKU",
  item_id: "987654321",
});
const RESERVATION_LEDGER = {
  schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  ledger_id: "ledger-11111111-1111-4111-8111-111111111111" as const,
  ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222" as const,
  state_directory_path_sha256: "3".repeat(64),
  directory_identity_sha256: "4".repeat(64),
  identity_artifact_sha256: "5".repeat(64),
};

type NetworkPrimitive =
  | "fetch"
  | "http.request"
  | "http.get"
  | "https.request"
  | "https.get"
  | "net.connect"
  | "net.createConnection"
  | "tls.connect";

interface NetworkTripwire {
  readonly counts: Readonly<Record<NetworkPrimitive, number>>;
  total(): number;
}

function installNetworkTripwire(t: TestContext): NetworkTripwire {
  const counts: Record<NetworkPrimitive, number> = {
    fetch: 0,
    "http.request": 0,
    "http.get": 0,
    "https.request": 0,
    "https.get": 0,
    "net.connect": 0,
    "net.createConnection": 0,
    "tls.connect": 0,
  };
  const blocked = (name: NetworkPrimitive): never => {
    counts[name] += 1;
    throw new Error(`network tripwire blocked ${name}`);
  };
  const patches: Array<{
    owner: Record<string, unknown>;
    key: string;
    descriptor: PropertyDescriptor;
  }> = [];
  const replace = (
    ownerValue: unknown,
    key: string,
    name: NetworkPrimitive,
  ) => {
    const owner = ownerValue as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    assert(descriptor, `${name} must have an own property descriptor`);
    patches.push({ owner, key, descriptor });
    Object.defineProperty(owner, key, {
      ...descriptor,
      value: () => blocked(name),
    });
  };
  replace(http, "request", "http.request");
  replace(http, "get", "http.get");
  replace(https, "request", "https.request");
  replace(https, "get", "https.get");
  replace(net, "connect", "net.connect");
  replace(net, "createConnection", "net.createConnection");
  replace(tls, "connect", "tls.connect");

  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  assert(fetchDescriptor, "globalThis.fetch must have an own property descriptor");
  Object.defineProperty(globalThis, "fetch", {
    ...fetchDescriptor,
    value: () => blocked("fetch"),
  });
  t.after(() => {
    Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    for (const patch of patches.reverse()) {
      Object.defineProperty(patch.owner, patch.key, patch.descriptor);
    }
  });
  return {
    counts,
    total: () => Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}

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

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function ordinaryBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function jsonArtifact(value: unknown): ExactImageCertificateArtifact {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  return { bytes, sha256: sha256(bytes) };
}

function sealedArtifact(body: Record<string, unknown>): ExactImageCertificateArtifact {
  return jsonArtifact({ ...body, body_sha256: walmartListingIntegritySha256(body) });
}

function signEnvelope<TBody>(
  envelope: WalmartListingRepairOwnerSigningEnvelope<TBody>,
): WalmartListingRepairOwnerAuthorization<TBody> {
  return assembleWalmartListingRepairOwnerAuthorization({
    envelope,
    signature_base64: sign(
      null,
      walmartListingRepairOwnerSigningMessage(envelope),
      OWNER_KEYS.privateKey,
    ).toString("base64"),
  });
}

function expectedTruth(): WalmartListingIntegrityInput["expected"] {
  return {
    title: "Pepperidge Farm 15 Grain Thin Sliced Bread, 22 oz, Pack of 6",
    outer_units: 6,
    identity: {
      brand_aliases: ["Pepperidge Farm"],
      product_marker_groups: [["Thin Sliced Bread", "Bread"]],
      variant_marker_groups: [["15 Grain"]],
      forbidden_markers: [{ role: "variant", aliases: ["Oatmeal"] }],
    },
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
    truth_source: "manual_verified",
  };
}

function targetSurface(): WalmartListingSurface {
  return {
    title: expectedTruth().title,
    description:
      "Pepperidge Farm 15 Grain Thin Sliced Bread, Pack of 6; each loaf is 22 oz.",
    bullets: [
      "Pepperidge Farm 15 Grain Thin Sliced Bread, Pack of 6",
      "Made for sandwiches and toast",
    ],
    attribute_claims: [
      { field_path: "product.brand", kind: "brand", text: "Pepperidge Farm" },
      {
        field_path: "product.multipack_quantity",
        kind: "outer_units",
        value: 6,
        unit: "count",
      },
      { field_path: "product.net_content", kind: "net_content", value: 22, unit: "oz" },
      { field_path: "product.product_type", kind: "product", text: "Thin Sliced Bread" },
      { field_path: "product.variant", kind: "variant", text: "15 Grain" },
    ],
    unmapped_attributes: [],
  };
}

function baselineSurface(): WalmartListingSurface {
  const target = targetSurface();
  return {
    ...target,
    attribute_claims: target.attribute_claims.map((claim) => (
      claim.kind === "outer_units" ? { ...claim, value: 1 } : claim
    )),
  };
}

function truthEvidence(sourceRefId: string, payloadSha: string, supports: string[]) {
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
  const expected = expectedTruth();
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
        identity: expected.identity,
        package_facts: expected.package_facts,
        source_ref_ids: ["recipe", ...observations.map((row) => row.sourceRefId)],
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
      identity: expected.identity,
      package_facts: expected.package_facts,
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
  const body = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: "2026-07-20T14:00:00.000Z",
    producer: "shared_product_truth_platform",
    rows: [{
      ...LISTING_ONE,
      revision,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  const snapshot = {
    ...body,
    snapshot_id: `product-truth-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
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
    issued_at: "2026-07-21T11:59:01.000Z",
    reservation_reserved_at: "2026-07-21T11:59:00.000Z",
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
      evidence: ["Pepperidge Farm 15 Grain Thin Sliced Bread 22 oz Pack of 6"],
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
    created_at: "2026-07-21T11:00:00.000Z",
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
  return sealWalmartListingObservationBatch({
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: RUN_LOCK_SHA,
    shard_id: "shard-images-0001",
    call_index: 0,
    call_key: callKey,
    created_at: "2026-07-21T11:59:00.000Z",
    provider: "claude_cli_subscription",
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
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      input_image_count_attested: true,
      worker_contract_attested: true,
    },
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: bindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: bindings.map((binding) => {
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
    }),
  });
}

function sequenceAuthorization(): WalmartListingRepairSequenceAuthorization {
  const signedBody: WalmartListingRepairSequenceSignedBody = {
    action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
    environment: "TEST_FIXTURE_ONLY",
    sequence_id: "closed-loop-sequence-1",
    sequence_epoch: "closed-loop-epoch-1",
    issued_at: "2026-07-21T11:00:00.000Z",
    expires_at: "2026-07-22T10:00:00.000Z",
    approved_by: "owner-test-fixture",
    decision_ref: "test://owner/closed-loop-sequence",
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    population_artifact_sha256: walmartListingIntegritySha256([LISTING_ONE, LISTING_TWO]),
    frozen_verifier_engine_release_sha256: RELEASE_SHA,
    capture_authority_public_key_spki_sha256: CAPTURE_FINGERPRINT,
    ordered_listings: [LISTING_ONE, LISTING_TWO],
    claims: {
      exact_ordered_population: true,
      source_aware_rebuild_required: true,
      next_sku_requires_rebuilt_pass: true,
      marketplace_writes_authorized: false,
      sequence_is_not_a_write_permit: true,
      mass_apply_allowed: false,
    },
  };
  return signEnvelope(walmartListingRepairSequenceSigningEnvelope({
    key_id: OWNER_KEY_ID,
    owner_public_key_spki_sha256: OWNER_PUBLIC_SHA,
    signed_body: signedBody,
  }));
}

function imageObservation(input: {
  slot: "main" | "gallery-1";
  assetSha: string;
  good: boolean;
}) {
  return {
    image_id: walmartListingIntegrityImageId(input.assetSha, input.slot, LISTING_KEY),
    visual_role: input.slot === "main" ? "tiled_main" as const : "single_product_front" as const,
    visible_brand_text: "Pepperidge Farm",
    visible_product_text: input.good ? "Thin Sliced Bread" : "Bread",
    visible_variant_text: input.good ? "15 Grain" : "Oatmeal",
    visible_size_texts: ["22 oz"],
    external_package_count: {
      mode: "exact" as const,
      value: input.good ? 6 : 1,
      min: null,
      max: null,
    },
    outer_package_claims: [input.good ? "Pack of 6" : "Pack of 1"],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package" as const,
    front_visibility: "all" as const,
    background: "white" as const,
    multiple_distinct_products: "no" as const,
    readable_identity: "clear" as const,
    evidence: [input.good ? "Pepperidge Farm 15 Grain Bread Pack of 6" : "Oatmeal Pack of 1"],
    flags: [],
  };
}

function buyerPayload(surface: WalmartListingSurface, urls: readonly string[]) {
  const outer = surface.attribute_claims.find((claim) => claim.kind === "outer_units")!;
  return {
    product: {
      item_id: ITEM_ID,
      title: surface.title,
      main_image: urls[0],
      images: [...urls],
      description: surface.description,
      feature_bullets: surface.bullets,
      brand: "Pepperidge Farm",
      product_type: "Thin Sliced Bread",
      variant: "15 Grain",
      multipack_quantity: outer.value,
      net_content: { value: 22, unit: "oz" },
    },
  };
}

function sealBuyerSnapshot(input: {
  capturedAt: string;
  assets: Array<Record<string, unknown>>;
  raw: ReturnType<typeof rawBuyerSources>;
}) {
  const resolution = resolveExactWalmartItemCandidate(
    SKU,
    input.raw.seller_item_payload,
    input.raw.catalog_search_payload,
  );
  const buyer = resolveExactBuyerPdp(
    input.raw.buyer_pdp_payload,
    { sku: SKU, item_id: ITEM_ID },
  );
  const body = {
    schema_version: "walmart-buyer-facing-snapshot/v3",
    captured_at: input.capturedAt,
    target: { sku: SKU, item_id: ITEM_ID },
    identity: {
      exact_sku_match: true,
      exact_item_id_match: true,
      buyer_facing_verified: true,
      seller: resolution.seller,
      catalog_search_candidate: resolution.catalog_search_candidate,
      buyer: {
        item_id: buyer.item_id,
        title: buyer.title,
        identity_evidence: buyer.identity_evidence,
      },
      chain_evidence: {
        seller_to_catalog: resolution.identity_evidence,
        catalog_to_buyer_pdp: buyer.identity_evidence,
      },
    },
    source_contract: {
      seller: "walmart_marketplace_exact_sku_get",
      candidate: "walmart_catalog_search_exact_upc",
      buyer: "walmart_buyer_pdp_exact_item_get",
      positional_or_fuzzy_fallbacks: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
    },
    payload_hashes: {
      seller_payload_canonical_sha256:
        walmartListingIntegritySha256(input.raw.seller_item_payload),
      catalog_search_payload_canonical_sha256:
        walmartListingIntegritySha256(input.raw.catalog_search_payload),
      resolution_canonical_sha256: walmartListingIntegritySha256(resolution),
      buyer_payload_canonical_sha256:
        walmartListingIntegritySha256(input.raw.buyer_pdp_payload),
    },
    assets: input.assets,
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  const safeStamp = input.capturedAt.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return {
    ...body,
    snapshot_id: `walmart-buyer-${safeStamp}-${bodySha.slice(0, 12)}`,
    body_sha256: bodySha,
  };
}

function sealBuyerIndex(capturedAt: string, snapshot: ReturnType<typeof sealBuyerSnapshot>) {
  const body = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: capturedAt,
    entries: [{
      ...LISTING_ONE,
      snapshot,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    index_id: `walmart-buyer-index-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function rawBuyerSources(surface: WalmartListingSurface, urls: readonly string[]) {
  return {
    seller_item_payload: {
      ItemResponse: [{
        sku: SKU,
        productName: surface.title,
        upc: "012345678905",
        gtin: "00012345678905",
        wpid: "PF-BREAD-WPID",
        publishedStatus: "PUBLISHED",
        lifecycleStatus: "ACTIVE",
      }],
    },
    catalog_search_payload: {
      items: [{
        standardUpc: ["012345678905"],
        itemId: ITEM_ID,
        title: surface.title,
        images: [{ url: urls[0] }],
        isMarketPlaceItem: true,
      }],
    },
    buyer_pdp_payload: buyerPayload(surface, urls),
  };
}

function ownerExecutionAuthority() {
  return {
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: OWNER_KEY_ID,
    public_key_spki_der_base64: OWNER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: OWNER_PUBLIC_SHA,
  };
}

function adjudicatorConstraints() {
  return {
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    coverage: "exactly_once",
    output_write_policy: "immutable_wx_reports_only",
    observations: "precomputed_source_verified_only",
  };
}

function observerExecutionConstraints() {
  return {
    network_target: "locked_worker_only",
    worker_health_calls_per_execute: 1,
    subscription_calls_total: 1,
    calls_per_shard: 1,
    max_calls_per_execute: 6,
    transport_attempts_per_shard: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    local_ocr_required: true,
    execution_order: "partition_contiguous_prefix",
    ambiguous_attempt_policy: "offline_terminalize_technical_error_no_retry_then_resume",
    output_write_policy: "immutable_wx_attempt_and_observation_only",
  };
}

function fileRef(filePath: string, bytes: Uint8Array) {
  return { path: filePath, sha256: sha256(bytes) };
}

function signedCaptureOwnerAuthorization(input: {
  runLock: ReturnType<typeof parseRunLock>;
  runLockSha: string;
  preflightSha: string;
  issuedAt: string;
}) {
  const signedBody = buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
    run_lock: input.runLock,
    run_lock_sha256: input.runLockSha,
    preflight_certificate_sha256: input.preflightSha,
    approval_id: `closed-loop-capture-${input.runLock.run_id}`,
    partition_ids: input.runLock.observer_partitions.map((row) => row.partition_id),
    issued_at: input.issuedAt,
    expires_at: input.runLock.hard_source_freshness.hard_deadline,
    source_freshness_deadline: input.runLock.hard_source_freshness.hard_deadline,
  });
  const envelope = {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: OWNER_KEY_ID,
    owner_public_key_spki_sha256: OWNER_PUBLIC_SHA,
    signed_body: signedBody,
  };
  return assembleWalmartListingIntegrityOwnerExecutionAuthorization({
    owner_execution_authority: ownerExecutionAuthority(),
    signed_body: signedBody,
    signature_base64: sign(
      null,
      walmartListingIntegrityOwnerAuthorizationSigningMessage(envelope),
      OWNER_KEYS.privateKey,
    ).toString("base64"),
    expected: {
      run_lock: input.runLock,
      run_lock_sha256: input.runLockSha,
      run_id: input.runLock.run_id,
      preflight_certificate_sha256: input.preflightSha,
      now: new Date(input.issuedAt),
    },
  });
}

function signedSourceWorkerReceipt(input: {
  runLockSha: string;
  callKey: string;
  promptSha: string;
  resultSha: string;
  imageShas: string[];
  executionPermit: WalmartListingExecutionPermit;
  reservedAt: string;
  issuedAt: string;
}) {
  const body = {
    issued_at: input.issuedAt,
    reservation_reserved_at: input.reservedAt,
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: input.runLockSha,
      shard_id: "shard-000000",
      call_index: 0,
      call_key: input.callKey,
      prompt_sha256: input.promptSha,
      execution_permit_sha256: input.executionPermit.sha256,
      partition_id: input.executionPermit.body.partition_id,
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

interface BuiltSourceCapture {
  bundle: WalmartListingRepairExactSourceBundle;
  input: WalmartListingIntegrityInput;
  report: SealedWalmartListingIntegrityReport;
  diagnostic: SealedWalmartListingIntegrityReport;
}

async function makeSource(input: {
  truth: ReturnType<typeof buildTruthSnapshot>;
  kind: string;
  capturedAt: string;
  runLockCreatedAt: string;
  nonce: string;
  surface: WalmartListingSurface;
  assets: ReadonlyMap<string, Uint8Array>;
  urls: readonly string[];
  goodImages: boolean;
}): Promise<BuiltSourceCapture> {
  const raw = rawBuyerSources(input.surface, input.urls);
  const imageSlots = ["main", "gallery-1"] as const;
  const assetDetails = await Promise.all(imageSlots.map(async (slot, index) => {
    const exactBytes = input.assets.get(slot)!;
    const fingerprint = await fingerprintGalleryImage("gallery-1", exactBytes);
    const preprocessed = await preprocessCatalogVisual(Buffer.from(exactBytes));
    const full = preprocessed.views.find((view) => view.role === "full")!;
    return {
      slot: slot as "main" | "gallery-1",
      ordinal: index,
      bytes: exactBytes,
      fingerprint,
      full,
      source_url: input.urls[index]!,
      image_id: walmartListingIntegrityImageId(fingerprint.sha256, slot, LISTING_KEY),
    };
  }));
  const buyerAssets = assetDetails.map((row, index) => ({
    slot: index === 0 ? "MAIN" : `GALLERY_${index}`,
    source_url: row.source_url,
    final_url: row.source_url,
    sha256: row.fingerprint.sha256,
    bytes: row.bytes.byteLength,
    media_type: "image/png",
    extension: "png",
    decoded_format: "png",
    decoded_width: row.fingerprint.width,
    decoded_height: row.fingerprint.height,
    local_path: `assets/${row.fingerprint.sha256}.png`,
  }));
  const buyerSnapshot = sealBuyerSnapshot({
    capturedAt: input.capturedAt,
    assets: buyerAssets,
    raw,
  });
  const buyerIndex = sealBuyerIndex(input.capturedAt, buyerSnapshot);
  const catalogExport = compileWalmartCatalogTruthExport(input.truth.snapshot, buyerIndex);
  const auditCase = catalogExport.cases[0]!;
  const preflightExpected = auditCase.preflight?.expected;
  assert(preflightExpected, "closed-loop fixture must be Product Truth auditable");
  const projectedSurface = projectWalmartListingSurfaceFromBuyerPdp(
    raw.buyer_pdp_payload,
    { sku: SKU, item_id: ITEM_ID },
  );
  assert.deepEqual(projectedSurface, input.surface);
  const surfaceSnapshot = sealWalmartListingSurfaceSnapshot({
    schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
    captured_at: input.capturedAt,
    listing: {
      ...LISTING_ONE,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
    },
    buyer_source: {
      contract: "walmart_buyer_pdp_exact_item_get",
      buyer_snapshot_id: buyerSnapshot.snapshot_id,
      buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
      buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
      exact_item_id_echo: true,
      complete_attribute_inventory: true,
    },
    surface: projectedSurface,
  });
  const listingInput: WalmartListingIntegrityInput = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      ...LISTING_ONE,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: input.capturedAt,
      composition: "same_product",
    },
    source_bindings: {
      product_truth_snapshot_id: input.truth.snapshot.snapshot_id,
      product_truth_snapshot_body_sha256: input.truth.snapshot.body_sha256,
      catalog_truth_export_id: catalogExport.export_id,
      catalog_truth_export_body_sha256: catalogExport.body_sha256,
      catalog_truth_case_id: auditCase.case_id,
      catalog_truth_preflight_sha256: auditCase.preflight_sha256!,
      truth_revision_id: auditCase.truth_revision.revision_id,
      truth_revision_body_sha256: auditCase.truth_revision.body_sha256,
      truth_approval_sha256: auditCase.truth_revision.approval_sha256!,
      buyer_index_id: buyerIndex.index_id,
      buyer_index_body_sha256: buyerIndex.body_sha256,
      buyer_snapshot_id: buyerSnapshot.snapshot_id,
      buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
      buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
      surface_snapshot_id: surfaceSnapshot.snapshot_id,
      surface_snapshot_body_sha256: surfaceSnapshot.body_sha256,
      surface_payload_sha256: surfaceSnapshot.buyer_source.buyer_payload_sha256,
    },
    expected: structuredClone(preflightExpected),
    surface: structuredClone(input.surface),
    images: {
      assets: assetDetails.map((row) => ({
        slot: row.slot,
        source_url: row.source_url,
        sha256: row.fingerprint.sha256,
        byte_length: row.bytes.byteLength,
        decoded_width: row.fingerprint.width,
        decoded_height: row.fingerprint.height,
        dhash64: row.fingerprint.dhash64,
        buyer_facing_verified: true,
        surface: "buyer_pdp",
      })),
      evidence: assetDetails.map((row) => ({
        slot: row.slot,
        asset_sha256: row.fingerprint.sha256,
        state: "observed" as const,
        observation: imageObservation({
          slot: row.slot,
          assetSha: row.fingerprint.sha256,
          good: input.goodImages,
        }),
        auxiliary_ocr: { ocr_texts: [] },
        local_ocr_truncated: false,
      })),
      duplicate_summary: null,
    },
  };
  const diagnostic = compileWalmartListingIntegrityReport(listingInput);

  const codeManifest = { bundle_id: `sha256:${RELEASE_SHA}` };
  const codeManifestBytes = ordinaryBytes(codeManifest);
  const truthBytes = input.truth.artifact.bytes;
  const buyerIndexBytes = ordinaryBytes(buyerIndex);
  const catalogExportBytes = ordinaryBytes(catalogExport);
  const buyerSnapshotBytes = ordinaryBytes(buyerSnapshot);
  const sellerBytes = ordinaryBytes(raw.seller_item_payload);
  const catalogBytes = ordinaryBytes(raw.catalog_search_payload);
  const buyerBytes = ordinaryBytes(raw.buyer_pdp_payload);
  const surfaceBytes = ordinaryBytes(surfaceSnapshot);
  const inputBytes = ordinaryBytes(listingInput);
  const dummy = ordinaryBytes({ exact_test_fixture: input.nonce });
  const partitionId = walmartListingIntegrityObserverPartitionId(0, ["shard-000000"]);
  const imageBindings = assetDetails.map((row) => ({
    listing_key: LISTING_KEY,
    item_id: ITEM_ID,
    slot: row.slot,
    asset_sha256: row.fingerprint.sha256,
    model_view_sha256: row.full.sha256,
    image_id: row.image_id,
  }));
  const rawRunLock = {
    schema_version: WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
    run_id: `run-${input.nonce}`,
    created_at: input.runLockCreatedAt,
    purpose: "walmart_listing_integrity_frozen_family",
    engine_contract: {
      executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
      listing_engine_version: WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
      input_schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
      report_schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
      base_input_mode: WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
      source_aware_required: true,
      observation_artifacts_required: true,
    },
    observer_contract: {
      provider: "claude_cli_subscription",
      model: "sonnet",
      observer_version: WALMART_LISTING_OBSERVER_VERSION,
      observation_schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
      prompt_version: BLIND_PROMPT_VERSION,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      local_ocr_script_sha256: "e".repeat(64),
      worker_build_sha256: "c".repeat(64),
      worker_receipt_key_id: "fixture-worker-key",
      worker_receipt_public_key_sha256: WORKER_PUBLIC_SHA,
      worker_analyze_url: "https://worker.example.test/codex-image/analyze-claude",
      vision_timeout_ms: 180_000,
      observer_response_margin_ms: 30_000,
      swift_executable_sha256: "1".repeat(64),
      xcrun_executable_sha256: "2".repeat(64),
      swift_version_output_sha256: "3".repeat(64),
      macos_sdk_path_sha256: "4".repeat(64),
      macos_sdk_version: "26.5",
      cli_version: "2.1.202",
      node_version: "v20.20.1",
      platform: "linux",
      arch: "x64",
      health_attestation_required: true,
      response_attestation_required: true,
      attempt_count: 1,
      fallback_allowed: false,
      max_images_per_call: 6,
      reservation_ledger: structuredClone(RESERVATION_LEDGER),
    },
    owner_execution_authority: ownerExecutionAuthority(),
    hard_source_freshness: buildWalmartListingIntegritySourceFreshness({
      authoritative_scope_captured_at: input.capturedAt,
      product_truth_snapshot_captured_at: input.truth.snapshot.captured_at,
      buyer_index_captured_at: input.capturedAt,
      locked_buyer_snapshot_captured_ats: [input.capturedAt],
    }),
    code_bundle_manifest: fileRef("control/code-bundle.json", codeManifestBytes),
    source_artifacts: {
      authoritative_published_scope: fileRef("control/authoritative-scope.json", dummy),
      authoritative_item_report_source: fileRef("control/item-report.json", dummy),
      authoritative_item_report_capture: Object.fromEntries([
        "create_request_manifest", "create_response_payload",
        "ready_status_request_manifest", "ready_status_payload",
        "download_locator_request_manifest", "download_locator_response_payload",
        "report_file_request_manifest", "downloaded_body",
        "http_create_response", "http_ready_status_response",
        "http_download_locator_response", "http_download_response", "trusted_context",
      ].map((key) => [key, fileRef(`control/${key}.json`, dummy)])),
      product_truth_snapshot: fileRef("sources/product-truth.json", truthBytes),
      buyer_snapshot_index: fileRef("sources/buyer-index.json", buyerIndexBytes),
      catalog_truth_export: fileRef("sources/catalog-truth.json", catalogExportBytes),
    },
    shards: [{
      shard_id: "shard-000000",
      call_index: 0,
      observation_batch_path: "observations/call-000000.json",
      prompt_sha256: walmartListingObservationPromptSha256(
        imageBindings.map((row) => row.image_id),
      ),
      images: imageBindings,
    }],
    listings: [{
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      base_input: fileRef("listing/input.json", inputBytes),
      surface_snapshot: fileRef("listing/surface.json", surfaceBytes),
      buyer_snapshot_manifest: fileRef("listing/buyer-snapshot.json", buyerSnapshotBytes),
      seller_item_payload: fileRef("listing/seller.json", sellerBytes),
      catalog_search_payload: fileRef("listing/catalog.json", catalogBytes),
      buyer_pdp_payload: fileRef("listing/buyer.json", buyerBytes),
      assets: assetDetails.map((row) => ({
        slot: row.slot,
        buyer_asset: fileRef(`assets/${row.slot}.png`, row.bytes),
        model_view: fileRef(`views/${row.slot}.png`, row.full.bytes),
        image_id: row.image_id,
      })),
      shard_ids: ["shard-000000"],
    }],
    observer_partitions: [{
      partition_id: partitionId,
      partition_index: 0,
      shard_ids: ["shard-000000"],
    }],
    adjudicator_constraints: adjudicatorConstraints(),
    observer_execution_constraints: observerExecutionConstraints(),
  };
  const runLockBytes = ordinaryBytes(rawRunLock);
  const runLockSha = sha256(runLockBytes);
  const runLock = parseRunLock(rawRunLock);
  const preflight = buildWalmartListingIntegrityPreflightCertificate({
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    code_bundle_manifest: codeManifest,
    code_bundle_manifest_sha256: sha256(codeManifestBytes),
    listings: [{ ref: runLock.listings[0] }],
  }, {
    population: {
      scope_snapshot_id: `scope-${input.nonce}`,
      scope_body_sha256: sha256(dummy),
      scope_captured_at: input.capturedAt,
      authoritative_published_count: 1,
      auditable_count: 1,
      truth_review_count: 0,
      unsupported_count: 0,
      exact_population_reconciliation: true,
    },
    listings_verified: 1,
  });
  const preflightBytes = ordinaryBytes(preflight);
  const parsedPreflight = parseWalmartListingIntegrityPreflightCertificate(preflight);
  assert.equal(parsedPreflight.body.run_lock_sha256, runLockSha);
  assert.equal(parsedPreflight.body.run_id, runLock.run_id);
  const permitCreatedAt = new Date(Date.parse(input.runLockCreatedAt) + 1_000).toISOString();
  const ownerAuthorization = signedCaptureOwnerAuthorization({
    runLock,
    runLockSha,
    preflightSha: sha256(preflightBytes),
    issuedAt: permitCreatedAt,
  });
  const reservation = buildWalmartListingIntegrityAllowanceReservation({
    owner_authorization: ownerAuthorization,
    sequence: 0,
    previous_reservation_sha256: ownerAuthorization.authorization_sha256,
    reserved_at: permitCreatedAt,
  });
  const executionBody = buildWalmartListingIntegrityExecutionPermitBody({
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    run_id: runLock.run_id,
    partition: runLock.observer_partitions[0],
    preflight_certificate_sha256: sha256(preflightBytes),
    created_at: permitCreatedAt,
    owner_authorization: ownerAuthorization,
    allowance_reservation: reservation,
  });
  const executionPermit = parseWalmartListingIntegrityExecutionPermit({
    sha256: walmartListingObservationSha256(executionBody),
    body: executionBody,
  }, {
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    run_id: runLock.run_id,
    partition: runLock.observer_partitions[0],
    preflight_certificate_sha256: sha256(preflightBytes),
    family_created_at: runLock.created_at,
  }) as WalmartListingExecutionPermit;
  const result = {
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: listingInput.images.evidence.map((row) => (
      row.state === "observed" ? structuredClone(row.observation) : assert.fail("observed fixture")
    )),
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
  const callKey = walmartListingObservationCallKey({
    run_lock_sha256: runLockSha,
    shard_id: "shard-000000",
    call_index: 0,
    worker_contract: workerContract,
    prompt_sha256: runLock.shards[0]!.prompt_sha256,
    image_bindings: imageBindings,
  });
  const resultSha = walmartListingObservationSha256(result);
  const reservedAt = new Date(Date.parse(permitCreatedAt) + 100).toISOString();
  const issuedAt = new Date(Date.parse(permitCreatedAt) + 1_000).toISOString();
  const observationBatch = sealWalmartListingObservationBatch({
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: runLockSha,
    shard_id: "shard-000000",
    call_index: 0,
    call_key: callKey,
    created_at: reservedAt,
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    worker_receipt: signedSourceWorkerReceipt({
      runLockSha,
      callKey,
      promptSha: runLock.shards[0]!.prompt_sha256,
      resultSha,
      imageShas: imageBindings.map((row) => row.model_view_sha256),
      executionPermit,
      reservedAt,
      issuedAt,
    }),
    execution_permit: executionPermit,
    execution: {
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      input_image_count_attested: true,
      worker_contract_attested: true,
    },
    prompt: { version: BLIND_PROMPT_VERSION, sha256: runLock.shards[0]!.prompt_sha256 },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: imageBindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: assetDetails.map((row) => {
      const ocrOutput = {
        schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
        engine: LOCAL_VISUAL_OCR_ENGINE,
        views: [{
          view_role: "full" as const,
          view_sha256: row.full.sha256,
          width: row.full.width,
          height: row.full.height,
          observations: [],
        }],
      };
      return {
        image_id: row.image_id,
        asset_sha256: row.fingerprint.sha256,
        full_view_sha256: row.full.sha256,
        preprocessor_version: VISUAL_PREPROCESS_VERSION,
        ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
        ocr_script_sha256: "e".repeat(64),
        ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
        ocr_output: ocrOutput,
        truncated: false,
        auxiliary_ocr: { ocr_texts: [] },
      };
    }),
  });
  const sources = {
    product_truth_snapshot: input.truth.snapshot,
    buyer_snapshot_index: buyerIndex,
    catalog_truth_export: catalogExport,
    buyer_snapshot_manifest: buyerSnapshot,
    ...raw,
    surface_snapshot: surfaceSnapshot,
    asset_bytes: new Map(assetDetails.map((row) => [row.slot, row.bytes])),
    run_lock_sha256: runLockSha,
    code_bundle_id: codeManifest.bundle_id,
    code_bundle_manifest_sha256: sha256(codeManifestBytes),
    worker_receipt_key_id: "fixture-worker-key",
    worker_receipt_public_key_sha256: WORKER_PUBLIC_SHA,
    observation_batches: [observationBatch],
  };
  const report = await verifyWalmartListingIntegrityReportAgainstSources(
    await compileWalmartListingIntegrityReportAgainstSources(listingInput, sources),
    listingInput,
    sources,
  );
  const bundle: WalmartListingRepairExactSourceBundle = {
    run_lock_bytes: runLockBytes,
    code_bundle_manifest_bytes: codeManifestBytes,
    preflight_certificate_bytes: preflightBytes,
    execution_permit_bytes: [ordinaryBytes(executionPermit)],
    product_truth_snapshot_bytes: truthBytes,
    buyer_snapshot_index_bytes: buyerIndexBytes,
    catalog_truth_export_bytes: catalogExportBytes,
    buyer_snapshot_manifest_bytes: buyerSnapshotBytes,
    seller_item_payload_bytes: sellerBytes,
    catalog_search_payload_bytes: catalogBytes,
    buyer_pdp_payload_bytes: buyerBytes,
    surface_snapshot_bytes: surfaceBytes,
    input_bytes: inputBytes,
    report_bytes: ordinaryBytes(report),
    asset_bytes: new Map(assetDetails.map((row) => [row.slot, Buffer.from(row.bytes)])),
    observation_batch_bytes: [ordinaryBytes(observationBatch)],
  };
  return { bundle, input: listingInput, report, diagnostic };
}

const SOURCE_VERIFIER = verifyWalmartListingIntegrityReportAgainstSources;

/**
 * Production Qualification is deliberately pinned NO-GO, so its public test
 * runtime requires a control callback. This callback does not trust fixture
 * shapes: it uses the production strict run-lock/preflight/Ed25519 permit
 * parsers and binds every supplied source/listing artifact to exact bytes.
 */
const CONTROL_VERIFIER = (
  rawRunLock: unknown,
  runLockBytes: Uint8Array,
  rawCodeManifest: unknown,
  codeManifestBytes: Uint8Array,
  rawPreflight: unknown,
  preflightBytes: Uint8Array,
  rawPermits: unknown[],
  _permitBytes: Uint8Array[],
  listingKey: string,
  artifactHashes: ReadonlyMap<string, string>,
) => {
  const runLock = parseRunLock(rawRunLock as Parameters<typeof parseRunLock>[0]);
  const runLockSha = sha256(runLockBytes);
  const codeManifest = rawCodeManifest as { bundle_id: string };
  const codeManifestSha = sha256(codeManifestBytes);
  const preflight = parseWalmartListingIntegrityPreflightCertificate(
    rawPreflight as Parameters<typeof parseWalmartListingIntegrityPreflightCertificate>[0],
  );
  const preflightSha = sha256(preflightBytes);
  assert.equal(preflight.body.run_lock_sha256, runLockSha);
  assert.equal(preflight.body.run_id, runLock.run_id);
  assert.equal(preflight.body.family_created_at, runLock.created_at);
  assert.equal(preflight.body.code_bundle_id, codeManifest.bundle_id);
  assert.equal(preflight.body.code_bundle_manifest_sha256, codeManifestSha);
  assert.equal(runLock.code_bundle_manifest.sha256, codeManifestSha);
  for (const [field, inventoryKey] of [
    ["product_truth_snapshot", "product_truth_snapshot"],
    ["buyer_snapshot_index", "buyer_snapshot_index"],
    ["catalog_truth_export", "catalog_truth_export"],
  ] as const) {
    assert.equal(runLock.source_artifacts[field].sha256, artifactHashes.get(inventoryKey));
  }
  const listing = runLock.listings.find((row) => row.listing_key === listingKey);
  assert(listing);
  for (const [field, inventoryKey] of [
    ["base_input", "input"],
    ["surface_snapshot", "surface_snapshot"],
    ["buyer_snapshot_manifest", "buyer_snapshot_manifest"],
    ["seller_item_payload", "seller_item_payload"],
    ["catalog_search_payload", "catalog_search_payload"],
    ["buyer_pdp_payload", "buyer_pdp_payload"],
  ] as const) {
    assert.equal(listing[field].sha256, artifactHashes.get(inventoryKey));
  }
  const covered = new Set<string>();
  const authorizationShas = new Set<string>();
  for (const rawPermit of rawPermits) {
    const partitionId = (rawPermit as { body: { partition_id: string } }).body.partition_id;
    const partition = runLock.observer_partitions.find((row) => row.partition_id === partitionId);
    assert(partition);
    const permit = parseWalmartListingIntegrityExecutionPermit(rawPermit, {
      run_lock: runLock,
      run_lock_sha256: runLockSha,
      run_id: runLock.run_id,
      preflight_certificate_sha256: preflightSha,
      family_created_at: runLock.created_at,
      partition,
    });
    permit.body.shard_ids.forEach((shardId: string) => covered.add(shardId));
    authorizationShas.add(permit.body.owner_authorization.authorization_sha256);
  }
  assert(listing.shard_ids.every((shardId: string) => covered.has(shardId)));
  assert(authorizationShas.size > 0);
  return {
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    code_bundle_id: codeManifest.bundle_id,
    code_bundle_manifest_sha256: codeManifestSha,
    capture_authority_key_id: runLock.owner_execution_authority.key_id,
    capture_authority_public_key_spki_sha256:
      runLock.owner_execution_authority.public_key_spki_sha256,
    worker_receipt_key_id: runLock.observer_contract.worker_receipt_key_id,
    worker_receipt_public_key_sha256:
      runLock.observer_contract.worker_receipt_public_key_sha256,
    authenticated_capture_nonce_sha256: sha256(canonicalJson({
      run_lock_sha256: runLockSha,
      preflight_certificate_sha256: preflightSha,
      owner_authorization_sha256: [...authorizationShas].sort(),
    })),
  };
};

function maintenanceSchema() {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["MPItemFeedHeader", "MPItem"],
    properties: {
      MPItemFeedHeader: {
        type: "object",
        additionalProperties: false,
        required: ["businessUnit", "locale", "version"],
        properties: {
          businessUnit: { const: "WALMART_US" },
          locale: { const: "en" },
          version: { const: SPEC_VERSION },
        },
      },
      MPItem: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["Orderable", "Visible"],
          properties: {
            Orderable: {
              type: "object",
              additionalProperties: false,
              required: ["sku", "productIdentifiers"],
              properties: {
                sku: { const: SKU },
                productIdentifiers: {
                  type: "object",
                  additionalProperties: false,
                  required: ["productIdType", "productId"],
                  properties: {
                    productIdType: { const: "UPC" },
                    productId: { const: "012345678905" },
                  },
                },
              },
            },
            Visible: {
              type: "object",
              additionalProperties: false,
              required: [PRODUCT_TYPE],
              properties: {
                [PRODUCT_TYPE]: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    productName: { type: "string", minLength: 1 },
                    mainImageUrl: { type: "string", minLength: 1 },
                    productSecondaryImageURL: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 },
                    },
                    multipackQuantity: { type: "integer", minimum: 1 },
                  },
                  minProperties: 1,
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildPayloadInputs(input: {
  plan: SealedWalmartListingRepairPlan;
  baseline: { surface: WalmartListingSurface; images: Array<{
    slot: "main" | `gallery-${number}`;
    source_url: string;
    sha256: string;
  }> };
  certificateBytes: Uint8Array;
}) {
  const getSpecRequest = {
    feedType: "MP_MAINTENANCE",
    version: SPEC_VERSION,
    productTypes: [PRODUCT_TYPE],
  };
  const getSpecResponse = { schema: maintenanceSchema() };
  const getSpecRequestBytes = canonicalBytes(getSpecRequest);
  const getSpecResponseBytes = canonicalBytes(getSpecResponse);
  const getSpecReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST",
    path: "/v3/items/spec",
    request_content_type: "application/json",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: "a".repeat(64),
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    request_payload_sha256: walmartListingSurgicalSha256(getSpecRequest),
    response_payload_sha256: walmartListingSurgicalSha256(getSpecResponse),
    fetched_at: "2026-07-21T11:56:00.000Z",
  };
  const getSpecReceipt = {
    ...getSpecReceiptBody,
    body_sha256: walmartListingSurgicalSha256(getSpecReceiptBody),
  } as WalmartListingSurgicalGetSpecReceipt;
  const liveItemResponse = {
    ItemResponse: [{
      sku: SKU,
      itemId: ITEM_ID,
      productType: PRODUCT_TYPE,
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      upc: "012345678905",
    }],
  };
  const liveItemResponseBytes = canonicalBytes(liveItemResponse);
  const liveReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET",
    path: `/v3/items/${SKU}`,
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: "b".repeat(64),
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    response_payload_sha256: walmartListingSurgicalSha256(liveItemResponse),
    captured_at: "2026-07-21T11:55:00.000Z",
  };
  const liveReceipt = {
    ...liveReceiptBody,
    body_sha256: walmartListingSurgicalSha256(liveReceiptBody),
  } as WalmartListingSurgicalLiveItemReceipt;
  const countClaim = input.plan.target.surface.attribute_claims.find(
    (claim) => claim.kind === "outer_units",
  )!;
  const contractBody = {
    schema_version: WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
    contract_id: "schema-contract-closed-loop-1",
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    target_sha256: input.plan.target.target_sha256,
    listing: {
      ...LISTING_ONE,
      product_identifier: { productIdType: "UPC", productId: "012345678905" },
      product_type: PRODUCT_TYPE,
      live_item_capture_sha256: walmartListingSurgicalSha256(liveItemResponse),
      live_item_receipt_body_sha256: liveReceipt.body_sha256,
      live_item_captured_at: liveReceipt.captured_at,
    },
    spec: {
      feed_type: "MP_MAINTENANCE",
      business_unit: "WALMART_US",
      locale: "en",
      version: SPEC_VERSION,
      product_type: PRODUCT_TYPE,
      request_payload_sha256: walmartListingSurgicalSha256(getSpecRequest),
      response_payload_sha256: walmartListingSurgicalSha256(getSpecResponse),
      schema_sha256: walmartListingSurgicalSha256(getSpecResponse.schema),
      get_spec_receipt_body_sha256: getSpecReceipt.body_sha256,
      valid_until: "2026-07-21T12:25:00.000Z",
    },
    schema_mapping_approval_sha256: "c".repeat(64),
    attribute_mappings: [{
      source_field_path: countClaim.field_path,
      source_kind: countClaim.kind,
      source_claim_sha256: walmartListingIntegritySha256(countClaim),
      walmart_visible_field: "multipackQuantity",
      walmart_value: 6,
      walmart_value_sha256: walmartListingSurgicalSha256(6),
    }],
    claims: {
      exact_one_sku: true,
      changed_fields_only: true,
      full_target_is_qa_reference_only: true,
      audit_claims_are_not_write_schema: true,
      blank_or_null_clear_forbidden: true,
      preserve_unapproved_fields_by_omission: true,
      retries: 0,
      redirects: 0,
    },
  };
  const schemaContract = {
    ...contractBody,
    body_sha256: walmartListingSurgicalSha256(contractBody),
  } as WalmartListingSurgicalSchemaContract;
  const request = {
    permit_id: "closed-loop-permit-1",
    target_image_certificate_sha256: sha256(input.certificateBytes),
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    request_correlation_id_sha256: sha256("closed-loop-correlation-1"),
    prepared_at: PAYLOAD_PREPARED_AT,
  };
  return {
    plan: input.plan,
    baseline: input.baseline,
    schema_contract: schemaContract,
    get_spec_receipt: getSpecReceipt,
    live_item_receipt: liveReceipt,
    target_image_certificate_bytes: input.certificateBytes,
    get_spec_request_bytes: getSpecRequestBytes,
    get_spec_response_bytes: getSpecResponseBytes,
    live_item_response_bytes: liveItemResponseBytes,
    request,
  };
}

function permitAuthorization(input: {
  sequence: WalmartListingRepairSequenceAuthorization;
  plan: SealedWalmartListingRepairPlan;
  ledger: Awaited<ReturnType<typeof bootstrapWalmartListingRepairConsumptionLedger>>["binding"];
  requestManifestSha: string;
  requestPayloadSha: string;
  certificateSha: string;
}): WalmartListingRepairOneSkuPermit {
  const body: WalmartListingRepairOneSkuPermitSignedBody = {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: "TEST_FIXTURE_ONLY",
    permit_id: "closed-loop-permit-1",
    issued_at: PERMIT_ISSUED_AT,
    expires_at: "2026-07-21T12:32:00.000Z",
    approved_by: "owner-test-fixture",
    decision_ref: "test://owner/closed-loop-one-sku",
    sequence_authorization_sha256: input.sequence.authorization_sha256,
    sequence_id: input.sequence.signed_body.sequence_id,
    sequence_epoch: input.sequence.signed_body.sequence_epoch,
    sequence_position: 0,
    listing: LISTING_ONE,
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    target_sha256: input.plan.target.target_sha256,
    target_image_certificate_sha256: input.certificateSha,
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
    apply_engine_release_sha256: APPLY_SHA,
    request_manifest_sha256: input.requestManifestSha,
    request_payload_sha256: input.requestPayloadSha,
    consumption_ledger: input.ledger,
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
  return signEnvelope(walmartListingRepairOneSkuPermitSigningEnvelope({
    key_id: OWNER_KEY_ID,
    owner_public_key_spki_sha256: OWNER_PUBLIC_SHA,
    signed_body: body,
  }));
}

interface ClosedLoopFixture {
  sequence: WalmartListingRepairSequenceAuthorization;
  plan: SealedWalmartListingRepairPlan;
  permit: WalmartListingRepairOneSkuPermit;
  baseline: Awaited<ReturnType<typeof makeSource>>;
  pendingPost: Awaited<ReturnType<typeof makeSource>>;
  passingPost: Awaited<ReturnType<typeof makeSource>>;
  certificateBytes: Buffer;
  writerResult: Awaited<ReturnType<typeof executeWalmartListingRepairOneSkuForTest>>;
  transportCounts: WalmartListingRepairTransportCounts;
  events: string[];
  reference: WalmartListingRepairApplyEvidenceReference;
  adapter: WalmartListingRepairCustodyApplyEvidenceAdapter;
  runtime: ReturnType<typeof walmartListingRepairTestRuntime>;
  artifactSink: Awaited<ReturnType<typeof createWalmartListingRepairArtifactCustody>>;
  feedStatusCorrelationSha: string;
}

async function completedClosedLoop(t: TestContext): Promise<ClosedLoopFixture> {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, "wm-closed-loop-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const ledgerRoot = path.join(base, "ledger");
  const artifactRoot = path.join(base, "artifacts");
  const ledgerBootstrap = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: ledgerRoot,
    now: "2026-07-21T11:00:00.000Z",
  });

  const targetPngs = await Promise.all([
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#fffdf8" } })
      .png().toBuffer(),
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#f8fdff" } })
      .png().toBuffer(),
  ]);
  const targetUrls = [
    "https://i5.walmartimages.com/pf-bread-6-main.png",
    "https://i5.walmartimages.com/pf-bread-6-gallery-1.png",
  ] as const;
  const rights = [rightsArtifact(0), rightsArtifact(1)];
  const imageObservations = targetPngs.map((bytes, index) => ({
    sourceRefId: `image-source-${index}`,
    artifact: imageObservationArtifact({
      index,
      sourceRefId: `image-source-${index}`,
      url: targetUrls[index]!,
      imageSha: sha256(bytes),
      byteSize: bytes.byteLength,
      rights: rights[index]!,
    }),
  }));
  const truth = buildTruthSnapshot(imageObservations);
  const targetAssets = new Map<string, Uint8Array>([
    ["main", targetPngs[0]!],
    ["gallery-1", targetPngs[1]!],
  ]);
  const baselinePngs = await Promise.all([
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#8c6d54" } })
      .png().toBuffer(),
    sharp({ create: { width: 1_500, height: 1_500, channels: 3, background: "#c7a27e" } })
      .png().toBuffer(),
  ]);
  const baselineAssets = new Map<string, Uint8Array>([
    ["main", baselinePngs[0]!],
    ["gallery-1", baselinePngs[1]!],
  ]);
  const baseline = await makeSource({
    truth,
    kind: "baseline",
    capturedAt: BASE_CAPTURED_AT,
    runLockCreatedAt: "2026-07-21T11:31:00.000Z",
    nonce: "baseline",
    surface: baselineSurface(),
    assets: baselineAssets,
    urls: [
      "https://i5.walmartimages.com/wrong-oatmeal-main.png",
      "https://i5.walmartimages.com/wrong-oatmeal-gallery.png",
    ],
    goodImages: false,
  });
  assert.equal(baseline.diagnostic.overall_verdict, "BAD");
  assert.match(baseline.diagnostic.blocking_reasons.join(" "), /quantity|forbidden|contradicts/u);

  const sequence = sequenceAuthorization();
  let adapter: WalmartListingRepairCustodyApplyEvidenceAdapter | null = null;
  const runtime = walmartListingRepairTestRuntime({
    verifier_engine_release_sha256: RELEASE_SHA,
    sourceVerifier: SOURCE_VERIFIER,
    controlVerifier: CONTROL_VERIFIER,
    verifyApply: async (input) => {
      if (!adapter) throw new Error("custody adapter is not available before terminal write");
      return adapter.verify(input);
    },
    env: TEST_ENV,
  });
  const initialGate = await evaluateWalmartListingRepairSequenceForTest({
    sequence_authorization: sequence,
    evidence_packages: [],
    evaluated_at: new Date(PLAN_CREATED_AT),
  }, runtime);
  assert.equal(initialGate.next_listing_key, LISTING_KEY);
  assert.notEqual(initialGate.next_listing_key, LISTING_TWO.listing_key);

  const targetImages = [
    { slot: "main" as const, source_url: targetUrls[0], sha256: sha256(targetPngs[0]!) },
    { slot: "gallery-1" as const, source_url: targetUrls[1], sha256: sha256(targetPngs[1]!) },
  ];
  const plan = await buildWalmartListingRepairPlanForTest({
    sequence_authorization: sequence,
    sequence_position: 0,
    baseline_source_bundle: baseline.bundle,
    plan_id: "closed-loop-plan-pf-bread-6",
    created_at: PLAN_CREATED_AT,
    expires_at: "2026-07-21T14:00:00.000Z",
    apply_engine_release_sha256: APPLY_SHA,
    target_surface: targetSurface(),
    target_images: targetImages,
    now: new Date(PLAN_CREATED_AT),
  }, runtime);
  assert.deepEqual(plan.changed_fields, ["attributes", "main", "gallery"]);

  const vision = jsonArtifact(buildVisionBatch(targetImages.map((image) => ({
    slot: image.slot,
    sha256: image.sha256,
  }))));
  const imageCertificate = await certifyWalmartListingRepairTargetImages({
    now: IMAGE_CERTIFIED_AT,
    plan: jsonArtifact(plan),
    listing_projection: jsonArtifact(targetSurface()),
    product_truth_snapshot: truth.artifact,
    worker_trust: {
      run_lock_sha256: RUN_LOCK_SHA,
      key_id: "fixture-worker-key",
      public_key_spki_sha256: WORKER_PUBLIC_SHA,
      worker_build: WORKER_BUILD,
      reservation_ledger: structuredClone(RESERVATION_LEDGER),
    },
    targets: targetPngs.map((downloadedBytes, index) => ({
      slot: targetImages[index]!.slot,
      downloaded_bytes: downloadedBytes,
      content_type: "image/png" as const,
      requested_url: targetUrls[index]!,
      final_url: targetUrls[index]!,
      redirect_chain: [],
      downloaded_at: "2026-07-21T11:58:00.000Z",
      fresh_until: "2026-07-22T11:58:00.000Z",
      derivation: "DIRECT_EXACT_ASSET" as const,
      represented_outer_unit_count: 6,
      represented_component_id: COMPONENT_ID,
      represented_canonical_variant_id: CANONICAL_VARIANT_ID,
      represented_content_observation_id: CONTENT_OBSERVATION_ID,
      product_truth_source_ref_id: imageObservations[index]!.sourceRefId,
      exact_variant_image_observation: imageObservations[index]!.artifact,
      rights_evidence: rights[index]!,
      vision_observation_batch: vision,
    })),
  });
  const certificateBytes = Buffer.from(
    canonicalWalmartListingSurgicalJson(imageCertificate),
    "utf8",
  );
  const verifiedCertificate = verifyWalmartListingRepairTargetImageCertificateBytes({
    certificate_bytes: certificateBytes,
    plan,
    at: IMAGE_CERTIFIED_AT,
  });
  assert.equal(verifiedCertificate.policy.authority, "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY");

  const baselineProjection = {
    surface: baseline.input.surface,
    images: baseline.input.images.assets.map((asset) => ({
      slot: asset.slot,
      source_url: asset.source_url,
      sha256: asset.sha256,
    })),
  };
  const payloadInputs = buildPayloadInputs({
    plan,
    baseline: baselineProjection,
    certificateBytes,
  });
  const built = buildWalmartListingSurgicalRequest(payloadInputs);
  const permit = permitAuthorization({
    sequence,
    plan,
    ledger: ledgerBootstrap.binding,
    requestManifestSha: built.request_manifest_sha256,
    requestPayloadSha: built.payload_sha256,
    certificateSha: sha256(certificateBytes),
  });
  const fixedPayloadContext = Object.fromEntries(
    Object.entries(payloadInputs).filter(([key]) => key !== "plan"),
  );
  const executionInput = {
    writer_input: {
      sequence_authorization: sequence,
      one_sku_permit: permit,
      plan,
      payload_context: fixedPayloadContext,
      target_image_certificate_context: {},
      request_correlation_id: "closed-loop-correlation-1",
      poll_policy: { max_attempts: 1, delay_ms: 0 },
    },
    production_context: {
      ledger_state_directory: ledgerRoot,
      artifact_custody_root: artifactRoot,
      sequence_evidence_packages: [],
      product_truth_binding: { ...permit.signed_body.product_truth },
    },
  };
  const fixedDependencies = createWalmartListingRepairProductionDependencies(executionInput);
  const sealedExecutionPackage = sealWalmartListingRepairExecutionPackage({
    created_at: "2026-07-21T12:02:59.000Z",
    execution: executionInput,
  });
  const executionPackageBytes = Buffer.from(
    renderWalmartListingRepairExecutionPackage(sealedExecutionPackage),
    "utf8",
  );
  const parsedExecutionPackage = parseWalmartListingRepairExecutionPackageBytes({
    artifact_bytes: executionPackageBytes,
    expected_artifact_sha256: sha256(executionPackageBytes),
  });
  assert.equal(
    parsedExecutionPackage.execution.writer_input.plan.body_sha256,
    plan.body_sha256,
  );
  assert(parsedExecutionPackage.execution.writer_input.payload_context
    && typeof parsedExecutionPackage.execution.writer_input.payload_context === "object");
  const fixedBuilt = await fixedDependencies.payload_builder.build({
    plan,
    sequence,
    permit,
    request_correlation_id_sha256: payloadInputs.request.request_correlation_id_sha256,
    context: fixedPayloadContext,
  });
  assert.deepEqual(fixedBuilt.payload_bytes, built.payload_bytes);
  assert.deepEqual(fixedBuilt.request_manifest_bytes, built.request_manifest_bytes);
  fixedDependencies.exact_request_verifier.verifyExactBytes({
    plan,
    sequence,
    permit,
    context: fixedPayloadContext,
    request_payload_bytes: fixedBuilt.payload_bytes,
    request_manifest_bytes: fixedBuilt.request_manifest_bytes,
    request_payload_sha256: fixedBuilt.payload_sha256,
    request_manifest_sha256: fixedBuilt.request_manifest_sha256,
  });
  assert.deepEqual(
    await fixedDependencies.read_current_product_truth({ plan }),
    permit.signed_body.product_truth,
  );
  assert.equal(
    (await fixedDependencies.verify_target_image_certificate({
      plan,
      certificate_bytes: certificateBytes,
      context: {},
      now: new Date(IMAGE_CERTIFIED_AT),
    })).certificate_sha256,
    sha256(certificateBytes),
  );
  await assert.rejects(stat(artifactRoot), { code: "ENOENT" });
  const ledger = createWalmartListingRepairLedgerAdapter({
    state_directory: ledgerRoot,
    expected_binding: ledgerBootstrap.binding,
  });
  const artifactSink = await createWalmartListingRepairArtifactCustody({
    custody_root: artifactRoot,
    permit,
  });

  const events: string[] = [];
  const transportCounts: WalmartListingRepairTransportCounts = {
    oauth_token_calls: 0,
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
    total_http_calls: 0,
  };
  const postBody = canonicalBytes({ feedId: FEED_ID, status: "RECEIVED" });
  const feedStatusBody = canonicalBytes({
    feedId: FEED_ID,
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: {
      itemIngestionStatus: [{ sku: SKU, ingestionStatus: "SUCCESS" }],
    },
  });
  const transport: WalmartListingRepairOneShotTransport = {
    getAccountBinding: () => ({
      channel: "WALMART_US",
      store_index: 1,
      seller_id: "closed-loop-seller",
      seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    }),
    getCallCounts: () => ({ ...transportCounts }),
    postMaintenance: async (request) => {
      events.push("POST");
      assert.equal(request.path, "/v3/feeds");
      assert.deepEqual(request.query, { feedType: "MP_MAINTENANCE" });
      assert.equal(request.retries, 0);
      assert.equal(request.redirect, "error");
      transportCounts.oauth_token_calls += 1;
      transportCounts.maintenance_post_calls += 1;
      transportCounts.total_http_calls += 2;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: postBody,
      };
    },
    getFeedStatus: async (request) => {
      events.push("GET");
      assert.equal(request.feed_id, FEED_ID);
      assert.equal(request.path, `/v3/feeds/${FEED_ID}`);
      assert.deepEqual(request.query, { includeDetails: "true" });
      assert.equal(request.retries, 0);
      assert.equal(request.redirect, "error");
      transportCounts.feed_status_get_calls += 1;
      transportCounts.total_http_calls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: feedStatusBody,
      };
    },
  };
  let clockMs = Date.parse("2026-07-21T12:03:00.000Z");
  const now = () => {
    const value = new Date(clockMs);
    clockMs += 1_000;
    return value;
  };
  const readyProof = async (): Promise<WalmartListingRepairSequenceGateResult> => (
    evaluateWalmartListingRepairSequenceForTest({
      sequence_authorization: sequence,
      evidence_packages: [],
      evaluated_at: now(),
    }, runtime)
  );
  const dependencies: WalmartListingRepairWriterDependencies = {
    payload_builder: {
      build: async ({ permit: suppliedPermit }) => {
        assert.equal(suppliedPermit.authorization_sha256, permit.authorization_sha256);
        return built;
      },
    },
    exact_request_verifier: {
      verifyExactBytes: (exact) => {
        verifyWalmartListingSurgicalRequestBytes({
          ...payloadInputs,
          request_payload_bytes: exact.request_payload_bytes,
          request_manifest_bytes: exact.request_manifest_bytes,
        });
      },
    },
    ledger,
    artifact_sink: artifactSink,
    rebuild_sequence_ready_proof: async () => {
      const gate = await readyProof();
      if (gate.status !== "READY_FOR_ONE_SKU_PLAN" || gate.next_listing_key === null) {
        throw new Error("closed-loop sequence unexpectedly ceased to be ready for its first SKU");
      }
      return {
        sequence_authorization_sha256: gate.sequence_authorization_sha256,
        sequence_id: gate.sequence_id,
        sequence_epoch: gate.sequence_epoch,
        verifier_engine_release_sha256: RELEASE_SHA,
        status: "READY_FOR_ONE_SKU_PLAN",
        next_listing_key: gate.next_listing_key,
        next_sequence_position: gate.completed_pass_count,
        marketplace_write_authorized: false,
        separate_signed_one_sku_permit_required: true,
      };
    },
    read_current_product_truth: async () => ({ ...permit.signed_body.product_truth }),
    verify_target_image_certificate: async ({ certificate_bytes: exactBytes, now: at }) => {
      const certificate = verifyWalmartListingRepairTargetImageCertificateBytes({
        certificate_bytes: exactBytes,
        plan,
        at,
      });
      return {
        status: "CERTIFIED_EXACT_TARGET_IMAGES",
        certificate_sha256: sha256(exactBytes),
        plan_body_sha256: plan.body_sha256,
        target_sha256: plan.target.target_sha256,
        listing: LISTING_ONE,
        verified_at: at.toISOString(),
        expires_at: certificate.expires_at,
        evidence_only_not_write_authority: true,
      };
    },
    open_transport: () => transport,
    now,
    wait: async () => undefined,
    random_id: () => `closed-loop-poll-${transportCounts.feed_status_get_calls + 1}`,
  };
  const writerResult = await executeWalmartListingRepairOneSkuForTest({
    sequence_authorization: sequence,
    one_sku_permit: permit,
    plan,
    payload_context: {},
    target_image_certificate_context: {},
    request_correlation_id: "closed-loop-correlation-1",
    poll_policy: { max_attempts: 1, delay_ms: 0 },
  }, dependencies, {
    verifySequence: (value, at) => (
      verifyWalmartListingRepairSequenceAuthorizationForTest(value, at, TEST_ENV)
    ),
    verifyCurrentPermit: (value, at) => (
      verifyCurrentWalmartListingRepairOneSkuPermitForTest(value, at, TEST_ENV)
    ),
    expected_apply_engine_release_sha256: APPLY_SHA,
  });
  assert.equal(writerResult.status, "SUCCEEDED");
  assert.equal(transportCounts.maintenance_post_calls, 1);

  const ledgerEvidence = await readWalmartListingRepairPermitLedgerEvidence({
    state_directory: ledgerRoot,
    expected_binding: ledgerBootstrap.binding,
    permit_authorization_sha256: permit.authorization_sha256,
  });
  const artifactEvidence = await readWalmartListingRepairArtifactCustodyEvidence({
    custody_root: artifactRoot,
    permit,
  });
  assert.equal(ledgerEvidence.state, "SUCCEEDED");
  assert(ledgerEvidence.terminal_sha256);
  const operatorPackagePath = path.join(base, "execution-package.json");
  const operatorStatusPath = path.join(base, "operator-status.json");
  const operatorReportPath = path.join(base, "operator-report.json");
  await writeFile(operatorPackagePath, executionPackageBytes, { flag: "wx", mode: 0o400 });
  const packageArtifactSha = sha256(executionPackageBytes);
  const operatorStatus = await runWalmartListingRepairOperator(
    parseWalmartListingRepairOperatorArgs([
      "status", "--package", operatorPackagePath,
      "--package-sha256", packageArtifactSha, "--out", operatorStatusPath,
    ]),
    new Date("2026-07-21T12:04:00.000Z"),
  );
  const operatorReport = await runWalmartListingRepairOperator(
    parseWalmartListingRepairOperatorArgs([
      "report", "--package", operatorPackagePath,
      "--package-sha256", packageArtifactSha, "--out", operatorReportPath,
    ]),
    new Date("2026-07-21T12:04:01.000Z"),
  );
  assert.equal(operatorStatus.status, "SUCCEEDED");
  assert.equal(operatorStatus.next_command, "fresh-live-reread-and-qualification");
  assert.equal(operatorReport.status, "SUCCEEDED");
  assert.equal((await stat(operatorStatusPath)).mode & 0o777, 0o400);
  assert.equal((await stat(operatorReportPath)).mode & 0o777, 0o400);
  const reference: WalmartListingRepairApplyEvidenceReference = {
    schema_version: WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
    permit_authorization_sha256: permit.authorization_sha256,
    ledger_identity_sha256: ledgerEvidence.identity_sha256,
    ledger_terminal_sha256: ledgerEvidence.terminal_sha256,
    ledger_head_sha256: ledgerEvidence.head_sha256,
    artifact_custody_identity_sha256: artifactEvidence.identity_artifact_sha256,
    artifact_custody_inventory_sha256: artifactEvidence.inventory_sha256,
  };
  adapter = createWalmartListingRepairCustodyApplyEvidenceAdapter({
    custody_root: artifactRoot,
    ledger_state_directory: ledgerRoot,
  });

  const pendingPost = await makeSource({
    truth,
    kind: "post-wrong",
    capturedAt: POST_CAPTURED_AT,
    runLockCreatedAt: "2026-07-21T12:21:00.000Z",
    nonce: "post-wrong",
    surface: baselineSurface(),
    assets: baselineAssets,
    urls: [
      "https://i5.walmartimages.com/wrong-oatmeal-main.png",
      "https://i5.walmartimages.com/wrong-oatmeal-gallery.png",
    ],
    goodImages: false,
  });
  const passingPost = await makeSource({
    truth,
    kind: "post-passing",
    capturedAt: RECHECK_CAPTURED_AT,
    runLockCreatedAt: "2026-07-21T12:31:00.000Z",
    nonce: "post-passing",
    surface: targetSurface(),
    assets: targetAssets,
    urls: targetUrls,
    goodImages: true,
  });
  return {
    sequence,
    plan,
    permit,
    baseline,
    pendingPost,
    passingPost,
    certificateBytes,
    writerResult,
    transportCounts,
    events,
    reference,
    adapter,
    runtime,
    artifactSink,
    feedStatusCorrelationSha: sha256("closed-loop-poll-1"),
  };
}

function evidencePackage(
  fx: ClosedLoopFixture,
  post: Awaited<ReturnType<typeof makeSource>>,
  reference = fx.reference,
): WalmartListingRepairQualificationEvidencePackage {
  return {
    plan: fx.plan,
    baseline_source_bundle: fx.baseline.bundle,
    one_sku_permit: fx.permit,
    apply_evidence_reference: reference,
    post_source_bundle: post.bundle,
  };
}

async function evaluate(
  fx: ClosedLoopFixture,
  packages: WalmartListingRepairQualificationEvidencePackage[],
) {
  return evaluateWalmartListingRepairSequenceForTest({
    sequence_authorization: fx.sequence,
    evidence_packages: packages,
    evaluated_at: new Date(QUALIFIED_AT),
  }, fx.runtime);
}

test("one exact SKU closes BAD -> repair -> SUCCEEDED -> reread -> PASS without hidden effects", async (t) => {
  const networkTripwire = installNetworkTripwire(t);
  const fx = await completedClosedLoop(t);

  assert.equal(fx.baseline.diagnostic.overall_verdict, "BAD");
  assert.equal(fx.passingPost.diagnostic.overall_verdict, "REVIEW");
  assert.equal(fx.passingPost.report.overall_verdict, "PASS");
  assert.equal(fx.passingPost.report.assurance.compilation_mode, "source_aware");
  assert.equal(fx.passingPost.report.assurance.source_artifacts_verified, true);
  assert.equal(fx.passingPost.report.assurance.asset_bytes_verified, true);
  assert.equal(fx.passingPost.report.assurance.observation_artifacts_verified, true);
  assert.equal(fx.writerResult.status, "SUCCEEDED");
  assert.deepEqual(fx.transportCounts, {
    oauth_token_calls: 1,
    maintenance_post_calls: 1,
    feed_status_get_calls: 1,
    total_http_calls: 3,
  });
  assert.deepEqual(fx.events, ["POST", "GET"]);
  assert.deepEqual(fx.writerResult.external_effects, {
    database_calls_by_core: 0,
    model_calls_by_core: 0,
    paid_provider_calls_by_core: 0,
    other_listing_writes_by_core: 0,
    marketplace_feed_posts_maximum: 1,
  });

  const postsBeforeQualification = fx.transportCounts.maintenance_post_calls;
  const pending = await evaluate(fx, [evidencePackage(fx, fx.pendingPost)]);
  assert.equal(pending.status, "WAITING_FOR_RECHECK");
  assert.equal(pending.completed_pass_count, 0);
  assert.equal(pending.next_listing_key, null);
  assert.equal(pending.blocked_listing_key, LISTING_KEY);
  assert.equal(pending.next_sku_released_for_plan_only, false);
  assert.equal(pending.rebuilt_qualifications[0]!.verdict, "PENDING_PROPAGATION");
  assert.equal(pending.rebuilt_qualifications[0]!.facets.pack_count, "FAIL");
  assert.equal(pending.rebuilt_qualifications[0]!.facets.main, "FAIL");
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);

  const closed = await evaluate(fx, [
    evidencePackage(fx, fx.pendingPost),
    evidencePackage(fx, fx.passingPost),
  ]);
  assert.equal(closed.status, "READY_FOR_ONE_SKU_PLAN");
  assert.equal(closed.completed_pass_count, 1);
  assert.equal(closed.next_listing_key, LISTING_TWO.listing_key);
  assert.equal(closed.next_sku_released_for_plan_only, true);
  assert.deepEqual(closed.rebuilt_qualifications.map((row) => row.verdict), [
    "PENDING_PROPAGATION",
    "PASS",
  ]);
  assert.equal(closed.rebuilt_qualifications[1]!.next_sku_unblocked, true);
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);
  assert.equal(fx.events.filter((entry) => entry === "POST").length, 1);

  const tamperedReport = JSON.parse(
    Buffer.from(fx.passingPost.bundle.report_bytes).toString("utf8"),
  ) as Record<string, unknown>;
  tamperedReport.overall_verdict = "BAD";
  await assert.rejects(evaluate(fx, [evidencePackage(fx, {
    ...fx.passingPost,
    bundle: {
      ...fx.passingPost.bundle,
      report_bytes: ordinaryBytes(tamperedReport),
    },
  })]));
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);

  const tamperedPermit = JSON.parse(
    Buffer.from(fx.passingPost.bundle.execution_permit_bytes[0]!).toString("utf8"),
  ) as { sha256: string; body: Record<string, unknown> };
  tamperedPermit.body.expires_at = "2026-07-21T12:31:00.001Z";
  await assert.rejects(evaluate(fx, [evidencePackage(fx, {
    ...fx.passingPost,
    bundle: {
      ...fx.passingPost.bundle,
      execution_permit_bytes: [ordinaryBytes(tamperedPermit)],
    },
  })]));
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);

  const tamperedReference = {
    ...fx.reference,
    artifact_custody_inventory_sha256: "f".repeat(64),
  };
  await assert.rejects(
    evaluate(fx, [evidencePackage(fx, fx.passingPost, tamperedReference)]),
    /reference differs from the current permit\/ledger\/artifact custody/i,
  );
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);

  const extraStatusPayload = canonicalBytes({
    feedId: FEED_ID,
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: { itemIngestionStatus: [{ sku: SKU, ingestionStatus: "SUCCESS" }] },
  });
  const extraCorrelation = "e".repeat(64);
  const extraStatusHttp = canonicalBytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: "FEED_STATUS_GET",
    method: "GET",
    path: `/v3/feeds/${FEED_ID}`,
    query: { includeDetails: "true" },
    feed_id: FEED_ID,
    status: 200,
    content_type: "application/json",
    content_length: extraStatusPayload.byteLength,
    request_correlation_id_sha256: extraCorrelation,
    captured_at: "2026-07-21T12:40:00.000Z",
  });
  const extraStem = sha256(canonicalJson({
    schema_version: "walmart-listing-repair-feed-status-call/v1",
    feed_id: FEED_ID,
    correlation_id_sha256: extraCorrelation,
    request_manifest_sha256: fx.permit.signed_body.request_manifest_sha256,
    request_payload_sha256: fx.permit.signed_body.request_payload_sha256,
  }));
  await fx.artifactSink.persist("FEED_STATUS", {
    [`feed-status-${extraStem}.http.json`]: extraStatusHttp,
    [`feed-status-${extraStem}.payload.bin`]: extraStatusPayload,
  });
  await assert.rejects(
    evaluate(fx, [evidencePackage(fx, fx.passingPost)]),
    /reference differs from the current permit\/ledger\/artifact custody/i,
  );
  assert.equal(fx.transportCounts.maintenance_post_calls, postsBeforeQualification);
  assert.equal(networkTripwire.total(), 0);
  assert.deepEqual(networkTripwire.counts, {
    fetch: 0,
    "http.request": 0,
    "http.get": 0,
    "https.request": 0,
    "https.get": 0,
    "net.connect": 0,
    "net.createConnection": 0,
    "tls.connect": 0,
  });
});
