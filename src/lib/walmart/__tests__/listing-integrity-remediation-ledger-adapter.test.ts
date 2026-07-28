import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WalmartListingRepairOneSkuPermit } from
  "../listing-integrity-remediation-authority.ts";
import {
  createWalmartListingRepairLedgerAdapter,
} from "../listing-integrity-remediation-ledger-adapter.ts";
import {
  bootstrapWalmartListingRepairConsumptionLedger,
  openWalmartListingRepairConsumptionLedger,
} from "../listing-integrity-remediation-ledger.ts";

const AUTHORIZATION_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);
const PAYLOAD_SHA = "c".repeat(64);
const RESPONSE_HTTP_SHA = "d".repeat(64);
const RESPONSE_SHA = "e".repeat(64);
const STATUS_HTTP_SHA = "f".repeat(64);
const STATUS_SHA = "1".repeat(64);

function permit(binding: Awaited<ReturnType<
  typeof bootstrapWalmartListingRepairConsumptionLedger
>>["binding"]): WalmartListingRepairOneSkuPermit {
  return {
    authorization_sha256: AUTHORIZATION_SHA,
    signed_body: { consumption_ledger: structuredClone(binding) },
  } as unknown as WalmartListingRepairOneSkuPermit;
}

test("concrete adapter binds one permit to one immutable ledger through terminal success", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "walmart-repair-ledger-adapter-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const stateDirectory = path.join(parent, "ledger");
  const boot = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    now: "2026-07-21T12:00:00.000Z",
    random_uuid: (() => {
      const values = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ];
      return () => values.shift()!;
    })(),
  });
  const adapter = createWalmartListingRepairLedgerAdapter({
    state_directory: stateDirectory,
    expected_binding: boot.binding,
  });
  const exactPermit = permit(boot.binding);
  const requesting = await adapter.consume({
    permit: exactPermit,
    claimed_at: "2026-07-21T12:00:01.000Z",
    requesting_at: "2026-07-21T12:00:01.000Z",
    request_manifest_sha256: MANIFEST_SHA,
    request_payload_sha256: PAYLOAD_SHA,
  });
  assert.equal(requesting.state, "REQUESTING");
  assert.deepEqual(
    await adapter.loadRequesting({
      permit: exactPermit,
      request_manifest_sha256: MANIFEST_SHA,
      request_payload_sha256: PAYLOAD_SHA,
    }),
    requesting,
  );
  const accepted = await adapter.recordAccepted({
    permit: exactPermit,
    requesting,
    accepted_at: "2026-07-21T12:00:02.000Z",
    apply_id: "repair-apply-1",
    feed_id: "feed-1",
    response_http_receipt_sha256: RESPONSE_HTTP_SHA,
    response_payload_sha256: RESPONSE_SHA,
  });
  assert.equal(accepted.state, "ACCEPTED");
  assert.deepEqual(
    await adapter.loadAccepted({
      permit: exactPermit,
      request_manifest_sha256: MANIFEST_SHA,
      request_payload_sha256: PAYLOAD_SHA,
    }),
    accepted,
  );
  const terminal = await adapter.terminalize({
    permit: exactPermit,
    prior: accepted,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: "2026-07-21T12:00:03.000Z",
      apply_id: "repair-apply-1",
      error_code: null,
      marketplace_write_calls: 1,
      http_status: 202,
      feed_id: "feed-1",
      response_http_receipt_sha256: RESPONSE_HTTP_SHA,
      response_payload_sha256: RESPONSE_SHA,
      feed_status_http_receipt_sha256: STATUS_HTTP_SHA,
      feed_status_payload_sha256: STATUS_SHA,
      exact_listing_count: 1,
    },
  });
  assert.equal((terminal as { state: string }).state, "SUCCEEDED");
  const snapshot = await openWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    expected_binding: boot.binding,
  });
  assert.equal(snapshot.permits.length, 1);
  assert.equal(snapshot.permits[0]?.state, "SUCCEEDED");
});

test("adapter rejects cross-ledger permits and request-hash drift before advancing state", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "walmart-repair-ledger-adapter-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const stateDirectory = path.join(parent, "ledger");
  const boot = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    now: "2026-07-21T12:00:00.000Z",
  });
  const adapter = createWalmartListingRepairLedgerAdapter({
    state_directory: stateDirectory,
    expected_binding: boot.binding,
  });
  const foreign = permit({
    ...boot.binding,
    ledger_epoch: "epoch-foreign",
  });
  await assert.rejects(
    adapter.consume({
      permit: foreign,
      claimed_at: "2026-07-21T12:00:01.000Z",
      requesting_at: "2026-07-21T12:00:01.000Z",
      request_manifest_sha256: MANIFEST_SHA,
      request_payload_sha256: PAYLOAD_SHA,
    }),
    /not bound to this exact durable ledger identity/,
  );
  let snapshot = await openWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    expected_binding: boot.binding,
  });
  assert.equal(snapshot.permits.length, 0);

  const exactPermit = permit(boot.binding);
  await adapter.consume({
    permit: exactPermit,
    claimed_at: "2026-07-21T12:00:01.000Z",
    requesting_at: "2026-07-21T12:00:01.000Z",
    request_manifest_sha256: MANIFEST_SHA,
    request_payload_sha256: PAYLOAD_SHA,
  });
  await assert.rejects(
    adapter.loadRequesting({
      permit: exactPermit,
      request_manifest_sha256: "9".repeat(64),
      request_payload_sha256: PAYLOAD_SHA,
    }),
    /differs from the exact request manifest\/payload/,
  );
  snapshot = await openWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    expected_binding: boot.binding,
  });
  assert.equal(snapshot.permits[0]?.state, "REQUESTING");
});

test("adapter requires an absolute normalized custody path", () => {
  assert.throws(
    () => createWalmartListingRepairLedgerAdapter({
      state_directory: "relative/ledger",
      expected_binding: {} as never,
    }),
    /absolute normalized path/,
  );
});
