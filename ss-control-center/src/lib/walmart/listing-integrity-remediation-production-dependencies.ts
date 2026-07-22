/** Fixed production dependency closure for one-SKU Walmart repair. */

import { createHash } from "node:crypto";

import type {
  WalmartListingRepairConsumptionLedgerBinding,
  WalmartListingRepairOneSkuPermit,
} from "./listing-integrity-remediation-authority.ts";
import { createWalmartListingRepairArtifactCustody } from "./listing-integrity-remediation-artifacts.ts";
import { verifyWalmartListingRepairTargetImageCertificateBytes } from "./listing-integrity-remediation-image-certificate.ts";
import { createWalmartListingRepairLedgerAdapter } from "./listing-integrity-remediation-ledger-adapter.ts";
import {
  buildWalmartListingSurgicalRequest,
  verifyWalmartListingSurgicalRequestBytes,
} from "./listing-integrity-remediation-payload.ts";
import {
  evaluateWalmartListingRepairSequence,
  type WalmartListingRepairQualificationEvidencePackage,
} from "./listing-integrity-remediation-qualification.ts";
import { createWalmartListingRepairNativeTransport } from "./listing-integrity-remediation-transport.ts";
import type {
  BuiltWalmartListingRepairSurgicalRequest,
  WalmartListingRepairArtifactSink,
  WalmartListingRepairExactRequestVerifier,
  WalmartListingRepairPayloadBuilder,
  WalmartListingRepairProductTruthBinding,
  WalmartListingRepairProductionExecutionInput,
  WalmartListingRepairSequenceReadyProof,
  WalmartListingRepairWriterDependencies,
} from "./listing-integrity-remediation-writer.ts";

type JsonRecord = Record<string, unknown>;
type SurgicalBuildInput = Parameters<typeof buildWalmartListingSurgicalRequest>[0];
type SurgicalPayloadContext = Omit<SurgicalBuildInput, "plan">;

const PAYLOAD_CONTEXT_KEYS = Object.freeze([
  "baseline",
  "schema_contract",
  "get_spec_receipt",
  "live_item_receipt",
  "target_image_certificate_bytes",
  "get_spec_request_bytes",
  "get_spec_response_bytes",
  "live_item_response_bytes",
  "request",
]);
const PRODUCT_TRUTH_KEYS = Object.freeze([
  "expected_sha256",
  "product_truth_snapshot_id",
  "product_truth_snapshot_body_sha256",
  "truth_revision_id",
  "truth_revision_body_sha256",
  "truth_approval_sha256",
]);

export class WalmartListingRepairProductionDependencyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairProductionDependencyError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairProductionDependencyError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_PRODUCTION_CONTEXT", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])) {
    fail("INVALID_PRODUCTION_CONTEXT", `${label} has unsupported or missing fields`);
  }
}

function snapshot<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    return fail("INVALID_PRODUCTION_CONTEXT", `${label} is not snapshot-safe data`);
  }
}

function payloadContext(value: unknown): SurgicalPayloadContext {
  const raw = record(value, "payload_context");
  exactKeys(raw, PAYLOAD_CONTEXT_KEYS, "payload_context");
  for (const key of [
    "target_image_certificate_bytes",
    "get_spec_request_bytes",
    "get_spec_response_bytes",
    "live_item_response_bytes",
  ]) {
    if (!(raw[key] instanceof Uint8Array)) {
      fail("INVALID_PRODUCTION_CONTEXT", `payload_context.${key} must be exact bytes`);
    }
  }
  return snapshot(raw, "payload_context") as unknown as SurgicalPayloadContext;
}

function emptyCertificateContext(value: unknown): void {
  const raw = record(value, "target_image_certificate_context");
  exactKeys(raw, [], "target_image_certificate_context");
}

function productTruthBinding(value: unknown): WalmartListingRepairProductTruthBinding {
  const raw = record(value, "product_truth_binding");
  exactKeys(raw, PRODUCT_TRUTH_KEYS, "product_truth_binding");
  return snapshot(raw, "product_truth_binding") as unknown as WalmartListingRepairProductTruthBinding;
}

function rawPermit(value: unknown): WalmartListingRepairOneSkuPermit {
  const permit = record(value, "one_sku_permit");
  const signedBody = record(permit.signed_body, "one_sku_permit.signed_body");
  record(signedBody.consumption_ledger, "one_sku_permit consumption_ledger");
  return snapshot(permit, "one_sku_permit") as unknown as WalmartListingRepairOneSkuPermit;
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function lazyArtifactSink(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
}): WalmartListingRepairArtifactSink {
  let custodyPromise: ReturnType<typeof createWalmartListingRepairArtifactCustody> | null = null;
  const custody = () => {
    custodyPromise ??= createWalmartListingRepairArtifactCustody(input);
    return custodyPromise;
  };
  const sink: WalmartListingRepairArtifactSink = {
    async persist(stage, artifacts) {
      return (await custody()).persist(stage, artifacts);
    },
    async loadAccepted(loadInput) {
      return (await custody()).loadAccepted(loadInput);
    },
  };
  return Object.freeze(sink);
}

function adaptPayload(
  built: ReturnType<typeof buildWalmartListingSurgicalRequest>,
): BuiltWalmartListingRepairSurgicalRequest {
  return built as unknown as BuiltWalmartListingRepairSurgicalRequest;
}

/**
 * This is the sole production dependency factory. It accepts data only and
 * statically selects every executable component. It performs no network call,
 * creates no custody directory, and consumes no permit during construction.
 */
export function createWalmartListingRepairProductionDependencies(
  input: WalmartListingRepairProductionExecutionInput,
): WalmartListingRepairWriterDependencies {
  const execution = snapshot(input, "production execution input");
  const context = execution.production_context;
  if (!context || typeof context !== "object") {
    fail("INVALID_PRODUCTION_CONTEXT", "production_context is missing");
  }
  const payload = payloadContext(execution.writer_input.payload_context);
  emptyCertificateContext(execution.writer_input.target_image_certificate_context);
  const truth = productTruthBinding(context.product_truth_binding);
  if (!Array.isArray(context.sequence_evidence_packages)) {
    fail("INVALID_PRODUCTION_CONTEXT", "sequence_evidence_packages must be an array");
  }
  const evidencePackages = snapshot(
    context.sequence_evidence_packages,
    "sequence_evidence_packages",
  ) as readonly WalmartListingRepairQualificationEvidencePackage[];
  const permit = rawPermit(execution.writer_input.one_sku_permit);
  const binding = snapshot(
    permit.signed_body.consumption_ledger,
    "permit consumption ledger",
  ) as WalmartListingRepairConsumptionLedgerBinding;
  const ledger = createWalmartListingRepairLedgerAdapter({
    state_directory: context.ledger_state_directory,
    expected_binding: binding,
  });
  const artifactSink = lazyArtifactSink({
    custody_root: context.artifact_custody_root,
    permit,
  });
  const payloadBuilder: WalmartListingRepairPayloadBuilder = {
    async build({ plan }) {
      return adaptPayload(buildWalmartListingSurgicalRequest({ plan, ...payload }));
    },
  };
  Object.freeze(payloadBuilder);
  const exactRequestVerifier: WalmartListingRepairExactRequestVerifier = {
    verifyExactBytes({ plan, request_payload_bytes, request_manifest_bytes }) {
      verifyWalmartListingSurgicalRequestBytes({
        plan,
        ...payload,
        request_payload_bytes,
        request_manifest_bytes,
      });
    },
  };
  Object.freeze(exactRequestVerifier);

  const dependencies: WalmartListingRepairWriterDependencies = {
    payload_builder: payloadBuilder,
    exact_request_verifier: exactRequestVerifier,
    ledger,
    artifact_sink: artifactSink,
    async rebuild_sequence_ready_proof({ sequence_authorization, plan }) {
      const gate = await evaluateWalmartListingRepairSequence({
        sequence_authorization,
        evidence_packages: snapshot(evidencePackages, "sequence_evidence_packages reread"),
      });
      if (gate.status !== "READY_FOR_ONE_SKU_PLAN" || gate.next_listing_key === null) {
        fail("SEQUENCE_NOT_READY", "rebuilt production sequence gate is not ready for one SKU");
      }
      return {
        sequence_authorization_sha256: gate.sequence_authorization_sha256,
        sequence_id: gate.sequence_id,
        sequence_epoch: gate.sequence_epoch,
        verifier_engine_release_sha256: plan.verifier_engine_release_sha256,
        status: "READY_FOR_ONE_SKU_PLAN",
        next_listing_key: gate.next_listing_key,
        next_sequence_position: gate.completed_pass_count,
        marketplace_write_authorized: false,
        separate_signed_one_sku_permit_required: true,
      } satisfies WalmartListingRepairSequenceReadyProof;
    },
    async read_current_product_truth() {
      return snapshot(truth, "product_truth_binding reread");
    },
    async verify_target_image_certificate({ plan, certificate_bytes, now }) {
      const certificate = verifyWalmartListingRepairTargetImageCertificateBytes({
        certificate_bytes,
        plan,
        at: now,
      });
      return {
        status: "CERTIFIED_EXACT_TARGET_IMAGES",
        certificate_sha256: bytesSha256(certificate_bytes),
        plan_body_sha256: plan.body_sha256,
        target_sha256: plan.target.target_sha256,
        listing: {
          channel: plan.listing.channel,
          store_index: plan.listing.store_index,
          sku: plan.listing.sku,
          listing_key: plan.listing.listing_key,
          item_id: plan.listing.item_id,
        },
        verified_at: now.toISOString(),
        expires_at: certificate.expires_at,
        evidence_only_not_write_authority: true,
      };
    },
    open_transport() {
      return createWalmartListingRepairNativeTransport({
        store_index: execution.writer_input.plan.listing.store_index,
      });
    },
  };
  return Object.freeze(dependencies);
}
