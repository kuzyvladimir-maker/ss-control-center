import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type { ListingItem, ListingPatch } from "@/lib/amazon-sp-api/listings";

import {
  applyPreRequestAbortDisposition,
  buildPreRequestAbortDispositionProposal,
  releasePreRequestAbortDispositionFence,
  writePreRequestAbortDispositionProposal,
} from "../repair/uncrustables-pre-request-abort-disposition";
import {
  PRE_REQUEST_ABORT_TERMINAL_STATUS,
  preRequestAbortFenceReleaseConfirmationToken,
} from "../repair/uncrustables-pre-request-abort-disposition-contract";
import {
  ImmutableCheckpointStore,
  executeRepairPlan,
  readRepairExecutionSelection,
  readRepairPlan,
  type RepairAmazonGateway,
} from "../repair/uncrustables-surgical";

const PLAN = path.resolve(
  "data/repairs/generated/uncrustables-owner-relaxed-main-24-20260719-v1/" +
    "URP-20260719T024117003Z-a68d9eec28b4.json",
);
const SELECTION = path.resolve(
  "data/repairs/execution-selections/" +
    "uncrustables-owner-relaxed-main-bk-recovery-20260719-v1/" +
    "URES-20260719T031312719Z-76cd668203a7.json",
);
const JOURNAL = path.resolve(
  "data/repairs/checkpoints/a68d9eec28b4f890a4c1",
);
const ARMED = path.join(
  JOURNAL,
  "20260719T031228645Z-BK-AS5Z-8UY5_media-SUBMISSION_ARMED-c3c85f31-6e06-4ef0-8b0b-e243acd79596.json",
);
const FAILED = path.join(
  JOURNAL,
  "20260719T031228799Z-BK-AS5Z-8UY5_media-FAILED-fa7c7c2b-6203-4c08-ad5a-84fa6f3e7f7d.json",
);
const RECOVERY = path.join(
  JOURNAL,
  "20260719T031343866Z-BK-AS5Z-8UY5_media-SETTLEMENT_UNRESOLVED-cdfc55dd-73c4-45af-90e8-6703e10571c2.json",
);
test("pre-request abort disposition is exact, non-VERIFIED, separately releases fence, and permits one real retry", async () => {
  const plan = await readRepairPlan(PLAN);
  const selection = await readRepairExecutionSelection(SELECTION, plan);
  const root = path.join(
    tmpdir(),
    `uncr-pre-request-abort-${Date.now()}-${Math.random()}`,
  );
  const checkpointRoot = path.join(root, "checkpoints");
  const journalDir = path.join(checkpointRoot, plan.sha256.slice(0, 20));
  const coordinationDir = path.join(root, "coordination");
  await mkdir(journalDir, { recursive: true });
  await mkdir(coordinationDir, { recursive: true });
  const copied = await Promise.all(
    [ARMED, FAILED, RECOVERY].map(async (source) => {
      const destination = path.join(journalDir, path.basename(source));
      await copyFile(source, destination);
      return destination;
    }),
  );
  const fencePath = path.join(coordinationDir, "pending-mutation-fence.json");
  const fenceBytes = Buffer.from(
    `${JSON.stringify({
      schema_version: "uncrustables-amazon-pending-mutation-fence/v1",
      repair_plan_sha256: plan.sha256,
      claimed_at: "2026-07-19T03:12:24.242Z",
      process_id: 21215,
      purpose: "FORWARD_APPLY:URP-20260719T024117003Z",
    }, null, 2)}\n`,
  );
  await writeFile(fencePath, fenceBytes);

  const proposal = await buildPreRequestAbortDispositionProposal({
    planPath: PLAN,
    executionSelectionPath: SELECTION,
    armedCheckpointPath: copied[0],
    failedCheckpointPath: copied[1],
    recoveryCheckpointPath: copied[2],
    checkpointRoot,
    coordinationDir,
    createdAt: new Date("2026-07-19T03:20:00.000Z"),
  });
  assert.equal(proposal.action.action_id, "BK-AS5Z-8UY5:media");
  assert.equal(proposal.recovery.consecutive_stable_reads, 3);
  assert.equal(proposal.guarantees.historical_amazon_patch_performed, false);

  const outputDir = path.join(root, "proposal");
  const proposalPath = await writePreRequestAbortDispositionProposal(
    outputDir,
    proposal,
  );
  await assert.rejects(
    applyPreRequestAbortDisposition({
      proposalPath,
      confirmation: "WRONG",
    }),
    /confirmation mismatch/,
  );
  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    plan.sha256,
    coordinationDir,
  );
  assert.equal((await store.pendingSubmissions()).size, 1);

  const disposition = await applyPreRequestAbortDisposition({
    proposalPath,
    confirmation: proposal.confirmation_token,
  });
  assert.equal(disposition.event.status, PRE_REQUEST_ABORT_TERMINAL_STATUS);
  assert.equal((await store.pendingSubmissions()).size, 0);
  assert.equal(
    (await store.verifiedActionIds()).has(proposal.action.action_id),
    false,
  );
  assert.deepEqual(await readFile(fencePath), fenceBytes);

  await releasePreRequestAbortDispositionFence({
    proposalPath,
    confirmation: preRequestAbortFenceReleaseConfirmationToken(proposal.sha256),
  });
  await assert.rejects(readFile(fencePath), /ENOENT/);

  const entry = plan.entries.find((candidate) =>
    candidate.actions.some(
      (action) => action.action_id === proposal.action.action_id,
    )
  );
  const action = entry?.actions.find(
    (candidate) => candidate.action_id === proposal.action.action_id,
  );
  assert.ok(entry && action?.desired.kind === "MEDIA");
  const current: ListingItem = {
    sku: entry.sku,
    summaries: [{
      marketplaceId: MARKETPLACE_ID,
      asin: entry.asin,
      productType: entry.audited_product_type,
    }],
    attributes: {
      main_product_image_locator: [{
        marketplace_id: MARKETPLACE_ID,
        media_location: "https://example.invalid/old-main.jpg",
      }],
    },
    issues: [],
  };
  let mutationCalls = 0;
  let immediateGuardCalls = 0;
  const gateway: RepairAmazonGateway = {
    physicalMutationGuardContract: "CALL_IMMEDIATELY_BEFORE_REQUEST_V1",
    getListing: async () => structuredClone(current),
    patchListing: async (
      storeIndex,
      _sku,
      _productType,
      patches,
      validationPreview,
      _previewContext,
      beforeMutatingRequest,
    ) => {
      if (validationPreview) return { status: "VALID", issues: [] };
      beforeMutatingRequest?.({
        store_index: storeIndex,
        marketplace_id: MARKETPLACE_ID,
        amazon_merchant_id: "TEST-MERCHANT",
      });
      immediateGuardCalls++;
      mutationCalls++;
      const attributes = (current.attributes ??= {}) as Record<string, unknown>;
      for (const patch of patches as ListingPatch[]) {
        const attribute = patch.path.replace("/attributes/", "");
        if (patch.op === "delete") delete attributes[attribute];
        else attributes[attribute] = structuredClone(patch.value);
      }
      return { status: "ACCEPTED", submissionId: "TEST-SUBMISSION", issues: [] };
    },
  };
  const retry = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: selection.confirmation_token,
    checkpointStore: store,
    executionSelection: selection,
    requestDelayMs: 200,
    verifyAttempts: 2,
    verifyDelayMs: 0,
    settlementAttempts: 2,
    settlementDelayMs: 0,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(mutationCalls, 1);
  assert.equal(immediateGuardCalls, 1);
  assert.equal(retry.verified_actions, 1);
  assert.equal(retry.already_applied_actions, 0);
  assert.equal(retry.failed_actions, 0);
});
