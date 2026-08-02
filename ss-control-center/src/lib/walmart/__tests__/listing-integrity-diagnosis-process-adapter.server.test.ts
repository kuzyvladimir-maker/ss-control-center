import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartListingIntegrityDiagnosisArgv,
  parseWalmartListingIntegrityDiagnosisProcessStdout,
} from "../listing-integrity-diagnosis-process-adapter.server.ts";

const MANIFEST_SHA = "a".repeat(64);

test("diagnosis adapter builds only one exact SKU capture", () => {
  assert.deepEqual(buildWalmartListingIntegrityDiagnosisArgv({
    command: "capture",
    sku: "FaisalX-2000",
    store_index: 1,
    product_truth_manifest_sha256: MANIFEST_SHA,
    output_dir: "/private/capture",
  }), [
    "capture",
    "--sku=FaisalX-2000",
    "--store-index=1",
    `--product-truth-manifest-sha256=${MANIFEST_SHA}`,
    "--output-dir=/private/capture",
  ]);
  assert.throws(
    () => buildWalmartListingIntegrityDiagnosisArgv({
      command: "capture",
      sku: "FaisalX-2000",
      store_index: 1,
      product_truth_manifest_sha256: MANIFEST_SHA,
      output_dir: "relative",
    }),
    /DIAGNOSIS_PROCESS_INVALID/,
  );
  assert.deepEqual(buildWalmartListingIntegrityDiagnosisArgv({
    command: "inspect",
    sku: "FaisalX-2000",
    store_index: 1,
    product_truth_manifest_sha256: MANIFEST_SHA,
    output_dir: "/private/source-required-inspection",
  }), [
    "inspect",
    "--sku=FaisalX-2000",
    "--store-index=1",
    `--product-truth-manifest-sha256=${MANIFEST_SHA}`,
    "--output-dir=/private/source-required-inspection",
  ]);
});

test("diagnosis adapter rejects implicit scope and exposes no write command", () => {
  const observe = buildWalmartListingIntegrityDiagnosisArgv({
    command: "observe",
    intake_dir: "/private/capture",
    output_dir: "/private/observe",
  });
  const diagnose = buildWalmartListingIntegrityDiagnosisArgv({
    command: "diagnose",
    product_truth: "/private/product-truth.json",
    buyer_snapshot: "/private/buyer-snapshot.json",
    buyer_pdp: "/private/buyer-pdp.json",
    observations: "/private/observations.json",
    asset_root: "/private/capture",
    output: "/private/diagnosis.json",
  });
  assert.equal(observe[0], "observe");
  assert.equal(diagnose[0], "diagnose");
  assert.equal([...observe, ...diagnose].some((value) => (
    /execute|apply|retry|--all/u.test(value)
  )), false);
});

test("diagnosis adapter accepts exact JSON after bounded Walmart transport logs", () => {
  const parsed = parseWalmartListingIntegrityDiagnosisProcessStdout(Buffer.from([
    "[WALMART][STORE1] token issued, expires at 2026-08-01T23:39:03.021Z",
    "[WALMART][STORE1] GET /v3/items/FaisalX-2554 → 200 (tokens: 149, 1026ms, cid=test)",
    "{",
    '  "status": "CAPTURED",',
    '  "listing_key": "walmart:1:FaisalX-2554"',
    "}",
    "",
  ].join("\n"), "utf8"));
  assert.deepEqual(parsed, {
    status: "CAPTURED",
    listing_key: "walmart:1:FaisalX-2554",
  });
});

test("diagnosis adapter rejects unbounded stdout prefixes and trailing junk", () => {
  assert.throws(
    () => parseWalmartListingIntegrityDiagnosisProcessStdout(Buffer.from(
      'unexpected log\n{"status":"CAPTURED"}\n',
      "utf8",
    )),
    /does not end in one JSON object after bounded Walmart logs/u,
  );
  assert.throws(
    () => parseWalmartListingIntegrityDiagnosisProcessStdout(Buffer.from(
      '[WALMART][STORE1] ok\n{"status":"CAPTURED"}\ntrailing',
      "utf8",
    )),
    /does not end in one JSON object after bounded Walmart logs/u,
  );
});
