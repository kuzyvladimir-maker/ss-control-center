/**
 * Build the immutable owner-approved Coupon-vs-Sale-Price launch layer.
 *
 * This script is offline. It validates the three July 2026 experiment files,
 * reconciles every ASIN/SKU, binds the canonical Layer A price/floor, and
 * emits a SHA-sealed JSON manifest. It never calls Amazon, ChannelMax, or a DB.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
  UNCRUSTABLES_LAUNCH_COHORT_ROWS,
  UNCRUSTABLES_COUPON_GROUP_POLICIES,
  UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION,
  launchPricingManifestBodySha256,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesCouponGroupPolicy,
  type UncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingRow,
  type UncrustablesLaunchLever,
} from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";
import { priceFor } from "@/lib/pricing/cost-model";

const DEFAULT_OUTPUT_DIR = "data/repairs/launch-pricing";
const DEFAULT_EXCLUDED_SKUS = ["TY-AST2-JE9P"];

interface Options {
  assignments: string;
  coupons: string;
  salePrices: string;
  outputDir: string;
  reviewedAt: string;
  excludedSkus: string[];
  ownerApprovedAt: string | null;
}

interface Assignment {
  asin: string;
  sku: string;
  count: number;
  arm: "A" | "B";
  basePrice: number;
  effectivePrice: number;
  lever: UncrustablesLaunchLever;
}

interface SalePriceSpec {
  asin: string;
  sku: string;
  count: number;
  itemPrice: number;
  salePrice: number;
  start: string;
  end: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    assignments: "",
    coupons: "",
    salePrices: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    reviewedAt: new Date().toISOString(),
    excludedSkus: [...DEFAULT_EXCLUDED_SKUS],
    ownerApprovedAt: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--assignments=")) {
      options.assignments = arg.slice("--assignments=".length);
    } else if (arg.startsWith("--coupons=")) {
      options.coupons = arg.slice("--coupons=".length);
    } else if (arg.startsWith("--sale-prices=")) {
      options.salePrices = arg.slice("--sale-prices=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--reviewed-at=")) {
      options.reviewedAt = new Date(arg.slice("--reviewed-at=".length)).toISOString();
    } else if (arg.startsWith("--exclude-skus=")) {
      options.excludedSkus = arg
        .slice("--exclude-skus=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--owner-approved-at=")) {
      options.ownerApprovedAt = new Date(
        arg.slice("--owner-approved-at=".length),
      ).toISOString();
    } else if (arg === "--help") {
      console.log(
        [
          "Usage: npx tsx scripts/build-uncrustables-launch-pricing-manifest.ts [options]",
          "  --assignments=PATH required corrected assignment source",
          "  --coupons=PATH     required corrected coupon spec",
          "  --sale-prices=PATH required corrected Sale Price spec",
          `  --output-dir=PATH  (default ${DEFAULT_OUTPUT_DIR})`,
          "  --reviewed-at=ISO  deterministic manifest timestamp",
          `  --exclude-skus=A,B (default ${DEFAULT_EXCLUDED_SKUS.join(",")})`,
          "  --owner-approved-at=ISO omit while this safety revision is only proposed",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.assignments || !options.coupons || !options.salePrices) {
    throw new Error(
      "--assignments, --coupons, and --sale-prices are all required; historical public files are unsafe defaults.",
    );
  }
  return options;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lines(bytes: Buffer): string[] {
  return bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function amount(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} is not a positive amount.`);
  }
  return Math.round(parsed * 100) / 100;
}

function count(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} is not a positive integer.`);
  }
  return parsed;
}

function equalMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

function discountFromLever(
  lever: string,
  label: string,
): 12 | 13 {
  const match = /^(?:COUPON|SALEPRICE)_(12|13)$/.exec(lever);
  if (!match) throw new Error(`${label} has an unsupported launch lever.`);
  return Number(match[1]) as 12 | 13;
}

function parseAssignments(bytes: Buffer): Assignment[] {
  const rows = lines(bytes);
  if (rows.shift() !== "ASIN,SKU,count,arm,base_item_price,effective_price,lever") {
    throw new Error("Unexpected launch assignment header.");
  }
  return rows.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Assignment row ${index + 1} has ${columns.length} columns.`);
    }
    const [asin, sku, rawCount, arm, base, effective, lever] = columns;
    if (arm !== "A" && arm !== "B") throw new Error(`Invalid arm for ${sku}.`);
    discountFromLever(lever, sku);
    const expectedPrefix = arm === "A" ? "COUPON_" : "SALEPRICE_";
    if (!lever.startsWith(expectedPrefix)) throw new Error(`Invalid lever for ${sku}.`);
    return {
      asin,
      sku,
      count: count(rawCount, `${sku} count`),
      arm,
      basePrice: amount(base, `${sku} base price`),
      effectivePrice: amount(effective, `${sku} effective price`),
      lever: lever as UncrustablesLaunchLever,
    };
  });
}

function parseSalePrices(bytes: Buffer): SalePriceSpec[] {
  const rows = lines(bytes);
  if (rows.shift() !== "ASIN,SKU,count,item_price,sale_price,start,end") {
    throw new Error("Unexpected Sale Price header.");
  }
  return rows.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Sale Price row ${index + 1} has ${columns.length} columns.`);
    }
    const [asin, sku, rawCount, itemPrice, salePrice, start, end] = columns;
    return {
      asin,
      sku,
      count: count(rawCount, `${sku} count`),
      itemPrice: amount(itemPrice, `${sku} item price`),
      salePrice: amount(salePrice, `${sku} sale price`),
      start,
      end,
    };
  });
}

function parseCouponAsins(bytes: Buffer): {
  discountsByAsin: Map<string, 12 | 13>;
  groups: Array<{
    asins: string[];
    discountPercent: 12 | 13;
    title: string;
    budgetUsd: number;
    limitOnePerCustomer: string;
    targetedSegment: string;
  }>;
  rows: number;
  start: string;
  end: string;
} {
  const rows = lines(bytes);
  const header = rows.shift();
  if (!header?.startsWith("ASIN list,Discount type,Coupon discount % Off value,")) {
    throw new Error("Unexpected coupon flat-file header.");
  }
  const discountsByAsin = new Map<string, 12 | 13>();
  const groups: Array<{
    asins: string[];
    discountPercent: 12 | 13;
    title: string;
    budgetUsd: number;
    limitOnePerCustomer: string;
    targetedSegment: string;
  }> = [];
  let sharedStart: string | null = null;
  let sharedEnd: string | null = null;
  for (const [index, line] of rows.entries()) {
    const columns = line.split(",");
    if (columns.length !== 9) {
      throw new Error(`Coupon row ${index + 1} has ${columns.length} columns.`);
    }
    const [
      asinList,
      discountType,
      rawDiscount,
      title,
      rawBudget,
      start,
      end,
      limitOnePerCustomer,
      targetedSegment,
    ] = columns;
    const discount = Number(rawDiscount);
    if (discountType !== "% off" || (discount !== 12 && discount !== 13)) {
      throw new Error(`Coupon row ${index + 1} must use a reviewed 12% or 13% discount.`);
    }
    if (!title.trim() || title.includes("%")) {
      throw new Error(
        `Coupon row ${index + 1} title is empty or improperly repeats a discount percentage.`,
      );
    }
    const budgetUsd = amount(rawBudget, `Coupon row ${index + 1} budget`);
    if (
      limitOnePerCustomer !== "Yes" ||
      targetedSegment !== "All customers"
    ) {
      throw new Error(
        `Coupon row ${index + 1} must be one-per-customer and target All customers.`,
      );
    }
    if (sharedStart != null && sharedStart !== start) {
      throw new Error("Coupon rows use different start dates.");
    }
    if (sharedEnd != null && sharedEnd !== end) {
      throw new Error("Coupon rows use different end dates.");
    }
    sharedStart = start;
    sharedEnd = end;
    const asins = asinList.split(";").filter(Boolean);
    for (const asin of asins) {
      if (!/^B0[A-Z0-9]{8}$/.test(asin)) {
        throw new Error(`Coupon ASIN ${asin} is invalid.`);
      }
      if (discountsByAsin.has(asin)) {
        throw new Error(`Coupon ASIN ${asin} is duplicated.`);
      }
      discountsByAsin.set(asin, discount as 12 | 13);
    }
    groups.push({
      asins,
      discountPercent: discount as 12 | 13,
      title,
      budgetUsd,
      limitOnePerCustomer,
      targetedSegment,
    });
  }
  if (!sharedStart || !sharedEnd) throw new Error("Coupon dates are missing.");
  return {
    discountsByAsin,
    groups,
    rows: rows.length,
    start: sharedStart,
    end: sharedEnd,
  };
}

function startInstant(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toISOString();
}

function endInstant(date: string): string {
  return new Date(`${date}T23:59:59.000Z`).toISOString();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [assignmentBytes, couponBytes, salePriceBytes] = await Promise.all([
    readFile(options.assignments),
    readFile(options.coupons),
    readFile(options.salePrices),
  ]);
  const assignments = parseAssignments(assignmentBytes);
  const coupons = parseCouponAsins(couponBytes);
  const salePrices = parseSalePrices(salePriceBytes);
  const preAssignmentExclusions = [
    { ...UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION },
  ];
  if (
    assignments.length + preAssignmentExclusions.length !==
      UNCRUSTABLES_LAUNCH_COHORT_ROWS ||
    assignments.some(
      (row) =>
        row.sku === UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION.sku ||
        row.asin === UNCRUSTABLES_REQUIRED_PRE_ASSIGNMENT_EXCLUSION.asin,
    )
  ) {
    throw new Error(
      `Launch assignments must contain exactly ${UNCRUSTABLES_LAUNCH_COHORT_ROWS - preAssignmentExclusions.length} identities and omit the sealed VN pre-assignment exclusion.`,
    );
  }
  const saleBySku = new Map(salePrices.map((row) => [row.sku, row]));
  if (saleBySku.size !== salePrices.length) throw new Error("Duplicate Sale Price SKU.");
  const couponAssignments = assignments.filter((row) => row.arm === "A");
  const saleAssignments = assignments.filter((row) => row.arm === "B");
  const expectedCouponAsins = new Set(couponAssignments.map((row) => row.asin));
  if (
    expectedCouponAsins.size !== coupons.discountsByAsin.size ||
    [...expectedCouponAsins].some(
      (asin) => !coupons.discountsByAsin.has(asin),
    )
  ) {
    throw new Error("Coupon flat file does not cover the exact Arm A ASIN set.");
  }
  const assignmentByAsin = new Map(assignments.map((row) => [row.asin, row]));
  const couponControls = coupons.groups
    .map((group): UncrustablesCouponGroupPolicy => {
      const groupAssignments = group.asins.map((asin) => assignmentByAsin.get(asin));
      const counts = new Set(groupAssignments.map((row) => row?.count));
      if (
        groupAssignments.some((row) => !row || row.arm !== "A") ||
        counts.size !== 1
      ) {
        throw new Error("Coupon group does not map to exactly one Arm A count tier.");
      }
      const groupCount = [...counts][0];
      const expected = UNCRUSTABLES_COUPON_GROUP_POLICIES.find(
        (candidate) => candidate.count === groupCount,
      );
      if (
        !expected ||
        group.discountPercent !== expected.discount_percent ||
        group.title !== expected.title ||
        group.budgetUsd !== expected.budget_usd
      ) {
        throw new Error(`Coupon controls for ${String(groupCount)} count are not approved.`);
      }
      return {
        count: expected.count,
        discount_percent: expected.discount_percent,
        title: expected.title,
        budget_usd: expected.budget_usd,
        asin_count: group.asins.length,
        limit_one_per_customer: true,
        targeted_segment: "All customers",
      };
    })
    .sort((left, right) => left.count - right.count);
  if (
    couponControls.length !== UNCRUSTABLES_COUPON_GROUP_POLICIES.length ||
    new Set(couponControls.map((group) => group.count)).size !==
      UNCRUSTABLES_COUPON_GROUP_POLICIES.length
  ) {
    throw new Error("Coupon spec must contain the exact five approved count groups.");
  }
  const couponBudgetTotal = couponControls.reduce(
    (sum, group) => sum + group.budget_usd,
    0,
  );
  if (couponBudgetTotal !== 1150) {
    throw new Error("Coupon spec must preserve the exact approved $1,150 total budget.");
  }
  if (saleAssignments.length !== salePrices.length) {
    throw new Error("Sale Price spec does not cover the exact Arm B row count.");
  }
  const startAt = startInstant(coupons.start);
  const endAt = endInstant(coupons.end);
  const outputRows: UncrustablesLaunchPricingRow[] = assignments.map(
    (assignment): UncrustablesLaunchPricingRow => {
    const canonical = priceFor(assignment.count);
    if (!canonical) throw new Error(`No canonical price for ${assignment.sku}.`);
    if (!equalMoney(assignment.basePrice, canonical.suggested)) {
      throw new Error(`${assignment.sku} base does not match Layer A.`);
    }
    const discountPercent = discountFromLever(assignment.lever, assignment.sku);
    const expectedEffective =
      Math.round(
        assignment.basePrice * (1 - discountPercent / 100) * 100,
      ) / 100;
    if (
      !equalMoney(assignment.effectivePrice, expectedEffective) ||
      assignment.effectivePrice + 0.005 < canonical.floor
    ) {
      throw new Error(`${assignment.sku} effective price is not a safe launch overlay.`);
    }
    if (assignment.arm === "A") {
      if (
        !assignment.lever.startsWith("COUPON_") ||
        saleBySku.has(assignment.sku) ||
        coupons.discountsByAsin.get(assignment.asin) !== discountPercent
      ) {
        throw new Error(`${assignment.sku} has contradictory coupon/Sale Price routing.`);
      }
      return {
        sku: assignment.sku,
        asin: assignment.asin,
        count: assignment.count,
        arm: "A",
        lever: assignment.lever,
        base_price: assignment.basePrice,
        floor_price: canonical.floor,
        effective_price: assignment.effectivePrice,
        discount_percent: discountPercent,
        sale_price_schedule: null,
      };
    }
    const sale = saleBySku.get(assignment.sku);
    if (
      !assignment.lever.startsWith("SALEPRICE_") ||
      !sale ||
      sale.asin !== assignment.asin ||
      sale.count !== assignment.count ||
      !equalMoney(sale.itemPrice, assignment.basePrice) ||
      !equalMoney(sale.salePrice, assignment.effectivePrice) ||
      startInstant(sale.start) !== startAt ||
      endInstant(sale.end) !== endAt
    ) {
      throw new Error(`${assignment.sku} Sale Price spec does not match its assignment.`);
    }
    return {
      sku: assignment.sku,
      asin: assignment.asin,
      count: assignment.count,
      arm: "B",
      lever: assignment.lever,
      base_price: assignment.basePrice,
      floor_price: canonical.floor,
      effective_price: assignment.effectivePrice,
      discount_percent: discountPercent,
      sale_price_schedule: {
        value_with_tax: assignment.effectivePrice,
        start_at: startAt,
        end_at: endAt,
      },
    };
    },
  ).sort((left, right) => left.sku.localeCompare(right.sku));
  const excludedSkuSet = new Set(options.excludedSkus);
  if (excludedSkuSet.size !== options.excludedSkus.length) {
    throw new Error("Excluded SKU list contains duplicates.");
  }
  const exclusions = [...excludedSkuSet]
    .map((sku) => {
      const row = outputRows.find((candidate) => candidate.sku === sku);
      if (!row) throw new Error(`Excluded SKU ${sku} is absent from assignments.`);
      return {
        sku: row.sku,
        asin: row.asin,
        reason: "AMAZON_CATALOG_IDENTITY_CONFLICT_8541" as const,
      };
    })
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const activeRows = outputRows.filter((row) => !excludedSkuSet.has(row.sku));
  const activeCouponRows = activeRows.filter((row) => row.arm === "A").length;
  const activeSalePriceRows = activeRows.filter((row) => row.arm === "B").length;
  const withoutDigest: Omit<UncrustablesLaunchPricingManifest, "body_sha256"> = {
    schema_version: UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
    immutable: true,
    reviewed_at: options.reviewedAt,
    decision: {
      original_owner_decision_date: "2026-07-13",
      revision_status: options.ownerApprovedAt
        ? "OWNER_APPROVED"
        : "PROPOSED_OWNER_APPROVAL_REQUIRED",
      revision_prepared_at: options.reviewedAt,
      owner_approved_at: options.ownerApprovedAt,
      changes: {
        count_45_discount_percent_from_13_to_12: true,
        synchronized_window_rebased: true,
        unsafe_historical_coupon_titles_replaced: true,
        coupon_budget_and_targeting_sealed: true,
      },
    },
    source_artifacts: {
      assignments: {
        path: options.assignments,
        sha256: sha256(assignmentBytes),
        rows: assignments.length,
      },
      coupon_spec: {
        path: options.coupons,
        sha256: sha256(couponBytes),
        rows: coupons.rows,
      },
      sale_price_spec: {
        path: options.salePrices,
        sha256: sha256(salePriceBytes),
        rows: salePrices.length,
      },
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
      groups: couponControls,
    },
    exclusions,
    pre_assignment_exclusions: preAssignmentExclusions,
    scope: {
      cohort_rows: UNCRUSTABLES_LAUNCH_COHORT_ROWS,
      rows: outputRows.length,
      coupon_rows: couponAssignments.length,
      sale_price_rows: saleAssignments.length,
      excluded_rows: exclusions.length,
      pre_assignment_excluded_rows: preAssignmentExclusions.length,
      active_rows: activeRows.length,
      active_coupon_rows: activeCouponRows,
      active_sale_price_rows: activeSalePriceRows,
      start_at: startAt,
      end_at: endAt,
    },
    rows: outputRows,
  };
  const manifest: UncrustablesLaunchPricingManifest = {
    ...withoutDigest,
    body_sha256: launchPricingManifestBodySha256(withoutDigest),
  };
  verifyUncrustablesLaunchPricingManifest(manifest);
  await mkdir(options.outputDir, { recursive: true });
  const timestamp = options.reviewedAt.replace(/[-:.]/g, "");
  const file = path.join(
    options.outputDir,
    `uncrustables-launch-pricing-${timestamp}-${manifest.body_sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        mode: "OFFLINE_NO_EXTERNAL_WRITES",
        manifest: file,
        body_sha256: manifest.body_sha256,
        rows: manifest.scope.rows,
        cohort_rows: manifest.scope.cohort_rows,
        coupon_rows: manifest.scope.coupon_rows,
        sale_price_rows: manifest.scope.sale_price_rows,
        excluded_rows: manifest.scope.excluded_rows,
        pre_assignment_excluded_rows:
          manifest.scope.pre_assignment_excluded_rows,
        active_rows: manifest.scope.active_rows,
        start_at: manifest.scope.start_at,
        end_at: manifest.scope.end_at,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
