import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartListingIntegrityControlWorkerTick,
} from "../listing-integrity-control-worker.ts";
import type {
  WalmartListingIntegrityControlStoreStatus,
} from "../listing-integrity-control-store.server.ts";

function status(
  installation: "NOT_INSTALLED" | "INSTALLED",
): WalmartListingIntegrityControlStoreStatus {
  return {
    schemaVersion: "walmart-listing-integrity-control-store-status/v1",
    installation,
    runtimeStage: "OFF",
    activeRun: installation === "INSTALLED" ? {
      runId: "wlirun-test",
      poolBodySha256: "a".repeat(64),
      releaseIdSha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      status: "ACTIVE",
      createdAt: "2026-08-01T18:00:00.000Z",
      updatedAt: "2026-08-01T18:00:00.000Z",
      itemCount: 1,
      terminalCount: 0,
      qualifiedCount: 0,
      quarantinedCount: 0,
      activeItem: {
        ordinal: 1,
        listingKey: "walmart:1:FaisalX-2000",
        sku: "FaisalX-2000",
        itemId: "3EXACTWPID",
        state: "QUEUED",
        revision: 1,
        transitionedAt: "2026-08-01T18:00:00.000Z",
      },
      nextDecision: {
        action: "STOP_DEFAULT_OFF",
        listing_key: "walmart:1:FaisalX-2000",
      },
    } : null,
    claims: {
      databaseWrites: 0,
      walmartReads: 0,
      walmartWrites: 0,
      modelCalls: 0,
      runtimeActivationGranted: false,
    },
  };
}

test("worker resumes the exact persisted item but remains default-OFF", () => {
  const tick = buildWalmartListingIntegrityControlWorkerTick({
    status: status("INSTALLED"),
    observed_at: "2026-08-01T18:05:00.000Z",
  });
  assert.equal(tick.status, "DEFAULT_OFF");
  assert.equal(tick.decision, "STOP_DEFAULT_OFF");
  assert.equal(tick.sku, "FaisalX-2000");
  assert.match(tick.resume_token ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(tick.external_effects.walmart_writes, 0);
  assert.equal(tick.runtime_activation_granted, false);
});

test("worker reports missing migration without fabricating a run", () => {
  const tick = buildWalmartListingIntegrityControlWorkerTick({
    status: status("NOT_INSTALLED"),
    observed_at: "2026-08-01T18:05:00.000Z",
  });
  assert.equal(tick.status, "NOT_INSTALLED");
  assert.equal(tick.decision, "INSTALL_REQUIRED");
  assert.equal(tick.run_id, null);
  assert.equal(tick.resume_token, null);
});
