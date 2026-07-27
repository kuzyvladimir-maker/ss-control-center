/**
 * Union loader tests (Phase A0 of the studio integration plan): the sealed
 * static manifests verify as a union, tampering fails closed, registration
 * is idempotent by sha256 and rejects corrupt candidates atomically.
 *
 * Run: npx tsx --test src/lib/bundle-factory/audit/__tests__/uncrustables-owner-approval-manifests.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearRegisteredOwnerApprovalManifestsForTests,
  allUnionOwnerApprovedProofs,
  registerSealedOwnerApprovalManifest,
  STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS,
  unionManifestContainingProof,
  unionUncrustablesOwnerApprovalManifests,
  verifyUncrustablesOwnerApprovalManifestUnion,
  type UncrustablesMainOwnerApprovalManifest,
} from "../uncrustables-owner-approval-manifests";
import { verifyProductionUncrustablesAuthenticityArtifacts } from "../uncrustables-main-production-preflight";

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("real static union (v3 + trial1) verifies end to end", () => {
  verifyUncrustablesOwnerApprovalManifestUnion();
  assert.ok(STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS.length >= 2);
  const proofs = allUnionOwnerApprovedProofs();
  assert.ok(proofs.length >= 20, `expected >=20 proofs, got ${proofs.length}`);
});

test("preflight facade still verifies through the union loader", () => {
  verifyProductionUncrustablesAuthenticityArtifacts();
});

test("a tampered entry breaks the manifest seal", () => {
  const manifests = clone(
    unionUncrustablesOwnerApprovalManifests(),
  ) as UncrustablesMainOwnerApprovalManifest[];
  manifests[1].entries[0].sku = "TAMPERED-SKU";
  assert.throws(
    () => verifyUncrustablesOwnerApprovalManifestUnion(undefined, manifests),
    /SHA-256 seal/,
  );
});

test("a duplicated proof across manifests fails cross-manifest uniqueness", () => {
  const manifests = clone(
    unionUncrustablesOwnerApprovalManifests(),
  ) as UncrustablesMainOwnerApprovalManifest[];
  // Re-append an exact copy of an already-sealed manifest: every seal is
  // intact, so the union must die on proof_id duplication instead.
  manifests.push(clone(manifests[1]));
  assert.throws(
    () => verifyUncrustablesOwnerApprovalManifestUnion(undefined, manifests),
    /Duplicate owner-approved proof_id/,
  );
});

test("manifestContainingProof pins the exact sealed manifest", () => {
  const [v3, trial1] = STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS;
  for (const manifest of [v3, trial1]) {
    for (const proof of manifest.entries) {
      assert.equal(
        unionManifestContainingProof(proof.proof_id).sha256,
        manifest.sha256,
      );
    }
  }
  assert.throws(() => unionManifestContainingProof("no-such-proof"));
});

test("registration is idempotent by sha256 and rejects corrupt candidates atomically", () => {
  try {
    // Re-registering an already-present static manifest is a no-op.
    assert.equal(
      registerSealedOwnerApprovalManifest(
        STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS[1],
      ),
      false,
    );
    // A corrupt candidate throws and must NOT enter the union.
    const corrupt = clone(
      STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS[1],
    ) as UncrustablesMainOwnerApprovalManifest;
    corrupt.sha256 = "0".repeat(64);
    assert.throws(() => registerSealedOwnerApprovalManifest(corrupt));
    assert.equal(
      unionUncrustablesOwnerApprovalManifests().length,
      STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS.length,
    );
    // And the union still verifies clean after the rejected attempt.
    verifyUncrustablesOwnerApprovalManifestUnion();
  } finally {
    __clearRegisteredOwnerApprovalManifestsForTests();
  }
});
