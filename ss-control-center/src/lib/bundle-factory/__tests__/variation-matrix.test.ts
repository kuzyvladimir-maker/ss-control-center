// Unit tests for Phase 2.2 variation-matrix generator. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/variation-matrix.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateVariants,
  type ResearchPoolItem,
} from "../variation-matrix";

function poolItem(overrides: Partial<ResearchPoolItem> = {}): ResearchPoolItem {
  return {
    id: "p1",
    product_name: "Lunchables Pizza",
    brand: "Lunchables",
    avg_price_cents: 250,
    freshness_score: 90,
    storage_temp: "Refrigerated",
    pack_sizes: null,
    flavors: null,
    ...overrides,
  };
}

test("SINGLE_FLAVOR → 1 variant of N units", () => {
  const variants = generateVariants({
    pool: [
      poolItem({ id: "a", freshness_score: 95 }),
      poolItem({ id: "b", freshness_score: 80, product_name: "B" }),
    ],
    composition_type: "SINGLE_FLAVOR",
    pack_count: 12,
  });
  assert.equal(variants.length, 1);
  assert.equal(variants[0].composition.length, 1);
  assert.equal(variants[0].composition[0].qty, 12);
  assert.equal(variants[0].composition[0].research_pool_id, "a"); // highest fresh
});

test("MIXED_FLAVOR with pool size 4 + pack 12 → 4 variants", () => {
  const variants = generateVariants({
    pool: [
      poolItem({ id: "a", product_name: "A", freshness_score: 95 }),
      poolItem({ id: "b", product_name: "B", freshness_score: 90 }),
      poolItem({ id: "c", product_name: "C", freshness_score: 85 }),
      poolItem({ id: "d", product_name: "D", freshness_score: 80 }),
    ],
    composition_type: "MIXED_FLAVOR",
    pack_count: 12,
  });
  // 50/50 + 60/40 + 3-way + 4-way (pack>=8) = 4
  assert.ok(variants.length >= 3 && variants.length <= 5);
  // First variant is even 50/50 of top 2.
  const first = variants[0];
  assert.equal(first.composition.length, 2);
  assert.equal(first.composition[0].qty + first.composition[1].qty, 12);
});

test("CROSS_BRAND skips duplicate brands", () => {
  const variants = generateVariants({
    pool: [
      poolItem({ id: "a", brand: "Lunchables", product_name: "A", freshness_score: 95 }),
      poolItem({ id: "b", brand: "Lunchables", product_name: "B", freshness_score: 90 }),
      poolItem({ id: "c", brand: "Capri Sun", product_name: "C", freshness_score: 85 }),
      poolItem({ id: "d", brand: "Hershey's", product_name: "D", freshness_score: 80 }),
    ],
    composition_type: "CROSS_BRAND",
    pack_count: 12,
  });
  // First variant must contain distinct brands.
  const first = variants[0];
  const brands = new Set(first.composition.map((c) => c.brand));
  assert.equal(brands.size, first.composition.length);
});

test("variant cost = sum(qty × unit_price)", () => {
  const variants = generateVariants({
    pool: [poolItem({ id: "x", avg_price_cents: 300, freshness_score: 90 })],
    composition_type: "SINGLE_FLAVOR",
    pack_count: 10,
  });
  assert.equal(variants[0].cost_cents, 3000);
});

test("suggested price rounds to nearest $0.50 step", () => {
  const variants = generateVariants({
    pool: [poolItem({ id: "x", avg_price_cents: 250, freshness_score: 90 })],
    composition_type: "SINGLE_FLAVOR",
    pack_count: 12, // cost = $30; 30 × 2.5 = $75 → already on $0.50
    markup_multiplier: 2.5,
  });
  assert.equal(variants[0].suggested_price_cents % 50, 0);
});

test("feasibility_score weighted by qty", () => {
  const variants = generateVariants({
    pool: [
      poolItem({ id: "a", freshness_score: 100, product_name: "A" }),
      poolItem({ id: "b", freshness_score: 50, product_name: "B" }),
    ],
    composition_type: "MIXED_FLAVOR",
    pack_count: 10,
  });
  // 5×100 + 5×50 = 750; /10 = 75
  const fifty = variants.find((v) => v.composition.length === 2);
  assert.ok(fifty);
  assert.equal(fifty!.feasibility_score, 75);
});

test("indices are stable + dense (0..n-1)", () => {
  const variants = generateVariants({
    pool: Array.from({ length: 6 }, (_, i) =>
      poolItem({
        id: `p${i}`,
        product_name: `Item ${i}`,
        brand: `Brand${i}`,
        freshness_score: 90 - i,
      }),
    ),
    composition_type: "CROSS_BRAND",
    pack_count: 12,
  });
  variants.forEach((v, i) => assert.equal(v.idx, i));
});

test("pool with all zero prices throws", () => {
  assert.throws(() =>
    generateVariants({
      pool: [poolItem({ avg_price_cents: 0 })],
      composition_type: "SINGLE_FLAVOR",
      pack_count: 12,
    }),
  );
});

test("pack_count < 2 throws", () => {
  assert.throws(() =>
    generateVariants({
      pool: [poolItem()],
      composition_type: "SINGLE_FLAVOR",
      pack_count: 1,
    }),
  );
});
