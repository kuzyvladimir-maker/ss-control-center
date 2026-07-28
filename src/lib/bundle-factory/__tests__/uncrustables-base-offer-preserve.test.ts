// node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-base-offer-preserve.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { ListingItem, ListingPatch } from "../../amazon-sp-api/listings";
import {
  BASE_OFFER_PATH,
  BASE_OFFER_PRESERVE_PROFILE,
  assertBaseOfferPreservePatch,
  assertBaseOfferPreservePlan,
  assertBaseOfferPreserveSelection,
  buildBaseOfferPreservePreviewSet,
  sha256,
  stableJson,
  type BaseOfferPreservePlan,
  type BaseOfferPreserveSelection,
} from "../repair/uncrustables-base-offer-preserve";

const ARTIFACT_DIR =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3";
const PLAN_PATH = `${ARTIFACT_DIR}/base-offer-preserve-plan.json`;
const SELECTION_PATH = `${ARTIFACT_DIR}/base-offer-preserve-selection.json`;
const REPORT_PATH = `${ARTIFACT_DIR}/offline-validation-report.json`;
const SNAPSHOT_PATH =
  "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/" +
  "UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json";

async function load<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("sealed plan and selection cover exactly 161 actions plus 3 identity holds", async () => {
  const [plan, selection] = await Promise.all([
    load<BaseOfferPreservePlan>(PLAN_PATH),
    load<BaseOfferPreserveSelection>(SELECTION_PATH),
  ]);
  assert.equal(assertBaseOfferPreservePlan(plan), plan);
  assert.equal(assertBaseOfferPreserveSelection(plan, selection), selection);
  assert.equal(plan.profile, BASE_OFFER_PRESERVE_PROFILE);
  assert.equal(plan.entries.length, 161);
  assert.equal(plan.holds.length, 3);
  assert.deepEqual(
    plan.holds.map((hold) => hold.sku),
    ["SZ-ASPI-JFAT", "TY-AST2-JE9P", "VN-AS1A-D572"],
  );
  assert.ok(plan.holds.every((hold) => hold.action_id === null && hold.patch === null));
  assert.deepEqual(selection.selected_action_ids, plan.entries.map((entry) => entry.action_id));
  assert.equal(new Set(selection.selected_action_ids).size, 161);
});

test("every actual patch is sparse, selector-safe, and structurally omits promo/list", async () => {
  const plan = await load<BaseOfferPreservePlan>(PLAN_PATH);
  for (const entry of plan.entries) {
    assert.doesNotThrow(() => assertBaseOfferPreservePatch(entry.actual_patch));
    assert.equal(entry.actual_patch.op, "merge");
    assert.equal(entry.actual_patch.path, BASE_OFFER_PATH);
    const patchBytes = stableJson(entry.actual_patch);
    assert.equal(patchBytes.includes("discounted_price"), false);
    assert.equal(patchBytes.includes("list_price"), false);
    assert.equal(
      entry.before.discounted_price.canonical_json,
      entry.simulated_after.discounted_price.canonical_json,
    );
    assert.equal(
      entry.before.list_price.canonical_json,
      entry.simulated_after.list_price.canonical_json,
    );
  }
  assert.equal(
    plan.entries.filter((entry) => entry.before.list_price.present).length,
    159,
  );
});

test("patch validator rejects discounted_price, list_price, unknown members, and nulls", () => {
  const baseSelector = {
    marketplace_id: "ATVPDKIKX0DER",
    currency: "USD",
    audience: "ALL",
    our_price: [{ schedule: [{ value_with_tax: 76.99 }] }],
  };
  const patch = (selector: Record<string, unknown>): ListingPatch => ({
    op: "merge",
    path: BASE_OFFER_PATH,
    value: [selector],
  });
  assert.doesNotThrow(() => assertBaseOfferPreservePatch(patch(baseSelector)));
  assert.throws(
    () =>
      assertBaseOfferPreservePatch(
        patch({ ...baseSelector, discounted_price: [{ schedule: [] }] }),
      ),
    /discounted_price is structurally forbidden/,
  );
  assert.throws(
    () => assertBaseOfferPreservePatch(patch({ ...baseSelector, list_price: [] })),
    /list_price is structurally forbidden/,
  );
  assert.throws(
    () => assertBaseOfferPreservePatch(patch({ ...baseSelector, quantity: 100 })),
    /ALL.quantity is out of scope/,
  );
  assert.throws(
    () => assertBaseOfferPreservePatch(patch({ ...baseSelector, our_price: null })),
    /ALL.our_price cannot be null/,
  );
});

test("offline preview is CAS-bound and preserves active Sales Price/list price exactly", async () => {
  const [plan, snapshot] = await Promise.all([
    load<BaseOfferPreservePlan>(PLAN_PATH),
    load<{ entries: Array<{ sku: string; listing: ListingItem }> }>(SNAPSHOT_PATH),
  ]);
  const entry = plan.entries.find((candidate) => candidate.before.discounted_price.present);
  assert.ok(entry, "fixture must include an active discounted_price schedule");
  const listing = snapshot.entries.find((candidate) => candidate.sku === entry.sku)?.listing;
  assert.ok(listing);
  const preview = buildBaseOfferPreservePreviewSet(entry, listing);
  assert.equal(preview.actual_merge_patch.op, "merge");
  assert.equal(preview.validation_preview_patch.op, "replace");
  assert.deepEqual(
    preview.validation_preview_patch.value,
    preview.actual_merge_patch.value,
  );
  assert.equal(
    preview.simulated_after_sha256,
    entry.simulated_after.purchasable_offer_sha256,
  );

  const drifted = clone(listing);
  const offers = drifted.attributes?.purchasable_offer as Array<Record<string, unknown>>;
  const all = offers.find((offer) => offer.audience === "ALL");
  assert.ok(all);
  all.discounted_price = [{ schedule: [{ value_with_tax: 1.23 }] }];
  assert.throws(
    () => buildBaseOfferPreservePreviewSet(entry, drifted),
    /CAS failed: purchasable_offer drifted/,
  );

  const driftedList = clone(listing);
  assert.ok(driftedList.attributes);
  driftedList.attributes.list_price = [
    { value: 999.99, currency: "USD", marketplace_id: "ATVPDKIKX0DER" },
  ];
  assert.throws(
    () => buildBaseOfferPreservePreviewSet(entry, driftedList),
    /CAS failed: list_price drifted/,
  );

  const driftedB2B = clone(listing);
  const topLevelOffers = driftedB2B.offers as Array<Record<string, unknown>>;
  const b2b = topLevelOffers.find((offer) => offer.offerType === "B2B");
  assert.ok(b2b);
  b2b.price = { currency: "USD", currencyCode: "USD", amount: "999.99" };
  assert.throws(
    () => buildBaseOfferPreservePreviewSet(entry, driftedB2B),
    /CAS failed: top-level B2B offer drifted/,
  );
});

test("plan/selection authority and seals fail closed on tampering", async () => {
  const [plan, selection] = await Promise.all([
    load<BaseOfferPreservePlan>(PLAN_PATH),
    load<BaseOfferPreserveSelection>(SELECTION_PATH),
  ]);
  assert.equal(plan.execution_authorized, false);
  assert.equal(plan.authority.promo_v4_reused_as_authority, false);
  assert.equal(plan.authority.coupon_or_sales_price_action_authorized, false);
  assert.equal(selection.execution_authorized, false);

  const tamperedPlan = clone(plan);
  tamperedPlan.entries[0].actual_patch.value[0].discounted_price = null;
  assert.throws(() => assertBaseOfferPreservePlan(tamperedPlan), /seal is invalid/);

  const tamperedSelection = clone(selection);
  tamperedSelection.selected_action_ids.pop();
  assert.throws(
    () => assertBaseOfferPreserveSelection(plan, tamperedSelection),
    /seal is invalid/,
  );
});

test("offline validation artifact proves 161/161 preservation with zero external calls", async () => {
  const report = await load<{
    body_sha256: string;
    summary: Record<string, number | boolean>;
    rows: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>(REPORT_PATH);
  const body: Record<string, unknown> = clone(report);
  delete body.body_sha256;
  assert.equal(report.body_sha256, sha256(stableJson(body)));
  assert.equal(report.rows.length, 161);
  assert.equal(report.summary.cas_against_fresh_snapshot_pass, 161);
  assert.equal(report.summary.discounted_price_canonical_preservation_pass, 161);
  assert.equal(report.summary.list_price_canonical_preservation_pass, 161);
  assert.equal(report.summary.amazon_validation_preview_calls, 0);
  assert.equal(report.summary.amazon_mutations, 0);
  assert.equal(report.summary.channelmax_mutations, 0);
});

test("artifact sidecars match exact plan and selection bytes", async () => {
  for (const filePath of [PLAN_PATH, SELECTION_PATH, REPORT_PATH]) {
    const [bytes, sidecar] = await Promise.all([
      readFile(filePath),
      readFile(`${filePath}.sha256`, "utf8"),
    ]);
    assert.equal(sidecar.split(/\s+/)[0], sha256(bytes));
  }
});
