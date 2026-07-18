import assert from "node:assert/strict";
import test from "node:test";

import {
  SHADOW_50_ACCEPTANCE_GATES,
  SHADOW_50_QUOTAS,
  WALMART_SHADOW_50_SCHEMA,
  buildWalmartShadow50,
  shadowPrimaryStratum,
} from "../shadow-50.ts";

const stratumFlags = {
  known_bad_or_return_risk: {
    flags: {
      prior_visual_bad: true,
      elevated_return_risk: false,
      remediation_applied: true,
      listing_kind: "multipack",
    },
    outerUnits: 6,
  },
  remediated: {
    flags: {
      prior_visual_bad: false,
      elevated_return_risk: false,
      remediation_applied: true,
      listing_kind: "multipack",
    },
    outerUnits: 4,
  },
  multipack: {
    flags: {
      prior_visual_bad: false,
      elevated_return_risk: false,
      remediation_applied: false,
      listing_kind: "bundle",
    },
    outerUnits: 3,
  },
  single_unit_control: {
    flags: {
      prior_visual_bad: false,
      elevated_return_risk: false,
      remediation_applied: false,
      listing_kind: "single",
    },
    outerUnits: 1,
  },
};

function expectedTruth(title, outerUnits) {
  return {
    title,
    outer_units: outerUnits,
    identity: {
      brand_aliases: ["example brand"],
      product_marker_groups: [["snack product", "snack"]],
      variant_marker_groups: [],
      forbidden_markers: [{ role: "variant", aliases: ["diet"] }],
    },
    package_facts: [
      { kind: "net_content", value: 10, unit: "oz", requirement: "if_visible" },
    ],
    truth_source: "manual_verified",
  };
}

function candidates(extraPerCell = 1) {
  const out = [];
  let id = 1000000;
  for (const [stratum, tiers] of Object.entries(SHADOW_50_QUOTAS)) {
    const setup = stratumFlags[stratum];
    for (const [salesTier, quota] of Object.entries(tiers)) {
      for (let index = 0; index < quota + extraPerCell; index++) {
        id += 1;
        out.push({
          sku: `${stratum}-${salesTier}-${index}`,
          item_id: String(id),
          published_status: "PUBLISHED",
          lifecycle_status: "ACTIVE",
          category: `category-${index % 5}`,
          sales_tier: salesTier,
          risk_score: quota + extraPerCell - index,
          expected: expectedTruth(`Example Brand Snack ${stratum} ${index}`, setup.outerUnits),
          ...setup.flags,
        });
      }
    }
  }
  return out;
}

test("primary stratum priority prevents risky/remediated cases leaking into controls", () => {
  for (const [expectedStratum, setup] of Object.entries(stratumFlags)) {
    const candidate = {
      sku: expectedStratum,
      item_id: "123",
      published_status: "PUBLISHED",
      category: "food",
      sales_tier: "high",
      risk_score: 1,
      expected: expectedTruth("Example Brand Snack", setup.outerUnits),
      ...setup.flags,
    };
    assert.equal(shadowPrimaryStratum(candidate), expectedStratum);
  }
});

test("builder selects deterministic exact quotas across risk and sales tiers", () => {
  const source = candidates(2);
  const first = buildWalmartShadow50(source, "fixed-seed");
  const second = buildWalmartShadow50([...source].reverse(), "fixed-seed");
  assert.equal(first.schema_version, WALMART_SHADOW_50_SCHEMA);
  assert.equal(first.selection_policy.truth_schema, "walmart-visual-audit/v3");
  assert.equal(first.cases.length, 50);
  assert.equal(first.manifest_id, second.manifest_id);
  assert.deepEqual(first.cases.map((item) => item.sku), second.cases.map((item) => item.sku));
  assert.deepEqual(first.distribution.strata, {
    known_bad_or_return_risk: 15,
    remediated: 15,
    multipack: 10,
    single_unit_control: 10,
  });
  assert.deepEqual(first.distribution.sales_tiers, { high: 20, medium: 16, low: 14 });
  assert.equal(new Set(first.cases.map((item) => item.sku)).size, 50);
  assert.equal(new Set(first.cases.map((item) => item.item_id)).size, 50);
});

test("builder does not borrow quota from another cell", () => {
  const source = candidates(0);
  const missing = source.filter((item) => item.sku !== "multipack-low-2");
  assert.throws(
    () => buildWalmartShadow50(missing),
    /multipack\/low: need 3 candidates, found 2/,
  );
});

test("builder rejects duplicate item identity before selection", () => {
  const source = candidates(0);
  source[1] = { ...source[1], item_id: source[0].item_id };
  assert.throws(() => buildWalmartShadow50(source), /duplicate shadow item_id/);
});

test("builder rejects legacy or incomplete truth instead of translating it", () => {
  const source = candidates(0);
  const legacy = structuredClone(source[0]);
  delete legacy.expected;
  legacy.expected_identity = { marker_groups: [["example brand"], ["snack"]] };
  assert.throws(() => buildWalmartShadow50([legacy, ...source.slice(1)]), /unsupported fields: expected_identity/);

  const emptyProduct = structuredClone(source);
  emptyProduct[0].expected.identity.product_marker_groups = [];
  assert.throws(() => buildWalmartShadow50(emptyProduct), /product_marker_groups must not be empty/);

  const logoBrand = structuredClone(source);
  logoBrand[0].expected.identity.brand_aliases = ["G"];
  assert.throws(() => buildWalmartShadow50(logoBrand), /full lexical brand names/);

  const legacyExpected = structuredClone(source);
  legacyExpected[0].expected.unit_size = { value: 10, unit: "oz" };
  assert.throws(() => buildWalmartShadow50(legacyExpected), /expected has unsupported fields: unit_size/);
});

test("builder enforces forbidden-marker roles and typed package facts", () => {
  const badRole = candidates(0);
  badRole[0].expected.identity.forbidden_markers = [{ role: "any", aliases: ["diet"] }];
  assert.throws(() => buildWalmartShadow50(badRole), /role is unsupported/);

  const ambiguousFact = candidates(0);
  ambiguousFact[0].expected.package_facts = [
    { kind: "net_content", value: 8, unit: "count", requirement: "required" },
  ];
  assert.throws(() => buildWalmartShadow50(ambiguousFact), /net_content cannot use count/);

  const noFacts = candidates(0);
  noFacts[0].expected.package_facts = [];
  assert.throws(() => buildWalmartShadow50(noFacts), /must contain 1-2 typed package facts/);
});

test("acceptance contract is zero-write and zero-classification-error", () => {
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.selected_cases_exactly, 50);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.false_passes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.false_bads, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.review_rate_max, 0.25);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.database_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.walmart_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.r2_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.remediation_actions, 0);
});
