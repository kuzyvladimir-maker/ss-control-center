/**
 * Minting-lib tests on REAL committed trial artifacts (xl-protein-90 bytes).
 * Run: npx tsx --test src/lib/bundle-factory/audit/__tests__/uncrustables-owner-approval-minting.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  mintCandidateProof,
  sealStudioOwnerApprovalManifest,
} from "../uncrustables-owner-approval-minting";
import {
  __clearRegisteredOwnerApprovalManifestsForTests,
  registerSealedOwnerApprovalManifest,
  verifySealedOwnerApprovalManifest,
} from "../uncrustables-owner-approval-manifests";
import { MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "../uncrustables-authenticity-merged";

const ROOT = path.resolve(__dirname, "../../../../..");
const REAL_PNG = readFileSync(
  path.resolve(
    ROOT,
    "data/audits/uncrustables-trial-publish-20260723/xl-protein-90.png",
  ),
);

const XL90_COMPS = [
  { flavor: "Peanut Butter & Honey Spread", qty: 10, box_size: 10, box_count: 1 },
  { flavor: "Peanut Butter & Blueberry", qty: 32, box_size: 8, box_count: 4 },
  { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 32, box_size: 8, box_count: 4 },
  { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 16, box_size: 8, box_count: 2 },
];

function mintInput(slug: string) {
  return {
    slug,
    sku: "ST-TEST-0001",
    mainImageUrl:
      "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/trial1-xl-protein-90/main.png",
    imageBytes: REAL_PNG,
    prompt: "test prompt",
    referenceUrls: ["https://refs.example/anchor.png"],
    renderScript: "studio",
    workerLabel: "codex-image-worker (test)",
    comps: XL90_COMPS,
    observedAt: new Date("2026-07-27T01:00:00Z"),
    approvedAt: new Date("2026-07-27T01:05:00Z"),
    reviewNotes:
      "Test review: carton-by-carton verification protocol executed in unit test.",
    approvalNotes: "Test approval bound to real archived bytes.",
  };
}

const locator = (slug: string, kind: string) =>
  `data/audits/uncrustables-studio/${slug}.${kind === "image" ? "png" : "generation-manifest.json"}`;

test("mints a self-verifying production proof from real archived bytes", () => {
  const minted = mintCandidateProof(
    mintInput("studio-test-xl90"),
    { reviewer: "owner", session: "test-session-1" },
    locator,
  );
  assert.equal(minted.pixelDimensions.width, 2048);
  assert.equal(minted.proof.approval_scope, "production-main");
  assert.equal(minted.proof.production_eligible, true);
  assert.equal(minted.proof.human_approval.reviewer, "owner");
  assert.equal(
    minted.proof.human_approval.reviewed_at,
    "2026-07-27T01:05:00.000Z",
  );
  assert.equal(minted.proof.image.sha256, minted.imageSha256);
});

test("sealed studio manifest passes the union verifier in isolation", () => {
  const minted = mintCandidateProof(
    mintInput("studio-test-xl90"),
    { reviewer: "owner", session: "test-session-1" },
    locator,
  );
  const manifest = sealStudioOwnerApprovalManifest({
    manifestId: "uncrustables-studio-test-manifest-1",
    capturedAt: new Date("2026-07-27T01:06:00Z"),
    approvedBy: "owner",
    entries: [minted.proof],
  });
  verifySealedOwnerApprovalManifest(
    manifest,
    MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY as never,
    new Set(),
    new Set(),
  );
});

test("union registration accepts a unique studio proof and rejects a second approval of a listing already in the static trial manifest", () => {
  try {
    const unique = mintCandidateProof(
      mintInput("studio-test-xl90"),
      { reviewer: "owner", session: "test-session-1" },
      locator,
    );
    const okManifest = sealStudioOwnerApprovalManifest({
      manifestId: "uncrustables-studio-test-manifest-2",
      capturedAt: new Date("2026-07-27T01:07:00Z"),
      approvedBy: "owner",
      entries: [unique.proof],
    });
    assert.equal(registerSealedOwnerApprovalManifest(okManifest), true);

    // Slug "xl-protein-90" reproduces proof_id production-xl-protein-90,
    // which already exists in the sealed trial1 manifest → union must refuse.
    const colliding = mintCandidateProof(
      mintInput("xl-protein-90"),
      { reviewer: "owner", session: "test-session-1" },
      locator,
    );
    const badManifest = sealStudioOwnerApprovalManifest({
      manifestId: "uncrustables-studio-test-manifest-3",
      capturedAt: new Date("2026-07-27T01:08:00Z"),
      approvedBy: "owner",
      entries: [colliding.proof],
    });
    assert.throws(
      () => registerSealedOwnerApprovalManifest(badManifest),
      /Duplicate owner-approved (proof_id|listing)/,
    );
  } finally {
    __clearRegisteredOwnerApprovalManifestsForTests();
  }
});

test("non-PNG bytes and small dimensions fail closed", () => {
  assert.throws(
    () =>
      mintCandidateProof(
        { ...mintInput("studio-bad"), imageBytes: Buffer.from("nope") },
        { reviewer: "owner", session: "s" },
        locator,
      ),
    /not a PNG/,
  );
});

test("unknown flavor fails closed", () => {
  assert.throws(
    () =>
      mintCandidateProof(
        {
          ...mintInput("studio-bad-flavor"),
          comps: [{ flavor: "Fictional Flavor", qty: 90, box_size: 8, box_count: 11 }],
        },
        { reviewer: "owner", session: "s" },
        locator,
      ),
    /not in merged registry/,
  );
});
