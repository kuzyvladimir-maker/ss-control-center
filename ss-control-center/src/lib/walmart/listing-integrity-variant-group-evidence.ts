/**
 * Read-only evidence compiler for the narrow Walmart single-member
 * variant-group repair lane.
 *
 * It performs no I/O. Callers must supply exact bytes from a canonical ITEM v6
 * catalog source, its decoded report, a fresh seller item, and the matching
 * MP_MAINTENANCE Get Spec response.
 */

import { createHash } from "node:crypto";

import {
  verifyWalmartItemReportCatalogSource,
} from "./item-report-published-source.ts";
import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";

export const WALMART_LISTING_VARIANT_GROUP_EVIDENCE_SCHEMA =
  "walmart-listing-variant-group-repair-evidence/v2" as const;
export const WALMART_LISTING_VARIANT_GROUP_ALL_ITEMS_RECEIPT_SCHEMA =
  "walmart-listing-variant-group-all-items-receipt/v1" as const;

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_AGE_MS = 48 * 60 * 60 * 1_000;
const REQUIRED_HEADERS = [
  "SKU",
  "Item ID",
  "Lifecycle Status",
  "Publish Status",
  "Product Type",
  "Variant Group Id",
  "Primary Variant?",
  "Variant Grouping Attributes",
  "Variant Grouping Values",
] as const;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingVariantGroupRepairEvidence {
  schema_version: typeof WALMART_LISTING_VARIANT_GROUP_EVIDENCE_SCHEMA;
  created_at: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
    product_type: string;
  };
  current_group: {
    variant_group_id: string;
    exact_member_count: 1;
    current_is_primary_variant: "No";
    grouping_attributes: [{
      name: "flavor";
      value: string;
    }];
  };
  requested_group_update: {
    variant_group_id: string;
    variant_attribute_names: ["flavor"];
    is_primary_variant: "Yes";
    flavor: string;
    count: number;
    count_per_pack: 1;
    multipack_quantity: number;
  };
  population_authority: {
    catalog_source_body_sha256: string;
    catalog_source_file_sha256: string;
    decoded_report_sha256: string;
    report_request_id_sha256: string;
    report_cutoff_at: string;
    catalog_population_complete: true;
    unique_listing_count: number;
    exact_group_member_source_record_sha256: string;
    all_items_receipt_body_sha256: string;
    all_items_response_sha256: string;
    all_items_variant_group_id: string;
    all_items_total_items: 1;
    all_items_exact_member_count: 1;
    group_completeness_authority:
      "FRESH_WALMART_ALL_ITEMS_VARIANT_GROUP_FILTER";
  };
  live_authority: {
    seller_item_file_sha256: string;
    get_spec_response_file_sha256: string;
    seller_group_matches_report: true;
    current_spec_supports_exact_group_fields: true;
  };
  claims: {
    read_only: true;
    exact_single_member_group: true;
    complete_group_submission_count: 1;
    price_unchanged: true;
    inventory_unchanged: true;
    listing_status_unchanged: true;
    walmart_writes_authorized: false;
  };
  body_sha256: string;
}

export interface WalmartListingVariantGroupAllItemsReceipt {
  schema_version:
    typeof WALMART_LISTING_VARIANT_GROUP_ALL_ITEMS_RECEIPT_SCHEMA;
  method: "GET";
  path: "/v3/items";
  query: {
    variantGroupId: string;
    limit: 200;
    offset: 0;
  };
  response_content_type: "application/json";
  http_status: 200;
  correlation_id_sha256: string;
  seller_account_fingerprint_sha256: string;
  response_payload_sha256: string;
  captured_at: string;
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart variant-group evidence rejected input: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return parsed;
}

function exactBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 2
    || value.byteLength > MAX_BYTES) {
    fail(`${label} must be bounded exact bytes`);
  }
  return Uint8Array.from(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed))
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be a canonical ISO instant`);
  }
  return parsed;
}

function parseJsonBytes(value: Uint8Array, label: string): JsonRecord {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
      label,
    );
  } catch {
    return fail(`${label} must be UTF-8 JSON`);
  }
}

function parseCsvRows(value: Uint8Array): string[][] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((entry) => entry !== "")) rows.push(row);
    row = [];
    if (rows.length > 100_000) fail("decoded ITEM report exceeds row cap");
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === "\"" && source[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
        quoteClosed = true;
      } else {
        field += character;
      }
      continue;
    }
    if (character === "\"") {
      if (field !== "" || quoteClosed) fail("decoded ITEM report has malformed quotes");
      quoted = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\n") {
      pushRow();
    } else if (character === "\r") {
      if (source[index + 1] === "\n") continue;
      pushRow();
    } else {
      if (quoteClosed) fail("decoded ITEM report has text after a closing quote");
      field += character;
      if (field.length > 1_000_000) fail("decoded ITEM report field exceeds cap");
    }
  }
  if (quoted) fail("decoded ITEM report has an unterminated quote");
  if (field !== "" || row.length > 0) pushRow();
  if (rows.length < 2) fail("decoded ITEM report has no data rows");
  const width = rows[0]!.length;
  if (width < REQUIRED_HEADERS.length || width > 500
    || rows.some((entry) => entry.length !== width)) {
    fail("decoded ITEM report has an invalid rectangular shape");
  }
  return rows;
}

function reportIndex(header: readonly string[], name: string): number {
  const matches = header
    .map((entry, index) => entry === name ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) fail(`decoded ITEM report needs one ${name} column`);
  return matches[0]!;
}

function getSpecProductProperties(
  response: JsonRecord,
  productType: string,
): JsonRecord {
  let schemaValue = Object.hasOwn(response, "schema")
    ? response.schema
    : response;
  if (typeof schemaValue === "string") {
    try {
      schemaValue = JSON.parse(schemaValue);
    } catch {
      fail("Get Spec schema string is invalid JSON");
    }
  }
  const schema = record(schemaValue, "Get Spec schema");
  const properties = record(schema.properties, "Get Spec schema.properties");
  const mpItem = record(properties.MPItem, "Get Spec MPItem");
  const item = record(mpItem.items, "Get Spec MPItem.items");
  const itemProperties = record(item.properties, "Get Spec MPItem properties");
  const visible = record(itemProperties.Visible, "Get Spec Visible");
  const visibleProperties = record(
    visible.properties,
    "Get Spec Visible.properties",
  );
  const product = record(
    visibleProperties[productType],
    `Get Spec Visible.${productType}`,
  );
  return record(product.properties, `Get Spec ${productType}.properties`);
}

function enumContains(
  properties: JsonRecord,
  field: string,
  expected: string,
): boolean {
  const definition = record(properties[field], `Get Spec ${field}`);
  const target = field === "variantAttributeNames"
    ? record(definition.items, `Get Spec ${field}.items`)
    : definition;
  return Array.isArray(target.enum) && target.enum.includes(expected);
}

export function buildWalmartListingVariantGroupRepairEvidence(input: {
  created_at: string;
  listing: {
    store_index: number;
    sku: string;
    item_id: string;
  };
  target: {
    flavor: string;
    count: number;
    count_per_pack: 1;
    multipack_quantity: number;
  };
  catalog_source_bytes: Uint8Array;
  decoded_item_report_bytes: Uint8Array;
  live_item_response_bytes: Uint8Array;
  get_spec_response_bytes: Uint8Array;
  all_items_response_bytes: Uint8Array;
  all_items_receipt: WalmartListingVariantGroupAllItemsReceipt;
}): WalmartListingVariantGroupRepairEvidence {
  const createdAt = instant(input.created_at, "created_at");
  const storeIndex = positiveInteger(input.listing.store_index, "store_index");
  const sku = text(input.listing.sku, "sku", 512);
  const itemId = text(input.listing.item_id, "item_id", 64);
  const flavor = text(input.target.flavor, "target flavor", 512);
  const count = positiveInteger(input.target.count, "target count");
  const multipack = positiveInteger(
    input.target.multipack_quantity,
    "target multipack quantity",
  );
  if (input.target.count_per_pack !== 1 || count !== multipack) {
    fail("single-unit multipack target must use count=multipack and countPerPack=1");
  }

  const catalogBytes = exactBytes(input.catalog_source_bytes, "catalog source");
  const reportBytes = exactBytes(input.decoded_item_report_bytes, "decoded report");
  const liveBytes = exactBytes(input.live_item_response_bytes, "live item response");
  const specBytes = exactBytes(input.get_spec_response_bytes, "Get Spec response");
  const allItemsBytes = exactBytes(
    input.all_items_response_bytes,
    "All Items variant-group response",
  );
  const catalogRaw = parseJsonBytes(catalogBytes, "catalog source");
  const catalog = verifyWalmartItemReportCatalogSource(catalogRaw);
  if (catalog.account_scope.channel !== "WALMART_US"
    || catalog.account_scope.store_index !== storeIndex
    || catalog.catalog_population_complete !== true
    || catalog.report.report_type !== "ITEM"
    || catalog.report.report_version !== "v6"
    || catalog.report.decoded_report_sha256 !== sha256(reportBytes)) {
    fail("catalog source is not the complete matching ITEM v6 decoded report");
  }
  const reportCutoff = instant(catalog.report.cutoff_at, "report cutoff_at");
  const age = Date.parse(createdAt) - Date.parse(reportCutoff);
  if (age < 0 || age > MAX_REPORT_AGE_MS) {
    fail("catalog source is future-dated or older than 48 hours");
  }

  const rows = parseCsvRows(reportBytes);
  const header = rows[0]!;
  for (const required of REQUIRED_HEADERS) reportIndex(header, required);
  const indexes = Object.fromEntries(REQUIRED_HEADERS.map((name) => (
    [name, reportIndex(header, name)]
  ))) as Record<typeof REQUIRED_HEADERS[number], number>;
  const groupRows = rows.slice(1).filter((row) => (
    row[indexes["Variant Group Id"]] !== ""
    && row[indexes["Variant Group Id"]] === row[indexes["Variant Group Id"]]!.trim()
  ));
  const listingRow = groupRows.find((row) => row[indexes.SKU] === sku);
  if (!listingRow) fail("exact SKU is absent from ITEM report variant groups");
  const groupId = text(
    listingRow[indexes["Variant Group Id"]],
    "report Variant Group Id",
    300,
  );
  if (listingRow[indexes["Item ID"]] !== itemId
    || listingRow[indexes["Lifecycle Status"]] !== "ACTIVE"
    || listingRow[indexes["Publish Status"]] !== "PUBLISHED"
    || listingRow[indexes["Primary Variant?"]] !== "N"
    || listingRow[indexes["Variant Grouping Attributes"]] !== "flavor") {
    fail("listing is not an exact active, published, non-primary flavor row");
  }
  const currentFlavor = text(
    listingRow[indexes["Variant Grouping Values"]],
    "report Variant Grouping Values",
    512,
  );
  const productType = text(
    listingRow[indexes["Product Type"]],
    "report Product Type",
    512,
  );

  const live = parseJsonBytes(liveBytes, "live item response");
  if (!Array.isArray(live.ItemResponse) || live.ItemResponse.length !== 1) {
    fail("live item response must contain one ItemResponse");
  }
  const liveRow = record(live.ItemResponse[0], "live ItemResponse[0]");
  const groupInfo = record(liveRow.variantGroupInfo, "live variantGroupInfo");
  if (liveRow.sku !== sku || liveRow.productType !== productType
    || liveRow.publishedStatus !== "PUBLISHED"
    || liveRow.lifecycleStatus !== "ACTIVE"
    || liveRow.variantGroupId !== groupId
    || groupInfo.isPrimary !== false
    || !Array.isArray(groupInfo.groupingAttributes)
    || groupInfo.groupingAttributes.length !== 1) {
    fail("fresh live item does not match the exact single-member report group");
  }
  const liveGrouping = record(
    groupInfo.groupingAttributes[0],
    "live groupingAttributes[0]",
  );
  if (liveGrouping.name !== "flavor" || liveGrouping.value !== currentFlavor) {
    fail("fresh live grouping attribute differs from ITEM report");
  }

  const allItemsReceipt = input.all_items_receipt;
  const allItemsReceiptBody = {
    schema_version: allItemsReceipt.schema_version,
    method: allItemsReceipt.method,
    path: allItemsReceipt.path,
    query: allItemsReceipt.query,
    response_content_type: allItemsReceipt.response_content_type,
    http_status: allItemsReceipt.http_status,
    correlation_id_sha256: allItemsReceipt.correlation_id_sha256,
    seller_account_fingerprint_sha256:
      allItemsReceipt.seller_account_fingerprint_sha256,
    response_payload_sha256: allItemsReceipt.response_payload_sha256,
    captured_at: allItemsReceipt.captured_at,
  };
  if (allItemsReceipt.schema_version
      !== WALMART_LISTING_VARIANT_GROUP_ALL_ITEMS_RECEIPT_SCHEMA
    || allItemsReceipt.method !== "GET"
    || allItemsReceipt.path !== "/v3/items"
    || allItemsReceipt.query.variantGroupId !== groupId
    || allItemsReceipt.query.limit !== 200
    || allItemsReceipt.query.offset !== 0
    || allItemsReceipt.response_content_type !== "application/json"
    || allItemsReceipt.http_status !== 200
    || allItemsReceipt.response_payload_sha256 !== sha256(allItemsBytes)
    || walmartListingIntegritySha256(allItemsReceiptBody)
      !== allItemsReceipt.body_sha256) {
    fail("All Items receipt is not bound to the exact variant group response");
  }
  const allItemsCapturedAt = instant(
    allItemsReceipt.captured_at,
    "All Items captured_at",
  );
  const allItemsAge = Date.parse(createdAt) - Date.parse(allItemsCapturedAt);
  if (allItemsAge < 0 || allItemsAge > 30 * 60 * 1_000) {
    fail("All Items variant-group response is future-dated or older than 30 minutes");
  }
  const allItems = parseJsonBytes(
    allItemsBytes,
    "All Items variant-group response",
  );
  if (!Array.isArray(allItems.ItemResponse)
    || allItems.ItemResponse.length !== 1
    || allItems.totalItems !== 1) {
    fail("fresh All Items response does not prove one complete variant-group member");
  }
  const allItemsRow = record(
    allItems.ItemResponse[0],
    "All Items ItemResponse[0]",
  );
  const allItemsGroupInfo = record(
    allItemsRow.variantGroupInfo,
    "All Items ItemResponse[0].variantGroupInfo",
  );
  if (allItemsRow.sku !== sku
    || allItemsRow.variantGroupId !== groupId
    || allItemsRow.productType !== productType
    || allItemsRow.publishedStatus !== "PUBLISHED"
    || allItemsRow.lifecycleStatus !== "ACTIVE"
    || allItemsGroupInfo.isPrimary !== false
    || !Array.isArray(allItemsGroupInfo.groupingAttributes)
    || allItemsGroupInfo.groupingAttributes.length !== 1) {
    fail("fresh All Items member differs from the exact live/report listing");
  }
  const allItemsGrouping = record(
    allItemsGroupInfo.groupingAttributes[0],
    "All Items groupingAttributes[0]",
  );
  if (allItemsGrouping.name !== "flavor"
    || allItemsGrouping.value !== currentFlavor) {
    fail("fresh All Items grouping attribute differs from exact live/report evidence");
  }

  const spec = parseJsonBytes(specBytes, "Get Spec response");
  const specProperties = getSpecProductProperties(spec, productType);
  for (const field of [
    "variantGroupId",
    "variantAttributeNames",
    "isPrimaryVariant",
    "flavor",
    "count",
    "countPerPack",
    "multipackQuantity",
  ]) {
    if (!Object.hasOwn(specProperties, field)) {
      fail(`current MP_MAINTENANCE spec does not support ${field}`);
    }
  }
  if (!enumContains(specProperties, "variantAttributeNames", "flavor")
    || !enumContains(specProperties, "isPrimaryVariant", "Yes")) {
    fail("current MP_MAINTENANCE spec rejects the required group enums");
  }

  const sourceRecord = catalog.rows.find((row) => row.sku === sku);
  if (!sourceRecord || sourceRecord.reported_legacy_item_identifier_opaque !== itemId
    || sourceRecord.published_status !== "PUBLISHED"
    || sourceRecord.reported_lifecycle_status !== "ACTIVE") {
    fail("canonical catalog projection differs from the decoded group row");
  }
  const body = {
    schema_version: WALMART_LISTING_VARIANT_GROUP_EVIDENCE_SCHEMA,
    created_at: createdAt,
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku,
      listing_key: `walmart:${storeIndex}:${sku}`,
      item_id: itemId,
      product_type: productType,
    },
    current_group: {
      variant_group_id: groupId,
      exact_member_count: 1 as const,
      current_is_primary_variant: "No" as const,
      grouping_attributes: [{
        name: "flavor" as const,
        value: currentFlavor,
      }] as [{
        name: "flavor";
        value: string;
      }],
    },
    requested_group_update: {
      variant_group_id: groupId,
      variant_attribute_names: ["flavor"] as ["flavor"],
      is_primary_variant: "Yes" as const,
      flavor,
      count,
      count_per_pack: 1 as const,
      multipack_quantity: multipack,
    },
    population_authority: {
      catalog_source_body_sha256: catalog.body_sha256,
      catalog_source_file_sha256: sha256(catalogBytes),
      decoded_report_sha256: sha256(reportBytes),
      report_request_id_sha256: catalog.report.report_request_id_sha256,
      report_cutoff_at: reportCutoff,
      catalog_population_complete: true as const,
      unique_listing_count: catalog.reconciliation.unique_listing_count,
      exact_group_member_source_record_sha256:
        sourceRecord.source_record_sha256,
      all_items_receipt_body_sha256: allItemsReceipt.body_sha256,
      all_items_response_sha256: sha256(allItemsBytes),
      all_items_variant_group_id: groupId,
      all_items_total_items: 1 as const,
      all_items_exact_member_count: 1 as const,
      group_completeness_authority:
        "FRESH_WALMART_ALL_ITEMS_VARIANT_GROUP_FILTER" as const,
    },
    live_authority: {
      seller_item_file_sha256: sha256(liveBytes),
      get_spec_response_file_sha256: sha256(specBytes),
      seller_group_matches_report: true as const,
      current_spec_supports_exact_group_fields: true as const,
    },
    claims: {
      read_only: true as const,
      exact_single_member_group: true as const,
      complete_group_submission_count: 1 as const,
      price_unchanged: true as const,
      inventory_unchanged: true as const,
      listing_status_unchanged: true as const,
      walmart_writes_authorized: false as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
}

/**
 * Strict self-consistency verifier for an owner-packaged evidence object.
 * Creation provenance is established by the builder from exact input bytes;
 * this verifier prevents mutation or widening after the artifact is sealed.
 */
export function verifyWalmartListingVariantGroupRepairEvidence(
  input: unknown,
): WalmartListingVariantGroupRepairEvidence {
  const raw = record(input, "evidence");
  exactKeys(raw, [
    "schema_version",
    "created_at",
    "listing",
    "current_group",
    "requested_group_update",
    "population_authority",
    "live_authority",
    "claims",
    "body_sha256",
  ], "evidence");
  if (raw.schema_version !== WALMART_LISTING_VARIANT_GROUP_EVIDENCE_SCHEMA) {
    fail("evidence schema version is invalid");
  }
  const createdAt = instant(raw.created_at, "evidence created_at");

  const listing = record(raw.listing, "evidence listing");
  exactKeys(listing, [
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "item_id",
    "product_type",
  ], "evidence listing");
  const storeIndex = positiveInteger(
    listing.store_index,
    "evidence listing store_index",
  );
  const sku = text(listing.sku, "evidence listing sku", 512);
  const itemId = text(listing.item_id, "evidence listing item_id", 64);
  if (listing.channel !== "WALMART_US"
    || listing.listing_key !== `walmart:${storeIndex}:${sku}`
    || !/^\d+$/u.test(itemId)) {
    fail("evidence listing identity is invalid");
  }
  const productType = text(
    listing.product_type,
    "evidence listing product_type",
    512,
  );

  const current = record(raw.current_group, "evidence current_group");
  exactKeys(current, [
    "variant_group_id",
    "exact_member_count",
    "current_is_primary_variant",
    "grouping_attributes",
  ], "evidence current_group");
  const groupId = text(
    current.variant_group_id,
    "evidence current_group variant_group_id",
    512,
  );
  if (current.exact_member_count !== 1
    || current.current_is_primary_variant !== "No"
    || !Array.isArray(current.grouping_attributes)
    || current.grouping_attributes.length !== 1) {
    fail("evidence current_group is not one non-primary member");
  }
  const grouping = record(
    current.grouping_attributes[0],
    "evidence current_group grouping_attributes[0]",
  );
  exactKeys(
    grouping,
    ["name", "value"],
    "evidence current_group grouping_attributes[0]",
  );
  if (grouping.name !== "flavor") {
    fail("evidence current_group grouping field must be flavor");
  }
  const currentFlavor = text(
    grouping.value,
    "evidence current_group flavor",
    512,
  );

  const requested = record(
    raw.requested_group_update,
    "evidence requested_group_update",
  );
  exactKeys(requested, [
    "variant_group_id",
    "variant_attribute_names",
    "is_primary_variant",
    "flavor",
    "count",
    "count_per_pack",
    "multipack_quantity",
  ], "evidence requested_group_update");
  const targetFlavor = text(
    requested.flavor,
    "evidence requested flavor",
    512,
  );
  const targetCount = positiveInteger(
    requested.count,
    "evidence requested count",
  );
  if (requested.variant_group_id !== groupId
    || !Array.isArray(requested.variant_attribute_names)
    || requested.variant_attribute_names.length !== 1
    || requested.variant_attribute_names[0] !== "flavor"
    || requested.is_primary_variant !== "Yes"
    || requested.count_per_pack !== 1
    || requested.multipack_quantity !== targetCount) {
    fail("evidence requested_group_update is invalid");
  }

  const population = record(
    raw.population_authority,
    "evidence population_authority",
  );
  exactKeys(population, [
    "catalog_source_body_sha256",
    "catalog_source_file_sha256",
    "decoded_report_sha256",
    "report_request_id_sha256",
    "report_cutoff_at",
    "catalog_population_complete",
    "unique_listing_count",
    "exact_group_member_source_record_sha256",
    "all_items_receipt_body_sha256",
    "all_items_response_sha256",
    "all_items_variant_group_id",
    "all_items_total_items",
    "all_items_exact_member_count",
    "group_completeness_authority",
  ], "evidence population_authority");
  if (population.catalog_population_complete !== true) {
    fail("evidence population is not complete");
  }
  if (population.all_items_variant_group_id !== groupId
    || population.all_items_total_items !== 1
    || population.all_items_exact_member_count !== 1
    || population.group_completeness_authority
      !== "FRESH_WALMART_ALL_ITEMS_VARIANT_GROUP_FILTER") {
    fail("evidence All Items population authority is invalid");
  }
  const populationParsed = {
    catalog_source_body_sha256: digest(
      population.catalog_source_body_sha256,
      "evidence catalog source body SHA",
    ),
    catalog_source_file_sha256: digest(
      population.catalog_source_file_sha256,
      "evidence catalog source file SHA",
    ),
    decoded_report_sha256: digest(
      population.decoded_report_sha256,
      "evidence decoded report SHA",
    ),
    report_request_id_sha256: digest(
      population.report_request_id_sha256,
      "evidence report request ID SHA",
    ),
    report_cutoff_at: instant(
      population.report_cutoff_at,
      "evidence report cutoff_at",
    ),
    catalog_population_complete: true as const,
    unique_listing_count: positiveInteger(
      population.unique_listing_count,
      "evidence unique listing count",
    ),
    exact_group_member_source_record_sha256: digest(
      population.exact_group_member_source_record_sha256,
      "evidence group source record SHA",
    ),
    all_items_receipt_body_sha256: digest(
      population.all_items_receipt_body_sha256,
      "evidence All Items receipt body SHA",
    ),
    all_items_response_sha256: digest(
      population.all_items_response_sha256,
      "evidence All Items response SHA",
    ),
    all_items_variant_group_id: text(
      population.all_items_variant_group_id,
      "evidence All Items variant group ID",
      512,
    ),
    all_items_total_items: 1 as const,
    all_items_exact_member_count: 1 as const,
    group_completeness_authority:
      "FRESH_WALMART_ALL_ITEMS_VARIANT_GROUP_FILTER" as const,
  };
  const age = Date.parse(createdAt) - Date.parse(populationParsed.report_cutoff_at);
  if (age < 0 || age > MAX_REPORT_AGE_MS) {
    fail("sealed evidence is future-dated or used a report older than 48 hours");
  }

  const live = record(raw.live_authority, "evidence live_authority");
  exactKeys(live, [
    "seller_item_file_sha256",
    "get_spec_response_file_sha256",
    "seller_group_matches_report",
    "current_spec_supports_exact_group_fields",
  ], "evidence live_authority");
  if (live.seller_group_matches_report !== true
    || live.current_spec_supports_exact_group_fields !== true) {
    fail("evidence live authority claims are invalid");
  }
  const liveParsed = {
    seller_item_file_sha256: digest(
      live.seller_item_file_sha256,
      "evidence seller item file SHA",
    ),
    get_spec_response_file_sha256: digest(
      live.get_spec_response_file_sha256,
      "evidence Get Spec response file SHA",
    ),
    seller_group_matches_report: true as const,
    current_spec_supports_exact_group_fields: true as const,
  };

  const claims = record(raw.claims, "evidence claims");
  exactKeys(claims, [
    "read_only",
    "exact_single_member_group",
    "complete_group_submission_count",
    "price_unchanged",
    "inventory_unchanged",
    "listing_status_unchanged",
    "walmart_writes_authorized",
  ], "evidence claims");
  if (claims.read_only !== true
    || claims.exact_single_member_group !== true
    || claims.complete_group_submission_count !== 1
    || claims.price_unchanged !== true
    || claims.inventory_unchanged !== true
    || claims.listing_status_unchanged !== true
    || claims.walmart_writes_authorized !== false) {
    fail("evidence safety claims are invalid");
  }

  const parsedBody = {
    schema_version: WALMART_LISTING_VARIANT_GROUP_EVIDENCE_SCHEMA,
    created_at: createdAt,
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku,
      listing_key: `walmart:${storeIndex}:${sku}`,
      item_id: itemId,
      product_type: productType,
    },
    current_group: {
      variant_group_id: groupId,
      exact_member_count: 1 as const,
      current_is_primary_variant: "No" as const,
      grouping_attributes: [{
        name: "flavor" as const,
        value: currentFlavor,
      }] as [{
        name: "flavor";
        value: string;
      }],
    },
    requested_group_update: {
      variant_group_id: groupId,
      variant_attribute_names: ["flavor"] as ["flavor"],
      is_primary_variant: "Yes" as const,
      flavor: targetFlavor,
      count: targetCount,
      count_per_pack: 1 as const,
      multipack_quantity: targetCount,
    },
    population_authority: populationParsed,
    live_authority: liveParsed,
    claims: {
      read_only: true as const,
      exact_single_member_group: true as const,
      complete_group_submission_count: 1 as const,
      price_unchanged: true as const,
      inventory_unchanged: true as const,
      listing_status_unchanged: true as const,
      walmart_writes_authorized: false as const,
    },
  };
  const bodySha256 = digest(raw.body_sha256, "evidence body SHA");
  if (walmartListingIntegritySha256(parsedBody) !== bodySha256) {
    fail("evidence body SHA mismatch");
  }
  return { ...parsedBody, body_sha256: bodySha256 };
}
