import assert from "node:assert/strict";
import test from "node:test";

import { ruleBrandField } from "../rules/rule-2-brand-field";
import { ruleDisclaimerBullets } from "../rules/rule-3-disclaimer-bullets";
import { ruleDisclaimerDescription } from "../rules/rule-4-disclaimer-description";
import type { ComplianceInput } from "../types";

function input(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    title: "Campbell's Chunky Soup, 18.8 oz Can (Pack of 8)",
    brand: "campbells",
    bullets: ["Includes 8 identical retail packages"],
    description: "Stock up with 8 identical retail packages.",
    bundle_components: [{ brand: "campbells" }],
    ...overrides,
  };
}

test("Walmart requires the original manufacturer brand, Amazon does not allow it", () => {
  // Owner decision 2026-08-02: on Walmart the brand field names the true
  // manufacturer of the item being listed.
  assert.equal(ruleBrandField(input({ channel: "WALMART" })).passed, true);
  // Amazon keeps the allow-list that stops a foreign brand being borrowed.
  const amazon = ruleBrandField(input({ channel: "AMAZON_SALUTEM" }));
  assert.equal(amazon.passed, false);
  assert.equal(amazon.reason, "brand_not_allowed");
  // An empty brand is still a failure on every channel.
  assert.equal(ruleBrandField(input({ channel: "WALMART", brand: "" })).passed, false);
});

test("a Walmart multipack gets multipack wording, never the gift-basket sentence", () => {
  const walmart = input({ channel: "WALMART" });
  const bulletResult = ruleDisclaimerBullets(walmart, { autoFix: true });
  assert.equal(bulletResult.passed, true);
  const injected = walmart.bullets.join(" ");
  assert.match(injected, /Assembled and packed by Salutem Solutions LLC as a multipack\./u);
  assert.doesNotMatch(injected, /gift basket/iu);

  const descResult = ruleDisclaimerDescription(walmart, { autoFix: true });
  assert.equal(descResult.passed, true);
  assert.match(walmart.description, /assembled and packed by Salutem Solutions LLC/iu);
  assert.doesNotMatch(walmart.description, /gift basket/iu);
});

test("gift-set channels keep the gift-basket disclaimer unchanged", () => {
  const amazon = input({ channel: "AMAZON_SALUTEM", brand: "Salutem Vita" });
  ruleDisclaimerBullets(amazon, { autoFix: true });
  assert.match(amazon.bullets.join(" "), /as a gift basket\./u);
});
