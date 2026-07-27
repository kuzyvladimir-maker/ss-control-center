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
  verifyWalmartListingIntegrityControlledPool,
} from "../src/lib/walmart/listing-integrity-operations.ts";
import {
  readProductTruthSnapshots,
} from "../src/lib/sourcing/product-truth-read-contract.ts";
import {
  verifyWalmartListingIntegrityCatalogArtifacts,
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
    "limit",
    "output-dir",
  ];
  if (flags.size !== required.length || required.some((key) => !flags.has(key))) {
    fail(`required arguments: ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  const rawLimit = flags.get("limit");
  if (!/^[1-9]\d*$/u.test(rawLimit)) fail("--limit must be a positive integer");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 50) fail("--limit must be between 1 and 50");
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
  return value?.schema_version === "walmart-listing-integrity-live-canary-verification/v1"
    && value?.status === "LIVE_SURFACE_PASS"
    && value?.qualification_boundary?.buyer_facing_live_surface_verified === true
    && value?.qualification_boundary?.frozen_sequence_gate_receipt_emitted === true
    && value?.qualification_boundary?.next_sku_unblocked === true;
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
  const [censusFile, planFile, completed] = await Promise.all([
    readPinnedJson(options.census, options.expect_census_sha256, "census"),
    readPinnedJson(options.plan, options.expect_plan_sha256, "plan"),
    completedCases(options.completed_root),
  ]);
  verifyWalmartListingIntegrityCatalogArtifacts({
    census: censusFile.value,
    plan: planFile.value,
  });
  const scopes = listWalmartListingIntegrityControlledPoolCandidateScopes({
    census: censusFile.value,
    completedListingKeys: completed.map((entry) => entry.listingKey),
  });
  const createdAt = new Date();
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
    databaseReads: 1 + productTruth.logicalReads,
    completedCases: completed,
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
    completed_listing_keys: pool.completedListingKeys,
    source_readiness: pool.sourceReadiness,
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
