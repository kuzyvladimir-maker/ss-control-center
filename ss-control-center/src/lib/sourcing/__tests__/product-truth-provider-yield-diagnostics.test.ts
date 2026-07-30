import assert from "node:assert/strict";
import test from "node:test";

import {
  scoreOffer,
  type CanonicalProduct,
  type RetailOffer,
} from "../retail-fetch";
import {
  assertProductTruthProviderYieldDiagnostics,
  buildProductTruthProviderYieldDiagnostics,
  PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY,
  ProductTruthProviderYieldPersistenceError,
  providerYieldDiagnosticsFromError,
} from "../product-truth-provider-yield-diagnostics";

const NOW = "2026-07-30T05:30:00.000Z";
const target: CanonicalProduct = {
  brand: "Cheerios",
  product_line: "Honey Nut Cereal",
  size: "18.8 oz",
  outer_pack_count: 1,
};

function offer(overrides: Partial<RetailOffer> = {}): RetailOffer {
  return {
    retailer: "walmart",
    retailerProductId: "123",
    price: 5.49,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/123?api_key=secret-value&source=audit",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-30T05:29:00.000Z",
    title: "Cheerios Honey Nut Cereal, 18.8 oz",
    brand: "Cheerios",
    description: "DO_NOT_PERSIST_RAW_DESCRIPTION",
    keyFeatures: ["DO_NOT_PERSIST_RAW_FEATURE"],
    imageUrls: ["https://images.example/DO_NOT_PERSIST_RAW_IMAGE.jpg"],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct",
    meteredReceiptId: "receipt-1",
    meteredRunId: "run-1",
    meteredApprovalId: "approval-1",
    ...overrides,
  };
}

test("provider yield diagnostics retain matcher and price decisions without raw content or secrets", () => {
  const exact = scoreOffer(offer(), target);
  const adjacentVariant = scoreOffer(offer({
    retailerProductId: "456",
    title: "Cheerios Chocolate Cereal, 18.8 oz",
  }), target);

  const diagnostics = buildProductTruthProviderYieldDiagnostics({
    query: "Cheerios Honey Nut Cereal 18.8 oz",
    evaluatedAt: NOW,
    target,
    sources: [{
      source: "oxylabs:walmart",
      status: "completed",
      detail: "ZIP_SCOPED:33765 authorization=top-secret",
      candidates: [
        {
          offer: exact,
          admission: { verdict: "ADMIT", reasonCode: "ADMITTED" },
        },
        {
          offer: adjacentVariant,
          admission: { verdict: "REJECT", reasonCode: "SCORE_REJECTED" },
        },
      ],
    }],
  });

  assert.equal(diagnostics.totals.parsedCandidates, 2);
  assert.equal(diagnostics.totals.recordedCandidates, 2);
  assert.equal(diagnostics.sources[0].candidates[0].identityMatch?.verdict, "EXACT_IDENTITY");
  assert.equal(diagnostics.sources[0].candidates[0].priceEvidence.eligibility, "FACT");
  assert.equal(diagnostics.sources[0].candidates[1].identityMatch?.verdict, "REJECT");
  assert.equal(diagnostics.sources[0].candidates[1].admission.reasonCode, "SCORE_REJECTED");
  assert.match(diagnostics.sources[0].detail ?? "", /authorization=\[REDACTED\]/);
  assert.doesNotMatch(diagnostics.sources[0].candidates[0].productUrl ?? "", /secret-value/);

  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /DO_NOT_PERSIST_RAW_/);
  assert.doesNotMatch(serialized, /top-secret|secret-value/);
  assert.equal(assertProductTruthProviderYieldDiagnostics(diagnostics), diagnostics);
});

test("provider yield diagnostics are deterministically bounded and hash tampering fails closed", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    offer: scoreOffer(offer({
      retailerProductId: `item-${index}`,
      title: `Honey Nut Cheerios Cereal, 18.8 oz item ${index} ${"x".repeat(700)}`,
    }), target),
    admission: {
      verdict: "REJECT" as const,
      reasonCode: "SCORE_REJECTED" as const,
    },
  }));
  const first = buildProductTruthProviderYieldDiagnostics({
    query: "Cheerios Honey Nut Cereal 18.8 oz",
    evaluatedAt: NOW,
    target,
    sources: [{
      source: "oxylabs:walmart",
      status: "completed",
      candidates,
    }],
  });
  const second = buildProductTruthProviderYieldDiagnostics({
    query: "Cheerios Honey Nut Cereal 18.8 oz",
    evaluatedAt: NOW,
    target,
    sources: [{
      source: "oxylabs:walmart",
      status: "completed",
      candidates,
    }],
  });

  assert.equal(
    first.sources[0].recordedCandidateCount,
    PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxCandidatesPerSource,
  );
  assert.equal(first.sources[0].truncatedCandidateCount, 10);
  assert.equal(first.diagnosticsSha256, second.diagnosticsSha256);
  assert.ok(
    Buffer.byteLength(JSON.stringify(first), "utf8")
      <= PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxSerializedBytes,
  );

  const tampered = structuredClone(first);
  tampered.query = "tampered";
  assert.throws(
    () => assertProductTruthProviderYieldDiagnostics(tampered),
    /PROVIDER_YIELD_DIAGNOSTICS_HASH_MISMATCH/,
  );
});

test("persistence failures carry the already-built diagnostics", () => {
  const diagnostics = buildProductTruthProviderYieldDiagnostics({
    query: "Cheerios Honey Nut Cereal 18.8 oz",
    evaluatedAt: NOW,
    target,
    sources: [],
  });
  const error = new ProductTruthProviderYieldPersistenceError(
    "write failed",
    diagnostics,
    new Error("database unavailable"),
  );
  assert.equal(providerYieldDiagnosticsFromError(error), diagnostics);
  assert.equal(providerYieldDiagnosticsFromError(new Error("other")), null);
});
