// node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-base-offer-live-executor.test.ts

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ListingItem, ListingPatch } from "../../amazon-sp-api/listings";
import {
  applySparsePurchasableOfferMerge,
  sha256,
  stableJson,
  type BaseOfferPreservePlan,
  type BaseOfferPreserveSelection,
} from "../repair/uncrustables-base-offer-preserve";
import {
  BASE_OFFER_LIVE_ARM_ENV,
  BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA,
  LK_FIRST_CANARY_ACTION_ID,
  createBaseOfferLiveSelection,
  createBaseOfferRollbackBinding,
  baseOfferLiveArmToken,
  type BaseOfferLiveAuthorization,
  type BaseOfferLiveSelection,
  type BaseOfferRollbackBinding,
} from "../repair/uncrustables-base-offer-live-contract";
import {
  ImmutableBaseOfferCheckpointStore,
  baseOfferExecutionBindingSha256,
  executeBaseOfferLive,
  type BaseOfferAmazonGateway,
  type BaseOfferAmazonGatewayResponse,
} from "../repair/uncrustables-base-offer-live-executor";
import type { UncrustablesPreChangeSnapshot } from "../repair/uncrustables-amazon-rollback";

const PLAN_PATH =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json";
const FULL_SELECTION_PATH =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json";
const LIVE_SELECTION_PATH =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-lk-first-canary-20260719-v1/live-selection.json";
const SNAPSHOT_PATH =
  "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/" +
  "UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json";
const BINDING_AT = new Date("2026-07-19T03:05:00.000Z");
const RUNTIME_AT = new Date("2026-07-19T03:06:00.000Z");

interface Fixture {
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  liveSelection: BaseOfferLiveSelection;
  snapshot: UncrustablesPreChangeSnapshot;
  snapshotBytes: Buffer;
  rollbackBinding: BaseOfferRollbackBinding;
  before: ListingItem;
  desired: ListingItem;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function fixture(): Promise<Fixture> {
  const [planBytes, fullSelectionBytes, liveSelectionBytes, snapshotBytes] =
    await Promise.all([
      readFile(PLAN_PATH),
      readFile(FULL_SELECTION_PATH),
      readFile(LIVE_SELECTION_PATH),
      readFile(SNAPSHOT_PATH),
    ]);
  const plan = JSON.parse(planBytes.toString("utf8")) as BaseOfferPreservePlan;
  const fullSelection = JSON.parse(
    fullSelectionBytes.toString("utf8"),
  ) as BaseOfferPreserveSelection;
  const liveSelection = JSON.parse(
    liveSelectionBytes.toString("utf8"),
  ) as BaseOfferLiveSelection;
  const snapshot = JSON.parse(
    snapshotBytes.toString("utf8"),
  ) as UncrustablesPreChangeSnapshot;
  const rollbackBinding = createBaseOfferRollbackBinding({
    plan,
    fullSelection,
    liveSelection,
    snapshotPath: SNAPSHOT_PATH,
    snapshotBytes,
    snapshot,
    now: BINDING_AT,
  });
  const entry = plan.entries.find(
    (candidate) => candidate.action_id === LK_FIRST_CANARY_ACTION_ID,
  );
  assert.ok(entry);
  const snapshotEntry = snapshot.entries.find(
    (candidate) => candidate.sku === entry.sku,
  );
  assert.ok(snapshotEntry);
  const before = clone(snapshotEntry.listing);
  const desired = clone(before);
  assert.ok(desired.attributes);
  desired.attributes.purchasable_offer = applySparsePurchasableOfferMerge(
    desired.attributes.purchasable_offer as unknown[],
    entry.actual_patch.value,
  );
  const b2b = (desired.offers as Array<Record<string, unknown>>).find(
    (offer) => offer.offerType === "B2B",
  );
  assert.ok(b2b);
  b2b.price = { currency: "USD", currencyCode: "USD", amount: "76.99" };
  desired.issues = (desired.issues ?? []).filter(
    (issue) => String(issue.code ?? "") !== "19038",
  );
  return {
    plan,
    fullSelection,
    liveSelection,
    snapshot,
    snapshotBytes,
    rollbackBinding,
    before,
    desired,
  };
}

function authorization(fx: Fixture): BaseOfferLiveAuthorization {
  const body: Omit<BaseOfferLiveAuthorization, "body_sha256"> = {
    schema_version: BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA,
    profile: "AMAZON_BASE_OFFER_PRESERVE_PROMO_V1",
    immutable: true,
    authorization_id: "OWNER-LK-TEST-AUTHORIZATION",
    owner_approved: true,
    created_at: BINDING_AT.toISOString(),
    expires_at: "2026-07-19T03:14:00.000Z",
    permit: "APPLY_AMAZON_BASE_OFFER_PRESERVE_PROMO_V1",
    source_plan_body_sha256: fx.plan.body_sha256,
    source_full_selection_body_sha256: fx.fullSelection.body_sha256,
    source_live_selection_body_sha256: fx.liveSelection.body_sha256,
    source_rollback_binding_body_sha256: fx.rollbackBinding.body_sha256,
    snapshot_file_sha256: fx.rollbackBinding.snapshot.file_sha256,
    snapshot_body_sha256: fx.rollbackBinding.snapshot.body_sha256,
    selected_action_ids: [...fx.liveSelection.selected_action_ids],
    account: {
      store_index: 1,
      marketplace_id: "ATVPDKIKX0DER",
      amazon_merchant_id: "A1TESTMERCHANT",
    },
    constraints: {
      exact_patch_path: "/attributes/purchasable_offer",
      discounted_price_action_authorized: false,
      list_price_action_authorized: false,
      sales_price_action_authorized: false,
      coupon_action_authorized: false,
      one_patch_attempt_per_action: true,
      stable_readback_required: true,
    },
  };
  return { ...body, body_sha256: sha256(stableJson(body)) };
}

class MockGateway implements BaseOfferAmazonGateway {
  readonly physicalMutationGuardContract =
    "CALL_IMMEDIATELY_BEFORE_REQUEST_V1" as const;
  getCalls = 0;
  previewCalls = 0;
  applyCalls = 0;
  seenPatches: ListingPatch[][] = [];

  constructor(
    private readonly listings: ListingItem[],
    private readonly applyResponse: BaseOfferAmazonGatewayResponse = {
      status: "ACCEPTED",
      submissionId: "submission-1",
      issues: [],
    },
    private readonly callPhysicalGuard = true,
    private readonly throwAfterPhysicalGuard = false,
  ) {}

  async getListing(): Promise<ListingItem> {
    const listing = this.listings[Math.min(this.getCalls, this.listings.length - 1)];
    this.getCalls++;
    return clone(listing);
  }

  async patchListing(
    _storeIndex: number,
    _sku: string,
    _productType: string,
    patches: ListingPatch[],
    options: {
      validationPreview: boolean;
      beforeRequest?: (context: {
        store_index: number;
        marketplace_id: string;
        amazon_merchant_id: string;
      }) => void;
    },
  ): Promise<BaseOfferAmazonGatewayResponse> {
    this.seenPatches.push(clone(patches));
    if (options.validationPreview) {
      this.previewCalls++;
      return { status: "VALID", issues: [] };
    }
    this.applyCalls++;
    if (this.callPhysicalGuard) {
      options.beforeRequest?.({
        store_index: 1,
        marketplace_id: "ATVPDKIKX0DER",
        amazon_merchant_id: "A1TESTMERCHANT",
      });
    }
    if (this.throwAfterPhysicalGuard) throw new Error("lost response");
    return clone(this.applyResponse);
  }
}

async function checkpointStore(input: {
  fx: Fixture;
  mode: "VALIDATION_PREVIEW" | "APPLY";
  authorization?: BaseOfferLiveAuthorization | null;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubol-checkpoints-"));
  const digest = baseOfferExecutionBindingSha256({
    mode: input.mode,
    plan: input.fx.plan,
    fullSelection: input.fx.fullSelection,
    liveSelection: input.fx.liveSelection,
    rollbackBinding: input.fx.rollbackBinding,
    authorization: input.authorization,
  });
  return new ImmutableBaseOfferCheckpointStore(
    root,
    digest,
    path.join(root, "coordination"),
    () => RUNTIME_AT,
  );
}

test("first sealed canary is exactly LK and another first action is rejected", async () => {
  const fx = await fixture();
  assert.deepEqual(fx.liveSelection.selected_skus, ["LK-AS7X-K43B"]);
  assert.equal(fx.liveSelection.first_action_id, LK_FIRST_CANARY_ACTION_ID);
  assert.equal(fx.liveSelection.execution_authorized, false);
  const other = fx.plan.entries.find(
    (entry) => entry.action_id !== LK_FIRST_CANARY_ACTION_ID,
  );
  assert.ok(other);
  assert.throws(
    () =>
      createBaseOfferLiveSelection({
        plan: fx.plan,
        fullSelection: fx.fullSelection,
        kind: "CANARY",
        actionIds: [other.action_id],
      }),
    /first sealed base-offer canary must be exactly LK-AS7X-K43B/,
  );
});

test("fresh rollback binding covers exact LK inverse and rejects stale snapshot", async () => {
  const fx = await fixture();
  assert.equal(fx.rollbackBinding.snapshot.rows, 164);
  assert.equal(fx.rollbackBinding.entries.length, 1);
  assert.equal(fx.rollbackBinding.entries[0].sku, "LK-AS7X-K43B");
  const inverseBytes = stableJson(fx.rollbackBinding.entries[0].inverse_patch);
  assert.equal(inverseBytes.includes("discounted_price"), false);
  assert.equal(inverseBytes.includes("list_price"), false);
  assert.throws(
    () =>
      createBaseOfferRollbackBinding({
        plan: fx.plan,
        fullSelection: fx.fullSelection,
        liveSelection: fx.liveSelection,
        snapshotPath: SNAPSHOT_PATH,
        snapshotBytes: fx.snapshotBytes,
        snapshot: fx.snapshot,
        now: new Date("2026-07-19T04:00:00.000Z"),
      }),
    /snapshot is stale/,
  );
});

test("offline validation exposes no gateway or live arm path", async () => {
  const fx = await fixture();
  const result = await executeBaseOfferLive({
    plan: fx.plan,
    fullSelection: fx.fullSelection,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    snapshot: fx.snapshot,
    snapshotBytes: fx.snapshotBytes,
    now: () => RUNTIME_AT,
  });
  assert.equal(result.mode, "OFFLINE_VALIDATE");
  assert.equal(result.offline_validated_actions, 1);
  assert.equal(result.external_mutations_attempted, 0);
});

test("preview requires exact token+env and sends only replace surrogate", async () => {
  const fx = await fixture();
  const gateway = new MockGateway([fx.before, fx.before]);
  const store = await checkpointStore({ fx, mode: "VALIDATION_PREVIEW" });
  const token = baseOfferLiveArmToken({
    mode: "VALIDATION_PREVIEW",
    plan: fx.plan,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
  });
  await assert.rejects(
    executeBaseOfferLive({
      plan: fx.plan,
      fullSelection: fx.fullSelection,
      liveSelection: fx.liveSelection,
      rollbackBinding: fx.rollbackBinding,
      snapshot: fx.snapshot,
      snapshotBytes: fx.snapshotBytes,
      gateway,
      checkpointStore: store,
      mode: "VALIDATION_PREVIEW",
      confirmation: token,
      environment: {},
      now: () => RUNTIME_AT,
    }),
    /requires exact confirmation/,
  );
  assert.equal(gateway.getCalls, 0);
  const result = await executeBaseOfferLive({
    plan: fx.plan,
    fullSelection: fx.fullSelection,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    snapshot: fx.snapshot,
    snapshotBytes: fx.snapshotBytes,
    gateway,
    checkpointStore: store,
    mode: "VALIDATION_PREVIEW",
    confirmation: token,
    environment: { [BASE_OFFER_LIVE_ARM_ENV]: token },
    requestDelayMs: 200,
    readbackDelayMs: 200,
    now: () => RUNTIME_AT,
    sleep: async () => {},
  });
  assert.equal(result.preview_valid_actions, 1);
  assert.equal(result.external_mutations_attempted, 0);
  assert.equal(gateway.applyCalls, 0);
  assert.equal(gateway.seenPatches[0][0].op, "replace");
  assert.equal(stableJson(gateway.seenPatches).includes("discounted_price"), false);
  assert.equal(stableJson(gateway.seenPatches).includes("list_price"), false);
});

test("LK apply performs one sparse merge and requires two stable desired readbacks", async () => {
  const fx = await fixture();
  const auth = authorization(fx);
  const gateway = new MockGateway([
    fx.before,
    fx.before,
    fx.before,
    fx.desired,
    fx.desired,
  ]);
  const store = await checkpointStore({ fx, mode: "APPLY", authorization: auth });
  const token = baseOfferLiveArmToken({
    mode: "APPLY",
    plan: fx.plan,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    authorization: auth,
  });
  const result = await executeBaseOfferLive({
    plan: fx.plan,
    fullSelection: fx.fullSelection,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    snapshot: fx.snapshot,
    snapshotBytes: fx.snapshotBytes,
    authorization: auth,
    gateway,
    checkpointStore: store,
    mode: "APPLY",
    confirmation: token,
    environment: { [BASE_OFFER_LIVE_ARM_ENV]: token },
    requestDelayMs: 200,
    readbackAttempts: 4,
    readbackDelayMs: 200,
    stableReads: 2,
    now: () => RUNTIME_AT,
    sleep: async () => {},
  });
  assert.equal(result.submitted_actions, 1);
  assert.equal(result.verified_actions, 1);
  assert.equal(result.external_mutations_attempted, 1);
  assert.equal(gateway.previewCalls, 1);
  assert.equal(gateway.applyCalls, 1);
  assert.equal(gateway.seenPatches[1][0].op, "merge");
  assert.equal(stableJson(gateway.seenPatches[1]).includes("discounted_price"), false);
  assert.equal(stableJson(gateway.seenPatches[1]).includes("list_price"), false);
  const statuses = (await store.readEvents()).map((event) => event.status);
  assert.deepEqual(statuses, [
    "PREVIEW_VALID",
    "SUBMISSION_ARMED",
    "SUBMITTED",
    "READBACK_OBSERVED",
    "READBACK_OBSERVED",
    "VERIFIED",
  ]);
});

test("top-level list-price drift fails before preview PATCH", async () => {
  const fx = await fixture();
  const drifted = clone(fx.before);
  assert.ok(drifted.attributes);
  drifted.attributes.list_price = [
    { value: 999.99, currency: "USD", marketplace_id: "ATVPDKIKX0DER" },
  ];
  const gateway = new MockGateway([drifted]);
  const store = await checkpointStore({ fx, mode: "VALIDATION_PREVIEW" });
  const token = baseOfferLiveArmToken({
    mode: "VALIDATION_PREVIEW",
    plan: fx.plan,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
  });
  await assert.rejects(
    executeBaseOfferLive({
      plan: fx.plan,
      fullSelection: fx.fullSelection,
      liveSelection: fx.liveSelection,
      rollbackBinding: fx.rollbackBinding,
      snapshot: fx.snapshot,
      snapshotBytes: fx.snapshotBytes,
      gateway,
      checkpointStore: store,
      mode: "VALIDATION_PREVIEW",
      confirmation: token,
      environment: { [BASE_OFFER_LIVE_ARM_ENV]: token },
      now: () => RUNTIME_AT,
    }),
    /promo\/list preservation CAS failed/,
  );
  assert.equal(gateway.previewCalls, 0);
  assert.deepEqual((await store.readEvents()).map((event) => event.status), [
    "FAILED_BEFORE_SUBMISSION",
  ]);
});

test("top-level B2B drift fails CAS before preview PATCH", async () => {
  const fx = await fixture();
  const drifted = clone(fx.before);
  const b2b = (drifted.offers as Array<Record<string, unknown>>).find(
    (offer) => offer.offerType === "B2B",
  );
  assert.ok(b2b);
  b2b.price = { currency: "USD", currencyCode: "USD", amount: "999.99" };
  const gateway = new MockGateway([drifted]);
  const store = await checkpointStore({ fx, mode: "VALIDATION_PREVIEW" });
  const token = baseOfferLiveArmToken({
    mode: "VALIDATION_PREVIEW",
    plan: fx.plan,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
  });
  await assert.rejects(
    executeBaseOfferLive({
      plan: fx.plan,
      fullSelection: fx.fullSelection,
      liveSelection: fx.liveSelection,
      rollbackBinding: fx.rollbackBinding,
      snapshot: fx.snapshot,
      snapshotBytes: fx.snapshotBytes,
      gateway,
      checkpointStore: store,
      mode: "VALIDATION_PREVIEW",
      confirmation: token,
      environment: { [BASE_OFFER_LIVE_ARM_ENV]: token },
      now: () => RUNTIME_AT,
    }),
    /CAS failed: top-level B2B offer drifted/,
  );
  assert.equal(gateway.previewCalls, 0);
});

test("lost response after physical guard is AMBIGUOUS and cannot replay", async () => {
  const fx = await fixture();
  const auth = authorization(fx);
  const gateway = new MockGateway(
    [fx.before, fx.before, fx.before],
    { status: "ACCEPTED" },
    true,
    true,
  );
  const store = await checkpointStore({ fx, mode: "APPLY", authorization: auth });
  const token = baseOfferLiveArmToken({
    mode: "APPLY",
    plan: fx.plan,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    authorization: auth,
  });
  const options = {
    plan: fx.plan,
    fullSelection: fx.fullSelection,
    liveSelection: fx.liveSelection,
    rollbackBinding: fx.rollbackBinding,
    snapshot: fx.snapshot,
    snapshotBytes: fx.snapshotBytes,
    authorization: auth,
    gateway,
    checkpointStore: store,
    mode: "APPLY" as const,
    confirmation: token,
    environment: { [BASE_OFFER_LIVE_ARM_ENV]: token },
    requestDelayMs: 200,
    readbackDelayMs: 200,
    now: () => RUNTIME_AT,
    sleep: async () => {},
  };
  await assert.rejects(executeBaseOfferLive(options), /lost response/);
  const statuses = (await store.readEvents()).map((event) => event.status);
  assert.deepEqual(statuses, [
    "PREVIEW_VALID",
    "SUBMISSION_ARMED",
    "AMBIGUOUS",
  ]);
  const callsBeforeReplay = gateway.getCalls;
  await assert.rejects(executeBaseOfferLive(options), /Checkpoint state blocks replay/);
  assert.equal(gateway.getCalls, callsBeforeReplay);
  assert.equal(gateway.applyCalls, 1);
});
