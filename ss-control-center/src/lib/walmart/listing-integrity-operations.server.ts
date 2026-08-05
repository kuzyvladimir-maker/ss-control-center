import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  ListingIntegrityCompletedOperation,
  ListingIntegrityOperationsState,
} from "./listing-integrity-shadow-contract";
import {
  WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA,
  WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_SCHEMA,
  WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_V1_SCHEMA,
  WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA,
  WALMART_LISTING_INTEGRITY_NO_CHANGE_VERIFICATION_SCHEMA,
  parseWalmartListingIntegrityCompletedCase,
  verifyWalmartListingIntegrityControlledPool,
  type WalmartListingIntegrityControlledPool,
} from "./listing-integrity-operations";
import {
  walmartListingIntegrityCatalogSha256,
} from "./listing-integrity-catalog-orchestrator";

const DEFAULT_OPERATIONS_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-operations",
);

const DEFAULT_COMPLETED_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-post-canary",
);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function emptyState(): ListingIntegrityOperationsState {
  return {
    status: "NOT_READY",
    poolId: null,
    poolBodySha256: null,
    poolFileSha256: null,
    poolCreatedAt: null,
    poolEvidencePath: null,
    strictSequence: true,
    maxApplyInFlight: 1,
    walmartWritesAllowed: false,
    modelCallsAllowed: false,
    sourceCandidateCount: 0,
    repairReadyCount: 0,
    sourceRequiredCount: 0,
    quarantinedCount: 0,
    completed: [],
    quarantined: [],
    pool: [],
    sourceRequired: [],
  };
}

async function regularFileBytes(pathname: string, maximum: number): Promise<Buffer> {
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) {
    throw new Error(`${pathname}: expected a bounded regular file`);
  }
  return readFile(pathname);
}

function isFinalQualification(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const verification = value as Record<string, unknown>;
  const boundary = verification.qualification_boundary;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return false;
  const fields = boundary as Record<string, unknown>;
  const common = verification.status === "LIVE_SURFACE_PASS"
    && fields.buyer_facing_live_surface_verified === true
    && fields.next_sku_unblocked === true;
  return common && (
    (verification.schema_version === WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA
      && fields.frozen_sequence_gate_receipt_emitted === true)
    || (verification.schema_version
        === WALMART_LISTING_INTEGRITY_NO_CHANGE_VERIFICATION_SCHEMA
      && verification.completion_mode === "AUDITED_NO_CHANGE"
      && verification.feed_id === null
      && verification.exact_payload_sha256 === null
      && fields.source_aware_qualification_receipt_emitted === true
      && fields.no_walmart_write_required === true)
  );
}

async function loadCompletedOperations(
  root: string,
): Promise<ListingIntegrityCompletedOperation[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const cases = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const evidenceRoot = path.join(root, entry.name);
    const verificationPath = path.join(evidenceRoot, "live-canary-verification.json");
    const galleryPath = path.join(evidenceRoot, "before-after-gallery.html");
    let verificationBytes;
    let galleryBytes;
    try {
      [verificationBytes, galleryBytes] = await Promise.all([
        regularFileBytes(verificationPath, 1_000_000),
        regularFileBytes(galleryPath, 5_000_000),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const verification = JSON.parse(verificationBytes.toString("utf8"));
    if (!isFinalQualification(verification)) continue;
    const parsed = parseWalmartListingIntegrityCompletedCase({
      verification,
      verificationFileSha256: digest(verificationBytes),
      galleryFileSha256: digest(galleryBytes),
      verificationPath,
      galleryPath,
    });
    cases.push(parsed);
  }
  const latest = new Map<string, (typeof cases)[number]>();
  for (const candidate of cases.sort((left, right) => (
    Date.parse(right.qualifiedAt) - Date.parse(left.qualifiedAt)
    || right.verificationFileSha256.localeCompare(left.verificationFileSha256, "en")
  ))) {
    const previous = latest.get(candidate.listingKey);
    if (previous
      && (previous.sku !== candidate.sku || previous.itemId !== candidate.itemId)) {
      throw new Error(`completed operation identity conflict: ${candidate.listingKey}`);
    }
    if (!previous) latest.set(candidate.listingKey, candidate);
  }
  return [...latest.values()]
    .sort((left, right) => (
      Date.parse(right.qualifiedAt) - Date.parse(left.qualifiedAt)
      || left.listingKey.localeCompare(right.listingKey, "en")
    ))
    .map((entry) => ({
      completionMode: entry.completionMode,
      listingKey: entry.listingKey,
      sku: entry.sku,
      itemId: entry.itemId,
      feedId: entry.feedId,
      payloadSha256: entry.payloadSha256,
      beforeCapturedAt: entry.beforeCapturedAt,
      afterCapturedAt: entry.afterCapturedAt,
      checksPassed: entry.checksPassed,
      qualification: "PASS" as const,
      publishedAndActive: true as const,
      indexingPreserved: true as const,
      galleryHref: `/api/walmart/growth/listing-integrity/gallery/${encodeURIComponent(entry.sku)}`,
      galleryFileSha256: entry.galleryFileSha256,
      verificationFileSha256: entry.verificationFileSha256,
    }));
}

async function loadLatestPool(
  root: string,
): Promise<{
  pool: WalmartListingIntegrityControlledPool;
  fileSha256: string;
  evidencePath: string;
} | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const evidenceRoot = path.join(root, entry.name);
    const jsonPath = path.join(evidenceRoot, "controlled-pool.json");
    const shaPath = path.join(evidenceRoot, "controlled-pool.sha256");
    let bytes;
    let shaBytes;
    try {
      [bytes, shaBytes] = await Promise.all([
        regularFileBytes(jsonPath, 10_000_000),
        regularFileBytes(shaPath, 100),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const expectedSha = shaBytes.toString("utf8").trim();
    const fileSha256 = digest(bytes);
    if (!/^[a-f0-9]{64}$/u.test(expectedSha) || expectedSha !== fileSha256) {
      throw new Error(`${jsonPath}: controlled pool exact-file SHA mismatch`);
    }
    const decoded = JSON.parse(bytes.toString("utf8")) as {
      schemaVersion?: unknown;
      poolId?: unknown;
      bodySha256?: unknown;
      policy?: Record<string, unknown>;
      sourceReadiness?: Record<string, unknown>;
    };
    if (decoded.schemaVersion
      === WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_V1_SCHEMA) {
      continue;
    }
    if (decoded.schemaVersion !== WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA
      && decoded.schemaVersion !== WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_SCHEMA) {
      throw new Error(`${jsonPath}: unsupported controlled pool schema`);
    }
    let pool: WalmartListingIntegrityControlledPool;
    if (decoded.schemaVersion === WALMART_LISTING_INTEGRITY_LEGACY_CONTROLLED_POOL_SCHEMA) {
      const body = { ...decoded };
      delete body.poolId;
      delete body.bodySha256;
      const rebuilt = walmartListingIntegrityCatalogSha256(body);
      if (decoded.bodySha256 !== rebuilt
        || decoded.poolId !== `controlled-pool-${rebuilt.slice(0, 20)}`
        || decoded.policy?.mode !== "READ_ONLY_CONTROLLED_POOL"
        || decoded.policy?.maxApplyInFlight !== 1
        || decoded.policy?.walmartWritesAllowed !== false
        || decoded.policy?.automaticRetryAllowed !== false) {
        throw new Error(`${jsonPath}: legacy v2 pool seal or policy differs`);
      }
      pool = {
        ...(decoded as unknown as Omit<
          WalmartListingIntegrityControlledPool,
          "schemaVersion" | "policy" | "quarantinedListingKeys"
          | "quarantinedItems" | "sourceReadiness"
        >),
        schemaVersion: WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA,
        policy: {
          ...(decoded.policy as unknown as WalmartListingIntegrityControlledPool["policy"]),
          terminalFailureMayQuarantineAndAdvance: true,
        },
        quarantinedListingKeys: [],
        quarantinedItems: [],
        sourceReadiness: {
          ...(decoded.sourceReadiness as unknown as Omit<
            WalmartListingIntegrityControlledPool["sourceReadiness"],
            "quarantinedCount"
          >),
          quarantinedCount: 0,
        },
      };
    } else {
      pool = decoded as WalmartListingIntegrityControlledPool;
      verifyWalmartListingIntegrityControlledPool(pool);
    }
    candidates.push({
      pool,
      fileSha256,
      evidencePath: path.relative(process.cwd(), evidenceRoot),
    });
  }
  candidates.sort((left, right) => (
    Date.parse(right.pool.createdAt) - Date.parse(left.pool.createdAt)
    || right.fileSha256.localeCompare(left.fileSha256, "en")
  ));
  return candidates[0] ?? null;
}

export async function loadListingIntegrityOperationsState(
  operationsRoot = DEFAULT_OPERATIONS_ROOT,
  completedRoot = DEFAULT_COMPLETED_ROOT,
): Promise<ListingIntegrityOperationsState> {
  const [selected, completed] = await Promise.all([
    loadLatestPool(operationsRoot),
    loadCompletedOperations(completedRoot),
  ]);
  if (!selected) return { ...emptyState(), completed };
  const completedKeys = [...completed.map((entry) => entry.listingKey)].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
  if (JSON.stringify(completedKeys) !== JSON.stringify(selected.pool.completedListingKeys)) {
    throw new Error("controlled pool completed-listing boundary differs from final galleries");
  }
  return {
    status: "READ_ONLY_POOL_READY",
    poolId: selected.pool.poolId,
    poolBodySha256: selected.pool.bodySha256,
    poolFileSha256: selected.fileSha256,
    poolCreatedAt: selected.pool.createdAt,
    poolEvidencePath: selected.evidencePath,
    strictSequence: true,
    maxApplyInFlight: 1,
    walmartWritesAllowed: false,
    modelCallsAllowed: false,
    sourceCandidateCount: selected.pool.sourceReadiness.candidateCount,
    repairReadyCount: selected.pool.sourceReadiness.repairReadyCount,
    sourceRequiredCount: selected.pool.sourceReadiness.sourceRequiredCount,
    quarantinedCount: selected.pool.sourceReadiness.quarantinedCount,
    completed,
    quarantined: selected.pool.quarantinedItems.map((item) => ({
      listingKey: item.listingKey,
      sku: item.sku,
      itemId: item.itemId,
      quarantinedAt: item.createdAt,
      status: item.status,
      outcome: item.outcome,
      nextAction: item.nextAction,
      listingRepairComplete: false as const,
      samePayloadReapplyAllowed: false as const,
      walmartWriteAuthorized: false as const,
      dispositionBodySha256: item.dispositionBodySha256,
      dispositionFileSha256: item.dispositionFileSha256,
    })),
    pool: selected.pool.items.map((item) => ({
      ordinal: item.ordinal,
      listingKey: item.listingKey,
      sku: item.sku,
      itemId: item.itemId,
      title: item.title,
      outerUnits: item.titleOuterCount,
      // pool.items carries only PRODUCT_TRUTH_READY rows at runtime (the
      // SOURCE_REQUIRED ones live in pool.sourceRequiredItems below); the
      // source union is wider than this read-only web row contract.
      stage: item.stage as "PRODUCT_TRUTH_READY",
      nextAction: item.nextAction as "FRESH_SOURCE_AWARE_AUDIT",
      deterministicFindings: [...item.deterministicFindings],
      performance: {
        units90: item.performance.units90,
        sales90: item.performance.sales90,
        returns90: item.performance.returns90,
        returnRate90: item.performance.returnRate90,
        computedAt: item.performance.computedAt,
      },
      walmartWriteAuthorized: false,
    })),
    sourceRequired: selected.pool.sourceRequiredItems.map((item) => ({
      ordinal: item.ordinal,
      listingKey: item.listingKey,
      sku: item.sku,
      itemId: item.itemId,
      title: item.title,
      outerUnits: item.titleOuterCount,
      stage: "SOURCE_REQUIRED",
      nextAction: "ENRICH_EXACT_PRODUCT_TRUTH",
      deterministicFindings: [...item.deterministicFindings],
      productTruthBlockers: [...item.productTruthBlockers],
      walmartWriteAuthorized: false,
    })),
  };
}

export async function readListingIntegrityGallery(
  sku: string,
  completedRoot = DEFAULT_COMPLETED_ROOT,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  if (!/^[A-Za-z0-9._-]{1,500}$/u.test(sku)) return null;
  const completed = await loadCompletedOperations(completedRoot);
  const exact = completed.find((entry) => entry.sku === sku);
  if (!exact) return null;
  const operations = await loadCompletedOperationsForGallery(completedRoot, sku);
  if (!operations) return null;
  return operations;
}

async function loadCompletedOperationsForGallery(
  root: string,
  sku: string,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const entry of entries.filter((candidate) => (
    candidate.isDirectory() && !candidate.isSymbolicLink()
  ))) {
    const verificationPath = path.join(root, entry.name, "live-canary-verification.json");
    const galleryPath = path.join(root, entry.name, "before-after-gallery.html");
    let verificationBytes;
    let galleryBytes;
    try {
      [verificationBytes, galleryBytes] = await Promise.all([
        regularFileBytes(verificationPath, 1_000_000),
        regularFileBytes(galleryPath, 5_000_000),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const verification = JSON.parse(verificationBytes.toString("utf8"));
    if (!isFinalQualification(verification)) continue;
    const parsed = parseWalmartListingIntegrityCompletedCase({
      verification,
      verificationFileSha256: digest(verificationBytes),
      galleryFileSha256: digest(galleryBytes),
      verificationPath,
      galleryPath,
    });
    if (parsed.sku === sku) {
      matches.push({ parsed, bytes: galleryBytes, sha256: parsed.galleryFileSha256 });
    }
  }
  matches.sort((left, right) => (
    Date.parse(right.parsed.qualifiedAt) - Date.parse(left.parsed.qualifiedAt)
    || right.parsed.verificationFileSha256.localeCompare(
      left.parsed.verificationFileSha256,
      "en",
    )
  ));
  return matches[0] ? { bytes: matches[0].bytes, sha256: matches[0].sha256 } : null;
}
