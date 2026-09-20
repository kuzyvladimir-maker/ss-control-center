#!/usr/bin/env -S node --env-file=.env --import tsx

/**
 * Build one immutable, read-only Walmart Listing Integrity controlled pool.
 *
 * Inputs are exact-byte pinned catalog artifacts plus final Qualification-bound
 * before/after galleries. The only external read is WalmartSkuPerf. This command
 * cannot call Walmart, a model, a paid provider, or mutate any database/listing.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import { createClient } from "@libsql/client";

import {
  buildWalmartListingIntegrityControlledPool,
  listWalmartListingIntegrityControlledPoolCandidateScopes,
  parseWalmartListingIntegrityCompletedCase,
  parseWalmartListingIntegrityQuarantinedCase,
  verifyWalmartListingIntegrityControlledPool,
} from "../src/lib/walmart/listing-integrity-operations.ts";
import {
  readProductTruthSnapshots,
} from "../src/lib/sourcing/product-truth-read-contract.ts";
import {
  verifyWalmartListingIntegrityCatalogArtifacts,
  verifyWalmartListingIntegrityCatalogFreshness,
  walmartListingIntegrityCatalogSha256,
} from "../src/lib/walmart/listing-integrity-catalog-orchestrator.ts";

const HELP = `Usage:
  node --env-file=.env --import tsx \
    scripts/build-walmart-listing-integrity-controlled-pool.ts \
    --census=/absolute/catalog-census.json \
    --expect-census-sha256=<sha256> \
    --plan=/absolute/scan-plan.json \
    --expect-plan-sha256=<sha256> \
    --manifest-sha256=<authoritative-manifest-sha256> \
    --completed-root=/absolute/walmart-listing-integrity-post-canary \
    --quarantine-root=/absolute/walmart-listing-integrity-quarantine \
    --reserved-listing-keys=walmart:1:SKU-RESERVED \
    --readmission-artifact=/absolute/readmission.json \
    --expect-readmission-sha256=<sha256> \
    --limit=10 \
    --output-dir=/absolute/new/directory

Effects: one read-only WalmartSkuPerf query and immutable local artifact writes.
Walmart/model/paid-provider/database writes are impossible in this command.
`;

function fail(message) {
  throw new Error(message);
}

function exactSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)
    || path.resolve(value) !== value) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
    return { help: true };
  }
  const flags = new Map();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1])) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1], match[2]);
  }
  const required = [
    "census",
    "expect-census-sha256",
    "plan",
    "expect-plan-sha256",
    "manifest-sha256",
    "completed-root",
    "quarantine-root",
    "limit",
    "output-dir",
  ];
  const allowed = new Set([
    ...required,
    "reserved-listing-keys",
    "readmission-artifact",
    "expect-readmission-sha256",
  ]);
  if (required.some((key) => !flags.has(key))
    || flags.has("readmission-artifact") !== flags.has("expect-readmission-sha256")
    || [...flags.keys()].some((key) => !allowed.has(key))) {
    fail(`required arguments: ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  const rawLimit = flags.get("limit");
  if (!/^[1-9]\d*$/u.test(rawLimit)) fail("--limit must be a positive integer");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 50) fail("--limit must be between 1 and 50");
  const reservedListingKeys = (flags.get("reserved-listing-keys") ?? "")
    .split(",")
    .filter(Boolean);
  if (new Set(reservedListingKeys).size !== reservedListingKeys.length
    || reservedListingKeys.some((key) => !/^walmart:\d+:[^,\s]+$/u.test(key))) {
    fail("--reserved-listing-keys must be unique exact Walmart listing keys");
  }
  return {
    help: false,
    census: absolutePath(flags.get("census"), "--census"),
    expect_census_sha256: exactSha(
      flags.get("expect-census-sha256"),
      "--expect-census-sha256",
    ),
    plan: absolutePath(flags.get("plan"), "--plan"),
    expect_plan_sha256: exactSha(flags.get("expect-plan-sha256"), "--expect-plan-sha256"),
    manifest_sha256: exactSha(flags.get("manifest-sha256"), "--manifest-sha256"),
    completed_root: absolutePath(flags.get("completed-root"), "--completed-root"),
    quarantine_root: absolutePath(flags.get("quarantine-root"), "--quarantine-root"),
    readmission_artifact: flags.has("readmission-artifact")
      ? absolutePath(flags.get("readmission-artifact"), "--readmission-artifact")
      : null,
    expect_readmission_sha256: flags.has("expect-readmission-sha256")
      ? exactSha(flags.get("expect-readmission-sha256"), "--expect-readmission-sha256")
      : null,
    reserved_listing_keys: reservedListingKeys.sort((left, right) => (
      left.localeCompare(right, "en")
    )),
    limit,
    output_dir: absolutePath(flags.get("output-dir"), "--output-dir"),
  };
}

function cleanEnv(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readPinnedJson(file, expectedSha, label) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  const bytes = await readFile(file);
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) fail(`${label} file SHA mismatch`);
  return { bytes, value: JSON.parse(bytes.toString("utf8")), fileSha256: actualSha };
}

function isQualificationBoundVerification(value) {
  const boundary = value?.qualification_boundary;
  const common = value?.status === "LIVE_SURFACE_PASS"
    && boundary?.buyer_facing_live_surface_verified === true
    && boundary?.next_sku_unblocked === true;
  return common && (
    (value?.schema_version === "walmart-listing-integrity-live-canary-verification/v1"
      && boundary?.frozen_sequence_gate_receipt_emitted === true)
    || (value?.schema_version === "walmart-listing-integrity-no-change-verification/v1"
      && value?.completion_mode === "AUDITED_NO_CHANGE"
      && value?.feed_id === null
      && value?.exact_payload_sha256 === null
      && boundary?.source_aware_qualification_receipt_emitted === true
      && boundary?.no_walmart_write_required === true)
  );
}

async function completedCases(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("--completed-root must be a real directory");
  }
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const parsed = [];
  for (const directory of directories) {
    const verificationPath = path.join(root, directory, "live-canary-verification.json");
    const galleryPath = path.join(root, directory, "before-after-gallery.html");
    let verificationBytes;
    let galleryBytes;
    try {
      [verificationBytes, galleryBytes] = await Promise.all([
        readFile(verificationPath),
        readFile(galleryPath),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const verification = JSON.parse(verificationBytes.toString("utf8"));
    if (!isQualificationBoundVerification(verification)) continue;
    parsed.push(parseWalmartListingIntegrityCompletedCase({
      verification,
      verificationFileSha256: sha256(verificationBytes),
      galleryFileSha256: sha256(galleryBytes),
      verificationPath,
      galleryPath,
    }));
  }
  const newestByListing = new Map();
  for (const candidate of parsed.sort((left, right) => (
    Date.parse(right.qualifiedAt) - Date.parse(left.qualifiedAt)
    || right.verificationFileSha256.localeCompare(left.verificationFileSha256, "en")
  ))) {
    const existing = newestByListing.get(candidate.listingKey);
    if (existing) {
      if (existing.sku !== candidate.sku || existing.itemId !== candidate.itemId
        || existing.storeIndex !== candidate.storeIndex) {
        fail(`completed-case identity conflict for ${candidate.listingKey}`);
      }
      continue;
    }
    newestByListing.set(candidate.listingKey, candidate);
  }
  return [...newestByListing.values()].sort(
    (left, right) => left.listingKey.localeCompare(right.listingKey, "en"),
  );
}

async function quarantinedCases(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("--quarantine-root must be a real directory");
  }
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const parsed = [];
  for (const directory of directories) {
    const dispositionPath = path.join(root, directory, "failure-disposition.json");
    const shaPath = path.join(root, directory, "failure-disposition.sha256");
    let dispositionBytes;
    let shaBytes;
    try {
      [dispositionBytes, shaBytes] = await Promise.all([
        readFile(dispositionPath),
        readFile(shaPath),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const dispositionFileSha256 = sha256(dispositionBytes);
    if (shaBytes.toString("utf8").trim() !== dispositionFileSha256) {
      fail(`${dispositionPath}: exact-file SHA mismatch`);
    }
    parsed.push(parseWalmartListingIntegrityQuarantinedCase({
      disposition: JSON.parse(dispositionBytes.toString("utf8")),
      dispositionFileSha256,
      dispositionPath,
    }));
  }
  return parsed;
}

async function readPerformance(storeIndex) {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN) || undefined;
  if (!url) fail("TURSO_DATABASE_URL or DATABASE_URL is required");
  const db = createClient({ url, authToken });
  try {
    const result = await db.execute({
      sql: `SELECT sku,storeIndex,units30,sales30,orders30,returns30,
                   units90,sales90,orders90,returns90,computedAt
              FROM WalmartSkuPerf WHERE storeIndex=? ORDER BY sku`,
      args: [storeIndex],
    });
    return result.rows;
  } finally {
    db.close();
  }
}

async function readControlTerminalRows() {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN) || undefined;
  if (!url) fail("TURSO_DATABASE_URL or DATABASE_URL is required");
  const db = createClient({ url, authToken });
  try {
    const result = await db.execute(`
      SELECT runId,listingKey,sku,itemId,state,stateBodySha256,evidenceSha256,transitionedAt
      FROM WalmartListingIntegrityControlItem
      WHERE state IN (
        'AUDITED_PASS','QUALIFIED_PASS',
        'QUARANTINED_SOURCE_REQUIRED','QUARANTINED_UNRESOLVED'
      )
      ORDER BY listingKey ASC,transitionedAt DESC,runId DESC
    `);
    return result.rows;
  } finally {
    db.close();
  }
}

function exactText(value, label, maximum = 768) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function parseReadmission(pinned, terminalRows) {
  if (!pinned) return null;
  const value = pinned.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("readmission must be one object");
  }
  const body = { ...value };
  delete body.body_sha256;
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  const policy = value.policy;
  if (value.schema_version !== "walmart-listing-integrity-control-readmission/v1"
    || value.body_sha256 !== bodySha256
    || new Date(value.created_at).toISOString() !== value.created_at
    || value.required_diagnosis_adapter_version
      !== "walmart-listing-integrity-single-process-adapter/v9"
    || value.reason_code !== "ALGORITHM_FALSE_NEGATIVE_FIXED"
    || !policy || typeof policy !== "object" || Array.isArray(policy)
    || policy.single_use !== true || policy.maximum_items !== 2
    || policy.model_call_reuse_allowed !== false
    || policy.walmart_writes_authorized !== false
    || !Array.isArray(value.items) || value.items.length < 1
    || value.items.length > policy.maximum_items) {
    fail("readmission contract or body seal is invalid");
  }
  const rowsByListing = new Map();
  for (const [index, row] of terminalRows.entries()) {
    const listingKey = exactText(row.listingKey, `terminalRows[${index}].listingKey`);
    const rows = rowsByListing.get(listingKey) ?? [];
    rows.push(row);
    rowsByListing.set(listingKey, rows);
  }
  const seen = new Set();
  const activeItems = [];
  for (const [index, raw] of value.items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`readmission.items[${index}] must be one object`);
    }
    const item = {
      listingKey: exactText(raw.listing_key, `readmission.items[${index}].listing_key`),
      sku: exactText(raw.sku, `readmission.items[${index}].sku`, 500),
      itemId: exactText(raw.item_id, `readmission.items[${index}].item_id`, 100),
      priorRunId: exactText(raw.prior_run_id, `readmission.items[${index}].prior_run_id`, 200),
      priorState: raw.prior_state,
      priorStateBodySha256: exactSha(
        raw.prior_state_body_sha256,
        `readmission.items[${index}].prior_state_body_sha256`,
      ),
      priorEvidenceSha256: exactSha(
        raw.prior_evidence_sha256,
        `readmission.items[${index}].prior_evidence_sha256`,
      ),
    };
    if (seen.has(item.listingKey)
      || item.priorState !== "QUARANTINED_UNRESOLVED"
      || item.listingKey !== `walmart:1:${item.sku}`) {
      fail(`readmission.items[${index}] identity or prior state is invalid`);
    }
    seen.add(item.listingKey);
    const rows = rowsByListing.get(item.listingKey) ?? [];
    const prior = rows.find((row) => (
      row.runId === item.priorRunId
      && row.sku === item.sku
      && row.itemId === item.itemId
      && row.state === item.priorState
      && row.stateBodySha256 === item.priorStateBodySha256
      && row.evidenceSha256 === item.priorEvidenceSha256
    ));
    if (!prior) fail(`readmission prior terminal state is absent for ${item.listingKey}`);
    const latest = rows[0];
    if (latest?.stateBodySha256 === item.priorStateBodySha256) {
      activeItems.push({
        listingKey: item.listingKey,
        priorStateBodySha256: item.priorStateBodySha256,
        reasonCode: "ALGORITHM_FALSE_NEGATIVE_FIXED",
      });
    }
  }
  activeItems.sort((left, right) => left.listingKey.localeCompare(right.listingKey, "en"));
  return {
    artifactFileSha256: pinned.fileSha256,
    artifactBodySha256: bodySha256,
    activeItems,
  };
}

async function readProductTruthReadiness(input) {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN) || undefined;
  if (!url) fail("TURSO_DATABASE_URL or DATABASE_URL is required");
  const db = createClient({ url, authToken });
  const rows = [];
  let logicalReads = 0;
  try {
    for (let offset = 0; offset < input.scopes.length; offset += 100) {
      const scopes = input.scopes.slice(offset, offset + 100);
      const snapshots = await readProductTruthSnapshots(db, {
        scopes: scopes.map((scope) => ({
          channel: "walmart",
          storeIndex: scope.storeIndex,
          sku: scope.sku,
        })),
        expectedManifestSha256: input.manifestSha256,
        asOf: input.asOf,
        maxPriceAgeMs: 30 * 24 * 60 * 60 * 1_000,
      });
      logicalReads += 1;
      snapshots.forEach((snapshot, index) => {
        const scope = scopes[index];
        if (!scope || snapshot.snapshot.listingKey !== scope.listingKey) {
          fail("Product Truth batch order or exact listing identity differs");
        }
        const componentCount = snapshot.recipe.components.length;
        const blockers = [...snapshot.views.listingImprovement.blockers];
        if (componentCount !== 1) {
          blockers.push(
            `SAME_PRODUCT_PIPELINE_REQUIRES_ONE_COMPONENT:FOUND_${componentCount}`,
          );
        }
        rows.push({
          listingKey: scope.listingKey,
          storeIndex: scope.storeIndex,
          sku: scope.sku,
          listingImprovementReady: snapshot.views.listingImprovement.ready,
          componentCount,
          blockers: [...new Set(blockers)].sort(),
        });
      });
    }
    return { rows, logicalReads };
  } finally {
    db.close();
  }
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePool(outputDir, pool) {
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const bytes = jsonBytes(pool);
  const fileSha256 = sha256(bytes);
  await writeExclusive(path.join(outputDir, "controlled-pool.json"), bytes);
  await writeExclusive(
    path.join(outputDir, "controlled-pool.sha256"),
    Buffer.from(`${fileSha256}\n`, "utf8"),
  );
  await chmod(outputDir, 0o500);
  return fileSha256;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const [censusFile, planFile, completed, quarantined, terminalRows, readmissionFile] = await Promise.all([
    readPinnedJson(options.census, options.expect_census_sha256, "census"),
    readPinnedJson(options.plan, options.expect_plan_sha256, "plan"),
    completedCases(options.completed_root),
    quarantinedCases(options.quarantine_root),
    readControlTerminalRows(),
    options.readmission_artifact
      ? readPinnedJson(
        options.readmission_artifact,
        options.expect_readmission_sha256,
        "readmission",
      )
      : null,
  ]);
  const readmission = parseReadmission(readmissionFile, terminalRows);
  const activeReadmissionKeys = new Set(
    readmission?.activeItems.map((item) => item.listingKey) ?? [],
  );
  const processedControlListingKeys = [...new Set(
    terminalRows.map((row, index) => exactText(
      row.listingKey,
      `terminalRows[${index}].listingKey`,
    )),
  )]
    .filter((listingKey) => !activeReadmissionKeys.has(listingKey))
    .sort((left, right) => left.localeCompare(right, "en"));
  verifyWalmartListingIntegrityCatalogArtifacts({
    census: censusFile.value,
    plan: planFile.value,
  });
  const createdAt = new Date();
  const catalogFreshness = verifyWalmartListingIntegrityCatalogFreshness({
    census: censusFile.value,
    as_of: createdAt.toISOString(),
  });
  const scopes = listWalmartListingIntegrityControlledPoolCandidateScopes({
    census: censusFile.value,
    completedListingKeys: completed.map((entry) => entry.listingKey),
    quarantinedListingKeys: quarantined.map((entry) => entry.listingKey),
    processedControlListingKeys,
    reservedListingKeys: options.reserved_listing_keys,
  });
  const [performanceRows, productTruth] = await Promise.all([
    readPerformance(censusFile.value.store_index),
    readProductTruthReadiness({
      scopes,
      manifestSha256: options.manifest_sha256,
      asOf: createdAt,
    }),
  ]);
  const pool = buildWalmartListingIntegrityControlledPool({
    census: censusFile.value,
    scanPlan: planFile.value,
    censusFileSha256: censusFile.fileSha256,
    scanPlanFileSha256: planFile.fileSha256,
    performanceRows,
    productTruthReadiness: productTruth.rows,
    authoritativeManifestSha256: options.manifest_sha256,
    databaseReads: 2 + productTruth.logicalReads,
    completedCases: completed,
    quarantinedCases: quarantined,
    processedControlListingKeys,
    readmission: readmission?.activeItems.length ? {
      schemaVersion: "walmart-listing-integrity-controlled-pool-readmission/v1",
      artifactFileSha256: readmission.artifactFileSha256,
      artifactBodySha256: readmission.artifactBodySha256,
      items: readmission.activeItems,
    } : undefined,
    reservedListingKeys: options.reserved_listing_keys,
    createdAt: createdAt.toISOString(),
    requestedSize: options.limit,
  });
  verifyWalmartListingIntegrityControlledPool(pool);
  const poolFileSha256 = await writePool(options.output_dir, pool);
  process.stdout.write(`${JSON.stringify({
    status: "READ_ONLY_CONTROLLED_POOL_READY",
    pool_id: pool.poolId,
    pool_body_sha256: pool.bodySha256,
    pool_file_sha256: poolFileSha256,
    items: pool.items.map((item) => ({
      ordinal: item.ordinal,
      sku: item.sku,
      item_id: item.itemId,
      deterministic_findings: item.deterministicFindings,
      returns_90: item.performance.returns90,
      units_90: item.performance.units90,
      sales_90: item.performance.sales90,
    })),
    quarantined_items: pool.quarantinedItems.map((item) => ({
      sku: item.sku,
      item_id: item.itemId,
      outcome: item.outcome,
      next_action: item.nextAction,
    })),
    completed_listing_keys: pool.completedListingKeys,
    processed_control_listing_keys: pool.processedControlListingKeys,
    reserved_listing_keys: pool.reservedListingKeys ?? [],
    readmission: pool.readmission ?? null,
    source_readiness: pool.sourceReadiness,
    catalog_freshness: catalogFreshness,
    source_required_preview: pool.sourceRequiredItems.map((item) => ({
      ordinal: item.ordinal,
      sku: item.sku,
      item_id: item.itemId,
      blockers: item.productTruthBlockers,
      next_action: item.nextAction,
    })),
    output_dir: options.output_dir,
    external_effects: pool.externalEffects,
    next_command: null,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
