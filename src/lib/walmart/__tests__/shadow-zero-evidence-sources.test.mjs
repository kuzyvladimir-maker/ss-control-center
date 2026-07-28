import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
  walmartShadowCanonicalSha256,
} from "../shadow-50.ts";
import {
  buildWalmartItemReportDownloadLocatorRequestManifest,
  buildWalmartItemReportFileRequestManifest,
  buildWalmartItemReportReadyRequestManifest,
  buildWalmartItemReportV6CreateRequestManifest,
  compileWalmartItemReportPublishedSource,
  compileWalmartShadowPublishedCatalogSourceFromItemReport,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportUtf8Sha256,
} from "../item-report-published-source.ts";
import {
  compileWalmartShadowZeroEvidenceSources,
  verifyWalmartShadowZeroEvidenceSourcesAgainstItemReportCapture,
  verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog,
} from "../shadow-zero-evidence-sources.ts";

const CAPTURED_AT = "2026-07-18T23:30:00.000Z";
const encoder = new TextEncoder();

function digest(value) {
  return walmartShadowCanonicalSha256(value);
}

function bytes(value) {
  return encoder.encode(value);
}

function trustedItemReportFixture() {
  const requestId = "zero-evidence-item-v6";
  const accountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: "c".repeat(64),
  };
  const correlations = {
    create_sha256: walmartItemReportUtf8Sha256("zero-create-correlation"),
    ready_status_sha256: walmartItemReportUtf8Sha256("zero-ready-correlation"),
    download_locator_sha256: walmartItemReportUtf8Sha256("zero-locator-correlation"),
    report_file_sha256: walmartItemReportUtf8Sha256("zero-file-correlation"),
  };
  const binding = (requestCorrelationIdSha256) => ({
    account_scope: accountScope,
    request_correlation_id_sha256: requestCorrelationIdSha256,
  });
  const downloadUrl = "https://walmart-reports.s3.amazonaws.com/reports/zero-item-v6.csv?signature=zero";
  const createRequest = bytes(JSON.stringify(
    buildWalmartItemReportV6CreateRequestManifest(binding(correlations.create_sha256)),
  ));
  const createResponse = bytes(JSON.stringify({
    requestId,
    requestSubmissionDate: "2026-07-18T22:45:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = bytes(JSON.stringify(buildWalmartItemReportReadyRequestManifest(
    requestId,
    binding(correlations.ready_status_sha256),
  )));
  const readyResponse = bytes(JSON.stringify({
    requestId,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    reportGenerationDate: "2026-07-18T23:20:00.000Z",
  }));
  const locatorRequest = bytes(JSON.stringify(buildWalmartItemReportDownloadLocatorRequestManifest(
    requestId,
    binding(correlations.download_locator_sha256),
  )));
  const locatorResponse = bytes(JSON.stringify({
    requestId,
    downloadURL: downloadUrl,
    downloadURLExpirationTime: "2026-07-19T00:30:00.000Z",
  }));
  const fileRequest = bytes(JSON.stringify(buildWalmartItemReportFileRequestManifest({
    ...binding(correlations.report_file_sha256),
    locator_url: downloadUrl,
  })));
  const reportBytes = bytes([
    "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition",
    "Bread-6,Bread Six Pack,111111111111,UPC,PUBLISHED,New",
    "bread-6,Bread Lowercase,222222222222,UPC,PUBLISHED,New",
    "old,Old Bread,333333333333,UPC,UNPUBLISHED,New",
  ].join("\n") + "\n");
  const requestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  const http = {
    create_response: {
      status: 200,
      content_type: "application/json",
      content_length: createResponse.byteLength,
      echoed_correlation_id_sha256: correlations.create_sha256,
      echoed_report_request_id_sha256: requestIdSha256,
    },
    ready_status_response: {
      status: 200,
      content_type: "application/json",
      content_length: readyResponse.byteLength,
      echoed_correlation_id_sha256: correlations.ready_status_sha256,
      echoed_report_request_id_sha256: requestIdSha256,
    },
    download_locator_response: {
      status: 200,
      content_type: "application/json",
      content_length: locatorResponse.byteLength,
      echoed_correlation_id_sha256: correlations.download_locator_sha256,
      echoed_report_request_id_sha256: requestIdSha256,
    },
    download_response: {
      status: 200,
      content_type: "text/csv",
      content_length: reportBytes.byteLength,
      echoed_correlation_id_sha256: null,
      echoed_report_request_id_sha256: null,
    },
  };
  const capture = {
    create_request_manifest_bytes: createRequest,
    create_response_payload_bytes: createResponse,
    ready_status_request_manifest_bytes: readyRequest,
    ready_status_payload_bytes: readyResponse,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: reportBytes,
    http,
  };
  const exchangeSeal = (requestManifestBytes, correlationSha256, responseBytes, metadata) => (
    walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestManifestBytes,
      request_correlation_id_sha256: correlationSha256,
      response_payload_bytes: responseBytes,
      http: metadata,
    })
  );
  const context = {
    account_scope: accountScope,
    request_correlations: correlations,
    trusted_exchange_seals: {
      create_response_sha256: exchangeSeal(
        createRequest,
        correlations.create_sha256,
        createResponse,
        http.create_response,
      ),
      ready_status_response_sha256: exchangeSeal(
        readyRequest,
        correlations.ready_status_sha256,
        readyResponse,
        http.ready_status_response,
      ),
      download_locator_response_sha256: exchangeSeal(
        locatorRequest,
        correlations.download_locator_sha256,
        locatorResponse,
        http.download_locator_response,
      ),
      download_response_sha256: exchangeSeal(
        fileRequest,
        correlations.report_file_sha256,
        reportBytes,
        http.download_response,
      ),
    },
    ready_at: CAPTURED_AT,
    download_locator_at: "2026-07-18T23:31:00.000Z",
    report_file_requested_at: "2026-07-18T23:32:00.000Z",
    downloaded_at: "2026-07-18T23:33:00.000Z",
  };
  const itemReportSource = compileWalmartItemReportPublishedSource(capture, context);
  const publishedCatalog = compileWalmartShadowPublishedCatalogSourceFromItemReport(itemReportSource);
  return { capture, context, itemReportSource, publishedCatalog };
}

function listing(storeIndex, sku) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: `walmart:${storeIndex}:${sku}`,
    published_status: "PUBLISHED",
  };
}

function publishedSource(rows = [
  listing(1, "Bread-6"),
  listing(1, "bread-6"),
  listing(2, "SKU-002"),
]) {
  const canonicalRows = [...rows].sort((left, right) => (
    left.listing_key < right.listing_key ? -1 : left.listing_key > right.listing_key ? 1 : 0
  ));
  const body = {
    schema_version: WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    captured_at: CAPTURED_AT,
    channel: "WALMART_US",
    published_population_complete: true,
    source_artifact: {
      schema_version: "walmart-item-report-published-source/v1",
      source_id: "walmart-item-report-published-fixture",
      body_sha256: digest("item-report-body"),
      raw_transport_sha256: digest("item-report-transport"),
      decoded_report_sha256: digest("item-report-decoded"),
      cutoff_at: CAPTURED_AT,
    },
    rows: canonicalRows,
  };
  const bodySha256 = digest(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-catalog-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

function resealSource(source, idPrefix) {
  const body = structuredClone(source);
  delete body.snapshot_id;
  delete body.body_sha256;
  const bodySha256 = digest(body);
  return {
    ...body,
    snapshot_id: `${idPrefix}-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

test("zero-evidence compile is deterministic, complete, and preserves exact SKU case", () => {
  const published = publishedSource();
  const first = compileWalmartShadowZeroEvidenceSources(published);
  const second = compileWalmartShadowZeroEvidenceSources(structuredClone(published));

  assert.deepEqual(first, second);
  assert.equal(first.prior_visual_source.rows.length, published.rows.length);
  assert.equal(first.remediation_source.rows.length, published.rows.length);
  assert.deepEqual(
    first.prior_visual_source.rows.map((row) => row.listing_key),
    published.rows.map((row) => row.listing_key),
  );
  assert.equal(first.prior_visual_source.rows[0].sku, "Bread-6");
  assert.equal(first.prior_visual_source.rows[1].sku, "bread-6");
  assert.ok(first.prior_visual_source.rows.every((row) => (
    row.verdict === "NOT_AUDITED" && row.label === null
  )));
  assert.ok(first.remediation_source.rows.every((row) => (
    row.status === "NOT_APPLIED" && row.verification === null
  )));
});

test("zero ledgers and sources bind the exact PUBLISHED population and cutoff", () => {
  const published = publishedSource();
  const compiled = compileWalmartShadowZeroEvidenceSources(published);

  for (const ledger of [compiled.prior_visual_ledger, compiled.remediation_ledger]) {
    assert.equal(ledger.mode, "ZERO_EVIDENCE");
    assert.equal(ledger.captured_at, published.captured_at);
    assert.deepEqual(ledger.entries, []);
    assert.deepEqual(ledger.published_catalog, {
      artifact_id: published.snapshot_id,
      body_sha256: published.body_sha256,
      captured_at: published.captured_at,
    });
  }
  assert.deepEqual(
    compiled.prior_visual_source.source_bindings.evidence_ledger,
    {
      schema_version: compiled.prior_visual_ledger.schema_version,
      ledger_id: compiled.prior_visual_ledger.ledger_id,
      body_sha256: compiled.prior_visual_ledger.body_sha256,
      captured_at: compiled.prior_visual_ledger.captured_at,
      mode: "ZERO_EVIDENCE",
    },
  );
  assert.equal(compiled.remediation_source.source_reconciliation.evidence_accepted, 0);
  assert.equal(compiled.remediation_source.source_reconciliation.ledger_entries, 0);
});

test("source-aware verifier rejects a fully resealed fake historical BAD verdict", () => {
  const published = publishedSource();
  const forged = structuredClone(compileWalmartShadowZeroEvidenceSources(published));
  forged.prior_visual_source.rows[0].verdict = "BAD";
  forged.prior_visual_source.rows[0].label = {
    label_id: "unqualified-history",
    body_sha256: digest("unqualified-history"),
    labeled_at: CAPTURED_AT,
  };
  forged.prior_visual_source.source_bindings.evidence_ledger.mode = "QUALIFIED";
  forged.prior_visual_source.source_reconciliation.ledger_entries = 1;
  forged.prior_visual_source.source_reconciliation.evidence_accepted = 1;
  forged.prior_visual_source = resealSource(
    forged.prior_visual_source,
    "walmart-shadow-prior-visual",
  );

  assert.throws(
    () => verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog(forged, published),
    /do not exactly match deterministic compilation/,
  );
});

test("source-aware verifier rejects a fully resealed fake VERIFIED_APPLIED status", () => {
  const published = publishedSource();
  const forged = structuredClone(compileWalmartShadowZeroEvidenceSources(published));
  forged.remediation_source.rows[0].status = "VERIFIED_APPLIED";
  forged.remediation_source.rows[0].verification = {
    verification_id: "db-ok-is-not-proof",
    body_sha256: digest("db-ok-is-not-proof"),
    verified_at: CAPTURED_AT,
  };
  forged.remediation_source.source_bindings.evidence_ledger.mode = "QUALIFIED";
  forged.remediation_source.source_reconciliation.ledger_entries = 1;
  forged.remediation_source.source_reconciliation.evidence_accepted = 1;
  forged.remediation_source = resealSource(
    forged.remediation_source,
    "walmart-shadow-remediation",
  );

  assert.throws(
    () => verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog(forged, published),
    /do not exactly match deterministic compilation/,
  );
});

test("source-aware verifier rejects a baseline compiled for a different population", () => {
  const original = publishedSource();
  const different = publishedSource([listing(1, "Bread-6"), listing(2, "SKU-002")]);
  const compiled = compileWalmartShadowZeroEvidenceSources(original);

  assert.throws(
    () => verifyWalmartShadowZeroEvidenceSourcesAgainstPublishedCatalog(compiled, different),
    /do not exactly match deterministic compilation/,
  );
});

test("compiler rejects a resealed published source with a duplicate exact listing identity", () => {
  const valid = publishedSource();
  const body = structuredClone(valid);
  delete body.snapshot_id;
  delete body.body_sha256;
  body.rows.push(structuredClone(body.rows[0]));
  const bodySha256 = digest(body);
  const duplicate = {
    ...body,
    snapshot_id: `walmart-shadow-catalog-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };

  assert.throws(
    () => compileWalmartShadowZeroEvidenceSources(duplicate),
    /duplicate listing_key/,
  );
});

test("operational verifier replays zero baseline through trusted ITEM v6 capture", () => {
  const fixture = trustedItemReportFixture();
  const zeroSources = compileWalmartShadowZeroEvidenceSources(fixture.publishedCatalog);

  assert.deepEqual(
    verifyWalmartShadowZeroEvidenceSourcesAgainstItemReportCapture(
      zeroSources,
      fixture.publishedCatalog,
      fixture.itemReportSource,
      fixture.capture,
      fixture.context,
    ),
    zeroSources,
  );
  assert.deepEqual(
    zeroSources.prior_visual_source.rows.map((row) => [row.sku, row.verdict]),
    [["Bread-6", "NOT_AUDITED"], ["bread-6", "NOT_AUDITED"]],
  );
  assert.ok(zeroSources.remediation_source.rows.every((row) => (
    row.status === "NOT_APPLIED" && row.verification === null
  )));
});

test("operational verifier rejects body-only swap under the original trusted exchange seal", () => {
  const fixture = trustedItemReportFixture();
  const zeroSources = compileWalmartShadowZeroEvidenceSources(fixture.publishedCatalog);
  const swappedBytes = bytes([
    "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition",
    "foreign,Foreign Product,999999999999,UPC,PUBLISHED,New",
  ].join("\n") + "\n");
  const swappedCapture = {
    ...fixture.capture,
    downloaded_body_bytes: swappedBytes,
    http: {
      ...fixture.capture.http,
      download_response: {
        ...fixture.capture.http.download_response,
        content_length: swappedBytes.byteLength,
      },
    },
  };

  assert.throws(
    () => verifyWalmartShadowZeroEvidenceSourcesAgainstItemReportCapture(
      zeroSources,
      fixture.publishedCatalog,
      fixture.itemReportSource,
      swappedCapture,
      fixture.context,
    ),
    /does not match the trusted atomic capture exchange seal/,
  );
});
