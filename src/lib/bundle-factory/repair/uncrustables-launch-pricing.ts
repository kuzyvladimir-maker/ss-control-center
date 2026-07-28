import { createHash } from "node:crypto";

import { priceFor } from "@/lib/pricing/cost-model";

export const UNCRUSTABLES_LAUNCH_PRICING_SCHEMA =
  "uncrustables-launch-pricing/v4" as const;

export const UNCRUSTABLES_LAUNCH_COHORT_ROWS = 164 as const;

export const UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION = {
  sku: "VN-AS1A-D572",
  asin: "B0H82PKK18",
  reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
} as const;

export type UncrustablesLaunchArm = "A" | "B";
export type UncrustablesLaunchLever =
  | "COUPON_12"
  | "COUPON_13"
  | "SALEPRICE_12"
  | "SALEPRICE_13";

export interface UncrustablesCouponGroupPolicy {
  count: 24 | 30 | 45 | 90 | 120;
  discount_percent: 12 | 13;
  title: string;
  budget_usd: number;
  asin_count: number;
  limit_one_per_customer: true;
  targeted_segment: "All customers";
}

export const UNCRUSTABLES_COUPON_GROUP_POLICIES = [
  {
    count: 24,
    discount_percent: 13,
    title: "Uncrustables 24 Count Launch Savings",
    budget_usd: 110,
  },
  {
    count: 30,
    discount_percent: 13,
    title: "Uncrustables 30 Count Launch Savings",
    budget_usd: 120,
  },
  {
    count: 45,
    discount_percent: 12,
    title: "Uncrustables 45 Count Launch Savings",
    budget_usd: 180,
  },
  {
    count: 90,
    discount_percent: 13,
    title: "Uncrustables 90 Count Launch Savings",
    budget_usd: 340,
  },
  {
    count: 120,
    discount_percent: 13,
    title: "Uncrustables 120 Count Launch Savings",
    budget_usd: 400,
  },
] as const;

export interface UncrustablesSalePriceSchedule {
  value_with_tax: number;
  start_at: string;
  end_at: string;
}

export interface UncrustablesLaunchPricingRow {
  sku: string;
  asin: string;
  count: number;
  arm: UncrustablesLaunchArm;
  lever: UncrustablesLaunchLever;
  base_price: number;
  floor_price: number;
  effective_price: number;
  discount_percent: 12 | 13;
  sale_price_schedule: UncrustablesSalePriceSchedule | null;
}

export interface UncrustablesLaunchPricingExclusion {
  sku: string;
  asin: string;
  reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541";
}

export interface UncrustablesLaunchPricingManifest {
  schema_version: typeof UNCRUSTABLES_LAUNCH_PRICING_SCHEMA;
  immutable: true;
  reviewed_at: string;
  decision: {
    original_owner_decision_date: "2026-07-13";
    revision_status:
      | "PROPOSED_OWNER_APPROVAL_REQUIRED"
      | "OWNER_APPROVED";
    revision_prepared_at: string;
    owner_approved_at: string | null;
    changes: {
      count_45_discount_percent_from_13_to_12: true;
      synchronized_window_rebased: true;
      unsafe_historical_coupon_titles_replaced: true;
      coupon_budget_and_targeting_sealed: true;
    };
  };
  source_artifacts: {
    assignments: LaunchPricingSourceArtifact;
    coupon_spec: LaunchPricingSourceArtifact;
    sale_price_spec: LaunchPricingSourceArtifact;
  };
  policy: {
    experiment: "BALANCED_COUPON_VS_SALE_PRICE";
    base_price_immutable: true;
    list_price_absent: true;
    effective_price_not_below_floor: true;
    equal_effective_price_within_count_tier: true;
    maximum_discount_percent: 13;
    excluded_identity_conflicts_not_publishable: true;
    owner_approval_required_for_execution: true;
    coupon_budget_is_not_a_hard_spend_cap_acknowledged: true;
  };
  coupon_controls: {
    group_count: 5;
    total_budget_usd: 1150;
    groups: UncrustablesCouponGroupPolicy[];
  };
  /** Identity-conflicted rows that were present in the sealed arm assignment. */
  exclusions: UncrustablesLaunchPricingExclusion[];
  /** Cohort members withheld before arm assignment; no synthetic arm is invented. */
  pre_assignment_exclusions: UncrustablesLaunchPricingExclusion[];
  scope: {
    cohort_rows: typeof UNCRUSTABLES_LAUNCH_COHORT_ROWS;
    rows: number;
    coupon_rows: number;
    sale_price_rows: number;
    excluded_rows: number;
    pre_assignment_excluded_rows: number;
    active_rows: number;
    active_coupon_rows: number;
    active_sale_price_rows: number;
    start_at: string;
    end_at: string;
  };
  rows: UncrustablesLaunchPricingRow[];
  body_sha256: string;
}

export interface LaunchPricingSourceArtifact {
  path: string;
  sha256: string;
  rows: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function money(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive finite amount.`);
  }
  const rounded = Math.round(parsed * 100) / 100;
  if (Math.abs(parsed - rounded) >= 0.000001) {
    throw new Error(`${label} must have at most two decimal places.`);
  }
  return rounded;
}

function exactMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

function isoInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function sourceArtifact(
  value: unknown,
  label: string,
): LaunchPricingSourceArtifact {
  if (!isRecord(value)) throw new Error(`${label} is missing.`);
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new Error(`${label}.path is missing.`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`${label}.sha256 is invalid.`);
  }
  if (!Number.isInteger(value.rows) || Number(value.rows) <= 0) {
    throw new Error(`${label}.rows must be a positive integer.`);
  }
  return {
    path: value.path,
    sha256: value.sha256,
    rows: Number(value.rows),
  };
}

export function launchPricingManifestBodySha256(
  manifest: Omit<UncrustablesLaunchPricingManifest, "body_sha256"> | UncrustablesLaunchPricingManifest,
): string {
  const body = { ...(manifest as unknown as Record<string, unknown>) };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

export function verifyUncrustablesLaunchPricingManifest(
  raw: unknown,
): UncrustablesLaunchPricingManifest {
  if (!isRecord(raw)) throw new Error("Launch-pricing manifest must be an object.");
  const manifest = raw as unknown as UncrustablesLaunchPricingManifest;
  if (
    manifest.schema_version !== UNCRUSTABLES_LAUNCH_PRICING_SCHEMA ||
    manifest.immutable !== true
  ) {
    throw new Error(
      `Launch-pricing manifest must use ${UNCRUSTABLES_LAUNCH_PRICING_SCHEMA} and immutable=true.`,
    );
  }
  isoInstant(manifest.reviewed_at, "launch-pricing reviewed_at");
  const revisionPreparedAt = isoInstant(
    manifest.decision?.revision_prepared_at,
    "launch-pricing decision.revision_prepared_at",
  );
  if (
    manifest.decision?.original_owner_decision_date !== "2026-07-13" ||
    manifest.decision.changes?.count_45_discount_percent_from_13_to_12 !== true ||
    manifest.decision.changes?.synchronized_window_rebased !== true ||
    manifest.decision.changes?.unsafe_historical_coupon_titles_replaced !== true ||
    manifest.decision.changes?.coupon_budget_and_targeting_sealed !== true ||
    (manifest.decision.revision_status === "PROPOSED_OWNER_APPROVAL_REQUIRED" &&
      manifest.decision.owner_approved_at !== null) ||
    (manifest.decision.revision_status === "OWNER_APPROVED" &&
      (manifest.decision.owner_approved_at == null ||
        Date.parse(
          isoInstant(
            manifest.decision.owner_approved_at,
            "launch-pricing decision.owner_approved_at",
          ),
        ) < Date.parse(revisionPreparedAt))) ||
    ![
      "PROPOSED_OWNER_APPROVAL_REQUIRED",
      "OWNER_APPROVED",
    ].includes(manifest.decision.revision_status)
  ) {
    throw new Error("Launch-pricing decision/revision metadata is invalid.");
  }
  if (
    manifest.policy?.experiment !== "BALANCED_COUPON_VS_SALE_PRICE" ||
    manifest.policy.base_price_immutable !== true ||
    manifest.policy.list_price_absent !== true ||
    manifest.policy.effective_price_not_below_floor !== true ||
    manifest.policy.equal_effective_price_within_count_tier !== true ||
    manifest.policy.maximum_discount_percent !== 13 ||
    manifest.policy.excluded_identity_conflicts_not_publishable !== true ||
    manifest.policy.owner_approval_required_for_execution !== true ||
    manifest.policy.coupon_budget_is_not_a_hard_spend_cap_acknowledged !== true
  ) {
    throw new Error("Launch-pricing safety policy is incomplete or weakened.");
  }
  const assignments = sourceArtifact(
    manifest.source_artifacts?.assignments,
    "source_artifacts.assignments",
  );
  const couponSpec = sourceArtifact(
    manifest.source_artifacts?.coupon_spec,
    "source_artifacts.coupon_spec",
  );
  const salePriceSpec = sourceArtifact(
    manifest.source_artifacts?.sale_price_spec,
    "source_artifacts.sale_price_spec",
  );
  if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    throw new Error("Launch-pricing manifest rows are missing.");
  }
  const startAt = isoInstant(manifest.scope?.start_at, "launch-pricing scope.start_at");
  const endAt = isoInstant(manifest.scope?.end_at, "launch-pricing scope.end_at");
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new Error("Launch-pricing end_at must be after start_at.");
  }
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  const tierPolicies = new Map<
    number,
    { base: number; floor: number; effective: number; discountPercent: number }
  >();
  let couponRows = 0;
  let salePriceRows = 0;
  for (const [index, row] of manifest.rows.entries()) {
    const label = `launch-pricing row ${index + 1}`;
    if (!row || typeof row.sku !== "string" || !row.sku.trim()) {
      throw new Error(`${label} SKU is missing.`);
    }
    if (typeof row.asin !== "string" || !/^B0[A-Z0-9]{8}$/.test(row.asin)) {
      throw new Error(`${label} ASIN is invalid.`);
    }
    if (seenSkus.has(row.sku) || seenAsins.has(row.asin)) {
      throw new Error(`${label} duplicates a SKU or ASIN.`);
    }
    seenSkus.add(row.sku);
    seenAsins.add(row.asin);
    if (!Number.isInteger(row.count) || row.count <= 0) {
      throw new Error(`${label} count must be a positive integer.`);
    }
    if (row.arm !== "A" && row.arm !== "B") {
      throw new Error(`${label} arm must be A or B.`);
    }
    const canonical = priceFor(row.count);
    if (!canonical) throw new Error(`${label} has no canonical price model.`);
    const base = money(row.base_price, `${label} base_price`);
    const floor = money(row.floor_price, `${label} floor_price`);
    const effective = money(row.effective_price, `${label} effective_price`);
    if (!exactMoney(base, canonical.suggested) || !exactMoney(floor, canonical.floor)) {
      throw new Error(`${label} does not match the canonical Layer A base/floor.`);
    }
    if (![12, 13].includes(row.discount_percent)) {
      throw new Error(`${label} discount_percent must be 12 or 13.`);
    }
    const expectedEffective =
      Math.round(base * (1 - row.discount_percent / 100) * 100) / 100;
    if (
      !exactMoney(effective, expectedEffective) ||
      effective + 0.005 < floor ||
      effective >= base
    ) {
      throw new Error(`${label} has an unsafe or non-reviewed effective price.`);
    }
    const expectedLever = `${row.arm === "A" ? "COUPON" : "SALEPRICE"}_${row.discount_percent}`;
    if (row.lever !== expectedLever) {
      throw new Error(`${label} arm/lever/discount pairing is invalid.`);
    }
    const tierPolicy = tierPolicies.get(row.count);
    if (tierPolicy) {
      if (
        !exactMoney(tierPolicy.base, base) ||
        !exactMoney(tierPolicy.floor, floor) ||
        !exactMoney(tierPolicy.effective, effective) ||
        tierPolicy.discountPercent !== row.discount_percent
      ) {
        throw new Error(`${label} is not exposure-matched within its count tier.`);
      }
    } else {
      tierPolicies.set(row.count, {
        base,
        floor,
        effective,
        discountPercent: row.discount_percent,
      });
    }
    if (row.arm === "A") {
      couponRows++;
      if (row.sale_price_schedule !== null) {
        throw new Error(`${label} coupon arm must not carry a Sale Price schedule.`);
      }
    } else if (row.arm === "B") {
      salePriceRows++;
      const schedule = row.sale_price_schedule;
      if (!schedule) throw new Error(`${label} Sale Price schedule is missing.`);
      if (
        !exactMoney(
          money(schedule.value_with_tax, `${label} sale value`),
          effective,
        ) ||
        isoInstant(schedule.start_at, `${label} sale start_at`) !== startAt ||
        isoInstant(schedule.end_at, `${label} sale end_at`) !== endAt
      ) {
        throw new Error(`${label} Sale Price schedule does not match the sealed experiment.`);
      }
    }
  }
  if (!Array.isArray(manifest.exclusions)) {
    throw new Error("Launch-pricing exclusions must be an array.");
  }
  const excludedSkus = new Set<string>();
  const excludedAsins = new Set<string>();
  for (const [index, exclusion] of manifest.exclusions.entries()) {
    const row = manifest.rows.find((candidate) => candidate.sku === exclusion?.sku);
    if (
      !row ||
      row.asin !== exclusion.asin ||
      exclusion.reason !== "AMAZON_CATALOG_IDENTITY_CONFLICT_8541" ||
      excludedSkus.has(exclusion.sku) ||
      excludedAsins.has(exclusion.asin)
    ) {
      throw new Error(
        `Launch-pricing exclusion ${index + 1} is invalid, duplicated, or not bound to a source row.`,
      );
    }
    excludedSkus.add(exclusion.sku);
    excludedAsins.add(exclusion.asin);
  }
  if (!Array.isArray(manifest.pre_assignment_exclusions)) {
    throw new Error("Launch-pricing pre-assignment exclusions must be an array.");
  }
  const preAssignmentExcludedSkus = new Set<string>();
  const preAssignmentExcludedAsins = new Set<string>();
  for (const [index, exclusion] of manifest.pre_assignment_exclusions.entries()) {
    if (
      !exclusion ||
      typeof exclusion.sku !== "string" ||
      !exclusion.sku.trim() ||
      typeof exclusion.asin !== "string" ||
      !/^B0[A-Z0-9]{8}$/.test(exclusion.asin) ||
      exclusion.reason !== "AMAZON_CATALOG_IDENTITY_CONFLICT_8541" ||
      seenSkus.has(exclusion.sku) ||
      seenAsins.has(exclusion.asin) ||
      excludedSkus.has(exclusion.sku) ||
      excludedAsins.has(exclusion.asin) ||
      preAssignmentExcludedSkus.has(exclusion.sku) ||
      preAssignmentExcludedAsins.has(exclusion.asin)
    ) {
      throw new Error(
        `Launch-pricing pre-assignment exclusion ${index + 1} is invalid, duplicated, or overlaps an experiment row.`,
      );
    }
    preAssignmentExcludedSkus.add(exclusion.sku);
    preAssignmentExcludedAsins.add(exclusion.asin);
  }
  if (
    !manifest.pre_assignment_exclusions.some(
      (exclusion) =>
        exclusion.sku === UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION.sku &&
        exclusion.asin === UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION.asin &&
        exclusion.reason ===
          UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION.reason,
    )
  ) {
    throw new Error(
      "Launch-pricing pre-assignment exclusions must explicitly account for VN-AS1A-D572 / B0H82PKK18.",
    );
  }
  const activeRows = manifest.rows.filter((row) => !excludedSkus.has(row.sku));
  const activeCouponRows = activeRows.filter((row) => row.arm === "A").length;
  const activeSalePriceRows = activeRows.filter((row) => row.arm === "B").length;
  if (
    manifest.coupon_controls?.group_count !==
      UNCRUSTABLES_COUPON_GROUP_POLICIES.length ||
    manifest.coupon_controls.total_budget_usd !== 1150 ||
    !Array.isArray(manifest.coupon_controls.groups) ||
    manifest.coupon_controls.groups.length !==
      UNCRUSTABLES_COUPON_GROUP_POLICIES.length
  ) {
    throw new Error("Launch-pricing coupon group controls are incomplete.");
  }
  const couponGroupCounts = new Set<number>();
  let couponBudget = 0;
  for (const expected of UNCRUSTABLES_COUPON_GROUP_POLICIES) {
    const group = manifest.coupon_controls.groups.find(
      (candidate) => candidate.count === expected.count,
    );
    const expectedAsinCount = manifest.rows.filter(
      (row) => row.arm === "A" && row.count === expected.count,
    ).length;
    if (
      !group ||
      couponGroupCounts.has(group.count) ||
      group.discount_percent !== expected.discount_percent ||
      group.title !== expected.title ||
      group.budget_usd !== expected.budget_usd ||
      expectedAsinCount <= 0 ||
      group.asin_count !== expectedAsinCount ||
      group.limit_one_per_customer !== true ||
      group.targeted_segment !== "All customers"
    ) {
      throw new Error(
        `Launch-pricing coupon controls for ${expected.count} count are invalid.`,
      );
    }
    couponGroupCounts.add(group.count);
    couponBudget += group.budget_usd;
  }
  if (couponBudget !== manifest.coupon_controls.total_budget_usd) {
    throw new Error("Launch-pricing coupon budget total is inconsistent.");
  }
  for (const count of new Set(manifest.rows.map((row) => row.count))) {
    const tierRows = manifest.rows.filter((row) => row.count === count);
    const armA = tierRows.filter((row) => row.arm === "A").length;
    const armB = tierRows.filter((row) => row.arm === "B").length;
    if (armA === 0 || armB === 0 || Math.abs(armA - armB) > 1) {
      throw new Error(
        `Launch-pricing count ${count} is not balanced between coupon and Sale Price arms.`,
      );
    }
  }
  if (
    manifest.scope.cohort_rows !== UNCRUSTABLES_LAUNCH_COHORT_ROWS ||
    manifest.scope.rows !== manifest.rows.length ||
    manifest.scope.coupon_rows !== couponRows ||
    manifest.scope.sale_price_rows !== salePriceRows ||
    assignments.rows !== manifest.rows.length ||
    salePriceSpec.rows !== salePriceRows ||
    couponSpec.rows !== manifest.coupon_controls.group_count ||
    manifest.scope.excluded_rows !== manifest.exclusions.length ||
    manifest.scope.pre_assignment_excluded_rows !==
      manifest.pre_assignment_exclusions.length ||
    manifest.scope.active_rows !== activeRows.length ||
    manifest.scope.active_coupon_rows !== activeCouponRows ||
    manifest.scope.active_sale_price_rows !== activeSalePriceRows ||
    manifest.scope.active_rows + manifest.scope.excluded_rows !==
      manifest.scope.rows ||
    manifest.scope.cohort_rows !==
      manifest.scope.rows + manifest.scope.pre_assignment_excluded_rows ||
    manifest.scope.cohort_rows !==
      manifest.scope.active_rows +
        manifest.scope.excluded_rows +
        manifest.scope.pre_assignment_excluded_rows
  ) {
    throw new Error("Launch-pricing scope/source row counts are inconsistent.");
  }
  if (
    typeof manifest.body_sha256 !== "string" ||
    manifest.body_sha256 !== launchPricingManifestBodySha256(manifest)
  ) {
    throw new Error("Launch-pricing body SHA-256 is invalid.");
  }
  return manifest;
}

export function launchPricingRowsBySku(
  manifest: UncrustablesLaunchPricingManifest,
): Map<string, UncrustablesLaunchPricingRow> {
  verifyUncrustablesLaunchPricingManifest(manifest);
  const excluded = new Set(manifest.exclusions.map((row) => row.sku));
  return new Map(
    manifest.rows
      .filter((row) => !excluded.has(row.sku))
      .map((row) => [row.sku, row]),
  );
}
