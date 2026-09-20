import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseWalmartListingIntegritySuccessorArgs,
  publishCompletedGallery,
  recoverPublishedMainFailureAdmission,
  verifyAuditedPassGallery,
  verifyWalmartListingIntegritySuccessorCatalogSnapshot,
  walmartListingIntegrityControlReadmission,
  walmartListingIntegrityReservedListingKeys,
} from "../walmart-listing-integrity-successor-worker.ts";
import {
  walmartListingIntegrityCatalogSha256,
} from "../../src/lib/walmart/listing-integrity-catalog-orchestrator.ts";
import {
  walmartListingIntegrityControlSha256,
} from "../../src/lib/walmart/listing-integrity-control-plane.ts";
import {
  acquireWalmartListingIntegrityGlobalAdmission,
  bootstrapWalmartListingIntegrityGlobalAdmissionRoot,
  inspectWalmartListingIntegrityGlobalAdmissionRoot,
} from "../../src/lib/walmart/listing-integrity-global-admission.ts";

test("successor watcher is exact, bounded and rejects mass flags", () => {
  const parsed = parseWalmartListingIntegritySuccessorArgs([
    "watch",
    "--custody-root", "/private/custody",
    "--status-path", "/private/status.json",
    "--max-audits", "3",
  ]);
  assert.deepEqual(parsed, {
    command: "watch",
    custody_root: "/private/custody",
    status_path: "/private/status.json",
    max_audits: 3,
  });
  for (const argv of [
    ["watch", "--all", "1"],
    ["watch", "--custody-root", "/private/custody", "--status-path", "/private/status.json", "--max-audits", "11"],
    ["once", "--custody-root", "relative", "--max-audits", "1"],
  ]) {
    assert.throws(
      () => parseWalmartListingIntegritySuccessorArgs(argv),
      /WALMART_LISTING_SUCCESSOR_INVALID/,
    );
  }
});

test("successor doctor accepts no scope because it cannot write", () => {
  assert.deepEqual(parseWalmartListingIntegritySuccessorArgs(["doctor"]), {
    command: "doctor",
    custody_root: null,
    status_path: null,
    max_audits: 0,
  });
  assert.throws(
    () => parseWalmartListingIntegritySuccessorArgs(["doctor", "--all", "1"]),
    /WALMART_LISTING_SUCCESSOR_INVALID/,
  );
});

test("successor wave excludes SKU reserved by the parallel Walmart session", () => {
  assert.deepEqual(walmartListingIntegrityReservedListingKeys, [
    "walmart:1:FaisalX-1435",
  ]);
});

test("successor pins the exact single-use algorithm-fix readmission artifact", () => {
  assert.deepEqual(walmartListingIntegrityControlReadmission, {
    relativePath:
      "data/audits/walmart-listing-integrity-readmission/20260802T002700Z-v14-false-negative-v1/readmission.json",
    fileSha256:
      "e527bcd195267bd255207259e08c62ece7cb9cf55afeadf87f2848b4f7098252",
  });
});

test("successor accepts only fresh authoritative catalog snapshot results", () => {
  const outputDir = "/private/catalog-snapshot";
  const result = {
    status: "AUTHORITATIVE_READ_ONLY_PLAN_READY",
    local_artifacts: {
      output_dir: outputDir,
      census_sha256: "a".repeat(64),
      plan_sha256: "b".repeat(64),
    },
    freshness: {
      verified: true,
      authority: "AUTHORITATIVE_ITEM_CATALOG_REPORT_MIRROR",
      report_request_id: "report-request-1",
      report_age_ms: 60_000,
      snapshot_age_ms: 1_000,
      catalog_rows: 5_235,
    },
    external_effects: {
      database_reads: 3,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      model_calls: 0,
      paid_api_calls: 0,
    },
  };
  assert.equal(
    verifyWalmartListingIntegritySuccessorCatalogSnapshot(result, outputDir)
      .freshness.report_request_id,
    "report-request-1",
  );
  for (const mutation of [
    (value: typeof result) => { value.freshness.report_age_ms = 24 * 60 * 60 * 1_000 + 1; },
    (value: typeof result) => { value.freshness.authority = "PROVISIONAL"; },
    (value: typeof result) => { value.external_effects.walmart_writes = 1; },
  ]) {
    const changed = structuredClone(result);
    mutation(changed);
    assert.throws(
      () => verifyWalmartListingIntegritySuccessorCatalogSnapshot(changed, outputDir),
      /not fresh/u,
    );
  }
});

test("successor verifies and publishes no-change gallery before advancement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wli-successor-gallery-"));
  const source = path.join(root, "source");
  await mkdir(source, { mode: 0o700 });
  const checks = Object.fromEntries(
    Array.from({ length: 19 }, (_, index) => [`check_${index}`, true]),
  );
  const body = {
    schema_version: "walmart-listing-integrity-no-change-verification/v1",
    status: "LIVE_SURFACE_PASS",
    completion_mode: "AUDITED_NO_CHANGE",
    qualified_at: "2026-08-01T20:00:00.000Z",
    listing: {
      listing_key: "walmart:1:SKU-CLEAN",
      sku: "SKU-CLEAN",
      item_id: "123456789",
      store_index: 1,
    },
    feed_id: null,
    exact_payload_sha256: null,
    before: { captured_at: "2026-08-01T19:59:00.000Z" },
    after: { captured_at: "2026-08-01T19:59:00.000Z" },
    checks,
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      source_aware_qualification_receipt_emitted: true,
      no_walmart_write_required: true,
      next_sku_unblocked: true,
    },
  };
  const verification = {
    ...body,
    body_sha256: walmartListingIntegrityCatalogSha256(body),
  };
  const verificationBytes = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`);
  const htmlBytes = Buffer.from("<!doctype html><title>clean before after</title>\n");
  const verificationPath = path.join(source, "live-canary-verification.json");
  await Promise.all([
    writeFile(verificationPath, verificationBytes, { mode: 0o400 }),
    writeFile(path.join(source, "before-after-gallery.html"), htmlBytes, { mode: 0o400 }),
  ]);
  try {
    const bodySha = await verifyAuditedPassGallery({
      verification_path: verificationPath,
      listing_key: "walmart:1:SKU-CLEAN",
      sku: "SKU-CLEAN",
      item_id: "123456789",
    });
    assert.equal(bodySha, verification.body_sha256);
    const published = await publishCompletedGallery({
      root,
      source_dir: source,
      sku: "SKU-CLEAN",
      completion_mode: "AUDITED_NO_CHANGE",
      body_sha256: bodySha,
    });
    assert.equal(published.status, "GALLERY_PUBLISHED");
    assert.deepEqual(
      await readFile(path.join(published.destination, "live-canary-verification.json")),
      verificationBytes,
    );
    assert.deepEqual(
      await readFile(path.join(published.destination, "before-after-gallery.html")),
      htmlBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successor recovers only an exact published MAIN quarantine without replay", async () => {
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "wli-successor-quarantine-"),
  ));
  const admissionRoot = path.join(root, "admission");
  const bootstrapped = await bootstrapWalmartListingIntegrityGlobalAdmissionRoot({
    root: admissionRoot,
    created_at: "2026-08-01T22:00:00.000Z",
  });
  const binding = {
    root: admissionRoot,
    expected_identity_sha256: bootstrapped.identity_file_sha256,
  };
  const claim = {
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-MAIN-FAIL",
      listing_key: "walmart:1:SKU-MAIN-FAIL",
      item_id: "123456789",
    },
    permit_authorization_sha256: "1".repeat(64),
    execution_package_artifact_sha256: "2".repeat(64),
    plan_body_sha256: "3".repeat(64),
    frozen_release_id_sha256: "4".repeat(64),
    claimed_at: "2026-08-01T22:01:00.000Z",
  };
  await acquireWalmartListingIntegrityGlobalAdmission({ binding, claim });
  const dispositionBody = {
    schema_version: "walmart-listing-integrity-main-terminal-failure-disposition/v1" as const,
    disposition_id: "main-failure-disposition-test",
    created_at: "2026-08-01T23:12:27.000Z",
    status: "QUARANTINED_UNRESOLVED" as const,
    listing: claim.listing,
    accepted_feed: {
      feed_id: "feed-main",
      terminal_at: "2026-08-01T22:10:00.000Z",
      request_payload_sha256: "5".repeat(64),
      feed_status_payload_sha256: "6".repeat(64),
      walmart_item_result: "SUCCESS" as const,
    },
    bindings: {
      execution_package_artifact_sha256: claim.execution_package_artifact_sha256,
      permit_authorization_sha256: claim.permit_authorization_sha256,
      plan_body_sha256: claim.plan_body_sha256,
      frozen_release_id_sha256: claim.frozen_release_id_sha256,
    },
    failed_qualification: {
      qualification_id: "qualification-main",
      qualified_at: "2026-08-01T23:12:26.000Z",
      qualification_body_sha256: "7".repeat(64),
      operator_receipt_body_sha256: "8".repeat(64),
      operator_receipt_file_sha256: "9".repeat(64),
      propagation_window_complete: true as const,
      published_and_indexed_preserved: true as const,
      automatic_reapply_allowed: false as const,
    },
    main_evidence: {
      live_main_sha256: "a".repeat(64),
      target_main_sha256: "b".repeat(64),
      live_capture_created_at: "2026-08-01T23:12:26.000Z",
      live_capture_intake_index_body_sha256: "c".repeat(64),
      encoded_bytes_exact: false as const,
      equivalent: false as const,
      dhash_distance: 28,
      maximum_dhash_distance: 2,
      psnr_millidb: 0,
      minimum_psnr_millidb: 38000,
    },
    classification: {
      outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_MAIN" as const,
      likely_platform_cause:
        "CATALOG_CONTENT_PRIORITY_PROPAGATION_OR_OWNERSHIP" as const,
      cause_proof_level: "LIKELY_NOT_PROVEN" as const,
      same_payload_reapply_allowed: false as const,
      listing_repair_complete: false as const,
    },
    sequence: {
      next_listing_unblocked: true as const,
      quarantined_listing_excluded_from_active_pool: true as const,
      max_apply_in_flight: 1 as const,
    },
    next_action: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN" as const,
    marketplace_write_authorized: false as const,
  };
  const disposition = {
    ...dispositionBody,
    body_sha256: walmartListingIntegrityControlSha256(dispositionBody),
  };
  const bytes = Buffer.from(`${JSON.stringify(disposition, null, 2)}\n`, "utf8");
  const fileSha = createHash("sha256").update(bytes).digest("hex");
  const quarantineDir = path.join(
    root,
    "data/audits/walmart-listing-integrity-quarantine/main-failure",
  );
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(quarantineDir, "failure-disposition.json"), bytes, { mode: 0o400 }),
    writeFile(
      path.join(quarantineDir, "failure-disposition.sha256"),
      `${fileSha}\n`,
      { mode: 0o400 },
    ),
  ]);
  try {
    const admission = await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding);
    const recovered = await recoverPublishedMainFailureAdmission({
      root,
      admission,
      admission_binding: binding,
      snapshot: {
        installation: "INSTALLED",
        runtime_policy_stage: "OFF",
        run: {
          run_id: "run-published-main-failure",
          release_id_sha256: claim.frozen_release_id_sha256,
          status: "ACTIVE",
          items: [{
            state: "QUARANTINED_UNRESOLVED",
            identity: {
              listing_key: claim.listing.listing_key,
              sku: claim.listing.sku,
              store_index: claim.listing.store_index,
              item_id: "wpid-not-buyer-item-id",
              ordinal: 0,
            },
            execution_package_sha256: claim.execution_package_artifact_sha256,
            owner_permit_sha256: claim.permit_authorization_sha256,
          }],
        },
      } as never,
    });
    assert.equal(recovered?.status, "RECOVERED_PUBLISHED_MAIN_FAILURE_ADMISSION");
    assert.equal(recovered?.disposition_file_sha256, fileSha);
    assert.equal(
      (await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding)).status,
      "AVAILABLE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successor rebuilds a missing MAIN disposition from exact persisted Qualification", async () => {
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "wli-successor-main-crash-recovery-"),
  ));
  const custodyRoot = path.join(root, "custody");
  await mkdir(custodyRoot, { mode: 0o700 });
  const admissionRoot = path.join(root, "admission");
  const bootstrapped = await bootstrapWalmartListingIntegrityGlobalAdmissionRoot({
    root: admissionRoot,
    created_at: "2026-08-01T22:00:00.000Z",
  });
  const binding = {
    root: admissionRoot,
    expected_identity_sha256: bootstrapped.identity_file_sha256,
  };
  const claim = {
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-MAIN-CRASH",
      listing_key: "walmart:1:SKU-MAIN-CRASH",
      item_id: "987654321",
    },
    permit_authorization_sha256: createHash("sha256").update("permit").digest("hex"),
    execution_package_artifact_sha256:
      createHash("sha256").update("package").digest("hex"),
    plan_body_sha256: createHash("sha256").update("plan").digest("hex"),
    frozen_release_id_sha256: createHash("sha256").update("release").digest("hex"),
    claimed_at: "2026-08-01T22:01:00.000Z",
  };
  await acquireWalmartListingIntegrityGlobalAdmission({ binding, claim });
  const seal = <T extends Record<string, unknown>>(body: T) => ({
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const qualifiedAt = "2026-08-01T23:12:26.000Z";
  const qualification = seal({
    schema_version: "walmart-listing-integrity-repair-live-qualification/v2",
    qualification_id: "qualification-main-crash-recovery",
    qualified_at: qualifiedAt,
    verdict: "FAIL",
    listing: claim.listing,
    plan_body_sha256: claim.plan_body_sha256,
    permit_authorization_sha256: claim.permit_authorization_sha256,
    feed_id: "feed-main-crash-recovery",
    feed_terminal_at: "2026-08-01T22:10:00.000Z",
    apply_custody: {
      request_payload_sha256: digest("payload"),
      terminal_feed_status_payload_sha256: digest("feed-status"),
    },
    facets: {
      attributes: "PASS",
      bullets: "PASS",
      description: "PASS",
      exact_listing_identity: "PASS",
      exact_repair_target: "FAIL",
      fresh_authenticated_live_reread: "PASS",
      gallery: "PASS",
      main: "FAIL",
      pack_count: "PASS",
      product_and_variant: "PASS",
      published_and_indexed: "PASS",
      terminal_apply_custody: "PASS",
      title: "PASS",
      unchanged_fields_preserved: "FAIL",
    },
    main_equivalence: {
      live_sha256: digest("old-main"),
      target_sha256: digest("target-main"),
      encoded_bytes_exact: false,
      equivalent: false,
      dhash_distance: 28,
      maximum_dhash_distance: 2,
      psnr_millidb: 0,
      minimum_psnr_millidb: 38000,
    },
    live_capture: {
      created_at: qualifiedAt,
      intake_index_body_sha256: digest("intake"),
      image_sha256: [digest("old-main")],
    },
    propagation: {
      failure_not_before: "2026-08-01T23:12:25.210Z",
      reread_before_failure_window: false,
      recheck_same_sku_without_write: false,
    },
    next_sku_unblocked: false,
    next_action: "OWNER_REVIEW_REPLAN",
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
  });
  const receipt = seal({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "qualify",
    status: "FAIL",
    execution_package_artifact_sha256: claim.execution_package_artifact_sha256,
    permit_authorization_sha256: claim.permit_authorization_sha256,
    listing: claim.listing,
    qualification,
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
    external_effects: {
      model_calls: 0,
      paid_provider_calls: 0,
      database_writes: 0,
      walmart_content_writes: 0,
    },
  });
  const runId = "run-main-crash-recovery";
  const revision = 5;
  const caseId = `case-0-${digest(claim.listing.listing_key).slice(0, 16)}`;
  const receiptRoot = path.join(
    custodyRoot,
    runId,
    caseId,
    "operator",
    `r${revision - 1}-qualify`,
  );
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(receiptRoot, "receipt.json"),
    `${JSON.stringify(receipt)}\n`,
    { mode: 0o400 },
  );
  try {
    const admission = await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding);
    const recovered = await recoverPublishedMainFailureAdmission({
      root,
      custody_root: custodyRoot,
      admission,
      admission_binding: binding,
      snapshot: {
        installation: "INSTALLED",
        runtime_policy_stage: "OFF",
        run: {
          run_id: runId,
          release_id_sha256: claim.frozen_release_id_sha256,
          status: "ACTIVE",
          items: [{
            state: "QUARANTINED_UNRESOLVED",
            revision,
            identity: { ...claim.listing, ordinal: 0 },
            execution_package_sha256: claim.execution_package_artifact_sha256,
            owner_permit_sha256: claim.permit_authorization_sha256,
          }],
        },
      } as never,
    });
    assert.equal(recovered?.status, "RECOVERED_PUBLISHED_MAIN_FAILURE_ADMISSION");
    assert.equal(recovered?.disposition_rebuilt_from_receipt, true);
    assert.equal(recovered?.walmart_writes, 0);
    assert.equal(
      (await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding)).status,
      "AVAILABLE",
    );
    const quarantineRoot = path.join(
      root,
      "data/audits/walmart-listing-integrity-quarantine",
    );
    const directories = await readdir(quarantineRoot);
    assert.equal(directories.length, 1);
    const disposition = JSON.parse(await readFile(
      path.join(quarantineRoot, directories[0]!, "failure-disposition.json"),
      "utf8",
    ));
    assert.equal(disposition.listing.listing_key, claim.listing.listing_key);
    assert.equal(disposition.failed_qualification.qualified_at, qualifiedAt);
    assert.equal(disposition.marketplace_write_authorized, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
