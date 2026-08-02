import assert from "node:assert/strict";
import test from "node:test";

import {
  walmartListingIntegrityControlSha256,
} from "../listing-integrity-control-plane.ts";
import {
  compileWalmartListingIntegrityRemediationRoute,
  walmartListingIntegrityRouteIsDeferredImageRepair,
} from "../listing-integrity-remediation-route.ts";

function diagnosis(input: {
  text?: "PASS" | "REVIEW" | "BAD";
  main?: "PASS" | "REVIEW" | "BAD";
  gallery?: "PASS" | "REVIEW" | "BAD";
  titleMismatch?: boolean;
  bodyOuter?: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
  attributesOuter?: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
  outcome?: "BAD" | "REVIEW";
}) {
  const mainBad = input.main === "BAD";
  const galleryBad = input.gallery === "BAD";
  const body = {
    schema_version: "walmart-listing-single-process-report/v1",
    listing_key: "walmart:1:SKU-1",
    outcome: {
      status: input.outcome ?? "BAD",
      blockers: mainBad
        ? ["MAIN: wrong product"]
        : galleryBad ? ["GALLERY_1: wrong product"] : ["TEXT: quantity conflict"],
    },
    detector_input: {
      listing: { listing_key: "walmart:1:SKU-1", sku: "SKU-1" },
      expected: { outer_units: 6 },
    },
    detector_report: {
      overall_verdict: input.outcome ?? "BAD",
      blocking_reasons: mainBad ? ["MAIN: wrong product"] : [],
      text_decision: {
        verdict: input.text ?? "REVIEW",
        checks: {
          title_identity: input.titleMismatch ? "MISMATCH" : "MATCH",
          title_outer_units: "MATCH",
          title_package_facts: "MATCH",
          body_identity: "MATCH",
          body_outer_units: input.bodyOuter ?? "MATCH",
          body_package_facts: "MATCH",
          attributes_identity: "MATCH",
          attributes_outer_units: input.attributesOuter ?? "MATCH",
          attributes_package_facts: "MATCH",
        },
        hard_failures: [],
      },
      main_decision: {
        verdict: input.main ?? "PASS",
        checks: {
          external_quantity: "MATCH",
          single_package_per_cell: "MATCH",
          front: "MATCH",
          background: "MATCH",
          no_mixed_product: "MATCH",
          package_facts: { net_content: mainBad ? "MISMATCH" : "MATCH" },
        },
        hard_failures: mainBad ? ["wrong product"] : [],
      },
      gallery_decisions: [{
        verdict: input.gallery ?? "PASS",
        hard_failures: galleryBad ? ["wrong product"] : [],
        technical_error: null,
        missing_reason: null,
      }],
    },
  };
  return { ...body, body_sha256: walmartListingIntegrityControlSha256(body) };
}

test("routes a proven MAIN defect through description, bullets and MAIN only", () => {
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({ main: "BAD" }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(route.status, "AUTOMATIC_ROUTE_READY");
  assert.equal(route.route, "DESCRIPTION_BULLETS_MAIN");
  assert.deepEqual(route.changed_fields, ["description", "bullets", "main"]);
  assert.equal(route.safeguards.walmart_write_authorized, false);
});

test("routes a gallery hard failure through the full image-set path", () => {
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({ gallery: "BAD" }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(route.route, "DESCRIPTION_BULLETS_MAIN_GALLERY");
  assert.deepEqual(route.changed_fields, ["description", "bullets", "main", "gallery"]);
});

test("allows text-only only when MAIN and gallery are hard-failure free", () => {
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({
      text: "BAD",
      main: "PASS",
      gallery: "REVIEW",
      bodyOuter: "MISMATCH",
    }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(route.route, "DESCRIPTION_BULLETS");
  assert.deepEqual(route.changed_fields, ["description", "bullets"]);
});

test("routes an exact REVIEW through one combined non-image repair", () => {
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({
      outcome: "REVIEW",
      text: "REVIEW",
      main: "PASS",
      gallery: "REVIEW",
      bodyOuter: "NOT_APPLICABLE",
      attributesOuter: "UNKNOWN",
    }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(route.status, "AUTOMATIC_ROUTE_READY");
  assert.equal(route.route, "NON_IMAGE");
  assert.deepEqual(route.changed_fields, ["description", "bullets", "attributes"]);
  assert.equal(walmartListingIntegrityRouteIsDeferredImageRepair({
    route,
    defer_image_repairs: true,
  }), false);
});

test("owner image hold defers image routes but leaves text-only repair available", () => {
  const imageRoute = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({ gallery: "BAD" }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  const textRoute = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({
      text: "BAD",
      main: "PASS",
      gallery: "REVIEW",
      bodyOuter: "MISMATCH",
    }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(walmartListingIntegrityRouteIsDeferredImageRepair({
    route: imageRoute,
    defer_image_repairs: true,
  }), true);
  assert.equal(walmartListingIntegrityRouteIsDeferredImageRepair({
    route: textRoute,
    defer_image_repairs: true,
  }), false);
  assert.equal(walmartListingIntegrityRouteIsDeferredImageRepair({
    route: imageRoute,
    defer_image_repairs: false,
  }), false);
});

test("does not hide a title mismatch inside a text or image repair", () => {
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis({ main: "BAD", titleMismatch: true }),
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  });
  assert.equal(route.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(route.route, null);
  assert.match(route.blockers.join(" "), /TITLE_CHANGE/);
});

test("rejects a changed or cross-SKU diagnosis", () => {
  const input = diagnosis({ main: "BAD" });
  assert.throws(() => compileWalmartListingIntegrityRemediationRoute({
    diagnosis: { ...input, body_sha256: "a".repeat(64) },
    expected_listing_key: "walmart:1:SKU-1",
    expected_sku: "SKU-1",
  }), /body seal differs/);
  assert.throws(() => compileWalmartListingIntegrityRemediationRoute({
    diagnosis: input,
    expected_listing_key: "walmart:1:OTHER",
    expected_sku: "OTHER",
  }), /identity differs/);
});
