/**
 * Derive corrected, immutable launch-pricing source specs from the reviewed
 * July 2026 A/B assignment. This is offline and never calls Amazon or
 * ChannelMAX.
 *
 * Corrections:
 * - 45-count uses 12% in both arms ($115.27, safely above the $114.27 floor).
 * - every other tier keeps the reviewed 13% exposure.
 * - coupon titles do not repeat a discount percentage.
 * - coupon and Sale Price specs use one synchronized fresh date window.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ASSIGNMENTS_HEADER =
  "ASIN,SKU,count,arm,base_item_price,effective_price,lever";
const COUPONS_HEADER =
  "ASIN list,Discount type,Coupon discount % Off value,Coupon title,Coupon budget,Coupon start date,Coupon end date,Limit redemption to one per customer,Targeted Segment";
const SALE_PRICES_HEADER =
  "ASIN,SKU,count,item_price,sale_price,start,end";

function parseArgs(argv) {
  const options = {
    assignments: "public/launch-experiment-assignments.csv",
    coupons: "public/coupons-uncrustables-launch.csv",
    salePrices: "public/salesprice-uncrustables-launch.csv",
    outputDir:
      "data/repairs/launch-pricing/source-v2-20260720-20260819",
    start: "2026-07-20",
    end: "2026-08-19",
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
    } else if (arg.startsWith("--start=")) {
      options.start = arg.slice("--start=".length);
    } else if (arg.startsWith("--end=")) {
      options.end = arg.slice("--end=".length);
    } else if (arg === "--help") {
      console.log(
        [
          "Usage: node scripts/build-uncrustables-launch-v2-sources.mjs [options]",
          "  --assignments=PATH",
          "  --coupons=PATH",
          "  --sale-prices=PATH",
          "  --output-dir=PATH",
          "  --start=YYYY-MM-DD",
          "  --end=YYYY-MM-DD",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const [label, value] of [
    ["start", options.start],
    ["end", options.end],
  ]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${label} must be YYYY-MM-DD.`);
    }
    if (new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
      throw new Error(`${label} is not a real calendar date.`);
    }
  }
  if (options.end <= options.start) throw new Error("end must be after start.");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function splitLines(value) {
  return value
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function csv(header, rows) {
  return `${[header, ...rows].join("\n")}\n`;
}

function money(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid money value: ${value}`);
  }
  return parsed;
}

function roundedDiscount(base, percent) {
  return Math.round(base * (1 - percent / 100) * 100) / 100;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [assignmentSource, couponSource, salePriceSource] = await Promise.all([
    readFile(options.assignments, "utf8"),
    readFile(options.coupons, "utf8"),
    readFile(options.salePrices, "utf8"),
  ]);

  const assignmentLines = splitLines(assignmentSource);
  if (assignmentLines.shift() !== ASSIGNMENTS_HEADER) {
    throw new Error("Unexpected assignment source header.");
  }
  const assignments = assignmentLines.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Assignment row ${index + 1} has ${columns.length} columns.`);
    }
    const [asin, sku, rawCount, arm, rawBase] = columns;
    const count = Number(rawCount);
    const base = money(rawBase);
    if (!/^B0[A-Z0-9]{8}$/.test(asin) || !sku || !Number.isInteger(count)) {
      throw new Error(`Assignment row ${index + 1} has an invalid identity.`);
    }
    if (arm !== "A" && arm !== "B") {
      throw new Error(`Assignment ${sku} has invalid arm ${arm}.`);
    }
    const discount = count === 45 ? 12 : 13;
    const effective = roundedDiscount(base, discount);
    const lever = `${arm === "A" ? "COUPON" : "SALEPRICE"}_${discount}`;
    return { asin, sku, count, arm, base, effective, discount, lever };
  });
  if (assignments.length !== 163) {
    throw new Error(`Expected 163 assignments; found ${assignments.length}.`);
  }
  if (
    new Set(assignments.map((row) => row.asin)).size !== assignments.length ||
    new Set(assignments.map((row) => row.sku)).size !== assignments.length
  ) {
    throw new Error("Assignment source contains duplicate ASINs or SKUs.");
  }
  const byAsin = new Map(assignments.map((row) => [row.asin, row]));
  const bySku = new Map(assignments.map((row) => [row.sku, row]));

  const couponLines = splitLines(couponSource);
  if (couponLines.shift() !== COUPONS_HEADER) {
    throw new Error("Unexpected coupon source header.");
  }
  const couponAsins = new Set();
  const correctedCoupons = couponLines.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 9) {
      throw new Error(`Coupon row ${index + 1} has ${columns.length} columns.`);
    }
    const [asinList, discountType, , , budget, , , onePerCustomer, segment] =
      columns;
    const members = asinList.split(";").filter(Boolean);
    const assignmentsInGroup = members.map((asin) => byAsin.get(asin));
    if (
      assignmentsInGroup.some((row) => !row || row.arm !== "A") ||
      assignmentsInGroup.length === 0
    ) {
      throw new Error(`Coupon row ${index + 1} does not map exactly to Arm A.`);
    }
    const counts = new Set(assignmentsInGroup.map((row) => row.count));
    const discounts = new Set(assignmentsInGroup.map((row) => row.discount));
    if (counts.size !== 1 || discounts.size !== 1 || discountType !== "% off") {
      throw new Error(`Coupon row ${index + 1} mixes tiers or lever types.`);
    }
    for (const asin of members) {
      if (couponAsins.has(asin)) throw new Error(`Duplicate coupon ASIN ${asin}.`);
      couponAsins.add(asin);
    }
    const count = assignmentsInGroup[0].count;
    const discount = assignmentsInGroup[0].discount;
    const title = `Uncrustables ${count} Count Launch Savings`;
    return [
      asinList,
      "% off",
      String(discount),
      title,
      budget,
      options.start,
      options.end,
      onePerCustomer,
      segment,
    ].join(",");
  });
  const expectedCouponAsins = assignments.filter((row) => row.arm === "A");
  if (
    couponAsins.size !== expectedCouponAsins.length ||
    expectedCouponAsins.some((row) => !couponAsins.has(row.asin))
  ) {
    throw new Error("Corrected coupon spec does not cover exact Arm A.");
  }

  const saleLines = splitLines(salePriceSource);
  if (saleLines.shift() !== SALE_PRICES_HEADER) {
    throw new Error("Unexpected Sale Price source header.");
  }
  const saleSkus = new Set();
  const correctedSales = saleLines.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 7) {
      throw new Error(`Sale Price row ${index + 1} has ${columns.length} columns.`);
    }
    const [asin, sku] = columns;
    const assignment = bySku.get(sku);
    if (!assignment || assignment.asin !== asin || assignment.arm !== "B") {
      throw new Error(`Sale Price row ${index + 1} does not map exactly to Arm B.`);
    }
    if (saleSkus.has(sku)) throw new Error(`Duplicate Sale Price SKU ${sku}.`);
    saleSkus.add(sku);
    return [
      assignment.asin,
      assignment.sku,
      String(assignment.count),
      assignment.base.toFixed(2),
      assignment.effective.toFixed(2),
      options.start,
      options.end,
    ].join(",");
  });
  const expectedSaleSkus = assignments.filter((row) => row.arm === "B");
  if (
    saleSkus.size !== expectedSaleSkus.length ||
    expectedSaleSkus.some((row) => !saleSkus.has(row.sku))
  ) {
    throw new Error("Corrected Sale Price spec does not cover exact Arm B.");
  }

  const correctedAssignments = csv(
    ASSIGNMENTS_HEADER,
    assignments.map((row) =>
      [
        row.asin,
        row.sku,
        String(row.count),
        row.arm,
        row.base.toFixed(2),
        row.effective.toFixed(2),
        row.lever,
      ].join(","),
    ),
  );
  const correctedCouponSpec = csv(COUPONS_HEADER, correctedCoupons);
  const correctedSaleSpec = csv(SALE_PRICES_HEADER, correctedSales);
  const files = {
    assignments: "launch-experiment-assignments-v2.csv",
    coupon_spec: "coupons-uncrustables-launch-v2-spec.csv",
    sale_price_spec: "salesprice-uncrustables-launch-v2-spec.csv",
  };
  const metadata = {
    schema_version: "uncrustables-launch-v2-sources/v1",
    immutable: true,
    source: {
      assignments: { path: options.assignments, sha256: sha256(assignmentSource) },
      coupons: { path: options.coupons, sha256: sha256(couponSource) },
      sale_prices: { path: options.salePrices, sha256: sha256(salePriceSource) },
    },
    policy: {
      start: options.start,
      end: options.end,
      default_discount_percent: 13,
      count_45_discount_percent: 12,
      count_45_effective_price: 115.27,
      coupon_titles_exclude_percent: true,
    },
    rows: {
      assignments: assignments.length,
      coupon_asins: couponAsins.size,
      coupon_groups: correctedCoupons.length,
      sale_prices: correctedSales.length,
    },
    outputs: {
      assignments: {
        file: files.assignments,
        sha256: sha256(correctedAssignments),
      },
      coupon_spec: {
        file: files.coupon_spec,
        sha256: sha256(correctedCouponSpec),
      },
      sale_price_spec: {
        file: files.sale_price_spec,
        sha256: sha256(correctedSaleSpec),
      },
    },
  };

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, files.assignments), correctedAssignments, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(path.join(options.outputDir, files.coupon_spec), correctedCouponSpec, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(path.join(options.outputDir, files.sale_price_spec), correctedSaleSpec, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(
      path.join(options.outputDir, "source-manifest.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        mode: "OFFLINE_NO_EXTERNAL_WRITES",
        output_dir: options.outputDir,
        ...metadata.rows,
        start: options.start,
        end: options.end,
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
