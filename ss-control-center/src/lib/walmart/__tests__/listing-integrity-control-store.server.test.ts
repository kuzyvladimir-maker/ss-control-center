import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildListingIntegrityControlStatusResponse,
  POST as postControlStatus,
} from "@/app/api/walmart/growth/listing-integrity/control/route";
import {
  createWalmartListingIntegrityQueuedState,
} from "../listing-integrity-control-plane";
import {
  loadWalmartListingIntegrityControlStoreStatus,
} from "../listing-integrity-control-store.server";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const NOW = "2026-08-01T17:00:00.000Z";

function fixture() {
  const state = createWalmartListingIntegrityQueuedState({
    identity: {
      run_id: "wlirun-1",
      pool_body_sha256: H("pool"),
      ordinal: 1,
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      item_id: "8394316918",
      store_index: 1,
    },
    created_at: NOW,
    queue_evidence_sha256: H("queue"),
  });
  return {
    run: {
      runId: "wlirun-1",
      poolBodySha256: H("pool"),
      releaseIdSha256: H("release"),
      manifestSha256: H("manifest"),
      runtimeStage: "OFF",
      status: "ACTIVE",
      createdAt: NOW,
      updatedAt: NOW,
    },
    item: {
      runId: "wlirun-1",
      ordinal: 1,
      listingKey: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      itemId: "8394316918",
      storeIndex: 1,
      state: state.state,
      revision: state.revision,
      stateBodySha256: state.body_sha256,
      previousStateSha256: state.previous_state_sha256,
      evidenceSha256: state.evidence_sha256,
      executionPackageSha256: state.execution_package_sha256,
      ownerPermitSha256: state.owner_permit_sha256,
      feedId: state.feed_id,
      marketplaceWriteCalls: state.marketplace_write_calls,
      automaticRetryAllowed: state.automatic_retry_allowed,
      automaticReplayAllowed: state.automatic_replay_allowed,
      transitionedAt: state.transitioned_at,
    },
  };
}

function client(rows: ReturnType<typeof fixture>) {
  let calls = 0;
  return {
    async $queryRawUnsafe() {
      calls += 1;
      return calls === 1 ? [rows.run] : [rows.item];
    },
  };
}

test("read-only store verifies sealed rows and reports default-OFF decision", async () => {
  const status = await loadWalmartListingIntegrityControlStoreStatus(client(fixture()));
  assert.equal(status.installation, "INSTALLED");
  assert.equal(status.runtimeStage, "OFF");
  assert.equal(status.activeRun?.activeItem?.sku, "FaisalX-1144");
  assert.deepEqual(status.activeRun?.nextDecision, {
    action: "STOP_DEFAULT_OFF",
    listing_key: "walmart:1:FaisalX-1144",
  });
  assert.deepEqual(status.claims, {
    databaseWrites: 0,
    walmartReads: 0,
    walmartWrites: 0,
    modelCalls: 0,
    runtimeActivationGranted: false,
  });
});

test("missing Stage A migration is reported honestly and does not fabricate a run", async () => {
  const status = await loadWalmartListingIntegrityControlStoreStatus({
    async $queryRawUnsafe() {
      throw new Error("no such table: WalmartListingIntegrityControlRun");
    },
  });
  assert.equal(status.installation, "NOT_INSTALLED");
  assert.equal(status.activeRun, null);
});

test("store fails closed when persisted state bytes do not match the seal", async () => {
  const rows = fixture();
  rows.item.stateBodySha256 = H("tampered");
  await assert.rejects(
    loadWalmartListingIntegrityControlStoreStatus(client(rows)),
    /seal or immutable policy differs/,
  );
});

test("control API is no-store GET-only and rejects activation mutations", async () => {
  const response = await buildListingIntegrityControlStatusResponse(
    () => loadWalmartListingIntegrityControlStoreStatus(client(fixture())),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal((await response.json()).control.runtimeStage, "OFF");

  const post = await postControlStatus();
  assert.equal(post.status, 405);
  assert.equal(
    (await post.json()).error,
    "READ_ONLY_LISTING_INTEGRITY_CONTROL_API",
  );
});
