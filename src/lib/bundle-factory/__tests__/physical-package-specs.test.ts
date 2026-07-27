import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
  parseVerifiedPhysicalPackageSpecs,
  physicalPackageSpecsMatchSku,
  withVerifiedPhysicalPackageSpecs,
} from "@/lib/bundle-factory/physical-package-specs";

const measured = {
  weight_oz: 32,
  length_in: 14,
  width_in: 10,
  height_in: 6,
};

test("calculated cooler/box planning values are not physical proof", () => {
  const packaging = JSON.stringify({
    cooler_size: "L",
    shipping_weight_lb: 24,
    box_dimensions_in: { length: 20, width: 14, height: 12 },
  });
  assert.equal(parseVerifiedPhysicalPackageSpecs(packaging), null);
});

test("ship-specs merge preserves metadata and creates verified provenance", () => {
  const packaging = withVerifiedPhysicalPackageSpecs(
    JSON.stringify({ cooler_size: "L", note: "keep" }),
    measured,
    new Date("2026-07-17T12:00:00.000Z"),
  );
  const parsed = JSON.parse(packaging) as Record<string, unknown>;
  assert.equal(parsed.cooler_size, "L");
  assert.equal(parsed.note, "keep");
  assert.deepEqual(parseVerifiedPhysicalPackageSpecs(packaging), {
    schema_version: VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
    source: "OPERATOR_SHIP_SPECS",
    verified_at: "2026-07-17T12:00:00.000Z",
    ...measured,
  });
});

test("ship-specs merge refuses to discard malformed existing metadata", () => {
  assert.throws(
    () => withVerifiedPhysicalPackageSpecs("{bad", measured),
    /malformed packaging_spec/i,
  );
  assert.throws(
    () => withVerifiedPhysicalPackageSpecs("[]", measured),
    /non-object packaging_spec/i,
  );
});

test("publisher proof must match all four persisted SKU values", () => {
  const proof = parseVerifiedPhysicalPackageSpecs(
    withVerifiedPhysicalPackageSpecs(null, measured),
  );
  assert.ok(proof);
  assert.equal(
    physicalPackageSpecsMatchSku(
      {
        package_weight_oz: 32,
        package_length_in: 14,
        package_width_in: 10,
        package_height_in: 6,
      },
      proof,
    ),
    true,
  );
  assert.equal(
    physicalPackageSpecsMatchSku(
      {
        package_weight_oz: 32,
        package_length_in: 14,
        package_width_in: 10,
        package_height_in: 7,
      },
      proof,
    ),
    false,
  );
});
