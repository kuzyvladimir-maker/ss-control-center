import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWalmartListingIntegrityGlobalAdmission,
  assertWalmartListingIntegrityGlobalAdmission,
  bootstrapWalmartListingIntegrityGlobalAdmissionRoot,
  completeWalmartListingIntegrityGlobalAdmission,
  inspectWalmartListingIntegrityGlobalAdmissionRoot,
  WalmartListingIntegrityGlobalAdmissionError,
  type WalmartListingIntegrityGlobalAdmissionBinding,
  type WalmartListingIntegrityGlobalAdmissionClaimInput,
} from "../listing-integrity-global-admission.ts";

const SHA = {
  permit: "1".repeat(64),
  package: "2".repeat(64),
  plan: "3".repeat(64),
  release: "4".repeat(64),
  evidence: "5".repeat(64),
};

async function fixture(): Promise<{
  parent: string;
  root: string;
  binding: WalmartListingIntegrityGlobalAdmissionBinding;
  claim: WalmartListingIntegrityGlobalAdmissionClaimInput;
}> {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "listing-admission-")));
  const root = path.join(parent, "global");
  const bootstrapped = await bootstrapWalmartListingIntegrityGlobalAdmissionRoot({
    root,
    created_at: "2026-08-01T17:00:00.000Z",
  });
  return {
    parent,
    root,
    binding: {
      root,
      expected_identity_sha256: bootstrapped.identity_file_sha256,
    },
    claim: {
      listing: {
        channel: "WALMART_US",
        store_index: 1,
        sku: "Exact-SKU-1",
        listing_key: "walmart:1:Exact-SKU-1",
        item_id: "123456789",
      },
      permit_authorization_sha256: SHA.permit,
      execution_package_artifact_sha256: SHA.package,
      plan_body_sha256: SHA.plan,
      frozen_release_id_sha256: SHA.release,
      claimed_at: "2026-08-01T17:01:00.000Z",
    },
  };
}

test("global admission allows exactly one atomic live claim across concurrent callers", async () => {
  const fx = await fixture();
  try {
    const attempts = await Promise.allSettled([
      acquireWalmartListingIntegrityGlobalAdmission({ binding: fx.binding, claim: fx.claim }),
      acquireWalmartListingIntegrityGlobalAdmission({
        binding: fx.binding,
        claim: {
          ...fx.claim,
          listing: {
            ...fx.claim.listing,
            sku: "Exact-SKU-2",
            listing_key: "walmart:1:Exact-SKU-2",
            item_id: "987654321",
          },
          permit_authorization_sha256: "6".repeat(64),
        },
      }),
    ]);
    assert.equal(attempts.filter((row) => row.status === "fulfilled").length, 1);
    const rejected = attempts.find((row) => row.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof WalmartListingIntegrityGlobalAdmissionError);
    assert.equal(rejected.reason.code, "GLOBAL_ADMISSION_OCCUPIED");

    const inspected = await inspectWalmartListingIntegrityGlobalAdmissionRoot(fx.binding);
    assert.equal(inspected.status, "OCCUPIED");
    assert.equal(inspected.active_claim?.retry_allowed, false);
    assert.equal((await stat(path.join(fx.root, "active"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(fx.root, "active", "claim.json"))).mode & 0o777, 0o400);
  } finally {
    await rm(fx.parent, { recursive: true, force: true });
  }
});

test("GET/Qualification continuation must match exact SKU, package, permit and release", async () => {
  const fx = await fixture();
  try {
    const claim = await acquireWalmartListingIntegrityGlobalAdmission({
      binding: fx.binding,
      claim: fx.claim,
    });
    assert.equal(
      (await assertWalmartListingIntegrityGlobalAdmission({
        binding: fx.binding,
        claim: fx.claim,
      })).claim_id,
      claim.claim_id,
    );
    await assert.rejects(
      assertWalmartListingIntegrityGlobalAdmission({
        binding: fx.binding,
        claim: { ...fx.claim, execution_package_artifact_sha256: "7".repeat(64) },
      }),
      (error: unknown) => error instanceof WalmartListingIntegrityGlobalAdmissionError
        && error.code === "GLOBAL_ADMISSION_MISMATCH",
    );
  } finally {
    await rm(fx.parent, { recursive: true, force: true });
  }
});

test("PASS is archived atomically, never deleted, and unblocks the next exact claim", async () => {
  const fx = await fixture();
  try {
    const active = await acquireWalmartListingIntegrityGlobalAdmission({
      binding: fx.binding,
      claim: fx.claim,
    });
    const terminal = await completeWalmartListingIntegrityGlobalAdmission({
      binding: fx.binding,
      claim: fx.claim,
      completed_at: "2026-08-01T17:15:00.000Z",
      outcome: "PASS",
      evidence_file_sha256: SHA.evidence,
    });
    assert.equal(terminal.outcome, "PASS");
    assert.equal((await inspectWalmartListingIntegrityGlobalAdmissionRoot(fx.binding)).status, "AVAILABLE");
    const history = path.join(fx.root, "history", active.claim_id);
    assert.equal(JSON.parse(await readFile(path.join(history, "claim.json"), "utf8")).claim_id, active.claim_id);
    assert.equal(JSON.parse(await readFile(path.join(history, "terminal.json"), "utf8")).outcome, "PASS");

    const second = {
      ...fx.claim,
      listing: {
        ...fx.claim.listing,
        sku: "Exact-SKU-2",
        listing_key: "walmart:1:Exact-SKU-2",
        item_id: "987654321",
      },
      permit_authorization_sha256: "6".repeat(64),
      execution_package_artifact_sha256: "7".repeat(64),
      claimed_at: "2026-08-01T17:16:00.000Z",
    };
    assert.equal(
      (await acquireWalmartListingIntegrityGlobalAdmission({
        binding: fx.binding,
        claim: second,
      })).listing.sku,
      "Exact-SKU-2",
    );
  } finally {
    await rm(fx.parent, { recursive: true, force: true });
  }
});

test("identity drift and a second bootstrap both fail closed", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      inspectWalmartListingIntegrityGlobalAdmissionRoot({
        ...fx.binding,
        expected_identity_sha256: "9".repeat(64),
      }),
      (error: unknown) => error instanceof WalmartListingIntegrityGlobalAdmissionError
        && error.code === "IDENTITY_MISMATCH",
    );
    await assert.rejects(
      bootstrapWalmartListingIntegrityGlobalAdmissionRoot({
        root: fx.root,
        created_at: "2026-08-01T17:20:00.000Z",
      }),
      (error: unknown) => error instanceof WalmartListingIntegrityGlobalAdmissionError
        && error.code === "ROOT_ALREADY_EXISTS",
    );
  } finally {
    await rm(fx.parent, { recursive: true, force: true });
  }
});
