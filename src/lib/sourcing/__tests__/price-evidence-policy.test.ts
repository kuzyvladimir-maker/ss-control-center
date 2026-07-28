import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRICE_EVIDENCE_POLICY_VERSION,
  PRODUCT_TRUTH_PROCUREMENT_ZIP,
  classifyPriceEvidenceRetailer,
  evaluatePriceEvidenceEligibility,
  type PriceEvidenceCandidate,
  type PriceEvidencePolicyOptions,
  type PriceEvidenceReasonCode,
} from "../price-evidence-policy";

const NOW = "2026-07-18T16:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;
const policy: PriceEvidencePolicyOptions = { now: NOW, maxAgeMs: HOUR_MS };

function validCandidate(overrides: Partial<PriceEvidenceCandidate> = {}): PriceEvidenceCandidate {
  return {
    retailer: "Publix",
    via: "direct",
    price: 5.49,
    isFirstParty: true,
    inStock: true,
    zip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
    localityEvidence: "zip_scoped",
    fetchedAt: "2026-07-18T15:30:00.000Z",
    matchVerdict: "EXACT_IDENTITY",
    ...overrides,
  };
}

function assertRejected(
  overrides: Partial<PriceEvidenceCandidate>,
  reason: PriceEvidenceReasonCode,
  options: PriceEvidencePolicyOptions = policy,
): void {
  const result = evaluatePriceEvidenceEligibility(validCandidate(overrides), options);
  assert.equal(result.eligibility, "REJECT");
  assert.ok(result.reasonCodes.includes(reason), JSON.stringify(result));
}

test("fresh exact direct first-party Clearwater offer is factual evidence", () => {
  const result = evaluatePriceEvidenceEligibility(validCandidate(), policy);

  assert.deepEqual(result, {
    eligibility: "FACT",
    policyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    reasonCodes: ["EXACT_IDENTITY_DIRECT_FACT"],
    retailerKey: "publix",
    retailerLocality: "LOCAL",
    localityEvidence: "zip_scoped",
    normalizedZip: "33765",
    requiredZip: "33765",
    ageMs: 30 * 60 * 1000,
    maxAgeMs: HOUR_MS,
    matchVerdict: "EXACT_IDENTITY",
  });
});

test("known national direct offer can be fact without a local ZIP", () => {
  const result = evaluatePriceEvidenceEligibility(
    validCandidate({
      retailer: "Amazon.com",
      zip: null,
      localityEvidence: "national_unscoped",
    }),
    policy,
  );

  assert.equal(result.eligibility, "FACT");
  assert.equal(result.retailerKey, "amazon");
  assert.equal(result.retailerLocality, "NATIONAL");
  assert.equal(result.requiredZip, null);
});

test("a stored Clearwater ZIP is not locality proof by itself", () => {
  assertRejected(
    { zip: "33765", localityEvidence: null },
    "LOCALITY_SCOPE_UNPROVEN",
  );
  assertRejected(
    { zip: "33765", localityEvidence: "national_unscoped" },
    "LOCALITY_SCOPE_MISMATCH",
  );

  const proven = evaluatePriceEvidenceEligibility(
    validCandidate({ zip: "33765", localityEvidence: "zip_scoped" }),
    policy,
  );
  assert.equal(proven.eligibility, "FACT");
});

test("store-scoped evidence also proves a local offer, but unknown scope does not", () => {
  const storeScoped = evaluatePriceEvidenceEligibility(
    validCandidate({ localityEvidence: "store_scoped" }),
    policy,
  );
  assert.equal(storeScoped.eligibility, "FACT");
  assert.equal(storeScoped.localityEvidence, "store_scoped");

  assertRejected(
    { localityEvidence: "claimed_local" },
    "LOCALITY_EVIDENCE_UNSUPPORTED",
  );
});

test("national evidence must explicitly prove its national scope", () => {
  assertRejected(
    { retailer: "Amazon", zip: null, localityEvidence: null },
    "LOCALITY_SCOPE_UNPROVEN",
  );
  assertRejected(
    { retailer: "Amazon", zip: null, localityEvidence: "zip_scoped" },
    "LOCALITY_SCOPE_MISMATCH",
  );

  const national = evaluatePriceEvidenceEligibility(
    validCandidate({
      retailer: "Amazon",
      zip: null,
      localityEvidence: "national_unscoped",
    }),
    policy,
  );
  assert.equal(national.eligibility, "FACT");
});

test("canonical matcher estimate verdicts remain explicitly typed estimates", () => {
  const cases = [
    ["CROSS_SIZE_ESTIMATE", "CROSS_SIZE_ESTIMATE"],
    ["SIBLING_ESTIMATE", "SIBLING_ESTIMATE"],
    ["SIZE_UNKNOWN_ESTIMATE", "SIZE_UNKNOWN_ESTIMATE"],
  ] as const;

  for (const [matchVerdict, reason] of cases) {
    const result = evaluatePriceEvidenceEligibility(validCandidate({ matchVerdict }), policy);
    assert.equal(result.eligibility, "ESTIMATE", matchVerdict);
    assert.deepEqual(result.reasonCodes, [reason]);
  }
});

test("Instacart is estimate-only even for otherwise exact evidence", () => {
  const exact = evaluatePriceEvidenceEligibility(validCandidate({ via: "instacart" }), policy);
  assert.equal(exact.eligibility, "ESTIMATE");
  assert.deepEqual(exact.reasonCodes, ["INSTACART_ESTIMATE"]);

  const crossSize = evaluatePriceEvidenceEligibility(
    validCandidate({ via: "instacart", matchVerdict: "CROSS_SIZE_ESTIMATE" }),
    policy,
  );
  assert.equal(crossSize.eligibility, "ESTIMATE");
  assert.deepEqual(crossSize.reasonCodes, ["CROSS_SIZE_ESTIMATE", "INSTACART_ESTIMATE"]);
});

test("matcher rejection and unknown matcher states fail closed", () => {
  assertRejected({ matchVerdict: "REJECT" }, "MATCH_REJECTED");
  assertRejected({ matchVerdict: "LEGACY_FUZZY" }, "MATCH_VERDICT_UNSUPPORTED");
  assertRejected({ matchVerdict: null }, "MATCH_VERDICT_UNSUPPORTED");
});

test("first-party evidence must be explicitly true", () => {
  assertRejected({ isFirstParty: false }, "FIRST_PARTY_FALSE");
  assertRejected({ isFirstParty: null }, "FIRST_PARTY_UNPROVEN");
  assertRejected({ isFirstParty: undefined }, "FIRST_PARTY_UNPROVEN");
});

test("stock must be explicitly true", () => {
  assertRejected({ inStock: false }, "OUT_OF_STOCK");
  assertRejected({ inStock: null }, "STOCK_UNKNOWN");
  assertRejected({ inStock: undefined }, "STOCK_UNKNOWN");
});

test("price must be present, finite, and positive", () => {
  assertRejected({ price: null }, "PRICE_MISSING");
  assertRejected({ price: 0 }, "PRICE_NOT_POSITIVE");
  assertRejected({ price: -1 }, "PRICE_NOT_POSITIVE");
  assertRejected({ price: Number.NaN }, "PRICE_NOT_FINITE");
  assertRejected({ price: Number.POSITIVE_INFINITY }, "PRICE_NOT_FINITE");
});

test("freshness accepts the exact boundary and rejects stale evidence", () => {
  const boundary = evaluatePriceEvidenceEligibility(
    validCandidate({ fetchedAt: "2026-07-18T15:00:00.000Z" }),
    policy,
  );
  assert.equal(boundary.eligibility, "FACT");
  assert.equal(boundary.ageMs, HOUR_MS);

  assertRejected(
    { fetchedAt: "2026-07-18T14:59:59.999Z" },
    "EVIDENCE_STALE",
  );
});

test("missing, invalid, unzoned, and future timestamps are rejected", () => {
  assertRejected({ fetchedAt: null }, "FETCHED_AT_MISSING");
  assertRejected({ fetchedAt: "not-a-date" }, "FETCHED_AT_INVALID");
  assertRejected({ fetchedAt: "2026-07-18T15:30:00" }, "FETCHED_AT_INVALID");
  assertRejected({ fetchedAt: "2026-07-18T16:00:00.001Z" }, "FETCHED_AT_IN_FUTURE");
});

test("invalid explicit evaluation time or freshness policy rejects", () => {
  assertRejected({}, "POLICY_NOW_INVALID", { now: "not-a-date", maxAgeMs: HOUR_MS });
  assertRejected({}, "POLICY_NOW_INVALID", {
    now: "2026-07-18T16:00:00",
    maxAgeMs: HOUR_MS,
  });
  assertRejected({}, "POLICY_MAX_AGE_INVALID", { now: NOW, maxAgeMs: -1 });
  assertRejected({}, "POLICY_MAX_AGE_INVALID", { now: NOW, maxAgeMs: Number.NaN });
});

test("every known local chain requires Clearwater ZIP 33765", () => {
  for (const retailer of [
    "Publix Super Markets",
    "BJ's Wholesale Club",
    "ALDI",
    "Walmart.com",
    "Target",
    "Sam's Club",
    "Costco",
    "Winn-Dixie",
    "Whole Foods Market",
  ]) {
    assertRejected({ retailer, zip: null }, "LOCAL_ZIP_MISSING");
    assertRejected({ retailer, zip: "34695" }, "LOCAL_ZIP_MISMATCH");
  }
});

test("ZIP+4 for Clearwater is accepted while malformed ZIP is not", () => {
  const zip4 = evaluatePriceEvidenceEligibility(
    validCandidate({ zip: "33765-1234" }),
    policy,
  );
  assert.equal(zip4.eligibility, "FACT");
  assert.equal(zip4.normalizedZip, "33765");

  assertRejected({ zip: "33765 USA" }, "LOCAL_ZIP_INVALID");
});

test("unknown retailer locality cannot silently bypass local proof", () => {
  const result = evaluatePriceEvidenceEligibility(
    validCandidate({ retailer: "New Neighborhood Grocer", zip: null }),
    policy,
  );

  assert.equal(result.eligibility, "REJECT");
  assert.equal(result.retailerLocality, "UNKNOWN");
  assert.ok(result.reasonCodes.includes("RETAILER_UNRECOGNIZED"));
});

test("missing or unsupported source route is rejected", () => {
  assertRejected({ via: null }, "VIA_MISSING");
  assertRejected({ via: "google-shopping" }, "VIA_UNSUPPORTED");
});

test("retailer classification is normalized but versioned and closed", () => {
  assert.deepEqual(classifyPriceEvidenceRetailer(" BJ’s Wholesale Club "), {
    key: "bjs",
    locality: "LOCAL",
  });
  assert.deepEqual(classifyPriceEvidenceRetailer("Amazon"), {
    key: "amazon",
    locality: "NATIONAL",
  });
  assert.deepEqual(classifyPriceEvidenceRetailer(""), {
    key: null,
    locality: "UNKNOWN",
  });
});
