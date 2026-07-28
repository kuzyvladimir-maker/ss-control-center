import { createHash } from "node:crypto";

import {
  UNCRUSTABLES_COUPON_GROUP_POLICIES,
  launchPricingRowsBySku,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingManifest,
} from "./uncrustables-launch-pricing";

export const UNCRUSTABLES_LAUNCH_EXECUTION_AUTHORIZATION_SCHEMA =
  "uncrustables-launch-execution-authorization/v4" as const;
export const UNCRUSTABLES_CHANNELMAX_POST_UPLOAD_EVIDENCE_SCHEMA =
  "uncrustables-channelmax-post-upload-evidence/v2" as const;
export const UNCRUSTABLES_COUPON_ACTIVATION_EVIDENCE_SCHEMA =
  "uncrustables-amazon-coupon-activation-evidence/v4" as const;

export interface LaunchEvidenceArtifact {
  path: string;
  sha256: string;
}

export interface ChannelMaxLaunchControlRow {
  sku: string;
  asin: string;
  repricing_model_id: string;
  repricing_model_name: string;
  repricing_mode: "MANUAL";
  observed_base_price: number;
  minimum_selling_price: number;
  maximum_selling_price: number;
}

export interface AmazonCouponLaunchControlRow {
  asin: string;
  count: number;
  discount_percent: 12 | 13;
  coupon_id: string;
  active_or_scheduled_coupon_ids: [string];
  normalized_status: "SCHEDULED" | "ACTIVE";
  raw_status: string;
  start_at: string;
  end_at: string;
}

export interface AmazonCouponLaunchControlGroup {
  count: 24 | 30 | 45 | 90 | 120;
  discount_percent: 12 | 13;
  title: string;
  budget_usd: number;
  asin_count: number;
  limit_one_per_customer: true;
  targeted_segment: "All customers";
  coupon_id: string;
  normalized_status: "SCHEDULED" | "ACTIVE";
  raw_status: string;
  start_at: string;
  end_at: string;
}

export interface AmazonCouponAbsentControlRow {
  asin: string;
  count: number;
  active_or_scheduled_coupon_ids: [];
}

export interface UncrustablesLaunchExecutionAuthorization {
  schema_version: typeof UNCRUSTABLES_LAUNCH_EXECUTION_AUTHORIZATION_SCHEMA;
  immutable: true;
  created_at: string;
  expires_at: string;
  source_plan_sha256: string;
  execution_selection_sha256: string;
  account: {
    store_index: number;
    marketplace_id: string;
    amazon_merchant_id: string;
    channelmax_account_id: string;
  };
  launch_pricing: {
    source_sha256: string;
    body_sha256: string;
  };
  channelmax: {
    source_export: LaunchEvidenceArtifact;
    assignment_upload: LaunchEvidenceArtifact;
    upload_task_id: string;
    upload_status: "COMPLETED";
    upload_completed_at: string;
    verified_at: string;
    manual_model_id: string;
    manual_model_name: string;
    rule_44a_skip_repricing: true;
    rule_44b_skip_repricing: true;
    amazon_is_only_price_writer: true;
    bounds_are_guardrails_not_base_price_authority: true;
    active_rows: number;
    rows: ChannelMaxLaunchControlRow[];
  };
  coupons: {
    source_evidence: LaunchEvidenceArtifact;
    verified_at: string;
    active_and_scheduled_account_scope_checked: true;
    active_rows: number;
    groups: AmazonCouponLaunchControlGroup[];
    rows: AmazonCouponLaunchControlRow[];
    arm_b_absence_rows: AmazonCouponAbsentControlRow[];
  };
  body_sha256: string;
}

export interface LaunchExecutionAuthorizationRuntimeInput {
  authorization: UncrustablesLaunchExecutionAuthorization;
  launchPricingManifest: UncrustablesLaunchPricingManifest;
  launchPricingSourceSha256: string;
  launchPricingSourceBytes: Buffer;
  evidence_bytes: {
    channelmax_source_export: Buffer;
    channelmax_assignment_upload: Buffer;
    coupon_source_evidence: Buffer;
  };
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactMoney(left: number, right: number): boolean {
  return Number.isFinite(left) && Math.abs(left - right) < 0.005;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty canonical ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function rawCouponStatusMatches(
  rawStatus: unknown,
  normalizedStatus: "SCHEDULED" | "ACTIVE",
): boolean {
  if (typeof rawStatus !== "string" || !rawStatus.trim()) return false;
  const normalizedRaw = rawStatus.trim().toUpperCase().replace(/[^A-Z]+/g, "_");
  if (normalizedStatus === "SCHEDULED") {
    return normalizedRaw === "SCHEDULED";
  }
  return normalizedRaw === "ACTIVE" || normalizedRaw === "RUNNING";
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function artifact(value: unknown, label: string): LaunchEvidenceArtifact {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path.trim()
  ) {
    throw new Error(`${label} path is missing.`);
  }
  return { path: value.path, sha256: digest(value.sha256, `${label} sha256`) };
}

function parseSealedEvidence(
  bytes: Buffer,
  schemaVersion: string,
  label: string,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!isRecord(raw) || raw.schema_version !== schemaVersion || raw.immutable !== true) {
    throw new Error(`${label} schema/immutability is invalid.`);
  }
  const bodyDigest = raw.body_sha256;
  const body = { ...raw };
  delete body.body_sha256;
  if (
    typeof bodyDigest !== "string" ||
    bodyDigest !== sha256(stableJson(body))
  ) {
    throw new Error(`${label} body SHA-256 is invalid.`);
  }
  return raw;
}

export function launchExecutionEvidenceBodySha256(
  evidence: Record<string, unknown>,
): string {
  const body = { ...evidence };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

export function launchExecutionAuthorizationBodySha256(
  authorization:
    | Omit<UncrustablesLaunchExecutionAuthorization, "body_sha256">
    | UncrustablesLaunchExecutionAuthorization,
): string {
  const body = { ...(authorization as unknown as Record<string, unknown>) };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

export function verifyUncrustablesLaunchExecutionAuthorization(
  raw: unknown,
  context: {
    planSha256: string;
    executionSelectionSha256: string;
    launchPricingSourceSha256: string;
    launchPricingManifest: UncrustablesLaunchPricingManifest;
    now?: Date;
  },
): UncrustablesLaunchExecutionAuthorization {
  if (!isRecord(raw)) {
    throw new Error("Launch execution authorization must be an object.");
  }
  const authorization = raw as unknown as UncrustablesLaunchExecutionAuthorization;
  if (
    authorization.schema_version !==
      UNCRUSTABLES_LAUNCH_EXECUTION_AUTHORIZATION_SCHEMA ||
    authorization.immutable !== true
  ) {
    throw new Error("Launch execution authorization schema/immutability is invalid.");
  }
  if (
    !Number.isInteger(authorization.account?.store_index) ||
    authorization.account.store_index <= 0 ||
    typeof authorization.account.marketplace_id !== "string" ||
    !authorization.account.marketplace_id.trim() ||
    /[\t\r\n]/.test(authorization.account.marketplace_id) ||
    typeof authorization.account.amazon_merchant_id !== "string" ||
    !/^[A-Z0-9]+$/.test(authorization.account.amazon_merchant_id) ||
    typeof authorization.account.channelmax_account_id !== "string" ||
    !authorization.account.channelmax_account_id.trim() ||
    /[\t\r\n]/.test(authorization.account.channelmax_account_id)
  ) {
    throw new Error("Launch execution authorization account binding is invalid.");
  }
  const createdAt = canonicalInstant(
    authorization.created_at,
    "authorization created_at",
  );
  const expiresAt = canonicalInstant(
    authorization.expires_at,
    "authorization expires_at",
  );
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = (context.now ?? new Date()).getTime();
  if (
    expiresMs <= createdMs ||
    expiresMs - createdMs > 30 * 60 * 1000 ||
    nowMs < createdMs ||
    nowMs >= expiresMs
  ) {
    throw new Error(
      "Launch execution authorization is not current or exceeds its 30-minute freshness window.",
    );
  }
  if (
    digest(authorization.source_plan_sha256, "authorization plan sha256") !==
      context.planSha256 ||
    digest(
      authorization.execution_selection_sha256,
      "authorization execution-selection sha256",
    ) !== context.executionSelectionSha256 ||
    digest(
      authorization.launch_pricing?.source_sha256,
      "authorization launch source sha256",
    ) !== context.launchPricingSourceSha256
  ) {
    throw new Error("Launch execution authorization is bound to different sealed inputs.");
  }
  const launchManifest = verifyUncrustablesLaunchPricingManifest(
    context.launchPricingManifest,
  );
  if (
    digest(
      authorization.launch_pricing.body_sha256,
      "authorization launch body sha256",
    ) !== launchManifest.body_sha256 ||
    launchManifest.decision.revision_status !== "OWNER_APPROVED"
  ) {
    throw new Error(
      "Launch execution authorization requires the exact owner-approved pricing revision.",
    );
  }
  const ownerApprovedAt = canonicalInstant(
    launchManifest.decision.owner_approved_at,
    "launch-pricing decision.owner_approved_at",
  );
  const launchEndAt = canonicalInstant(
    launchManifest.scope.end_at,
    "launch-pricing scope.end_at",
  );
  const launchStartAt = canonicalInstant(
    launchManifest.scope.start_at,
    "launch-pricing scope.start_at",
  );
  if (
    Date.parse(ownerApprovedAt) > createdMs ||
    Date.parse(ownerApprovedAt) > nowMs
  ) {
    throw new Error(
      "Launch-pricing owner approval must exist before authorization creation and execution.",
    );
  }
  if (nowMs >= Date.parse(launchEndAt)) {
    throw new Error(
      "Launch-pricing schedule has expired; rebuild and re-approve a fresh synchronized window.",
    );
  }
  if (nowMs >= Date.parse(launchStartAt)) {
    throw new Error(
      "The synchronized launch window has already started; ordinary launch writes are closed.",
    );
  }
  artifact(
    authorization.channelmax?.source_export,
    "authorization ChannelMAX source export",
  );
  artifact(
    authorization.channelmax?.assignment_upload,
    "authorization ChannelMAX assignment upload",
  );
  const channelMaxVerifiedAt = canonicalInstant(
    authorization.channelmax?.verified_at,
    "authorization ChannelMAX verified_at",
  );
  const channelMaxUploadCompletedAt = canonicalInstant(
    authorization.channelmax?.upload_completed_at,
    "authorization ChannelMAX upload_completed_at",
  );
  if (
    Date.parse(channelMaxVerifiedAt) > createdMs ||
    Date.parse(channelMaxVerifiedAt) > nowMs ||
    nowMs - Date.parse(channelMaxVerifiedAt) > 15 * 60 * 1000 ||
    // Two nominal ~30-minute ChannelMAX feed cycles plus a small buffer must
    // pass before Amazon pricing is allowed to move.
    Date.parse(channelMaxVerifiedAt) - Date.parse(channelMaxUploadCompletedAt) <
      65 * 60 * 1000 ||
    authorization.channelmax.upload_status !== "COMPLETED" ||
    typeof authorization.channelmax.upload_task_id !== "string" ||
    !authorization.channelmax.upload_task_id.trim() ||
    typeof authorization.channelmax.manual_model_id !== "string" ||
    !/^\d+$/.test(authorization.channelmax.manual_model_id) ||
    typeof authorization.channelmax.manual_model_name !== "string" ||
    !authorization.channelmax.manual_model_name.trim() ||
    /[\t\r\n]/.test(authorization.channelmax.manual_model_name) ||
    authorization.channelmax.rule_44a_skip_repricing !== true ||
    authorization.channelmax.rule_44b_skip_repricing !== true ||
    authorization.channelmax.amazon_is_only_price_writer !== true ||
    authorization.channelmax.bounds_are_guardrails_not_base_price_authority !==
      true ||
    !Array.isArray(authorization.channelmax.rows)
  ) {
    throw new Error("ChannelMAX launch-control evidence is incomplete.");
  }

  const activeRows = launchPricingRowsBySku(launchManifest);
  if (
    authorization.channelmax.active_rows !== activeRows.size ||
    authorization.channelmax.rows.length !== activeRows.size
  ) {
    throw new Error("ChannelMAX evidence does not cover the exact active launch scope.");
  }
  const channelMaxSeen = new Set<string>();
  for (const row of authorization.channelmax.rows) {
    const launchRow = activeRows.get(row.sku);
    if (
      !launchRow ||
      launchRow.asin !== row.asin ||
      channelMaxSeen.has(row.sku) ||
      typeof row.repricing_model_id !== "string" ||
      !/^\d+$/.test(row.repricing_model_id) ||
      typeof row.repricing_model_name !== "string" ||
      !row.repricing_model_name.trim() ||
      /[\t\r\n]/.test(row.repricing_model_name) ||
      row.repricing_mode !== "MANUAL" ||
      row.repricing_model_id !== authorization.channelmax.manual_model_id ||
      row.repricing_model_name !== authorization.channelmax.manual_model_name ||
      !exactMoney(row.observed_base_price, launchRow.base_price) ||
      !exactMoney(row.minimum_selling_price, launchRow.floor_price) ||
      !exactMoney(row.maximum_selling_price, launchRow.base_price)
    ) {
      throw new Error(`ChannelMAX evidence for ${row.sku} is unsafe or mismatched.`);
    }
    channelMaxSeen.add(row.sku);
  }

  artifact(
    authorization.coupons?.source_evidence,
    "authorization coupon source evidence",
  );
  const couponsVerifiedAt = canonicalInstant(
    authorization.coupons?.verified_at,
    "authorization coupons verified_at",
  );
  if (
    Date.parse(couponsVerifiedAt) > createdMs ||
    Date.parse(couponsVerifiedAt) > nowMs ||
    nowMs - Date.parse(couponsVerifiedAt) > 15 * 60 * 1000 ||
    authorization.coupons.active_and_scheduled_account_scope_checked !== true ||
    !Array.isArray(authorization.coupons.groups) ||
    !Array.isArray(authorization.coupons.rows) ||
    !Array.isArray(authorization.coupons.arm_b_absence_rows)
  ) {
    throw new Error("Coupon activation evidence is incomplete.");
  }
  const couponLaunchRows = [...activeRows.values()].filter(
    (row) => row.arm === "A",
  );
  if (
    authorization.coupons.active_rows !== couponLaunchRows.length ||
    authorization.coupons.rows.length !== couponLaunchRows.length
  ) {
    throw new Error("Coupon evidence does not cover the exact active Arm A scope.");
  }
  const couponByAsin = new Map(couponLaunchRows.map((row) => [row.asin, row]));
  if (
    authorization.coupons.groups.length !==
    UNCRUSTABLES_COUPON_GROUP_POLICIES.length
  ) {
    throw new Error("Coupon campaign evidence does not contain the exact five groups.");
  }
  const couponGroupsByCount = new Map<number, AmazonCouponLaunchControlGroup>(
    authorization.coupons.groups.map((group) => [group.count, group]),
  );
  if (
    couponGroupsByCount.size !== UNCRUSTABLES_COUPON_GROUP_POLICIES.length
  ) {
    throw new Error("Coupon campaign evidence contains duplicate count groups.");
  }
  const couponGroupIds = new Set<string>();
  for (const expected of UNCRUSTABLES_COUPON_GROUP_POLICIES) {
    const group = couponGroupsByCount.get(expected.count);
    const manifestGroup = launchManifest.coupon_controls.groups.find(
      (candidate) => candidate.count === expected.count,
    );
    const activeAsinCount = couponLaunchRows.filter(
      (row) => row.count === expected.count,
    ).length;
    if (
      !group ||
      !manifestGroup ||
      group.discount_percent !== expected.discount_percent ||
      group.title !== expected.title ||
      group.budget_usd !== expected.budget_usd ||
      group.asin_count !== activeAsinCount ||
      group.limit_one_per_customer !== true ||
      group.targeted_segment !== "All customers" ||
      typeof group.coupon_id !== "string" ||
      !group.coupon_id.trim() ||
      couponGroupIds.has(group.coupon_id.trim()) ||
      group.normalized_status !== "SCHEDULED" ||
      !rawCouponStatusMatches(group.raw_status, group.normalized_status) ||
      canonicalInstant(group.start_at, `${group.count} coupon start_at`) !==
        launchManifest.scope.start_at ||
      canonicalInstant(group.end_at, `${group.count} coupon end_at`) !==
        launchManifest.scope.end_at
    ) {
      throw new Error(
        `Coupon campaign evidence for ${expected.count} count is unsafe or mismatched.`,
      );
    }
    couponGroupIds.add(group.coupon_id.trim());
  }
  const couponSeen = new Set<string>();
  for (const row of authorization.coupons.rows) {
    const launchRow = couponByAsin.get(row.asin);
    if (
      !launchRow ||
      couponSeen.has(row.asin) ||
      row.count !== launchRow.count ||
      row.discount_percent !== launchRow.discount_percent ||
      typeof row.coupon_id !== "string" ||
      !row.coupon_id.trim() ||
      !Array.isArray(row.active_or_scheduled_coupon_ids) ||
      row.active_or_scheduled_coupon_ids.length !== 1 ||
      row.active_or_scheduled_coupon_ids[0] !== row.coupon_id ||
      row.normalized_status !== "SCHEDULED" ||
      !rawCouponStatusMatches(row.raw_status, row.normalized_status) ||
      row.coupon_id !== couponGroupsByCount.get(row.count)?.coupon_id ||
      row.normalized_status !==
        couponGroupsByCount.get(row.count)?.normalized_status ||
      canonicalInstant(row.start_at, `${row.asin} coupon start_at`) !==
        launchManifest.scope.start_at ||
      canonicalInstant(row.end_at, `${row.asin} coupon end_at`) !==
        launchManifest.scope.end_at
    ) {
      throw new Error(`Coupon activation evidence for ${row.asin} is unsafe or mismatched.`);
    }
    couponSeen.add(row.asin);
  }
  const salePriceLaunchRows = [...activeRows.values()].filter(
    (row) => row.arm === "B",
  );
  if (
    authorization.coupons.arm_b_absence_rows.length !==
    salePriceLaunchRows.length
  ) {
    throw new Error(
      "Coupon evidence does not prove absence across the exact active Arm B scope.",
    );
  }
  const salePriceByAsin = new Map(
    salePriceLaunchRows.map((row) => [row.asin, row]),
  );
  const absenceSeen = new Set<string>();
  for (const row of authorization.coupons.arm_b_absence_rows) {
    const launchRow = salePriceByAsin.get(row.asin);
    if (
      !launchRow ||
      absenceSeen.has(row.asin) ||
      row.count !== launchRow.count ||
      !Array.isArray(row.active_or_scheduled_coupon_ids) ||
      row.active_or_scheduled_coupon_ids.length !== 0
    ) {
      throw new Error(
        `Coupon absence evidence for Arm B ASIN ${row.asin} is unsafe or mismatched.`,
      );
    }
    absenceSeen.add(row.asin);
  }
  if (
    typeof authorization.body_sha256 !== "string" ||
    authorization.body_sha256 !==
      launchExecutionAuthorizationBodySha256(authorization)
  ) {
    throw new Error("Launch execution authorization body SHA-256 is invalid.");
  }
  return authorization;
}

/** Reconcile the three hashed evidence files with the inline authorization.
 * A matching file digest is insufficient when its parsed settings/rows do not
 * prove the exact Manual model and coupon campaigns represented inline. */
export function verifyUncrustablesLaunchExecutionEvidenceBytes(
  authorization: UncrustablesLaunchExecutionAuthorization,
  launchPricingManifest: UncrustablesLaunchPricingManifest,
  evidence: LaunchExecutionAuthorizationRuntimeInput["evidence_bytes"],
): void {
  const launch = verifyUncrustablesLaunchPricingManifest(
    launchPricingManifest,
  );
  const references = [
    [
      authorization.channelmax.source_export,
      evidence.channelmax_source_export,
    ],
    [
      authorization.channelmax.assignment_upload,
      evidence.channelmax_assignment_upload,
    ],
    [authorization.coupons.source_evidence, evidence.coupon_source_evidence],
  ] as const;
  for (const [reference, bytes] of references) {
    const exactDigest = Buffer.isBuffer(bytes)
      ? createHash("sha256").update(bytes).digest("hex")
      : null;
    if (exactDigest !== reference.sha256) {
      throw new Error(`Execution evidence bytes do not match ${reference.path}.`);
    }
  }

  const channelMax = parseSealedEvidence(
    evidence.channelmax_source_export,
    UNCRUSTABLES_CHANNELMAX_POST_UPLOAD_EVIDENCE_SCHEMA,
    "ChannelMAX post-upload evidence",
  );
  const expectedChannelMaxFields: Record<string, unknown> = {
    account: authorization.account,
    verified_at: authorization.channelmax.verified_at,
    upload_task_id: authorization.channelmax.upload_task_id,
    upload_status: authorization.channelmax.upload_status,
    upload_completed_at: authorization.channelmax.upload_completed_at,
    manual_model_id: authorization.channelmax.manual_model_id,
    manual_model_name: authorization.channelmax.manual_model_name,
    rule_44a_skip_repricing:
      authorization.channelmax.rule_44a_skip_repricing,
    rule_44b_skip_repricing:
      authorization.channelmax.rule_44b_skip_repricing,
    amazon_is_only_price_writer:
      authorization.channelmax.amazon_is_only_price_writer,
    bounds_are_guardrails_not_base_price_authority:
      authorization.channelmax.bounds_are_guardrails_not_base_price_authority,
    active_rows: authorization.channelmax.active_rows,
    rows: authorization.channelmax.rows,
  };
  for (const [key, expected] of Object.entries(expectedChannelMaxFields)) {
    if (stableJson(channelMax[key]) !== stableJson(expected)) {
      throw new Error(
        `ChannelMAX post-upload evidence contradicts authorization field ${key}.`,
      );
    }
  }

  const rows = [...launchPricingRowsBySku(launch).values()].sort((left, right) =>
    left.sku.localeCompare(right.sku),
  );
  const assignmentLines = [
    [
      "SKU",
      "ASIN",
      "SellingVenue",
      "MinSellingPrice",
      "MaxSellingPrice",
      "RepricingModelID",
    ].join("\t"),
    ...rows.map((row) =>
      [
        row.sku,
        row.asin,
        "AmazonUS",
        row.floor_price.toFixed(2),
        row.base_price.toFixed(2),
        authorization.channelmax.manual_model_id,
      ].join("\t"),
    ),
  ];
  const expectedAssignment = `${assignmentLines.join("\r\n")}\r\n`;
  if (evidence.channelmax_assignment_upload.toString("utf8") !== expectedAssignment) {
    throw new Error(
      "ChannelMAX assignment upload bytes do not exactly match the active launch scope and Manual model.",
    );
  }

  const coupons = parseSealedEvidence(
    evidence.coupon_source_evidence,
    UNCRUSTABLES_COUPON_ACTIVATION_EVIDENCE_SCHEMA,
    "Amazon coupon activation evidence",
  );
  const expectedCouponFields: Record<string, unknown> = {
    account: authorization.account,
    verified_at: authorization.coupons.verified_at,
    active_and_scheduled_account_scope_checked:
      authorization.coupons.active_and_scheduled_account_scope_checked,
    active_rows: authorization.coupons.active_rows,
    groups: authorization.coupons.groups,
    rows: authorization.coupons.rows,
    arm_b_absence_rows: authorization.coupons.arm_b_absence_rows,
  };
  for (const [key, expected] of Object.entries(expectedCouponFields)) {
    if (stableJson(coupons[key]) !== stableJson(expected)) {
      throw new Error(
        `Amazon coupon activation evidence contradicts authorization field ${key}.`,
      );
    }
  }
}
