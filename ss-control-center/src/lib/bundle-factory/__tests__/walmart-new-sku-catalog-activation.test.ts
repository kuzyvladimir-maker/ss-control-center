import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
import { computeWalmartSellerAccountFingerprint } from "@/lib/walmart/item-report-capture-session";
import { buildWalmartSellerCatalogAuthorityBinding } from "../walmart-new-sku-catalog-authority";
import { fingerprintWalmartSellerAccount } from "../walmart-new-sku-engine";
import { runWalmartNewSkuCatalogActivationCli } from "../../../../scripts/walmart-new-sku-catalog-activation";
import {
  WalmartNewSkuCatalogActivationError,
  applyWalmartNewSkuCatalogActivation,
  assembleWalmartNewSkuCatalogActivationOwnerApproval,
  buildWalmartNewSkuCatalogActivationConfirmation,
  buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest,
  planWalmartNewSkuCatalogActivation,
  verifyWalmartNewSkuCatalogActivationPlan,
  verifyWalmartNewSkuCatalogActivationReceipt,
  type ApplyWalmartNewSkuCatalogActivationInput,
  type SealedWalmartNewSkuCatalogActivationPlan,
} from "../walmart-new-sku-catalog-activation";

const encoder = new TextEncoder();
const REQUEST_ID = "request-item-v6-catalog-activation-fixture";
const DOWNLOAD_URL =
  "https://walmart-reports.s3.amazonaws.com/reports/item-v6.csv?X-Amz-Signature=fixture";
const TEST_CLIENT_ID = "catalog-activation-client-id";
const TEST_CLIENT_SECRET = "catalog-activation-client-secret";
const TEST_SELLER_ID = "catalog-activation-seller-id";
const TEST_OWNER_KEY_ID = "catalog-activation-owner-fixture";
const TEST_OWNER_KEYS = generateKeyPairSync("ed25519");
const TEST_OWNER_PUBLIC_KEY_DER = TEST_OWNER_KEYS.publicKey.export({
  format: "der",
  type: "spki",
}) as Buffer;
const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  WALMART_NEW_SKU_TEST_MODE: "1",
  WALMART_API_BASE_URL: "https://catalog-activation.fixture.test",
  WALMART_NEW_SKU_TEST_OWNER_KEY_ID: TEST_OWNER_KEY_ID,
  WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
    TEST_OWNER_PUBLIC_KEY_DER.toString("base64"),
  WALMART_CLIENT_ID_STORE1: TEST_CLIENT_ID,
  WALMART_CLIENT_SECRET_STORE1: TEST_CLIENT_SECRET,
  WALMART_STORE1_SELLER_ID: TEST_SELLER_ID,
};
const CAPTURE_FINGERPRINT = computeWalmartSellerAccountFingerprint({
  store_index: 1,
  client_id: TEST_CLIENT_ID,
  seller_id: TEST_SELLER_ID,
});
const BUSINESS_FINGERPRINT = fingerprintWalmartSellerAccount({
  storeIndex: 1,
  sellerId: TEST_SELLER_ID,
});
const DATABASE_FINGERPRINT = "d".repeat(64);
const CORRELATIONS = Object.freeze({
  create_sha256: walmartItemReportUtf8Sha256("activation-correlation-create"),
  ready_status_sha256: walmartItemReportUtf8Sha256("activation-correlation-ready"),
  download_locator_sha256:
    walmartItemReportUtf8Sha256("activation-correlation-locator"),
  report_file_sha256: walmartItemReportUtf8Sha256("activation-correlation-file"),
});
const ACCOUNT_SCOPE = Object.freeze({
  channel: "WALMART_US" as const,
  store_index: 1,
  seller_account_fingerprint_sha256: CAPTURE_FINGERPRINT,
});
const BASE_CONTEXT = Object.freeze({
  account_scope: ACCOUNT_SCOPE,
  request_correlations: CORRELATIONS,
  ready_at: "2026-07-19T10:30:00.000Z",
  download_locator_at: "2026-07-19T10:31:00.000Z",
  report_file_requested_at: "2026-07-19T10:32:00.000Z",
  downloaded_at: "2026-07-19T10:33:00.000Z",
});
const PLAN_NOW = new Date("2026-07-19T11:00:00.000Z");
const APPLY_NOW = new Date("2026-07-19T11:05:00.000Z");

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
    requestSubmissionDate: "2026-07-19T10:00:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = bytes(JSON.stringify(buildWalmartItemReportReadyRequestManifest(
    REQUEST_ID,
    binding(CORRELATIONS.ready_status_sha256),
  )));
  const readyResponse = bytes(JSON.stringify({
    requestId: REQUEST_ID,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: "2026-07-19T10:00:00.000Z",
    reportGenerationDate: "2026-07-19T10:20:00.000Z",
  }));
  const locatorRequest = bytes(JSON.stringify(
    buildWalmartItemReportDownloadLocatorRequestManifest(
      REQUEST_ID,
      binding(CORRELATIONS.download_locator_sha256),
    ),
  ));
  const locatorResponse = bytes(JSON.stringify({
    requestId: REQUEST_ID,
    requestSubmissionDate: "2026-07-19T10:00:00.000Z",
    reportGenerationDate: "2026-07-19T10:20:00.000Z",
    downloadURL: DOWNLOAD_URL,
    downloadURLExpirationTime: "2026-07-19T11:30:00.000Z",
  }));
  const fileRequest = bytes(JSON.stringify(buildWalmartItemReportFileRequestManifest({
    ...binding(CORRELATIONS.report_file_sha256),
    locator_url: DOWNLOAD_URL,
  })));
  const report = bytes([
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
    ready_status_payload_bytes: readyResponse,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: report,
    http: {
      create_response: http(createResponse, CORRELATIONS.create_sha256, requestIdSha256),
      ready_status_response: http(
        readyResponse,
        CORRELATIONS.ready_status_sha256,
        requestIdSha256,
      ),
      download_locator_response: http(
        locatorResponse,
        CORRELATIONS.download_locator_sha256,
        requestIdSha256,
      ),
      download_response: http(report, null, null, "application/octet-stream"),
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

async function createSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE WalmartCatalogItem (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
      itemId TEXT, title TEXT, lifecycleStatus TEXT, publishedStatus TEXT,
      syncedAt TEXT NOT NULL, mainImageUrl TEXT, mainImageFetchedAt TEXT
    );
    CREATE UNIQUE INDEX WalmartCatalogItem_storeIndex_sku_key
      ON WalmartCatalogItem(storeIndex,sku);
    CREATE TABLE WalmartReport (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, reportType TEXT NOT NULL,
      requestId TEXT NOT NULL UNIQUE, status TEXT NOT NULL, requestedAt TEXT NOT NULL,
      statusCheckedAt TEXT, readyAt TEXT, downloadedAt TEXT, rowCount INTEGER,
      error TEXT, updatedAt TEXT NOT NULL
    );
  `);
}

interface Fixture {
  root: string;
  db: Client;
  databaseUrl: string;
  sourcePath: string;
  sourceFileSha256: string;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "walmart-catalog-activation-"));
  const databaseUrl = pathToFileURL(resolve(root, "catalog.sqlite")).href;
  const db = createClient({ url: databaseUrl });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await createSchema(db);
  await db.executeMultiple(`
    INSERT INTO WalmartCatalogItem
      (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt,
       mainImageUrl,mainImageFetchedAt)
    VALUES
      ('old-a',1,'SKU-A','old-item','Old Product A','ACTIVE','PUBLISHED',
       '2026-07-19T09:01:00.000Z','https://images.example/a.jpg','2026-07-19T09:02:00.000Z'),
      ('old-only',1,'OLD-SKU','old-only','Old Product','ACTIVE','PUBLISHED',
       '2026-07-19T09:01:00.000Z',NULL,NULL),
      ('store-two',2,'STORE-2-SKU','store-two','Store 2 Product','ACTIVE','PUBLISHED',
       '2026-07-19T09:01:00.000Z',NULL,NULL);
    INSERT INTO WalmartReport
      (id,storeIndex,reportType,requestId,status,requestedAt,statusCheckedAt,
       readyAt,downloadedAt,rowCount,error,updatedAt)
    VALUES
      ('old-report',1,'ITEM_CATALOG','old-request','DOWNLOADED',
       '2026-07-19T08:00:00.000Z','2026-07-19T08:30:00.000Z',
       '2026-07-19T08:30:00.000Z','2026-07-19T08:31:00.000Z',2,NULL,
       '2026-07-19T08:31:00.000Z');
  `);
  const capture = buildCapture();
  const source = compileWalmartItemReportCatalogSource(capture, trustedContext(capture));
  const sourceBytes = Buffer.from(canonicalWalmartItemReportJson(source), "utf8");
  const sourcePath = resolve(root, "catalog-source.json");
  await writeFile(sourcePath, sourceBytes, { flag: "wx", mode: 0o600 });
  await chmod(sourcePath, 0o600);
  return {
    root,
    db,
    databaseUrl,
    sourcePath,
    sourceFileSha256: createHash("sha256").update(sourceBytes).digest("hex"),
  };
}

async function databaseSnapshot(db: Client): Promise<string> {
  const [catalog, reports] = await Promise.all([
    db.execute(`SELECT * FROM WalmartCatalogItem ORDER BY storeIndex,sku,id`),
    db.execute(`SELECT * FROM WalmartReport ORDER BY storeIndex,reportType,requestedAt,id`),
  ]);
  return JSON.stringify(
    { catalog: catalog.rows, reports: reports.rows },
    (_key, value) => typeof value === "bigint" ? Number(value) : value,
  );
}

async function plan(
  fx: Fixture,
  now = PLAN_NOW,
  environment = "test_fixture_only",
) {
  return planWalmartNewSkuCatalogActivation({
    db: fx.db,
    sourcePath: fx.sourcePath,
    expectedSourceFileSha256: fx.sourceFileSha256,
    storeIndex: 1,
    businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
    activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
    databaseTargetFingerprintSha256: DATABASE_FINGERPRINT,
    environment,
    now,
  });
}

function ownerApprovalFor(
  activationPlan: SealedWalmartNewSkuCatalogActivationPlan,
  now = APPLY_NOW,
) {
  const request = buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest({
    plan: activationPlan,
    keyId: TEST_OWNER_KEY_ID,
    approvalId: "catalog-activation-owner-approval-fixture",
    issuedAt: new Date("2026-07-19T11:01:00.000Z"),
    expiresAt: new Date("2026-07-19T11:25:00.000Z"),
    approvedBy: "owner-fixture",
    decisionRef: "https://owner.fixture.test/decisions/catalog-activation",
    now: new Date("2026-07-19T11:01:00.000Z"),
    env: TEST_ENV,
  });
  const detachedSignature = signEd25519(
    null,
    Buffer.from(request.signing_message_base64, "base64"),
    TEST_OWNER_KEYS.privateKey,
  );
  const approval = assembleWalmartNewSkuCatalogActivationOwnerApproval({
    request,
    plan: activationPlan,
    detachedSignature,
    now,
    env: TEST_ENV,
  });
  const artifactSha256 = createHash("sha256")
    .update(canonicalWalmartItemReportJson(approval))
    .digest("hex");
  return { request, detachedSignature, approval, artifactSha256 };
}

function authorizedApplyInput(
  fx: Fixture,
  activationPlan: SealedWalmartNewSkuCatalogActivationPlan,
): ApplyWalmartNewSkuCatalogActivationInput {
  const authorization = ownerApprovalFor(activationPlan);
  return {
    db: fx.db,
    plan: activationPlan,
    ownerApproval: authorization.approval,
    ownerApprovalArtifactSha256: authorization.artifactSha256,
    confirmation: buildWalmartNewSkuCatalogActivationConfirmation({
      plan: activationPlan,
      ownerApproval: authorization.approval,
      ownerApprovalArtifactSha256: authorization.artifactSha256,
      now: APPLY_NOW,
      env: TEST_ENV,
    }),
    businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
    activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
    databaseTargetFingerprintSha256: DATABASE_FINGERPRINT,
    environment: "test_fixture_only",
    now: APPLY_NOW,
    ownerTrustEnvironment: TEST_ENV,
    recheckOwnerApproval: async () => ({
      approval: authorization.approval,
      artifactSha256: authorization.artifactSha256,
      businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
      activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
    }),
  };
}

async function expectCode(
  action: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WalmartNewSkuCatalogActivationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("PLAN is DB-read-only and seals the exact all-status activation", async (t) => {
  const fx = await fixture(t);
  const before = await databaseSnapshot(fx.db);
  const result = await plan(fx);

  assert.equal(result.action, "ACTIVATE");
  assert.equal(result.eligible_for_apply, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.source.row_count, 2);
  assert.equal(result.current_state.mirror_row_count, 2);
  assert.equal(result.claims.walmart_api_calls, 0);
  assert.equal(result.claims.paid_provider_calls, 0);
  assert.deepEqual(verifyWalmartNewSkuCatalogActivationPlan(result), result);
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("APPLY atomically activates source, preserves image cache, and becomes authority-ready", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const result = await applyWalmartNewSkuCatalogActivation(
    authorizedApplyInput(fx, activationPlan),
  );

  assert.equal(result.database_changed, true);
  assert.equal(result.idempotent_replay, false);
  assert.deepEqual(
    verifyWalmartNewSkuCatalogActivationReceipt(result.receipt),
    result.receipt,
  );
  const rows = await fx.db.execute(
    `SELECT storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt,
            mainImageUrl,mainImageFetchedAt
     FROM WalmartCatalogItem ORDER BY storeIndex,sku`,
  );
  assert.equal(rows.rows.length, 3);
  assert.deepEqual(
    rows.rows.filter((row) => Number(row.storeIndex) === 1).map((row) => ({
      sku: row.sku,
      itemId: row.itemId,
      status: row.publishedStatus,
      syncedAt: row.syncedAt,
      image: row.mainImageUrl,
    })),
    [
      {
        sku: "SKU-A",
        itemId: "1001",
        status: "PUBLISHED",
        syncedAt: "2026-07-19T10:33:00.000Z",
        image: "https://images.example/a.jpg",
      },
      {
        sku: "SKU-B",
        itemId: "WPID-B",
        status: "UNPUBLISHED",
        syncedAt: "2026-07-19T10:33:00.000Z",
        image: null,
      },
    ],
  );

  const authority = await buildWalmartSellerCatalogAuthorityBinding({
    db: fx.db,
    sourcePath: fx.sourcePath,
    expectedSourceFileSha256: fx.sourceFileSha256,
    storeIndex: 1,
    businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
    activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
    now: new Date("2026-07-19T11:06:00.000Z"),
  });
  assert.equal(authority.source_artifact.row_count, 2);
  assert.equal(authority.mirror_reconciliation.exact_match, true);
  assert.equal(authority.walmart_report_diagnostic.exact_match, true);
});

test("same sealed APPLY is idempotent and returns the same receipt", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const applyInput = authorizedApplyInput(fx, activationPlan);
  const first = await applyWalmartNewSkuCatalogActivation(applyInput);
  const afterFirst = await databaseSnapshot(fx.db);
  const second = await applyWalmartNewSkuCatalogActivation({
    ...applyInput,
    now: new Date("2026-07-19T11:06:00.000Z"),
  });

  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(second.database_changed, false);
  assert.equal(second.idempotent_replay, true);
  assert.equal(await databaseSnapshot(fx.db), afterFirst);
});

test("wrong confirmation performs no database write", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const before = await databaseSnapshot(fx.db);
  await expectCode(
    applyWalmartNewSkuCatalogActivation({
      ...authorizedApplyInput(fx, activationPlan),
      confirmation: "wrong-confirmation",
    }),
    "CATALOG_ACTIVATION_CONFIRMATION_MISMATCH",
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("unsigned approval plus a self-generated confirmation cannot write", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const authorization = ownerApprovalFor(activationPlan);
  const unsignedArtifactSha256 = createHash("sha256")
    .update(canonicalWalmartItemReportJson(authorization.request))
    .digest("hex");
  const before = await databaseSnapshot(fx.db);

  await assert.rejects(
    applyWalmartNewSkuCatalogActivation({
      ...authorizedApplyInput(fx, activationPlan),
      ownerApproval: authorization.request,
      ownerApprovalArtifactSha256: unsignedArtifactSha256,
      confirmation: [
        "APPLY_WALMART_NEW_SKU_CATALOG_ACTIVATION_V2",
        activationPlan.plan_sha256,
        unsignedArtifactSha256,
      ].join(":"),
    }),
    (error: unknown) => error instanceof WalmartNewSkuCatalogActivationError,
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("a valid sealed source captured under another seller credential cannot write", async (t) => {
  const fx = await fixture(t);
  const before = await databaseSnapshot(fx.db);
  const otherCaptureFingerprint = computeWalmartSellerAccountFingerprint({
    store_index: 1,
    client_id: "other-seller-client-id",
    seller_id: "other-seller-id",
  });
  const otherBusinessFingerprint = fingerprintWalmartSellerAccount({
    storeIndex: 1,
    sellerId: "other-seller-id",
  });

  await expectCode(
    planWalmartNewSkuCatalogActivation({
      db: fx.db,
      sourcePath: fx.sourcePath,
      expectedSourceFileSha256: fx.sourceFileSha256,
      storeIndex: 1,
      businessSellerAccountFingerprintSha256: otherBusinessFingerprint,
      activeCaptureCredentialScopeFingerprintSha256: otherCaptureFingerprint,
      databaseTargetFingerprintSha256: DATABASE_FINGERPRINT,
      environment: "test_fixture_only",
      now: PLAN_NOW,
    }),
    "CATALOG_SOURCE_SCOPE_MISMATCH",
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("production fails closed for an empty trust root and a fixture/test key", async (t) => {
  const fx = await fixture(t);
  const productionPlan = await plan(fx, PLAN_NOW, "production");
  const before = await databaseSnapshot(fx.db);

  for (const env of [{} as NodeJS.ProcessEnv, TEST_ENV]) {
    assert.throws(
      () => buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest({
        plan: productionPlan,
        keyId: TEST_OWNER_KEY_ID,
        approvalId: "catalog-activation-production-fixture-attempt",
        issuedAt: new Date("2026-07-19T11:01:00.000Z"),
        expiresAt: new Date("2026-07-19T11:25:00.000Z"),
        approvedBy: "owner-fixture",
        decisionRef: "https://owner.fixture.test/decisions/not-production",
        now: new Date("2026-07-19T11:01:00.000Z"),
        env,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WalmartNewSkuCatalogActivationError);
        assert.equal(error.code, "CATALOG_ACTIVATION_OWNER_KEY_UNTRUSTED");
        return true;
      },
    );
  }
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("approval/account TOCTOU recheck fails before replacement", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const before = await databaseSnapshot(fx.db);
  const applyInput = authorizedApplyInput(fx, activationPlan);

  await expectCode(
    applyWalmartNewSkuCatalogActivation({
      ...applyInput,
      recheckOwnerApproval: async () => ({
        ...(await applyInput.recheckOwnerApproval()),
        businessSellerAccountFingerprintSha256: "e".repeat(64),
      }),
    }),
    "CATALOG_ACTIVATION_OWNER_APPROVAL_CHANGED",
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("failure after store delete rolls the whole activation back", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const before = await databaseSnapshot(fx.db);
  await assert.rejects(
    applyWalmartNewSkuCatalogActivation({
      ...authorizedApplyInput(fx, activationPlan),
      testHooks: {
        afterStoreDelete: async () => {
          throw new Error("injected rollback proof");
        },
      },
    }),
    /injected rollback proof/,
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("DB/image drift after PLAN blocks APPLY before replacement", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  await fx.db.execute(
    `UPDATE WalmartCatalogItem SET mainImageUrl='https://images.example/changed.jpg'
     WHERE storeIndex=1 AND sku='SKU-A'`,
  );
  const beforeApply = await databaseSnapshot(fx.db);
  await expectCode(
    applyWalmartNewSkuCatalogActivation({
      ...authorizedApplyInput(fx, activationPlan),
    }),
    "CATALOG_ACTIVATION_PRECONDITION_DRIFT",
  );
  assert.equal(await databaseSnapshot(fx.db), beforeApply);
});

test("equal/newer different ITEM_CATALOG report blocks activation", async (t) => {
  const fx = await fixture(t);
  await fx.db.execute({
    sql: `INSERT INTO WalmartReport
            (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,
             rowCount,updatedAt)
          VALUES ('newer',1,'ITEM_CATALOG','newer-request','DOWNLOADED',?,?,2,?)`,
    args: [
      "2026-07-19T10:34:00.000Z",
      "2026-07-19T10:35:00.000Z",
      "2026-07-19T10:35:00.000Z",
    ],
  });
  const activationPlan = await plan(fx);
  assert.equal(activationPlan.eligible_for_apply, false);
  assert.deepEqual(
    activationPlan.blockers,
    ["DIFFERENT_EQUAL_OR_NEWER_ITEM_CATALOG_REPORT_EXISTS"],
  );
});

test("unsafe, changed, or stale source fails closed", async (t) => {
  const fx = await fixture(t);
  await expectCode(
    planWalmartNewSkuCatalogActivation({
      db: fx.db,
      sourcePath: fx.sourcePath,
      expectedSourceFileSha256: "f".repeat(64),
      storeIndex: 1,
      businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
      activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
      databaseTargetFingerprintSha256: DATABASE_FINGERPRINT,
      environment: "test_fixture_only",
      now: PLAN_NOW,
    }),
    "CATALOG_SOURCE_FILE_SHA256_MISMATCH",
  );

  const link = resolve(fx.root, "source-link.json");
  await symlink(fx.sourcePath, link);
  await expectCode(
    planWalmartNewSkuCatalogActivation({
      db: fx.db,
      sourcePath: link,
      expectedSourceFileSha256: fx.sourceFileSha256,
      storeIndex: 1,
      businessSellerAccountFingerprintSha256: BUSINESS_FINGERPRINT,
      activeCaptureCredentialScopeFingerprintSha256: CAPTURE_FINGERPRINT,
      databaseTargetFingerprintSha256: DATABASE_FINGERPRINT,
      environment: "test_fixture_only",
      now: PLAN_NOW,
    }),
    "UNSAFE_CATALOG_SOURCE_PATH",
  );

  await expectCode(
    plan(fx, new Date("2026-07-20T10:33:00.001Z")),
    "CATALOG_SOURCE_STALE_OR_FUTURE",
  );
  assert.equal((await readFile(fx.sourcePath)).byteLength > 0, true);
});

test("expired plan blocks APPLY without opening a write path", async (t) => {
  const fx = await fixture(t);
  const activationPlan = await plan(fx);
  const before = await databaseSnapshot(fx.db);
  const applyInput = authorizedApplyInput(fx, activationPlan);
  await expectCode(
    applyWalmartNewSkuCatalogActivation({
      ...applyInput,
      now: new Date("2026-07-19T11:30:00.001Z"),
    }),
    "CATALOG_ACTIVATION_PLAN_EXPIRED",
  );
  assert.equal(await databaseSnapshot(fx.db), before);
});

test("owner-only CLI requires an external detached signature before atomic apply", async (t) => {
  const fx = await fixture(t);
  const planDirectory = resolve(fx.root, "cli-plan");
  const planned = await runWalmartNewSkuCatalogActivationCli([
    "plan",
    "--url", fx.databaseUrl,
    "--environment", "test_fixture_only",
    "--store-index", "1",
    "--source", fx.sourcePath,
    "--source-sha256", fx.sourceFileSha256,
    "--expires-at", "2026-07-19T11:30:00.000Z",
    "--out", planDirectory,
  ], { env: TEST_ENV, now: () => PLAN_NOW });
  assert.equal(planned.status, "PLANNED");
  assert.equal(planned.database_mutated, false);
  assert.equal(planned.owner_approval_required, true);
  assert.equal(planned.confirmation, null);
  const planBytes = await readFile(resolve(planDirectory, "plan.json"));
  const planFileSha256 = createHash("sha256").update(planBytes).digest("hex");
  assert.equal(
    await readFile(resolve(planDirectory, "plan.sha256"), "utf8"),
    `${planFileSha256}\n`,
  );
  await assert.rejects(
    readFile(resolve(planDirectory, "confirmation.txt")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const approvalRequestDirectory = resolve(fx.root, "cli-approval-request");
  const requested = await runWalmartNewSkuCatalogActivationCli([
    "approval-request",
    "--url", fx.databaseUrl,
    "--environment", "test_fixture_only",
    "--store-index", "1",
    "--plan", resolve(planDirectory, "plan.json"),
    "--plan-sha", resolve(planDirectory, "plan.sha256"),
    "--key-id", TEST_OWNER_KEY_ID,
    "--approval-id", "catalog-activation-cli-owner-approval",
    "--actor", "owner-fixture",
    "--decision-ref", "https://owner.fixture.test/decisions/catalog-cli",
    "--issued-at", "2026-07-19T11:01:00.000Z",
    "--approval-expires-at", "2026-07-19T11:25:00.000Z",
    "--out", approvalRequestDirectory,
  ], {
    env: TEST_ENV,
    now: () => new Date("2026-07-19T11:01:00.000Z"),
  });
  assert.equal(requested.status, "OWNER_SIGNATURE_REQUIRED");
  assert.equal(requested.private_key_accessed, false);
  const approvalRequest = JSON.parse(await readFile(
    resolve(approvalRequestDirectory, "approval-request.json"),
    "utf8",
  )) as { signing_message_base64: string };
  const detachedSignature = signEd25519(
    null,
    Buffer.from(approvalRequest.signing_message_base64, "base64"),
    TEST_OWNER_KEYS.privateKey,
  );
  const signaturePath = resolve(fx.root, "owner-signature.bin");
  await writeFile(signaturePath, detachedSignature, { flag: "wx", mode: 0o600 });

  const approvalDirectory = resolve(fx.root, "cli-owner-approval");
  const assembled = await runWalmartNewSkuCatalogActivationCli([
    "approval-assemble",
    "--url", fx.databaseUrl,
    "--environment", "test_fixture_only",
    "--store-index", "1",
    "--plan", resolve(planDirectory, "plan.json"),
    "--plan-sha", resolve(planDirectory, "plan.sha256"),
    "--approval-request", resolve(
      approvalRequestDirectory,
      "approval-request.json",
    ),
    "--detached-signature", signaturePath,
    "--out", approvalDirectory,
  ], {
    env: TEST_ENV,
    now: () => new Date("2026-07-19T11:02:00.000Z"),
  });
  assert.equal(assembled.status, "OWNER_APPROVAL_ASSEMBLED");
  assert.equal(assembled.private_key_accessed, false);
  const confirmation = (
    await readFile(resolve(approvalDirectory, "confirmation.txt"), "utf8")
  ).trim();

  const receiptDirectory = resolve(fx.root, "cli-receipt");
  const applied = await runWalmartNewSkuCatalogActivationCli([
    "apply",
    "--url", fx.databaseUrl,
    "--environment", "test_fixture_only",
    "--store-index", "1",
    "--plan", resolve(planDirectory, "plan.json"),
    "--plan-sha", resolve(planDirectory, "plan.sha256"),
    "--owner-approval", resolve(approvalDirectory, "approval.json"),
    "--owner-approval-sha", resolve(approvalDirectory, "approval.sha256"),
    "--confirm", confirmation,
    "--out", receiptDirectory,
  ], { env: TEST_ENV, now: () => APPLY_NOW });
  assert.equal(applied.status, "ACTIVE");
  assert.equal(applied.database_changed, true);
  const receiptBytes = await readFile(resolve(receiptDirectory, "receipt.json"));
  const receiptFileSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  assert.equal(
    await readFile(resolve(receiptDirectory, "receipt.sha256"), "utf8"),
    `${receiptFileSha256}\n`,
  );
});
