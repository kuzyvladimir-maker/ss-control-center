import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlink, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  buildWalmartItemReportDownloadLocatorRequestManifest,
  buildWalmartItemReportFileRequestManifest,
  buildWalmartItemReportReadyRequestManifest,
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  compileWalmartItemReportCatalogSource,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportUtf8Sha256,
  type HttpResponseCaptureMetadata,
  type WalmartItemReportCaptureEvidence,
  type WalmartItemReportCompileContext,
} from "@/lib/walmart/item-report-published-source";
import {
  WalmartSellerCatalogAuthorityError,
  buildWalmartExactIdentifierDuplicateGuardBinding,
  buildWalmartSellerCatalogAuthorityBinding,
  isWalmartExactIdentifierDuplicateGuardBinding,
  recheckWalmartSellerCatalogAuthorityBinding,
  verifyWalmartSellerCatalogAuthorityBinding,
  type BuildWalmartSellerCatalogAuthorityBindingInput,
  type WalmartSellerCatalogAuthorityErrorCode,
} from "../walmart-new-sku-catalog-authority";

const encoder = new TextEncoder();
const REQUEST_ID = "request-item-v6-authority-fixture";
const DOWNLOAD_URL =
  "https://walmart-reports.s3.amazonaws.com/reports/item-v6.csv?X-Amz-Signature=fixture";
const CAPTURE_FINGERPRINT = "a".repeat(64);
const BUSINESS_FINGERPRINT = "b".repeat(64);
const CORRELATIONS = Object.freeze({
  create_sha256: walmartItemReportUtf8Sha256("authority-correlation-create"),
  ready_status_sha256: walmartItemReportUtf8Sha256("authority-correlation-ready"),
  download_locator_sha256: walmartItemReportUtf8Sha256("authority-correlation-locator"),
  report_file_sha256: walmartItemReportUtf8Sha256("authority-correlation-file"),
});
const ACCOUNT_SCOPE = Object.freeze({
  channel: "WALMART_US" as const,
  store_index: 1,
  seller_account_fingerprint_sha256: CAPTURE_FINGERPRINT,
});
const BASE_CONTEXT = Object.freeze({
  account_scope: ACCOUNT_SCOPE,
  request_correlations: CORRELATIONS,
  ready_at: "2026-07-18T10:30:00.000Z",
  download_locator_at: "2026-07-18T10:31:00.000Z",
  report_file_requested_at: "2026-07-18T10:32:00.000Z",
  downloaded_at: "2026-07-18T10:33:00.000Z",
});
const MIRROR_SYNCED_AT = "2026-07-18T10:34:00.000Z";
const REPORT_DOWNLOADED_AT = "2026-07-18T10:33:30.000Z";
const NOW = new Date("2026-07-18T11:00:00.000Z");

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function http(
  responseBytes: Uint8Array,
  correlation: string | null,
  requestId: string | null,
  contentType = "application/json",
): HttpResponseCaptureMetadata {
  return {
    status: 200,
    content_type: contentType,
    content_length: responseBytes.byteLength,
    echoed_correlation_id_sha256: correlation,
    echoed_report_request_id_sha256: requestId,
  };
}

function buildCapture(): WalmartItemReportCaptureEvidence {
  const binding = (requestCorrelationSha256: string) => ({
    account_scope: ACCOUNT_SCOPE,
    request_correlation_id_sha256: requestCorrelationSha256,
  });
  const createRequest = bytes(JSON.stringify(
    buildWalmartItemReportV6CreateRequestManifest(binding(CORRELATIONS.create_sha256)),
  ));
  const createResponse = bytes(JSON.stringify({
    requestId: REQUEST_ID,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = bytes(JSON.stringify(buildWalmartItemReportReadyRequestManifest(
    REQUEST_ID,
    binding(CORRELATIONS.ready_status_sha256),
  )));
  const readyStatus = bytes(JSON.stringify({
    requestId: REQUEST_ID,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: "2026-07-18T10:00:00.000Z",
    reportGenerationDate: "2026-07-18T10:20:00.000Z",
  }));
  const locatorRequest = bytes(JSON.stringify(
    buildWalmartItemReportDownloadLocatorRequestManifest(
      REQUEST_ID,
      binding(CORRELATIONS.download_locator_sha256),
    ),
  ));
  const locatorResponse = bytes(JSON.stringify({
    requestId: REQUEST_ID,
    requestSubmissionDate: "2026-07-18T10:00:00.000Z",
    reportGenerationDate: "2026-07-18T10:20:00.000Z",
    downloadURL: DOWNLOAD_URL,
    downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
  }));
  const fileRequest = bytes(JSON.stringify(buildWalmartItemReportFileRequestManifest({
    ...binding(CORRELATIONS.report_file_sha256),
    locator_url: DOWNLOAD_URL,
  })));
  const reportBytes = bytes([
    "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,Brand,LifecycleStatus,Item ID,WPID",
    "SKU-A,Product A,000111222333,UPC,PUBLISHED,New,Brand A,ACTIVE,1001,WPID-A",
    "SKU-B,Product B,000111222340,UPC,UNPUBLISHED,New,Brand B,RETIRED,,WPID-B",
    "",
  ].join("\r\n"));
  const requestIdSha256 = walmartItemReportUtf8Sha256(REQUEST_ID);
  return {
    create_request_manifest_bytes: createRequest,
    create_response_payload_bytes: createResponse,
    ready_status_request_manifest_bytes: readyRequest,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: reportBytes,
    ready_status_payload_bytes: readyStatus,
    http: {
      create_response: http(
        createResponse,
        CORRELATIONS.create_sha256,
        requestIdSha256,
      ),
      ready_status_response: http(
        readyStatus,
        CORRELATIONS.ready_status_sha256,
        requestIdSha256,
      ),
      download_locator_response: http(
        locatorResponse,
        CORRELATIONS.download_locator_sha256,
        requestIdSha256,
      ),
      download_response: http(reportBytes, null, null, "application/octet-stream"),
    },
  };
}

function trustedContext(
  capture: WalmartItemReportCaptureEvidence,
): WalmartItemReportCompileContext {
  const seal = (
    requestBytes: Uint8Array,
    correlation: string,
    responseBytes: Uint8Array,
    responseHttp: HttpResponseCaptureMetadata,
  ) => walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: requestBytes,
    request_correlation_id_sha256: correlation,
    response_payload_bytes: responseBytes,
    http: responseHttp,
  });
  return {
    ...BASE_CONTEXT,
    trusted_exchange_seals: {
      create_response_sha256: seal(
        capture.create_request_manifest_bytes,
        CORRELATIONS.create_sha256,
        capture.create_response_payload_bytes,
        capture.http.create_response,
      ),
      ready_status_response_sha256: seal(
        capture.ready_status_request_manifest_bytes,
        CORRELATIONS.ready_status_sha256,
        capture.ready_status_payload_bytes,
        capture.http.ready_status_response,
      ),
      download_locator_response_sha256: seal(
        capture.download_locator_request_manifest_bytes,
        CORRELATIONS.download_locator_sha256,
        capture.download_locator_response_payload_bytes,
        capture.http.download_locator_response,
      ),
      download_response_sha256: seal(
        capture.report_file_request_manifest_bytes,
        CORRELATIONS.report_file_sha256,
        capture.downloaded_body_bytes,
        capture.http.download_response,
      ),
    },
  };
}

async function createSchema(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
    CREATE TABLE WalmartCatalogItem (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
      itemId TEXT, title TEXT, lifecycleStatus TEXT, publishedStatus TEXT,
      syncedAt TEXT NOT NULL
    );
    CREATE TABLE WalmartReport (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, reportType TEXT NOT NULL,
      requestId TEXT NOT NULL, status TEXT NOT NULL, requestedAt TEXT NOT NULL,
      downloadedAt TEXT, rowCount INTEGER
    );
  `);
  return db;
}

interface Fixture {
  db: Client;
  dir: string;
  sourcePath: string;
  sourceFileSha256: string;
  buildInput: BuildWalmartSellerCatalogAuthorityBindingInput;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const capture = buildCapture();
  const source = compileWalmartItemReportCatalogSource(
    capture,
    trustedContext(capture),
  );
  const canonicalBytes = Buffer.from(canonicalWalmartItemReportJson(source), "utf8");
  const realTmp = await realpath(tmpdir());
  const dir = await mkdtemp(join(realTmp, "walmart-catalog-authority-"));
  const sourcePath = join(dir, "catalog-source.json");
  await writeFile(sourcePath, canonicalBytes, { flag: "wx" });
  const sourceFileSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
  const db = await createSchema();
  for (const [index, row] of source.rows.entries()) {
    await db.execute({
      sql: `INSERT INTO WalmartCatalogItem
            (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
            VALUES (?,1,?,?,?,?,?,?)`,
      args: [
        `catalog-${index}`,
        row.sku,
        row.reported_legacy_item_identifier_opaque
          ?? row.reported_legacy_wpid_opaque,
        row.reported_product_name,
        row.reported_lifecycle_status,
        row.published_status,
        MIRROR_SYNCED_AT,
      ],
    });
  }
  await db.execute({
    sql: `INSERT INTO WalmartReport
          (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,rowCount)
          VALUES ('report-ok',1,'ITEM_CATALOG',?,'DOWNLOADED',?,?,?)`,
    args: [REQUEST_ID, "2026-07-18T10:00:00.000Z", REPORT_DOWNLOADED_AT, source.rows.length],
  });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    db,
    dir,
    sourcePath,
    sourceFileSha256,
    buildInput: {
      db,
      sourcePath,
      expectedSourceFileSha256: sourceFileSha256,
      storeIndex: 1,
      businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
      activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
      now: NOW,
    },
  };
}

async function assertAuthorityCode(
  action: () => Promise<unknown>,
  code: WalmartSellerCatalogAuthorityErrorCode,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WalmartSellerCatalogAuthorityError);
    assert.equal(error.code, code);
    return true;
  });
}

test("builds a deterministic exact all-status seller catalog authority binding", async (t) => {
  const fx = await fixture(t);
  const first = await buildWalmartSellerCatalogAuthorityBinding(fx.buildInput);
  const second = await buildWalmartSellerCatalogAuthorityBinding({
    ...fx.buildInput,
    now: new Date("2026-07-18T12:00:00.000Z"),
  });

  assert.deepEqual(first, second);
  assert.equal(first.source_artifact.row_count, 2);
  assert.equal(first.source_artifact.published_row_count, 1);
  assert.equal(first.source_artifact.file_sha256, fx.sourceFileSha256);
  assert.equal(
    first.account_scope.capture_credential_scope_fingerprint_sha256,
    CAPTURE_FINGERPRINT,
  );
  assert.equal(
    first.account_scope.business_seller_account_fingerprint_sha256,
    BUSINESS_FINGERPRINT,
  );
  assert.equal(first.mirror_reconciliation.exact_match, true);
  assert.equal(first.walmart_report_diagnostic.exact_match, true);
  assert.deepEqual(verifyWalmartSellerCatalogAuthorityBinding(first), first);
  assert.deepEqual(await recheckWalmartSellerCatalogAuthorityBinding({
    db: fx.db,
    expected: first,
    now: new Date("2026-07-18T12:30:00.000Z"),
  }), first);
});

test("exact staged SKU/UPC guard is sealed and requires no seller-catalog read", async () => {
  const first = buildWalmartExactIdentifierDuplicateGuardBinding({
    storeIndex: 1,
    businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
    ownerDecisionRef:
      "owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight",
  });
  const second = buildWalmartExactIdentifierDuplicateGuardBinding({
    storeIndex: 1,
    businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
    ownerDecisionRef:
      "owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight",
  });
  assert.deepEqual(first, second);
  assert.equal(isWalmartExactIdentifierDuplicateGuardBinding(first), true);
  assert.equal(first.policy.product_source, "PRODUCT_TRUTH_DONOR_CATALOG");
  assert.equal(first.policy.full_seller_catalog_required, false);
  assert.equal(first.policy.seller_recipe_catalog_scan_required, false);
  assert.equal(first.policy.exact_seller_sku_absence_required_before_certification, true);
  assert.equal(first.policy.exact_upc_catalog_search_required_before_certification, true);
  assert.deepEqual(verifyWalmartSellerCatalogAuthorityBinding(first), first);

  const noDatabaseCalls = {
    execute: async () => assert.fail("point duplicate guard must not query the seller catalog"),
  } as unknown as Client;
  assert.deepEqual(await recheckWalmartSellerCatalogAuthorityBinding({
    db: noDatabaseCalls,
    expected: first,
    now: NOW,
  }), first);
});

test("requires independently supplied exact file SHA and a safe absolute file", async (t) => {
  const fx = await fixture(t);
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...fx.buildInput,
      expectedSourceFileSha256: "f".repeat(64),
    }),
    "CATALOG_SOURCE_FILE_SHA256_MISMATCH",
  );
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...fx.buildInput,
      sourcePath: "relative/catalog-source.json",
    }),
    "UNSAFE_CATALOG_SOURCE_PATH",
  );

  const symlinkPath = join(fx.dir, "catalog-source-link.json");
  await symlink(fx.sourcePath, symlinkPath);
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...fx.buildInput,
      sourcePath: symlinkPath,
    }),
    "UNSAFE_CATALOG_SOURCE_PATH",
  );
});

test("binds the source to the active capture credential scope and exact store", async (t) => {
  const fx = await fixture(t);
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...fx.buildInput,
      activeCaptureCredentialScopeFingerprintSha256: "c".repeat(64),
    }),
    "CATALOG_SOURCE_SCOPE_MISMATCH",
  );
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...fx.buildInput,
      storeIndex: 2,
    }),
    "CATALOG_SOURCE_SCOPE_MISMATCH",
  );
});

test("rejects future or older-than-24h source and mirror timestamps", async (t) => {
  const future = await fixture(t);
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...future.buildInput,
      now: new Date("2026-07-18T10:32:59.999Z"),
    }),
    "CATALOG_SOURCE_STALE_OR_FUTURE",
  );

  const stale = await fixture(t);
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding({
      ...stale.buildInput,
      now: new Date("2026-07-19T10:34:00.001Z"),
    }),
    "CATALOG_SOURCE_STALE_OR_FUTURE",
  );

  const nonAtomic = await fixture(t);
  await nonAtomic.db.execute(
    "UPDATE WalmartCatalogItem SET syncedAt='2026-07-18T10:35:00.000Z' WHERE sku='SKU-A'",
  );
  await assertAuthorityCode(
    () => buildWalmartSellerCatalogAuthorityBinding(nonAtomic.buildInput),
    "CATALOG_MIRROR_NOT_ATOMIC",
  );
});

test("reconciles no missing, extra, duplicate, or changed mirror row", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (db: Client) => Promise<unknown>;
  }> = [
    {
      name: "missing",
      mutate: (db) => db.execute("DELETE FROM WalmartCatalogItem WHERE sku='SKU-B'"),
    },
    {
      name: "extra",
      mutate: (db) => db.execute({
        sql: `INSERT INTO WalmartCatalogItem
              (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
              VALUES ('extra',1,'SKU-X','item-x','Product X','ACTIVE','PUBLISHED',?)`,
        args: [MIRROR_SYNCED_AT],
      }),
    },
    {
      name: "duplicate",
      mutate: (db) => db.execute({
        sql: `INSERT INTO WalmartCatalogItem
              (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
              SELECT 'duplicate',storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt
              FROM WalmartCatalogItem WHERE sku='SKU-A'`,
      }),
    },
    {
      name: "changed title",
      mutate: (db) => db.execute(
        "UPDATE WalmartCatalogItem SET title='Product A changed' WHERE sku='SKU-A'",
      ),
    },
    {
      name: "changed item id",
      mutate: (db) => db.execute(
        "UPDATE WalmartCatalogItem SET itemId='other-item' WHERE sku='SKU-A'",
      ),
    },
    {
      name: "changed lifecycle",
      mutate: (db) => db.execute(
        "UPDATE WalmartCatalogItem SET lifecycleStatus='ARCHIVED' WHERE sku='SKU-A'",
      ),
    },
    {
      name: "changed published status",
      mutate: (db) => db.execute(
        "UPDATE WalmartCatalogItem SET publishedStatus='SYSTEM_PROBLEM' WHERE sku='SKU-A'",
      ),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fx = await fixture(subtest);
      await entry.mutate(fx.db);
      await assertAuthorityCode(
        () => buildWalmartSellerCatalogAuthorityBinding(fx.buildInput),
        "CATALOG_MIRROR_RECONCILIATION_MISMATCH",
      );
    });
  }
});

test("WalmartReport remains a required exact diagnostic, never the authority", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (db: Client) => Promise<unknown>;
  }> = [
    {
      name: "request mismatch",
      mutate: (db) => db.execute(
        "UPDATE WalmartReport SET requestId='other-request' WHERE id='report-ok'",
      ),
    },
    {
      name: "row count mismatch",
      mutate: (db) => db.execute(
        "UPDATE WalmartReport SET rowCount=3 WHERE id='report-ok'",
      ),
    },
    {
      name: "download skew",
      mutate: (db) => db.execute(
        "UPDATE WalmartReport SET downloadedAt='2026-07-18T10:45:00.000Z' WHERE id='report-ok'",
      ),
    },
    {
      name: "newer unrelated downloaded report",
      mutate: (db) => db.execute({
        sql: `INSERT INTO WalmartReport
              (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,rowCount)
              VALUES ('newer',1,'ITEM_CATALOG','other-request','DOWNLOADED',?,?,2)`,
        args: ["2026-07-18T10:34:00.000Z", "2026-07-18T10:35:00.000Z"],
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fx = await fixture(subtest);
      await entry.mutate(fx.db);
      await assertAuthorityCode(
        () => buildWalmartSellerCatalogAuthorityBinding(fx.buildInput),
        "CATALOG_REPORT_DIAGNOSTIC_MISMATCH",
      );
    });
  }
});

test("recheck fails if a coherent DB refresh changes the expected byte-exact binding", async (t) => {
  const fx = await fixture(t);
  const binding = await buildWalmartSellerCatalogAuthorityBinding(fx.buildInput);
  await fx.db.execute(
    "UPDATE WalmartCatalogItem SET syncedAt='2026-07-18T10:35:00.000Z'",
  );
  await fx.db.execute(
    "UPDATE WalmartReport SET downloadedAt='2026-07-18T10:35:00.000Z' WHERE id='report-ok'",
  );
  await assertAuthorityCode(
    () => recheckWalmartSellerCatalogAuthorityBinding({
      db: fx.db,
      expected: binding,
      now: NOW,
    }),
    "CATALOG_AUTHORITY_BINDING_DRIFT",
  );
});

test("pure verifier rejects coherent-looking seal and policy tampering", async (t) => {
  const fx = await fixture(t);
  const binding = await buildWalmartSellerCatalogAuthorityBinding(fx.buildInput);
  const tampered = structuredClone(binding);
  tampered.freshness_policy.future_tolerance_ms = 1 as 0;
  assert.throws(
    () => verifyWalmartSellerCatalogAuthorityBinding(tampered),
    (error: unknown) => {
      assert.ok(error instanceof WalmartSellerCatalogAuthorityError);
      assert.equal(error.code, "CATALOG_AUTHORITY_BINDING_INVALID");
      return true;
    },
  );
});
