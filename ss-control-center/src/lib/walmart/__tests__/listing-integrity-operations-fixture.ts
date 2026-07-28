import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  walmartListingIntegrityCatalogSha256,
} from "../listing-integrity-catalog-orchestrator";
import {
  WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA,
  WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA,
  type WalmartListingIntegrityControlledPool,
  type WalmartListingIntegrityControlledPoolItem,
} from "../listing-integrity-operations";

const SHA = (value: string | Uint8Array): string => (
  createHash("sha256").update(value).digest("hex")
);

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function poolItem(
  sku: string,
  ordinal: number,
  stage: "PRODUCT_TRUTH_READY" | "SOURCE_REQUIRED",
): WalmartListingIntegrityControlledPoolItem {
  const ready = stage === "PRODUCT_TRUTH_READY";
  return {
    ordinal,
    listingKey: `walmart:1:${sku}`,
    storeIndex: 1,
    sku,
    itemId: String(8_000_000_000 + ordinal),
    title: `${sku} Exact Product, Pack of 2`,
    stage,
    nextAction: ready
      ? "FRESH_SOURCE_AWARE_AUDIT"
      : "ENRICH_EXACT_PRODUCT_TRUTH",
    titleOuterCount: 2,
    deterministicFindings: ready && ordinal === 9
      ? []
      : ["TITLE_MULTIPACK_REQUIRES_VISUAL_AUDIT"],
    reasonCodes: ["MULTIPACK_AUDIT"],
    productTruthBlockers: ready ? [] : ["EXACT_COMPONENT_TRUTH_MISSING"],
    performance: {
      computedAt: "2026-07-28T12:00:00.000Z",
      units30: 10,
      sales30: 100,
      orders30: 8,
      returns30: ready && ordinal === 9 ? 0 : 1,
      units90: 30,
      sales90: 300,
      orders90: 24,
      returns90: ready && ordinal === 9 ? 0 : 2,
      returnRate90: ready && ordinal === 9 ? 0 : 2 / 30,
    },
    authority: {
      productTruthReady: ready,
      freshBuyerRereadReady: false,
      repairPlanReady: false,
      ownerPermitReady: false,
      walmartWriteAuthorized: false,
    },
  };
}

async function writeCompletedCase(
  root: string,
  input: {
    sku: string;
    itemId: string;
    ordinal: number;
    checks: number;
  },
): Promise<{ listingKey: string; gallerySha256: string }> {
  const directory = path.join(root, input.sku);
  await mkdir(directory, { mode: 0o700 });
  const checks = Object.fromEntries(
    Array.from({ length: input.checks }, (_, index) => [`check_${index + 1}`, true]),
  );
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_LIVE_VERIFICATION_SCHEMA,
    status: "LIVE_SURFACE_PASS",
    listing: {
      listing_key: `walmart:1:${input.sku}`,
      store_index: 1,
      sku: input.sku,
      item_id: input.itemId,
    },
    feed_id: `feed-${input.sku}`,
    exact_payload_sha256: SHA(`payload-${input.sku}`),
    before: {
      captured_at: `2026-07-27T0${input.ordinal}:00:00.000Z`,
    },
    after: {
      captured_at: `2026-07-28T0${input.ordinal}:00:00.000Z`,
    },
    checks,
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      frozen_sequence_gate_receipt_emitted: true,
      next_sku_unblocked: true,
    },
  };
  const verification = {
    ...body,
    body_sha256: walmartListingIntegrityCatalogSha256(body),
  };
  const gallery = Buffer.from(
    `<!doctype html><title>${input.sku} · фактическое ДО → ПОСЛЕ</title>`
      + `<main>LIVE SURFACE PASS · ${input.sku}</main>\n`,
    "utf8",
  );
  await Promise.all([
    writeFile(
      path.join(directory, "live-canary-verification.json"),
      jsonBytes(verification),
      { mode: 0o400 },
    ),
    writeFile(
      path.join(directory, "before-after-gallery.html"),
      gallery,
      { mode: 0o400 },
    ),
  ]);
  return {
    listingKey: `walmart:1:${input.sku}`,
    gallerySha256: SHA(gallery),
  };
}

export async function createListingIntegrityOperationsFixture(): Promise<{
  operationsRoot: string;
  completedRoot: string;
  pool: WalmartListingIntegrityControlledPool;
  gallerySha256BySku: ReadonlyMap<string, string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-operations-"));
  const operationsRoot = path.join(root, "operations");
  const completedRoot = path.join(root, "completed");
  await Promise.all([
    mkdir(operationsRoot, { mode: 0o700 }),
    mkdir(completedRoot, { mode: 0o700 }),
  ]);
  const completed = await Promise.all([
    writeCompletedCase(completedRoot, {
      sku: "FaisalX-1148",
      itemId: "15144369671",
      ordinal: 1,
      checks: 20,
    }),
    writeCompletedCase(completedRoot, {
      sku: "FaisalX-1181",
      itemId: "8389917875",
      ordinal: 2,
      checks: 18,
    }),
    writeCompletedCase(completedRoot, {
      sku: "FaisalX-1183",
      itemId: "8419413379",
      ordinal: 3,
      checks: 18,
    }),
  ]);
  const completedListingKeys = completed
    .map((entry) => entry.listingKey)
    .sort((left, right) => left.localeCompare(right, "en"));
  const repairSkus = [
    "FaisalX-1140",
    "FaisalX-1228",
    "FaisalX-231",
    "FaisalX-2526",
    "FaisalX-2734",
    "FaisalX-2751",
    "FaisalX-2769",
    "FaisalX-2770",
    "FaisalX-3485",
    "FaisalX-3486",
  ];
  const sourceSkus = [
    "FaisalX-1220",
    "FaisalX-1250",
    "FaisalX-1300",
    "FaisalX-1400",
    "FaisalX-1500",
    "FaisalX-1600",
    "FaisalX-1700",
    "FaisalX-1800",
    "FaisalX-1900",
    "FaisalX-2000",
  ];
  const quarantinedItem = {
    listingKey: "walmart:1:FaisalX-2768",
    sku: "FaisalX-2768",
    itemId: "1838619805",
    storeIndex: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    status: "QUARANTINED_UNRESOLVED" as const,
    outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET" as const,
    nextAction: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN" as const,
    dispositionBodySha256: SHA("quarantine-body"),
    dispositionFileSha256: SHA("quarantine-file"),
    dispositionPath: "/immutable/quarantine/FaisalX-2768/failure-disposition.json",
  };
  const body = {
    schemaVersion: WALMART_LISTING_INTEGRITY_CONTROLLED_POOL_SCHEMA,
    createdAt: "2026-07-28T12:30:00.000Z",
    storeIndex: 1,
    source: {
      censusId: "catalog-census-test",
      censusBodySha256: SHA("census-body"),
      censusFileSha256: SHA("census-file"),
      scanPlanId: "scan-plan-test",
      scanPlanBodySha256: SHA("plan-body"),
      scanPlanFileSha256: SHA("plan-file"),
      authoritativeManifestSha256: SHA("manifest"),
    },
    policy: {
      mode: "READ_ONLY_CONTROLLED_POOL" as const,
      requestedSize: 10,
      sourceRequiredPreviewSize: 10,
      strictSequence: true as const,
      maxApplyInFlight: 1 as const,
      automaticRetryAllowed: false as const,
      unknownPostReplayAllowed: false as const,
      walmartWritesAllowed: false as const,
      modelCallsAllowed: false as const,
      paidProviderCallsAllowed: false as const,
      terminalFailureMayQuarantineAndAdvance: true as const,
    },
    completedListingKeys,
    quarantinedListingKeys: [quarantinedItem.listingKey],
    quarantinedItems: [quarantinedItem],
    items: repairSkus.map((sku, ordinal) => (
      poolItem(sku, ordinal, "PRODUCT_TRUTH_READY")
    )),
    sourceRequiredItems: sourceSkus.map((sku, ordinal) => (
      poolItem(sku, ordinal, "SOURCE_REQUIRED")
    )),
    sourceReadiness: {
      candidateCount: 1204,
      repairReadyCount: 14,
      sourceRequiredCount: 1190,
      quarantinedCount: 1,
    },
    externalEffects: {
      databaseReads: 14,
      databaseWrites: 0 as const,
      walmartReads: 0 as const,
      walmartWrites: 0 as const,
      modelCalls: 0 as const,
      paidProviderCalls: 0 as const,
    },
  };
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  const pool: WalmartListingIntegrityControlledPool = {
    ...body,
    poolId: `controlled-pool-${bodySha256.slice(0, 20)}`,
    bodySha256,
  };
  const poolDirectory = path.join(operationsRoot, "sealed-pool");
  await mkdir(poolDirectory, { mode: 0o700 });
  const poolBytes = jsonBytes(pool);
  await Promise.all([
    writeFile(
      path.join(poolDirectory, "controlled-pool.json"),
      poolBytes,
      { mode: 0o400 },
    ),
    writeFile(
      path.join(poolDirectory, "controlled-pool.sha256"),
      `${SHA(poolBytes)}\n`,
      { mode: 0o400 },
    ),
  ]);
  return {
    operationsRoot,
    completedRoot,
    pool,
    gallerySha256BySku: new Map([
      ["FaisalX-1148", completed[0]!.gallerySha256],
      ["FaisalX-1181", completed[1]!.gallerySha256],
      ["FaisalX-1183", completed[2]!.gallerySha256],
    ]),
  };
}
