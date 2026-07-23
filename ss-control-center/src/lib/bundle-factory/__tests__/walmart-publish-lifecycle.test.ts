import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  assertWalmartCertifiedSubmissionAttemptBinding,
  canonicalWalmartPayloadJson,
  classifyWalmartDurableSynchronousFailure,
  classifyWalmartMarketplaceIssues,
  hashWalmartPayload,
  releaseUnknownWalmartSubmissionForRetry,
  WALMART_POLLABLE_LISTING_STATUSES,
  walmartDispositionQuarantinesUpc,
  walmartRecoveryDelayMs,
  walmartSubmissionIdempotencyKey,
  walmartUnknownAbsenceRecovery,
} from "@/lib/bundle-factory/distribution/walmart-publish-lifecycle";
import { evaluateManagedUpcAssignment } from "@/lib/bundle-factory/validation/validators/validator-upc-format";
import {
  assertWalmartPollPersistenceFence,
  evaluateWalmartBuyerLiveGate,
  exactNumericWalmartItemId,
  exactWalmartFeedItem,
  exactWalmartSellerRows,
} from "@/lib/bundle-factory/distribution/status-poller";

test("payload hashing is canonical and yields a stable per-SKU idempotency key", () => {
  const left = { z: 1, a: { y: [2, 1], x: true } };
  const right = { a: { x: true, y: [2, 1] }, z: 1 };
  assert.equal(canonicalWalmartPayloadJson(left), canonicalWalmartPayloadJson(right));
  const hash = hashWalmartPayload(left);
  assert.equal(hash, hashWalmartPayload(right));
  assert.equal(
    walmartSubmissionIdempotencyKey("sku-id", hash),
    walmartSubmissionIdempotencyKey("sku-id", hash),
  );
  assert.notEqual(
    walmartSubmissionIdempotencyKey("sku-id", hash),
    walmartSubmissionIdempotencyKey("other-sku-id", hash),
  );
});

test("certified attempt binding rejects payload, certification, seller, and idempotency drift", () => {
  const payloadSha256 = "a".repeat(64);
  const expected = {
    attemptId: "attempt-1",
    channelSkuId: "sku-id",
    certificationSha256: "b".repeat(64),
    payloadSha256,
    sellerAccountFingerprintSha256: "c".repeat(64),
    idempotencyKey: walmartSubmissionIdempotencyKey("sku-id", payloadSha256),
  };
  const attempt = {
    id: expected.attemptId,
    channel_sku_id: expected.channelSkuId,
    marketplace: "WALMART",
    certification_sha256: expected.certificationSha256,
    payload_hash: expected.payloadSha256,
    seller_account_fingerprint_sha256:
      expected.sellerAccountFingerprintSha256,
    idempotency_key: expected.idempotencyKey,
  };
  assert.doesNotThrow(() =>
    assertWalmartCertifiedSubmissionAttemptBinding({ expected, attempt }),
  );
  for (const changed of [
    { ...attempt, certification_sha256: "d".repeat(64) },
    { ...attempt, payload_hash: "d".repeat(64) },
    { ...attempt, seller_account_fingerprint_sha256: "d".repeat(64) },
    { ...attempt, idempotency_key: `walmart:v1:${"d".repeat(64)}` },
  ]) {
    assert.throws(
      () =>
        assertWalmartCertifiedSubmissionAttemptBinding({
          expected,
          attempt: changed,
        }),
      /not exactly bound/,
    );
  }
});

test("post-GET persistence fence rejects a swapped or terminal active attempt", () => {
  const payloadSha256 = "a".repeat(64);
  const expected = {
    attemptId: "attempt-a",
    channelSkuId: "sku-id",
    certificationSha256: "b".repeat(64),
    payloadSha256,
    sellerAccountFingerprintSha256: "c".repeat(64),
    idempotencyKey: walmartSubmissionIdempotencyKey("sku-id", payloadSha256),
  };
  const attempt = {
    id: expected.attemptId,
    channel_sku_id: expected.channelSkuId,
    marketplace: "WALMART",
    certification_sha256: expected.certificationSha256,
    payload_hash: expected.payloadSha256,
    seller_account_fingerprint_sha256:
      expected.sellerAccountFingerprintSha256,
    idempotency_key: expected.idempotencyKey,
    active_key: expected.channelSkuId,
    state: "PENDING_REVIEW",
  };
  assert.doesNotThrow(() =>
    assertWalmartPollPersistenceFence({
      expected,
      resultAttemptId: expected.attemptId,
      boundAttempt: attempt,
      activeAttemptId: expected.attemptId,
    }),
  );
  assert.throws(
    () =>
      assertWalmartPollPersistenceFence({
        expected,
        resultAttemptId: expected.attemptId,
        boundAttempt: attempt,
        activeAttemptId: "attempt-b",
      }),
    /lost the exact active certified attempt/,
  );
  assert.throws(
    () =>
      assertWalmartPollPersistenceFence({
        expected,
        resultAttemptId: expected.attemptId,
        boundAttempt: { ...attempt, active_key: null, state: "BUYER_VERIFIED" },
        activeAttemptId: null,
      }),
    /lost the exact active certified attempt/,
  );
});

test("a consumed durable POST claim can never be released by replay failure", () => {
  assert.deepEqual(
    classifyWalmartDurableSynchronousFailure({
      state: "CLAIMED",
      requestCount: 0,
    }),
    {
      state: "RETRYABLE",
      disposition: "LOCAL_PREFLIGHT_RETRYABLE",
      release_active_fence: true,
    },
  );
  assert.deepEqual(
    classifyWalmartDurableSynchronousFailure({
      state: "REQUESTING",
      requestCount: 1,
    }),
    {
      state: "UNKNOWN",
      disposition: "SUBMISSION_AMBIGUOUS",
      release_active_fence: false,
    },
  );
  assert.throws(
    () =>
      classifyWalmartDurableSynchronousFailure({
        state: "REQUESTING",
        requestCount: 0,
      }),
    /invalid request counter\/state/i,
  );
});

test("Walmart rejection disposition quarantines only identifier conflicts", () => {
  const collision = classifyWalmartMarketplaceIssues([
    { message: "UPC is already associated with another item" },
  ]);
  const ownership = classifyWalmartMarketplaceIssues([
    { message: "GTIN ownership could not be verified with GS1" },
  ]);
  const generic = classifyWalmartMarketplaceIssues([
    { message: "Required attribute color is missing" },
  ]);
  assert.equal(collision, "UPC_COLLISION");
  assert.equal(ownership, "GTIN_OWNERSHIP_REJECTED");
  assert.equal(generic, "MARKETPLACE_REJECTED");
  assert.equal(walmartDispositionQuarantinesUpc(collision), true);
  assert.equal(walmartDispositionQuarantinesUpc(ownership), true);
  assert.equal(walmartDispositionQuarantinesUpc(generic), false);
});

test("local UPC assignment ignores the legacy CSV flag; certification supplies registry proof", () => {
  assert.deepEqual(
    evaluateManagedUpcAssignment({
      skuId: "sku-1",
      skuUpcPoolId: "pool-1",
      poolRow: {
        id: "pool-1",
        status: "ASSIGNED",
        assigned_to_id: "sku-1",
        gs1_validated: false,
      },
    }),
    { ok: true },
  );
  assert.equal(
    evaluateManagedUpcAssignment({
      skuId: "sku-1",
      skuUpcPoolId: "pool-1",
      poolRow: {
        id: "pool-1",
        status: "QUARANTINED",
        assigned_to_id: "sku-1",
        gs1_validated: true,
      },
    }).ok,
    false,
  );
  assert.equal(
    evaluateManagedUpcAssignment({
      skuId: "sku-1",
      skuUpcPoolId: "pool-1",
      poolRow: {
        id: "pool-1",
        status: "ASSIGNED",
        assigned_to_id: "sku-2",
        gs1_validated: true,
      },
    }).ok,
    false,
  );
});

test("polling covers review and ambiguous recovery states with bounded backoff", () => {
  assert.deepEqual([...WALMART_POLLABLE_LISTING_STATUSES], [
    "SUBMITTED",
    "PENDING_REVIEW",
    "SUBMITTING",
    "SUBMISSION_UNKNOWN",
  ]);
  assert.equal(walmartRecoveryDelayMs(0), 5 * 60_000);
  assert.equal(walmartRecoveryDelayMs(20), 60 * 60_000);
});

test("UNKNOWN timeout plus seller-SKU absence never authorizes retry", async () => {
  const claimedAt = new Date("2026-07-19T10:00:00.000Z");
  assert.deepEqual(
    walmartUnknownAbsenceRecovery({
      claimedAt,
      now: new Date("2026-07-19T11:59:59.999Z"),
    }),
    {
      state: "UNKNOWN",
      disposition: "SUBMISSION_AMBIGUOUS",
      automatic_retry_allowed: false,
    },
  );
  assert.deepEqual(
    walmartUnknownAbsenceRecovery({
      claimedAt,
      now: new Date("2026-07-19T12:00:00.000Z"),
    }),
    {
      state: "UNKNOWN",
      disposition: "MANUAL_RECONCILIATION_REQUIRED",
      automatic_retry_allowed: false,
    },
  );
  await assert.rejects(
    releaseUnknownWalmartSubmissionForRetry({
      channelSkuId: "sku-1",
      attemptId: "attempt-1",
      reason: "seller SKU absent after timeout",
    }),
    /Automatic retry release is prohibited.*manual reconciliation/i,
  );
});

test("exact Walmart parsers never use positional or WPID fallback", () => {
  const seller = {
    ItemResponse: [
      { sku: "OTHER", mart: { itemId: "111" }, publishedStatus: "PUBLISHED" },
      {
        sku: "PILOT-1",
        mart: { itemId: "222" },
        wpid: "ABCDEF",
        publishedStatus: "PUBLISHED",
      },
    ],
  };
  const exact = exactWalmartSellerRows(seller, "PILOT-1");
  assert.equal(exact.length, 1);
  assert.equal(exactNumericWalmartItemId(exact[0]!), "222");
  assert.equal(exactNumericWalmartItemId({ wpid: "ABCDEF" }), null);
  assert.equal(
    exactWalmartFeedItem(
      [
        { sku: "OTHER", ingestionStatus: "SUCCESS", martId: "111" },
        { sku: "PILOT-1", ingestionStatus: "SUCCESS", martId: "222" },
      ],
      "PILOT-1",
    )?.martId,
    "222",
  );
  assert.equal(
    exactWalmartFeedItem(
      [
        { sku: "PILOT-1", ingestionStatus: "SUCCESS", martId: "222" },
        { sku: "PILOT-1", ingestionStatus: "SUCCESS", martId: "333" },
      ],
      "PILOT-1",
    ),
    null,
  );
});

test("feed/seller success alone cannot satisfy Walmart LIVE", () => {
  assert.deepEqual(
    evaluateWalmartBuyerLiveGate({
      sellerPublishedStatus: "PUBLISHED",
      sellerLifecycleStatus: "ACTIVE",
      numericItemId: "222",
      buyerEvidence: null,
    }),
    {
      live: false,
      reason: "BUYER_PUBLISHED_BUYABLE_EVIDENCE_PENDING",
    },
  );
  assert.equal(
    evaluateWalmartBuyerLiveGate({
      sellerPublishedStatus: "PUBLISHED",
      sellerLifecycleStatus: "ACTIVE",
      numericItemId: "222",
      buyerEvidence: {
        published: true,
        buyable: true,
        exact_sku_match: true,
        exact_item_id_match: true,
      },
    }).live,
    true,
  );
});

test("migration enforces one active attempt per SKU and immutable true buyer proof", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await client.execute(`CREATE TABLE "ChannelSKU" ("id" TEXT NOT NULL PRIMARY KEY)`);
    await client.execute(`CREATE TABLE "UPCPool" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "upc" TEXT NOT NULL,
      "reserved_for_id" TEXT
    )`);
    const migration = await readFile(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260719003000_walmart_publish_lifecycle_safety/migration.sql",
      ),
      "utf8",
    );
    await client.executeMultiple(migration);
    await client.execute(
      `INSERT INTO "UPCPool" ("id", "upc", "reserved_for_id")
       VALUES ('pool-1', '012345678905', 'draft-1')`,
    );
    await assert.rejects(
      client.execute(
        `INSERT INTO "UPCPool" ("id", "upc", "reserved_for_id")
         VALUES ('pool-2', '012345678912', 'draft-1')`,
      ),
    );
    await client.execute(
      `INSERT INTO "ChannelSKU" ("id") VALUES ('sku-1'), ('sku-2'), ('sku-3')`,
    );
    const insertAttempt = (
      id: string,
      activeKey: string | null,
      state: string,
      channelSkuId = "sku-1",
      pilotSlot: 1 | 2 = channelSkuId === "sku-1" ? 1 : 2,
    ) =>
      client.execute({
        sql: `INSERT INTO "MarketplaceSubmissionAttempt" (
          "id", "channel_sku_id", "marketplace", "idempotency_key",
          "active_key", "pilot_permit_sha256", "pilot_permit_id",
          "owner_key_id", "owner_signature_sha256", "pilot_slot",
          "pilot_approval_sha256", "certification_sha256",
          "seller_account_fingerprint_sha256",
          "payload_hash", "claim_token", "state",
          "claimed_at", "updated_at"
        ) VALUES (
          ?, ?, 'WALMART', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )`,
        args: [
          id,
          channelSkuId,
          `idem-${id}`,
          activeKey,
          createHash("sha256").update(`permit-${id}`).digest("hex"),
          `owner-permit://${id}`,
          "owner-test-key",
          createHash("sha256").update(`signature-${id}`).digest("hex"),
          pilotSlot,
          "b".repeat(64),
          "d".repeat(64),
          "c".repeat(64),
          "a".repeat(64),
          `claim-${id}`,
          state,
        ],
      });
    await insertAttempt("attempt-1", "sku-1", "CLAIMED");
    const forgedConsume = await client.execute(
      `UPDATE "MarketplaceSubmissionAttempt"
       SET "state"='REQUESTING', "request_count"=1,
           "requested_at"=CURRENT_TIMESTAMP
       WHERE "id"='attempt-1' AND "claim_token"='forged-token'
         AND "state"='CLAIMED' AND "request_count"=0`,
    );
    assert.equal(Number(forgedConsume.rowsAffected), 0);
    const firstConsume = await client.execute(
      `UPDATE "MarketplaceSubmissionAttempt"
       SET "state"='REQUESTING', "request_count"=1,
           "requested_at"=CURRENT_TIMESTAMP
       WHERE "id"='attempt-1' AND "claim_token"='claim-attempt-1'
         AND "state"='CLAIMED' AND "request_count"=0`,
    );
    assert.equal(Number(firstConsume.rowsAffected), 1);
    const replayedConsume = await client.execute(
      `UPDATE "MarketplaceSubmissionAttempt"
       SET "state"='REQUESTING', "request_count"=1,
           "requested_at"=CURRENT_TIMESTAMP
       WHERE "id"='attempt-1' AND "claim_token"='claim-attempt-1'
         AND "state"='CLAIMED' AND "request_count"=0`,
    );
    assert.equal(Number(replayedConsume.rowsAffected), 0);
    await assert.rejects(insertAttempt("attempt-2", "sku-1", "CLAIMED"));
    await assert.rejects(
      client.execute(
        `UPDATE "MarketplaceSubmissionAttempt" SET "active_key"=NULL
         WHERE "id"='attempt-1'`,
      ),
      /invalid marketplace submission active fence/,
    );
    await client.execute(
      `UPDATE "MarketplaceSubmissionAttempt"
       SET "state"='RETRYABLE', "active_key"=NULL
       WHERE "id"='attempt-1'`,
    );
    await client.execute(
      `UPDATE "MarketplaceSubmissionAttempt"
       SET "state"='CLAIMED', "active_key"='sku-1'
       WHERE "id"='attempt-1'`,
    );
    await insertAttempt("attempt-sku-2", null, "RETRYABLE", "sku-2");
    await assert.rejects(
      client.execute(
        `DELETE FROM "MarketplaceSubmissionAttempt" WHERE "id"='attempt-1'`,
      ),
      /MarketplaceSubmissionAttempt is append-retained/,
    );
    await assert.rejects(
      insertAttempt("attempt-sku-3", null, "RETRYABLE", "sku-3"),
      /WALMART_PILOT_GLOBAL_TWO_SKU_CAP_REACHED/,
    );

    await assert.rejects(
      client.execute({
        sql: `INSERT INTO "WalmartBuyerPublicationEvidence" (
          "id", "channel_sku_id", "submission_attempt_id", "sku",
          "walmart_item_id", "source_url", "source_kind", "captured_at",
          "exact_sku_match", "exact_item_id_match", "published", "buyable",
          "evidence_hash", "raw_evidence"
        ) VALUES (
          'evidence-cross-sku', 'sku-2', 'attempt-1', 'PILOT-2', '223',
          'https://www.walmart.com/ip/223', 'WALMART_BUYER_PDP', CURRENT_TIMESTAMP,
          1, 1, 1, 1, ?, '{}'
        )`,
        args: ["c".repeat(64)],
      }),
      /WALMART_BUYER_EVIDENCE_ATTEMPT_SKU_MISMATCH/,
    );

    await assert.rejects(
      client.execute({
        sql: `INSERT INTO "WalmartBuyerPublicationEvidence" (
          "id", "channel_sku_id", "submission_attempt_id", "sku",
          "walmart_item_id", "source_url", "source_kind", "captured_at",
          "exact_sku_match", "exact_item_id_match", "published", "buyable",
          "evidence_hash", "raw_evidence"
        ) VALUES (
          'evidence-bad', 'sku-1', 'attempt-1', 'PILOT-1', '222',
          'https://www.walmart.com/ip/222', 'WALMART_BUYER_PDP', CURRENT_TIMESTAMP,
          1, 1, 1, 0, ?, '{}'
        )`,
        args: ["b".repeat(64)],
      }),
    );
  } finally {
    client.close();
  }
});

test("distribution source fences approval immediately before Walmart network submit", async () => {
  const [pipelineSource, transportSource, lifecycleSource] = await Promise.all([
    readFile(
      path.resolve(
        process.cwd(),
        "src/lib/bundle-factory/distribution/distribution-pipeline.ts",
      ),
      "utf8",
    ),
    readFile(
      path.resolve(
        process.cwd(),
        "src/lib/bundle-factory/distribution/walmart-publish.ts",
      ),
      "utf8",
    ),
    readFile(
      path.resolve(
        process.cwd(),
        "src/lib/bundle-factory/distribution/walmart-publish-lifecycle.ts",
      ),
      "utf8",
    ),
  ]);
  const claim = pipelineSource.indexOf("const claim = await claimWalmartSubmission");
  const approval = pipelineSource.indexOf(
    "assertValidWalmartDistributionApproval(sku)",
    claim,
  );
  const networkSubmit = pipelineSource.indexOf(
    "r = await submitToWalmart",
    approval,
  );
  assert.ok(claim > 0);
  assert.ok(approval > claim);
  assert.ok(networkSubmit > approval);
  assert.doesNotMatch(pipelineSource, /markWalmartSubmissionRequesting/);
  assert.match(
    pipelineSource.slice(networkSubmit),
    /beforeFeedPost:\s*async\s*\(\)\s*=>/,
  );
  assert.match(
    pipelineSource.slice(networkSubmit),
    /await input\.beforeWalmartFeedPost\?\.\(\)/,
  );
  assert.match(pipelineSource, /lifecyclePostClaim:\s*\{/);
  assert.match(pipelineSource, /WALMART_PILOT_MAX_APPLY_SKUS/);

  const transport = transportSource.slice(
    transportSource.indexOf("export async function submitToWalmart"),
  );
  const adjacentGuard = transport.indexOf("await input.beforeFeedPost?.()");
  const permit = transport.indexOf(
    "assertWalmartOwnerPermitSignature",
    adjacentGuard,
  );
  const oneShotConsume = transport.indexOf(
    "await markWalmartSubmissionRequesting",
    permit,
  );
  const feedPost = transport.indexOf(
    'client.requestRaw("POST", "/feeds"',
    oneShotConsume,
  );
  assert.ok(adjacentGuard > 0);
  assert.ok(permit > adjacentGuard);
  assert.ok(oneShotConsume > permit);
  assert.ok(feedPost > oneShotConsume);

  const durableFailure = lifecycleSource.slice(
    lifecycleSource.indexOf("export async function recordWalmartSynchronousFailure"),
    lifecycleSource.indexOf("export async function getActiveWalmartSubmissionAttempt"),
  );
  assert.match(durableFailure, /classifyWalmartDurableSynchronousFailure/);
  assert.match(
    durableFailure,
    /classified\.state === "UNKNOWN" \? input\.channelSkuId : null/,
  );
});
