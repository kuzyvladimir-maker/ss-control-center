import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { priceFor } from "@/lib/pricing/cost-model";
import {
  UNCRUSTABLES_COUPON_GROUP_POLICIES,
  UNCRUSTABLES_LAUNCH_COHORT_ROWS,
  UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
  UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION,
  launchPricingManifestBodySha256,
  type UncrustablesLaunchPricingExclusion,
  type UncrustablesLaunchPricingManifest,
} from "../repair/uncrustables-launch-pricing";
import {
  UNCRUSTABLES_CHANNELMAX_POST_UPLOAD_EVIDENCE_SCHEMA,
  UNCRUSTABLES_COUPON_ACTIVATION_EVIDENCE_SCHEMA,
  UNCRUSTABLES_LAUNCH_EXECUTION_AUTHORIZATION_SCHEMA,
  launchExecutionAuthorizationBodySha256,
  launchExecutionEvidenceBodySha256,
  verifyUncrustablesLaunchExecutionAuthorization,
  verifyUncrustablesLaunchExecutionEvidenceBytes,
  type UncrustablesLaunchExecutionAuthorization,
} from "../repair/uncrustables-launch-execution-authorization";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function evidenceBytes(body: Record<string, unknown>): Buffer {
  const document = {
    ...body,
    body_sha256: launchExecutionEvidenceBodySha256(body),
  };
  return Buffer.from(JSON.stringify(document));
}

function fixture() {
  const launchRows = UNCRUSTABLES_COUPON_GROUP_POLICIES.flatMap((group) => {
    const canonical = priceFor(group.count);
    assert.ok(canonical);
    const effective =
      Math.round(canonical.suggested * (1 - group.discount_percent / 100) * 100) /
      100;
    const code = String(group.count).padStart(3, "0");
    return [
      {
        sku: `AA-${code}-AAAA`,
        asin: `B0${code}A0001`,
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
        sku: `BB-${code}-BBBB`,
        asin: `B0${code}B0001`,
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
  const launchBody: Omit<UncrustablesLaunchPricingManifest, "body_sha256"> = {
    schema_version: UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
    immutable: true,
    reviewed_at: "2026-07-18T16:30:00.000Z",
    decision: {
      original_owner_decision_date: "2026-07-13",
      revision_status: "OWNER_APPROVED",
      revision_prepared_at: "2026-07-18T16:30:00.000Z",
      owner_approved_at: "2026-07-18T16:31:00.000Z",
      changes: {
        count_45_discount_percent_from_13_to_12: true,
        synchronized_window_rebased: true,
        unsafe_historical_coupon_titles_replaced: true,
        coupon_budget_and_targeting_sealed: true,
      },
    },
    source_artifacts: {
      assignments: { path: "/tmp/a.csv", sha256: "a".repeat(64), rows: 10 },
      coupon_spec: { path: "/tmp/c.csv", sha256: "b".repeat(64), rows: 5 },
      sale_price_spec: { path: "/tmp/s.csv", sha256: "c".repeat(64), rows: 5 },
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
    pre_assignment_exclusions:
      fixturePreAssignmentExclusions(launchRows.length),
    scope: {
      cohort_rows: UNCRUSTABLES_LAUNCH_COHORT_ROWS,
      rows: 10,
      coupon_rows: 5,
      sale_price_rows: 5,
      excluded_rows: 0,
      pre_assignment_excluded_rows:
        UNCRUSTABLES_LAUNCH_COHORT_ROWS - launchRows.length,
      active_rows: 10,
      active_coupon_rows: 5,
      active_sale_price_rows: 5,
      start_at: "2026-07-20T00:00:00.000Z",
      end_at: "2026-08-19T23:59:59.000Z",
    },
    rows: launchRows,
  };
  const launchManifest: UncrustablesLaunchPricingManifest = {
    ...launchBody,
    body_sha256: launchPricingManifestBodySha256(launchBody),
  };
  const planSha256 = "d".repeat(64);
  const selectionSha256 = "e".repeat(64);
  const launchSourceSha256 = "f".repeat(64);
  const authorizationBody: Omit<
    UncrustablesLaunchExecutionAuthorization,
    "body_sha256"
  > = {
    schema_version: UNCRUSTABLES_LAUNCH_EXECUTION_AUTHORIZATION_SCHEMA,
    immutable: true,
    created_at: "2026-07-18T17:00:00.000Z",
    expires_at: "2026-07-18T17:30:00.000Z",
    source_plan_sha256: planSha256,
    execution_selection_sha256: selectionSha256,
    account: {
      store_index: 1,
      marketplace_id: "ATVPDKIKX0DER",
      amazon_merchant_id: "A1TESTMERCHANT",
      channelmax_account_id: "salutem-test",
    },
    launch_pricing: {
      source_sha256: launchSourceSha256,
      body_sha256: launchManifest.body_sha256,
    },
    channelmax: {
      source_export: { path: "/tmp/cm-export.json", sha256: "1".repeat(64) },
      assignment_upload: { path: "/tmp/cm-upload.txt", sha256: "2".repeat(64) },
      upload_task_id: "CM-TASK-1",
      upload_status: "COMPLETED",
      upload_completed_at: "2026-07-18T15:50:00.000Z",
      verified_at: "2026-07-18T17:00:00.000Z",
      manual_model_id: "59021",
      manual_model_name: "Manual",
      rule_44a_skip_repricing: true,
      rule_44b_skip_repricing: true,
      amazon_is_only_price_writer: true,
      bounds_are_guardrails_not_base_price_authority: true,
      active_rows: launchRows.length,
      rows: launchRows.map((row) => ({
        sku: row.sku,
        asin: row.asin,
        repricing_model_id: "59021",
        repricing_model_name: "Manual",
        repricing_mode: "MANUAL" as const,
        observed_base_price: row.base_price,
        minimum_selling_price: row.floor_price,
        maximum_selling_price: row.base_price,
      })),
    },
    coupons: {
      source_evidence: { path: "/tmp/coupons.json", sha256: "3".repeat(64) },
      verified_at: "2026-07-18T17:00:00.000Z",
      active_and_scheduled_account_scope_checked: true,
      active_rows: 5,
      groups: UNCRUSTABLES_COUPON_GROUP_POLICIES.map((group) => ({
        ...group,
        asin_count: 1,
        limit_one_per_customer: true,
        targeted_segment: "All customers",
        coupon_id: `coupon-${group.count}`,
        normalized_status: "SCHEDULED",
        raw_status: "Scheduled",
        start_at: launchManifest.scope.start_at,
        end_at: launchManifest.scope.end_at,
      })),
      rows: launchRows
        .filter((row) => row.arm === "A")
        .map((row) => ({
          asin: row.asin,
          count: row.count,
          discount_percent: row.discount_percent,
          coupon_id: `coupon-${row.count}`,
          active_or_scheduled_coupon_ids: [
            `coupon-${row.count}`,
          ] as [string],
          normalized_status: "SCHEDULED" as const,
          raw_status: "Scheduled",
          start_at: launchManifest.scope.start_at,
          end_at: launchManifest.scope.end_at,
        })),
      arm_b_absence_rows: launchRows
        .filter((row) => row.arm === "B")
        .map((row) => ({
          asin: row.asin,
          count: row.count,
          active_or_scheduled_coupon_ids: [] as [],
        })),
    },
  };
  const authorization: UncrustablesLaunchExecutionAuthorization = {
    ...authorizationBody,
    body_sha256: launchExecutionAuthorizationBodySha256(authorizationBody),
  };
  const channelMaxSourceExport = evidenceBytes({
    schema_version: UNCRUSTABLES_CHANNELMAX_POST_UPLOAD_EVIDENCE_SCHEMA,
    immutable: true,
    account: authorization.account,
    verified_at: authorization.channelmax.verified_at,
    upload_task_id: authorization.channelmax.upload_task_id,
    upload_status: authorization.channelmax.upload_status,
    upload_completed_at: authorization.channelmax.upload_completed_at,
    manual_model_id: authorization.channelmax.manual_model_id,
    manual_model_name: authorization.channelmax.manual_model_name,
    rule_44a_skip_repricing: authorization.channelmax.rule_44a_skip_repricing,
    rule_44b_skip_repricing: authorization.channelmax.rule_44b_skip_repricing,
    amazon_is_only_price_writer:
      authorization.channelmax.amazon_is_only_price_writer,
    bounds_are_guardrails_not_base_price_authority:
      authorization.channelmax.bounds_are_guardrails_not_base_price_authority,
    active_rows: authorization.channelmax.active_rows,
    rows: authorization.channelmax.rows,
  });
  const sortedRows = [...launchRows].sort((left, right) =>
    left.sku.localeCompare(right.sku),
  );
  const channelMaxAssignmentUpload = Buffer.from(
    `${[
      [
        "SKU",
        "ASIN",
        "SellingVenue",
        "MinSellingPrice",
        "MaxSellingPrice",
        "RepricingModelID",
      ].join("\t"),
      ...sortedRows.map((row) =>
        [
          row.sku,
          row.asin,
          "AmazonUS",
          row.floor_price.toFixed(2),
          row.base_price.toFixed(2),
          authorization.channelmax.manual_model_id,
        ].join("\t"),
      ),
    ].join("\r\n")}\r\n`,
  );
  const couponSourceEvidence = evidenceBytes({
    schema_version: UNCRUSTABLES_COUPON_ACTIVATION_EVIDENCE_SCHEMA,
    immutable: true,
    account: authorization.account,
    verified_at: authorization.coupons.verified_at,
    active_and_scheduled_account_scope_checked:
      authorization.coupons.active_and_scheduled_account_scope_checked,
    active_rows: authorization.coupons.active_rows,
    groups: authorization.coupons.groups,
    rows: authorization.coupons.rows,
    arm_b_absence_rows: authorization.coupons.arm_b_absence_rows,
  });
  authorization.channelmax.source_export.sha256 = digest(channelMaxSourceExport);
  authorization.channelmax.assignment_upload.sha256 = digest(
    channelMaxAssignmentUpload,
  );
  authorization.coupons.source_evidence.sha256 = digest(couponSourceEvidence);
  authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    authorization,
  );
  const evidence = {
    channelmax_source_export: channelMaxSourceExport,
    channelmax_assignment_upload: channelMaxAssignmentUpload,
    coupon_source_evidence: couponSourceEvidence,
  };
  return {
    launchManifest,
    planSha256,
    selectionSha256,
    launchSourceSha256,
    authorization,
    evidence,
  };
}

function reseal(value: ReturnType<typeof fixture>): void {
  value.launchManifest.body_sha256 = launchPricingManifestBodySha256(
    value.launchManifest,
  );
  value.authorization.launch_pricing.body_sha256 =
    value.launchManifest.body_sha256;
  value.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    value.authorization,
  );
}

test("launch execution authorization requires exact Manual ChannelMAX and coupon scope", () => {
  const value = fixture();
  assert.equal(
    verifyUncrustablesLaunchExecutionAuthorization(value.authorization, {
      planSha256: value.planSha256,
      executionSelectionSha256: value.selectionSha256,
      launchPricingSourceSha256: value.launchSourceSha256,
      launchPricingManifest: value.launchManifest,
      now: new Date("2026-07-18T17:15:00.000Z"),
    }),
    value.authorization,
  );
});

test("launch execution authorization rejects active repricing and missing coupons", () => {
  const active = fixture();
  active.authorization.channelmax.rows[0].repricing_mode = "ACTIVE" as "MANUAL";
  active.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    active.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(active.authorization, {
        planSha256: active.planSha256,
        executionSelectionSha256: active.selectionSha256,
        launchPricingSourceSha256: active.launchSourceSha256,
        launchPricingManifest: active.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /ChannelMAX evidence/,
  );

  const missingCoupon = fixture();
  missingCoupon.authorization.coupons.rows.pop();
  missingCoupon.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(missingCoupon.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        missingCoupon.authorization,
        {
          planSha256: missingCoupon.planSha256,
          executionSelectionSha256: missingCoupon.selectionSha256,
          launchPricingSourceSha256: missingCoupon.launchSourceSha256,
          launchPricingManifest: missingCoupon.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /exact active Arm A scope/,
  );
});

test("ChannelMAX observed base price must equal the canonical launch base", () => {
  const staleBase = fixture();
  staleBase.authorization.channelmax.rows[0].observed_base_price += 0.65;
  staleBase.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(staleBase.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        staleBase.authorization,
        {
          planSha256: staleBase.planSha256,
          executionSelectionSha256: staleBase.selectionSha256,
          launchPricingSourceSha256: staleBase.launchSourceSha256,
          launchPricingManifest: staleBase.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /ChannelMAX evidence/,
  );
});

test("launch execution authorization expires closed and is selection-bound", () => {
  const value = fixture();
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(value.authorization, {
        planSha256: value.planSha256,
        executionSelectionSha256: "0".repeat(64),
        launchPricingSourceSha256: value.launchSourceSha256,
        launchPricingManifest: value.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /different sealed inputs/,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(value.authorization, {
        planSha256: value.planSha256,
        executionSelectionSha256: value.selectionSha256,
        launchPricingSourceSha256: value.launchSourceSha256,
        launchPricingManifest: value.launchManifest,
        now: new Date("2026-07-18T17:30:00.000Z"),
      }),
    /not current/,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(value.authorization, {
        planSha256: value.planSha256,
        executionSelectionSha256: value.selectionSha256,
        launchPricingSourceSha256: value.launchSourceSha256,
        launchPricingManifest: value.launchManifest,
        now: new Date("2026-07-18T17:15:00.001Z"),
      }),
    /ChannelMAX launch-control evidence is incomplete/,
  );
});

test("launch execution authorization rejects future approval and coupon overlap", () => {
  const futureApproval = fixture();
  futureApproval.launchManifest.decision.owner_approved_at =
    "2026-07-18T17:10:00.000Z";
  reseal(futureApproval);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        futureApproval.authorization,
        {
          planSha256: futureApproval.planSha256,
          executionSelectionSha256: futureApproval.selectionSha256,
          launchPricingSourceSha256: futureApproval.launchSourceSha256,
          launchPricingManifest: futureApproval.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /must exist before authorization creation/,
  );

  const overlap = fixture();
  overlap.authorization.coupons.arm_b_absence_rows[0]
    .active_or_scheduled_coupon_ids = ["unexpected-coupon"] as unknown as [];
  overlap.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    overlap.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(overlap.authorization, {
        planSha256: overlap.planSha256,
        executionSelectionSha256: overlap.selectionSha256,
        launchPricingSourceSha256: overlap.launchSourceSha256,
        launchPricingManifest: overlap.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /Coupon absence evidence/,
  );
});

test("launch execution authorization closes expired scope and stale coupon evidence", () => {
  const expired = fixture();
  expired.launchManifest.scope.start_at = "2026-07-18T16:00:00.000Z";
  expired.launchManifest.scope.end_at = "2026-07-18T17:15:00.000Z";
  for (const row of expired.launchManifest.rows) {
    if (row.sale_price_schedule) {
      row.sale_price_schedule.start_at = expired.launchManifest.scope.start_at;
      row.sale_price_schedule.end_at = expired.launchManifest.scope.end_at;
    }
  }
  for (const group of expired.authorization.coupons.groups) {
    group.start_at = expired.launchManifest.scope.start_at;
    group.end_at = expired.launchManifest.scope.end_at;
  }
  for (const row of expired.authorization.coupons.rows) {
    row.start_at = expired.launchManifest.scope.start_at;
    row.end_at = expired.launchManifest.scope.end_at;
  }
  reseal(expired);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(expired.authorization, {
        planSha256: expired.planSha256,
        executionSelectionSha256: expired.selectionSha256,
        launchPricingSourceSha256: expired.launchSourceSha256,
        launchPricingManifest: expired.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /schedule has expired/,
  );

  const staleCoupon = fixture();
  staleCoupon.authorization.created_at = "2026-07-18T17:14:00.000Z";
  staleCoupon.authorization.channelmax.verified_at =
    "2026-07-18T17:14:00.000Z";
  staleCoupon.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(staleCoupon.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        staleCoupon.authorization,
        {
          planSha256: staleCoupon.planSha256,
          executionSelectionSha256: staleCoupon.selectionSha256,
          launchPricingSourceSha256: staleCoupon.launchSourceSha256,
          launchPricingManifest: staleCoupon.launchManifest,
          now: new Date("2026-07-18T17:15:00.001Z"),
        },
      ),
    /Coupon activation evidence is incomplete/,
  );
});

test("ordinary launch writes close exactly at synchronized start", () => {
  const started = fixture();
  started.authorization.created_at = "2026-07-19T23:50:00.000Z";
  started.authorization.expires_at = "2026-07-20T00:10:00.000Z";
  started.authorization.channelmax.upload_completed_at =
    "2026-07-19T22:40:00.000Z";
  started.authorization.channelmax.verified_at =
    "2026-07-19T23:50:00.000Z";
  started.authorization.coupons.verified_at = "2026-07-19T23:50:00.000Z";
  started.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    started.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(started.authorization, {
        planSha256: started.planSha256,
        executionSelectionSha256: started.selectionSha256,
        launchPricingSourceSha256: started.launchSourceSha256,
        launchPricingManifest: started.launchManifest,
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    /launch window has already started/,
  );
});

test("ChannelMAX evidence requires a numeric Manual ID and two feed cycles", () => {
  const malformedModel = fixture();
  malformedModel.authorization.channelmax.manual_model_id = "59021\tACTIVE";
  for (const row of malformedModel.authorization.channelmax.rows) {
    row.repricing_model_id = "59021\tACTIVE";
  }
  malformedModel.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(malformedModel.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        malformedModel.authorization,
        {
          planSha256: malformedModel.planSha256,
          executionSelectionSha256: malformedModel.selectionSha256,
          launchPricingSourceSha256: malformedModel.launchSourceSha256,
          launchPricingManifest: malformedModel.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /ChannelMAX launch-control evidence is incomplete/,
  );

  const oneCycle = fixture();
  oneCycle.authorization.channelmax.upload_completed_at =
    "2026-07-18T15:55:00.001Z";
  oneCycle.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    oneCycle.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(oneCycle.authorization, {
        planSha256: oneCycle.planSha256,
        executionSelectionSha256: oneCycle.selectionSha256,
        launchPricingSourceSha256: oneCycle.launchSourceSha256,
        launchPricingManifest: oneCycle.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /ChannelMAX launch-control evidence is incomplete/,
  );
});

test("Arm B coupon absence coverage must be exact and unique", () => {
  const missing = fixture();
  missing.authorization.coupons.arm_b_absence_rows.pop();
  missing.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    missing.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(missing.authorization, {
        planSha256: missing.planSha256,
        executionSelectionSha256: missing.selectionSha256,
        launchPricingSourceSha256: missing.launchSourceSha256,
        launchPricingManifest: missing.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /does not prove absence/,
  );

  const duplicate = fixture();
  duplicate.authorization.coupons.arm_b_absence_rows[1] = structuredClone(
    duplicate.authorization.coupons.arm_b_absence_rows[0],
  );
  duplicate.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    duplicate.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(duplicate.authorization, {
        planSha256: duplicate.planSha256,
        executionSelectionSha256: duplicate.selectionSha256,
        launchPricingSourceSha256: duplicate.launchSourceSha256,
        launchPricingManifest: duplicate.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /Coupon absence evidence/,
  );
});

test("coupon campaign identity and raw status must be unambiguous", () => {
  const duplicate = fixture();
  duplicate.authorization.coupons.groups[1].coupon_id =
    duplicate.authorization.coupons.groups[0].coupon_id;
  duplicate.authorization.body_sha256 = launchExecutionAuthorizationBodySha256(
    duplicate.authorization,
  );
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(duplicate.authorization, {
        planSha256: duplicate.planSha256,
        executionSelectionSha256: duplicate.selectionSha256,
        launchPricingSourceSha256: duplicate.launchSourceSha256,
        launchPricingManifest: duplicate.launchManifest,
        now: new Date("2026-07-18T17:15:00.000Z"),
      }),
    /campaign evidence/,
  );

  const contradictory = fixture();
  contradictory.authorization.coupons.groups[0].raw_status = "Not scheduled";
  contradictory.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(contradictory.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        contradictory.authorization,
        {
          planSha256: contradictory.planSha256,
          executionSelectionSha256: contradictory.selectionSha256,
          launchPricingSourceSha256: contradictory.launchSourceSha256,
          launchPricingManifest: contradictory.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /campaign evidence/,
  );

  const prematurelyActive = fixture();
  const activeGroup = prematurelyActive.authorization.coupons.groups[0];
  activeGroup.normalized_status = "ACTIVE";
  activeGroup.raw_status = "Active";
  for (const row of prematurelyActive.authorization.coupons.rows.filter(
    (candidate) => candidate.count === activeGroup.count,
  )) {
    row.normalized_status = "ACTIVE";
    row.raw_status = "Active";
  }
  prematurelyActive.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(prematurelyActive.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        prematurelyActive.authorization,
        {
          planSha256: prematurelyActive.planSha256,
          executionSelectionSha256: prematurelyActive.selectionSha256,
          launchPricingSourceSha256: prematurelyActive.launchSourceSha256,
          launchPricingManifest: prematurelyActive.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /campaign evidence/,
  );
});

test("Arm A evidence rejects any additional active or scheduled coupon", () => {
  const stacked = fixture();
  stacked.authorization.coupons.rows[0]
    .active_or_scheduled_coupon_ids = [
      stacked.authorization.coupons.rows[0].coupon_id,
      "legacy-overlapping-coupon",
    ] as unknown as [string];
  stacked.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(stacked.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionAuthorization(
        stacked.authorization,
        {
          planSha256: stacked.planSha256,
          executionSelectionSha256: stacked.selectionSha256,
          launchPricingSourceSha256: stacked.launchSourceSha256,
          launchPricingManifest: stacked.launchManifest,
          now: new Date("2026-07-18T17:15:00.000Z"),
        },
      ),
    /Coupon activation evidence/,
  );
});

test("launch execution evidence bytes must parse to the exact inline controls", () => {
  const value = fixture();
  assert.doesNotThrow(() =>
    verifyUncrustablesLaunchExecutionEvidenceBytes(
      value.authorization,
      value.launchManifest,
      value.evidence,
    ),
  );

  const contradictory = fixture();
  const raw = JSON.parse(
    contradictory.evidence.channelmax_source_export.toString("utf8"),
  ) as Record<string, unknown>;
  const rows = raw.rows as Array<Record<string, unknown>>;
  rows[0].repricing_mode = "ACTIVE";
  delete raw.body_sha256;
  contradictory.evidence.channelmax_source_export = evidenceBytes(raw);
  contradictory.authorization.channelmax.source_export.sha256 = digest(
    contradictory.evidence.channelmax_source_export,
  );
  contradictory.authorization.body_sha256 =
    launchExecutionAuthorizationBodySha256(contradictory.authorization);
  assert.throws(
    () =>
      verifyUncrustablesLaunchExecutionEvidenceBytes(
        contradictory.authorization,
        contradictory.launchManifest,
        contradictory.evidence,
      ),
    /contradicts authorization field rows/,
  );
});
