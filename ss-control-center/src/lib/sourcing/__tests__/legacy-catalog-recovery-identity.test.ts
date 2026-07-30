import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateLegacyCatalogRecoveryIdentity,
} from "../legacy-catalog-recovery-identity";

const baseTarget = {
  brand: "Acme Foods",
  productLine: "Classic Bread",
  flavor: "Plain White",
  form: "loaf",
  size: "20 oz",
  outerPackCount: 1,
};

test("legacy recovery keeps the unchanged strict exact-content path", () => {
  const decision = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title: "Acme Foods Classic Bread Plain White Loaf, 20 oz",
    },
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.method, "STRICT_SOURCE_BRAND");
  assert.deepEqual(decision.controlledPresentationTokens, []);
  assert.equal(decision.contentIdentityDecision.eligible, true);
});

test("bad source brand metadata is recoverable only when title proves target brand", () => {
  const decision = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme",
      title: "Acme Foods Classic Bread Plain White Loaf, 20 oz",
    },
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.method, "TARGET_BRAND_PROVEN_IN_TITLE");
  assert.equal(decision.sourceBrandDecision.eligible, false);
  assert.equal(decision.contentIdentityDecision.eligible, true);

  const missingBrand = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme",
      title: "Classic Bread Plain White Loaf, 20 oz",
    },
  });
  assert.equal(missingBrand.eligible, false);
  assert.ok(
    missingBrand.blockers.includes("TITLE_BRAND_NOT_FOUND"),
  );
});

test("closed presentation tokens recover exact can and loaf titles", () => {
  const canned = evaluateLegacyCatalogRecoveryIdentity({
    target: {
      brand: "Del Monte",
      productLine: "Fruit Cocktail in 100% Juice",
      flavor: "Fruit Cocktail",
      form: "can",
      size: "15 oz",
      outerPackCount: 1,
    },
    donor: {
      brand: "Del Monte",
      title:
        "Del Monte Fruit Cocktail in Fruit Juice, Canned Fruit, 15 oz Can",
    },
  });
  assert.equal(canned.eligible, true);
  assert.equal(canned.method, "CONTROLLED_PRESENTATION_TOKENS");
  assert.deepEqual(canned.controlledPresentationTokens, ["canned"]);

  const claims = evaluateLegacyCatalogRecoveryIdentity({
    target: {
      brand: "Nature's Own",
      productLine: "Life",
      flavor: "Sugar-Free 100% Whole Grain",
      form: "loaf",
      size: "16 oz",
      outerPackCount: 1,
    },
    donor: {
      brand: "Nature's Own",
      title:
        "Nature's Own Life 100% Whole Grain Bread, Sugar Free Bread, "
        + "Non-GMO Keto Friendly, 16 oz Loaf",
    },
  });
  assert.equal(claims.eligible, true);
  assert.equal(claims.method, "CONTROLLED_PRESENTATION_TOKENS");
  assert.deepEqual(
    claims.controlledPresentationTokens,
    ["bread", "friendly", "gmo", "keto", "non"],
  );
});

test("recovery remains fail-closed for missing identity, adjacent variants, and size drift", () => {
  const missingSoft = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title: "Acme Foods Classic Bread White Loaf, 20 oz",
    },
  });
  assert.equal(missingSoft.eligible, false);
  assert.ok(missingSoft.blockers.includes("TITLE_TARGET_TOKEN_MISSING"));

  const spicy = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title:
        "Acme Foods Classic Bread Plain White Spicy Loaf, 20 oz",
    },
  });
  assert.equal(spicy.eligible, false);
  assert.ok(
    spicy.blockers.includes("TITLE_UNEXPLAINED_CANDIDATE_TOKEN"),
  );

  const wholeWheat = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title:
        "Acme Foods Classic Bread Plain White Whole Wheat Loaf, 20 oz",
    },
  });
  assert.equal(wholeWheat.eligible, false);
  assert.ok(wholeWheat.blockers.includes("MODIFIER_MISMATCH"));

  const sizeDrift = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title: "Acme Foods Classic Bread Plain White Loaf, 21 oz",
    },
  });
  assert.equal(sizeDrift.eligible, false);
  assert.ok(
    sizeDrift.blockers.includes("SAME_UNIT_PRINTED_AMOUNT_MISMATCH"),
  );
});

test("partial claim phrases never enter the controlled allowlist", () => {
  const decision = evaluateLegacyCatalogRecoveryIdentity({
    target: baseTarget,
    donor: {
      brand: "Acme Foods",
      title:
        "Acme Foods Classic Bread Plain White Loaf, 20 oz, Keto Edition",
    },
  });
  assert.equal(decision.eligible, false);
  assert.ok(
    decision.blockers.includes("TITLE_UNEXPLAINED_CANDIDATE_TOKEN"),
  );
});
