import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assembleWalmartListingRepairOwnerAuthorization,
  verifyCurrentWalmartListingRepairOneSkuPermitForTest,
  verifyWalmartListingRepairSequenceAuthorizationForTest,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  walmartListingRepairOwnerSigningMessage,
  walmartListingRepairSequenceSigningEnvelope,
  type WalmartListingRepairOwnerAuthorization,
  type WalmartListingRepairOwnerSigningEnvelope,
} from "../listing-integrity-remediation-authority.ts";
import {
  buildReviewedWalmartListingRepairProductTruthArtifact,
  buildWalmartListingRepairSequenceBodyFromCompilationRequest,
  compileWalmartListingRepairOwnerDraft,
  finalizeWalmartListingRepairExecutionPackage,
  verifyWalmartListingRepairCompilationRequest,
} from "../listing-integrity-remediation-owner-compiler.ts";
import {
  bootstrapWalmartListingRepairConsumptionLedger,
} from "../listing-integrity-remediation-ledger.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  walmartListingSurgicalSha256,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
} from "../listing-integrity-remediation-payload.ts";
import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";

const NOW = new Date("2026-07-25T12:05:00.000Z");
const SKU = "compiler-test-pack-6";
const ITEM_ID = "1234567890";
const SELLER_UPC = "012345678905";
const PRODUCT_TYPE = "Bakery";
const OWNER_KEY_ID = "listing-owner-compiler-fixture";
const SELLER_FINGERPRINT = "a".repeat(64);
const CAPTURE_KEY_FINGERPRINT = "b".repeat(64);
const VERIFIER_RELEASE = "c".repeat(64);
const APPLY_RELEASE = "d".repeat(64);
const EXPECTED_TRUTH_SHA = "e".repeat(64);
const CONFIRMATION =
  "Подтверждаю compiler-test-pack-6: изменить только description и bullets.";

const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({
  type: "spki",
  format: "der",
});
const OWNER_PUBLIC_SHA = sha256(OWNER_PUBLIC_DER);

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

function surface(input: {
  description: string;
  bullets: string[];
}): WalmartListingSurface {
  return {
    title: "Pepperidge Farm Hot Dog Buns, 14 oz, Pack of 6",
    description: input.description,
    bullets: input.bullets,
    attribute_claims: [],
    unmapped_attributes: [],
  };
}

function compilationRequest() {
  const baseline = surface({
    description: "Six bakery packages.",
    bullets: ["Hamburger buns", "Pack of 6"],
  });
  const target = surface({
    description: "Pepperidge Farm Hot Dog Buns, 14 oz each, Pack of 6.",
    bullets: ["Hot dog buns", "Six 14 oz packages"],
  });
  const images = [{
    slot: "main",
    source_url: "https://i5.walmartimages.com/compiler-test-main.png",
    sha256: "f".repeat(64),
  }, {
    slot: "gallery-1",
    source_url: "https://i5.walmartimages.com/compiler-test-gallery-1.png",
    sha256: "0".repeat(64),
  }];
  const body = {
    schema_version: "walmart-listing-single-repair-compilation-request/v1",
    created_at: "2026-07-25T11:55:00.000Z",
    status: "READY_FOR_CONNECTED_MATERIALS",
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: `walmart:1:${SKU}`,
      item_id: ITEM_ID,
      seller_upc: SELLER_UPC,
      captured_at: "2026-07-25T11:50:00.000Z",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product",
    },
    frozen_review: {
      proposal_file_sha256: "1".repeat(64),
      proposal_body_sha256: "2".repeat(64),
      certification_file_sha256: "3".repeat(64),
      certification_body_sha256: "4".repeat(64),
      diagnosis_file_sha256: "5".repeat(64),
      buyer_snapshot_file_sha256: "6".repeat(64),
      buyer_pdp_file_sha256: "7".repeat(64),
      donor_audit_file_sha256: "8".repeat(64),
    },
    product_truth_candidate: {
      candidate_sha256: "9".repeat(64),
      expected_sha256: EXPECTED_TRUTH_SHA,
      donor_product_id: "donor-hot-dog-buns",
      single_unit_upc: "014100050162",
      outer_units: 6,
    },
    repair: {
      baseline_surface: baseline,
      target_surface: target,
      baseline_images: images,
      target_images: images,
      changed_fields: ["description", "bullets"],
      unchanged_image_bytes: true,
    },
    owner_gate: {
      exact_confirmation: CONFIRMATION,
      confirms_only_reviewed_diff: true,
      confirmation_would_authorize_product_truth_activation: true,
      confirmation_would_authorize_one_sku_package_compilation: true,
      current_walmart_write_authorized: false,
      current_mass_run_authorized: false,
    },
    assurance: {
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
    next_required_inputs: [
      "fresh Get Spec receipt",
      "fresh exact live item receipt",
      "one-SKU owner permit",
    ],
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
}

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
          version: { const: WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION },
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
                    productId: { const: SELLER_UPC },
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
                  minProperties: 1,
                  properties: {
                    shortDescription: { type: "string", minLength: 1 },
                    keyFeatures: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function walmartMaterials(
  ledger: Awaited<
    ReturnType<typeof bootstrapWalmartListingRepairConsumptionLedger>
  >["binding"],
  ledgerRoot: string,
  artifactRoot: string,
) {
  const getSpecRequest = {
    feedType: "MP_MAINTENANCE",
    version: WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
    productTypes: [PRODUCT_TYPE],
  };
  const getSpecResponse = { schema: maintenanceSchema() };
  const liveItemResponse = {
    ItemResponse: [{
      sku: SKU,
      itemId: ITEM_ID,
      productType: PRODUCT_TYPE,
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      upc: SELLER_UPC,
    }],
  };
  const getSpecRequestBytes = canonicalBytes(getSpecRequest);
  const getSpecResponseBytes = canonicalBytes(getSpecResponse);
  const liveItemResponseBytes = canonicalBytes(liveItemResponse);
  const getSpecReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST",
    path: "/v3/items/spec",
    request_content_type: "application/json",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: "0".repeat(64),
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    request_payload_sha256: sha256(getSpecRequestBytes),
    response_payload_sha256: sha256(getSpecResponseBytes),
    fetched_at: "2026-07-25T12:03:00.000Z",
  };
  const getSpecReceipt = {
    ...getSpecReceiptBody,
    body_sha256: walmartListingSurgicalSha256(getSpecReceiptBody),
  } as WalmartListingSurgicalGetSpecReceipt;
  const liveReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET",
    path: `/v3/items/${SKU}`,
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: "1".repeat(64),
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    response_payload_sha256: sha256(liveItemResponseBytes),
    captured_at: "2026-07-25T12:03:30.000Z",
  };
  const liveItemReceipt = {
    ...liveReceiptBody,
    body_sha256: walmartListingSurgicalSha256(liveReceiptBody),
  } as WalmartListingSurgicalLiveItemReceipt;
  return {
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    capture_authority_public_key_spki_sha256: CAPTURE_KEY_FINGERPRINT,
    get_spec_receipt: getSpecReceipt,
    live_item_receipt: liveItemReceipt,
    get_spec_request_bytes: getSpecRequestBytes,
    get_spec_response_bytes: getSpecResponseBytes,
    live_item_response_bytes: liveItemResponseBytes,
    consumption_ledger: ledger,
    ledger_state_directory: ledgerRoot,
    artifact_custody_root: artifactRoot,
  };
}

test("owner compiler creates one exact text-only execution package with zero effects", {
  concurrency: false,
}, async (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    mode: process.env.WALMART_LISTING_REPAIR_TEST_MODE,
    keyId: process.env.WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID,
    publicKey:
      process.env.WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64,
  };
  process.env.NODE_ENV = "test";
  process.env.WALMART_LISTING_REPAIR_TEST_MODE = "1";
  process.env.WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID = OWNER_KEY_ID;
  process.env.WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64 =
    OWNER_PUBLIC_DER.toString("base64");
  t.after(() => {
    for (const [name, value] of [
      ["NODE_ENV", previous.NODE_ENV],
      ["WALMART_LISTING_REPAIR_TEST_MODE", previous.mode],
      ["WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID", previous.keyId],
      [
        "WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64",
        previous.publicKey,
      ],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, "wm-owner-compiler-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const ledgerRoot = path.join(base, "ledger");
  const artifactRoot = path.join(base, "artifacts");
  const ledger = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: ledgerRoot,
    now: "2026-07-25T11:45:00.000Z",
  });

  const request = compilationRequest();
  const normalizedRequest =
    verifyWalmartListingRepairCompilationRequest(request);
  assert.deepEqual(normalizedRequest.assurance, {
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    walmart_reads: 0,
    walmart_writes: 0,
  });
  assert.equal(
    verifyWalmartListingRepairCompilationRequest(normalizedRequest).body_sha256,
    request.body_sha256,
    "verified compilation requests must remain hash-valid when a caller verifies again",
  );
  const requestFileSha = sha256(canonicalBytes(request));
  const ids = {
    sequence_id: "compiler-sequence-1",
    sequence_epoch: "compiler-epoch-1",
    plan_id: "compiler-plan-1",
    contract_id: "compiler-contract-1",
    permit_id: "compiler-permit-1",
    request_correlation_id: "compiler-request-correlation-1",
    approved_by: "owner-test-fixture",
    decision_ref: "test://listing-integrity/compiler-review",
  };
  const timing = {
    sequence_issued_at: "2026-07-25T12:00:00.000Z",
    sequence_expires_at: "2026-07-25T13:00:00.000Z",
    plan_created_at: "2026-07-25T12:01:00.000Z",
    plan_expires_at: "2026-07-25T12:45:00.000Z",
    certificate_created_at: "2026-07-25T12:02:00.000Z",
    certificate_expires_at: "2026-07-25T12:40:00.000Z",
    request_prepared_at: "2026-07-25T12:04:00.000Z",
    permit_issued_at: "2026-07-25T12:04:30.000Z",
    permit_expires_at: "2026-07-25T12:20:00.000Z",
    package_created_at: "2026-07-25T12:05:00.000Z",
  };
  const reviewedTruth =
    buildReviewedWalmartListingRepairProductTruthArtifact({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      owner_confirmation: CONFIRMATION,
      approved_by: "owner-test-fixture",
      created_at: NOW.toISOString(),
    });
  const productTruth = reviewedTruth.binding;
  assert.equal(
    reviewedTruth.status,
    "ACTIVE_FOR_EXACT_ONE_SKU_PACKAGE_ONLY",
  );
  assert.equal(
    reviewedTruth.constraints.price_required_for_content_truth,
    false,
  );
  assert.equal(
    reviewedTruth.constraints.reusable_as_shared_catalog_activation,
    false,
  );
  assert.equal(productTruth.expected_sha256, EXPECTED_TRUTH_SHA);
  assert.match(reviewedTruth.body_sha256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => buildReviewedWalmartListingRepairProductTruthArtifact({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      owner_confirmation: "not the exact reviewed confirmation",
      approved_by: "owner-test-fixture",
      created_at: NOW.toISOString(),
    }),
    /owner confirmation/u,
  );
  assert.throws(
    () => buildReviewedWalmartListingRepairProductTruthArtifact({
      compilation_request: request,
      compilation_request_file_sha256: "0".repeat(64),
      owner_confirmation: CONFIRMATION,
      approved_by: "owner-test-fixture",
      created_at: "2026-07-25T11:54:59.999Z",
    }),
    /cannot predate/u,
  );
  const materials = walmartMaterials(
    ledger.binding,
    ledgerRoot,
    artifactRoot,
  );
  const sequenceBody =
    buildWalmartListingRepairSequenceBodyFromCompilationRequest({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      environment: "TEST_FIXTURE_ONLY",
      sequence_id: ids.sequence_id,
      sequence_epoch: ids.sequence_epoch,
      issued_at: timing.sequence_issued_at,
      expires_at: timing.sequence_expires_at,
      approved_by: ids.approved_by,
      decision_ref: ids.decision_ref,
      seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
      verifier_engine_release_sha256: VERIFIER_RELEASE,
      capture_authority_public_key_spki_sha256: CAPTURE_KEY_FINGERPRINT,
    });
  const rawSequence = signEnvelope(
    walmartListingRepairSequenceSigningEnvelope({
      key_id: OWNER_KEY_ID,
      owner_public_key_spki_sha256: OWNER_PUBLIC_SHA,
      signed_body: sequenceBody,
    }),
  );
  const sequence = verifyWalmartListingRepairSequenceAuthorizationForTest(
    rawSequence,
    NOW,
  );

  const draft = compileWalmartListingRepairOwnerDraft({
    environment: "TEST_FIXTURE_ONLY",
    compilation_request: request,
    compilation_request_file_sha256: requestFileSha,
    owner_confirmation: CONFIRMATION,
    sequence_authorization: sequence,
    product_truth_binding: productTruth,
    verifier_engine_release_sha256: VERIFIER_RELEASE,
    apply_engine_release_sha256: APPLY_RELEASE,
    ids,
    timing,
    materials,
  });

  assert.deepEqual(draft.built_request.validation.changed_fields, [
    "description",
    "bullets",
  ]);
  assert.deepEqual(draft.built_request.request_manifest.visible_fields, [
    "keyFeatures",
    "shortDescription",
  ]);
  const payload = draft.built_request.payload as {
    MPItem: Array<{ Visible: Record<string, Record<string, unknown>> }>;
  };
  assert.deepEqual(
    Object.keys(payload.MPItem[0]!.Visible[PRODUCT_TYPE]!).sort(),
    ["keyFeatures", "shortDescription"],
  );
  for (const forbidden of [
    "productName",
    "mainImageUrl",
    "productSecondaryImageURL",
    "price",
    "inventory",
    "publishedStatus",
    "lifecycleStatus",
  ]) {
    assert.equal(
      draft.built_request.payload_json.includes(`"${forbidden}"`),
      false,
      `payload must omit ${forbidden}`,
    );
  }
  assert.deepEqual(draft.assurance, {
    exact_listing_count: 1,
    changed_fields: ["description", "bullets"],
    current_walmart_write_authorized: false,
    mass_apply_allowed: false,
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    walmart_reads: 0,
    walmart_writes: 0,
  });

  const rawPermit = signEnvelope(
    walmartListingRepairOneSkuPermitSigningEnvelope({
      key_id: OWNER_KEY_ID,
      owner_public_key_spki_sha256: OWNER_PUBLIC_SHA,
      signed_body: draft.permit_signed_body,
    }),
  );
  const permit = verifyCurrentWalmartListingRepairOneSkuPermitForTest(
    rawPermit,
    NOW,
  );
  const result = finalizeWalmartListingRepairExecutionPackage({
    draft,
    verified_one_sku_permit: permit,
  });
  assert.equal(
    result.execution_package.created_at,
    timing.package_created_at,
  );
  assert.equal(result.execution_package.claims.exact_listing_count, 1);
  assert.equal(result.execution_package.claims.mass_apply_allowed, false);
  assert.equal(
    sha256(result.execution_package_bytes),
    result.execution_package_sha256,
  );

  assert.throws(() => compileWalmartListingRepairOwnerDraft({
    environment: "TEST_FIXTURE_ONLY",
    compilation_request: request,
    compilation_request_file_sha256: requestFileSha,
    owner_confirmation: "not the reviewed confirmation",
    sequence_authorization: sequence,
    product_truth_binding: productTruth,
    verifier_engine_release_sha256: VERIFIER_RELEASE,
    apply_engine_release_sha256: APPLY_RELEASE,
    ids,
    timing,
    materials,
  }), /owner confirmation/u);
  assert.throws(() => compileWalmartListingRepairOwnerDraft({
    environment: "TEST_FIXTURE_ONLY",
    compilation_request: request,
    compilation_request_file_sha256: requestFileSha,
    owner_confirmation: CONFIRMATION,
    sequence_authorization: sequence,
    product_truth_binding: {
      ...productTruth,
      expected_sha256: "0".repeat(64),
    },
    verifier_engine_release_sha256: VERIFIER_RELEASE,
    apply_engine_release_sha256: APPLY_RELEASE,
    ids,
    timing,
    materials,
  }), /Product Truth differs/u);
  assert.throws(() => compileWalmartListingRepairOwnerDraft({
    environment: "TEST_FIXTURE_ONLY",
    compilation_request: request,
    compilation_request_file_sha256: requestFileSha,
    owner_confirmation: CONFIRMATION,
    sequence_authorization: sequence,
    product_truth_binding: productTruth,
    verifier_engine_release_sha256: VERIFIER_RELEASE,
    apply_engine_release_sha256: APPLY_RELEASE,
    ids,
    timing,
    materials: {
      ...materials,
      live_item_receipt: {
        ...materials.live_item_receipt,
        captured_at: "2026-07-25T10:00:00.000Z",
      },
    },
  }), /body SHA|stale/u);
  assert.throws(() => finalizeWalmartListingRepairExecutionPackage({
    draft,
    verified_one_sku_permit: {
      ...permit,
      signed_body: {
        ...permit.signed_body,
        request_payload_sha256: "0".repeat(64),
      },
    },
  }), /permit differs/u);
});
