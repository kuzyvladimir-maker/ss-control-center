import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WALMART_LISTING_FULL_SURFACE_CAPABILITIES,
  WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA,
  WALMART_LISTING_ITEM_MUTABLE_FACETS,
  buildWalmartListingFullSurfacePlan,
  evaluateWalmartListingFullSurfaceFeed,
  nextWalmartListingFullSurfaceAction,
  walmartListingFullSurfaceSha256,
  type BuildWalmartListingFullSurfacePlanInput,
  type WalmartListingFullSurfaceOutcome,
} from "../listing-integrity-full-surface.ts";

const H = (char: string): string => char.repeat(64);

function operation(
  operation_id: string,
  operation_kind:
    | "SHIPPING_TEMPLATE_CREATE"
    | "ITEM_MAINTENANCE"
    | "SHIPPING_TEMPLATE_ASSOCIATION"
    | "LAG_TIME"
    | "PRICE"
    | "PROMOTIONAL_PRICE"
    | "REPRICER_ASSIGNMENT"
    | "INVENTORY"
    | "ITEM_RETIRE",
  exact_skus: string[],
) {
  const contentType = operation_kind === "ITEM_RETIRE"
    ? null
    : operation_kind === "ITEM_MAINTENANCE"
      || operation_kind === "SHIPPING_TEMPLATE_ASSOCIATION"
      ? "multipart/form-data" as const
      : "application/json" as const;
  return {
    operation_id,
    operation_kind,
    exact_skus,
    changed_item_facets: operation_kind === "ITEM_MAINTENANCE"
      ? [
        "title",
        "description",
        "key_features",
        "main_image",
        "secondary_images",
        "category_attributes",
        "variant_relationship",
        "shipping_weight",
        "package_dimensions",
        "country_of_origin",
      ] as const
      : undefined,
    request_payload_bytes: operation_kind === "ITEM_RETIRE"
      ? new Uint8Array()
      : Buffer.from(JSON.stringify({ exact_skus, operation_kind }), "utf8"),
    content_type: contentType,
    evidence_sha256: H("a"),
    account_scope_receipt_sha256: H("b"),
    category_schema_receipt_sha256:
      operation_kind === "ITEM_MAINTENANCE" ? H("c") : null,
    irreversible_owner_decision_sha256:
      operation_kind === "ITEM_RETIRE" ? H("d") : null,
    baseline_state_sha256: H("e"),
    expected_state_sha256: H("f"),
  };
}

function fixture(): BuildWalmartListingFullSurfacePlanInput {
  return {
    plan_id: "maruchan-full-surface-1",
    owner_decision_id: "owner-maruchan-20260729",
    owner_decision_sha256: H("1"),
    created_at: "2026-07-29T16:00:00.000Z",
    expires_at: "2026-07-30T15:59:59.000Z",
    seller_account_fingerprint_sha256: H("2"),
    product_truth_snapshot_sha256: H("3"),
    exact_listings: [
      {
        channel: "WALMART_US",
        store_index: 1,
        sku: "FaisalX-1433",
        listing_key: "walmart:1:FaisalX-1433",
        item_id: "1209518230",
      },
      {
        channel: "WALMART_US",
        store_index: 1,
        sku: "FaisalX-1434",
        listing_key: "walmart:1:FaisalX-1434",
        item_id: "517674888",
      },
      {
        channel: "WALMART_US",
        store_index: 1,
        sku: "FaisalX-1435",
        listing_key: "walmart:1:FaisalX-1435",
        item_id: "1523397932",
      },
    ],
    operations: [
      operation(
        "shipping-template-create",
        "SHIPPING_TEMPLATE_CREATE",
        ["FaisalX-1433", "FaisalX-1434", "FaisalX-1435"],
      ),
      operation(
        "item-group",
        "ITEM_MAINTENANCE",
        ["FaisalX-1433", "FaisalX-1434", "FaisalX-1435"],
      ),
      operation("price-1433", "PRICE", ["FaisalX-1433"]),
      operation("price-1434", "PRICE", ["FaisalX-1434"]),
      operation("price-1435", "PRICE", ["FaisalX-1435"]),
    ],
  };
}

function outcome(
  plan: ReturnType<typeof buildWalmartListingFullSurfacePlan>,
  index: number,
  result: WalmartListingFullSurfaceOutcome["outcome"],
): WalmartListingFullSurfaceOutcome {
  const operationRow = plan.operations[index];
  const body = {
    schema_version: WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA,
    plan_body_sha256: plan.body_sha256,
    operation_id: operationRow.operation_id,
    operation_body_sha256: operationRow.body_sha256,
    request_payload_sha256: operationRow.exact_request.request_payload_sha256,
    permit_authorization_sha256: H("4"),
    consumption_ledger_sha256: H("5"),
    attempted_at: `2026-07-29T16:0${index}:00.000Z`,
    outcome: result,
    marketplace_write_calls: 1 as const,
    readback_sha256: result === "SUCCEEDED_AND_READ_BACK" ? H("6") : null,
    diagnostic_sha256: null,
  };
  return {
    ...body,
    body_sha256: walmartListingFullSurfaceSha256(body),
  };
}

test("capability registry covers item, commercial, availability, fulfillment and lifecycle planes", () => {
  assert.deepEqual(
    Object.keys(WALMART_LISTING_FULL_SURFACE_CAPABILITIES),
    [
      "SHIPPING_TEMPLATE_CREATE",
      "ITEM_MAINTENANCE",
      "SHIPPING_TEMPLATE_ASSOCIATION",
      "LAG_TIME",
      "PRICE",
      "PROMOTIONAL_PRICE",
      "REPRICER_ASSIGNMENT",
      "INVENTORY",
      "ITEM_RETIRE",
    ],
  );
  assert.deepEqual(
    WALMART_LISTING_FULL_SURFACE_CAPABILITIES.ITEM_MAINTENANCE.item_facets,
    WALMART_LISTING_ITEM_MUTABLE_FACETS,
  );
  assert.equal(
    WALMART_LISTING_FULL_SURFACE_CAPABILITIES.ITEM_RETIRE.mutation_class,
    "IRREVERSIBLE",
  );
});

test("builds a sealed three-SKU group item repair followed by exact price writes", () => {
  const plan = buildWalmartListingFullSurfacePlan(fixture());
  assert.equal(plan.exact_listings.length, 3);
  assert.equal(plan.operations.length, 5);
  assert.equal(
    plan.operations[0].exact_request.path,
    "/v3/settings/shipping/templates",
  );
  assert.deepEqual(plan.operations[1].changed_item_facets, [
    "category_attributes",
    "country_of_origin",
    "description",
    "key_features",
    "main_image",
    "package_dimensions",
    "secondary_images",
    "shipping_weight",
    "title",
    "variant_relationship",
  ]);
  assert.equal(plan.operations[1].exact_request.query.feedType, "MP_MAINTENANCE");
  assert.equal(plan.operations[2].exact_request.path, "/v3/price");
  assert.equal(plan.execution_policy.maximum_in_flight_operations, 1);
  assert.equal(plan.execution_policy.automatic_replay_allowed, false);
  assert.match(plan.body_sha256, /^[a-f0-9]{64}$/u);
});

test("rejects an operation scoped to an unreviewed SKU", () => {
  const input = fixture();
  input.operations = [
    operation("foreign-price", "PRICE", ["FaisalX-9999"]),
  ];
  assert.throws(
    () => buildWalmartListingFullSurfacePlan(input),
    /outside exact_listings/u,
  );
});

test("rejects a non-canonical operation order", () => {
  const input = fixture();
  input.operations = [
    operation("inventory-first", "INVENTORY", ["FaisalX-1433"]),
    operation("price-second", "PRICE", ["FaisalX-1433"]),
  ];
  assert.throws(
    () => buildWalmartListingFullSurfacePlan(input),
    /canonical plane order/u,
  );
});

test("retirement needs its own exact irreversible decision", () => {
  const input = fixture();
  const retire = operation("retire-1433", "ITEM_RETIRE", ["FaisalX-1433"]);
  retire.irreversible_owner_decision_sha256 = null;
  input.operations = [retire];
  assert.throws(
    () => buildWalmartListingFullSurfacePlan(input),
    /irreversible owner decision/u,
  );
});

test("outcome state machine advances only after exact readback success", () => {
  const plan = buildWalmartListingFullSurfacePlan(fixture());
  assert.equal(
    nextWalmartListingFullSurfaceAction(plan, []).action,
    "EXECUTE_OPERATION",
  );
  const first = outcome(plan, 0, "SUCCEEDED_AND_READ_BACK");
  const next = nextWalmartListingFullSurfaceAction(plan, [first]);
  assert.equal(next.action, "EXECUTE_OPERATION");
  if (next.action === "EXECUTE_OPERATION") {
    assert.equal(next.operation.operation_id, "item-group");
  }
});

test("unknown result stops the plan and cannot replay the request", () => {
  const plan = buildWalmartListingFullSurfacePlan(fixture());
  const unknown = outcome(plan, 0, "UNKNOWN");
  assert.deepEqual(nextWalmartListingFullSurfaceAction(plan, [unknown]), {
    action: "STOP_NO_REPLAY",
    operation_id: "shipping-template-create",
    reason: "UNKNOWN",
  });
});

test("feed evaluation preserves exact Walmart item-level failure codes", () => {
  const verdict = evaluateWalmartListingFullSurfaceFeed({
    feedId: "feed-1",
    feedStatus: "PROCESSED",
    itemsReceived: 3,
    itemsSucceeded: 0,
    itemsFailed: 3,
    itemDetails: {
      itemIngestionStatus: [
        {
          sku: "FaisalX-1433",
          ingestionStatus: "DATA_ERROR",
          ingestionErrors: {
            ingestionError: [{
              code: "ERR_EXT_DATA_0101119",
              field: "QARTH",
            }],
          },
        },
        {
          sku: "FaisalX-1434",
          ingestionStatus: "DATA_ERROR",
          ingestionErrors: {
            ingestionError: [{
              code: "ERR_EXT_DATA_0101119",
              field: "QARTH",
            }],
          },
        },
        {
          sku: "FaisalX-1435",
          ingestionStatus: "DATA_ERROR",
          ingestionErrors: {
            ingestionError: [{
              code: "ERR_EXT_DATA_0101119",
              field: "QARTH",
            }],
          },
        },
      ],
    },
  }, "feed-1", ["FaisalX-1433", "FaisalX-1434", "FaisalX-1435"]);
  assert.deepEqual(verdict, {
    state: "FAILED",
    reason: "FEED_ITEMS_FAILED_OR_MISSING:ERR_EXT_DATA_0101119",
    failure_codes: ["ERR_EXT_DATA_0101119"],
  });
});

test("feed evaluation accepts only an exact all-SKU success set", () => {
  const verdict = evaluateWalmartListingFullSurfaceFeed({
    feedId: "feed-2",
    feedStatus: "PROCESSED",
    itemsReceived: 2,
    itemsSucceeded: 2,
    itemsFailed: 0,
    itemDetails: {
      itemIngestionStatus: [
        { sku: "FaisalX-1433", ingestionStatus: "SUCCESS" },
        { sku: "FaisalX-1434", ingestionStatus: "SUCCESS" },
      ],
    },
  }, "feed-2", ["FaisalX-1433", "FaisalX-1434"]);
  assert.deepEqual(verdict, { state: "SUCCEEDED", reason: null });
});
