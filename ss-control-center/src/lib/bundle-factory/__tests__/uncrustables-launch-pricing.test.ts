// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-launch-pricing.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UNCRUSTABLES_COUPON_GROUP_POLICIES,
  UNCRUSTABLES_LAUNCH_COHORT_ROWS,
  UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
  UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION,
  launchPricingManifestBodySha256,
  launchPricingRowsBySku,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingExclusion,
  type UncrustablesLaunchPricingManifest,
} from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";
import { priceFor } from "@/lib/pricing/cost-model";

function fixturePreAssignmentExclusions(
  experimentRows: number,
): UncrustablesLaunchPricingExclusion[] {
  const count = UNCRUSTABLES_LAUNCH_COHORT_ROWS - experimentRows;
  assert.ok(count >= 1);
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? { ...UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION }
      : {
          sku: `PRE-TEST-${String(index).padStart(3, "0")}`,
          asin: `B0Z${String(index).padStart(7, "0")}`,
          reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
        },
  );
}

function manifestFixture(): UncrustablesLaunchPricingManifest {
  const rows = UNCRUSTABLES_COUPON_GROUP_POLICIES.flatMap((group) => {
    const canonical = priceFor(group.count);
    assert.ok(canonical);
    const effective =
      Math.round(canonical.suggested * (1 - group.discount_percent / 100) * 100) /
      100;
    const code = String(group.count).padStart(3, "0");
    const couponIdentity = group.count === 24
      ? { sku: "AA-ASAA-AAAA", asin: "B000TEST01" }
      : { sku: `AA-${code}-AAAA`, asin: `B0${code}A0001` };
    const saleIdentity = group.count === 24
      ? { sku: "BB-ASBB-BBBB", asin: "B000TEST02" }
      : { sku: `BB-${code}-BBBB`, asin: `B0${code}B0001` };
    return [
      {
        ...couponIdentity,
        count: group.count,
        arm: "A" as const,
        lever: `COUPON_${group.discount_percent}` as const,
        base_price: canonical.suggested,
        floor_price: canonical.floor,
        effective_price: effective,
        discount_percent: group.discount_percent,
        sale_price_schedule: null,
      },
      {
        ...saleIdentity,
        count: group.count,
        arm: "B" as const,
        lever: `SALEPRICE_${group.discount_percent}` as const,
        base_price: canonical.suggested,
        floor_price: canonical.floor,
        effective_price: effective,
        discount_percent: group.discount_percent,
        sale_price_schedule: {
          value_with_tax: effective,
          start_at: "2026-07-20T00:00:00.000Z",
          end_at: "2026-08-19T23:59:59.000Z",
        },
      },
    ];
  });
  const body: Omit<UncrustablesLaunchPricingManifest, "body_sha256"> = {
    schema_version: UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
    immutable: true,
    reviewed_at: "2026-07-18T16:15:00.000Z",
    decision: {
      original_owner_decision_date: "2026-07-13",
      revision_status: "PROPOSED_OWNER_APPROVAL_REQUIRED",
      revision_prepared_at: "2026-07-18T16:15:00.000Z",
      owner_approved_at: null,
      changes: {
        count_45_discount_percent_from_13_to_12: true,
        synchronized_window_rebased: true,
        unsafe_historical_coupon_titles_replaced: true,
        coupon_budget_and_targeting_sealed: true,
      },
    },
    source_artifacts: {
      assignments: { path: "/tmp/assignments.csv", sha256: "a".repeat(64), rows: 10 },
      coupon_spec: { path: "/tmp/coupons.csv", sha256: "b".repeat(64), rows: 5 },
      sale_price_spec: { path: "/tmp/sales.csv", sha256: "c".repeat(64), rows: 5 },
    },
    policy: {
      experiment: "BALANCED_COUPON_VS_SALE_PRICE",
      base_price_immutable: true,
      list_price_absent: true,
      effective_price_not_below_floor: true,
      equal_effective_price_within_count_tier: true,
      maximum_discount_percent: 13,
      excluded_identity_conflicts_not_publishable: true,
      owner_approval_required_for_execution: true,
      coupon_budget_is_not_a_hard_spend_cap_acknowledged: true,
    },
    coupon_controls: {
      group_count: 5,
      total_budget_usd: 1150,
      groups: UNCRUSTABLES_COUPON_GROUP_POLICIES.map((group) => ({
        ...group,
        asin_count: 1,
        limit_one_per_customer: true,
        targeted_segment: "All customers",
      })),
    },
    exclusions: [],
    pre_assignment_exclusions: fixturePreAssignmentExclusions(rows.length),
    scope: {
      cohort_rows: UNCRUSTABLES_LAUNCH_COHORT_ROWS,
      rows: 10,
      coupon_rows: 5,
      sale_price_rows: 5,
      excluded_rows: 0,
      pre_assignment_excluded_rows:
        UNCRUSTABLES_LAUNCH_COHORT_ROWS - rows.length,
      active_rows: 10,
      active_coupon_rows: 5,
      active_sale_price_rows: 5,
      start_at: "2026-07-20T00:00:00.000Z",
      end_at: "2026-08-19T23:59:59.000Z",
    },
    rows,
  };
  return { ...body, body_sha256: launchPricingManifestBodySha256(body) };
}

function reseal(
  manifest: UncrustablesLaunchPricingManifest,
): UncrustablesLaunchPricingManifest {
  return {
    ...manifest,
    body_sha256: launchPricingManifestBodySha256(manifest),
  };
}

test("launch pricing verifies exact coupon/Sale Price parity and indexes by SKU", () => {
  const manifest = manifestFixture();
  assert.equal(verifyUncrustablesLaunchPricingManifest(manifest), manifest);
  const rows = launchPricingRowsBySku(manifest);
  assert.equal(rows.get("AA-ASAA-AAAA")?.sale_price_schedule, null);
  assert.equal(
    rows.get("BB-ASBB-BBBB")?.sale_price_schedule?.value_with_tax,
    66.98,
  );
});

test("launch pricing rejects a below-floor 45-count 13% overlay", () => {
  const manifest = manifestFixture();
  for (const row of manifest.rows) {
    row.count = 45;
    row.base_price = 130.99;
    row.floor_price = 114.27;
    row.effective_price = 113.96;
    row.discount_percent = 13;
    row.lever = row.arm === "A" ? "COUPON_13" : "SALEPRICE_13";
    if (row.sale_price_schedule) row.sale_price_schedule.value_with_tax = 113.96;
  }
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(manifest)),
    /unsafe or non-reviewed effective price/,
  );
});

test("launch pricing rejects mismatched exposure and tampered digests", () => {
  const manifest = manifestFixture();
  manifest.rows[1].effective_price = 67.99;
  if (manifest.rows[1].sale_price_schedule) {
    manifest.rows[1].sale_price_schedule.value_with_tax = 67.99;
  }
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(manifest)),
    /unsafe or non-reviewed effective price|not exposure-matched/,
  );

  const digestTamper = manifestFixture();
  digestTamper.rows[0].sku = "ZZ-ASZZ-ZZZZ";
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(digestTamper),
    /body SHA-256/,
  );
});

test("launch pricing seals coupon budgets, audience, and redemption control", () => {
  const wrongBudget = manifestFixture();
  wrongBudget.coupon_controls.groups[2].budget_usd = 181;
  wrongBudget.coupon_controls.total_budget_usd = 1151 as 1150;
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(wrongBudget)),
    /coupon group controls|coupon controls/,
  );

  const wrongAudience = manifestFixture();
  wrongAudience.coupon_controls.groups[0].targeted_segment =
    "Some customers" as "All customers";
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(wrongAudience)),
    /coupon controls/,
  );

  const unlimitedRedemptions = manifestFixture();
  unlimitedRedemptions.coupon_controls.groups[0].limit_one_per_customer =
    false as true;
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(unlimitedRedemptions)),
    /coupon controls/,
  );
});

test("launch pricing explicitly reconciles pre-assignment exclusions into the 164-SKU cohort", () => {
  const manifest = manifestFixture();
  assert.deepEqual(
    manifest.pre_assignment_exclusions[0],
    UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION,
  );
  assert.equal(
    manifest.scope.cohort_rows,
    manifest.scope.active_rows +
      manifest.scope.excluded_rows +
      manifest.scope.pre_assignment_excluded_rows,
  );

  const missingVn = manifestFixture();
  missingVn.pre_assignment_exclusions[0] = {
    sku: "PRE-MISSING-VN",
    asin: "B0Z9999999",
    reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
  };
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(missingVn)),
    /explicitly account for VN-AS1A-D572/,
  );

  const overlapsExperiment = manifestFixture();
  overlapsExperiment.pre_assignment_exclusions[0] = {
    ...overlapsExperiment.pre_assignment_exclusions[0],
    sku: overlapsExperiment.rows[0].sku,
  };
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(overlapsExperiment)),
    /overlaps an experiment row/,
  );

  const inconsistentScope = manifestFixture();
  inconsistentScope.scope.pre_assignment_excluded_rows--;
  assert.throws(
    () => verifyUncrustablesLaunchPricingManifest(reseal(inconsistentScope)),
    /scope\/source row counts are inconsistent/,
  );
});
