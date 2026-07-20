import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
  WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
  WALMART_ITEM_REPORT_LIMITS,
  WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA,
  buildWalmartItemReportDownloadLocatorRequestManifest,
  buildWalmartItemReportFileRequestManifest,
  buildWalmartItemReportReadyRequestManifest,
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  compileWalmartItemReportCatalogSource as compileWalmartItemReportCatalogSourceRaw,
  compileWalmartItemReportPublishedSource as compileWalmartItemReportPublishedSourceRaw,
  compileWalmartShadowPublishedCatalogSourceFromItemReport,
  verifyWalmartItemReportCatalogSource,
  verifyWalmartItemReportCatalogSourceAgainstCapture as verifyWalmartItemReportCatalogSourceAgainstCaptureRaw,
  verifyWalmartItemReportPublishedSource,
  verifyWalmartItemReportPublishedSourceAgainstCapture as verifyWalmartItemReportPublishedSourceAgainstCaptureRaw,
  verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture as verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCaptureRaw,
  verifyWalmartShadowPublishedCatalogSource,
  walmartItemReportSha256,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportUtf8Sha256,
  walmartListingKey,
} from "../item-report-published-source.ts";

const encoder = new TextEncoder();
const REQUEST_ID = "request-item-v6-fixture";
const DOWNLOAD_URL = "https://walmart-reports.s3.amazonaws.com/reports/item-v6.csv?X-Amz-Signature=secret-a";
const CORRELATIONS = Object.freeze({
  create_sha256: walmartItemReportUtf8Sha256("correlation-create"),
  ready_status_sha256: walmartItemReportUtf8Sha256("correlation-ready"),
  download_locator_sha256: walmartItemReportUtf8Sha256("correlation-locator"),
  report_file_sha256: walmartItemReportUtf8Sha256("correlation-file"),
});

const contextV6 = {
  account_scope: {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: "a".repeat(64),
  },
  request_correlations: CORRELATIONS,
  ready_at: "2026-07-18T10:30:00.000Z",
  download_locator_at: "2026-07-18T10:31:00.000Z",
  report_file_requested_at: "2026-07-18T10:32:00.000Z",
  downloaded_at: "2026-07-18T10:33:00.000Z",
};

const v6Header = "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition";

function bytes(text) {
  return encoder.encode(text);
}

function report(header, lines, ending = "\r\n") {
  return bytes([header, ...lines].join(ending) + ending);
}

function binding(correlationSha256, accountScope = contextV6.account_scope) {
  return {
    account_scope: accountScope,
    request_correlation_id_sha256: correlationSha256,
  };
}

function fullCreateRequestManifest(overrides = {}, accountScope = contextV6.account_scope, correlations = CORRELATIONS) {
  return {
    ...buildWalmartItemReportV6CreateRequestManifest(binding(correlations.create_sha256, accountScope)),
    ...overrides,
  };
}

function capture(downloadedBody, overrides = {}, fixture = {}) {
  const requestId = fixture.requestId ?? REQUEST_ID;
  const accountScope = fixture.account_scope ?? contextV6.account_scope;
  const correlations = fixture.correlations ?? CORRELATIONS;
  const downloadUrl = fixture.downloadUrl ?? DOWNLOAD_URL;
  const createRequest = bytes(JSON.stringify(fullCreateRequestManifest({}, accountScope, correlations)));
  const createResponse = bytes(JSON.stringify({
    requestId,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = bytes(JSON.stringify(buildWalmartItemReportReadyRequestManifest(
    requestId,
    binding(correlations.ready_status_sha256, accountScope),
  )));
  const readyStatus = bytes(JSON.stringify({
    requestId,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: "2026-07-18T10:00:00.000Z",
    reportGenerationDate: "2026-07-18T10:20:00.000Z",
    extraProviderField: "preserved-by-byte-seal",
  }));
  const locatorRequest = bytes(JSON.stringify(buildWalmartItemReportDownloadLocatorRequestManifest(
    requestId,
    binding(correlations.download_locator_sha256, accountScope),
  )));
  const locatorResponse = bytes(JSON.stringify({
    requestId,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportGenerationDate: "2026-07-18T10:20:00.000Z",
    downloadURL: downloadUrl,
    downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
  }));
  const fileRequest = bytes(JSON.stringify(buildWalmartItemReportFileRequestManifest({
    ...binding(correlations.report_file_sha256, accountScope),
    locator_url: downloadUrl,
  })));
  const reportRequestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  return {
    create_request_manifest_bytes: createRequest,
    create_response_payload_bytes: createResponse,
    ready_status_request_manifest_bytes: readyRequest,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: downloadedBody,
    ready_status_payload_bytes: readyStatus,
    http: {
      create_response: {
        status: 200,
        content_type: "application/json",
        content_length: createResponse.byteLength,
        echoed_correlation_id_sha256: correlations.create_sha256,
        echoed_report_request_id_sha256: reportRequestIdSha256,
      },
      ready_status_response: {
        status: 200,
        content_type: "application/json",
        content_length: readyStatus.byteLength,
        echoed_correlation_id_sha256: correlations.ready_status_sha256,
        echoed_report_request_id_sha256: reportRequestIdSha256,
      },
      download_locator_response: {
        status: 200,
        content_type: "application/json",
        content_length: locatorResponse.byteLength,
        echoed_correlation_id_sha256: correlations.download_locator_sha256,
        echoed_report_request_id_sha256: reportRequestIdSha256,
      },
      download_response: {
        status: 200,
        content_type: "application/octet-stream",
        content_length: downloadedBody.byteLength,
        echoed_correlation_id_sha256: null,
        echoed_report_request_id_sha256: null,
      },
    },
    ...overrides,
  };
}

function trustedContext(evidence, baseContext = contextV6) {
  const correlationFor = (field) => decodeJson(evidence[field]).authority.request_correlation_id_sha256;
  const seal = (requestField, correlation, responseField, httpField) => (
    walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: evidence[requestField],
      request_correlation_id_sha256: correlation,
      response_payload_bytes: evidence[responseField],
      http: evidence.http[httpField],
    })
  );
  return {
    ...baseContext,
    trusted_exchange_seals: {
      create_response_sha256: seal(
        "create_request_manifest_bytes",
        correlationFor("create_request_manifest_bytes"),
        "create_response_payload_bytes",
        "create_response",
      ),
      ready_status_response_sha256: seal(
        "ready_status_request_manifest_bytes",
        correlationFor("ready_status_request_manifest_bytes"),
        "ready_status_payload_bytes",
        "ready_status_response",
      ),
      download_locator_response_sha256: seal(
        "download_locator_request_manifest_bytes",
        correlationFor("download_locator_request_manifest_bytes"),
        "download_locator_response_payload_bytes",
        "download_locator_response",
      ),
      download_response_sha256: seal(
        "report_file_request_manifest_bytes",
        correlationFor("report_file_request_manifest_bytes"),
        "downloaded_body_bytes",
        "download_response",
      ),
    },
  };
}

function compileWalmartItemReportPublishedSource(evidence, contextInput = contextV6) {
  return compileWalmartItemReportPublishedSourceRaw(evidence, trustedContext(evidence, contextInput));
}

function compileWalmartItemReportCatalogSource(evidence, contextInput = contextV6) {
  return compileWalmartItemReportCatalogSourceRaw(evidence, trustedContext(evidence, contextInput));
}

function verifyWalmartItemReportPublishedSourceAgainstCapture(source, evidence, contextInput = contextV6) {
  return verifyWalmartItemReportPublishedSourceAgainstCaptureRaw(
    source,
    evidence,
    trustedContext(evidence, contextInput),
  );
}

function verifyWalmartItemReportCatalogSourceAgainstCapture(source, evidence, contextInput = contextV6) {
  return verifyWalmartItemReportCatalogSourceAgainstCaptureRaw(
    source,
    evidence,
    trustedContext(evidence, contextInput),
  );
}

function verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(
  bridge,
  source,
  evidence,
  contextInput = contextV6,
) {
  return verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCaptureRaw(
    bridge,
    source,
    evidence,
    trustedContext(evidence, contextInput),
  );
}

function withReadyPayload(evidence, payload) {
  const readyBytes = bytes(JSON.stringify(payload));
  return {
    ...evidence,
    ready_status_payload_bytes: readyBytes,
    http: {
      ...evidence.http,
      ready_status_response: {
        ...evidence.http.ready_status_response,
        content_length: readyBytes.byteLength,
      },
    },
  };
}

function withCreateResponse(evidence, payload) {
  const responseBytes = bytes(JSON.stringify(payload));
  return {
    ...evidence,
    create_response_payload_bytes: responseBytes,
    http: {
      ...evidence.http,
      create_response: {
        ...evidence.http.create_response,
        content_length: responseBytes.byteLength,
      },
    },
  };
}

function withLocatorResponse(evidence, payload) {
  const responseBytes = bytes(JSON.stringify(payload));
  return {
    ...evidence,
    download_locator_response_payload_bytes: responseBytes,
    http: {
      ...evidence.http,
      download_locator_response: {
        ...evidence.http.download_locator_response,
        content_length: responseBytes.byteLength,
      },
    },
  };
}

function withManifestBytes(evidence, field, manifest) {
  return { ...evidence, [field]: bytes(JSON.stringify(manifest)) };
}

function decodeJson(input) {
  return JSON.parse(new TextDecoder().decode(input));
}

function reseal(source) {
  const body = structuredClone(source);
  delete body.source_id;
  delete body.body_sha256;
  const bodySha = walmartItemReportSha256(body);
  return {
    ...body,
    source_id: `walmart-item-report-published-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function sealCatalogEnvelope(source) {
  const body = structuredClone(source);
  delete body.source_id;
  delete body.body_sha256;
  const bodySha = walmartItemReportSha256(body);
  return {
    ...body,
    source_id: `walmart-item-report-catalog-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function resealCatalog(source) {
  const body = structuredClone(source);
  body.reconciliation.rows_sha256 = walmartItemReportSha256(body.rows);
  const publishedRows = body.rows.filter((row) => row.published_status === "PUBLISHED");
  body.reconciliation.published_row_count = publishedRows.length;
  body.reconciliation.published_rows_sha256 = walmartItemReportSha256(publishedRows);
  return sealCatalogEnvelope(body);
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function singleMemberStoredZip(memberName, content) {
  const name = Buffer.from(memberName, "utf8");
  const data = Buffer.from(content);
  const crc = crc32(data);
  const flags = 0x0800;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const centralOffset = local.length + name.length + data.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return new Uint8Array(Buffer.concat([local, name, data, central, name, eocd]));
}

test("compiles documented v6 fields into a sealed, complete PUBLISHED denominator", () => {
  const decoded = report(v6Header, [
    'z:sku,"Example Bread, Wheat",012345678905,UPC,Published,New',
    "A-SKU,Alpha Bread,9781234567890,ISBN,PUBLISHED,New",
    "problem,Problem Bread,1234567890123,EAN,System Problem,New",
    "old,Old Bread,111111111111,UPC,UNPUBLISHED,New",
  ]);
  const evidence = capture(decoded);
  const source = compileWalmartItemReportPublishedSource(evidence, contextV6);

  assert.equal(source.schema_version, WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA);
  assert.equal(source.report.report_version, "v6");
  assert.equal(source.published_population_complete, true);
  assert.equal(source.report.download_transport.detected_container, "plain");
  assert.equal(source.report.create_request.unfiltered_full_report, true);
  assert.equal(source.report.create_request.report_version, "v6");
  assert.equal(source.report.create_response.request_id_exact_match, true);
  assert.equal(source.report.authority_evidence.http_status, 200);
  assert.equal(source.report.authority_evidence.request_id_path_exact_match, true);
  assert.equal(source.report.download_locator.request_id_exact_match, true);
  assert.equal(source.report.download_locator.download_url_sha256, walmartItemReportUtf8Sha256(DOWNLOAD_URL));
  assert.equal(source.report.report_file_request.locator_url_exact_match, true);
  assert.equal(source.report.report_file_request.redirect_count, 0);
  assert.equal(source.report.report_file_request.initial_url_sha256, source.report.download_locator.download_url_sha256);
  assert.equal(source.report.download_locator_at, contextV6.download_locator_at);
  assert.equal(source.report.report_file_requested_at, contextV6.report_file_requested_at);
  assert.equal(source.report.download_transport.http_status, 200);
  assert.equal(source.report.download_transport.bytes_sha256, source.report.decoded_report.bytes_sha256);
  assert.deepEqual(source.report.decoded_report.header_mapping, {
    sku: 0,
    product_name: 1,
    product_id: 2,
    product_id_type: 3,
    published_status: 4,
    lifecycle_status: null,
    product_condition: 5,
    legacy_item_id: null,
    legacy_wpid: null,
  });
  assert.deepEqual(source.rows.map((row) => row.listing_key), [
    "walmart:1:A-SKU",
    "walmart:1:z:sku",
  ]);
  assert.equal(source.rows[0].reported_product_identifier_opaque, "9781234567890");
  assert.equal(source.rows[0].reported_product_identifier_type_opaque, "ISBN");
  assert.equal(source.rows[1].reported_product_name, "Example Bread, Wheat");
  assert.equal(source.rows[0].reported_lifecycle_status, null);
  assert.equal(Object.hasOwn(source.rows[0], "item_id"), false);
  assert.equal(Object.hasOwn(source.rows[0], "wpid"), false);
  assert.deepEqual(source.reconciliation.published_status_counts, [
    { status: "PUBLISHED", count: 2 },
    { status: "SYSTEM_PROBLEM", count: 1 },
    { status: "UNPUBLISHED", count: 1 },
  ]);
  assert.equal(source.reconciliation.included_published_count, 2);
  assert.equal(source.reconciliation.excluded_non_published_count, 2);
  assert.equal(source.reconciliation.lifecycle_status_not_reported_count, 4);
  assert.deepEqual(source.reconciliation.lifecycle_status_counts, [
    { status: "ACTIVE", count: 0 },
    { status: "ARCHIVED", count: 0 },
    { status: "RETIRED", count: 0 },
  ]);
  assert.deepEqual(verifyWalmartItemReportPublishedSource(source), source);
  assert.deepEqual(verifyWalmartItemReportPublishedSourceAgainstCapture(source, evidence, contextV6), source);
});

test("catalog source preserves every ITEM v6 status, Brand, lifecycle, and legacy identifier", () => {
  const header = `${v6Header},Brand,LifecycleStatus,Item ID,WPID`;
  const decoded = report(header, [
    "z-published,Published Archived Bread,111111111111,UPC,PUBLISHED,New,Brand Z,ARCHIVED,item-z,WPID-Z",
    "a-problem,System Problem Bread,222222222222,EAN,SYSTEM_PROBLEM,New,Brand A,ACTIVE,,",
    "m-unpublished,Unpublished Bread,333333333333,UPC,UNPUBLISHED,New,Brand M,ARCHIVED,item-m,",
  ]);
  const evidence = capture(decoded);
  const source = compileWalmartItemReportCatalogSource(evidence, contextV6);
  const published = compileWalmartItemReportPublishedSource(evidence, contextV6);

  assert.equal(source.schema_version, WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA);
  assert.equal(source.catalog_population_complete, true);
  assert.equal(source.report.report_request_id, REQUEST_ID);
  assert.equal(source.report.report_request_id_sha256, walmartItemReportUtf8Sha256(REQUEST_ID));
  assert.equal(source.report.cutoff_at, contextV6.ready_at);
  assert.equal(source.report.downloaded_at, contextV6.downloaded_at);
  assert.equal(source.report.raw_transport_sha256, published.report.download_transport.bytes_sha256);
  assert.equal(source.report.decoded_report_sha256, published.report.decoded_report.bytes_sha256);
  assert.equal(source.published_source.body_sha256, published.body_sha256);
  assert.equal(source.published_source.source_id, published.source_id);
  assert.equal(source.report.parsed_data_record_count, 3);
  assert.equal(source.reconciliation.output_row_count, 3);
  assert.equal(source.reconciliation.unique_listing_count, 3);
  assert.equal(source.reconciliation.rows_sha256, walmartItemReportSha256(source.rows));
  assert.equal(source.reconciliation.published_row_count, 1);
  assert.equal(
    source.reconciliation.published_rows_sha256,
    walmartItemReportSha256(source.rows.filter((row) => row.published_status === "PUBLISHED")),
  );
  assert.deepEqual(source.rows.map((row) => [
    row.sku,
    row.reported_product_name,
    row.reported_brand,
    row.published_status,
    row.reported_lifecycle_status,
  ]), [
    ["a-problem", "System Problem Bread", "Brand A", "SYSTEM_PROBLEM", "ACTIVE"],
    ["m-unpublished", "Unpublished Bread", "Brand M", "UNPUBLISHED", "ARCHIVED"],
    ["z-published", "Published Archived Bread", "Brand Z", "PUBLISHED", "ARCHIVED"],
  ]);
  assert.equal(source.rows[0].reported_legacy_item_identifier_opaque, null);
  assert.equal(source.rows[0].reported_legacy_item_identifier_header, "Item ID");
  assert.equal(source.rows[1].reported_legacy_item_identifier_opaque, "item-m");
  assert.equal(source.rows[2].reported_legacy_wpid_opaque, "WPID-Z");
  assert.deepEqual(source.reconciliation.published_status_counts, [
    { status: "PUBLISHED", count: 1 },
    { status: "SYSTEM_PROBLEM", count: 1 },
    { status: "UNPUBLISHED", count: 1 },
  ]);
  assert.deepEqual(source.reconciliation.lifecycle_status_counts, [
    { status: "ACTIVE", count: 1 },
    { status: "ARCHIVED", count: 2 },
    { status: "RETIRED", count: 0 },
  ]);
  assert.deepEqual(verifyWalmartItemReportCatalogSource(source), source);
  assert.deepEqual(
    verifyWalmartItemReportCatalogSourceAgainstCapture(source, evidence, contextV6),
    source,
  );
});

test("catalog source fails closed when the ITEM v6 Brand column is absent", () => {
  const decoded = report(v6Header, [
    "sku,Bread,123456789012,UPC,PUBLISHED,New",
  ]);
  assert.throws(
    () => compileWalmartItemReportCatalogSource(capture(decoded), contextV6),
    /missing required Brand column/,
  );
});

test("catalog source retains sparse all-status rows with required headers and exact null cells", () => {
  const header = `${v6Header},Brand`;
  const decoded = report(header, [
    "problem,Sparse Problem Bread,123456789012,UPC,SYSTEM_PROBLEM,,",
  ]);
  const source = compileWalmartItemReportCatalogSource(capture(decoded), contextV6);
  assert.equal(source.rows.length, 1);
  assert.equal(source.rows[0].published_status, "SYSTEM_PROBLEM");
  assert.equal(source.rows[0].reported_brand, null);
  assert.equal(source.rows[0].reported_brand_header, "Brand");
  assert.equal(source.rows[0].reported_product_condition, null);
  assert.equal(source.rows[0].reported_product_condition_header, "ProductCondition");
  assert.equal(source.reconciliation.parsed_data_record_count, 1);
  assert.equal(source.reconciliation.output_row_count, 1);
  assert.deepEqual(verifyWalmartItemReportCatalogSource(source), source);
});

test("catalog source strongest verifier rejects a coherently self-resealed forged title", () => {
  const header = `${v6Header},Brand,LifecycleStatus`;
  const decoded = report(header, [
    "sku,Exact Bread,123456789012,UPC,PUBLISHED,New,Exact Brand,ARCHIVED",
  ]);
  const evidence = capture(decoded);
  const source = compileWalmartItemReportCatalogSource(evidence, contextV6);
  const forged = structuredClone(source);
  forged.rows[0].reported_product_name = "Forged Bread";
  const selfResealed = resealCatalog(forged);

  assert.deepEqual(verifyWalmartItemReportCatalogSource(selfResealed), selfResealed);
  assert.throws(
    () => verifyWalmartItemReportCatalogSourceAgainstCapture(
      selfResealed,
      evidence,
      contextV6,
    ),
    /does not exactly recompile from the trusted ITEM report capture and context/,
  );
});

test("catalog source verifier rejects missing and extra rows even after envelope reseal", () => {
  const header = `${v6Header},Brand`;
  const decoded = report(header, [
    "a,Alpha Bread,111111111111,UPC,PUBLISHED,New,Brand A",
    "b,Beta Bread,222222222222,UPC,UNPUBLISHED,New,Brand B",
  ]);
  const source = compileWalmartItemReportCatalogSource(capture(decoded), contextV6);

  const missing = structuredClone(source);
  missing.rows.pop();
  assert.throws(
    () => verifyWalmartItemReportCatalogSource(resealCatalog(missing)),
    /record\/output counts do not reconcile/,
  );

  const extra = structuredClone(source);
  extra.rows.push(structuredClone(extra.rows[0]));
  extra.rows.sort((left, right) => left.listing_key.localeCompare(right.listing_key));
  assert.throws(
    () => verifyWalmartItemReportCatalogSource(resealCatalog(extra)),
    /duplicate listing_key values/,
  );
});

test("catalog source verifier independently recomputes the filtered PUBLISHED projection", () => {
  const header = `${v6Header},Brand`;
  const decoded = report(header, [
    "published,Published Bread,111111111111,UPC,PUBLISHED,New,Brand A",
    "old,Old Bread,222222222222,UPC,UNPUBLISHED,New,Brand B",
  ]);
  const source = compileWalmartItemReportCatalogSource(capture(decoded), contextV6);

  const badHash = structuredClone(source);
  badHash.reconciliation.published_rows_sha256 = "f".repeat(64);
  assert.throws(
    () => verifyWalmartItemReportCatalogSource(sealCatalogEnvelope(badHash)),
    /PUBLISHED projection count\/hash mismatch/,
  );

  const badCount = structuredClone(source);
  badCount.reconciliation.published_row_count = 2;
  assert.throws(
    () => verifyWalmartItemReportCatalogSource(sealCatalogEnvelope(badCount)),
    /PUBLISHED projection count\/hash mismatch/,
  );
});

test("ProductId remains a typed global-product identifier, never buyer item_id or WPID", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
  assert.equal(source.rows[0].reported_product_identifier_header, "ProductId");
  assert.equal(source.rows[0].reported_product_identifier_type_header, "ProductIdType");
  assert.equal(source.rows[0].reported_product_identifier_opaque, "123456789012");
  assert.equal(canonicalWalmartItemReportJson(source).includes('"item_id"'), false);
  assert.equal(canonicalWalmartItemReportJson(source).includes('"reported_wpid"'), false);
});

test("preserves ProductId, legacy Item ID, and explicit WPID as three separate fields", () => {
  const header = `${v6Header},Item ID,WPID`;
  const decoded = report(header, [
    "sku,Bread,123456789012,UPC,PUBLISHED,New,legacy-item-value,WPID-ABC",
  ]);
  const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
  const row = source.rows[0];
  assert.equal(row.reported_product_identifier_opaque, "123456789012");
  assert.equal(row.reported_legacy_item_identifier_opaque, "legacy-item-value");
  assert.equal(row.reported_legacy_item_identifier_header, "Item ID");
  assert.equal(row.reported_legacy_wpid_opaque, "WPID-ABC");
  assert.equal(row.reported_legacy_wpid_header, "WPID");
});

test("authoritative completeness is pinned to full unfiltered v6", () => {
  const header = "SKU,ProductName,ProductId,ProductIdType,PublishedStatus";
  const decoded = report(header, ["sku,Bread,123456789012,UPC,PUBLISHED"]);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(decoded), contextV6),
    /missing required product_condition column/,
  );
  const valid = capture(report(v6Header, ["sku,Bread,123,UPC,PUBLISHED,New"]));
  assert.throws(
    () => compileWalmartItemReportPublishedSource({
      ...valid,
      create_request_manifest_bytes: bytes(JSON.stringify(fullCreateRequestManifest({
        query: { reportType: "ITEM", reportVersion: "v4" },
      }))),
    }, contextV6),
    /must bind unfiltered ITEM reportVersion v6/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource({
      ...valid,
      create_request_manifest_bytes: bytes(JSON.stringify(fullCreateRequestManifest({
        query: { reportType: "ITEM", reportVersion: "v6", publishedStatus: "PUBLISHED" },
      }))),
    }, contextV6),
    /unsupported fields: publishedStatus/,
  );
});

test("optional lifecycle is validated and reported but never narrows PUBLISHED scope", () => {
  const header = `${v6Header},LifecycleStatus`;
  const decoded = report(header, [
    "active,Bread A,111111111111,UPC,PUBLISHED,New,ACTIVE",
    "archived,Bread B,222222222222,UPC,PUBLISHED,New,ARCHIVED",
    "retired-old,Bread C,333333333333,UPC,UNPUBLISHED,New,RETIRED",
  ]);
  const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
  assert.deepEqual(source.rows.map((row) => [row.sku, row.reported_lifecycle_status]), [
    ["active", "ACTIVE"],
    ["archived", "ARCHIVED"],
  ]);
  assert.equal(source.reconciliation.included_published_count, 2);
  assert.equal(source.reconciliation.lifecycle_status_not_reported_count, 0);
  assert.deepEqual(source.status_semantics.inclusion_rule, {
    published_status: "PUBLISHED",
    lifecycle_filter: "NONE",
  });
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(header, [
      "sku,Bread,123456789012,UPC,PUBLISHED,New,UNKNOWN",
    ])), contextV6),
    /unsupported lifecycle status/,
  );
});

test("treats a present-but-blank optional lifecycle cell as null evidence", () => {
  const header = `${v6Header},LifecycleStatus`;
  const decoded = report(header, [
    "blank,Bread A,111111111111,UPC,PUBLISHED,New,",
    "active,Bread B,222222222222,UPC,PUBLISHED,New,ACTIVE",
  ]);
  const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
  assert.deepEqual(source.rows.map((row) => [
    row.sku,
    row.reported_lifecycle_status,
    row.reported_lifecycle_status_header,
  ]), [
    ["active", "ACTIVE", "LifecycleStatus"],
    ["blank", null, "LifecycleStatus"],
  ]);
  assert.equal(source.reconciliation.lifecycle_status_not_reported_count, 1);
  assert.deepEqual(verifyWalmartItemReportPublishedSource(source), source);
});

test("binds status, locator, and file manifests into one requestId chain", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);

  const wrongReady = decodeJson(evidence.ready_status_request_manifest_bytes);
  wrongReady.path.requestId = "request-b";
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withManifestBytes(
      evidence,
      "ready_status_request_manifest_bytes",
      wrongReady,
    ), contextV6),
    /READY request manifest path requestId does not exactly match/,
  );

  const wrongLocator = decodeJson(evidence.download_locator_request_manifest_bytes);
  wrongLocator.query.requestId = "request-b";
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withManifestBytes(
      evidence,
      "download_locator_request_manifest_bytes",
      wrongLocator,
    ), contextV6),
    /download locator request manifest requestId does not exactly match/,
  );

  const filteredLocator = decodeJson(evidence.download_locator_request_manifest_bytes);
  filteredLocator.query.publishedStatus = "PUBLISHED";
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withManifestBytes(
      evidence,
      "download_locator_request_manifest_bytes",
      filteredLocator,
    ), contextV6),
    /unsupported fields: publishedStatus/,
  );
});

test("rejects A create+READY combined with B locator+file, including strongest replay", () => {
  const bodyA = report(v6Header, ["a,A Bread,111111111111,UPC,PUBLISHED,New"]);
  const bodyB = report(v6Header, ["b,B Bread,222222222222,UPC,PUBLISHED,New"]);
  const evidenceA = capture(bodyA);
  const correlationsB = {
    create_sha256: walmartItemReportUtf8Sha256("b-create"),
    ready_status_sha256: walmartItemReportUtf8Sha256("b-ready"),
    download_locator_sha256: walmartItemReportUtf8Sha256("b-locator"),
    report_file_sha256: walmartItemReportUtf8Sha256("b-file"),
  };
  const evidenceB = capture(bodyB, {}, {
    requestId: "request-item-v6-b",
    downloadUrl: "https://walmart-reports.s3.amazonaws.com/reports/item-b.csv?X-Amz-Signature=secret-b",
    correlations: correlationsB,
  });
  const mixed = {
    ...evidenceA,
    download_locator_request_manifest_bytes: evidenceB.download_locator_request_manifest_bytes,
    download_locator_response_payload_bytes: evidenceB.download_locator_response_payload_bytes,
    report_file_request_manifest_bytes: evidenceB.report_file_request_manifest_bytes,
    downloaded_body_bytes: evidenceB.downloaded_body_bytes,
    http: {
      ...evidenceA.http,
      download_locator_response: evidenceB.http.download_locator_response,
      download_response: evidenceB.http.download_response,
    },
  };
  assert.throws(
    () => compileWalmartItemReportPublishedSource(mixed, contextV6),
    /trusted atomic capture exchange seal|download locator request manifest requestId does not exactly match/,
  );
  const sealedA = compileWalmartItemReportPublishedSource(evidenceA, contextV6);
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(reseal(sealedA), mixed, contextV6),
    /trusted atomic capture exchange seal|download locator request manifest requestId does not exactly match/,
  );

  const bodyOnlySwap = { ...evidenceA, downloaded_body_bytes: evidenceB.downloaded_body_bytes };
  const trustedAContext = trustedContext(evidenceA, contextV6);
  assert.throws(
    () => compileWalmartItemReportPublishedSourceRaw(bodyOnlySwap, trustedAContext),
    /does not match the trusted atomic capture exchange seal/,
  );
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCaptureRaw(
      sealedA,
      bodyOnlySwap,
      trustedAContext,
    ),
    /does not match the trusted atomic capture exchange seal/,
  );
});

test("keeps presigned URL secrets out of the file manifest and enforces URL/redirect policy", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);
  const fileManifestText = new TextDecoder().decode(evidence.report_file_request_manifest_bytes);
  assert.equal(fileManifestText.includes(DOWNLOAD_URL), false);
  assert.equal(fileManifestText.includes("secret-a"), false);

  const alteredDigest = decodeJson(evidence.report_file_request_manifest_bytes);
  alteredDigest.initial.url_sha256 = "f".repeat(64);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withManifestBytes(
      evidence,
      "report_file_request_manifest_bytes",
      alteredDigest,
    ), contextV6),
    /does not exactly describe the locator URL/,
  );

  const evilLocator = withLocatorResponse(evidence, {
    requestId: REQUEST_ID,
    downloadURL: "https://evil.example/reports/item.csv?signature=secret",
    downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
  });
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evilLocator, contextV6),
    /hostname is not approved/,
  );

  const finalUrl = "https://item-report.cloudfront.net/reports/item-v6.csv?token=secret-b";
  const redirectManifest = buildWalmartItemReportFileRequestManifest({
    ...binding(CORRELATIONS.report_file_sha256),
    locator_url: DOWNLOAD_URL,
    redirects: [{ status: 307, from_url: DOWNLOAD_URL, to_url: finalUrl }],
  });
  assert.equal(canonicalWalmartItemReportJson(redirectManifest).includes("secret-b"), false);
  const redirectedEvidence = withManifestBytes(
    evidence,
    "report_file_request_manifest_bytes",
    redirectManifest,
  );
  const redirectedSource = compileWalmartItemReportPublishedSource(redirectedEvidence, contextV6);
  assert.equal(redirectedSource.report.report_file_request.redirect_count, 1);
  assert.equal(
    redirectedSource.report.report_file_request.final_url_sha256,
    walmartItemReportUtf8Sha256(finalUrl),
  );

  for (const locatorUrl of [
    "http://walmart-reports.s3.amazonaws.com/reports/item.csv?sig=x",
    "https://user:pass@walmart-reports.s3.amazonaws.com/reports/item.csv?sig=x",
    "https://walmart-reports.s3.amazonaws.com:8443/reports/item.csv?sig=x",
    "https://evil.example/reports/item.csv?sig=x",
    "https://walmart-reports.s3.amazonaws.com/reports/item.csv?sig=x#fragment",
  ]) {
    assert.throws(
      () => buildWalmartItemReportFileRequestManifest({
        ...binding(CORRELATIONS.report_file_sha256),
        locator_url: locatorUrl,
      }),
      /HTTPS|credentials|non-default port|hostname is not approved|fragment/,
    );
  }
});

test("binds credential scope, distinct correlations, and echoed response identifiers", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);
  assert.throws(
    () => compileWalmartItemReportPublishedSourceRaw(evidence, contextV6),
    /missing required fields: trusted_exchange_seals/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      account_scope: { ...contextV6.account_scope, store_index: 2 },
    }),
    /does not exactly match trusted credential scope/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      account_scope: { ...contextV6.account_scope, seller_account_fingerprint_sha256: "b".repeat(64) },
    }),
    /does not exactly match trusted credential scope/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      request_correlations: {
        ...CORRELATIONS,
        download_locator_sha256: walmartItemReportUtf8Sha256("different-locator-correlation"),
      },
    }),
    /trusted atomic capture exchange seal|does not match trusted request correlation/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      request_correlations: { ...CORRELATIONS, report_file_sha256: CORRELATIONS.create_sha256 },
    }),
    /distinct correlation ID hash/,
  );
  const conflictingEcho = {
    ...evidence,
    http: {
      ...evidence.http,
      download_locator_response: {
        ...evidence.http.download_locator_response,
        echoed_correlation_id_sha256: walmartItemReportUtf8Sha256("wrong-echo"),
      },
    },
  };
  assert.throws(
    () => compileWalmartItemReportPublishedSource(conflictingEcho, contextV6),
    /echoed_correlation_id_sha256 conflicts with request manifest/,
  );
});

test("normalizes documented create timestamp aliases and rejects timestamp/expiry conflicts", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);
  const createdTimeOnly = withCreateResponse(evidence, {
    requestId: REQUEST_ID,
    createdTime: "2026-07-18T10:00:00Z",
    reportType: "ITEM",
    reportVersion: "v6",
  });
  assert.equal(
    compileWalmartItemReportPublishedSource(createdTimeOnly, contextV6).report.requested_at,
    "2026-07-18T10:00:00.000Z",
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withCreateResponse(evidence, {
      requestId: REQUEST_ID,
      requestSubmissionDate: "2026-07-18T10:00:00.000Z",
      createdTime: "2026-07-18T10:01:00.000Z",
      reportType: "ITEM",
      reportVersion: "v6",
    }), contextV6),
    /conflicting create response requestSubmissionDate\|createdTime/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: REQUEST_ID,
      requestStatus: "READY",
      reportType: "ITEM",
      reportVersion: "v6",
      requestSubmissionDate: "2026-07-18T10:00:00.000Z",
      createdTime: "2026-07-18T10:01:00.000Z",
    }), contextV6),
    /conflicting READY requestSubmissionDate\|createdTime/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: REQUEST_ID,
      requestStatus: "READY",
      reportType: "ITEM",
      reportVersion: "v6",
      reportGenerationDate: "2026-07-18T10:31:00.000Z",
    }), contextV6),
    /reportGenerationDate must be between/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withLocatorResponse(evidence, {
      requestId: REQUEST_ID,
      reportGenerationDate: "2026-07-18T10:21:00.000Z",
      downloadURL: DOWNLOAD_URL,
      downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
    }), contextV6),
    /reportGenerationDate conflicts with READY/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withLocatorResponse(evidence, {
      requestId: REQUEST_ID,
      downloadURL: DOWNLOAD_URL,
      downloadURLExpirationTime: "2026-07-18T10:32:59.000Z",
    }), contextV6),
    /must cover the observed report download time/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withLocatorResponse(evidence, {
      requestId: REQUEST_ID,
      downloadURL: DOWNLOAD_URL,
      downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
      downloadUrlExpirationTime: "2026-07-18T11:31:00.000Z",
    }), contextV6),
    /conflicting download locator downloadURLExpirationTime/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      download_locator_at: "2026-07-18T10:29:59.000Z",
    }),
    /context chronology must satisfy/,
  );
});

test("binds exact gzip transport and deterministically decoded report bytes", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const transport = new Uint8Array(gzipSync(decoded, { mtime: 0 }));
  const evidence = capture(transport);
  const source = compileWalmartItemReportPublishedSource(evidence, contextV6);
  assert.equal(source.report.download_transport.detected_container, "gzip");
  assert.notEqual(source.report.download_transport.bytes_sha256, source.report.decoded_report.bytes_sha256);
  assert.equal(source.report.decoded_report.byte_length, decoded.byteLength);
  verifyWalmartItemReportPublishedSourceAgainstCapture(source, evidence, contextV6);
});

test("binds exact single-member ZIP transport, member name, size, and CRC", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const transport = singleMemberStoredZip("ITEM-v6.csv", decoded);
  const evidence = capture(transport);
  const source = compileWalmartItemReportPublishedSource(evidence, contextV6);
  assert.equal(source.report.download_transport.detected_container, "zip");
  assert.equal(source.report.download_transport.decoded_member_name, "ITEM-v6.csv");
  assert.equal(source.report.decoded_report.byte_length, decoded.byteLength);

  const corrupted = new Uint8Array(transport);
  corrupted[30 + Buffer.byteLength("ITEM-v6.csv") + 2] ^= 0xff;
  assert.throws(() => compileWalmartItemReportPublishedSource(capture(corrupted), contextV6), /CRC32 mismatch/);
});

test("source-aware verification rejects forged resealed content and changed excluded bytes", () => {
  const decoded = report(v6Header, [
    "sku,Bread,123456789012,UPC,PUBLISHED,New",
    "old,Old Bread,999999999999,UPC,UNPUBLISHED,New",
  ]);
  const evidence = capture(decoded);
  const source = compileWalmartItemReportPublishedSource(evidence, contextV6);
  const forged = structuredClone(source);
  forged.rows[0].reported_product_name = "Different Product";
  const internallyValidForgery = reseal(forged);
  assert.deepEqual(verifyWalmartItemReportPublishedSource(internallyValidForgery), internallyValidForgery);
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(internallyValidForgery, evidence, contextV6),
    /does not exactly recompile/,
  );

  const changedExcluded = report(v6Header, [
    "sku,Bread,123456789012,UPC,PUBLISHED,New",
    "old,Changed Old Bread,999999999999,UPC,UNPUBLISHED,New",
  ]);
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, capture(changedExcluded), contextV6),
    /does not exactly recompile/,
  );
  const changedRequestBytes = {
    ...evidence,
    create_request_manifest_bytes: bytes(JSON.stringify(fullCreateRequestManifest(), null, 2)),
  };
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, changedRequestBytes, contextV6),
    /does not exactly recompile/,
  );
  const changedCreateResponseBytes = withCreateResponse(evidence, {
    requestId: REQUEST_ID,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
    changed: true,
  });
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, changedCreateResponseBytes, contextV6),
    /does not exactly recompile/,
  );
  const changedStatusBytes = withReadyPayload(evidence, {
    requestId: REQUEST_ID,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    changed: true,
  });
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, changedStatusBytes, contextV6),
    /does not exactly recompile/,
  );
  const changedLocatorBytes = withLocatorResponse(evidence, {
    requestId: REQUEST_ID,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportGenerationDate: "2026-07-18T10:20:00.000Z",
    downloadURL: DOWNLOAD_URL,
    downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
    changed: true,
  });
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, changedLocatorBytes, contextV6),
    /does not exactly recompile/,
  );
  const changedFileManifestBytes = {
    ...evidence,
    report_file_request_manifest_bytes: bytes(JSON.stringify(
      decodeJson(evidence.report_file_request_manifest_bytes),
      null,
      2,
    )),
  };
  assert.throws(
    () => verifyWalmartItemReportPublishedSourceAgainstCapture(source, changedFileManifestBytes, contextV6),
    /does not exactly recompile/,
  );
});

test("builds exact source-bound Shadow published v2 bridge and replays to HTTP bytes", () => {
  const decoded = report(v6Header, [
    "b,B Bread,222222222222,UPC,PUBLISHED,New",
    "a,A Bread,111111111111,UPC,PUBLISHED,New",
  ]);
  const evidence = capture(decoded);
  const upstream = compileWalmartItemReportPublishedSource(evidence, contextV6);
  const bridge = compileWalmartShadowPublishedCatalogSourceFromItemReport(upstream);
  assert.equal(bridge.schema_version, WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA);
  assert.equal(bridge.captured_at, contextV6.ready_at);
  assert.equal(bridge.source_artifact.source_id, upstream.source_id);
  assert.equal(bridge.source_artifact.raw_transport_sha256, upstream.report.download_transport.bytes_sha256);
  assert.equal(bridge.source_artifact.decoded_report_sha256, upstream.report.decoded_report.bytes_sha256);
  assert.deepEqual(bridge.rows, [
    { channel: "WALMART_US", store_index: 1, sku: "a", listing_key: "walmart:1:a", published_status: "PUBLISHED" },
    { channel: "WALMART_US", store_index: 1, sku: "b", listing_key: "walmart:1:b", published_status: "PUBLISHED" },
  ]);
  assert.deepEqual(
    verifyWalmartShadowPublishedCatalogSource(bridge),
    bridge,
  );
  assert.deepEqual(
    verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(
      bridge,
      upstream,
      evidence,
      contextV6,
    ),
    bridge,
  );
  const forgedV4 = structuredClone(upstream);
  forgedV4.report.report_version = "v4";
  forgedV4.report.create_request.report_version = "v4";
  assert.throws(
    () => compileWalmartShadowPublishedCatalogSourceFromItemReport(reseal(forgedV4)),
    /report_version must be v6/,
  );
});

test("never accepts caller-authored completeness or request fields in trusted context", () => {
  const decoded = report(v6Header, ["sku,Bread,123456789012,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      published_population_complete: true,
    }),
    /unsupported fields: published_population_complete/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, { ...contextV6, report_version: "v6" }),
    /unsupported fields: report_version/,
  );
});

test("rejects duplicate/conflicting listing keys instead of deduplicating", () => {
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,Bread,123456789012,UPC,PUBLISHED,New",
      "sku,Bread,123456789012,UPC,PUBLISHED,New",
    ])), contextV6),
    /duplicates listing_key walmart:1:sku/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,Bread,123456789012,UPC,PUBLISHED,New",
      "sku,Other Bread,999999999999,UPC,PUBLISHED,New",
    ])), contextV6),
    /conflicts with listing_key walmart:1:sku/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,Bread,123456789012,UPC,PUBLISHED,New",
      "sku,Bread,123456789012,UPC,UNPUBLISHED,New",
    ])), contextV6),
    /conflicts with listing_key walmart:1:sku/,
  );
});

test("rejects missing, duplicate, or semantically conflated headers", () => {
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(
      "SKU,ProductName,Item ID,ProductIdType,PublishedStatus,ProductCondition",
      ["sku,Bread,legacy,UPC,PUBLISHED,New"],
    )), contextV6),
    /missing required product_id column/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(
      `${v6Header},Item ID,Walmart Item ID`,
      ["sku,Bread,123,UPC,PUBLISHED,New,a,b"],
    )), contextV6),
    /ambiguous legacy_item_id columns/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(
      `${v6Header},Product Id`,
      ["sku,Bread,123,UPC,PUBLISHED,New,123"],
    )), contextV6),
    /duplicate normalized header/,
  );
});

test("rejects malformed rows, unknown statuses, and missing PUBLISHED evidence", () => {
  const malformed = [
    [`${v6Header}\n"sku,Bread,123,UPC,PUBLISHED,New\n`, /unterminated quoted field/],
    [`${v6Header}\nsku,Bread,123,UPC,PUBLISHED\n`, /has 5 cells; expected 6/],
    [`${v6Header}\nsku,Bread,123,UPC,PUBLISHED,New\n\n`, /record 3 is blank/],
  ];
  for (const [text, pattern] of malformed) {
    assert.throws(() => compileWalmartItemReportPublishedSource(capture(bytes(text)), contextV6), pattern);
  }
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,Bread,123,UPC,UNKNOWN,New",
    ])), contextV6),
    /unsupported published status/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,,123,UPC,PUBLISHED,New",
    ])), contextV6),
    /product_name must be a non-empty string/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      "sku,Bread,,UPC,PUBLISHED,New",
    ])), contextV6),
    /product_id must be a non-empty string/,
  );
});

test("binds READY payload request ID, response length, chronology, and account scope", () => {
  const decoded = report(v6Header, ["sku,Bread,123,UPC,PUBLISHED,New"]);
  const evidence = capture(decoded);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: "other",
      requestStatus: "READY",
      reportType: "ITEM",
      reportVersion: "v6",
    }), contextV6),
    /request ID does not exactly match|conflicts with report requestId/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withCreateResponse(evidence, {
      requestId: "forged-create-id",
      requestSubmissionDate: "2026-07-18T10:00:00.000Z",
      reportType: "ITEM",
      reportVersion: "v6",
    }), contextV6),
    /request ID does not exactly match|conflicts with report requestId/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: REQUEST_ID,
      requestStatus: "READY",
      reportType: "BUYBOX",
      reportVersion: "v6",
    }), contextV6),
    /must bind reportType=ITEM/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: REQUEST_ID,
      requestStatus: "READY",
      reportType: "ITEM",
      reportVersion: "v4",
    }), contextV6),
    /must bind reportVersion=v6/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(withReadyPayload(evidence, {
      requestId: REQUEST_ID,
      requestStatus: "READY",
    }), contextV6),
    /must bind reportType=ITEM/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource({
      ...evidence,
      http: {
        ...evidence.http,
        download_response: {
          ...evidence.http.download_response,
          content_length: decoded.byteLength + 1,
        },
      },
    }, contextV6),
    /content_length does not match captured body bytes|trusted exchange input HTTP content length/,
  );
  assert.throws(
    () => compileWalmartItemReportPublishedSource(evidence, {
      ...contextV6,
      ready_at: "2026-07-18T09:59:00.000Z",
    }),
    /ready_at must be at or after create response requestSubmissionDate/,
  );
});

test("derives conservative cutoff exclusively from READY observation", () => {
  const decoded = report(v6Header, ["sku,Bread,123,UPC,PUBLISHED,New"]);
  const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
  assert.equal(source.report.cutoff_at, contextV6.ready_at);
  assert.equal(source.report.cutoff_basis, "READY_OBSERVED_UPPER_BOUND");
  assert.equal(source.report.authority_evidence.report_type_exact_match, true);
  assert.equal(source.report.authority_evidence.report_version_exact_match, true);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(decoded), {
      ...contextV6,
      cutoff_at: "2026-07-18T10:20:00.000Z",
    }),
    /unsupported fields: cutoff_at/,
  );
  const forged = structuredClone(source);
  forged.report.cutoff_at = "2026-07-18T10:20:00.000Z";
  assert.throws(
    () => verifyWalmartItemReportPublishedSource(reseal(forged)),
    /cutoff must be the conservative READY-observed upper bound/,
  );
});

test("enforces decoded-size, compression-ratio, record, column, field, and status caps", () => {
  const decoded = report(v6Header, ["sku,Bread,123,UPC,PUBLISHED,New"]);
  const normalZip = singleMemberStoredZip("ITEM-v6.csv", decoded);
  const declaredBomb = Buffer.from(normalZip);
  let central = -1;
  for (let index = 0; index <= declaredBomb.length - 4; index += 1) {
    if (declaredBomb.readUInt32LE(index) === 0x02014b50) {
      central = index;
      break;
    }
  }
  assert.notEqual(central, -1);
  declaredBomb.writeUInt32LE(WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes + 1, central + 24);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(new Uint8Array(declaredBomb)), contextV6),
    /declared uncompressed size exceeds decoded-report safety cap/,
  );

  const ratioBomb = new Uint8Array(gzipSync(bytes("A".repeat(3_000_000)), { mtime: 0 }));
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(ratioBomb), contextV6),
    /gzip report transport decompression failed|compression ratio exceeds safety cap/,
  );

  const tooManyColumns = [
    ...v6Header.split(","),
    ...Array.from({ length: WALMART_ITEM_REPORT_LIMITS.max_columns - 5 }, (_, index) => `Extra${index}`),
  ].join(",");
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(tooManyColumns, [])), contextV6),
    /column-count safety cap/,
  );

  const oversizedField = "X".repeat(WALMART_ITEM_REPORT_LIMITS.max_field_characters + 1);
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(report(v6Header, [
      `sku,${oversizedField},123,UPC,PUBLISHED,New`,
    ])), contextV6),
    /field-length safety cap/,
  );

  const manyRecords = [v6Header, ...Array.from(
    { length: WALMART_ITEM_REPORT_LIMITS.max_logical_records },
    (_, index) => `sku-${index},Bread,123,UPC,UNPUBLISHED,New`,
  )].join("\n") + "\n";
  assert.throws(
    () => compileWalmartItemReportPublishedSource(capture(bytes(manyRecords)), contextV6),
    /logical-record safety cap/,
  );

  const oversizedStatus = new Uint8Array(WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes + 1).fill(0x20);
  const oversizedStatusEvidence = capture(decoded);
  assert.throws(
    () => compileWalmartItemReportPublishedSource({
      ...oversizedStatusEvidence,
      ready_status_payload_bytes: oversizedStatus,
      http: {
        ...oversizedStatusEvidence.http,
        ready_status_response: {
          ...oversizedStatusEvidence.http.ready_status_response,
          content_length: oversizedStatus.byteLength,
        },
      },
    }, contextV6),
    /ready_status_payload_bytes exceeds/,
  );
});

test("identity and sorting remain exact, case-sensitive, and locale-independent", () => {
  assert.equal(walmartListingKey(7, "SKU:a"), "walmart:7:SKU:a");
  assert.notEqual(walmartListingKey(7, "SKU"), walmartListingKey(7, "sku"));
  const decoded = report(v6Header, [
    "ä-sku,Unicode,333,UPC,PUBLISHED,New",
    "Z-sku,ASCII,111,UPC,PUBLISHED,New",
    "a-sku,Lower,222,UPC,PUBLISHED,New",
  ]);
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function forbiddenLocaleCompare() {
    throw new Error("localeCompare must not be used");
  };
  try {
    const source = compileWalmartItemReportPublishedSource(capture(decoded), contextV6);
    assert.deepEqual(source.rows.map((row) => row.sku), ["Z-sku", "a-sku", "ä-sku"]);
  } finally {
    String.prototype.localeCompare = original;
  }
});
