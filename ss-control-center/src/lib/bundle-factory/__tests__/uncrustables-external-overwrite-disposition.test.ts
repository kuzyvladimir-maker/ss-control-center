import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyExternalOverwriteDisposition,
  buildExternalOverwriteDispositionProposal,
  releaseExternalOverwriteDispositionFence,
  writeExternalOverwriteDispositionProposal,
} from "../repair/uncrustables-external-overwrite-disposition";
import {
  externalOverwriteFenceReleaseConfirmationToken,
} from "../repair/uncrustables-external-overwrite-disposition-contract";
import {
  EXACT_PATH_SETTLEMENT_GUARD,
  ImmutableCheckpointStore,
  SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
  buildRepairPlan,
  repairExecutionSelection,
  sha256,
  type DesiredRepairManifest,
} from "../repair/uncrustables-surgical";

function uniqueRoot(label: string): string {
  return path.join(
    tmpdir(),
    `uncr-qx-disposition-${label}-${Date.now()}-${Math.random()}`,
  );
}

async function fixture(input: {
  stableReads?: number;
  channelmaxMaximum?: number;
  channelmaxConfirmedAt?: string;
} = {}) {
  const root = uniqueRoot("fixture");
  const checkpointRoot = path.join(root, "checkpoints");
  const coordinationDir = path.join(root, "coordination");
  await mkdir(root, { recursive: true });
  const ledger = Buffer.from(
    JSON.stringify({
      schema_version: "uncrustables-ledger/v1.2",
      audit_id: "UL-QX-DISPOSITION-TEST",
      complete: true,
      immutable: true,
      mode: "live",
      external_mutations: false,
      completed_at: "2026-07-18T00:00:00.000Z",
      rows: [
        {
          sku: "QX-AS89-H8YC",
          asin: "B0H82RQ226",
          store_index: 1,
          canonical: {
            total_units: 24,
            components: [
              {
                product_id: "apple-protein",
                product_name: "Uncrustables Apple Cinnamon Protein",
                brand: "Uncrustables",
                flavor: "Apple Cinnamon",
                qty: 24,
                unit_price_cents: 100,
              },
            ],
            pricing: { suggested: 76.99, floor: 66.95 },
          },
          db: {
            draft: {
              brand: "Uncrustables",
              pack_count: 24,
              selected_variant: {
                name: "Apple Cinnamon 24",
                composition: [
                  {
                    product_id: "apple-protein",
                    product_name: "Uncrustables Apple Cinnamon Protein",
                    brand: "Uncrustables",
                    flavor: "Apple Cinnamon",
                    qty: 24,
                    unit_price_cents: 100,
                  },
                ],
              },
            },
          },
          live: {
            fetched: true,
            error: null,
            product_type: "GROCERY",
            title: "Uncrustables Apple Cinnamon Protein, 24 Count",
            bullets: [
              "24 sandwiches.",
              "Individually wrapped.",
              "Keep frozen.",
              "Review wrapper.",
              "Follow wrapper directions.",
            ],
            description: "Contains 24 sandwiches.",
            brand: "Uncrustables",
            gallery_image_urls: [],
            consumer_offer: {
              our_price: 85.7,
              minimum_seller_allowed_price: null,
              maximum_seller_allowed_price: 85.7,
            },
            raw_attributes: {},
            raw_offers: [],
          },
          anomalies: [],
        },
      ],
    }),
  );
  const manifest: DesiredRepairManifest = {
    schema_version: "uncrustables-surgical-desired/v1",
    source_ledger_sha256: sha256(ledger),
    repairs: [
      {
        sku: "QX-AS89-H8YC",
        review: {
          confidence: "HIGH",
          rationale: "Exact QX price test evidence.",
          evidence: ["Test-only exact sealed fixture."],
        },
        offer: {
          currency: "USD",
          consumer_price: 76.99,
          business_price: 76.99,
          minimum_seller_allowed_price: 66.95,
          maximum_seller_allowed_price: 76.99,
          discounted_price_absent: true,
          list_price_absent: true,
        },
      },
    ],
  };
  const plan = buildRepairPlan({
    ledgerPath: path.join(root, "ledger.json"),
    ledgerBytes: ledger,
    manifest,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
  });
  const planPath = path.join(root, "plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const selection = repairExecutionSelection(plan, {
    sourcePlanPath: planPath,
    skus: ["QX-AS89-H8YC"],
    actionKinds: ["OFFER"],
    createdAt: new Date("2026-07-18T00:01:00.000Z"),
  });
  const selectionPath = path.join(root, "selection.json");
  await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);

  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    plan.sha256,
    coordinationDir,
  );
  await store.claimPendingMutationFence("OFFER_SUBMIT_ONLY:QX-TEST");
  const guard = {
    schema_version: EXACT_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: "a".repeat(64),
    exact_action_paths: [
      "/attributes/list_price",
      "/attributes/purchasable_offer",
    ],
    before_path_state_sha256: "b".repeat(64),
  };
  const armed = await store.append({
    action_id: "QX-AS89-H8YC:offer",
    sku: "QX-AS89-H8YC",
    kind: "OFFER",
    status: "SUBMISSION_ARMED",
    detail: {
      strategy: "PRIMARY",
      crash_window_guard: true,
      settlement_guard: guard,
    },
  });
  const submitted = await store.append({
    action_id: "QX-AS89-H8YC:offer",
    sku: "QX-AS89-H8YC",
    kind: "OFFER",
    status: "SUBMITTED",
    detail: {
      strategy: SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
      armed_event_id: armed.event_id,
      actual_request_patch_sha256: guard.actual_patch_sha256,
      actual_request_patch_paths: guard.exact_action_paths,
      settlement_guard: guard,
      status: "ACCEPTED",
      submission_id: "amazon-qx-test-submission",
      issues: [],
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const settlement = await store.append({
    action_id: "QX-AS89-H8YC:offer",
    sku: "QX-AS89-H8YC",
    kind: "OFFER",
    status: "SETTLEMENT_UNRESOLVED",
    detail: {
      recovery: true,
      trigger: "PENDING_SETTLE_ONLY",
      selection_sha256: selection.sha256,
      submitted_event_id: submitted.event_id,
      disposition: "PENDING_READ_LIMIT",
      polling_reads: 3,
      read_errors: 0,
      consecutive_stable_reads: input.stableReads ?? 3,
      last_classification: "NON_DESIRED",
      last_path_state_sha256: "c".repeat(64),
      remains_pending: true,
      automatic_resubmission_authorized: false,
    },
  });
  const journalDir = path.join(checkpointRoot, plan.sha256.slice(0, 20));
  const settlementName = (await readdir(journalDir)).find((name) =>
    name.includes(settlement.event_id)
  );
  assert.ok(settlementName);
  const settlementPath = path.join(journalDir, settlementName);
  const channelmaxPostwritePath = path.join(root, "channelmax-postwrite.json");
  const maximum = input.channelmaxMaximum ?? 76.99;
  await writeFile(
    channelmaxPostwritePath,
    `${JSON.stringify(
      {
        schema_version: "channelmax-qx-fence-recovery-postwrite/v1",
        confirmed_at: input.channelmaxConfirmedAt ?? "2020-01-01T00:00:00.000Z",
        row: {
          item_id: 171129419,
          sku: "QX-AS89-H8YC",
          asin: "B0H82RQ226",
          site_id: 300,
        },
        before: {
          minimum_price: null,
          maximum_price: 85.7,
          price: 85.7,
          repricing_model_name: "Default",
        },
        after: {
          minimum_price: 66.95,
          maximum_price: maximum,
          price: 76.99,
          repricing_model_name: "Default",
        },
        write_response: {
          is_valid: true,
          message: "SUCCESS",
          updated_rows: 1,
        },
        independent_readback: {
          action: "inventoryitemsite",
          is_valid: true,
          minimum_price: 66.95,
          maximum_price: maximum,
          last_updated_by: "test-operator",
        },
        amazon_next_action: "GET_ONLY_PENDING_SETTLEMENT",
        amazon_resubmission_performed: false,
        result: "PASS",
      },
      null,
      2,
    )}\n`,
  );
  return {
    root,
    checkpointRoot,
    coordinationDir,
    planPath,
    selectionPath,
    settlementPath,
    channelmaxPostwritePath,
    store,
  };
}

test("exact QX evidence terminalizes only the accepted submission and preserves fence bytes", async () => {
  const fx = await fixture();
  const fencePath = path.join(fx.coordinationDir, "pending-mutation-fence.json");
  const fenceBefore = await readFile(fencePath);
  const proposal = await buildExternalOverwriteDispositionProposal({
    planPath: fx.planPath,
    executionSelectionPath: fx.selectionPath,
    settlementCheckpointPath: fx.settlementPath,
    channelmaxPostwritePath: fx.channelmaxPostwritePath,
    checkpointRoot: fx.checkpointRoot,
    coordinationDir: fx.coordinationDir,
    createdAt: new Date("2026-07-19T03:00:00.000Z"),
  });
  assert.equal(proposal.settlement.consecutive_stable_reads, 3);
  assert.equal(proposal.guarantees.amazon_calls_performed, 0);
  assert.equal((await fx.store.pendingSubmissions()).size, 1);
  assert.deepEqual(await readFile(fencePath), fenceBefore);

  const proposalDir = path.join(fx.root, "proposal");
  const proposalPath = await writeExternalOverwriteDispositionProposal(
    proposalDir,
    proposal,
  );
  const result = await applyExternalOverwriteDisposition({
    proposalPath,
    confirmation: proposal.confirmation_token,
  });
  assert.equal(result.event.status, "DISPOSITIONED_EXTERNAL_OVERWRITE");
  assert.equal(result.fence_preserved, true);
  assert.equal((await fx.store.pendingSubmissions()).size, 0);
  assert.ok((await fx.store.verifiedActionIds()).has("QX-AS89-H8YC:offer"));
  assert.deepEqual(await readFile(fencePath), fenceBefore);

  await assert.rejects(
    releaseExternalOverwriteDispositionFence({
      proposalPath,
      confirmation: "RELEASE-WRONG",
    }),
    /release confirmation mismatch/,
  );
  assert.deepEqual(await readFile(fencePath), fenceBefore);
  const released = await releaseExternalOverwriteDispositionFence({
    proposalPath,
    confirmation: externalOverwriteFenceReleaseConfirmationToken(proposal.sha256),
  });
  assert.equal(released.armed_event.status, "FENCE_RELEASE_ARMED");
  assert.equal(released.released_event.status, "FENCE_RELEASED");
  await assert.rejects(readFile(fencePath), /ENOENT/);
});

test("two stable NON_DESIRED reads cannot produce a disposition", async () => {
  const fx = await fixture({ stableReads: 2 });
  await assert.rejects(
    buildExternalOverwriteDispositionProposal({
      planPath: fx.planPath,
      executionSelectionPath: fx.selectionPath,
      settlementCheckpointPath: fx.settlementPath,
      channelmaxPostwritePath: fx.channelmaxPostwritePath,
      checkpointRoot: fx.checkpointRoot,
      coordinationDir: fx.coordinationDir,
    }),
    /not exact 3\/3 stable NON_DESIRED evidence/,
  );
  assert.equal((await fx.store.pendingSubmissions()).size, 1);
});

test("ChannelMAX bounds mismatch cannot terminalize the Amazon submission", async () => {
  const fx = await fixture({ channelmaxMaximum: 77.99 });
  await assert.rejects(
    buildExternalOverwriteDispositionProposal({
      planPath: fx.planPath,
      executionSelectionPath: fx.selectionPath,
      settlementCheckpointPath: fx.settlementPath,
      channelmaxPostwritePath: fx.channelmaxPostwritePath,
      checkpointRoot: fx.checkpointRoot,
      coordinationDir: fx.coordinationDir,
    }),
    /does not equal the sealed OFFER price bounds/,
  );
  assert.equal((await fx.store.pendingSubmissions()).size, 1);
});
