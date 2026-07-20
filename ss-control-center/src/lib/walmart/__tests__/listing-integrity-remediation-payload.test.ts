import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairTargetImage,
} from "../listing-integrity-remediation-qualification.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_REQUEST_MANIFEST_SCHEMA,
  WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
  buildWalmartListingSurgicalRequest,
  canonicalWalmartListingSurgicalJson,
  verifyWalmartListingSurgicalRequestBytes,
  walmartListingSurgicalSha256,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
  type WalmartListingSurgicalProductIdentifier,
  type WalmartListingSurgicalSchemaContract,
} from "../listing-integrity-remediation-payload.ts";

const H = (char: string): string => char.repeat(64);
const SELLER = H("a");
const SPEC_VERSION = WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION;
const PRODUCT_TYPE = "Food And Beverage";

function seal<T extends Record<string, unknown>>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingSurgicalSha256(body) };
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
}

function image(slot: "main" | `gallery-${number}`, name: string, sha: string) {
  return {
    slot,
    source_url: `https://images.example.test/${name}.jpg`,
    sha256: H(sha),
  } satisfies WalmartListingRepairTargetImage;
}

function surface(input: {
  title: string;
  description?: string | null;
  bullets?: string[];
  claims: ListingAttributeClaim[];
}): WalmartListingSurface {
  return {
    title: input.title,
    description: input.description === undefined ? "Exact six-unit description" : input.description,
    bullets: input.bullets ?? ["Exact product", "Six retail units", "Buyer-visible facts"],
    attribute_claims: input.claims,
    unmapped_attributes: [],
  };
}

function planFixture(options: {
  baselineSurface?: WalmartListingSurface;
  targetSurface?: WalmartListingSurface;
  baselineImages?: WalmartListingRepairTargetImage[];
  targetImages?: WalmartListingRepairTargetImage[];
  changedFields?: Array<"title" | "description" | "bullets" | "attributes" | "main" | "gallery">;
} = {}): {
  plan: SealedWalmartListingRepairPlan;
  baseline: { surface: WalmartListingSurface; images: WalmartListingRepairTargetImage[] };
} {
  const baselineSurface = options.baselineSurface ?? surface({
    title: "Exact Product Pack of 1",
    claims: [{
      field_path: "product.attributes.Multipack Quantity",
      kind: "outer_units",
      value: 1,
      unit: "count",
    }],
  });
  const targetSurface = options.targetSurface ?? surface({
    title: "Exact Product Pack of 6",
    claims: [{
      field_path: "product.attributes.Multipack Quantity",
      kind: "outer_units",
      value: 6,
      unit: "count",
    }],
  });
  const baselineImages = options.baselineImages ?? [
    image("main", "old-main", "1"),
    image("gallery-1", "gallery-one", "2"),
    image("gallery-2", "gallery-two", "3"),
  ];
  const targetImages = options.targetImages ?? [
    image("main", "new-main", "4"),
    image("gallery-1", "gallery-one", "2"),
    image("gallery-2", "gallery-two", "3"),
  ];
  const changedFields = options.changedFields ?? ["title", "attributes", "main"];
  const target = { surface: targetSurface, images: targetImages };
  const body = {
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: "repair-plan-1",
    created_at: "2026-07-20T12:00:00.000Z",
    expires_at: "2026-07-20T13:00:00.000Z",
    verifier_engine_release_sha256: H("5"),
    apply_engine_release_sha256: H("6"),
    sequence: {
      authorization_sha256: H("7"),
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      position: 0,
      population_artifact_sha256: H("8"),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-EXACT-1",
      listing_key: "walmart:1:SKU-EXACT-1",
      item_id: "123456789",
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      captured_at: "2026-07-20T11:55:00.000Z",
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "baseline-report-1",
      report_body_sha256: H("9"),
      input_body_sha256: H("a"),
      captured_at: "2026-07-20T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(baselineSurface),
      images_sha256: walmartListingIntegritySha256(baselineImages),
      buyer_payload_sha256: H("b"),
      surface_payload_sha256: H("c"),
      source_evidence_inventory_sha256: H("d"),
      live_capture_exchange_sha256: H("e"),
      authenticated_capture_nonce_sha256: H("f"),
    },
    product_truth: {
      expected_sha256: H("1"),
      product_truth_snapshot_id: "truth-snapshot-1",
      product_truth_snapshot_body_sha256: H("2"),
      product_truth_snapshot_file_sha256: H("3"),
      truth_revision_id: "truth-revision-1",
      truth_revision_body_sha256: H("4"),
      truth_approval_sha256: H("5"),
    },
    target: {
      ...target,
      target_sha256: walmartListingIntegritySha256(target),
    },
    changed_fields: changedFields,
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
  return {
    plan: seal(body) as SealedWalmartListingRepairPlan,
    baseline: { surface: baselineSurface, images: baselineImages },
  };
}

function maintenanceSchema(identifier: WalmartListingSurgicalProductIdentifier) {
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
                sku: { const: "SKU-EXACT-1" },
                productIdentifiers: {
                  type: "object",
                  additionalProperties: false,
                  required: ["productIdType", "productId"],
                  properties: {
                    productIdType: { const: identifier.productIdType },
                    productId: { const: identifier.productId },
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
                    shortDescription: { type: "string", minLength: 1 },
                    keyFeatures: { type: "array", minItems: 1, items: { type: "string" } },
                    mainImageUrl: { type: "string", minLength: 1 },
                    productSecondaryImageURL: {
                      type: "array",
                      minEntries: 1,
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

function fixture(options: {
  planData?: ReturnType<typeof planFixture>;
  identifier?: WalmartListingSurgicalProductIdentifier;
  contractMutator?: (body: Record<string, unknown>) => void;
  receiptMutator?: (body: Record<string, unknown>) => void;
  liveItemMutator?: (row: Record<string, unknown>) => void;
  liveReceiptMutator?: (body: Record<string, unknown>) => void;
  schemaMutator?: (schema: Record<string, unknown>) => void;
} = {}) {
  const planData = options.planData ?? planFixture();
  const identifier = options.identifier ?? {
    productIdType: "UPC" as const,
    productId: "012345678905",
  };
  const schema = maintenanceSchema(identifier) as Record<string, unknown>;
  options.schemaMutator?.(schema);
  const getSpecRequest = {
    feedType: "MP_MAINTENANCE",
    version: SPEC_VERSION,
    productTypes: [PRODUCT_TYPE],
  };
  const getSpecResponse = { schema };
  const getSpecRequestBytes = bytes(getSpecRequest);
  const getSpecResponseBytes = bytes(getSpecResponse);
  const receiptBody: Record<string, unknown> = {
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST",
    path: "/v3/items/spec",
    request_content_type: "application/json",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: H("6"),
    seller_account_fingerprint_sha256: SELLER,
    request_payload_sha256: walmartListingSurgicalSha256(getSpecRequest),
    response_payload_sha256: walmartListingSurgicalSha256(getSpecResponse),
    fetched_at: "2026-07-20T12:04:00.000Z",
  };
  options.receiptMutator?.(receiptBody);
  const receipt = seal(receiptBody) as unknown as WalmartListingSurgicalGetSpecReceipt;
  const liveItemRow: Record<string, unknown> = {
    sku: "SKU-EXACT-1",
    itemId: "123456789",
    productType: PRODUCT_TYPE,
    publishedStatus: "PUBLISHED",
    lifecycleStatus: "ACTIVE",
    [identifier.productIdType.toLowerCase()]: identifier.productId,
  };
  options.liveItemMutator?.(liveItemRow);
  const liveItemResponse = { ItemResponse: [liveItemRow] };
  const liveItemResponseBytes = bytes(liveItemResponse);
  const liveReceiptBody: Record<string, unknown> = {
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET",
    path: "/v3/items/SKU-EXACT-1",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: H("0"),
    seller_account_fingerprint_sha256: SELLER,
    response_payload_sha256: walmartListingSurgicalSha256(liveItemResponse),
    captured_at: "2026-07-20T12:03:00.000Z",
  };
  options.liveReceiptMutator?.(liveReceiptBody);
  const liveReceipt = seal(liveReceiptBody) as unknown as WalmartListingSurgicalLiveItemReceipt;
  const targetClaim = planData.plan.target.surface.attribute_claims[0]!;
  const contractBody: Record<string, unknown> = {
    schema_version: WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
    contract_id: "schema-contract-1",
    plan_id: planData.plan.plan_id,
    plan_body_sha256: planData.plan.body_sha256,
    target_sha256: planData.plan.target.target_sha256,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "SKU-EXACT-1",
      listing_key: "walmart:1:SKU-EXACT-1",
      item_id: "123456789",
      product_identifier: identifier,
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
      schema_sha256: walmartListingSurgicalSha256(schema),
      get_spec_receipt_body_sha256: receipt.body_sha256,
      valid_until: "2026-07-20T12:25:00.000Z",
    },
    schema_mapping_approval_sha256: H("8"),
    attribute_mappings: [{
      source_field_path: targetClaim.field_path,
      source_kind: targetClaim.kind,
      source_claim_sha256: walmartListingIntegritySha256(targetClaim),
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
  options.contractMutator?.(contractBody);
  const contract = seal(contractBody) as unknown as WalmartListingSurgicalSchemaContract;
  return {
    ...planData,
    schema,
    contract,
    receipt,
    liveReceipt,
    getSpecRequestBytes,
    getSpecResponseBytes,
    liveItemResponseBytes,
    request: {
      permit_id: "permit-1",
      seller_account_fingerprint_sha256: SELLER,
      request_correlation_id_sha256: H("9"),
      prepared_at: "2026-07-20T12:05:00.000Z",
    },
  };
}

function build(value = fixture()) {
  return buildWalmartListingSurgicalRequest({
    plan: value.plan,
    baseline: value.baseline,
    schema_contract: value.contract,
    get_spec_receipt: value.receipt,
    live_item_receipt: value.liveReceipt,
    get_spec_request_bytes: value.getSpecRequestBytes,
    get_spec_response_bytes: value.getSpecResponseBytes,
    live_item_response_bytes: value.liveItemResponseBytes,
    request: value.request,
  });
}

test("builds one canonical native MP_MAINTENANCE request and never writes the full QA target", () => {
  const result = build();
  assert.deepEqual(result.payload.MPItemFeedHeader, {
    businessUnit: "WALMART_US",
    locale: "en",
    version: SPEC_VERSION,
  });
  const items = result.payload.MPItem as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.Orderable, {
    sku: "SKU-EXACT-1",
    productIdentifiers: { productIdType: "UPC", productId: "012345678905" },
  });
  const visible = (items[0]!.Visible as Record<string, Record<string, unknown>>)[PRODUCT_TYPE]!;
  assert.deepEqual(visible, {
    productName: "Exact Product Pack of 6",
    mainImageUrl: "https://images.example.test/new-main.jpg",
    multipackQuantity: 6,
  });
  assert.equal(Object.hasOwn(visible, "shortDescription"), false);
  assert.equal(Object.hasOwn(visible, "keyFeatures"), false);
  assert.equal(Object.hasOwn(visible, "productSecondaryImageURL"), false);
  assert.equal(Object.hasOwn(visible, "brand"), false);
  assert.equal(result.payload_json, canonicalWalmartListingSurgicalJson(result.payload));
  assert.equal(result.payload_sha256, walmartListingSurgicalSha256(result.payload));
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.status, "PASSED");
  assert.deepEqual(result.validation.changed_fields, ["title", "attributes", "main"]);
  assert.equal(result.validation.full_target_written, false);
});

test("manifest freezes pre-sign timing, raw spec, identifier, and exact transport semantics", () => {
  const result = build();
  const manifest = result.request_manifest;
  assert.equal(manifest.schema_version, WALMART_LISTING_SURGICAL_REQUEST_MANIFEST_SCHEMA);
  assert.equal(manifest.prepared_at, "2026-07-20T12:05:00.000Z");
  assert.equal((manifest as unknown as Record<string, unknown>).created_at, undefined);
  assert.equal(manifest.method, "POST");
  assert.equal(manifest.path, "/v3/feeds");
  assert.equal(manifest.feed_type, "MP_MAINTENANCE");
  assert.deepEqual(manifest.listing, {
    channel: "WALMART_US",
    store_index: 1,
    sku: "SKU-EXACT-1",
    listing_key: "walmart:1:SKU-EXACT-1",
    item_id: "123456789",
  });
  assert.deepEqual(manifest.native_identity, {
    product_identifier: { productIdType: "UPC", productId: "012345678905" },
    product_type: PRODUCT_TYPE,
    live_item_response_payload_sha256: result.validation.live_item_response_payload_sha256,
    live_item_receipt_body_sha256: result.validation.live_item_receipt_body_sha256,
  });
  assert.deepEqual(manifest.transport, {
    query: { feedType: "MP_MAINTENANCE" },
    multipart: {
      field_name: "file",
      filename: "SKU-EXACT-1-mp-maintenance.json",
      content_type: "application/json",
    },
    retries: 0,
    redirects: 0,
  });
  assert.equal(result.filename, manifest.transport.multipart.filename);
  assert.deepEqual(manifest.get_spec.product_identifier, {
    productIdType: "UPC",
    productId: "012345678905",
  });
  assert.equal(manifest.request_payload_sha256, result.payload_sha256);
  assert.equal(result.validation.exact_listing_count, 1);
  assert.equal(result.validation.feed_type, "MP_MAINTENANCE");
  assert.equal(result.request_manifest_sha256, walmartListingSurgicalSha256(manifest));
});

test("gallery replacement preserves exact target ordering and omits unchanged MAIN", () => {
  const baseline = [
    image("main", "same-main", "1"),
    image("gallery-1", "old-gallery", "2"),
  ];
  const target = [
    image("main", "same-main", "1"),
    image("gallery-1", "new-gallery-one", "3"),
    image("gallery-2", "new-gallery-two", "4"),
  ];
  const sameClaims: ListingAttributeClaim[] = [{
    field_path: "product.attributes.Multipack Quantity",
    kind: "outer_units",
    value: 6,
    unit: "count",
  }];
  const planData = planFixture({
    baselineSurface: surface({ title: "Same title", claims: sameClaims }),
    targetSurface: surface({ title: "Same title", claims: sameClaims }),
    baselineImages: baseline,
    targetImages: target,
    changedFields: ["gallery"],
  });
  const value = fixture({
    planData,
    contractMutator: (body) => { body.attribute_mappings = []; },
  });
  const result = build(value);
  const item = (result.payload.MPItem as Array<Record<string, unknown>>)[0]!;
  const visible = (item.Visible as Record<string, Record<string, unknown>>)[PRODUCT_TYPE]!;
  assert.deepEqual(visible, {
    productSecondaryImageURL: [
      "https://images.example.test/new-gallery-one.jpg",
      "https://images.example.test/new-gallery-two.jpg",
    ],
  });
  assert.equal(Object.hasOwn(visible, "mainImageUrl"), false);
});

test("supports exact live identifier allowlist instead of assuming UPC", () => {
  const result = build(fixture({
    identifier: { productIdType: "GTIN", productId: "00123456789012" },
  }));
  const item = (result.payload.MPItem as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual((item.Orderable as Record<string, unknown>).productIdentifiers, {
    productIdType: "GTIN",
    productId: "00123456789012",
  });
});

test("supports an explicitly mapped newly added target claim", () => {
  const targetClaim: ListingAttributeClaim = {
    field_path: "product.attributes.Multipack Quantity",
    kind: "outer_units",
    value: 6,
    unit: "count",
  };
  const planData = planFixture({
    baselineSurface: surface({ title: "Exact Product Pack of 1", claims: [] }),
    targetSurface: surface({ title: "Exact Product Pack of 6", claims: [targetClaim] }),
  });
  const result = build(fixture({ planData }));
  const item = (result.payload.MPItem as Array<Record<string, unknown>>)[0]!;
  const visible = (item.Visible as Record<string, Record<string, unknown>>)[PRODUCT_TYPE]!;
  assert.equal(visible.multipackQuantity, 6);
});

test("rejects caller field paths as Walmart keys and mappings for unchanged claims", () => {
  const reservedCaseVariant = fixture({
    contractMutator: (body) => {
      const mappings = body.attribute_mappings as Array<Record<string, unknown>>;
      mappings[0]!.walmart_visible_field = "Brand";
    },
  });
  assert.throws(() => build(reservedCaseVariant), /reserved\/forbidden Walmart field/i);

  const directPath = fixture({
    contractMutator: (body) => {
      const mappings = body.attribute_mappings as Array<Record<string, unknown>>;
      mappings[0]!.walmart_visible_field = "product.attributes.Multipack Quantity";
      mappings[0]!.walmart_value_sha256 = walmartListingSurgicalSha256(6);
    },
  });
  assert.throws(() => build(directPath), /reserved\/forbidden Walmart field|invalid/i);

  const planData = planFixture();
  const unchangedClaim: ListingAttributeClaim = {
    field_path: "product.attributes.Flavor",
    kind: "variant",
    text: "Chocolate",
  };
  planData.plan.target.surface.attribute_claims.push(unchangedClaim);
  planData.baseline.surface.attribute_claims.push(unchangedClaim);
  // Rebuild all affected hashes after intentionally adding the unchanged claim.
  const target = { surface: planData.plan.target.surface, images: planData.plan.target.images };
  const planBody = { ...planData.plan } as Record<string, unknown>;
  delete planBody.body_sha256;
  (planBody.target as Record<string, unknown>).target_sha256 = walmartListingIntegritySha256(target);
  (planBody.baseline as Record<string, unknown>).surface_sha256 = walmartListingIntegritySha256(
    planData.baseline.surface,
  );
  planData.plan = seal(planBody) as unknown as SealedWalmartListingRepairPlan;
  const extra = fixture({
    planData,
    contractMutator: (body) => {
      body.plan_body_sha256 = planData.plan.body_sha256;
      body.target_sha256 = planData.plan.target.target_sha256;
      const mappings = body.attribute_mappings as Array<Record<string, unknown>>;
      mappings.push({
        source_field_path: unchangedClaim.field_path,
        source_kind: unchangedClaim.kind,
        source_claim_sha256: walmartListingIntegritySha256(unchangedClaim),
        walmart_visible_field: "flavor",
        walmart_value: "Chocolate",
        walmart_value_sha256: walmartListingSurgicalSha256("Chocolate"),
      });
      mappings.sort((left, right) => String(left.walmart_visible_field)
        .localeCompare(String(right.walmart_visible_field), "en"));
    },
  });
  assert.throws(() => build(extra), /not bound to a changed target claim/i);
});

test("pins the configured spec and exact fresh live item identity/state from raw bytes", () => {
  const oldSpec = fixture({
    contractMutator: (body) => {
      (body.spec as Record<string, unknown>).version = "5.0.20260101-00_00_00-api";
    },
  });
  assert.throws(() => build(oldSpec), /configured current MP_MAINTENANCE spec/i);

  const staleLive = fixture({
    liveReceiptMutator: (body) => {
      body.captured_at = "2026-07-20T11:30:00.000Z";
    },
  });
  assert.throws(() => build(staleLive), /live item.*stale|stale.*live item/i);

  const tamperedLive = fixture();
  tamperedLive.liveItemResponseBytes = Buffer.concat([
    Buffer.from(tamperedLive.liveItemResponseBytes),
    Buffer.from(" "),
  ]);
  assert.throws(
    () => build(tamperedLive),
    /raw live item response bytes differ/i,
  );

  const cases: Array<{
    label: string;
    mutate: (row: Record<string, unknown>) => void;
    expected: RegExp;
  }> = [
    {
      label: "SKU",
      mutate: (row) => { row.sku = "OTHER-SKU"; },
      expected: /SKU differs/i,
    },
    {
      label: "itemId",
      mutate: (row) => { row.itemId = "987654321"; },
      expected: /matching numeric itemId/i,
    },
    {
      label: "product identifier",
      mutate: (row) => { row.upc = "999999999999"; },
      expected: /matching product identifier/i,
    },
    {
      label: "productType",
      mutate: (row) => { row.productType = "Wrong Type"; },
      expected: /productType differs/i,
    },
    {
      label: "published state",
      mutate: (row) => { row.publishedStatus = "UNPUBLISHED"; },
      expected: /not PUBLISHED\/ACTIVE/i,
    },
    {
      label: "lifecycle state",
      mutate: (row) => { row.lifecycleStatus = "RETIRED"; },
      expected: /not PUBLISHED\/ACTIVE/i,
    },
  ];
  for (const candidate of cases) {
    assert.throws(
      () => build(fixture({ liveItemMutator: candidate.mutate })),
      candidate.expected,
      candidate.label,
    );
  }
});

test("rejects attribute removal and null description instead of guessing clear semantics", () => {
  const baselineClaims: ListingAttributeClaim[] = [{
    field_path: "product.attributes.Flavor",
    kind: "variant",
    text: "Chocolate",
  }];
  const targetClaims: ListingAttributeClaim[] = [{
    field_path: "product.attributes.Multipack Quantity",
    kind: "outer_units",
    value: 6,
    unit: "count",
  }];
  const removalPlan = planFixture({
    baselineSurface: surface({ title: "Same", claims: baselineClaims }),
    targetSurface: surface({ title: "Same", claims: targetClaims }),
    baselineImages: [image("main", "main", "1"), image("gallery-1", "gallery", "2")],
    targetImages: [image("main", "main", "1"), image("gallery-1", "gallery", "2")],
    changedFields: ["attributes"],
  });
  assert.throws(() => build(fixture({ planData: removalPlan })), /removing an existing attribute/i);

  const claim: ListingAttributeClaim = {
    field_path: "product.attributes.Multipack Quantity",
    kind: "outer_units",
    value: 6,
    unit: "count",
  };
  const clearDescription = planFixture({
    baselineSurface: surface({ title: "Same", description: "Old", claims: [claim] }),
    targetSurface: surface({ title: "Same", description: null, claims: [claim] }),
    baselineImages: [image("main", "main", "1"), image("gallery-1", "gallery", "2")],
    targetImages: [image("main", "main", "1"), image("gallery-1", "gallery", "2")],
    changedFields: ["description"],
  });
  assert.throws(
    () => build(fixture({
      planData: clearDescription,
      contractMutator: (body) => { body.attribute_mappings = []; },
    })),
    /clearing description is unsupported/i,
  );
});

test("rejects stale/tampered raw Get Spec evidence and schema-invalid output", () => {
  const stale = fixture({
    contractMutator: (body) => {
      (body.spec as Record<string, unknown>).valid_until = "2026-07-20T12:04:30.000Z";
    },
  });
  assert.throws(() => build(stale), /stale\/future/i);

  const tampered = fixture();
  tampered.getSpecResponseBytes = Buffer.from(
    `${Buffer.from(tampered.getSpecResponseBytes).toString("utf8")} `,
    "utf8",
  );
  assert.throws(() => build(tampered), /raw Get Spec request\/response bytes differ/i);

  const schemaReject = fixture({
    schemaMutator: (schema) => {
      const mpItem = (schema.properties as Record<string, Record<string, unknown>>).MPItem;
      const item = mpItem.items as Record<string, unknown>;
      const orderable = ((item.properties as Record<string, Record<string, unknown>>).Orderable);
      (orderable.properties as Record<string, unknown>).forbiddenRequiredField = {
        type: "string",
      };
      (orderable.required as string[]).push("forbiddenRequiredField");
    },
  });
  assert.throws(() => build(schemaReject), /failed exact MP_MAINTENANCE schema/i);
});

test("exact-byte verifier rejects payload or manifest drift", () => {
  const value = fixture();
  const result = build(value);
  const common = {
    plan: value.plan,
    baseline: value.baseline,
    schema_contract: value.contract,
    get_spec_receipt: value.receipt,
    live_item_receipt: value.liveReceipt,
    get_spec_request_bytes: value.getSpecRequestBytes,
    get_spec_response_bytes: value.getSpecResponseBytes,
    live_item_response_bytes: value.liveItemResponseBytes,
    request: value.request,
  };
  assert.equal(verifyWalmartListingSurgicalRequestBytes({
    ...common,
    request_payload_bytes: result.payload_bytes,
    request_manifest_bytes: result.request_manifest_bytes,
  }).payload_sha256, result.payload_sha256);
  assert.throws(() => verifyWalmartListingSurgicalRequestBytes({
    ...common,
    request_payload_bytes: Buffer.concat([Buffer.from(result.payload_bytes), Buffer.from(" ")]),
    request_manifest_bytes: result.request_manifest_bytes,
  }), /payload bytes differ/i);
  assert.throws(() => verifyWalmartListingSurgicalRequestBytes({
    ...common,
    request_payload_bytes: result.payload_bytes,
    request_manifest_bytes: Buffer.concat([
      Buffer.from(result.request_manifest_bytes),
      Buffer.from(" "),
    ]),
  }), /manifest bytes differ/i);
});

test("fixture plan remains bound to the listing-integrity input family", () => {
  // A narrow regression guard that keeps this test fixture on the same canonical
  // listing identity contract used by the repair planner.
  assert.equal(WALMART_LISTING_INTEGRITY_INPUT_SCHEMA, "walmart-listing-integrity-input/v1");
});
