import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  ProductTruthNewSkuReadError,
  buildProductTruthNewSkuRecipeComponentFromRows,
  buildProductTruthWalmartPilotCandidate,
} from "../product-truth-read-contract";
import { collectWalmartPilotCandidatesPaginated } from "../product-truth-new-sku-view";
import {
  newSkuCompilerOptions as options,
  validIdentityRow as identity,
  validIdentityRowWithContent,
  validPriceRow as price,
} from "./product-truth-new-sku-fixtures";

test("canonical Product Truth boundary exports the exact new-SKU compiler", () => {
  assert.equal(
    PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    "product-truth-read-contract/3.1.0",
  );
  const component = buildProductTruthNewSkuRecipeComponentFromRows({
    identity,
    price,
    qty: 2,
    index: 0,
    options,
  });
  assert.equal(component.content_role, "EXACT");
  assert.equal(component.price_evidence.locality_evidence, "zip_scoped");
  assert.equal(component.price_evidence.zip, "33765");
  assert.equal(component.price_evidence.price_per_unit, 4.99);
  assert.equal(component.price_evidence.eligibility, "FACT");
  assert.equal(component.price_evidence.via, "direct");
  assert.equal(component.price_evidence.currency, "USD");
  assert.equal(component.manufacturer_upc, "012345678905");
  assert.equal(component.canonical_identity.productLine, "Strawberry Snack");
  assert.match(component.content_provenance.content_hash, /^[a-f0-9]{64}$/);

  const candidate = buildProductTruthWalmartPilotCandidate({
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    as_of: options.asOf,
    price_max_age_ms: options.maxPriceAgeMs,
    zip: options.zip,
    components: [component],
  });
  assert.equal(candidate.storage_classification, "SHELF_STABLE");
  assert.equal(candidate.category, "Snack Foods");
});

test("canonical new-SKU compiler preserves ZIP and arithmetic fail-closed gates", () => {
  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity,
      price: { ...price, localityEvidence: "store_scoped", zip: null },
      qty: 2,
      index: 0,
      options,
    }),
    (error: unknown) =>
      error instanceof ProductTruthNewSkuReadError &&
      error.blockers.includes("donor-a:LOCALITY_EVIDENCE_INVALID"),
  );
  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity,
      price: { ...price, pricePerUnit: 1 },
      qty: 2,
      index: 0,
      options,
    }),
    /PRICE_PER_UNIT_ARITHMETIC_MISMATCH/,
  );
  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity: { ...identity, outerPackCount: 2 },
      price,
      qty: 2,
      index: 0,
      options,
    }),
    /CANONICAL_IDENTITY_INVALID/,
  );
  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity,
      price: { ...price, packSizeSeen: 2, pricePerUnit: Number(price.price) / 2 },
      qty: 2,
      index: 0,
      options,
    }),
    /PRICE_EVIDENCE_NOT_BASE_UNIT/,
  );
});

test("new-SKU compiler rejects stale identity and tampered immutable provenance", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...identity, matcherVersion: "canonical-product-match/1.1.0" }, /MATCHER_VERSION_NOT_CURRENT/],
    [{ ...identity, decisionEvidenceHash: "0".repeat(64) }, /DECISION_EVIDENCE_HASH_MISMATCH/],
    [{ ...identity, contentHash: "0".repeat(64) }, /CONTENT_HASH_MISMATCH/],
    [{ ...identity, fieldHashesJson: JSON.stringify({ title: "0".repeat(64) }) }, /CONTENT_FIELD_HASHES_INVALID/],
  ];
  for (const [tamperedIdentity, expected] of cases) {
    assert.throws(
      () => buildProductTruthNewSkuRecipeComponentFromRows({
        identity: tamperedIdentity,
        price,
        qty: 2,
        index: 0,
        options,
      }),
      expected,
    );
  }

  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity,
      price: { ...price, via: "instacart" },
      qty: 2,
      index: 0,
      options,
    }),
    /PRICE_VIA_NOT_DIRECT|PRICE_POLICY_NOT_FACT/,
  );
});

test("new-SKU compiler rejects scalar fact sentinels but accepts explicit no-allergen evidence", () => {
  for (const nutritionFacts of [false, 0] as const) {
    assert.throws(
      () => buildProductTruthNewSkuRecipeComponentFromRows({
        identity: validIdentityRowWithContent({ nutritionFacts }),
        price,
        qty: 2,
        index: 0,
        options,
      }),
      /NUTRITION_MISSING/,
    );
  }
  assert.throws(
    () => buildProductTruthNewSkuRecipeComponentFromRows({
      identity: validIdentityRowWithContent({
        allergens: false,
        attributes: { packageType: "Pouch" },
      }),
      price,
      qty: 2,
      index: 0,
      options,
    }),
    /ALLERGENS_MISSING/,
  );
  for (const allergens of [{ foo: [] }, [[]]] as const) {
    assert.throws(
      () => buildProductTruthNewSkuRecipeComponentFromRows({
        identity: validIdentityRowWithContent({ allergens }),
        price,
        qty: 2,
        index: 0,
        options,
      }),
      /ALLERGENS_MISSING/,
    );
  }
  const explicitNoAllergens = buildProductTruthNewSkuRecipeComponentFromRows({
    identity: validIdentityRowWithContent({ allergens: [] }),
    price,
    qty: 2,
    index: 0,
    options,
  });
  assert.deepEqual(explicitNoAllergens.facts.allergens, []);
});

test("Walmart pilot classification fails closed without immutable storage/category", () => {
  const component = buildProductTruthNewSkuRecipeComponentFromRows({
    identity,
    price,
    qty: 2,
    index: 0,
    options,
  });
  assert.throws(
    () => buildProductTruthWalmartPilotCandidate({
      contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
      as_of: options.asOf,
      price_max_age_ms: options.maxPriceAgeMs,
      zip: options.zip,
      components: [{
        ...component,
        content_classification: {
          ...component.content_classification,
          storage: null,
          storage_field: null,
        },
      }],
    }),
    /STORAGE_EVIDENCE_MISSING/,
  );
});

test("candidate pagination scans beyond early semantic rejects until limit or exhaustion", async () => {
  const component = buildProductTruthNewSkuRecipeComponentFromRows({
    identity,
    price,
    qty: 2,
    index: 0,
    options,
  });
  const base = buildProductTruthWalmartPilotCandidate({
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    as_of: options.asOf,
    price_max_age_ms: options.maxPriceAgeMs,
    zip: options.zip,
    components: [component],
  });
  const ids = ["bad-1", "bad-2", "bad-3", "good-1", "good-2"];
  const offsets: number[] = [];
  const result = await collectWalmartPilotCandidatesPaginated({
    limit: 2,
    pageSize: 2,
    readPage: async (offset, pageSize) => {
      offsets.push(offset);
      return ids.slice(offset, offset + pageSize);
    },
    readCandidate: async (donorProductId) => {
      if (donorProductId.startsWith("bad")) {
        throw new ProductTruthNewSkuReadError([`${donorProductId}:SEMANTIC_REJECT`]);
      }
      return { ...base, donor_product_id: donorProductId, title: donorProductId };
    },
  });
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(result.map((candidate) => candidate.donor_product_id), ["good-1", "good-2"]);
});

test("Bundle Factory compatibility facade owns no Product Truth SQL", () => {
  const facade = readFileSync(
    new URL("../../bundle-factory/product-truth-recipe-input.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(facade, /\bSELECT\b|\bJOIN\b|\.execute\s*\(/i);
  assert.match(facade, /product-truth-read-contract/);

  const sourcingReader = readFileSync(
    new URL("../product-truth-new-sku-view.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sourcingReader, /product\.upc|product\.category/i);
  assert.doesNotMatch(sourcingReader, /SELECT\s+category\s+FROM\s+DonorProduct/i);
});
