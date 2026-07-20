// Pure canonical product matcher contract.
//   npx tsx --test src/lib/sourcing/__tests__/canonical-product-match.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  CANONICAL_TITLE_NEUTRAL_TOKENS,
  matchCanonicalProduct,
  matchCanonicalProductTitle,
  normalizeIdentityTokens,
  parseCanonicalSize,
  parseOuterPackCount,
  type CanonicalMatchReasonCode,
  type CanonicalMatchVerdict,
  type CanonicalProductIdentity,
} from "@/lib/sourcing/canonical-product-match";

type Case = {
  name: string;
  target: CanonicalProductIdentity;
  candidate: CanonicalProductIdentity;
  verdict: CanonicalMatchVerdict;
  reasons?: CanonicalMatchReasonCode[];
};

const cola = (overrides: CanonicalProductIdentity = {}): CanonicalProductIdentity => ({
  brand: "Coca-Cola",
  productLine: "Cola Soda",
  flavor: "Original",
  form: "Beverage",
  size: "12 fl oz",
  ...overrides,
});

const cases: Case[] = [
  {
    name: "exact identity normalizes punctuation, case, and possessive brand spelling",
    target: {
      brand: "Smucker's",
      productLine: "Uncrustables Sandwiches",
      flavor: "Peanut Butter & Strawberry Jam",
      form: "Frozen Sandwich",
      size: "8 oz",
    },
    candidate: {
      brand: "SMUCKERS",
      productLine: "Sandwiches Uncrustables",
      flavor: "Strawberry Jam and Peanut Butter",
      form: "sandwich frozen",
      size: "8 ounces",
    },
    verdict: "EXACT_IDENTITY",
    reasons: ["IDENTITY_EXACT", "SIZE_EXACT"],
  },
  {
    name: "neighboring flavor is an explicit sibling estimate, never exact",
    target: {
      brand: "Smucker's",
      productLine: "Uncrustables",
      flavor: "Peanut Butter Strawberry Jam",
      form: "Frozen Sandwich",
      size: "8 oz",
    },
    candidate: {
      brand: "Smuckers",
      productLine: "Uncrustables",
      flavor: "Peanut Butter Grape Jelly",
      form: "Frozen Sandwich",
      size: "8 oz",
    },
    verdict: "SIBLING_ESTIMATE",
    reasons: ["IDENTITY_SIBLING_FLAVOR"],
  },
  {
    name: "normal soda does not match Zero Sugar even when base flavor overlaps",
    target: cola({ flavor: "Cola" }),
    candidate: cola({
      flavor: "Cola",
      title: "Coca-Cola Cola Soda Zero Sugar Beverage, 12 fl oz",
    }),
    verdict: "REJECT",
    reasons: ["MODIFIER_MISMATCH"],
  },
  {
    name: "plain cheesy and Extra Cheesy are distinct modifiers",
    target: {
      brand: "Cheez-It",
      productLine: "Baked Snack Crackers",
      flavor: "Cheesy",
      form: "Crackers",
      size: "12.4 oz",
    },
    candidate: {
      brand: "Cheez It",
      productLine: "Baked Snack Crackers",
      flavor: "Extra Cheesy",
      form: "Crackers",
      size: "12.4 oz",
    },
    verdict: "REJECT",
    reasons: ["MODIFIER_MISMATCH"],
  },
  {
    name: "Original versus Extra is rejected rather than treated as a flavor sibling",
    target: cola({ flavor: "Original" }),
    candidate: cola({ flavor: "Extra" }),
    verdict: "REJECT",
    reasons: ["MODIFIER_MISMATCH"],
  },
  {
    name: "multiword brand requires every exact brand token",
    target: {
      brand: "Pasta Zara",
      productLine: "Spaghetti",
      flavor: "Traditional",
      form: "Dry Pasta",
      size: "16 oz",
    },
    candidate: {
      brand: "Pasta",
      productLine: "Spaghetti",
      flavor: "Traditional",
      form: "Dry Pasta",
      size: "16 oz",
    },
    verdict: "REJECT",
    reasons: ["BRAND_MISMATCH"],
  },
  {
    name: "token boundary prevents Dove from matching Dover",
    target: {
      brand: "Dove",
      productLine: "Promises",
      flavor: "Milk Chocolate",
      form: "Candy",
      size: "7.61 oz",
      title: "Dove Promises Milk Chocolate Candy, 7.61 oz",
    },
    candidate: {
      brand: "Dove",
      productLine: "Promises",
      flavor: "Milk Chocolate",
      form: "Candy",
      size: "7.61 oz",
      title: "Dover Promises Milk Chocolate Candy, 7.61 oz",
    },
    verdict: "REJECT",
    reasons: ["CANDIDATE_TITLE_BRAND_CONTRADICTION"],
  },
  {
    name: "same numeric amount in MASS and COUNT is incompatible",
    target: {
      brand: "Acme",
      productLine: "Snack Bites",
      flavor: "Chocolate",
      form: "Bag",
      size: "12 oz",
    },
    candidate: {
      brand: "Acme",
      productLine: "Snack Bites",
      flavor: "Chocolate",
      form: "Bag",
      size: "12 count",
    },
    verdict: "REJECT",
    reasons: ["SIZE_DIMENSION_MISMATCH"],
  },
  {
    name: "same identity at a compatible different mass is cross-size estimate",
    target: {
      brand: "Acme",
      productLine: "Black Beans",
      flavor: "Original",
      form: "Can",
      size: "15 oz",
    },
    candidate: {
      brand: "Acme",
      productLine: "Black Beans",
      flavor: "Original",
      form: "Can",
      size: "30 oz",
    },
    verdict: "CROSS_SIZE_ESTIMATE",
    reasons: ["SIZE_DIFFERENT_COMPATIBLE_DIMENSION"],
  },
  {
    name: "metric mass conversion keeps 1000 g and 1 kg exact",
    target: {
      brand: "Acme",
      productLine: "Bread Flour",
      flavor: "Unbleached",
      form: "Flour",
      size: "1000 g",
    },
    candidate: {
      brand: "Acme",
      productLine: "Bread Flour",
      flavor: "Unbleached",
      form: "Flour",
      size: "1 kg",
    },
    verdict: "EXACT_IDENTITY",
    reasons: ["SIZE_EQUIVALENT_CONVERSION"],
  },
  {
    name: "US and metric volume labels remain exact within label-rounding tolerance",
    target: {
      brand: "Acme",
      productLine: "Spring Water",
      flavor: "Still",
      form: "Bottle",
      size: "33.8 fl oz",
    },
    candidate: {
      brand: "Acme",
      productLine: "Spring Water",
      flavor: "Still",
      form: "Bottle",
      size: "1 L",
    },
    verdict: "EXACT_IDENTITY",
    reasons: ["SIZE_EQUIVALENT_CONVERSION"],
  },
  {
    name: "same brand and flavor in a different product form is rejected",
    target: {
      brand: "Dove",
      productLine: "Promises",
      flavor: "Milk Chocolate",
      form: "Candy",
      size: "7.61 oz",
    },
    candidate: {
      brand: "Dove",
      productLine: "Promises",
      flavor: "Milk Chocolate",
      form: "Ice Cream",
      size: "7.61 oz",
    },
    verdict: "REJECT",
    reasons: ["FORM_MISMATCH"],
  },
  {
    name: "missing candidate size is a flagged estimate, not exact",
    target: {
      brand: "Jimmy Dean",
      productLine: "Breakfast Sandwiches",
      flavor: "Sausage Egg Cheese",
      form: "Frozen Sandwich",
      size: "36.8 oz",
    },
    candidate: {
      brand: "Jimmy Dean",
      productLine: "Breakfast Sandwiches",
      flavor: "Sausage Egg Cheese",
      form: "Frozen Sandwich",
    },
    verdict: "SIZE_UNKNOWN_ESTIMATE",
    reasons: ["CANDIDATE_SIZE_MISSING"],
  },
  {
    name: "unparseable target size remains a flagged size-unknown estimate",
    target: {
      brand: "Acme",
      productLine: "Tomato Soup",
      flavor: "Original",
      form: "Can",
      size: "family size",
    },
    candidate: {
      brand: "Acme",
      productLine: "Tomato Soup",
      flavor: "Original",
      form: "Can",
      size: "18 oz",
    },
    verdict: "SIZE_UNKNOWN_ESTIMATE",
    reasons: ["TARGET_SIZE_UNPARSEABLE"],
  },
  {
    name: "different flavor plus different size is compounded uncertainty and rejected",
    target: {
      brand: "Acme",
      productLine: "Potato Chips",
      flavor: "Sea Salt",
      form: "Bag",
      size: "8 oz",
    },
    candidate: {
      brand: "Acme",
      productLine: "Potato Chips",
      flavor: "Barbecue",
      form: "Bag",
      size: "16 oz",
    },
    verdict: "REJECT",
    reasons: ["SIBLING_SIZE_NOT_EXACT"],
  },
  {
    name: "brand-only evidence is insufficient for an exact product identity",
    target: { brand: "Acme", size: "12 oz" },
    candidate: { brand: "Acme", size: "12 oz" },
    verdict: "REJECT",
    reasons: ["INSUFFICIENT_IDENTITY"],
  },
];

for (const row of cases) {
  test(row.name, () => {
    const actual = matchCanonicalProduct(row.target, row.candidate);
    assert.equal(actual.verdict, row.verdict);
    assert.equal(actual.matcherVersion, CANONICAL_PRODUCT_MATCHER_VERSION);
    for (const reason of row.reasons ?? []) {
      assert.ok(actual.reasonCodes.includes(reason), `${reason} missing from ${actual.reasonCodes.join(", ")}`);
    }
  });
}

test("identity tokens are exact words, not substrings", () => {
  assert.deepEqual(normalizeIdentityTokens("Dove"), ["dove"]);
  assert.deepEqual(normalizeIdentityTokens("Dover"), ["dover"]);
  assert.notDeepEqual(normalizeIdentityTokens("Dove"), normalizeIdentityTokens("Dover"));
});

test("size parser normalizes MASS conversions", () => {
  const sixteenOz = parseCanonicalSize("16 oz")!;
  const onePound = parseCanonicalSize("1 lb")!;
  const oneKg = parseCanonicalSize("1 kg")!;
  const thousandGrams = parseCanonicalSize("1000 g")!;

  assert.equal(sixteenOz.dimension, "MASS");
  assert.equal(onePound.dimension, "MASS");
  assert.ok(Math.abs(sixteenOz.baseAmount - onePound.baseAmount) < 1e-9);
  assert.equal(oneKg.baseAmount, thousandGrams.baseAmount);
});

test("size parser normalizes VOLUME conversions without treating fl oz as mass", () => {
  const fluidOunces = parseCanonicalSize("33.8 fl oz")!;
  const liter = parseCanonicalSize("1 L")!;
  const milliliters = parseCanonicalSize("500 ml")!;

  assert.equal(fluidOunces.dimension, "VOLUME");
  assert.equal(liter.dimension, "VOLUME");
  assert.equal(milliliters.baseAmount, 500);
  assert.ok(Math.abs(fluidOunces.baseAmount - liter.baseAmount) / liter.baseAmount < 0.01);
});

test("equivalent converted package sizes are exact identity", () => {
  const common = {
    brand: "Acme Foods",
    productLine: "Bread Flour",
    flavor: "Unbleached",
    form: "Flour",
  };
  const result = matchCanonicalProduct(
    { ...common, size: "16 oz" },
    { ...common, size: "1 lb" },
  );
  assert.equal(result.verdict, "EXACT_IDENTITY");
  assert.ok(result.reasonCodes.includes("SIZE_EQUIVALENT_CONVERSION"));
});

test("ambiguous compound size is never silently reduced to its first number", () => {
  assert.equal(parseCanonicalSize("8 oz / 4 ct"), null);
  const common = {
    brand: "Acme",
    productLine: "Snack Cakes",
    flavor: "Chocolate",
    form: "Box",
  };
  const result = matchCanonicalProduct(
    { ...common, size: "8 oz / 4 ct" },
    { ...common, size: "8 oz" },
  );
  assert.equal(result.verdict, "SIZE_UNKNOWN_ESTIMATE");
  assert.ok(result.reasonCodes.includes("TARGET_SIZE_AMBIGUOUS"));
});

test("cross-size estimate has a bounded ratio", () => {
  const common = {
    brand: "Acme",
    productLine: "Tomato Sauce",
    flavor: "Original",
    form: "Can",
  };
  const result = matchCanonicalProduct(
    { ...common, size: "8 oz" },
    { ...common, size: "64 oz" },
  );
  assert.equal(result.verdict, "REJECT");
  assert.ok(result.reasonCodes.includes("SIZE_RATIO_OUT_OF_RANGE"));
});

const titleColaTarget: CanonicalProductIdentity = {
  brand: "Coca-Cola",
  productLine: "Cola Soda",
  flavor: "Original",
  form: "Beverage",
  size: "12 fl oz",
};

type TitleCase = {
  name: string;
  target?: CanonicalProductIdentity;
  candidate: { title: string; brand?: string };
  verdict: CanonicalMatchVerdict;
  reason: CanonicalMatchReasonCode;
};

const titleCases: TitleCase[] = [
  {
    name: "title bridge accepts a brand-led exact title with audited neutral SEO words",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage, 12 fl oz, Packaging May Vary",
    },
    verdict: "EXACT_IDENTITY",
    reason: "TITLE_FALLBACK_IDENTITY_PROVEN",
  },
  {
    name: "title bridge rejects a 2 Pack candidate for the default one-package target",
    candidate: {
      title: "2 Pack Coca-Cola Cola Soda Original Beverage, 12 fl oz",
      brand: "Coca Cola",
    },
    verdict: "REJECT",
    reason: "OUTER_PACK_COUNT_MISMATCH",
  },
  {
    name: "title bridge accepts 2 Pack only when the target explicitly requires two packages",
    target: {
      ...titleColaTarget,
      outerPackCount: 2,
    },
    candidate: {
      title: "2 Pack Coca-Cola Cola Soda Original Beverage, 12 fl oz",
      brand: "Coca Cola",
    },
    verdict: "EXACT_IDENTITY",
    reason: "TITLE_FALLBACK_IDENTITY_PROVEN",
  },
  {
    name: "case-of prefix carries outer package quantity",
    candidate: {
      title: "Case of 6 Coca-Cola Cola Soda Original Beverage, 12 fl oz",
    },
    verdict: "REJECT",
    reason: "OUTER_PACK_COUNT_MISMATCH",
  },
  {
    name: "N x prefix carries outer package quantity",
    candidate: {
      title: "3 x Coca-Cola Cola Soda Original Beverage, 12 fl oz",
    },
    verdict: "REJECT",
    reason: "OUTER_PACK_COUNT_MISMATCH",
  },
  {
    name: "suffix Pack of N also carries outer package quantity",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage, 12 fl oz, Pack of 2",
    },
    verdict: "REJECT",
    reason: "OUTER_PACK_COUNT_MISMATCH",
  },
  {
    name: "title bridge preserves the cross-size estimate tier",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage, 24 fl oz",
    },
    verdict: "CROSS_SIZE_ESTIMATE",
    reason: "SIZE_DIFFERENT_COMPATIBLE_DIMENSION",
  },
  {
    name: "title bridge preserves the size-unknown estimate tier",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage",
    },
    verdict: "SIZE_UNKNOWN_ESTIMATE",
    reason: "CANDIDATE_SIZE_UNPARSEABLE",
  },
  {
    name: "title bridge preserves converted exact sizes",
    target: {
      brand: "Acme Foods",
      productLine: "Bread Flour",
      flavor: "Unbleached",
      form: "Bag",
      size: "16 oz",
    },
    candidate: {
      title: "Acme Foods Bread Flour Unbleached Bag, 1 lb",
    },
    verdict: "EXACT_IDENTITY",
    reason: "SIZE_EQUIVALENT_CONVERSION",
  },
  {
    name: "brand must not be preceded by retailer or house-brand words",
    candidate: {
      title: "Great Value Coca-Cola Cola Soda Original Beverage, 12 fl oz",
    },
    verdict: "REJECT",
    reason: "TITLE_PREFIX_NOT_ALLOWED",
  },
  {
    name: "brand evidence uses a whole-word boundary",
    target: {
      brand: "Dove",
      productLine: "Promises",
      flavor: "Milk Chocolate",
      form: "Candy",
      size: "7.61 oz",
    },
    candidate: {
      title: "Dover Promises Milk Chocolate Candy, 7.61 oz",
    },
    verdict: "REJECT",
    reason: "TITLE_BRAND_NOT_FOUND",
  },
  {
    name: "optional retailer brand field cannot contradict the target brand",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage, 12 fl oz",
      brand: "Pepsi",
    },
    verdict: "REJECT",
    reason: "BRAND_MISMATCH",
  },
  {
    name: "a missing target flavor token is rejected rather than inferred as sibling",
    target: {
      brand: "Acme",
      productLine: "Fruit Spread",
      flavor: "Strawberry",
      form: "Jar",
      size: "18 oz",
    },
    candidate: {
      title: "Acme Fruit Spread Grape Jar, 18 oz",
    },
    verdict: "REJECT",
    reason: "TITLE_TARGET_TOKEN_MISSING",
  },
  {
    name: "Original Spicy cannot masquerade as exact Original",
    target: {
      brand: "Acme",
      productLine: "Potato Chips",
      flavor: "Original",
      form: "Bag",
      size: "8 oz",
    },
    candidate: {
      title: "Acme Potato Chips Original Spicy Bag, 8 oz",
    },
    verdict: "REJECT",
    reason: "TITLE_UNEXPLAINED_CANDIDATE_TOKEN",
  },
  {
    name: "Extra Cheesy Jalapeno cannot masquerade as exact Extra Cheesy",
    target: {
      brand: "Acme",
      productLine: "Snack Crackers",
      flavor: "Extra Cheesy",
      form: "Box",
      size: "12 oz",
    },
    candidate: {
      title: "Acme Snack Crackers Extra Cheesy Jalapeno Box, 12 oz",
    },
    verdict: "REJECT",
    reason: "TITLE_UNEXPLAINED_CANDIDATE_TOKEN",
  },
  {
    name: "known Zero Sugar modifier conflicts with Original",
    candidate: {
      title: "Coca-Cola Cola Soda Original Zero Sugar Beverage, 12 fl oz",
    },
    verdict: "REJECT",
    reason: "MODIFIER_MISMATCH",
  },
  {
    name: "unapproved SEO claims are unexplained rather than silently ignored",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage Best Seller, 12 fl oz",
    },
    verdict: "REJECT",
    reason: "TITLE_UNEXPLAINED_CANDIDATE_TOKEN",
  },
  {
    name: "same amount in COUNT remains incompatible with target VOLUME",
    candidate: {
      title: "Coca-Cola Cola Soda Original Beverage, 12 count",
    },
    verdict: "REJECT",
    reason: "SIZE_DIMENSION_MISMATCH",
  },
  {
    name: "ordinary count size inside the product title remains one outer package",
    target: {
      brand: "Acme",
      productLine: "Snack Cakes",
      flavor: "Chocolate",
      form: "Box",
      size: "12 ct",
    },
    candidate: {
      title: "Acme Snack Cakes Chocolate Box, 12 ct",
    },
    verdict: "EXACT_IDENTITY",
    reason: "TITLE_FALLBACK_IDENTITY_PROVEN",
  },
];

for (const row of titleCases) {
  test(row.name, () => {
    const result = matchCanonicalProductTitle(row.target ?? titleColaTarget, row.candidate);
    assert.equal(result.verdict, row.verdict);
    assert.ok(result.reasonCodes.includes(row.reason), `${row.reason} missing from ${result.reasonCodes.join(", ")}`);
    assert.notEqual(result.verdict, "SIBLING_ESTIMATE");
    assert.ok(result.titleEvidence);
  });
}

test("title bridge exposes missing and unexplained tokens for audit", () => {
  const missing = matchCanonicalProductTitle(
    {
      brand: "Acme",
      productLine: "Fruit Spread",
      flavor: "Strawberry",
      form: "Jar",
      size: "18 oz",
    },
    { title: "Acme Fruit Spread Grape Jar, 18 oz" },
  );
  assert.deepEqual(missing.titleEvidence?.missingTargetTokens, ["strawberry"]);

  const unexplained = matchCanonicalProductTitle(
    {
      brand: "Acme",
      productLine: "Potato Chips",
      flavor: "Original",
      form: "Bag",
      size: "8 oz",
    },
    { title: "Acme Potato Chips Original Spicy Bag, 8 oz" },
  );
  assert.deepEqual(unexplained.titleEvidence?.unexplainedCandidateTokens, ["spicy"]);
});

test("neutral title allowlist stays explicit and excludes adjacent-variant words", () => {
  const neutral = new Set<string>(CANONICAL_TITLE_NEUTRAL_TOKENS);
  for (const meaningful of ["spicy", "jalapeno", "grape", "strawberry", "extra", "original", "best", "seller"]) {
    assert.equal(neutral.has(meaningful), false, `${meaningful} must remain identity-bearing`);
  }
});

test("outer pack parser distinguishes multipack syntax from ordinary count size", () => {
  assert.equal(parseOuterPackCount("2 Pack Acme Tomato Soup, 12 oz"), 2);
  assert.equal(parseOuterPackCount("Case of 6 Acme Tomato Soup, 12 oz"), 6);
  assert.equal(parseOuterPackCount("3 x Acme Tomato Soup, 12 oz"), 3);
  assert.equal(parseOuterPackCount("Acme Snack Cakes, 12 ct"), null);
});

test("title evidence and normalized products expose outer package counts", () => {
  const mismatch = matchCanonicalProductTitle(titleColaTarget, {
    title: "2 Pack Coca-Cola Cola Soda Original Beverage, 12 fl oz",
  });
  assert.equal(mismatch.titleEvidence?.targetOuterPackCount, 1);
  assert.equal(mismatch.titleEvidence?.candidateOuterPackCount, 2);
  assert.equal(mismatch.normalized.target.outerPackCount, 1);
  assert.equal(mismatch.normalized.candidate.outerPackCount, 2);

  const ordinaryCount = matchCanonicalProductTitle(
    {
      brand: "Acme",
      productLine: "Snack Cakes",
      flavor: "Chocolate",
      form: "Box",
      size: "12 ct",
    },
    { title: "Acme Snack Cakes Chocolate Box, 12 ct" },
  );
  assert.equal(ordinaryCount.normalized.target.outerPackCount, 1);
  assert.equal(ordinaryCount.normalized.candidate.outerPackCount, 1);
  assert.equal(ordinaryCount.normalized.candidate.size?.dimension, "COUNT");
  assert.equal(ordinaryCount.normalized.candidate.size?.amount, 12);
});

test("structured matcher also rejects outer pack mismatch and title contradiction", () => {
  const common = {
    brand: "Acme",
    productLine: "Tomato Soup",
    flavor: "Original",
    form: "Can",
    size: "12 oz",
  };
  const mismatch = matchCanonicalProduct(
    { ...common, outerPackCount: 1 },
    { ...common, outerPackCount: 2 },
  );
  assert.equal(mismatch.verdict, "REJECT");
  assert.ok(mismatch.reasonCodes.includes("OUTER_PACK_COUNT_MISMATCH"));

  const contradiction = matchCanonicalProduct(
    { ...common, outerPackCount: 1 },
    { ...common, outerPackCount: 1, title: "2 Pack Acme Tomato Soup Original Can, 12 oz" },
  );
  assert.equal(contradiction.verdict, "REJECT");
  assert.equal(contradiction.normalized.candidate.outerPackCountStatus, "CONTRADICTORY");
  assert.ok(contradiction.reasonCodes.includes("CANDIDATE_OUTER_PACK_COUNT_INVALID"));
});
