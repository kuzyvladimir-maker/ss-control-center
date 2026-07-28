import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
} from "../item-report-published-source.ts";
import {
  buildWalmartListingVariantGroupRepairEvidence,
  WALMART_LISTING_VARIANT_GROUP_ALL_ITEMS_RECEIPT_SCHEMA,
  verifyWalmartListingVariantGroupRepairEvidence,
} from "../listing-integrity-variant-group-evidence.ts";

const REPORT_HEADER = [
  "SKU",
  "Item ID",
  "Product Name",
  "Lifecycle Status",
  "Publish Status",
  "Product Type",
  "Variant Group Id",
  "Primary Variant?",
  "Variant Grouping Attributes",
  "Variant Grouping Values",
];

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function csv(rows: string[][]): Buffer {
  return Buffer.from(`${rows.map((row) => row.map((field) => (
    /[",\r\n]/u.test(field) ? `"${field.replaceAll("\"", "\"\"")}"` : field
  )).join(",")).join("\r\n")}\r\n`, "utf8");
}

function fixture(options: {
  extraGroupMember?: boolean;
  specSupportsGroup?: boolean;
  createdAt?: string;
} = {}) {
  const report = csv([
    REPORT_HEADER,
    [
      "FaisalX-2768",
      "1838619805",
      "Campbell's Golden Mushroom Soup, Quantity of 4",
      "ACTIVE",
      "PUBLISHED",
      "Prepared & Packaged Soups",
      "campCondGoldMush",
      "N",
      "flavor",
      "qty 4",
    ],
    ...(options.extraGroupMember ? [[
      "OTHER-SKU",
      "9999999999",
      "Another soup",
      "ACTIVE",
      "PUBLISHED",
      "Prepared & Packaged Soups",
      "campCondGoldMush",
      "Y",
      "flavor",
      "qty 2",
    ]] : []),
  ]);
  const sourceRecord = {
    channel: "WALMART_US",
    store_index: 1,
    sku: "FaisalX-2768",
    listing_key: "walmart:1:FaisalX-2768",
    published_status: "PUBLISHED",
    reported_lifecycle_status: "ACTIVE",
    reported_lifecycle_status_header: "Lifecycle Status",
    reported_product_identifier_header: "UPC",
    reported_product_identifier_opaque: "684611928177",
    reported_product_identifier_type_header: "UPC",
    reported_product_identifier_type_opaque: "UPC",
    reported_legacy_item_identifier_header: "Item ID",
    reported_legacy_item_identifier_opaque: "1838619805",
    reported_legacy_wpid_header: "WPID",
    reported_legacy_wpid_opaque: "1MD37R331C2K",
    reported_product_name: "Campbell's Golden Mushroom Soup, Quantity of 4",
    reported_product_name_header: "Product Name",
    reported_brand: "Campbell's",
    reported_brand_header: "Brand",
    reported_product_condition: "New",
    reported_product_condition_header: "Product Condition",
    source_record_number: 2,
    source_record_sha256: "a".repeat(64),
  };
  const rows = [sourceRecord];
  const publishedRows = rows;
  const body = {
    schema_version: "walmart-item-report-catalog-source/v1",
    account_scope: {
      channel: "WALMART_US",
      store_index: 1,
      seller_account_fingerprint_sha256: "b".repeat(64),
    },
    report: {
      source_system: "walmart_marketplace_api",
      report_type: "ITEM",
      report_version: "v6",
      report_request_id: "report-request-1",
      report_request_id_sha256: sha256("report-request-1"),
      requested_at: "2026-07-26T16:14:12.000Z",
      cutoff_at: "2026-07-26T16:35:05.671Z",
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      downloaded_at: "2026-07-26T17:56:42.033Z",
      raw_transport_sha256: "c".repeat(64),
      decoded_report_sha256: sha256(report),
      parsed_data_record_count: 1,
    },
    published_source: {
      schema_version: "walmart-item-report-published-source/v1",
      source_id: `walmart-item-report-published-${"d".repeat(16)}`,
      body_sha256: "d".repeat(64),
    },
    status_semantics: {
      policy_id: "walmart-item-v6-all-status-catalog/v1",
      inclusion_rule: "ALL_REPORT_ROWS",
      included_published_statuses: [
        "PUBLISHED",
        "SYSTEM_PROBLEM",
        "UNPUBLISHED",
      ],
      accepted_lifecycle_statuses: ["ACTIVE", "ARCHIVED", "RETIRED"],
      lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY",
    },
    reconciliation: {
      parsed_data_record_count: 1,
      output_row_count: 1,
      unique_listing_count: 1,
      rows_sha256: walmartItemReportSha256(rows),
      published_row_count: 1,
      published_rows_sha256: walmartItemReportSha256(publishedRows),
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: [
        { status: "PUBLISHED", count: 1 },
        { status: "SYSTEM_PROBLEM", count: 0 },
        { status: "UNPUBLISHED", count: 0 },
      ],
      lifecycle_status_counts: [
        { status: "ACTIVE", count: 1 },
        { status: "ARCHIVED", count: 0 },
        { status: "RETIRED", count: 0 },
      ],
      lifecycle_status_not_reported_count: 0,
    },
    catalog_population_complete: true,
    rows,
  };
  const catalogBodySha = walmartItemReportSha256(body);
  const catalog = {
    ...body,
    source_id: `walmart-item-report-catalog-${catalogBodySha.slice(0, 16)}`,
    body_sha256: catalogBodySha,
  };
  const groupProperties = options.specSupportsGroup === false ? {} : {
    variantGroupId: { type: "string" },
    variantAttributeNames: {
      type: "array",
      items: { type: "string", enum: ["flavor"] },
    },
    isPrimaryVariant: { type: "string", enum: ["No", "Yes"] },
  };
  const spec = {
    schema: {
      properties: {
        MPItem: {
          items: {
            properties: {
              Visible: {
                properties: {
                  "Prepared & Packaged Soups": {
                    properties: {
                      ...groupProperties,
                      flavor: { type: "string" },
                      count: { type: "integer" },
                      countPerPack: { type: "integer" },
                      multipackQuantity: { type: "integer" },
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
  const live = {
    ItemResponse: [{
      sku: "FaisalX-2768",
      productType: "Prepared & Packaged Soups",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      variantGroupId: "campCondGoldMush",
      variantGroupInfo: {
        isPrimary: false,
        groupingAttributes: [{ name: "flavor", value: "qty 4" }],
      },
    }],
  };
  const allItems = {
    ItemResponse: [
      ...live.ItemResponse,
      ...(options.extraGroupMember ? [{
        sku: "OTHER-SKU",
        productType: "Prepared & Packaged Soups",
        publishedStatus: "PUBLISHED",
        lifecycleStatus: "ACTIVE",
        variantGroupId: "campCondGoldMush",
        variantGroupInfo: {
          isPrimary: true,
          groupingAttributes: [{ name: "flavor", value: "qty 2" }],
        },
      }] : []),
    ],
    totalItems: options.extraGroupMember ? 2 : 1,
  };
  const allItemsBytes = bytes(allItems);
  const allItemsReceiptBody = {
    schema_version:
      WALMART_LISTING_VARIANT_GROUP_ALL_ITEMS_RECEIPT_SCHEMA,
    method: "GET" as const,
    path: "/v3/items" as const,
    query: {
      variantGroupId: "campCondGoldMush",
      limit: 200 as const,
      offset: 0 as const,
    },
    response_content_type: "application/json" as const,
    http_status: 200 as const,
    correlation_id_sha256: "e".repeat(64),
    seller_account_fingerprint_sha256: "b".repeat(64),
    response_payload_sha256: sha256(allItemsBytes),
    captured_at: "2026-07-27T21:34:00.000Z",
  };
  return {
    input: {
      created_at: options.createdAt ?? "2026-07-27T21:35:00.000Z",
      listing: {
        store_index: 1,
        sku: "FaisalX-2768",
        item_id: "1838619805",
      },
      target: {
        flavor: "Golden Mushroom",
        count: 4,
        count_per_pack: 1 as const,
        multipack_quantity: 4,
      },
      catalog_source_bytes: bytes(catalog),
      decoded_item_report_bytes: report,
      live_item_response_bytes: bytes(live),
      get_spec_response_bytes: bytes(spec),
      all_items_response_bytes: allItemsBytes,
      all_items_receipt: {
        ...allItemsReceiptBody,
        body_sha256: walmartItemReportSha256(allItemsReceiptBody),
      },
    },
    catalog,
  };
}

test("seals exact read-only evidence for a complete one-member variant group", () => {
  const { input } = fixture();
  const evidence = buildWalmartListingVariantGroupRepairEvidence(input);
  assert.equal(evidence.current_group.exact_member_count, 1);
  assert.equal(evidence.current_group.variant_group_id, "campCondGoldMush");
  assert.deepEqual(evidence.requested_group_update, {
    variant_group_id: "campCondGoldMush",
    variant_attribute_names: ["flavor"],
    is_primary_variant: "Yes",
    flavor: "Golden Mushroom",
    count: 4,
    count_per_pack: 1,
    multipack_quantity: 4,
  });
  assert.equal(evidence.claims.walmart_writes_authorized, false);
  assert.match(evidence.body_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    verifyWalmartListingVariantGroupRepairEvidence(evidence),
    evidence,
  );
});

test("rejects an incomplete population claim, stale report, or unsupported schema", () => {
  assert.throws(
    () => buildWalmartListingVariantGroupRepairEvidence(
      fixture({ extraGroupMember: true }).input,
    ),
    /does not prove one complete variant-group member/u,
  );
  assert.throws(
    () => buildWalmartListingVariantGroupRepairEvidence(
      fixture({ createdAt: "2026-07-29T21:35:00.000Z" }).input,
    ),
    /older than 48 hours/u,
  );
  assert.throws(
    () => buildWalmartListingVariantGroupRepairEvidence(
      fixture({ specSupportsGroup: false }).input,
    ),
    /does not support variantGroupId/u,
  );
});

test("canonical catalog fixture is independently parseable", () => {
  const { catalog } = fixture();
  assert.match(canonicalWalmartItemReportJson(catalog), /catalog_population_complete/u);
});

test("sealed evidence verifier rejects mutation and widened authority", () => {
  const evidence = buildWalmartListingVariantGroupRepairEvidence(fixture().input);
  const changedTarget = structuredClone(evidence);
  changedTarget.requested_group_update.flavor = "Beef";
  assert.throws(
    () => verifyWalmartListingVariantGroupRepairEvidence(changedTarget),
    /body SHA mismatch/u,
  );
  const widened = structuredClone(evidence) as unknown as {
    claims: { walmart_writes_authorized: boolean };
  };
  widened.claims.walmart_writes_authorized = true;
  assert.throws(
    () => verifyWalmartListingVariantGroupRepairEvidence(widened),
    /safety claims are invalid/u,
  );
});
