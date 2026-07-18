// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-carton-decomposition.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  planExactReviewedCartonDecomposition,
} from "../audit/uncrustables-carton-decomposition";
import type {
  ResolvedReviewedUncrustablesPackageArt,
} from "../audit/uncrustables-main-authenticity";

const evidence = [{
  kind: "reviewed-artifact" as const,
  locator: "data/audits/fixture.jpg",
  sha256: "a".repeat(64),
}];

function carton(
  flavor_id: string,
  retail_pack_size: number,
  art_id = `${flavor_id}-${retail_pack_size}ct`,
): ResolvedReviewedUncrustablesPackageArt {
  return {
    flavor_id,
    pack_mode: "retail-carton",
    retail_pack_size,
    art_id,
    evidence,
  };
}

test("uses the fewest exact reviewed cartons: 24 = 10 + 10 + 4", () => {
  const result = planExactReviewedCartonDecomposition({
    flavor_id: "chocolate-hazelnut",
    quantity: 24,
    reviewed_art: [
      carton("chocolate-hazelnut", 15),
      carton("chocolate-hazelnut", 10),
      carton("chocolate-hazelnut", 4),
    ],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.total_cartons, 3);
    assert.deepEqual(result.expanded_pack_sizes, [10, 10, 4]);
    assert.deepEqual(
      result.lines.map((line) => [line.retail_pack_size, line.visible_carton_count]),
      [[10, 2], [4, 1]],
    );
  }
});

test("uses stable reviewed-registry order to break equal-carton ties", () => {
  const first = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 10,
    reviewed_art: [carton("flavor-a", 4), carton("flavor-a", 5), carton("flavor-a", 6)],
  });
  const second = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 10,
    reviewed_art: [carton("flavor-a", 5), carton("flavor-a", 4), carton("flavor-a", 6)],
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(first.expanded_pack_sizes, [4, 6]);
    assert.deepEqual(second.expanded_pack_sizes, [5, 5]);
  }
});

test("fails closed for a cross-flavor pack, ambiguity, or no exact sum", () => {
  const crossFlavor = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 24,
    reviewed_art: [carton("flavor-a", 10), carton("flavor-b", 4)],
  });
  assert.equal(crossFlavor.ok, false);
  if (!crossFlavor.ok) assert.equal(crossFlavor.code, "ART_SCOPE_MISMATCH");

  const ambiguous = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 20,
    reviewed_art: [
      carton("flavor-a", 10, "old-10ct"),
      carton("flavor-a", 10, "new-10ct"),
    ],
  });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, "AMBIGUOUS_REVIEWED_PACK_SIZE");
  }

  const impossible = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 23,
    reviewed_art: [carton("flavor-a", 10), carton("flavor-a", 4)],
  });
  assert.equal(impossible.ok, false);
  if (!impossible.ok) assert.equal(impossible.code, "NO_EXACT_DECOMPOSITION");
});

test("fails closed for malformed or self-unverifiable evidence metadata", () => {
  const nullEntry = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 20,
    reviewed_art: [
      null as unknown as ResolvedReviewedUncrustablesPackageArt,
    ],
  });
  assert.equal(nullEntry.ok, false);
  if (!nullEntry.ok) assert.equal(nullEntry.code, "ART_INVALID");

  const invalidEvidence = carton("flavor-a", 10);
  invalidEvidence.evidence = [{
    kind: "reviewed-artifact",
    locator: "",
    sha256: "x",
  }];
  const result = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 20,
    reviewed_art: [invalidEvidence],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ART_INVALID");

  const missingRuntimeMetadata = {
    flavor_id: "flavor-a",
    pack_mode: "retail-carton",
    retail_pack_size: 10,
    art_id: null,
    evidence: [null],
  } as unknown as ResolvedReviewedUncrustablesPackageArt;
  const missing = planExactReviewedCartonDecomposition({
    flavor_id: "flavor-a",
    quantity: 20,
    reviewed_art: [missingRuntimeMetadata],
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "ART_INVALID");
});
