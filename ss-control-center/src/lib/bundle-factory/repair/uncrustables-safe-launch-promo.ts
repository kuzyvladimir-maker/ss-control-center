import { createHash } from "node:crypto";

import {
  UNCRUSTABLES_COUPON_GROUP_POLICIES,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesLaunchArm,
  type UncrustablesLaunchLever,
  type UncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingRow,
} from "./uncrustables-launch-pricing";
import {
  verifySafeBaseOfferChannelMaxManualAssignment,
  type SafeBaseOfferChannelMaxManualManifest,
} from "./uncrustables-channelmax-safe-base-offer-manual";

export const SAFE_LAUNCH_PROMO_SCHEMA =
  "uncrustables-safe-launch-promo-ab/v1" as const;

export const SAFE_LAUNCH_PROMO_PREPARED_AT =
  "2026-07-19T06:00:00.000Z" as const;

export const SAFE_LAUNCH_PROMO_WINDOW = {
  start_date: "2026-07-20",
  end_date: "2026-08-19",
  start_at: "2026-07-20T00:00:00.000Z",
  end_at: "2026-08-19T23:59:59.000Z",
} as const;

export const SAFE_LAUNCH_PROMO_IDENTITY_HOLDS = [
  {
    sku: "SZ-ASPI-JFAT",
    asin: "B0H776M5B5",
    source_arm: "A",
    reason: "IDENTITY_HOLD_NO_PROMO",
  },
  {
    sku: "TY-AST2-JE9P",
    asin: "B0H84WQRXB",
    source_arm: "B",
    reason: "IDENTITY_HOLD_NO_PROMO",
  },
  {
    sku: "VN-AS1A-D572",
    asin: "B0H82PKK18",
    source_arm: null,
    reason: "IDENTITY_HOLD_NO_PROMO",
  },
] as const;

export const SAFE_LAUNCH_PROMO_TIER_POLICY = [
  {
    count: 24,
    base_price: 76.99,
    floor_price: 66.95,
    effective_price: 66.98,
    discount_percent: 13,
  },
  {
    count: 30,
    base_price: 85.99,
    floor_price: 74.75,
    effective_price: 74.81,
    discount_percent: 13,
  },
  {
    count: 45,
    base_price: 130.99,
    floor_price: 114.27,
    effective_price: 115.27,
    discount_percent: 12,
  },
  {
    count: 90,
    base_price: 252.99,
    floor_price: 219.57,
    effective_price: 220.1,
    discount_percent: 13,
  },
  {
    count: 120,
    base_price: 297.99,
    floor_price: 258.57,
    effective_price: 259.25,
    discount_percent: 13,
  },
] as const;

export const SAFE_LAUNCH_PROMO_PINNED_SOURCES = {
  launch_manifest: {
    path:
      "data/repairs/launch-pricing/manifests-v4-proposal/" +
      "uncrustables-launch-pricing-20260718T181103000Z-75cebdca9037.json",
    file_sha256:
      "1f41574bde29108050a16ca0980a4fb8206200a4d26314e07d04a09cf0898f9b",
  },
  assignments: {
    path:
      "data/repairs/launch-pricing/source-v2-20260720-20260819/" +
      "launch-experiment-assignments-v2.csv",
    file_sha256:
      "dbf6b4175566194847cf365544f6a69c856225be6f6f3d2849357a7e6c1c8b51",
  },
  coupon_spec: {
    path:
      "data/repairs/launch-pricing/source-v2-20260720-20260819/" +
      "coupons-uncrustables-launch-v2-spec.csv",
    file_sha256:
      "3da9c2d2d8cb2c7d0fc3def8b115d393e09b4b7da8653a551574e36c7371e46a",
  },
  sale_price_spec: {
    path:
      "data/repairs/launch-pricing/source-v2-20260720-20260819/" +
      "salesprice-uncrustables-launch-v2-spec.csv",
    file_sha256:
      "8cbe49a2bccbbbe6ae223aa44cb1635839023c0a51af77a5171a6e9847b418d8",
  },
  safe_base_offer_manifest: {
    path:
      "data/repairs/channelmax-manual/" +
      "uncrustables-safe-base-offer-161-20260719-v1/manifest.json",
    file_sha256:
      "627c3c17b854801392864366e37617f7aa226e30835c6342c8b66c673660479e",
  },
  safe_base_offer_tsv: {
    path:
      "data/repairs/channelmax-manual/" +
      "uncrustables-safe-base-offer-161-20260719-v1/" +
      "uncrustables-channelmax-safe-manual-161-20260719T055000000Z-1475cf783747.txt",
    file_sha256:
      "1475cf7837478c91ec2b69be52b5da3e4ca58dfaacc69e8c81eadc133b8d0753",
  },
} as const;

export const SAFE_LAUNCH_PROMO_FILES = {
  assignments: "uncrustables-safe-launch-promo-assignments-161.csv",
  coupons: "uncrustables-safe-launch-promo-coupons-81.csv",
  sale_prices: "uncrustables-safe-launch-promo-sales-price-80.csv",
} as const;

const ASSIGNMENTS_HEADER =
  "ASIN,SKU,count,arm,base_item_price,effective_price,lever";
const COUPONS_HEADER =
  "ASIN list,Discount type,Coupon discount % Off value,Coupon title,Coupon budget,Coupon start date,Coupon end date,Limit redemption to one per customer,Targeted Segment";
const SALE_PRICES_HEADER =
  "ASIN,SKU,count,item_price,sale_price,start,end";

type IdentityHold = (typeof SAFE_LAUNCH_PROMO_IDENTITY_HOLDS)[number];

interface ArtifactBinding {
  path: string;
  file_sha256: string;
}

export interface SafeLaunchPromoSource {
  path: string;
  bytes: Buffer;
}

export interface BuildSafeLaunchPromoInput {
  launchManifest: SafeLaunchPromoSource;
  assignments: SafeLaunchPromoSource;
  couponSpec: SafeLaunchPromoSource;
  salePriceSpec: SafeLaunchPromoSource;
  safeBaseOfferManifest: SafeLaunchPromoSource;
  safeBaseOfferTsv: SafeLaunchPromoSource;
}

export interface SafeLaunchPromoRow extends UncrustablesLaunchPricingRow {
  ordinal: number;
}

export interface SafeLaunchPromoCouponGroup {
  count: 24 | 30 | 45 | 90 | 120;
  discount_percent: 12 | 13;
  title: string;
  budget_usd: number;
  asin_count: number;
  asins: string[];
  limit_one_per_customer: true;
  targeted_segment: "All customers";
}

export interface SafeLaunchPromoManifest {
  schema_version: typeof SAFE_LAUNCH_PROMO_SCHEMA;
  immutable: true;
  offline_only: true;
  prepared_at: typeof SAFE_LAUNCH_PROMO_PREPARED_AT;
  authority: {
    owner_approval_received: false;
    execution_authorized: false;
    amazon_live_mutations_performed: false;
    channelmax_live_mutations_performed: false;
    external_mutations: 0;
  };
  strategy: {
    experiment: "BALANCED_COUPON_VS_SALE_PRICE";
    source_revision_status: "PROPOSED_OWNER_APPROVAL_REQUIRED";
    source_original_owner_decision_date: "2026-07-13";
    assignments_preserved: true;
    arm_rebalancing_performed: false;
    base_price_immutable: true;
    equal_effective_price_within_count_tier: true;
  };
  sources: {
    launch_manifest: ArtifactBinding;
    assignments: ArtifactBinding;
    coupon_spec: ArtifactBinding;
    sale_price_spec: ArtifactBinding;
    safe_base_offer_manifest: ArtifactBinding;
    safe_base_offer_tsv: ArtifactBinding;
  };
  scope: {
    cohort_rows: 164;
    source_assigned_rows: 163;
    identity_hold_rows: 3;
    safe_promo_rows: 161;
    coupon_rows: 81;
    sale_price_rows: 80;
    coupon_group_rows: 5;
    exact_safe_base_offer_scope_match: true;
    no_extra_or_missing_skus: true;
  };
  window: typeof SAFE_LAUNCH_PROMO_WINDOW;
  identity_holds: IdentityHold[];
  tier_policy: Array<(typeof SAFE_LAUNCH_PROMO_TIER_POLICY)[number]>;
  coupon_controls: {
    total_budget_usd: 1150;
    budget_is_not_a_hard_spend_cap_acknowledged: true;
    groups: SafeLaunchPromoCouponGroup[];
  };
  rows: SafeLaunchPromoRow[];
  files: {
    assignments: {
      file: typeof SAFE_LAUNCH_PROMO_FILES.assignments;
      rows: 161;
      sha256: string;
    };
    coupons: {
      file: typeof SAFE_LAUNCH_PROMO_FILES.coupons;
      group_rows: 5;
      asin_rows: 81;
      sha256: string;
    };
    sale_prices: {
      file: typeof SAFE_LAUNCH_PROMO_FILES.sale_prices;
      rows: 80;
      sha256: string;
    };
  };
  execution_gate: {
    this_artifact_does_not_authorize_execution: true;
    separate_current_owner_approval_required: true;
    fresh_amazon_preflight_required: true;
    fresh_channelmax_manual_readback_required: true;
    identity_holds_must_remain_excluded: true;
  };
  body_sha256: string;
}

export interface BuiltSafeLaunchPromo {
  manifest: SafeLaunchPromoManifest;
  assignmentsCsv: string;
  couponsCsv: string;
  salePricesCsv: string;
}

interface AssignmentRow {
  asin: string;
  sku: string;
  count: number;
  arm: UncrustablesLaunchArm;
  basePrice: number;
  effectivePrice: number;
  lever: UncrustablesLaunchLever;
}

interface CouponGroupRow {
  asins: string[];
  discountPercent: 12 | 13;
  title: string;
  budget: number;
  start: string;
  end: string;
  count: 24 | 30 | 45 | 90 | 120;
}

interface SalePriceRow {
  asin: string;
  sku: string;
  count: number;
  itemPrice: number;
  salePrice: number;
  start: string;
  end: string;
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

export function safeLaunchPromoSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

function money(value: string, label: string): number {
  if (!/^\d+\.\d{2}$/.test(value)) {
    throw new Error(`${label} must have exact two-decimal money formatting.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive amount.`);
  }
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function splitLines(bytes: Buffer, label: string): string[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.startsWith("\uFEFF")) {
    throw new Error(`${label} must be canonical LF UTF-8 with a final newline.`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line.length)) {
    throw new Error(`${label} contains an empty row.`);
  }
  return lines;
}

function exactSource(
  source: SafeLaunchPromoSource,
  pinned: ArtifactBinding,
  label: string,
): ArtifactBinding {
  if (
    source.path !== pinned.path ||
    safeLaunchPromoSha256(source.bytes) !== pinned.file_sha256
  ) {
    throw new Error(`${label} is not the exact pinned canonical source.`);
  }
  return { path: pinned.path, file_sha256: pinned.file_sha256 };
}

function parseAssignments(bytes: Buffer): AssignmentRow[] {
  const lines = splitLines(bytes, "Assignment source");
  if (lines.shift() !== ASSIGNMENTS_HEADER) {
    throw new Error("Assignment source header is invalid.");
  }
  const skus = new Set<string>();
  const asins = new Set<string>();
  const rows = lines.map((line, index): AssignmentRow => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Assignment row ${index + 1} must have seven columns.`);
    }
    const [asin, sku, rawCount, rawArm, rawBase, rawEffective, rawLever] =
      columns;
    const count = positiveInteger(rawCount, `Assignment row ${index + 1} count`);
    if (!/^B0[A-Z0-9]{8}$/.test(asin) || !sku) {
      throw new Error(`Assignment row ${index + 1} identity is invalid.`);
    }
    if (skus.has(sku) || asins.has(asin)) {
      throw new Error(`Assignment row ${index + 1} duplicates SKU or ASIN.`);
    }
    skus.add(sku);
    asins.add(asin);
    if (rawArm !== "A" && rawArm !== "B") {
      throw new Error(`Assignment row ${index + 1} arm is invalid.`);
    }
    if (!/^((COUPON)|(SALEPRICE))_(12|13)$/.test(rawLever)) {
      throw new Error(`Assignment row ${index + 1} lever is invalid.`);
    }
    return {
      asin,
      sku,
      count,
      arm: rawArm,
      basePrice: money(rawBase, `Assignment row ${index + 1} base price`),
      effectivePrice: money(
        rawEffective,
        `Assignment row ${index + 1} effective price`,
      ),
      lever: rawLever as UncrustablesLaunchLever,
    };
  });
  if (rows.length !== 163) {
    throw new Error(`Assignment source must contain exactly 163 rows; found ${rows.length}.`);
  }
  return rows;
}

function parseCoupons(
  bytes: Buffer,
  assignmentsByAsin: Map<string, AssignmentRow>,
): CouponGroupRow[] {
  const lines = splitLines(bytes, "Coupon source");
  if (lines.shift() !== COUPONS_HEADER) {
    throw new Error("Coupon source header is invalid.");
  }
  const seen = new Set<string>();
  const groups = lines.map((line, index): CouponGroupRow => {
    const columns = line.split(",");
    if (columns.length !== 9) {
      throw new Error(`Coupon row ${index + 1} must have nine columns.`);
    }
    const [asinList, type, rawDiscount, title, rawBudget, start, end, limit, segment] =
      columns;
    const asins = asinList.split(";");
    if (!asins.length || asins.some((asin) => !/^B0[A-Z0-9]{8}$/.test(asin))) {
      throw new Error(`Coupon row ${index + 1} ASIN list is invalid.`);
    }
    const assignments = asins.map((asin) => assignmentsByAsin.get(asin));
    if (assignments.some((row) => !row || row.arm !== "A")) {
      throw new Error(`Coupon row ${index + 1} does not map exactly to Arm A.`);
    }
    const counts = new Set(assignments.map((row) => row?.count));
    if (
      counts.size !== 1 ||
      type !== "% off" ||
      !["12", "13"].includes(rawDiscount) ||
      !/^\d+$/.test(rawBudget) ||
      start !== SAFE_LAUNCH_PROMO_WINDOW.start_date ||
      end !== SAFE_LAUNCH_PROMO_WINDOW.end_date ||
      limit !== "Yes" ||
      segment !== "All customers"
    ) {
      throw new Error(`Coupon row ${index + 1} policy is invalid.`);
    }
    for (const asin of asins) {
      if (seen.has(asin)) throw new Error(`Coupon source duplicates ASIN ${asin}.`);
      seen.add(asin);
    }
    return {
      asins,
      discountPercent: Number(rawDiscount) as 12 | 13,
      title,
      budget: Number(rawBudget),
      start,
      end,
      count: [...counts][0] as CouponGroupRow["count"],
    };
  });
  const expected = [...assignmentsByAsin.values()].filter((row) => row.arm === "A");
  if (
    groups.length !== 5 ||
    seen.size !== 82 ||
    expected.length !== 82 ||
    expected.some((row) => !seen.has(row.asin))
  ) {
    throw new Error("Coupon source must cover exact 82-row Arm A in five groups.");
  }
  return groups;
}

function parseSalePrices(
  bytes: Buffer,
  assignmentsBySku: Map<string, AssignmentRow>,
): SalePriceRow[] {
  const lines = splitLines(bytes, "Sale Price source");
  if (lines.shift() !== SALE_PRICES_HEADER) {
    throw new Error("Sale Price source header is invalid.");
  }
  const seen = new Set<string>();
  const rows = lines.map((line, index): SalePriceRow => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Sale Price row ${index + 1} must have seven columns.`);
    }
    const [asin, sku, rawCount, rawItem, rawSale, start, end] = columns;
    const assignment = assignmentsBySku.get(sku);
    if (
      !assignment ||
      assignment.asin !== asin ||
      assignment.arm !== "B" ||
      seen.has(sku) ||
      start !== SAFE_LAUNCH_PROMO_WINDOW.start_date ||
      end !== SAFE_LAUNCH_PROMO_WINDOW.end_date
    ) {
      throw new Error(`Sale Price row ${index + 1} does not map exactly to Arm B.`);
    }
    seen.add(sku);
    const count = positiveInteger(rawCount, `Sale Price row ${index + 1} count`);
    const itemPrice = money(rawItem, `Sale Price row ${index + 1} item price`);
    const salePrice = money(rawSale, `Sale Price row ${index + 1} sale price`);
    if (
      count !== assignment.count ||
      !exactMoney(itemPrice, assignment.basePrice) ||
      !exactMoney(salePrice, assignment.effectivePrice)
    ) {
      throw new Error(`Sale Price row ${index + 1} contradicts its assignment.`);
    }
    return { asin, sku, count, itemPrice, salePrice, start, end };
  });
  const expected = [...assignmentsBySku.values()].filter((row) => row.arm === "B");
  if (
    rows.length !== 81 ||
    seen.size !== 81 ||
    expected.length !== 81 ||
    expected.some((row) => !seen.has(row.sku))
  ) {
    throw new Error("Sale Price source must cover exact 81-row Arm B.");
  }
  return rows;
}

function verifySourceManifestAlignment(
  manifest: UncrustablesLaunchPricingManifest,
  assignments: AssignmentRow[],
  couponGroups: CouponGroupRow[],
  salePrices: SalePriceRow[],
): void {
  if (
    manifest.decision.revision_status !== "PROPOSED_OWNER_APPROVAL_REQUIRED" ||
    manifest.scope.rows !== 163 ||
    manifest.scope.coupon_rows !== 82 ||
    manifest.scope.sale_price_rows !== 81 ||
    manifest.scope.start_at !== SAFE_LAUNCH_PROMO_WINDOW.start_at ||
    manifest.scope.end_at !== SAFE_LAUNCH_PROMO_WINDOW.end_at
  ) {
    throw new Error("Pinned launch manifest is not the expected unapproved 163-row strategy.");
  }
  const manifestBySku = new Map(manifest.rows.map((row) => [row.sku, row]));
  for (const assignment of assignments) {
    const row = manifestBySku.get(assignment.sku);
    if (
      !row ||
      row.asin !== assignment.asin ||
      row.count !== assignment.count ||
      row.arm !== assignment.arm ||
      row.lever !== assignment.lever ||
      !exactMoney(row.base_price, assignment.basePrice) ||
      !exactMoney(row.effective_price, assignment.effectivePrice)
    ) {
      throw new Error(`Assignment source contradicts launch manifest for ${assignment.sku}.`);
    }
  }
  if (manifestBySku.size !== assignments.length) {
    throw new Error("Assignment source and launch manifest scope differ.");
  }
  for (const group of couponGroups) {
    const policy = manifest.coupon_controls.groups.find(
      (candidate) => candidate.count === group.count,
    );
    if (
      !policy ||
      policy.discount_percent !== group.discountPercent ||
      policy.title !== group.title ||
      policy.budget_usd !== group.budget ||
      policy.asin_count !== group.asins.length
    ) {
      throw new Error(`Coupon group ${group.count} contradicts launch manifest.`);
    }
  }
  const saleBySku = new Map(salePrices.map((row) => [row.sku, row]));
  for (const row of manifest.rows.filter((candidate) => candidate.arm === "B")) {
    const sale = saleBySku.get(row.sku);
    if (
      !sale ||
      row.sale_price_schedule?.start_at !== SAFE_LAUNCH_PROMO_WINDOW.start_at ||
      row.sale_price_schedule.end_at !== SAFE_LAUNCH_PROMO_WINDOW.end_at ||
      !exactMoney(row.sale_price_schedule.value_with_tax, sale.salePrice)
    ) {
      throw new Error(`Sale Price source contradicts launch manifest for ${row.sku}.`);
    }
  }
}

function verifyIdentityHoldInputs(
  manifest: UncrustablesLaunchPricingManifest,
  assignmentsBySku: Map<string, AssignmentRow>,
  couponGroups: CouponGroupRow[],
  salePrices: SalePriceRow[],
  safeBaseOffer: SafeBaseOfferChannelMaxManualManifest,
): void {
  const sourceCouponAsins = new Set(couponGroups.flatMap((group) => group.asins));
  const sourceSaleSkus = new Set(salePrices.map((row) => row.sku));
  const sz = assignmentsBySku.get("SZ-ASPI-JFAT");
  const ty = assignmentsBySku.get("TY-AST2-JE9P");
  if (
    !sz ||
    sz.asin !== "B0H776M5B5" ||
    sz.arm !== "A" ||
    !sourceCouponAsins.has(sz.asin) ||
    !ty ||
    ty.asin !== "B0H84WQRXB" ||
    ty.arm !== "B" ||
    !sourceSaleSkus.has(ty.sku) ||
    assignmentsBySku.has("VN-AS1A-D572") ||
    !manifest.pre_assignment_exclusions.some(
      (row) => row.sku === "VN-AS1A-D572" && row.asin === "B0H82PKK18",
    )
  ) {
    throw new Error("Pinned strategy does not preserve the exact SZ/TY/VN hold lineage.");
  }
  const safeHolds = safeBaseOffer.identity_holds.map((row) => ({
    sku: row.sku,
    asin: row.amazon_asin,
  }));
  const expectedHolds = SAFE_LAUNCH_PROMO_IDENTITY_HOLDS.map((row) => ({
    sku: row.sku,
    asin: row.asin,
  }));
  if (stableJson(safeHolds) !== stableJson(expectedHolds)) {
    throw new Error("Safe base-offer scope does not carry the exact SZ/TY/VN holds.");
  }
}

function assignmentCsv(rows: SafeLaunchPromoRow[]): string {
  return `${[
    ASSIGNMENTS_HEADER,
    ...rows.map((row) =>
      [
        row.asin,
        row.sku,
        row.count,
        row.arm,
        row.base_price.toFixed(2),
        row.effective_price.toFixed(2),
        row.lever,
      ].join(","),
    ),
  ].join("\n")}\n`;
}

function couponCsv(groups: SafeLaunchPromoCouponGroup[]): string {
  return `${[
    COUPONS_HEADER,
    ...groups.map((group) =>
      [
        group.asins.join(";"),
        "% off",
        group.discount_percent,
        group.title,
        group.budget_usd,
        SAFE_LAUNCH_PROMO_WINDOW.start_date,
        SAFE_LAUNCH_PROMO_WINDOW.end_date,
        "Yes",
        group.targeted_segment,
      ].join(","),
    ),
  ].join("\n")}\n`;
}

function salePriceCsv(rows: SafeLaunchPromoRow[]): string {
  return `${[
    SALE_PRICES_HEADER,
    ...rows
      .filter((row) => row.arm === "B")
      .map((row) =>
        [
          row.asin,
          row.sku,
          row.count,
          row.base_price.toFixed(2),
          row.effective_price.toFixed(2),
          SAFE_LAUNCH_PROMO_WINDOW.start_date,
          SAFE_LAUNCH_PROMO_WINDOW.end_date,
        ].join(","),
      ),
  ].join("\n")}\n`;
}

export function safeLaunchPromoManifestBodySha256(
  manifest: Omit<SafeLaunchPromoManifest, "body_sha256"> | SafeLaunchPromoManifest,
): string {
  const body = { ...(manifest as unknown as Record<string, unknown>) };
  delete body.body_sha256;
  return safeLaunchPromoSha256(stableJson(body));
}

function assertPinnedBindings(manifest: SafeLaunchPromoManifest): void {
  for (const key of Object.keys(SAFE_LAUNCH_PROMO_PINNED_SOURCES) as Array<
    keyof typeof SAFE_LAUNCH_PROMO_PINNED_SOURCES
  >) {
    const expected = SAFE_LAUNCH_PROMO_PINNED_SOURCES[key];
    const actual = manifest.sources[key];
    if (
      !actual ||
      actual.path !== expected.path ||
      actual.file_sha256 !== expected.file_sha256
    ) {
      throw new Error(`Safe launch promo source binding ${key} is invalid.`);
    }
  }
}

export function verifySafeLaunchPromoArtifact(
  manifest: SafeLaunchPromoManifest,
  files: {
    assignmentsCsv: string;
    couponsCsv: string;
    salePricesCsv: string;
  },
): SafeLaunchPromoManifest {
  if (
    manifest.schema_version !== SAFE_LAUNCH_PROMO_SCHEMA ||
    manifest.immutable !== true ||
    manifest.offline_only !== true ||
    manifest.prepared_at !== SAFE_LAUNCH_PROMO_PREPARED_AT ||
    manifest.authority?.owner_approval_received !== false ||
    manifest.authority.execution_authorized !== false ||
    manifest.authority.amazon_live_mutations_performed !== false ||
    manifest.authority.channelmax_live_mutations_performed !== false ||
    manifest.authority.external_mutations !== 0
  ) {
    throw new Error("Safe launch promo authority or offline boundary is invalid.");
  }
  if (
    manifest.strategy?.experiment !== "BALANCED_COUPON_VS_SALE_PRICE" ||
    manifest.strategy.source_revision_status !==
      "PROPOSED_OWNER_APPROVAL_REQUIRED" ||
    manifest.strategy.source_original_owner_decision_date !== "2026-07-13" ||
    manifest.strategy.assignments_preserved !== true ||
    manifest.strategy.arm_rebalancing_performed !== false ||
    manifest.strategy.base_price_immutable !== true ||
    manifest.strategy.equal_effective_price_within_count_tier !== true ||
    stableJson(manifest.window) !== stableJson(SAFE_LAUNCH_PROMO_WINDOW) ||
    stableJson(manifest.identity_holds) !==
      stableJson(SAFE_LAUNCH_PROMO_IDENTITY_HOLDS) ||
    stableJson(manifest.tier_policy) !== stableJson(SAFE_LAUNCH_PROMO_TIER_POLICY)
  ) {
    throw new Error("Safe launch promo strategy, window, holds, or tier policy drifted.");
  }
  assertPinnedBindings(manifest);
  if (
    manifest.scope?.cohort_rows !== 164 ||
    manifest.scope.source_assigned_rows !== 163 ||
    manifest.scope.identity_hold_rows !== 3 ||
    manifest.scope.safe_promo_rows !== 161 ||
    manifest.scope.coupon_rows !== 81 ||
    manifest.scope.sale_price_rows !== 80 ||
    manifest.scope.coupon_group_rows !== 5 ||
    manifest.scope.exact_safe_base_offer_scope_match !== true ||
    manifest.scope.no_extra_or_missing_skus !== true ||
    !Array.isArray(manifest.rows) ||
    manifest.rows.length !== 161
  ) {
    throw new Error("Safe launch promo scope is not exact 161 / 81 / 80.");
  }
  const heldSkus = new Set<string>(SAFE_LAUNCH_PROMO_IDENTITY_HOLDS.map((row) => row.sku));
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  let couponRows = 0;
  let saleRows = 0;
  for (const [index, row] of manifest.rows.entries()) {
    const tier = SAFE_LAUNCH_PROMO_TIER_POLICY.find(
      (candidate) => candidate.count === row.count,
    );
    const expectedLever = `${row.arm === "A" ? "COUPON" : "SALEPRICE"}_${row.discount_percent}`;
    if (
      row.ordinal !== index + 1 ||
      !/^B0[A-Z0-9]{8}$/.test(row.asin) ||
      !row.sku ||
      heldSkus.has(row.sku) ||
      seenSkus.has(row.sku) ||
      seenAsins.has(row.asin) ||
      !tier ||
      !exactMoney(row.base_price, tier.base_price) ||
      !exactMoney(row.floor_price, tier.floor_price) ||
      !exactMoney(row.effective_price, tier.effective_price) ||
      row.discount_percent !== tier.discount_percent ||
      row.lever !== expectedLever
    ) {
      throw new Error(`Safe launch promo row ${index + 1} is invalid.`);
    }
    seenSkus.add(row.sku);
    seenAsins.add(row.asin);
    if (row.arm === "A") {
      couponRows++;
      if (row.sale_price_schedule !== null) {
        throw new Error(`Coupon row ${row.sku} carries a Sale Price schedule.`);
      }
    } else if (row.arm === "B") {
      saleRows++;
      if (
        row.sale_price_schedule?.start_at !== SAFE_LAUNCH_PROMO_WINDOW.start_at ||
        row.sale_price_schedule.end_at !== SAFE_LAUNCH_PROMO_WINDOW.end_at ||
        !exactMoney(
          row.sale_price_schedule.value_with_tax,
          row.effective_price,
        )
      ) {
        throw new Error(`Sale Price row ${row.sku} schedule is invalid.`);
      }
    } else {
      throw new Error(`Safe launch promo row ${row.sku} arm is invalid.`);
    }
  }
  if (couponRows !== 81 || saleRows !== 80) {
    throw new Error("Safe launch promo arms are not exact 81 / 80.");
  }
  if (
    manifest.coupon_controls?.total_budget_usd !== 1150 ||
    manifest.coupon_controls.budget_is_not_a_hard_spend_cap_acknowledged !== true ||
    !Array.isArray(manifest.coupon_controls.groups) ||
    manifest.coupon_controls.groups.length !== 5
  ) {
    throw new Error("Safe launch promo coupon controls are invalid.");
  }
  const couponAsins = new Set<string>();
  for (const [index, expectedPolicy] of UNCRUSTABLES_COUPON_GROUP_POLICIES.entries()) {
    const group = manifest.coupon_controls.groups[index];
    const expectedAsins = manifest.rows
      .filter((row) => row.arm === "A" && row.count === expectedPolicy.count)
      .map((row) => row.asin);
    if (
      !group ||
      group.count !== expectedPolicy.count ||
      group.discount_percent !== expectedPolicy.discount_percent ||
      group.title !== expectedPolicy.title ||
      group.budget_usd !== expectedPolicy.budget_usd ||
      group.asin_count !== group.asins.length ||
      group.asin_count !== expectedAsins.length ||
      group.limit_one_per_customer !== true ||
      group.targeted_segment !== "All customers" ||
      stableJson([...group.asins].sort()) !== stableJson([...expectedAsins].sort())
    ) {
      throw new Error(`Safe launch promo coupon group ${expectedPolicy.count} is invalid.`);
    }
    for (const asin of group.asins) {
      if (couponAsins.has(asin)) {
        throw new Error(`Safe launch promo coupon ASIN ${asin} is duplicated.`);
      }
      couponAsins.add(asin);
    }
  }
  if (couponAsins.size !== 81) {
    throw new Error("Safe launch promo coupons do not cover exact 81 ASINs.");
  }
  const expectedAssignments = assignmentCsv(manifest.rows);
  const expectedCoupons = couponCsv(manifest.coupon_controls.groups);
  const expectedSalePrices = salePriceCsv(manifest.rows);
  if (
    files.assignmentsCsv !== expectedAssignments ||
    files.couponsCsv !== expectedCoupons ||
    files.salePricesCsv !== expectedSalePrices ||
    manifest.files?.assignments.file !== SAFE_LAUNCH_PROMO_FILES.assignments ||
    manifest.files.assignments.rows !== 161 ||
    manifest.files.assignments.sha256 !==
      safeLaunchPromoSha256(files.assignmentsCsv) ||
    manifest.files.coupons.file !== SAFE_LAUNCH_PROMO_FILES.coupons ||
    manifest.files.coupons.group_rows !== 5 ||
    manifest.files.coupons.asin_rows !== 81 ||
    manifest.files.coupons.sha256 !== safeLaunchPromoSha256(files.couponsCsv) ||
    manifest.files.sale_prices.file !== SAFE_LAUNCH_PROMO_FILES.sale_prices ||
    manifest.files.sale_prices.rows !== 80 ||
    manifest.files.sale_prices.sha256 !==
      safeLaunchPromoSha256(files.salePricesCsv)
  ) {
    throw new Error("Safe launch promo files or output bindings are invalid.");
  }
  if (
    manifest.execution_gate?.this_artifact_does_not_authorize_execution !== true ||
    manifest.execution_gate.separate_current_owner_approval_required !== true ||
    manifest.execution_gate.fresh_amazon_preflight_required !== true ||
    manifest.execution_gate.fresh_channelmax_manual_readback_required !== true ||
    manifest.execution_gate.identity_holds_must_remain_excluded !== true
  ) {
    throw new Error("Safe launch promo execution gate is weakened.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.body_sha256) ||
    manifest.body_sha256 !== safeLaunchPromoManifestBodySha256(manifest)
  ) {
    throw new Error("Safe launch promo body SHA-256 is invalid.");
  }
  return manifest;
}

export function buildSafeLaunchPromoArtifact(
  input: BuildSafeLaunchPromoInput,
): BuiltSafeLaunchPromo {
  const sources = {
    launch_manifest: exactSource(
      input.launchManifest,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.launch_manifest,
      "Launch manifest",
    ),
    assignments: exactSource(
      input.assignments,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.assignments,
      "Assignment source",
    ),
    coupon_spec: exactSource(
      input.couponSpec,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.coupon_spec,
      "Coupon source",
    ),
    sale_price_spec: exactSource(
      input.salePriceSpec,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.sale_price_spec,
      "Sale Price source",
    ),
    safe_base_offer_manifest: exactSource(
      input.safeBaseOfferManifest,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.safe_base_offer_manifest,
      "Safe base-offer manifest",
    ),
    safe_base_offer_tsv: exactSource(
      input.safeBaseOfferTsv,
      SAFE_LAUNCH_PROMO_PINNED_SOURCES.safe_base_offer_tsv,
      "Safe base-offer TSV",
    ),
  };
  const launchManifest = verifyUncrustablesLaunchPricingManifest(
    JSON.parse(input.launchManifest.bytes.toString("utf8")) as unknown,
  );
  const safeBaseOffer = JSON.parse(
    input.safeBaseOfferManifest.bytes.toString("utf8"),
  ) as SafeBaseOfferChannelMaxManualManifest;
  verifySafeBaseOfferChannelMaxManualAssignment(
    safeBaseOffer,
    input.safeBaseOfferTsv.bytes.toString("utf8"),
  );
  const assignments = parseAssignments(input.assignments.bytes);
  const assignmentsBySku = new Map(assignments.map((row) => [row.sku, row]));
  const assignmentsByAsin = new Map(assignments.map((row) => [row.asin, row]));
  const couponGroups = parseCoupons(input.couponSpec.bytes, assignmentsByAsin);
  const salePrices = parseSalePrices(input.salePriceSpec.bytes, assignmentsBySku);
  verifySourceManifestAlignment(
    launchManifest,
    assignments,
    couponGroups,
    salePrices,
  );
  verifyIdentityHoldInputs(
    launchManifest,
    assignmentsBySku,
    couponGroups,
    salePrices,
    safeBaseOffer,
  );

  const heldSkus = new Set<string>(SAFE_LAUNCH_PROMO_IDENTITY_HOLDS.map((row) => row.sku));
  const manifestBySku = new Map(launchManifest.rows.map((row) => [row.sku, row]));
  const rows: SafeLaunchPromoRow[] = assignments
    .filter((row) => !heldSkus.has(row.sku))
    .map((assignment, index) => {
      const source = manifestBySku.get(assignment.sku);
      if (!source) throw new Error(`Missing launch row for ${assignment.sku}.`);
      return {
        ordinal: index + 1,
        ...source,
        sale_price_schedule: source.sale_price_schedule
          ? { ...source.sale_price_schedule }
          : null,
      };
    });
  const safeBaseBySku = new Map(safeBaseOffer.rows.map((row) => [row.sku, row]));
  if (rows.length !== 161 || safeBaseBySku.size !== 161) {
    throw new Error("Safe launch and base-offer scopes must both contain exactly 161 rows.");
  }
  for (const row of rows) {
    const base = safeBaseBySku.get(row.sku);
    if (
      !base ||
      base.asin !== row.asin ||
      !exactMoney(base.base_price, row.base_price) ||
      !exactMoney(base.minimum_selling_price, row.floor_price) ||
      !exactMoney(base.maximum_selling_price, row.base_price)
    ) {
      throw new Error(`Safe promo/base-offer scope differs for ${row.sku}.`);
    }
  }
  if (safeBaseBySku.size !== rows.length) {
    throw new Error("Safe promo/base-offer scope contains an extra or missing SKU.");
  }

  const safeCouponGroups: SafeLaunchPromoCouponGroup[] = couponGroups.map((group) => {
    const asins = group.asins.filter((asin) =>
      rows.some((row) => row.arm === "A" && row.asin === asin),
    );
    return {
      count: group.count,
      discount_percent: group.discountPercent,
      title: group.title,
      budget_usd: group.budget,
      asin_count: asins.length,
      asins,
      limit_one_per_customer: true,
      targeted_segment: "All customers",
    };
  });
  const assignmentsCsv = assignmentCsv(rows);
  const couponsCsv = couponCsv(safeCouponGroups);
  const salePricesCsv = salePriceCsv(rows);
  const partial = {
    schema_version: SAFE_LAUNCH_PROMO_SCHEMA,
    immutable: true,
    offline_only: true,
    prepared_at: SAFE_LAUNCH_PROMO_PREPARED_AT,
    authority: {
      owner_approval_received: false,
      execution_authorized: false,
      amazon_live_mutations_performed: false,
      channelmax_live_mutations_performed: false,
      external_mutations: 0,
    },
    strategy: {
      experiment: "BALANCED_COUPON_VS_SALE_PRICE",
      source_revision_status: "PROPOSED_OWNER_APPROVAL_REQUIRED",
      source_original_owner_decision_date: "2026-07-13",
      assignments_preserved: true,
      arm_rebalancing_performed: false,
      base_price_immutable: true,
      equal_effective_price_within_count_tier: true,
    },
    sources,
    scope: {
      cohort_rows: 164,
      source_assigned_rows: 163,
      identity_hold_rows: 3,
      safe_promo_rows: 161,
      coupon_rows: 81,
      sale_price_rows: 80,
      coupon_group_rows: 5,
      exact_safe_base_offer_scope_match: true,
      no_extra_or_missing_skus: true,
    },
    window: { ...SAFE_LAUNCH_PROMO_WINDOW },
    identity_holds: SAFE_LAUNCH_PROMO_IDENTITY_HOLDS.map((row) => ({ ...row })),
    tier_policy: SAFE_LAUNCH_PROMO_TIER_POLICY.map((row) => ({ ...row })),
    coupon_controls: {
      total_budget_usd: 1150,
      budget_is_not_a_hard_spend_cap_acknowledged: true,
      groups: safeCouponGroups,
    },
    rows,
    files: {
      assignments: {
        file: SAFE_LAUNCH_PROMO_FILES.assignments,
        rows: 161,
        sha256: safeLaunchPromoSha256(assignmentsCsv),
      },
      coupons: {
        file: SAFE_LAUNCH_PROMO_FILES.coupons,
        group_rows: 5,
        asin_rows: 81,
        sha256: safeLaunchPromoSha256(couponsCsv),
      },
      sale_prices: {
        file: SAFE_LAUNCH_PROMO_FILES.sale_prices,
        rows: 80,
        sha256: safeLaunchPromoSha256(salePricesCsv),
      },
    },
    execution_gate: {
      this_artifact_does_not_authorize_execution: true,
      separate_current_owner_approval_required: true,
      fresh_amazon_preflight_required: true,
      fresh_channelmax_manual_readback_required: true,
      identity_holds_must_remain_excluded: true,
    },
  } satisfies Omit<SafeLaunchPromoManifest, "body_sha256">;
  const manifest: SafeLaunchPromoManifest = {
    ...partial,
    body_sha256: safeLaunchPromoManifestBodySha256(partial),
  };
  verifySafeLaunchPromoArtifact(manifest, {
    assignmentsCsv,
    couponsCsv,
    salePricesCsv,
  });
  return { manifest, assignmentsCsv, couponsCsv, salePricesCsv };
}
