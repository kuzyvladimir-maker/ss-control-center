import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClient, type Client } from "@libsql/client";
import type {
  WalmartNewSkuApplyReceipt,
  WalmartNewSkuApprovalArtifact,
  WalmartNewSkuCertificationArtifact,
  WalmartNewSkuCertificationInput,
  WalmartNewSkuDoctorReceipt,
} from
  "@/lib/bundle-factory/walmart-new-sku-engine";
import {
  sealWalmartNewSkuVerifyReceipt,
} from "@/lib/bundle-factory/walmart-new-sku-engine";
import {
  buildPendingWalmartBuyerPublicationEvidenceTemplate,
} from "@/lib/bundle-factory/distribution/walmart-buyer-publication-evidence";
import {
  sha256WalmartJson,
} from "@/lib/bundle-factory/walmart-listing-contract";
import {
  WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
  WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS,
} from "@/lib/bundle-factory/walmart-new-sku-policy-review-evidence";
import {
  WALMART_POLICY_SOURCES,
  WALMART_POLICY_VERSION,
} from "@/lib/bundle-factory/validation/walmart-prepublication-policy";
import type {
  WalmartOwnerPermit,
  WalmartOwnerPermitSigningRequest,
} from "@/lib/bundle-factory/walmart-owner-permit";
import {
  createWalmartNewSkuFrozenRelease,
} from "@/lib/bundle-factory/walmart-new-sku-source-release";
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
  computeWalmartSellerAccountFingerprint,
} from "@/lib/walmart/item-report-capture-session";

const APP_ROOT = process.cwd();
const MIGRATIONS_ROOT = path.join(APP_ROOT, "prisma", "migrations");
const CLI = path.join(APP_ROOT, "scripts", "walmart-new-sku-engine.ts");
const OWNER_CLI = path.join(APP_ROOT, "scripts", "walmart-new-sku-owner.ts");
const FAKE_FETCH = path.join(
  APP_ROOT,
  "scripts",
  "__tests__",
  "helpers",
  "walmart-new-sku-fake-fetch.mjs",
);
const FIXTURE_WALMART_CLIENT_ID = "fixture-client-id";
const FIXTURE_WALMART_SELLER_ID = "fixture-seller-id";
const FIXTURE_ITEM_REPORT_REQUEST_ID = "fixture-item-report-request";

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ActiveCliRuntime {
  releaseRoot: string;
  operatorCli: string;
  ownerCli: string;
  fakeFetch: string;
}

let activeCliRuntime: ActiveCliRuntime | null = null;

async function runProcess(
  executable: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const runtimeArgs = activeCliRuntime
      ? args.map((arg) => {
          if (arg === CLI) return activeCliRuntime!.operatorCli;
          if (arg === OWNER_CLI) return activeCliRuntime!.ownerCli;
          if (arg === FAKE_FETCH) return activeCliRuntime!.fakeFetch;
          return arg;
        })
      : args;
    const usesFrozenCli = activeCliRuntime !== null && runtimeArgs.some(
      (arg) => arg === activeCliRuntime!.operatorCli || arg === activeCliRuntime!.ownerCli,
    );
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete childEnv[name];
      else childEnv[name] = value;
    }
    const child = spawn(executable, runtimeArgs, {
      cwd: options.cwd ?? (usesFrozenCli ? activeCliRuntime!.releaseRoot : APP_ROOT),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesWritable(path.join(root, entry.name));
    }
  }
}

async function freezeCurrentSourceOnce(parent: string) {
  return createWalmartNewSkuFrozenRelease({
    sourceRoot: APP_ROOT,
    outputDirectory: path.join(parent, "frozen-release"),
  });
}

function extractCreateObjects(sql: string): string[] {
  const lines = sql.split(/\r?\n/);
  const statements: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^CREATE TRIGGER\s+/i.test(line)) {
      const block = [line];
      while (++index < lines.length) {
        block.push(lines[index]);
        if (lines[index] === "END;") break;
      }
      statements.push(
        block.join("\n").replace(
          /^CREATE TRIGGER(?: IF NOT EXISTS)?\s+/i,
          "CREATE TRIGGER IF NOT EXISTS ",
        ),
      );
      continue;
    }
    if (/^CREATE (?:UNIQUE )?INDEX\s+/i.test(line)) {
      const block = [line];
      while (!block.at(-1)?.includes(";") && ++index < lines.length) {
        block.push(lines[index]);
      }
      statements.push(
        block.join("\n")
          .replace(
            /^CREATE UNIQUE INDEX(?: IF NOT EXISTS)?\s+/i,
            "CREATE UNIQUE INDEX IF NOT EXISTS ",
          )
          .replace(
            /^CREATE INDEX(?: IF NOT EXISTS)?\s+/i,
            "CREATE INDEX IF NOT EXISTS ",
          ),
      );
    }
  }
  return statements;
}

async function buildFreshCurrentSchema(db: Client): Promise<string[]> {
  const prismaExecutable = path.join(APP_ROOT, "node_modules", ".bin", "prisma");
  const diff = await runProcess(prismaExecutable, [
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
  ], { env: { DATABASE_URL: "file:./dev.db" } });
  assert.equal(diff.code, 0, diff.stderr || diff.stdout);
  const ddlStart = diff.stdout.indexOf("-- CreateTable");
  assert.ok(ddlStart >= 0, `Prisma diff produced no DDL:\n${diff.stdout}`);
  await db.executeMultiple(diff.stdout.slice(ddlStart));

  const entries = (await readdir(MIGRATIONS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const created: string[] = [];
  for (const name of entries) {
    const sql = await readFile(
      path.join(MIGRATIONS_ROOT, name, "migration.sql"),
      "utf8",
    );
    for (const statement of extractCreateObjects(sql)) {
      try {
        await db.executeMultiple(statement);
      } catch (error) {
        throw new Error(
          `Fresh integration DB failed safety object from ${name}: ${
            error instanceof Error ? error.message : String(error)
          }\n${statement.slice(0, 200)}`,
        );
      }
      created.push(name);
    }
  }
  return created;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoOffset(value: string, offsetMs: number): string {
  return new Date(Date.parse(value) + offsetMs).toISOString();
}

function itemReportBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function itemReportHttp(
  responseBytes: Uint8Array,
  correlationSha256: string | null,
  requestIdSha256: string | null,
  contentType = "application/json",
): HttpResponseCaptureMetadata {
  return {
    status: 200,
    content_type: contentType,
    content_length: responseBytes.byteLength,
    echoed_correlation_id_sha256: correlationSha256,
    echoed_report_request_id_sha256: requestIdSha256,
  };
}

async function writeSellerCatalogAuthorityFixture(
  root: string,
  observedAt: string,
): Promise<{ path: string; sha256: string }> {
  const captureFingerprint = computeWalmartSellerAccountFingerprint({
    store_index: 1,
    client_id: FIXTURE_WALMART_CLIENT_ID,
    seller_id: FIXTURE_WALMART_SELLER_ID,
  });
  const accountScope = {
    channel: "WALMART_US" as const,
    store_index: 1,
    seller_account_fingerprint_sha256: captureFingerprint,
  };
  const correlations = {
    create_sha256: walmartItemReportUtf8Sha256("fixture-item-report-create"),
    ready_status_sha256: walmartItemReportUtf8Sha256("fixture-item-report-ready"),
    download_locator_sha256:
      walmartItemReportUtf8Sha256("fixture-item-report-locator"),
    report_file_sha256: walmartItemReportUtf8Sha256("fixture-item-report-file"),
  };
  const binding = (requestCorrelationSha256: string) => ({
    account_scope: accountScope,
    request_correlation_id_sha256: requestCorrelationSha256,
  });
  const requestedAt = isoOffset(observedAt, -10 * 60_000);
  const generatedAt = isoOffset(observedAt, -4 * 60_000);
  const readyAt = isoOffset(observedAt, -3 * 60_000);
  const downloadLocatorAt = isoOffset(observedAt, -2 * 60_000);
  const reportFileRequestedAt = isoOffset(observedAt, -60_000);
  const downloadUrl =
    "https://walmart-reports.s3.amazonaws.com/reports/fixture-item-v6.csv?X-Amz-Signature=fixture";
  const createRequest = itemReportBytes(JSON.stringify(
    buildWalmartItemReportV6CreateRequestManifest(
      binding(correlations.create_sha256),
    ),
  ));
  const createResponse = itemReportBytes(JSON.stringify({
    requestId: FIXTURE_ITEM_REPORT_REQUEST_ID,
    requestSubmissionDate: requestedAt,
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = itemReportBytes(JSON.stringify(
    buildWalmartItemReportReadyRequestManifest(
      FIXTURE_ITEM_REPORT_REQUEST_ID,
      binding(correlations.ready_status_sha256),
    ),
  ));
  const readyResponse = itemReportBytes(JSON.stringify({
    requestId: FIXTURE_ITEM_REPORT_REQUEST_ID,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: requestedAt,
    reportGenerationDate: generatedAt,
  }));
  const locatorRequest = itemReportBytes(JSON.stringify(
    buildWalmartItemReportDownloadLocatorRequestManifest(
      FIXTURE_ITEM_REPORT_REQUEST_ID,
      binding(correlations.download_locator_sha256),
    ),
  ));
  const locatorResponse = itemReportBytes(JSON.stringify({
    requestId: FIXTURE_ITEM_REPORT_REQUEST_ID,
    requestSubmissionDate: requestedAt,
    reportGenerationDate: generatedAt,
    downloadURL: downloadUrl,
    downloadURLExpirationTime: isoOffset(observedAt, 60 * 60_000),
  }));
  const fileRequest = itemReportBytes(JSON.stringify(
    buildWalmartItemReportFileRequestManifest({
      ...binding(correlations.report_file_sha256),
      locator_url: downloadUrl,
    }),
  ));
  const reportBody = itemReportBytes([
    "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,Brand,LifecycleStatus,Item ID",
    "EXISTING-UNRELATED-1,Different Brand Tomato Soup 15 oz,012345678905,UPC,PUBLISHED,New,Different Brand,ACTIVE,fixture-item-existing",
    "",
  ].join("\r\n"));
  const requestIdSha256 = walmartItemReportUtf8Sha256(
    FIXTURE_ITEM_REPORT_REQUEST_ID,
  );
  const capture: WalmartItemReportCaptureEvidence = {
    create_request_manifest_bytes: createRequest,
    create_response_payload_bytes: createResponse,
    ready_status_request_manifest_bytes: readyRequest,
    ready_status_payload_bytes: readyResponse,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: reportBody,
    http: {
      create_response: itemReportHttp(
        createResponse,
        correlations.create_sha256,
        requestIdSha256,
      ),
      ready_status_response: itemReportHttp(
        readyResponse,
        correlations.ready_status_sha256,
        requestIdSha256,
      ),
      download_locator_response: itemReportHttp(
        locatorResponse,
        correlations.download_locator_sha256,
        requestIdSha256,
      ),
      download_response: itemReportHttp(
        reportBody,
        null,
        null,
        "application/octet-stream",
      ),
    },
  };
  const trustedSeal = (
    requestBytes: Uint8Array,
    correlationSha256: string,
    responseBytes: Uint8Array,
    responseHttp: HttpResponseCaptureMetadata,
  ) => walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: requestBytes,
    request_correlation_id_sha256: correlationSha256,
    response_payload_bytes: responseBytes,
    http: responseHttp,
  });
  const context: WalmartItemReportCompileContext = {
    account_scope: accountScope,
    request_correlations: correlations,
    ready_at: readyAt,
    download_locator_at: downloadLocatorAt,
    report_file_requested_at: reportFileRequestedAt,
    downloaded_at: observedAt,
    trusted_exchange_seals: {
      create_response_sha256: trustedSeal(
        createRequest,
        correlations.create_sha256,
        createResponse,
        capture.http.create_response,
      ),
      ready_status_response_sha256: trustedSeal(
        readyRequest,
        correlations.ready_status_sha256,
        readyResponse,
        capture.http.ready_status_response,
      ),
      download_locator_response_sha256: trustedSeal(
        locatorRequest,
        correlations.download_locator_sha256,
        locatorResponse,
        capture.http.download_locator_response,
      ),
      download_response_sha256: trustedSeal(
        fileRequest,
        correlations.report_file_sha256,
        reportBody,
        capture.http.download_response,
      ),
    },
  };
  const source = compileWalmartItemReportCatalogSource(capture, context);
  assert.equal(source.catalog_population_complete, true);
  assert.equal(source.rows.length, 1);
  assert.deepEqual(source.rows.map((row) => ({
    sku: row.sku,
    item_id: row.reported_legacy_item_identifier_opaque,
    title: row.reported_product_name,
    lifecycle_status: row.reported_lifecycle_status,
    published_status: row.published_status,
  })), [{
    sku: "EXISTING-UNRELATED-1",
    item_id: "fixture-item-existing",
    title: "Different Brand Tomato Soup 15 oz",
    lifecycle_status: "ACTIVE",
    published_status: "PUBLISHED",
  }]);
  const canonicalBytes = Buffer.from(
    canonicalWalmartItemReportJson(source),
    "utf8",
  );
  const sourcePath = path.join(root, "fixture-item-report-catalog-source.json");
  await writeFile(sourcePath, canonicalBytes, { flag: "wx" });
  return {
    path: sourcePath,
    sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
  };
}

function renderPosixArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertNextCommandContract(result: Record<string, unknown>): void {
  if (!("next_command" in result)) return;
  assert.ok("next_argv" in result, "next_command must always have exact next_argv");
  if (result.next_command === null) {
    assert.equal(result.next_argv, null);
    return;
  }
  assert.ok(Array.isArray(result.next_argv));
  assert.ok(result.next_argv.every((value) => typeof value === "string"));
  assert.equal(
    result.next_command,
    (result.next_argv as string[]).map(renderPosixArg).join(" "),
  );
}

async function seedCanonicalPilotFixture(
  db: Client,
  observedAt: string,
): Promise<void> {
  const donorProductId = "fixture-donor-1";
  const donorOfferId = "fixture-offer-1";
  const decisionId = "fixture-decision-1";
  const contentObservationId = "fixture-content-1";
  const priceObservationId = "fixture-price-1";
  const sourceUrl = "https://retailer.fixture.test/products/crunchy-snack";
  const sourceApi = "fixture-canonical-source";
  const identity = {
    brand: "Example Brand",
    productLine: "Crunchy Snack",
    flavor: "Sea Salt",
    form: "bag",
    sizeDimension: "MASS",
    sizeBaseAmount: 226.796,
    sizeBaseUnit: "g",
    outerPackCount: 1,
  };
  const identityJson = stableJson(identity);
  const identityHash = sha256(identityJson);
  const canonicalVariantId = `cpv1:${identityHash}`;
  const decisionEvidenceJson = JSON.stringify({
    exact: true,
    source: "fixture-reviewed-product-label",
  });
  const decisionEvidenceHash = sha256(decisionEvidenceJson);
  const content = {
    title: "Example Brand Crunchy Snack Sea Salt 8 oz",
    ingredients: "Potatoes, sunflower oil, sea salt",
    nutritionFacts: { calories: 140, servingSize: "1 oz" },
    allergens: [],
    mainImageUrl: "https://images.fixture.test/source-main.png",
    imageUrls: [
      "https://images.fixture.test/source-main.png",
      "https://images.fixture.test/source-nutrition.png",
    ],
    category: "Snack Foods",
    storageTemp: "Shelf Stable",
    upc: "012345678905",
    attributes: { netContent: "8 oz" },
  };
  const contentJson = JSON.stringify(content);
  const contentHash = sha256(contentJson);
  const fieldHashesJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(content).map(([key, value]) => [key, sha256(stableJson(value))]),
    ),
  );
  const contentObservationKey = sha256(stableJson({
    donorProductId,
    canonicalVariantId,
    variantDecisionId: decisionId,
    sourceUrl,
    sourceApi,
    contentHash,
    observedAt,
    runId: null,
    approvalId: null,
    meteredReceiptId: null,
  }));
  const priceObservationKey = sha256(stableJson({
    donorOfferId,
    donorProductId,
    canonicalVariantId,
    variantDecisionId: decisionId,
    retailer: "walmart",
    retailerProductId: "fixture-retail-item-1",
    observedAt,
  }));
  const listingSku = "EXISTING-UNRELATED-1";
  const listingKey = `walmart:1:${listingSku}`;
  const scopeCreatedAt = new Date(Date.parse(observedAt) + 1_000).toISOString();
  const componentCreatedAt = new Date(Date.parse(observedAt) + 2_000).toISOString();
  const costCreatedAt = new Date(Date.parse(observedAt) + 3_000).toISOString();

  await db.execute({
    sql: `INSERT INTO DonorProduct (
      id, brand, productLine, flavor, containerType, size, unitMeasure,
      unitAmount, category, upc, identityKey, identityStatus, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
    args: [
      donorProductId,
      "Example Brand",
      "Crunchy Snack",
      "Sea Salt",
      "bag",
      "8 oz",
      "oz",
      8,
      "Dry",
      "012345678905",
      "fixture:example-brand:crunchy-snack:sea-salt:8oz",
      observedAt,
      observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
      id, variantKey, identityHash, keyVersion, normalizedBrand,
      normalizedProductLine, normalizedFlavor, normalizedModifiersJson,
      normalizedForm, sizeDimension, sizeBaseAmount, sizeBaseUnit,
      outerPackCount, identityJson, createdAt
    ) VALUES (?, ?, ?, 'canonical-product-variant-key/1.0.0', ?, ?, ?, '[]',
      ?, 'MASS', ?, 'g', 1, ?, ?)`,
    args: [
      canonicalVariantId,
      canonicalVariantId,
      identityHash,
      "Example Brand",
      "Crunchy Snack",
      "Sea Salt",
      "bag",
      226.796,
      identityJson,
      observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorProductVariantDecision (
      id, decisionKey, donorProductId, canonicalVariantId, decisionStatus,
      matcherVersion, evidenceHash, evidenceJson, decidedAt, createdAt
    ) VALUES (?, ?, ?, ?, 'exact_confirmed', 'canonical-product-match/1.2.0',
      ?, ?, ?, ?)`,
    args: [
      decisionId,
      "fixture-decision-key-1",
      donorProductId,
      canonicalVariantId,
      decisionEvidenceHash,
      decisionEvidenceJson,
      observedAt,
      observedAt,
    ],
  });
  await db.execute({
    sql: `UPDATE DonorProduct SET
      identityStatus='exact_confirmed',
      identityMatcherVersion='canonical-product-match/1.2.0',
      identityEvidenceJson=?, identityConfirmedAt=?, updatedAt=?
      WHERE id=?`,
    args: [decisionEvidenceJson, observedAt, observedAt, donorProductId],
  });
  await db.execute({
    sql: `INSERT INTO ProductContentObservation (
      id, observationKey, donorProductId, canonicalVariantId,
      variantDecisionId, sourceUrl, sourceApi, contentHash,
      fieldHashesJson, contentJson, observedAt, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      contentObservationId,
      contentObservationKey,
      donorProductId,
      canonicalVariantId,
      decisionId,
      sourceUrl,
      sourceApi,
      contentHash,
      fieldHashesJson,
      contentJson,
      observedAt,
      observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorOffer (
      id, donorProductId, retailer, retailerProductId, via, price,
      packSizeSeen, pricePerUnit, currency, zip, localityEvidence,
      inStock, productUrl, sellerName, isFirstParty, sourceApi,
      fetchedAt, createdAt, updatedAt
    ) VALUES (?, ?, 'walmart', 'fixture-retail-item-1', 'direct', 3.99,
      1, 3.99, 'USD', '33765', 'zip_scoped', 1, ?, 'Walmart', 1,
      'fixture-canonical-source', ?, ?, ?)`,
    args: [donorOfferId, donorProductId, sourceUrl, observedAt, observedAt, observedAt],
  });
  await db.execute({
    sql: `INSERT INTO DonorOfferObservation (
      id, observationKey, donorOfferId, donorProductId, canonicalVariantId,
      variantDecisionId, retailer, retailerProductId, via, title, price,
      packSizeSeen, pricePerUnit, currency, zip, localityEvidence, inStock,
      productUrl, sellerName, isFirstParty, sourceApi, observedAt, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'walmart', 'fixture-retail-item-1', 'direct',
      'Example Brand Crunchy Snack Sea Salt 8 oz', 3.99, 1, 3.99, 'USD',
      '33765', 'zip_scoped', 1, ?, 'Walmart', 1,
      'fixture-canonical-source', ?, ?)`,
    args: [
      priceObservationId,
      priceObservationKey,
      donorOfferId,
      donorProductId,
      canonicalVariantId,
      decisionId,
      sourceUrl,
      observedAt,
      observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO UPCPool (
      id, upc, upc_prefix, gs1_validated, status, acquired_from,
      acquired_at, created_at, updated_at
    ) VALUES ('fixture-upc-pool-1', '012345678912', '012345', 0,
      'AVAILABLE', 'fixture-owner-pool', ?, ?, ?)`,
    args: [observedAt, observedAt, observedAt],
  });
  await db.execute({
    sql: `INSERT INTO WalmartCatalogItem (
      id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt
    ) VALUES (
      'fixture-existing-catalog-row',1,'EXISTING-UNRELATED-1','fixture-item-existing',
      'Different Brand Tomato Soup 15 oz','ACTIVE','PUBLISHED',?
    )`,
    args: [observedAt],
  });
  await db.execute({
    sql: `INSERT INTO SkuShippingData
          (id,sku,productIdentity,unitsInListing,source,createdAt,updatedAt)
          VALUES ('fixture-existing-shipping','EXISTING-UNRELATED-1',?,1,
                  'fixture',?,?)`,
    args: [
      JSON.stringify({
        brand: "Different Brand",
        product_line: "Tomato Soup",
        flavor: "Classic",
        form: "can",
        size: "15 oz",
        units_in_listing: 1,
      }),
      observedAt,
      observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO WalmartReport (
      id,storeIndex,reportType,requestId,status,requestedAt,readyAt,
      downloadedAt,rowCount,updatedAt
    ) VALUES (
      'fixture-item-catalog-report',1,'ITEM_CATALOG',?,
      'DOWNLOADED',?,?,?,1,?
    )`,
    args: [
      FIXTURE_ITEM_REPORT_REQUEST_ID,
      observedAt,
      observedAt,
      observedAt,
      observedAt,
    ],
  });

  const costId = "fixture-existing-cost-1";
  const recipeHash = sha256(`recipe:${costId}`);
  const componentEvidence = {
    evidenceStatus: "FACT",
    targetCanonicalVariantId: canonicalVariantId,
    contentCanonicalVariantId: canonicalVariantId,
    priceCanonicalVariantId: canonicalVariantId,
    contentObservationId,
    priceObservationId,
    product: "Example Brand Crunchy Snack",
    flavor: "Sea Salt",
    size: "8 oz",
    qty: 1,
    perUnit: 3.99,
    method: "exact",
    targetComparableUnitPrice: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: "canonical-product-match/1.2.0",
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
  };
  const recipeComponent = {
    idx: 0,
    priceEvidenceStatus: "FACT",
    targetCanonicalVariantId: canonicalVariantId,
    contentCanonicalVariantId: canonicalVariantId,
    priceCanonicalVariantId: canonicalVariantId,
    contentObservationId,
    priceEvidenceObservationId: priceObservationId,
    contentDonorProductId: donorProductId,
    priceEvidenceDonorProductId: donorProductId,
    priceEvidenceOfferId: donorOfferId,
    priceVariantDecisionId: decisionId,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: "canonical-product-match/1.2.0",
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
    product: "Example Brand Crunchy Snack",
    flavor: "Sea Salt",
    size: "8 oz",
    perUnit: 3.99,
    qty: 1,
    method: "exact",
  };
  const costEvidence = {
    schemaVersion: "product-truth-sku-cost-evidence/2.0.0",
    channel: "walmart",
    storeIndex: 1,
    listingKey,
    listingKeyVersion: "product-truth-listing-key/1.0.0",
    outcome: "FACT",
    recipeHash,
    evaluatedAt: costCreatedAt,
    total: 3.99,
    costPerUnit: 3.99,
    packSize: 1,
    components: [recipeComponent],
  };
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope (
      listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
      manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
      sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
    ) VALUES (?, 'product-truth-listing-key/1.0.0', 'walmart', 1, ?,
      'AUTHORITATIVE_PHASE1_MANIFEST','phase1-authoritative-scope-manifest/v3',
      ?, ?, 'fixture-owner-decision', 'fixture-phase1-report', ?, ?, ?)`,
    args: [
      listingKey,
      listingSku,
      sha256(`manifest:${listingKey}`),
      scopeCreatedAt,
      sha256(`source:${listingKey}`),
      scopeCreatedAt,
      scopeCreatedAt,
    ],
  });
  await db.batch([
    { sql: "PRAGMA defer_foreign_keys = ON", args: [] },
    {
      sql: `INSERT INTO SkuCostListingScopeLink
            (skuCostId,listingKey,linkVersion,createdAt)
            VALUES (?,?,'sku-cost-listing-scope-link/1.0.0',?)`,
      args: [costId, listingKey, componentCreatedAt],
    },
    {
      sql: `INSERT INTO SkuComponentEvidence (
        id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
        targetCanonicalVariantId,contentCanonicalVariantId,priceCanonicalVariantId,
        contentObservationId,priceObservationId,matchTier,matcherVersion,
        pricePolicyVersion,evidenceHash,evidenceJson,createdAt
      ) VALUES (?,?,?,0,'FACT',?,?,?,?,?,'EXACT_IDENTITY',
        'canonical-product-match/1.2.0','price-evidence-eligibility/1.0.0',?,?,?)`,
      args: [
        "fixture-existing-component-evidence-1",
        sha256("fixture-existing-component-evidence-key-1"),
        costId,
        canonicalVariantId,
        canonicalVariantId,
        canonicalVariantId,
        contentObservationId,
        priceObservationId,
        sha256(JSON.stringify(componentEvidence)),
        JSON.stringify(componentEvidence),
        componentCreatedAt,
      ],
    },
    {
      sql: `INSERT INTO SkuCost (
        id,sku,effectiveDate,productCost,totalCost,costPerUnit,packSize,
        includesPackaging,currency,source,needsReview,observationKey,recipeHash,
        evidenceJson,evidenceOutcome,matcherVersion,pricePolicyVersion,runId,
        approvalId,createdAt,updatedAt
      ) VALUES (?,?,?,3.99,3.99,3.99,1,0,'USD','retail:batch',0,?,?,?,
        'FACT','canonical-product-match/1.2.0','price-evidence-eligibility/1.0.0',
        'fixture-approved-run','fixture-owner-approval',?,?)`,
      args: [
        costId,
        listingSku,
        costCreatedAt,
        sha256(`cost:${costId}`),
        recipeHash,
        JSON.stringify(costEvidence),
        costCreatedAt,
        costCreatedAt,
      ],
    },
  ], "write");
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  cli = CLI,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const result = await runProcess(
    process.execPath,
    ["--import", "tsx", "--import", FAKE_FETCH, cli, ...args],
    { env, cwd },
  );
  assert.equal(
    result.code,
    0,
    `CLI failed: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  try {
    const stdout = result.stdout.trim();
    const jsonStart = stdout.lastIndexOf("\n{");
    const parsed = JSON.parse(
      jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout,
    ) as Record<string, unknown>;
    assertNextCommandContract(parsed);
    return parsed;
  } catch {
    assert.fail(
      `CLI did not return one JSON object: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

test("Walmart new-SKU harness builds current schema plus migration safety objects", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-new-sku-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "harness.db");
  const db = createClient({ url: `file:${databasePath}` });
  t.after(() => db.close());

  const created = await buildFreshCurrentSchema(db);
  assert.ok(created.length >= 100);
  const objects = await db.execute(
    `SELECT type, name FROM sqlite_master
     WHERE name IN (
       'CanonicalProductVariant',
       'MarketplaceSubmissionAttempt',
       'WalmartBuyerPublicationEvidence',
       'UPCPool_reserved_for_id_key'
     )
     ORDER BY type, name`,
  );
  assert.deepEqual(
    objects.rows.map((row) => [String(row.type), String(row.name)]),
    [
      ["index", "UPCPool_reserved_for_id_key"],
      ["table", "CanonicalProductVariant"],
      ["table", "MarketplaceSubmissionAttempt"],
      ["table", "WalmartBuyerPublicationEvidence"],
    ],
  );
});

test("isolated CLI runs plan through verify status without a Walmart mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-new-sku-cli-"));
  t.after(async () => {
    await makeDirectoriesWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const artifactRoot = path.join(root, "operator artifacts; $(literal) and 'quote'");
  const databasePath = path.join(root, "harness.db");
  const tracePath = path.join(root, "fake-http.jsonl");
  const doctorPath = path.join(artifactRoot, "doctor receipt.json");
  const planPath = path.join(artifactRoot, "plan.json");
  const stagePath = path.join(artifactRoot, "stage.json");
  const certificationInputPath = path.join(artifactRoot, "certification-input.json");
  const sealedCertificationInputPath = path.join(
    artifactRoot,
    "certification-input-sealed.json",
  );
  const certificationPath = path.join(artifactRoot, "certification.json");
  const dryRunPath = path.join(artifactRoot, "dry-run.json");
  const approvalPath = path.join(artifactRoot, "approval.json");
  const applyPreviewPath = path.join(artifactRoot, "apply-preview.json");
  const applyLivePath = path.join(artifactRoot, "apply-live.json");
  const applyLiveRetryPath = path.join(artifactRoot, "apply-live-retry.json");
  const ownerPermitRequestPath = path.join(artifactRoot, "owner-permit-request.json");
  const ownerPermitSignaturePath = path.join(artifactRoot, "owner-permit-signature.bin");
  const ownerPermitPath = path.join(artifactRoot, "owner-permit.json");
  const forgedOwnerPermitPath = path.join(artifactRoot, "owner-permit-forged.json");
  const verifyPath = path.join(artifactRoot, "verify.json");
  const buyerSealVerifyReceiptPath = path.join(
    artifactRoot,
    "buyer-seal-verify-receipt.json",
  );
  const buyerEvidenceTemplatePath = path.join(
    artifactRoot,
    "buyer-evidence-template.json",
  );
  const buyerEvidenceSealedPath = path.join(
    artifactRoot,
    "buyer-evidence-sealed.json",
  );
  const buyerScreenshotPath = path.join(artifactRoot, "buyer-pdp.png");
  const liveInitialVerifyPath = path.join(
    artifactRoot,
    "live-initial-verify.json",
  );
  const liveRepeatedVerifyPath = path.join(
    artifactRoot,
    "live-repeated-verify.json",
  );
  const liveBuyerEvidenceSealedPath = path.join(
    artifactRoot,
    "live-buyer-evidence-sealed.json",
  );
  const liveBuyerScreenshotPath = path.join(
    artifactRoot,
    "live-buyer-pdp.png",
  );
  const liveFinalVerifyPath = path.join(
    artifactRoot,
    "live-final-verify.json",
  );
  const liveFinalReplayPath = path.join(
    artifactRoot,
    "live-final-replay.json",
  );

  const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const asOf = new Date(Date.now() - 5 * 60_000).toISOString();
  const ownerKeys = generateKeyPairSync("ed25519");
  const ownerPublicDer = ownerKeys.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const seedDb = createClient({ url: `file:${databasePath}` });
  await buildFreshCurrentSchema(seedDb);
  await seedCanonicalPilotFixture(seedDb, observedAt);
  const sellerCatalogSource = await writeSellerCatalogAuthorityFixture(
    root,
    observedAt,
  );
  const { readWalmartPilotCandidate } = await import(
    "../../src/lib/sourcing/product-truth-new-sku-view"
  );
  await readWalmartPilotCandidate(seedDb, {
    donorProductId: "fixture-donor-1",
    qty: 2,
    asOf,
    maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    zip: "33765",
  });
  await seedDb.close();

  const env: Record<string, string | undefined> = {
    DATABASE_URL: `file:${databasePath}`,
    // Point both selectors at the same disposable file. The CLI intentionally
    // prefers TURSO_DATABASE_URL when present; this prevents .env from routing
    // any child process to the real remote database.
    TURSO_DATABASE_URL: `file:${databasePath}`,
    TURSO_AUTH_TOKEN: "",
    WALMART_CLIENT_ID_STORE1: FIXTURE_WALMART_CLIENT_ID,
    WALMART_CLIENT_SECRET_STORE1: "fixture-client-secret",
    WALMART_STORE1_SELLER_ID: FIXTURE_WALMART_SELLER_ID,
    WALMART_STORE1_NAME: "Fixture Walmart Store",
    WALMART_API_BASE_URL: "https://walmart.fixture.test",
    WALMART_MP_ITEM_SPEC_VERSION: "5.0.20260501-19_21_29-api",
    VEEQO_API_KEY: "fixture-veeqo-key",
    VEEQO_BASE_URL: "https://veeqo.fixture.test",
    WALMART_NEW_SKU_FAKE_HTTP_TRACE: tracePath,
    WALMART_NEW_SKU_ALLOW_UNEXPECTED_NETWORK: "0",
    WALMART_NEW_SKU_TEST_MODE: "1",
    WALMART_NEW_SKU_TEST_OWNER_KEY_ID: "owner-fixture-2026-01",
    WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      ownerPublicDer.toString("base64"),
    NODE_ENV: "test",
  };
  const frozen = await freezeCurrentSourceOnce(root);
  const frozenCli = path.join(
    frozen.release_root,
    "scripts",
    "walmart-new-sku-engine.ts",
  );
  activeCliRuntime = {
    releaseRoot: frozen.release_root,
    operatorCli: frozenCli,
    ownerCli: path.join(
      frozen.release_root,
      "scripts",
      "walmart-new-sku-owner.ts",
    ),
    fakeFetch: path.join(
      frozen.release_root,
      "scripts",
      "__tests__",
      "helpers",
      "walmart-new-sku-fake-fetch.mjs",
    ),
  };
  t.after(() => {
    if (activeCliRuntime?.releaseRoot === frozen.release_root) {
      activeCliRuntime = null;
    }
  });
  const expectedEngineReleaseSha256 = frozen.engine_release_sha256;
  t.diagnostic(`frozen engine release SHA-256: ${expectedEngineReleaseSha256}`);
  t.diagnostic(
    `frozen dependency closure: ${frozen.dependency_package_count} packages, `
      + `${frozen.dependency_file_count} files, `
      + `${frozen.dependency_total_file_bytes} bytes`,
  );

  const frozenHelp = await runProcess(
    "npm",
    ["--silent", "run", "walmart:new-sku", "--", "--help"],
    { cwd: frozen.release_root },
  );
  assert.equal(frozenHelp.code, 0, frozenHelp.stderr);
  assert.match(frozenHelp.stdout, /engine-emitted exact next command/);

  const frozenReleaseVerify = await runProcess(
    "npm",
    [
      "--silent", "run", "walmart:new-sku:release", "--", "verify",
      "--release-root", frozen.release_root,
      "--manifest", frozen.manifest_path,
      "--manifest-sha", frozen.manifest_sha256_path,
      "--expected-engine-release-sha", expectedEngineReleaseSha256,
    ],
    { cwd: frozen.release_root },
  );
  assert.equal(frozenReleaseVerify.code, 0, frozenReleaseVerify.stderr);
  assert.match(frozenReleaseVerify.stdout, /"ok": true/);

  const frozenCertification = await runProcess(
    "npm",
    ["--silent", "run", "test:product-truth-certification"],
    {
      cwd: frozen.release_root,
      env: {
        DATABASE_URL: `file:${path.join(root, "product-truth-certification.db")}`,
        TURSO_DATABASE_URL:
          `file:${path.join(root, "product-truth-certification.db")}`,
        TURSO_AUTH_TOKEN: "",
        NODE_ENV: "test",
        // Node 25 marks descendants of a node:test worker. The certification
        // suite is an intentional independent process and must execute all files.
        NODE_TEST_CONTEXT: undefined,
      },
    },
  );
  assert.equal(
    frozenCertification.code,
    0,
    `Frozen Product Truth certification failed:\n${frozenCertification.stdout}\n${frozenCertification.stderr}`,
  );
  const certificationOutput =
    `${frozenCertification.stdout}\n${frozenCertification.stderr}`;
  const certificationPass = certificationOutput.match(/\bpass\s+([1-9][0-9]*)\b/);
  assert.ok(certificationPass, certificationOutput);
  t.diagnostic(`frozen Product Truth certification: ${certificationPass[1]} passed`);

  const doctor = await runCli([
    "doctor",
    "--expected-engine-release-sha", expectedEngineReleaseSha256,
    "--release-manifest", frozen.manifest_path,
    "--release-manifest-sha", frozen.manifest_sha256_path,
    "--item-report-catalog-source", sellerCatalogSource.path,
    "--expected-item-report-catalog-source-sha256", sellerCatalogSource.sha256,
    "--limit", "1",
    "--as-of", asOf,
    "--out", doctorPath,
  ], env, frozenCli, frozen.release_root);
  assert.equal(doctor.read_only, true);
  assert.equal(doctor.ready_for_plan, true);
  assert.equal(doctor.infrastructure_ready_for_pilot, true);
  assert.equal(doctor.ready_for_live_apply, false);
  assert.deepEqual(doctor.blockers, []);
  assert.equal(doctor.doctor_receipt, doctorPath);
  assert.match(String(doctor.doctor_receipt_sha256), /^[a-f0-9]{64}$/);
  assert.equal(doctor.expected_engine_release_sha256, expectedEngineReleaseSha256);
  assert.equal(doctor.release_manifest_sha256, frozen.manifest_sha256);
  assert.deepEqual(doctor.planning_scope, {
    as_of: asOf,
    zip: "33765",
    max_price_age_ms: 86_400_000,
    limit: 1,
    pack_count: 2,
  });
  assert.equal(
    doctor.next_command,
    `npm run walmart:new-sku -- plan --doctor-receipt ${renderPosixArg(doctorPath)} ` +
      `--store-index 1 --limit 1 --pack-count 2 --zip 33765 ` +
      `--as-of ${asOf} --max-price-age-hours 24`,
  );
  assert.deepEqual(doctor.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "plan",
    "--doctor-receipt", doctorPath,
    "--store-index", "1",
    "--limit", "1",
    "--pack-count", "2",
    "--zip", "33765",
    "--as-of", asOf,
    "--max-price-age-hours", "24",
  ]);

  const planned = await runCli([
    "plan",
    "--doctor-receipt", doctorPath,
    "--limit", "1",
    "--pack-count", "2",
    "--as-of", asOf,
    "--out", planPath,
  ], env);
  assert.equal(planned.database_mutated, false);
  assert.equal(planned.marketplace_mutated, false);
  assert.equal(planned.candidate_count, 1);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
  assert.equal(plan.schema_version, "walmart-new-sku-plan/1.3.0");
  assert.equal(plan.doctor_receipt_sha256, doctor.doctor_receipt_sha256);
  assert.equal(plan.engine_release_sha256, expectedEngineReleaseSha256);
  assert.equal(plan.release_manifest_sha256, frozen.manifest_sha256);
  assert.equal(plan.max_live_submissions, 1);
  const candidates = plan.candidates as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 1);
  const planSha = String(plan.plan_sha256);
  const candidateKey = String(candidates[0].candidate_key);
  assert.equal(
    planned.next_command,
    `npm run walmart:new-sku -- stage --plan ${renderPosixArg(planPath)} ` +
      `--doctor-receipt ${renderPosixArg(doctorPath)} ` +
      `--candidate ${candidateKey} --mode preview`,
  );
  assert.deepEqual(planned.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "stage",
    "--plan", planPath,
    "--doctor-receipt", doctorPath,
    "--candidate", candidateKey,
    "--mode", "preview",
  ]);

  const deniedStageWithoutDoctor = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "stage", "--plan", planPath, "--candidate", candidateKey,
      "--mode", "preview",
    ],
    { env },
  );
  assert.equal(deniedStageWithoutDoctor.code, 1);
  assert.match(deniedStageWithoutDoctor.stderr, /stage requires --doctor-receipt/);

  const doctorArtifactForStage = JSON.parse(
    await readFile(doctorPath, "utf8"),
  ) as WalmartNewSkuDoctorReceipt;
  assert.equal(
    doctorArtifactForStage.schema_version,
    "walmart-new-sku-doctor-receipt/1.4.0",
  );
  assert.equal(
    doctorArtifactForStage.release_manifest_sha256,
    frozen.manifest_sha256,
  );
  const staleDoctor = structuredClone(doctorArtifactForStage);
  staleDoctor.checked_at = new Date(Date.now() - 61 * 60_000).toISOString();
  staleDoctor.expires_at = new Date(Date.now() - 31 * 60_000).toISOString();
  const staleDoctorUnsigned = Object.fromEntries(
    Object.entries(staleDoctor).filter(([key]) => key !== "receipt_sha256"),
  );
  staleDoctor.receipt_sha256 = sha256(stableJson(staleDoctorUnsigned));
  const staleDoctorPath = path.join(root, "doctor-stale.json");
  await writeFile(staleDoctorPath, `${JSON.stringify(staleDoctor, null, 2)}\n`);
  const deniedPlanWithStaleDoctor = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "plan", "--doctor-receipt", staleDoctorPath,
      "--limit", "1", "--pack-count", "2", "--as-of", asOf,
      "--out", path.join(root, "plan-stale-must-not-exist.json"),
    ],
    { env },
  );
  assert.equal(deniedPlanWithStaleDoctor.code, 1);
  assert.match(deniedPlanWithStaleDoctor.stderr, /DOCTOR_RECEIPT_INVALID_OR_STALE/);
  const deniedStaleDoctor = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "stage", "--plan", planPath, "--doctor-receipt", staleDoctorPath,
      "--candidate", candidateKey, "--mode", "preview",
    ],
    { env },
  );
  assert.equal(deniedStaleDoctor.code, 1);
  assert.match(deniedStaleDoctor.stderr, /DOCTOR_RECEIPT_INVALID_OR_STALE/);

  const planWithManifestDrift = structuredClone(plan);
  planWithManifestDrift.release_manifest_sha256 = "f".repeat(64);
  const driftedPlanUnsigned = Object.fromEntries(
    Object.entries(planWithManifestDrift).filter(([key]) => key !== "plan_sha256"),
  );
  planWithManifestDrift.plan_sha256 = sha256(stableJson(driftedPlanUnsigned));
  const driftedPlanPath = path.join(root, "plan-manifest-drift.json");
  await writeFile(
    driftedPlanPath,
    `${JSON.stringify(planWithManifestDrift, null, 2)}\n`,
  );
  const deniedDoctorBindingDrift = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "stage", "--plan", driftedPlanPath, "--doctor-receipt", doctorPath,
      "--candidate", candidateKey, "--mode", "preview",
    ],
    {
      env: {
        ...env,
        TURSO_DATABASE_URL: "libsql://must-not-open.invalid",
        TURSO_AUTH_TOKEN: "",
      },
    },
  );
  assert.equal(deniedDoctorBindingDrift.code, 1);
  assert.match(deniedDoctorBindingDrift.stderr, /PLAN_DOCTOR_BINDING_DRIFT/);
  assert.doesNotMatch(
    deniedDoctorBindingDrift.stderr,
    /TURSO_AUTH_TOKEN|required|must-not-open/,
  );

  const stagePreview = await runCli([
    "stage",
    "--plan", planPath,
    "--doctor-receipt", doctorPath,
    "--candidate", candidateKey,
    "--mode", "preview",
  ], env);
  assert.equal(stagePreview.internal_database_mutated, false);
  assert.equal(stagePreview.marketplace_mutated, false);
  assert.deepEqual(stagePreview.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "stage",
    "--plan", planPath,
    "--doctor-receipt", doctorPath,
    "--candidate", candidateKey,
    "--mode", "apply-internal",
    "--actor", "<operator>",
    "--confirm", planSha,
  ]);
  assert.match(String(stagePreview.next_command), /--actor '<operator>'/);
  assert.match(String(stagePreview.next_command), /'[^']*operator artifacts;/);
  const shellRoundTrip = await runProcess("/bin/sh", [
    "-c",
    'eval "set -- $NEXT_COMMAND" && printf "%s\\n" "$@"',
  ], {
    env: { NEXT_COMMAND: String(stagePreview.next_command) },
  });
  assert.equal(shellRoundTrip.code, 0, shellRoundTrip.stderr);
  assert.deepEqual(
    shellRoundTrip.stdout.trimEnd().split("\n"),
    stagePreview.next_argv,
  );

  const staged = await runCli([
    "stage",
    "--plan", planPath,
    "--doctor-receipt", doctorPath,
    "--candidate", candidateKey,
    "--mode", "apply-internal",
    "--actor", "fixture-operator",
    "--confirm", planSha,
    "--out", stagePath,
  ], env);
  assert.equal(staged.internal_database_mutated, true);
  assert.equal(staged.marketplace_mutated, false);
  const stage = JSON.parse(await readFile(stagePath, "utf8")) as Record<string, unknown>;
  assert.equal(stage.upc, "012345678912");
  assert.notEqual(
    stage.upc,
    (candidates[0].source_candidate as Record<string, unknown>).manufacturer_upc,
    "the staged UPC must identify the sellable multipack, not its component unit",
  );

  const certificationTemplateResult = await runCli([
    "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--mode", "template",
    "--out", certificationInputPath,
  ], env);
  const generatedPolicyReviewTemplatePath = String(
    certificationTemplateResult.policy_review_evidence_template,
  );
  assert.equal(
    generatedPolicyReviewTemplatePath,
    path.join(
      path.dirname(certificationInputPath),
      `policy-review-input-${candidateKey}.json`,
    ),
  );
  assert.equal(
    certificationTemplateResult.policy_review_evidence_template_disposition,
    "created",
  );
  const generatedPolicyReviewTemplate = JSON.parse(
    await readFile(generatedPolicyReviewTemplatePath, "utf8"),
  ) as Record<string, unknown>;
  assert.match(String(generatedPolicyReviewTemplate.decision), /^TODO_/);
  assert.equal(
    (generatedPolicyReviewTemplate.official_sources as unknown[]).length,
    6,
  );
  assert.equal((generatedPolicyReviewTemplate.findings as unknown[]).length, 6);
  const certification = JSON.parse(
    await readFile(certificationInputPath, "utf8"),
  ) as WalmartNewSkuCertificationInput;
  assert.equal(
    certification.evidence_artifacts.find(
      (artifact) => artifact.kind === "POLICY_REVIEW",
    )?.path,
    generatedPolicyReviewTemplatePath,
  );
  const evidenceAt = new Date().toISOString();
  certification.price_cents = 2499;
  certification.packaging_cost_cents = 100;
  certification.shipping_label_cents = 0;
  certification.shipping_in_price = false;
  certification.images = [
    {
      ...certification.images[0],
      url: "https://images.fixture.test/listing-main.png",
      rights_basis: "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
      rights_evidence_ref: "fixture-evidence://image-rights/main-v1",
      reviewed_at: evidenceAt,
    },
    {
      ...certification.images[1],
      url: "https://images.fixture.test/listing-secondary.png",
      rights_basis: "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
      rights_evidence_ref: "fixture-evidence://image-rights/secondary-v1",
      reviewed_at: evidenceAt,
    },
  ];
  certification.physical_package = {
    schema_version: "bundle-factory.verified-physical-package/v1",
    source: "OPERATOR_SHIP_SPECS",
    verified_at: evidenceAt,
    weight_oz: 20,
    length_in: 12,
    width_in: 8,
    height_in: 6,
  };
  certification.walmart.product_type = "Snack Foods";
  certification.walmart.country_of_origin_substantial_transformation =
    "United States";
  certification.walmart.country_of_origin_evidence = {
    canonical_variant_id: String(candidates[0].canonical_variant_id),
    content_observation_id: "fixture-content-1",
    value: "United States",
    source: "PRODUCT_LABEL",
    evidence_ref: "fixture-evidence://country-of-origin/product-label-v1",
    verified_at: evidenceAt,
  };
  certification.walmart.offer_handoff = {
    mode: "INLINE",
    quantity: 1,
    fulfillment_center_id: "FIXTURE_FC_1",
    fulfillment_lag_time: 1,
  };
  certification.prepublication = {
    seller_account_health: {
      status: "HEALTHY_AND_ACCEPTING_NEW_ITEMS",
      store_index: 1,
      seller_account_fingerprint_sha256:
        String(plan.seller_account_fingerprint_sha256),
      verified_at: evidenceAt,
      evidence_ref: "fixture-evidence://seller-account/healthy-and-accepting-v1",
    },
    category_approvals: [{
      scope: "INGESTIBLE_PRODUCTS",
      status: "APPROVED",
      verified_at: evidenceAt,
      evidence_ref: "fixture-evidence://seller-center/ingestible-approval-v1",
    }],
    sku_policy_review: {
      status: "CLEARED",
      reviewed_at: evidenceAt,
      evidence_ref: "fixture-evidence://policy-review/walmart-v1",
    },
    recall_check: {
      status: "CLEAR",
      checked_at: evidenceAt,
      source: "FDA recalls and USDA FSIS recalls",
      evidence_ref: "fixture-evidence://recall-check/current-v1",
    },
    brand_rights: {
      brand: "Example Brand",
      basis: "AUTHORIZED_RESELLER",
      verified_at: evidenceAt,
      evidence_ref: "fixture-evidence://brand-rights/example-brand-v1",
    },
    condition: { value: "New", verified_at: evidenceAt },
    expiration: {
      applicable: true,
      shelf_life_days: 180,
      minimum_days_remaining_at_ship: 60,
      lot_check_procedure_ref: "fixture-evidence://lot-control/procedure-v1",
      source_ref: "fixture-evidence://expiration/manufacturer-v1",
      verified_at: evidenceAt,
    },
  };
  const evidenceSpecs = [
    ["fixture-evidence://image-rights/main-v1", "IMAGE_RIGHTS"],
    ["fixture-evidence://image-rights/secondary-v1", "IMAGE_RIGHTS"],
    ["fixture-evidence://country-of-origin/product-label-v1", "COUNTRY_OF_ORIGIN"],
    ["fixture-evidence://seller-center/ingestible-approval-v1", "CATEGORY_APPROVAL"],
    ["fixture-evidence://policy-review/walmart-v1", "POLICY_REVIEW"],
    ["fixture-evidence://recall-check/current-v1", "RECALL_CHECK"],
    ["fixture-evidence://brand-rights/example-brand-v1", "BRAND_RIGHTS"],
    [
      "fixture-evidence://seller-account/healthy-and-accepting-v1",
      "SELLER_ACCOUNT_HEALTH",
    ],
    ["fixture-evidence://lot-control/procedure-v1", "LOT_CONTROL_PROCEDURE"],
    ["fixture-evidence://expiration/manufacturer-v1", "EXPIRATION_SOURCE"],
  ] as const;
  certification.evidence_artifacts = [];
  const policyOverviewUrl = WALMART_POLICY_SOURCES.find(
    (source) => source.id === "prohibited-products-overview",
  )!.url;
  const policySourceUrl = (sourceId: string): string =>
    WALMART_POLICY_SOURCES.find((source) => source.id === sourceId)!.url;
  const policyReviewEvidence = {
    schema_version: WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
    binding: {
      wave_id: String(plan.wave_id),
      plan_sha256: String(plan.plan_sha256),
      stage_sha256: String(stage.stage_sha256),
      candidate_key: String(candidates[0].candidate_key),
      candidate_sha256: sha256WalmartJson(candidates[0]),
      store_index: Number(plan.store_index),
      business_seller_account_fingerprint_sha256:
        String(plan.seller_account_fingerprint_sha256),
      sku: String(stage.proposed_sku),
      upc: String(stage.upc),
      donor_product_id: String(candidates[0].donor_product_id),
      canonical_variant_id: String(candidates[0].canonical_variant_id),
      product_type: certification.walmart.product_type,
    },
    policy_version: WALMART_POLICY_VERSION,
    reviewed_at: evidenceAt,
    reviewer: {
      reviewer_id: "fixture-human-policy-reviewer",
      role: "HUMAN_COMPLIANCE_REVIEWER",
    },
    decision: "CLEARED",
    official_sources: WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.map(
      (sourceId) => ({
        source_id: sourceId,
        url: policySourceUrl(sourceId),
        captured_at: evidenceAt,
        checked_at: evidenceAt,
      }),
    ),
    findings: [
      {
        finding_id: "category-preapproval",
        disposition: "REQUIRES_APPROVAL",
        summary: "The exact seller account has the required ingestible entitlement.",
        policy_source_ids: ["prohibited-products-overview"],
        required_approval_scopes: ["INGESTIBLE_PRODUCTS"],
      },
      {
        finding_id: "condition-resale-rights",
        disposition: "CLEARED",
        summary: "New-condition resale and rights evidence was reviewed for this SKU.",
        policy_source_ids: ["resold-products"],
        required_approval_scopes: [],
      },
      {
        finding_id: "food-labeling-prohibited",
        disposition: "CLEARED",
        summary: "Food identity, labeling, and prohibited-food controls were reviewed.",
        policy_source_ids: ["food-products", "prohibited-products-overview"],
        required_approval_scopes: [],
      },
      {
        finding_id: "product-claims",
        disposition: "CLEARED",
        summary: "All public product claims were reviewed against current policy.",
        policy_source_ids: ["product-claims"],
        required_approval_scopes: [],
      },
      {
        finding_id: "recall-safety",
        disposition: "CLEARED",
        summary: "Recall and product-safety controls were reviewed for the exact item.",
        policy_source_ids: ["recalled-products"],
        required_approval_scopes: [],
      },
      {
        finding_id: "territory-legal-sanctions",
        disposition: "CLEARED",
        summary: "Territory, legal, sanctions, and state restrictions were reviewed.",
        policy_source_ids: [
          "prohibited-products-overview",
          "restricted-illegal-products",
        ],
        required_approval_scopes: [],
      },
    ],
    required_category_approvals:
      certification.prepublication.category_approvals.map((approval) => ({
        scope: approval.scope,
        status: "APPROVED" as const,
        verified_at: approval.verified_at,
        evidence_ref: approval.evidence_ref,
      })),
  };
  for (const [index, [ref, kind]] of evidenceSpecs.entries()) {
    const bytes = kind === "POLICY_REVIEW"
      ? Buffer.from(`${JSON.stringify(policyReviewEvidence, null, 2)}\n`, "utf8")
      : Buffer.from(`sealed fixture evidence ${index} ${ref}\n`, "utf8");
    const evidencePath = kind === "POLICY_REVIEW"
      ? generatedPolicyReviewTemplatePath
      : path.join(root, `certification-evidence-${index}.txt`);
    await writeFile(evidencePath, bytes);
    certification.evidence_artifacts.push({
      ref,
      kind,
      path: evidencePath,
      sha256: "TODO_ENGINE_SEALS_EXACT_EVIDENCE_SHA256",
      byte_size: null as never,
      captured_at: evidenceAt,
      source_url: kind === "POLICY_REVIEW" ? policyOverviewUrl : null,
    });
  }
  await writeFile(
    certificationInputPath,
    `${JSON.stringify(certification, null, 2)}\n`,
    "utf8",
  );
  const sealedEvidenceResult = await runCli([
    "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--evidence", certificationInputPath,
    "--mode", "seal-evidence",
    "--out", sealedCertificationInputPath,
  ], env);
  assert.equal(sealedEvidenceResult.internal_database_mutated, false);
  assert.equal(sealedEvidenceResult.marketplace_mutated, false);
  assert.equal(sealedEvidenceResult.evidence_artifact_count, evidenceSpecs.length);
  assert.deepEqual(sealedEvidenceResult.changed_fields, [
    "evidence_artifacts[].sha256",
    "evidence_artifacts[].byte_size",
  ]);
  assert.deepEqual(sealedEvidenceResult.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--evidence", sealedCertificationInputPath,
    "--mode", "preview",
  ]);
  const sealedCertification = JSON.parse(
    await readFile(sealedCertificationInputPath, "utf8"),
  ) as WalmartNewSkuCertificationInput;
  for (const [index, artifact] of sealedCertification.evidence_artifacts.entries()) {
    const bytes = await readFile(artifact.path);
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(artifact.byte_size, bytes.length, `sealed evidence ${index}`);
  }
  const overwriteDraftPath = path.join(root, "certification-input-overwrite.json");
  const overwriteDraft = structuredClone(certification);
  overwriteDraft.price_cents += 1;
  await writeFile(
    overwriteDraftPath,
    `${JSON.stringify(overwriteDraft, null, 2)}\n`,
    "utf8",
  );
  const deniedSealOverwrite = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "certify",
      "--plan", planPath,
      "--stage", stagePath,
      "--evidence", overwriteDraftPath,
      "--mode", "seal-evidence",
      "--out", sealedCertificationInputPath,
    ],
    { env },
  );
  assert.equal(deniedSealOverwrite.code, 1);
  assert.match(
    deniedSealOverwrite.stderr,
    /Refusing to overwrite a different artifact/,
  );

  const tamperedEvidencePath = path.join(root, "certification-input-bad-sha.json");
  const tamperedEvidence = structuredClone(sealedCertification);
  tamperedEvidence.evidence_artifacts[0]!.sha256 = "0".repeat(64);
  await writeFile(
    tamperedEvidencePath,
    `${JSON.stringify(tamperedEvidence, null, 2)}\n`,
    "utf8",
  );
  const deniedEvidence = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "certify",
      "--plan", planPath,
      "--stage", stagePath,
      "--evidence", tamperedEvidencePath,
      "--mode", "preview",
    ],
    { env },
  );
  assert.equal(deniedEvidence.code, 1);
  assert.match(deniedEvidence.stderr, /Evidence artifact SHA-256 mismatch/);

  const certificationPreview = await runCli([
    "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--evidence", sealedCertificationInputPath,
    "--mode", "preview",
  ], env);
  assert.equal(certificationPreview.evidence_structure_valid, true);
  const certificationInputSha = String(
    certificationPreview.certification_input_sha256,
  );

  const deniedExistingSellerSku = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "certify",
      "--plan", planPath,
      "--stage", stagePath,
      "--evidence", sealedCertificationInputPath,
      "--mode", "apply-internal",
      "--actor", "fixture-operator",
      "--confirm", certificationInputSha,
      "--out", path.join(root, "must-not-certify-existing-seller-sku.json"),
    ],
    { env: { ...env, WALMART_NEW_SKU_TEST_EXISTING_SELLER_SKU: "1" } },
  );
  assert.equal(deniedExistingSellerSku.code, 1);
  assert.match(deniedExistingSellerSku.stderr, /SELLER_SKU_ALREADY_EXISTS/);
  const postDeniedDb = createClient({ url: `file:${databasePath}` });
  const postDeniedCounts = await postDeniedDb.execute(
    `SELECT
       (SELECT COUNT(*) FROM ChannelSKU) AS channelSkus,
       (SELECT COUNT(*) FROM MasterBundle) AS masterBundles`,
  );
  assert.equal(Number(postDeniedCounts.rows[0]?.channelSkus), 0);
  assert.equal(Number(postDeniedCounts.rows[0]?.masterBundles), 0);
  await postDeniedDb.close();

  const certified = await runCli([
    "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--evidence", sealedCertificationInputPath,
    "--mode", "apply-internal",
    "--actor", "fixture-operator",
    "--confirm", certificationInputSha,
    "--out", certificationPath,
  ], env);
  assert.equal(certified.internal_database_mutated, true);
  assert.equal(certified.marketplace_mutated, false);
  assert.equal(certified.validation_status, "PASSED");
  const certificationReceiptPath = String(certified.receipt);

  const dryRun = await runCli([
    "dry-run",
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--out", dryRunPath,
  ], env);
  assert.equal(dryRun.database_mutated, false);
  assert.equal(dryRun.marketplace_mutated, false);
  assert.equal(dryRun.live_get_spec_valid, true);
  assert.deepEqual((dryRun.next_argv as string[]).slice(-2), ["--mode", "preview"]);
  assert.equal((dryRun.next_argv as string[]).includes("--actor"), false);
  assert.equal((dryRun.next_argv as string[]).includes("--confirm"), false);

  const approvalPreview = await runCli([
    "approve",
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--dry-run-receipt", dryRunPath,
    "--mode", "preview",
  ], env);
  assert.equal(approvalPreview.internal_database_mutated, false);
  assert.equal(approvalPreview.marketplace_mutated, false);
  const dryRunReceipt = JSON.parse(await readFile(dryRunPath, "utf8")) as Record<string, unknown>;

  const approved = await runCli([
    "approve",
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--dry-run-receipt", dryRunPath,
    "--mode", "apply-internal",
    "--actor", "fixture-owner",
    "--note", "integration fixture approval only",
    "--confirm", String(dryRunReceipt.receipt_sha256),
    "--out", approvalPath,
  ], env);
  assert.equal(approved.internal_database_mutated, true);
  assert.equal(approved.marketplace_mutated, false);

  const applyPreview = await runCli([
    "apply",
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--dry-run-receipt", dryRunPath,
    "--approval", approvalPath,
    "--mode", "preview",
    "--out", applyPreviewPath,
  ], env);
  assert.equal(applyPreview.marketplace_mutation_requested, false);
  assert.equal((applyPreview.distribution as Record<string, unknown>).ok, true);
  assert.equal(applyPreview.latest_submission_attempt, null);
  assert.equal(applyPreview.next_command, null);
  assert.equal(applyPreview.next_argv, null);
  assert.ok(applyPreview.owner_permit_template);

  const deniedWithoutDoctor = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", String(approved.approval_sha256),
    ],
    { env },
  );
  assert.equal(deniedWithoutDoctor.code, 1);
  assert.match(deniedWithoutDoctor.stderr, /live apply requires --doctor-receipt/);

  const deniedWithoutPreview = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--doctor-receipt", doctorPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", String(approved.approval_sha256),
    ],
    { env },
  );
  assert.equal(deniedWithoutPreview.code, 1);
  assert.match(deniedWithoutPreview.stderr, /live apply requires --apply-preview-receipt/);

  const deniedWithoutOwnerPermit = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--doctor-receipt", doctorPath,
      "--apply-preview-receipt", applyPreviewPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", String(approved.approval_sha256),
    ],
    { env },
  );
  assert.equal(deniedWithoutOwnerPermit.code, 1);
  assert.match(deniedWithoutOwnerPermit.stderr, /live apply requires --owner-permit/);

  const approvalArtifact = JSON.parse(
    await readFile(approvalPath, "utf8"),
  ) as WalmartNewSkuApprovalArtifact;
  const doctorArtifact = JSON.parse(
    await readFile(doctorPath, "utf8"),
  ) as WalmartNewSkuDoctorReceipt;
  const previewArtifact = JSON.parse(
    await readFile(applyPreviewPath, "utf8"),
  ) as WalmartNewSkuApplyReceipt;
  const certificationArtifact = JSON.parse(
    await readFile(certificationPath, "utf8"),
  ) as WalmartNewSkuCertificationArtifact;
  assert.equal(
    certificationArtifact.schema_version,
    "walmart-new-sku-certification/1.4.0",
  );
  const buyerAttemptId = "fixture-buyer-seal-attempt";
  const buyerItemId = "123456789";
  const buyerCapturedAt = new Date().toISOString();
  const buyerSealVerifyReceipt = sealWalmartNewSkuVerifyReceipt({
    schema_version: "walmart-new-sku-verify-receipt/1.1.0",
    certification_sha256: certificationArtifact.certification_sha256,
    channel_sku_id: certificationArtifact.channel_sku_id,
    sku: certificationArtifact.sku,
    payload_sha256: certificationArtifact.payload_sha256,
    submission_attempt_binding: {
      attempt_id: buyerAttemptId,
      channel_sku_id: certificationArtifact.channel_sku_id,
      certification_sha256: certificationArtifact.certification_sha256,
      payload_sha256: certificationArtifact.payload_sha256,
      seller_account_fingerprint_sha256:
        certificationArtifact.seller_account_fingerprint_sha256,
      idempotency_key: `walmart:v1:${createHash("sha256")
        .update(
          `${certificationArtifact.channel_sku_id}\n` +
            certificationArtifact.payload_sha256,
        )
        .digest("hex")}`,
    },
    verified_at: buyerCapturedAt,
    marketplace_mutated: false,
    local_lifecycle_reconciled: true,
    buyer_evidence_recorded: false,
    poll_result: {
      channel_sku_id: certificationArtifact.channel_sku_id,
      submission_attempt_id: buyerAttemptId,
      walmart_item_id: buyerItemId,
    },
    buyer_evidence_status: {
      channel_sku_id: certificationArtifact.channel_sku_id,
      attempt_id: buyerAttemptId,
      attempt_state: "ACCEPTED",
      walmart_item_id: buyerItemId,
      buyer_verified: false,
      evidence_id: null,
      evidence_hash: null,
      captured_at: null,
    },
  }, certificationArtifact);
  const {
    receipt_sha256: _buyerReceiptSha256,
    ...tornBuyerReceiptInput
  } = structuredClone(buyerSealVerifyReceipt);
  assert.ok(_buyerReceiptSha256);
  const tornBuyerPoll = tornBuyerReceiptInput.poll_result as
    | { submission_attempt_id: string }
    | null;
  if (tornBuyerPoll) {
    tornBuyerPoll.submission_attempt_id = "foreign-attempt";
  }
  assert.throws(
    () =>
      sealWalmartNewSkuVerifyReceipt(
        tornBuyerReceiptInput,
        certificationArtifact,
      ),
    /VERIFY_RECEIPT_POLL_ATTEMPT_BINDING_INVALID/,
  );
  const buyerTemplate = buildPendingWalmartBuyerPublicationEvidenceTemplate({
    certificationSha256: certificationArtifact.certification_sha256,
    verifyReceiptSha256: buyerSealVerifyReceipt.receipt_sha256,
    channelSkuId: certificationArtifact.channel_sku_id,
    submissionAttemptId: buyerAttemptId,
    sku: certificationArtifact.sku,
    walmartItemId: buyerItemId,
  });
  buyerTemplate.capturedAt = buyerCapturedAt as never;
  buyerTemplate.exactSkuMatch = true;
  buyerTemplate.exactItemIdMatch = true;
  buyerTemplate.published = true;
  buyerTemplate.buyable = true;
  buyerTemplate.rawEvidence.binding.captured_at = buyerCapturedAt as never;
  buyerTemplate.rawEvidence.artifact.ref = buyerScreenshotPath;
  buyerTemplate.rawEvidence.observation.page_rendered = true;
  buyerTemplate.rawEvidence.observation.availability = "IN_STOCK";
  buyerTemplate.rawEvidence.observation.add_to_cart_enabled = true;
  buyerTemplate.rawEvidence.observer = "fixture-operator";
  await Promise.all([
    writeFile(
      buyerSealVerifyReceiptPath,
      `${JSON.stringify(buyerSealVerifyReceipt, null, 2)}\n`,
    ),
    writeFile(
      buyerEvidenceTemplatePath,
      `${JSON.stringify(buyerTemplate, null, 2)}\n`,
    ),
    writeFile(buyerScreenshotPath, "fixture buyer PDP screenshot bytes\n"),
  ]);
  const traceLinesBeforeBuyerSeal = (await readFile(tracePath, "utf8"))
    .trim().split("\n").filter(Boolean).length;
  const sealedBuyerEvidence = await runCli([
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceTemplatePath,
    "--mode", "seal-evidence",
    "--out", buyerEvidenceSealedPath,
  ], env);
  assert.equal(sealedBuyerEvidence.mode, "seal-evidence");
  assert.equal(sealedBuyerEvidence.database_reads_performed, 0);
  assert.equal(sealedBuyerEvidence.walmart_reads_performed, 0);
  assert.equal(sealedBuyerEvidence.provider_calls_performed, 0);
  assert.deepEqual(sealedBuyerEvidence.changed_fields, [
    "rawEvidence.artifact.sha256",
  ]);
  assert.deepEqual(sealedBuyerEvidence.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceSealedPath,
    "--mode", "status",
  ]);
  const sealedBuyerJson = JSON.parse(
    await readFile(buyerEvidenceSealedPath, "utf8"),
  ) as Record<string, unknown>;
  const sealedBuyerArtifact = (
    (sealedBuyerJson.rawEvidence as Record<string, unknown>)
      .artifact as Record<string, unknown>
  );
  assert.equal(
    sealedBuyerArtifact.sha256,
    createHash("sha256")
      .update(await readFile(buyerScreenshotPath))
      .digest("hex"),
  );
  assert.equal("byte_size" in sealedBuyerArtifact, false);
  const traceLinesAfterBuyerSeal = (await readFile(tracePath, "utf8"))
    .trim().split("\n").filter(Boolean).length;
  assert.equal(traceLinesAfterBuyerSeal, traceLinesBeforeBuyerSeal);

  const buyerSealOverwrite = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceTemplatePath,
    "--mode", "seal-evidence",
    "--out", buyerEvidenceSealedPath,
  ], { env });
  assert.equal(buyerSealOverwrite.code, 1);
  assert.match(buyerSealOverwrite.stderr, /output must not already exist/);

  const buyerAliasRoot = path.join(root, "buyer-artifact-alias");
  await symlink(artifactRoot, buyerAliasRoot);
  const buyerSealAlias = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceTemplatePath,
    "--mode", "seal-evidence",
    "--out", path.join(buyerAliasRoot, path.basename(buyerEvidenceTemplatePath)),
  ], { env });
  assert.equal(buyerSealAlias.code, 1);
  assert.match(buyerSealAlias.stderr, /output aliases the buyer evidence template/);

  const duplicateBuyerTemplatePath = path.join(
    artifactRoot,
    "buyer-evidence-duplicate-key.json",
  );
  const duplicateBuyerTemplate = (
    await readFile(buyerEvidenceTemplatePath, "utf8")
  ).replace(
    `  "channelSkuId": "${certificationArtifact.channel_sku_id}",`,
    `  "channelSkuId": "${certificationArtifact.channel_sku_id}",\n` +
      `  "channelSkuId": "${certificationArtifact.channel_sku_id}",`,
  );
  await writeFile(duplicateBuyerTemplatePath, duplicateBuyerTemplate);
  const duplicateBuyerSeal = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", duplicateBuyerTemplatePath,
    "--mode", "seal-evidence",
    "--out", path.join(artifactRoot, "duplicate-must-not-seal.json"),
  ], { env });
  assert.equal(duplicateBuyerSeal.code, 1);
  assert.match(duplicateBuyerSeal.stderr, /canonical JSON bytes/);

  const duplicateCertificationPath = path.join(
    artifactRoot,
    "certification-duplicate-key.json",
  );
  const canonicalCertificationText = await readFile(certificationPath, "utf8");
  const duplicateCertification = canonicalCertificationText.replace(
    `  "sku": "${certificationArtifact.sku}",`,
    `  "sku": "${certificationArtifact.sku}",\n` +
      `  "sku": "${certificationArtifact.sku}",`,
  );
  assert.notEqual(duplicateCertification, canonicalCertificationText);
  await writeFile(duplicateCertificationPath, duplicateCertification);
  const duplicateCertificationSeal = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", duplicateCertificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceTemplatePath,
    "--mode", "seal-evidence",
    "--out", path.join(artifactRoot, "duplicate-certification-must-not-seal.json"),
  ], { env });
  assert.equal(duplicateCertificationSeal.code, 1);
  assert.match(duplicateCertificationSeal.stderr, /canonical JSON bytes/);
  const traceLinesBeforeDuplicateInitialVerify = (
    await readFile(tracePath, "utf8")
  ).trim().split("\n").filter(Boolean).length;
  const duplicateCertificationInitialVerify = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, CLI,
      "verify",
      "--certification", duplicateCertificationPath,
      "--out", path.join(
        artifactRoot,
        "duplicate-certification-initial-verify-must-fail.json",
      ),
    ],
    { env },
  );
  assert.equal(duplicateCertificationInitialVerify.code, 1);
  assert.match(
    duplicateCertificationInitialVerify.stderr,
    /canonical JSON bytes/,
  );
  assert.equal(
    (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean)
      .length,
    traceLinesBeforeDuplicateInitialVerify,
  );

  const duplicateVerifyReceiptPath = path.join(
    artifactRoot,
    "verify-receipt-duplicate-key.json",
  );
  const canonicalVerifyReceiptText = await readFile(
    buyerSealVerifyReceiptPath,
    "utf8",
  );
  const duplicateVerifyReceipt = canonicalVerifyReceiptText.replace(
    `  "sku": "${certificationArtifact.sku}",`,
    `  "sku": "${certificationArtifact.sku}",\n` +
      `  "sku": "${certificationArtifact.sku}",`,
  );
  assert.notEqual(duplicateVerifyReceipt, canonicalVerifyReceiptText);
  await writeFile(duplicateVerifyReceiptPath, duplicateVerifyReceipt);
  const duplicateVerifyReceiptSeal = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", duplicateVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceTemplatePath,
    "--mode", "seal-evidence",
    "--out", path.join(artifactRoot, "duplicate-receipt-must-not-seal.json"),
  ], { env });
  assert.equal(duplicateVerifyReceiptSeal.code, 1);
  assert.match(duplicateVerifyReceiptSeal.stderr, /canonical JSON bytes/);

  const ownerPermitArtifactArgs = [
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--dry-run-receipt", dryRunPath,
    "--approval", approvalPath,
    "--doctor-receipt", doctorPath,
    "--apply-preview-receipt", applyPreviewPath,
  ];
  const requestedPermit = await runCli([
    "owner-permit-request",
    ...ownerPermitArtifactArgs,
    "--permit-id", "owner-permit://integration/fixture-only-v2",
    "--pilot-slot", "1",
    "--actor", "fixture-owner",
    "--decision-ref", "owner-decision://integration/fixture-only-v2",
    "--out", ownerPermitRequestPath,
  ], env, OWNER_CLI);
  assert.equal(requestedPermit.private_key_accessed, false);
  assert.equal(requestedPermit.database_mutated, false);
  assert.equal(requestedPermit.marketplace_mutated, false);
  assert.equal(requestedPermit.output, ownerPermitRequestPath);
  const signingRequest = JSON.parse(
    await readFile(ownerPermitRequestPath, "utf8"),
  ) as WalmartOwnerPermitSigningRequest;
  const signedBody = signingRequest.signed_body;
  assert.equal(signingRequest.key_id, "owner-fixture-2026-01");
  assert.equal(signedBody.environment, "TEST_FIXTURE_ONLY");
  assert.equal(
    signedBody.engine_release_sha256,
    doctorArtifact.engine_release_sha256,
  );
  assert.equal(signedBody.approval_sha256, approvalArtifact.approval_sha256);
  assert.equal(signedBody.doctor_receipt_sha256, doctorArtifact.receipt_sha256);
  assert.equal(
    signedBody.apply_preview_receipt_sha256,
    previewArtifact.receipt_sha256,
  );
  assert.equal(
    signedBody.certification_sha256,
    certificationArtifact.certification_sha256,
  );
  assert.equal(signedBody.payload_sha256, certificationArtifact.payload_sha256);
  assert.equal(
    signedBody.seller_account_fingerprint_sha256,
    doctorArtifact.seller_account_fingerprint_sha256,
  );
  assert.equal(
    signedBody.database_target_fingerprint_sha256,
    doctorArtifact.database_target_fingerprint_sha256,
  );
  assert.equal(signedBody.pilot_slot, 1);
  const signature = sign(
    null,
    Buffer.from(String(signingRequest.signing_message_base64), "base64"),
    ownerKeys.privateKey,
  );
  assert.equal(signature.byteLength, 64);
  await writeFile(ownerPermitSignaturePath, signature);

  const assemblyArgs = (requestPath: string, signaturePath: string, outputPath: string) => [
    "owner-permit-assemble",
    ...ownerPermitArtifactArgs,
    "--owner-permit-request", requestPath,
    "--detached-signature", signaturePath,
    "--out", outputPath,
  ];
  const tamperCases: Array<[
    string,
    (request: WalmartOwnerPermitSigningRequest) => void,
  ]> = [
    ["key", (request) => { request.key_id = "substituted-owner-key"; }],
    ["environment", (request) => {
      request.signed_body.environment = "PRODUCTION";
    }],
    ["release", (request) => {
      request.signed_body.engine_release_sha256 = "a".repeat(64);
    }],
    ["payload", (request) => {
      request.signed_body.payload_sha256 = "b".repeat(64);
    }],
    ["target", (request) => {
      request.signed_body.database_target_fingerprint_sha256 = "c".repeat(64);
    }],
  ];
  for (const [label, mutate] of tamperCases) {
    const request = structuredClone(signingRequest);
    mutate(request);
    const requestPath = path.join(root, `owner-permit-request-${label}-tampered.json`);
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    const denied = await runProcess(
      process.execPath,
      [
        "--import", "tsx", "--import", FAKE_FETCH, OWNER_CLI,
        ...assemblyArgs(
          requestPath,
          ownerPermitSignaturePath,
          path.join(root, `owner-permit-${label}-must-not-exist.json`),
        ),
      ],
      { env },
    );
    assert.equal(denied.code, 1, `${label}: ${denied.stdout}`);
    assert.match(
      denied.stderr,
      /OWNER_PERMIT_SIGNING_REQUEST_BINDING_MISMATCH/,
    );
  }

  const wrongKeys = generateKeyPairSync("ed25519");
  const wrongSignaturePath = path.join(root, "owner-permit-wrong-signature.bin");
  await writeFile(
    wrongSignaturePath,
    sign(
      null,
      Buffer.from(String(signingRequest.signing_message_base64), "base64"),
      wrongKeys.privateKey,
    ),
  );
  const deniedWrongSignature = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, OWNER_CLI,
      ...assemblyArgs(
        ownerPermitRequestPath,
        wrongSignaturePath,
        path.join(root, "owner-permit-wrong-signature-must-not-exist.json"),
      ),
    ],
    { env },
  );
  assert.equal(deniedWrongSignature.code, 1);
  assert.match(
    deniedWrongSignature.stderr,
    /WALMART_OWNER_PERMIT_SIGNATURE_OR_BINDING_INVALID/,
  );

  const wrongTargetPath = path.join(root, "wrong-target.db");
  const deniedWrongTarget = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, OWNER_CLI,
      ...assemblyArgs(
        ownerPermitRequestPath,
        ownerPermitSignaturePath,
        path.join(root, "owner-permit-wrong-target-must-not-exist.json"),
      ),
    ],
    {
      env: {
        ...env,
        DATABASE_URL: `file:${wrongTargetPath}`,
        TURSO_DATABASE_URL: `file:${wrongTargetPath}`,
      },
    },
  );
  assert.equal(deniedWrongTarget.code, 1);
  assert.match(
    deniedWrongTarget.stderr,
    /current release\/database\/schema\/spec/,
  );

  const deniedWrongAuthorityEnvironment = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, OWNER_CLI,
      ...assemblyArgs(
        ownerPermitRequestPath,
        ownerPermitSignaturePath,
        path.join(root, "owner-permit-wrong-env-must-not-exist.json"),
      ),
    ],
    { env: { ...env, WALMART_NEW_SKU_TEST_MODE: "0" } },
  );
  assert.equal(deniedWrongAuthorityEnvironment.code, 1);
  assert.match(
    deniedWrongAuthorityEnvironment.stderr,
    /DOCTOR_RECEIPT_INVALID_OR_STALE|OWNER_PERMIT_TRUST_ROOT_NOT_READY/,
  );

  const occupiedPermitPath = path.join(root, "owner-permit-occupied.json");
  await writeFile(occupiedPermitPath, "occupied by a different artifact\n");
  const deniedOverwrite = await runProcess(
    process.execPath,
    [
      "--import", "tsx", "--import", FAKE_FETCH, OWNER_CLI,
      ...assemblyArgs(
        ownerPermitRequestPath,
        ownerPermitSignaturePath,
        occupiedPermitPath,
      ),
    ],
    { env },
  );
  assert.equal(deniedOverwrite.code, 1);
  assert.match(deniedOverwrite.stderr, /Refusing to overwrite a different artifact/);
  assert.equal(
    await readFile(occupiedPermitPath, "utf8"),
    "occupied by a different artifact\n",
  );

  const assembledPermit = await runCli(
    assemblyArgs(
      ownerPermitRequestPath,
      ownerPermitSignaturePath,
      ownerPermitPath,
    ),
    env,
    OWNER_CLI,
  );
  assert.equal(assembledPermit.private_key_accessed, false);
  assert.equal(assembledPermit.signature_verified, true);
  assert.equal(assembledPermit.database_mutated, false);
  assert.equal(assembledPermit.marketplace_mutated, false);
  const ownerPermit = JSON.parse(
    await readFile(ownerPermitPath, "utf8"),
  ) as WalmartOwnerPermit;
  assert.equal(assembledPermit.permit_sha256, ownerPermit.permit_sha256);

  const forgedOwnerPermit = structuredClone(ownerPermit);
  forgedOwnerPermit.signed_body.sku = "FORGED-BY-OPERATOR";
  const forgedUnsigned = Object.fromEntries(
    Object.entries(forgedOwnerPermit).filter(([key]) => key !== "permit_sha256"),
  );
  forgedOwnerPermit.permit_sha256 = sha256(stableJson(forgedUnsigned));
  await writeFile(
    forgedOwnerPermitPath,
    `${JSON.stringify(forgedOwnerPermit, null, 2)}\n`,
  );
  const deniedForgedOwnerPermit = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--doctor-receipt", doctorPath,
      "--apply-preview-receipt", applyPreviewPath,
      "--owner-permit", forgedOwnerPermitPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", forgedOwnerPermit.permit_sha256,
    ],
    { env },
  );
  assert.equal(deniedForgedOwnerPermit.code, 1);
  assert.match(
    deniedForgedOwnerPermit.stderr,
    /OWNER_PERMIT_SIGNATURE_OR_BINDING_INVALID/,
  );

  const deniedWrongPermitConfirmation = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--doctor-receipt", doctorPath,
      "--apply-preview-receipt", applyPreviewPath,
      "--owner-permit", ownerPermitPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", "wrong-permit-sha",
    ],
    { env },
  );
  assert.equal(deniedWrongPermitConfirmation.code, 1);
  assert.match(
    deniedWrongPermitConfirmation.stderr,
    /live apply requires --confirm equal to owner_permit_sha256/,
  );

  const driftDb = createClient({ url: `file:${databasePath}` });
  await driftDb.execute(`CREATE TABLE DoctorReceiptSchemaDrift(id TEXT PRIMARY KEY)`);
  await driftDb.close();
  const deniedDriftedDoctor = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      "apply",
      "--certification", certificationPath,
      "--certification-receipt", certificationReceiptPath,
      "--dry-run-receipt", dryRunPath,
      "--approval", approvalPath,
      "--doctor-receipt", doctorPath,
      "--apply-preview-receipt", applyPreviewPath,
      "--owner-permit", ownerPermitPath,
      "--mode", "live",
      "--actor", "fixture-owner",
      "--confirm", ownerPermit.permit_sha256,
    ],
    { env },
  );
  assert.equal(deniedDriftedDoctor.code, 1);
  assert.match(deniedDriftedDoctor.stderr, /database target or schema has drifted/);
  const restoreDb = createClient({ url: `file:${databasePath}` });
  await restoreDb.execute(`DROP TABLE DoctorReceiptSchemaDrift`);
  await restoreDb.close();

  const verified = await runCli([
    "verify",
    "--certification", certificationPath,
    "--out", verifyPath,
  ], env);
  assert.equal(verified.marketplace_mutated, false);
  assert.equal(verified.listing_status, "PENDING");
  assert.equal(verified.poll_result, null);

  const liveApplyArgs = [
    "apply",
    "--certification", certificationPath,
    "--certification-receipt", certificationReceiptPath,
    "--dry-run-receipt", dryRunPath,
    "--approval", approvalPath,
    "--doctor-receipt", doctorPath,
    "--apply-preview-receipt", applyPreviewPath,
    "--owner-permit", ownerPermitPath,
    "--mode", "live",
    "--actor", "fixture-owner",
    "--confirm", ownerPermit.permit_sha256,
  ];
  const traceBeforeCatalogDrift = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url: string });
  const postsBeforeCatalogDrift = traceBeforeCatalogDrift.filter(
    (entry) =>
      entry.method === "POST" && new URL(entry.url).pathname === "/v3/feeds",
  ).length;
  const catalogDriftDb = createClient({ url: `file:${databasePath}` });
  await catalogDriftDb.execute(
    `UPDATE WalmartCatalogItem
     SET title='tampered-after-certification'
     WHERE id='fixture-existing-catalog-row'`,
  );
  await catalogDriftDb.close();
  const deniedCatalogDrift = await runProcess(
    process.execPath,
    [
      "--import", "tsx",
      "--import", FAKE_FETCH,
      CLI,
      ...liveApplyArgs,
    ],
    { env: { ...env, WALMART_NEW_SKU_TEST_ALLOW_FEED_POST: "1" } },
  );
  assert.equal(deniedCatalogDrift.code, 1);
  assert.match(
    deniedCatalogDrift.stderr,
    /CATALOG_MIRROR_RECONCILIATION_MISMATCH|CATALOG_AUTHORITY_BINDING_DRIFT/,
  );
  const driftInspectionDb = createClient({ url: `file:${databasePath}` });
  const attemptRowsAfterCatalogDrift = await driftInspectionDb.execute(
    `SELECT COUNT(*) AS value FROM MarketplaceSubmissionAttempt`,
  );
  await driftInspectionDb.execute(
    `UPDATE WalmartCatalogItem
     SET title='Different Brand Tomato Soup 15 oz'
     WHERE id='fixture-existing-catalog-row'`,
  );
  await driftInspectionDb.close();
  assert.equal(Number(attemptRowsAfterCatalogDrift.rows[0].value), 0);
  const traceAfterCatalogDrift = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url: string });
  assert.equal(
    traceAfterCatalogDrift.filter(
      (entry) =>
        entry.method === "POST" && new URL(entry.url).pathname === "/v3/feeds",
    ).length,
    postsBeforeCatalogDrift,
  );
  const liveApplied = await runCli([
    ...liveApplyArgs,
    "--out", applyLivePath,
  ], { ...env, WALMART_NEW_SKU_TEST_ALLOW_FEED_POST: "1" });
  assert.equal(liveApplied.marketplace_mutation_requested, true);
  assert.equal((liveApplied.distribution as Record<string, unknown>).ok, true);
  assert.equal(
    (liveApplied.latest_submission_attempt as Record<string, unknown>).state,
    "ACCEPTED",
  );
  assert.equal(
    (liveApplied.latest_submission_attempt as Record<string, unknown>)
      .marketplace_submission_id,
    "fixture-feed-id-1",
  );

  const liveRetried = await runCli([
    ...liveApplyArgs,
    "--out", applyLiveRetryPath,
  ], { ...env, WALMART_NEW_SKU_TEST_ALLOW_FEED_POST: "1" });
  assert.equal(liveRetried.marketplace_mutation_requested, true);
  assert.equal((liveRetried.distribution as Record<string, unknown>).ok, true);
  assert.equal(
    (liveRetried.latest_submission_attempt as Record<string, unknown>).state,
    "ACCEPTED",
  );

  const inspectDb = createClient({ url: `file:${databasePath}` });
  const [skuRows, poolRows, attemptCount, buyerEvidenceCount] = await Promise.all([
    inspectDb.execute(
      `SELECT validation_status, listing_status, lifecycle_status, submission_id
       FROM ChannelSKU`,
    ),
    inspectDb.execute(
      `SELECT status, assigned_to_id, reserved_for_id FROM UPCPool
       WHERE id='fixture-upc-pool-1'`,
    ),
    inspectDb.execute(`SELECT COUNT(*) AS value FROM MarketplaceSubmissionAttempt`),
    inspectDb.execute(`SELECT COUNT(*) AS value FROM WalmartBuyerPublicationEvidence`),
  ]);
  await inspectDb.close();
  assert.equal(skuRows.rows.length, 1);
  assert.equal(String(skuRows.rows[0].validation_status), "PASSED");
  assert.equal(String(skuRows.rows[0].listing_status), "SUBMITTED");
  assert.equal(skuRows.rows[0].submission_id, "fixture-feed-id-1");
  assert.equal(String(poolRows.rows[0].status), "ASSIGNED");
  assert.ok(poolRows.rows[0].assigned_to_id);
  assert.equal(poolRows.rows[0].reserved_for_id, null);
  assert.equal(Number(attemptCount.rows[0].value), 1);
  assert.equal(Number(buyerEvidenceCount.rows[0].value), 0);

  const liveBuyerItemId = "123456789";
  const liveSubmissionAttemptId = String(
    (liveApplied.latest_submission_attempt as Record<string, unknown>).id,
  );
  const staleBuyerEvidenceId = "fixture-stale-buyer-evidence";
  const staleClock = Date.now();
  const staleBuyerCapturedAt = new Date(
    staleClock - 35 * 60_000,
  ).toISOString();
  const staleBuyerRawEvidence = JSON.stringify({
    fixture: "recorded-stale-buyer-evidence",
    submission_attempt_id: liveSubmissionAttemptId,
    captured_at: staleBuyerCapturedAt,
  });
  const staleBuyerEvidenceDb = createClient({ url: `file:${databasePath}` });
  try {
    await staleBuyerEvidenceDb.execute({
      sql: `UPDATE MarketplaceSubmissionAttempt
            SET claimed_at=?, requested_at=?, accepted_at=?
            WHERE id=?`,
      args: [
        new Date(staleClock - 50 * 60_000).toISOString(),
        new Date(staleClock - 45 * 60_000).toISOString(),
        new Date(staleClock - 40 * 60_000).toISOString(),
        liveSubmissionAttemptId,
      ],
    });
    await staleBuyerEvidenceDb.execute({
      sql: `INSERT INTO WalmartBuyerPublicationEvidence (
              id, channel_sku_id, submission_attempt_id, sku, walmart_item_id,
              source_url, source_kind, captured_at, exact_sku_match,
              exact_item_id_match, published, buyable, evidence_hash, raw_evidence
            ) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL_BROWSER_VERIFICATION', ?,
                      1, 1, 1, 1, ?, ?)`,
      args: [
        staleBuyerEvidenceId,
        certificationArtifact.channel_sku_id,
        liveSubmissionAttemptId,
        certificationArtifact.sku,
        liveBuyerItemId,
        `https://www.walmart.com/ip/${liveBuyerItemId}`,
        staleBuyerCapturedAt,
        createHash("sha256").update(staleBuyerRawEvidence).digest("hex"),
        staleBuyerRawEvidence,
      ],
    });
  } finally {
    await staleBuyerEvidenceDb.close();
  }
  const pollReadyEnv = {
    ...env,
    WALMART_NEW_SKU_TEST_POLL_READY: "1",
    WALMART_NEW_SKU_TEST_POLL_SKU: certificationArtifact.sku,
    WALMART_NEW_SKU_TEST_POLL_ITEM_ID: liveBuyerItemId,
  };
  const initialLiveVerify = await runCli([
    "verify",
    "--certification", certificationPath,
    "--out", liveInitialVerifyPath,
  ], pollReadyEnv);
  assert.equal(initialLiveVerify.listing_status, "PENDING_REVIEW");
  const initialLiveBuyerStatus =
    initialLiveVerify.buyer_evidence_status as Record<string, unknown>;
  assert.equal(initialLiveBuyerStatus.buyer_verified, false);
  assert.equal(initialLiveBuyerStatus.evidence_id, staleBuyerEvidenceId);
  assert.equal(initialLiveBuyerStatus.captured_at, staleBuyerCapturedAt);
  assert.equal(initialLiveBuyerStatus.walmart_item_id, liveBuyerItemId);
  const firstLiveBuyerTemplatePath = String(
    initialLiveVerify.buyer_evidence_template,
  );
  assert.ok(firstLiveBuyerTemplatePath.endsWith(".json"));
  const initialLiveReceipt = JSON.parse(
    await readFile(liveInitialVerifyPath, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    initialLiveReceipt.schema_version,
    "walmart-new-sku-verify-receipt/1.1.0",
  );
  assert.equal(
    initialLiveReceipt.payload_sha256,
    certificationArtifact.payload_sha256,
  );
  const initialAttemptBinding =
    initialLiveReceipt.submission_attempt_binding as Record<string, unknown>;
  assert.equal(
    initialAttemptBinding.certification_sha256,
    certificationArtifact.certification_sha256,
  );
  assert.equal(
    initialAttemptBinding.payload_sha256,
    certificationArtifact.payload_sha256,
  );
  assert.equal(
    initialAttemptBinding.seller_account_fingerprint_sha256,
    certificationArtifact.seller_account_fingerprint_sha256,
  );

  const repeatedLiveVerify = await runCli([
    "verify",
    "--certification", certificationPath,
    "--out", liveRepeatedVerifyPath,
  ], pollReadyEnv);
  assert.equal(repeatedLiveVerify.listing_status, "PENDING_REVIEW");
  const repeatedLiveBuyerTemplatePath = String(
    repeatedLiveVerify.buyer_evidence_template,
  );
  assert.notEqual(
    repeatedLiveBuyerTemplatePath,
    firstLiveBuyerTemplatePath,
  );
  assert.ok(
    firstLiveBuyerTemplatePath.includes(
      String(initialLiveReceipt.receipt_sha256).slice(0, 12),
    ),
  );
  const repeatedLiveReceipt = JSON.parse(
    await readFile(liveRepeatedVerifyPath, "utf8"),
  ) as Record<string, unknown>;
  assert.ok(
    repeatedLiveBuyerTemplatePath.includes(
      String(repeatedLiveReceipt.receipt_sha256).slice(0, 12),
    ),
  );

  const liveBuyerTemplate = JSON.parse(
    await readFile(firstLiveBuyerTemplatePath, "utf8"),
  ) as Record<string, unknown>;
  const liveBuyerTemplateBinding =
    liveBuyerTemplate.engineBinding as Record<string, unknown>;
  assert.equal(
    liveBuyerTemplateBinding.verify_receipt_sha256,
    initialLiveReceipt.receipt_sha256,
  );
  assert.equal(
    liveBuyerTemplateBinding.submission_attempt_id,
    liveSubmissionAttemptId,
  );
  const liveCapturedAt = new Date().toISOString();
  liveBuyerTemplate.capturedAt = liveCapturedAt;
  liveBuyerTemplate.exactSkuMatch = true;
  liveBuyerTemplate.exactItemIdMatch = true;
  liveBuyerTemplate.published = true;
  liveBuyerTemplate.buyable = true;
  const liveRawEvidence = liveBuyerTemplate.rawEvidence as Record<string, unknown>;
  const liveRawBinding = liveRawEvidence.binding as Record<string, unknown>;
  const liveRawArtifact = liveRawEvidence.artifact as Record<string, unknown>;
  const liveRawObservation =
    liveRawEvidence.observation as Record<string, unknown>;
  liveRawBinding.captured_at = liveCapturedAt;
  liveRawArtifact.ref = liveBuyerScreenshotPath;
  liveRawObservation.page_rendered = true;
  liveRawObservation.availability = "IN_STOCK";
  liveRawObservation.add_to_cart_enabled = true;
  liveRawEvidence.observer = "fixture-live-buyer-operator";
  await Promise.all([
    writeFile(
      firstLiveBuyerTemplatePath,
      `${JSON.stringify(liveBuyerTemplate, null, 2)}\n`,
    ),
    writeFile(
      liveBuyerScreenshotPath,
      "fixture exact live buyer PDP screenshot bytes\n",
    ),
  ]);
  await t.test(
    "verify seal-evidence fences a deterministic output-parent retarget before write",
    async () => {
      const outputParentA = await mkdtemp(
        path.join(root, "buyer-seal-output-parent-a-"),
      );
      const outputParentB = await mkdtemp(
        path.join(root, "buyer-seal-output-parent-b-"),
      );
      const outputParentAlias = path.join(root, "buyer-seal-output-parent-alias");
      const retargetHookPath = path.join(root, "retarget-output-parent-hook.mjs");
      const retargetedOutputPath = path.join(
        outputParentAlias,
        "must-not-be-written.json",
      );
      await Promise.all([
        symlink(outputParentA, outputParentAlias, "dir"),
        writeFile(
          retargetHookPath,
          `import fs from "node:fs";\n` +
            `import path from "node:path";\n` +
            `import { syncBuiltinESMExports } from "node:module";\n` +
            `const watched = path.resolve(process.env.WALMART_TEST_RETARGET_PARENT);\n` +
            `const replacement = path.resolve(process.env.WALMART_TEST_RETARGET_TO);\n` +
            `const originalRealpath = fs.promises.realpath.bind(fs.promises);\n` +
            `const originalUnlink = fs.promises.unlink.bind(fs.promises);\n` +
            `const originalSymlink = fs.promises.symlink.bind(fs.promises);\n` +
            `let watchedCalls = 0;\n` +
            `fs.promises.realpath = async (requested, options) => {\n` +
            `  if (path.resolve(String(requested)) === watched) {\n` +
            `    watchedCalls += 1;\n` +
            `    if (watchedCalls === 2) {\n` +
            `      await originalUnlink(watched);\n` +
            `      await originalSymlink(replacement, watched, "dir");\n` +
            `    }\n` +
            `  }\n` +
            `  return originalRealpath(requested, options);\n` +
            `};\n` +
            `syncBuiltinESMExports();\n`,
          "utf8",
        ),
      ]);

      const retargetedSeal = await runProcess(process.execPath, [
        "--import", "tsx",
        "--import", FAKE_FETCH,
        "--import", retargetHookPath,
        CLI,
        "verify",
        "--certification", certificationPath,
        "--verify-receipt", liveInitialVerifyPath,
        "--buyer-evidence", firstLiveBuyerTemplatePath,
        "--mode", "seal-evidence",
        "--out", retargetedOutputPath,
      ], {
        env: {
          ...pollReadyEnv,
          WALMART_TEST_RETARGET_PARENT: outputParentAlias,
          WALMART_TEST_RETARGET_TO: outputParentB,
        },
      });
      assert.equal(retargetedSeal.code, 1);
      assert.match(
        retargetedSeal.stderr,
        /Artifact output parent changed before write/,
      );
      assert.equal(
        await realpath(outputParentAlias),
        await realpath(outputParentB),
      );
      assert.deepEqual(await readdir(outputParentA), []);
      assert.deepEqual(await readdir(outputParentB), []);
    },
  );
  const liveBuyerSeal = await runCli([
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", liveInitialVerifyPath,
    "--buyer-evidence", firstLiveBuyerTemplatePath,
    "--mode", "seal-evidence",
    "--out", liveBuyerEvidenceSealedPath,
  ], pollReadyEnv);
  assert.equal(liveBuyerSeal.mode, "seal-evidence");
  assert.equal(liveBuyerSeal.database_mutated, false);
  assert.equal(liveBuyerSeal.marketplace_mutated, false);

  const finalLiveVerify = await runCli([
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", liveInitialVerifyPath,
    "--buyer-evidence", liveBuyerEvidenceSealedPath,
    "--mode", "status",
    "--out", liveFinalVerifyPath,
  ], pollReadyEnv);
  assert.equal(finalLiveVerify.ok, true);
  assert.equal(finalLiveVerify.listing_status, "LIVE");
  assert.equal(finalLiveVerify.lifecycle_status, "LIVE");
  assert.equal(finalLiveVerify.buyer_evidence_template, null);
  assert.equal(finalLiveVerify.next_argv, null);
  const finalBuyerStatus =
    finalLiveVerify.buyer_evidence_status as Record<string, unknown>;
  assert.equal(finalBuyerStatus.buyer_verified, true);
  assert.equal(finalBuyerStatus.attempt_id, initialAttemptBinding.attempt_id);
  assert.ok(finalBuyerStatus.evidence_id);

  const replayedFinalLiveVerify = await runCli([
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", liveInitialVerifyPath,
    "--buyer-evidence", liveBuyerEvidenceSealedPath,
    "--mode", "status",
    "--out", liveFinalReplayPath,
  ], pollReadyEnv);
  assert.equal(replayedFinalLiveVerify.ok, true);
  assert.equal(replayedFinalLiveVerify.listing_status, "LIVE");
  assert.equal(replayedFinalLiveVerify.buyer_evidence_template, null);
  assert.equal(replayedFinalLiveVerify.next_argv, null);

  const liveInspectionDb = createClient({ url: `file:${databasePath}` });
  const [liveSkuRows, liveAttemptRows, liveEvidenceRows] = await Promise.all([
    liveInspectionDb.execute(
      `SELECT listing_status, lifecycle_status, walmart_item_id
       FROM ChannelSKU WHERE id=?`,
      [certificationArtifact.channel_sku_id],
    ),
    liveInspectionDb.execute(
      `SELECT state, active_key, certification_sha256, payload_hash,
              seller_account_fingerprint_sha256
       FROM MarketplaceSubmissionAttempt WHERE id=?`,
      [String(initialAttemptBinding.attempt_id)],
    ),
    liveInspectionDb.execute(
      `SELECT COUNT(*) AS value FROM WalmartBuyerPublicationEvidence
       WHERE submission_attempt_id=?`,
      [String(initialAttemptBinding.attempt_id)],
    ),
  ]);
  await liveInspectionDb.close();
  assert.equal(liveSkuRows.rows[0].listing_status, "LIVE");
  assert.equal(liveSkuRows.rows[0].lifecycle_status, "LIVE");
  assert.equal(liveSkuRows.rows[0].walmart_item_id, liveBuyerItemId);
  assert.equal(liveAttemptRows.rows[0].state, "BUYER_VERIFIED");
  assert.equal(liveAttemptRows.rows[0].active_key, null);
  assert.equal(
    liveAttemptRows.rows[0].certification_sha256,
    certificationArtifact.certification_sha256,
  );
  assert.equal(
    liveAttemptRows.rows[0].payload_hash,
    certificationArtifact.payload_sha256,
  );
  assert.equal(
    liveAttemptRows.rows[0].seller_account_fingerprint_sha256,
    certificationArtifact.seller_account_fingerprint_sha256,
  );
  assert.equal(Number(liveEvidenceRows.rows[0].value), 2);

  const trace = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url: string });
  assert.equal(
    trace.filter(
      (entry) => new URL(entry.url).pathname === "/v3/items/walmart/search",
    ).length,
    3,
  );
  assert.equal(
    trace.filter(
      (entry) => new URL(entry.url).pathname === "/v3/items/spec",
    ).length,
    3,
  );
  assert.ok(trace.some((entry) => entry.url.includes("veeqo.fixture.test/products")));
  assert.ok(trace.some((entry) => entry.url.includes("images.fixture.test/listing-main.png")));
  assert.equal(
    trace.filter(
      (entry) => entry.method === "POST" && new URL(entry.url).pathname === "/v3/feeds",
    ).length,
    1,
  );
  t.diagnostic(
    "frozen fake Walmart flow: exactly one feed POST; generated buyer worksheet sealed to BUYER_VERIFIED/LIVE; replays made no second POST",
  );
  const feedPayloadEvents = trace.filter(
    (entry) => (entry as { kind?: string }).kind === "feed-payload",
  ) as unknown as Array<{ canonical_payload_sha256: string }>;
  assert.equal(feedPayloadEvents.length, 1);
  assert.equal(
    feedPayloadEvents[0].canonical_payload_sha256,
    certificationArtifact.payload_sha256,
  );
  assert.ok(
    trace.every((entry) => [
      "walmart.fixture.test",
      "veeqo.fixture.test",
      "images.fixture.test",
    ].includes(new URL(entry.url).hostname)),
  );

  const foreignAttemptId = "fixture-newer-foreign-payload-attempt";
  const foreignPayloadSha256 = "7".repeat(64);
  const foreignCertificationSha256 = "8".repeat(64);
  const foreignCreatedAt = new Date(Date.now() + 1_000).toISOString();
  const mismatchDb = createClient({ url: `file:${databasePath}` });
  await mismatchDb.execute({
    sql: `INSERT INTO MarketplaceSubmissionAttempt (
      id, channel_sku_id, marketplace, idempotency_key, active_key,
      pilot_permit_sha256, pilot_permit_id, owner_key_id,
      owner_signature_sha256, pilot_slot, pilot_approval_sha256,
      certification_sha256, seller_account_fingerprint_sha256,
      payload_hash, claim_token, state, request_count,
      marketplace_submission_id, marketplace_disposition,
      claimed_at, requested_at, accepted_at, created_at, updated_at
    ) VALUES (
      ?, ?, 'WALMART', ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?,
      'ACCEPTED', 1, ?, 'FEED_ACCEPTED', ?, ?, ?, ?, ?
    )`,
    args: [
      foreignAttemptId,
      certificationArtifact.channel_sku_id,
      `walmart:v1:${createHash("sha256")
        .update(
          `${certificationArtifact.channel_sku_id}\n${foreignPayloadSha256}`,
        )
        .digest("hex")}`,
      certificationArtifact.channel_sku_id,
      createHash("sha256").update("foreign-permit").digest("hex"),
      "owner-permit://integration/foreign-payload",
      "owner-fixture-foreign-key",
      createHash("sha256").update("foreign-signature").digest("hex"),
      createHash("sha256").update("foreign-approval").digest("hex"),
      foreignCertificationSha256,
      certificationArtifact.seller_account_fingerprint_sha256,
      foreignPayloadSha256,
      "fixture-foreign-claim-token",
      "fixture-foreign-feed-id",
      foreignCreatedAt,
      foreignCreatedAt,
      foreignCreatedAt,
      foreignCreatedAt,
      foreignCreatedAt,
    ],
  });
  const beforeMismatchRows = await Promise.all([
    mismatchDb.execute(
      `SELECT COUNT(*) AS value FROM WalmartBuyerPublicationEvidence`,
    ),
    mismatchDb.execute(`SELECT COUNT(*) AS value FROM ListingLifecycleLog`),
  ]);
  await mismatchDb.close();
  const traceLinesBeforeMismatch = (await readFile(tracePath, "utf8"))
    .trim().split("\n").filter(Boolean).length;

  const oldCertificationInitialVerify = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--out", path.join(artifactRoot, "old-cert-initial-verify-must-fail.json"),
  ], { env });
  assert.equal(oldCertificationInitialVerify.code, 1);
  assert.match(
    oldCertificationInitialVerify.stderr,
    /not exactly bound to the supplied certification/,
  );

  const oldCertificationBuyerVerify = await runProcess(process.execPath, [
    "--import", "tsx", "--import", FAKE_FETCH, CLI,
    "verify",
    "--certification", certificationPath,
    "--verify-receipt", buyerSealVerifyReceiptPath,
    "--buyer-evidence", buyerEvidenceSealedPath,
    "--mode", "status",
    "--out", path.join(artifactRoot, "old-cert-buyer-verify-must-fail.json"),
  ], { env });
  assert.equal(oldCertificationBuyerVerify.code, 1);
  assert.match(
    oldCertificationBuyerVerify.stderr,
    /not exactly bound to the supplied certification/,
  );

  assert.equal(
    (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean)
      .length,
    traceLinesBeforeMismatch,
  );
  const mismatchInspectionDb = createClient({ url: `file:${databasePath}` });
  const afterMismatchRows = await Promise.all([
    mismatchInspectionDb.execute(
      `SELECT COUNT(*) AS value FROM WalmartBuyerPublicationEvidence`,
    ),
    mismatchInspectionDb.execute(`SELECT COUNT(*) AS value FROM ListingLifecycleLog`),
  ]);
  await mismatchInspectionDb.close();
  assert.equal(
    Number(afterMismatchRows[0].rows[0].value),
    Number(beforeMismatchRows[0].rows[0].value),
  );
  assert.equal(
    Number(afterMismatchRows[1].rows[0].value),
    Number(beforeMismatchRows[1].rows[0].value),
  );
  assert.equal(String(stage.marketplace_mutation_allowed), "false");
});
