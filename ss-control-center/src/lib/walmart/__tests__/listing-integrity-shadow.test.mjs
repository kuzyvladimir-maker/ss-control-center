import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadListingIntegrityShadowData } from "../listing-integrity-shadow.server.ts";

const ROOT = path.resolve(
  import.meta.dirname,
  "../../../..",
  "data/audits/walmart-listing-integrity-fresh-controls",
);

test("projects the fresh quantity-confusion control into read-only Command Center data", async () => {
  const data = await loadListingIntegrityShadowData(ROOT);
  assert.equal(data.mode, "SHADOW_READ_ONLY");
  assert.equal(data.catalog.status, "CAPTURE_TEST_READY");
  assert.equal(data.catalog.snapshotVerified, true);
  assert.equal(data.catalog.catalog.total, 3936);
  assert.equal(data.catalog.catalog.exactOnce, true);
  assert.equal(data.catalog.catalog.duplicateSkus, 0);
  assert.equal(data.catalog.queues.visualTriageReady, 1464);
  assert.equal(data.catalog.queues.sourceAcquisitionRequired, 1431);
  assert.equal(data.catalog.visualScan.tasks, 1964);
  assert.equal(data.catalog.visualScan.partitions, 57);
  assert.equal(data.catalog.visualScan.capturedPartitions, 1);
  assert.equal(data.catalog.visualScan.capturedAssets, 32);
  assert.equal(data.catalog.visualScan.captureTechnicalErrors, 0);
  assert.equal(data.catalog.visualScan.modelCallsCompleted, 0);
  assert.equal(data.catalog.visualScan.walmartWrites, 0);
  assert.equal(data.engine.closedLoopTestsPassed, 109);
  assert.equal(data.engine.focusedTestsPassed, 37);
  assert.equal(data.engine.visualComparatorTestsPassed, 38);
  assert.equal(data.engine.observationTestsPassed, 17);
  assert.equal(data.engine.workerSecurityTestsPassed, 17);
  assert.equal(data.engine.shadowTestsPassed, 8);
  assert.equal(data.engine.walmartWrites, 0);
  assert.equal(data.productTruth.status, "BLOCKED_SKU_TRUTH_NOT_READY");
  assert.equal(data.productTruth.schemaReady, true);
  assert.equal(data.productTruth.pendingMigrations, 0);
  assert.equal(data.productTruth.listingKey, "walmart:1:FaisalX-1183");
  assert.deepEqual(data.productTruth.blockers, [
    "LISTING_SCOPE_NOT_REGISTERED",
    "CURRENT_SCOPED_SKU_COST_MISSING",
  ]);
  assert.equal(data.productTruth.executionPackageReady, false);
  assert.equal(data.productTruth.walmartWriteAuthorized, false);
  assert.equal(data.productTruth.massRunAuthorized, false);
  assert.equal(
    data.productTruth.sharedPlanSha256,
    "37c6d141e3d97c3d8fef1f54f57cff6725b6b657126c48b23194a9db487913fa",
  );
  assert.equal(data.gates.productTruth, "BLOCKED_SKU_TRUTH_NOT_READY");
  assert.equal(data.gates.liveCanary, "LOCKED");
  assert.equal(data.gates.massRun, "LOCKED");
  assert.equal(data.cases.length, 1);

  const control = data.cases[0];
  assert.equal(control.sku, "FaisalX-1183");
  assert.equal(control.itemId, "8419413379");
  assert.equal(control.expectedOuterUnits, 6);
  assert.equal(control.observedMainUnits, 1);
  assert.equal(control.beforeVerdict, "BAD");
  assert.equal(control.proposedMainVerdict, "PASS");
  assert.equal(control.proposedMain.representedOuterUnits, 6);
  assert.equal(control.byteCustodyStatus, "VERIFIED");
  assert.equal(control.visualAttestationStatus, "SIGNED_TARGET_PASS_GALLERY_REVIEW_REQUIRED");
  assert.equal(control.visualAttestation.currentMainVerdict, "BAD");
  assert.equal(control.visualAttestation.targetMainVerdict, "PASS");
  assert.equal(control.visualAttestation.galleryBadCount, 0);
  assert.equal(control.visualAttestation.galleryReviewCount, 2);
  assert.equal(control.visualAttestation.signedReceiptCount, 2);
  assert.equal(control.ownerVisualReviewStatus, "APPROVED");
  assert.equal(control.ownerVisualReview.currentMainAcceptedAsOnePackage, true);
  assert.equal(control.ownerVisualReview.proposedMainAcceptedAsSixPackages, true);
  assert.equal(control.ownerVisualReview.galleryAccepted, true);
  assert.equal(control.ownerVisualReview.walmartWriteAuthorized, false);
  assert.match(data.gates.next, /Canonical Product Truth schema is ready/);
  assert.match(data.gates.next, /LISTING_SCOPE_NOT_REGISTERED/);
  assert.deepEqual(control.changedFields, ["MAIN"]);
  assert.equal(control.currentImages.length, 3);
});

test("missing evidence root remains a safe empty shadow view", async () => {
  const data = await loadListingIntegrityShadowData(path.join(ROOT, "does-not-exist"));
  assert.deepEqual(data.cases, []);
  assert.equal(data.catalog.status, "NOT_CAPTURED");
  assert.equal(data.productTruth.status, "UNVERIFIED");
  assert.equal(data.productTruth.schemaReady, false);
  assert.equal(data.productTruth.executionPackageReady, false);
  assert.equal(data.productTruth.walmartWriteAuthorized, false);
  assert.equal(data.productTruth.massRunAuthorized, false);
  assert.equal(data.gates.massRun, "LOCKED");
});

test("Product Truth readiness fails closed when its SHA-bound bytes change", async (t) => {
  const tempParent = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-truth-tamper-"));
  t.after(async () => {
    await rm(tempParent, { recursive: true });
  });
  const tempRoot = path.join(tempParent, "evidence");
  await cp(ROOT, tempRoot, { recursive: true });
  const readinessPath = path.join(tempRoot, "_product-truth-readiness.json");
  const bytes = await readFile(readinessPath);
  await chmod(readinessPath, 0o600);
  await writeFile(readinessPath, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(
    loadListingIntegrityShadowData(tempRoot),
    /Product Truth readiness SHA-256 mismatch/,
  );
});

test("a self-asserted Product Truth READY state cannot unlock the shadow UI", async (t) => {
  const tempParent = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-false-ready-"));
  t.after(async () => {
    await rm(tempParent, { recursive: true });
  });
  const tempRoot = path.join(tempParent, "evidence");
  await cp(ROOT, tempRoot, { recursive: true });
  const readinessPath = path.join(tempRoot, "_product-truth-readiness.json");
  const sidecarPath = path.join(tempRoot, "_product-truth-readiness.sha256");
  const readiness = JSON.parse(await readFile(readinessPath, "utf8"));
  readiness.status = "READY";
  const bytes = Buffer.from(`${JSON.stringify(readiness, null, 2)}\n`);
  await chmod(readinessPath, 0o600);
  await chmod(sidecarPath, 0o600);
  await writeFile(readinessPath, bytes);
  await writeFile(sidecarPath, `${createHash("sha256").update(bytes).digest("hex")}\n`);
  await assert.rejects(
    loadListingIntegrityShadowData(tempRoot),
    /unsupported Product Truth readiness state/,
  );
});

test("signed shadow evidence fails closed when an attestation byte changes", async (t) => {
  const tempParent = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-shadow-tamper-"));
  t.after(async () => {
    await rm(tempParent, { recursive: true });
  });
  const tempRoot = path.join(tempParent, "evidence");
  await cp(ROOT, tempRoot, { recursive: true });
  const attestationPath = path.join(
    tempRoot,
    "FaisalX-1183-20260722T122025Z",
    "shadow-vision-20260722T224545Z",
    "attestation-v5.json",
  );
  const bytes = await readFile(attestationPath);
  await chmod(attestationPath, 0o600);
  await writeFile(attestationPath, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(
    loadListingIntegrityShadowData(tempRoot),
    /visual attestation bundle\.files\.attestation SHA-256 mismatch/,
  );
});

test("owner visual review fails closed when a reviewed byte changes", async (t) => {
  const tempParent = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-owner-review-tamper-"));
  t.after(async () => {
    await rm(tempParent, { recursive: true });
  });
  const tempRoot = path.join(tempParent, "evidence");
  await cp(ROOT, tempRoot, { recursive: true });
  const reviewPath = path.join(
    tempRoot,
    "FaisalX-1183-20260722T122025Z",
    "owner-visual-review-20260722T234908Z.json",
  );
  const bytes = await readFile(reviewPath);
  await chmod(reviewPath, 0o600);
  await writeFile(reviewPath, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(
    loadListingIntegrityShadowData(tempRoot),
    /owner visual review SHA-256 mismatch/,
  );
});

test("finds MAIN by slot instead of trusting image order", async (t) => {
  const source = JSON.parse(await readFile(
    path.join(ROOT, "FaisalX-1183-20260722T122025Z/manifest.json"),
    "utf8",
  ));
  source.current_images.reverse();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-shadow-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true });
  });
  const caseRoot = path.join(tempRoot, "reordered-control");
  await mkdir(caseRoot);
  const manifestBytes = Buffer.from(JSON.stringify(source));
  await writeFile(path.join(caseRoot, "manifest.json"), manifestBytes);
  const preview = JSON.parse(await readFile(
    path.join(ROOT, "FaisalX-1183-20260722T122025Z/canary-preview.json"),
    "utf8",
  ));
  preview.source_manifest.sha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const previewBytes = Buffer.from(JSON.stringify(preview));
  await writeFile(path.join(caseRoot, "canary-preview.json"), previewBytes);
  await writeFile(
    path.join(caseRoot, "canary-preview.sha256"),
    createHash("sha256").update(previewBytes).digest("hex"),
  );
  await writeFile(
    path.join(tempRoot, "_verification.json"),
    await readFile(path.join(ROOT, "_verification.json")),
  );
  await writeFile(
    path.join(tempRoot, "_verification.sha256"),
    await readFile(path.join(ROOT, "_verification.sha256")),
  );
  await writeFile(
    path.join(tempRoot, "_product-truth-readiness.json"),
    await readFile(path.join(ROOT, "_product-truth-readiness.json")),
  );
  await writeFile(
    path.join(tempRoot, "_product-truth-readiness.sha256"),
    await readFile(path.join(ROOT, "_product-truth-readiness.sha256")),
  );

  const data = await loadListingIntegrityShadowData(tempRoot);
  assert.equal(data.cases[0].observedMainUnits, 1);
  assert.equal(data.cases[0].visualAttestationStatus, "PENDING");
});
