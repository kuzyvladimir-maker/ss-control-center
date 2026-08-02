import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartListingIntegrityRemediationInvocation,
  type WalmartListingIntegrityRemediationProcessConfig,
} from "../listing-integrity-remediation-process-adapter.server.ts";

const ROOT = "/private/workspace";
const FROZEN = "/private/release";
const SHA = "a".repeat(64);
const config: WalmartListingIntegrityRemediationProcessConfig = {
  node_path: "/opt/node",
  env_file: "/private/.env",
  workspace_engine_root: ROOT,
  frozen_engine_root: FROZEN,
};

test("main preparation commands are shell-free exact workspace invocations", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "build-main",
    product_truth: "/private/case/product-truth.json",
    diagnosis: "/private/case/diagnosis.json",
    output_dir: "/private/case/main",
  });
  assert.equal(built.cwd, ROOT);
  assert.equal(built.script, `${ROOT}/scripts/build-walmart-listing-main-candidate.ts`);
  assert.deepEqual(built.argv, [
    "--product-truth=/private/case/product-truth.json",
    "--diagnosis=/private/case/diagnosis.json",
    "--output-dir=/private/case/main",
  ]);
  assert.equal(built.argv.some((row) => row.includes("--all")), false);
});

test("owner package is compiled only from the pinned frozen engine", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "package",
    compilation_request: "/private/case/compilation-request.json",
    owner_confirmation: "Exact owner confirmation",
    private_key: "/private/key.pem",
    custody_root: "/private/custody",
    output_dir: "/private/case/package",
    verifier_release_sha256: SHA,
    apply_release_sha256: SHA,
    approved_by: "owner-policy",
  });
  assert.equal(built.cwd, FROZEN);
  assert.equal(built.argv[0], "package");
  assert.equal(built.argv.some((row) => row.includes("--all")), false);
  assert.equal(built.argv.some((row) => row.includes("retry")), false);
});

test("text-only route uses Product Truth directly and the exact review chain", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "build-text",
    product_truth: "/private/case/product-truth.json",
    diagnosis: "/private/case/diagnosis.json",
    buyer_snapshot: "/private/case/snapshot.json",
    buyer_pdp: "/private/case/pdp.json",
    output_dir: "/private/case/text",
  });
  assert.equal(built.argv.some((row) => row.startsWith("--content-evidence=")), false);
  const compiled = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "compile-text",
    proposal: "/private/case/text/review-proposal.json",
    diagnosis: "/private/case/diagnosis.json",
    buyer_snapshot: "/private/case/snapshot.json",
    buyer_pdp: "/private/case/pdp.json",
    donor_audit: "/private/case/text/donor-audit.json",
    certification: "/private/case/text/review-certification.json",
    asset_root: "/private/case/capture",
    output: "/private/case/text/compilation-request.json",
  });
  assert.equal(compiled.argv[0], "prepare-repair");
  assert.equal(compiled.argv.some((row) => row.includes("--all")), false);
});

test("combined non-image route is one shell-free local candidate build", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "build-non-image",
    product_truth: "/private/case/product-truth.json",
    diagnosis: "/private/case/diagnosis.json",
    buyer_snapshot: "/private/case/snapshot.json",
    buyer_pdp: "/private/case/pdp.json",
    output_dir: "/private/case/non-image",
  });
  assert.equal(built.cwd, ROOT);
  assert.match(built.script, /build-walmart-listing-non-image-repair-candidate\.ts$/u);
  assert.deepEqual(built.argv, [
    "--product-truth=/private/case/product-truth.json",
    "--diagnosis=/private/case/diagnosis.json",
    "--buyer-snapshot=/private/case/snapshot.json",
    "--buyer-pdp=/private/case/pdp.json",
    "--output-dir=/private/case/non-image",
  ]);
  assert.equal(built.argv.some((row) => row.includes("--all")), false);
});

test("gallery repair compiles the exact contiguous image-set chain", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "compile-image-set",
    preview: "/private/case/preview/preview.json",
    diagnosis: "/private/case/diagnosis.json",
    buyer_snapshot: "/private/case/snapshot.json",
    buyer_pdp: "/private/case/pdp.json",
    seller_item: "/private/case/seller.json",
    product_truth: "/private/case/product-truth.json",
    main_candidate_dir: "/private/case/main",
    source_candidate_dir: "/private/case/image-set",
    qualification_dir: "/private/case/qualification",
    curated_dir: "/private/case/curated",
    r2_staging: "/private/case/r2.json",
    output_dir: "/private/case/compilation",
  });
  assert.match(built.script, /build-walmart-listing-image-set-compilation-request\.ts$/u);
  assert.equal(built.argv.length, 12);
  assert.equal(built.argv.some((row) => row.includes("--all")), false);
});

test("post-Qualification gallery is a shell-free no-write workspace invocation", () => {
  const built = buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "build-live-gallery",
    before_dir: "/private/case/capture",
    after_dir: "/private/case/operator/r9-qualify/capture.evidence",
    execution_package: "/private/case/remediation/owner-package/execution-package.json",
    qualification_receipt: "/private/case/operator/r9-qualify/receipt.json",
    output_dir: "/private/case/final-gallery",
  });
  assert.equal(built.cwd, ROOT);
  assert.match(built.script, /build-walmart-listing-integrity-live-gallery\.mjs$/u);
  assert.deepEqual(built.argv, [
    "--before-dir=/private/case/capture",
    "--after-dir=/private/case/operator/r9-qualify/capture.evidence",
    "--execution-package=/private/case/remediation/owner-package/execution-package.json",
    "--qualification-receipt=/private/case/operator/r9-qualify/receipt.json",
    "--output-dir=/private/case/final-gallery",
  ]);
  assert.equal(built.argv.some((row) => row.includes("--all")), false);
});

test("rejects relative paths and malformed release bindings", () => {
  assert.throws(() => buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "build-main",
    product_truth: "relative.json",
    diagnosis: "/private/case/diagnosis.json",
    output_dir: "/private/case/main",
  }), /absolute normalized path/);
  assert.throws(() => buildWalmartListingIntegrityRemediationInvocation(config, {
    command: "package",
    compilation_request: "/private/case/compilation-request.json",
    owner_confirmation: "Exact owner confirmation",
    private_key: "/private/key.pem",
    custody_root: "/private/custody",
    output_dir: "/private/case/package",
    verifier_release_sha256: "bad",
    apply_release_sha256: SHA,
    approved_by: "owner-policy",
  }), /lowercase SHA-256/);
});
