import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";
import type { ChannelSKU } from "@/generated/prisma/client";

test("Walmart transport consumes one durable claim and rejects replay/forgery", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-feed-one-shot-"));
  const databasePath = path.join(root, "lifecycle.sqlite");
  const databaseUrl = `file:${databasePath}`;
  const ownerKeys = generateKeyPairSync("ed25519");
  const ownerPublicDer = ownerKeys.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    WALMART_NEW_SKU_TEST_MODE: "1",
    WALMART_NEW_SKU_TEST_ALLOW_FEED_POST: "1",
    WALMART_API_BASE_URL: "https://one-shot.fixture.test",
    WALMART_NEW_SKU_TEST_OWNER_KEY_ID: "owner-one-shot-fixture-key",
    WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      ownerPublicDer.toString("base64"),
  });

  const db = createClient({ url: databaseUrl });
  const {
    buildWalmartPayload,
    submitToWalmart,
  } = await import("@/lib/bundle-factory/distribution/walmart-publish");
  const { hashWalmartPayload } = await import(
    "@/lib/bundle-factory/distribution/walmart-payload-hash"
  );
  const {
    claimWalmartSubmission,
    recordWalmartSynchronousFailure,
  } = await import(
    "@/lib/bundle-factory/distribution/walmart-publish-lifecycle"
  );
  const {
    assembleWalmartOwnerPermit,
    buildWalmartOwnerPermitSigningRequest,
  } = await import("@/lib/bundle-factory/walmart-owner-permit");
  const {
    sha256WalmartJson,
    WALMART_PUBLIC_CONTRACT_SCHEMA,
  } = await import("@/lib/bundle-factory/walmart-listing-contract");
  const { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } = await import(
    "@/lib/bundle-factory/validation/walmart-prepublication-policy"
  );
  const { VERIFIED_PHYSICAL_PACKAGE_SCHEMA } = await import(
    "@/lib/bundle-factory/physical-package-specs"
  );
  const { prisma } = await import("@/lib/prisma");

  t.after(async () => {
    await prisma.$disconnect();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  await db.execute(`CREATE TABLE "ChannelSKU" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "master_bundle_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "brand_account_id" TEXT,
    "sku" TEXT NOT NULL,
    "upc" TEXT NOT NULL,
    "upc_pool_id" TEXT,
    "asin" TEXT,
    "walmart_item_id" TEXT,
    "ebay_item_id" TEXT,
    "tiktok_product_id" TEXT,
    "title" TEXT NOT NULL,
    "bullets" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "search_terms" TEXT,
    "attributes" TEXT NOT NULL,
    "channel_category" TEXT,
    "channel_browse_node" TEXT,
    "price_cents" INTEGER NOT NULL,
    "business_price_cents" INTEGER,
    "lifecycle_status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submitted_at" DATETIME,
    "processing_at" DATETIME,
    "live_at" DATETIME,
    "live_url" TEXT,
    "last_error_at" DATETIME,
    "errors" TEXT,
    "units_sold_30d" INTEGER DEFAULT 0,
    "revenue_30d_cents" INTEGER DEFAULT 0,
    "compliance_status" TEXT NOT NULL DEFAULT 'PENDING',
    "compliance_check_id" TEXT,
    "compliance_blocked_at" DATETIME,
    "compliance_blocked_reasons" TEXT,
    "main_image_url" TEXT,
    "validation_status" TEXT NOT NULL DEFAULT 'PENDING',
    "validation_errors" TEXT,
    "validated_at" DATETIME,
    "validation_check_id" TEXT,
    "validation_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_quantity" INTEGER,
    "inventory_checked_at" DATETIME,
    "package_length_in" REAL,
    "package_width_in" REAL,
    "package_height_in" REAL,
    "package_weight_oz" REAL,
    "country_of_origin" TEXT DEFAULT 'US',
    "item_type" TEXT,
    "listing_status" TEXT NOT NULL DEFAULT 'PENDING',
    "submission_id" TEXT,
    "published_at" DATETIME,
    "distribution_errors" TEXT,
    "distribution_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_status_check_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
  )`);
  await db.execute(`CREATE TABLE "UPCPool" (
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
  await db.executeMultiple(migration);
  await db.execute(`CREATE TABLE "ListingLifecycleLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "master_bundle_id" TEXT,
    "channel_sku_id" TEXT,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "details" TEXT,
    "user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute({
    sql: `INSERT INTO "ChannelSKU" (
      "id", "master_bundle_id", "channel", "sku", "upc", "title",
      "bullets", "description", "attributes", "price_cents", "updated_at"
    ) VALUES (?, ?, 'WALMART', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "sku-one-shot",
      "bundle-one-shot",
      "WM-ONE1-SHOT",
      "012345678905",
      "Example Brand Sea Salt Snack 8 oz",
      JSON.stringify(["One 8 oz bag."]),
      "Sea salt snack in one 8 oz bag.",
      "{}",
      1299,
      new Date().toISOString(),
    ],
  });

  const schema = { type: "object", required: ["MPItemFeedHeader", "MPItem"] };
  const contract = {
    contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
    spec_version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    spec_schema_hash: sha256WalmartJson(schema),
    spec_fetched_at: "2026-07-19T10:00:00.000Z",
    product_type: "Food And Beverage",
    country_of_origin_substantial_transformation: "US",
    secondary_image_urls: ["https://images.fixture.test/one-shot-side.png"],
    public_attributes: { flavor: "Sea Salt" },
    offer_handoff: {
      mode: "STAGED_AFTER_ITEM_SETUP",
      quantity: 1,
      fulfillment_center_id: "DEFAULT",
      fulfillment_lag_time: 1,
    },
  };
  const now = new Date();
  const sku = {
    id: "sku-one-shot",
    master_bundle_id: "bundle-one-shot",
    channel: "WALMART",
    sku: "WM-ONE1-SHOT",
    upc: "012345678905",
    title: "Example Brand Sea Salt Snack 8 oz",
    bullets: JSON.stringify(["One 8 oz bag."]),
    description: "Sea salt snack in one 8 oz bag.",
    attributes: JSON.stringify({ walmart: contract }),
    price_cents: 1299,
    main_image_url: "https://images.fixture.test/one-shot.png",
    package_length_in: 10,
    package_width_in: 8,
    package_height_in: 4,
    package_weight_oz: 8,
    created_at: now,
    updated_at: now,
  } as unknown as ChannelSKU;
  const physicalPackageSpecs = {
    schema_version: VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
    source: "OPERATOR_SHIP_SPECS" as const,
    verified_at: now.toISOString(),
    weight_oz: 8,
    length_in: 10,
    width_in: 8,
    height_in: 4,
  };
  const buildOptions = {
    brand: "Example Brand",
    packCount: 1,
    physicalPackageSpecs,
  };
  const payload = buildWalmartPayload(sku, buildOptions);
  const payloadHash = hashWalmartPayload(payload);
  const approvalSha256 = "2".repeat(64);
  const sellerFingerprint = "7".repeat(64);
  const permitRequest = buildWalmartOwnerPermitSigningRequest({
    key_id: "owner-one-shot-fixture-key",
    signed_body: {
      permit_id: "owner-permit://one-shot/sku-one-shot",
      action: "WALMART_MP_ITEM_SUBMIT",
      environment: "TEST_FIXTURE_ONLY",
      engine_release_sha256: "1".repeat(64),
      approval_sha256: approvalSha256,
      doctor_receipt_sha256: "3".repeat(64),
      apply_preview_receipt_sha256: "4".repeat(64),
      certification_sha256: "5".repeat(64),
      candidate_key: "candidate-one-shot",
      channel_sku_id: sku.id,
      sku: sku.sku,
      upc: sku.upc!,
      payload_sha256: payloadHash,
      store_index: 1,
      seller_account_fingerprint_sha256: sellerFingerprint,
      database_target_fingerprint_sha256: "8".repeat(64),
      pilot_slot: 1,
      max_pilot_skus: 2,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 20 * 60_000).toISOString(),
      approved_by: "fixture-owner",
      decision_ref: "owner-decision://one-shot/sku-one-shot",
      live_submission_authorized: true,
      claims: {
        exact_one_sku: true,
        marketplace_submission_max: 1,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
  });
  const signedPermit = assembleWalmartOwnerPermit({
    request: permitRequest,
    signature_base64: sign(
      null,
      Buffer.from(permitRequest.signing_message_base64, "base64"),
      ownerKeys.privateKey,
    ).toString("base64"),
  });
  const claimToken = "claim-one-shot-fixture";
  await db.execute({
    sql: `INSERT INTO "MarketplaceSubmissionAttempt" (
      "id", "channel_sku_id", "marketplace", "idempotency_key",
      "active_key", "pilot_permit_sha256", "pilot_permit_id",
      "owner_key_id", "owner_signature_sha256", "pilot_slot",
      "pilot_approval_sha256", "certification_sha256",
      "seller_account_fingerprint_sha256",
      "payload_hash", "claim_token", "state", "claimed_at", "updated_at"
    ) VALUES (?, ?, 'WALMART', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?)`,
    args: [
      "attempt-one-shot",
      sku.id,
      `walmart:v1:${createHash("sha256").update(`${sku.id}\n${payloadHash}`).digest("hex")}`,
      sku.id,
      signedPermit.permit_sha256,
      signedPermit.signed_body.permit_id,
      signedPermit.key_id,
      signedPermit.signature_sha256,
      approvalSha256,
      signedPermit.signed_body.certification_sha256,
      sellerFingerprint,
      payloadHash,
      claimToken,
      now.toISOString(),
      now.toISOString(),
    ],
  });

  let feedPosts = 0;
  const client = {
    async requestRaw(_method: string, requestPath: string) {
      if (requestPath === "/items/spec") {
        return {
          status: 200,
          ok: true,
          body: { schema },
          correlationId: "one-shot-spec",
        };
      }
      assert.equal(requestPath, "/feeds");
      feedPosts += 1;
      return {
        status: 200,
        ok: true,
        body: { feedId: "one-shot-feed", status: "RECEIVED" },
        correlationId: "one-shot-feed",
      };
    },
  };
  const ownerPermitAuthorization = {
    signedPermit,
    engineReleaseSha256: signedPermit.signed_body.engine_release_sha256,
    approvalSha256,
    sellerAccountFingerprintSha256: sellerFingerprint,
  };
  const submit = (claim: { attemptId: string; claimToken: string }) =>
    submitToWalmart({
      sku,
      storeIndex: 1,
      ...buildOptions,
      dryRun: false,
      beforeFeedPost() {},
      ownerPermitAuthorization,
      lifecyclePostClaim: claim,
      client,
    });

  const forged = await submit({
    attemptId: "attempt-one-shot",
    claimToken: "forged-one-shot-token",
  });
  assert.equal(forged.ok, false);
  assert.match(forged.error ?? "", /forged|already consumed/i);
  assert.equal(feedPosts, 0);
  const afterForgery = await db.execute(
    `SELECT state, request_count
     FROM "MarketplaceSubmissionAttempt" WHERE "id"='attempt-one-shot'`,
  );
  assert.equal(afterForgery.rows[0]?.state, "CLAIMED");
  assert.equal(Number(afterForgery.rows[0]?.request_count), 0);

  const first = await submit({ attemptId: "attempt-one-shot", claimToken });
  assert.equal(first.ok, true);
  assert.equal(feedPosts, 1);

  const replay = await submit({ attemptId: "attempt-one-shot", claimToken });
  assert.equal(replay.ok, false);
  assert.match(replay.error ?? "", /already consumed/i);
  assert.equal(feedPosts, 1);
  const recorded = await recordWalmartSynchronousFailure({
    channelSkuId: sku.id,
    attemptId: "attempt-one-shot",
    claimToken,
    error: replay.error,
  });
  assert.equal(recorded.listingStatus, "SUBMISSION_UNKNOWN");

  const retry = await claimWalmartSubmission({
    channelSkuId: sku.id,
    payload,
    pilotPermit: {
      permitSha256: signedPermit.permit_sha256,
      permitId: signedPermit.signed_body.permit_id,
      ownerKeyId: signedPermit.key_id,
      ownerSignatureSha256: signedPermit.signature_sha256,
      signedPermit,
      engineReleaseSha256: signedPermit.signed_body.engine_release_sha256,
      pilotSlot: 1,
      approvalSha256,
      certificationSha256: signedPermit.signed_body.certification_sha256,
      sellerAccountFingerprintSha256: sellerFingerprint,
    },
  });
  assert.equal(retry.claimed, false);
  assert.equal(retry.prior_state, "UNKNOWN");
  assert.match(retry.reason ?? "", /already has UNKNOWN attempt/i);
  assert.equal(feedPosts, 1);

  const attempt = await db.execute(
    `SELECT state, request_count, active_key
     FROM "MarketplaceSubmissionAttempt" WHERE "id"='attempt-one-shot'`,
  );
  assert.equal(attempt.rows[0]?.state, "UNKNOWN");
  assert.equal(Number(attempt.rows[0]?.request_count), 1);
  assert.equal(attempt.rows[0]?.active_key, sku.id);
  const channelSku = await db.execute(
    `SELECT listing_status FROM "ChannelSKU" WHERE "id"='sku-one-shot'`,
  );
  assert.equal(channelSku.rows[0]?.listing_status, "SUBMISSION_UNKNOWN");
});
