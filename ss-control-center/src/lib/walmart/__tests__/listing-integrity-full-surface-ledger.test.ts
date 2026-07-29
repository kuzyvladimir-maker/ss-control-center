import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openWalmartListingFullSurfaceLedger,
} from "../listing-integrity-full-surface-ledger";

const AUTHORIZATION = "a".repeat(64);
const HASH = "b".repeat(64);
const NOW = "2026-07-29T16:00:00.000Z";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "walmart-ledger-test-"));
  const directory = path.join(root, "ledger");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const ledger = await openWalmartListingFullSurfaceLedger({
    directory,
    ledger_id: "test-ledger",
    ledger_epoch: "test-epoch-1",
    now: NOW,
  });
  return ledger;
}

async function claimAndRequest(
  ledger: Awaited<ReturnType<typeof openWalmartListingFullSurfaceLedger>>,
) {
  const claim = await ledger.claim({
    authorization_sha256: AUTHORIZATION,
    plan_body_sha256: HASH,
    operation_id: "item-FaisalX-1434",
    operation_body_sha256: "c".repeat(64),
    request_payload_sha256: "d".repeat(64),
    request_byte_length: 42,
    seller_account_fingerprint_sha256: "e".repeat(64),
    now: NOW,
  });
  const requesting = await ledger.markRequesting({
    authorization_sha256: AUTHORIZATION,
    request_manifest_sha256: "f".repeat(64),
    request_payload_sha256: "d".repeat(64),
    correlation_id: "d6100dc8-e2de-49b6-810c-fd51e889a824",
    now: "2026-07-29T16:00:01.000Z",
  });
  return { claim, requesting };
}

test("durably burns an authorization before the mutation and rejects replay", async (t) => {
  const ledger = await fixture(t);
  const { claim, requesting } = await claimAndRequest(ledger);
  assert.equal(claim.state, "CLAIMED");
  assert.equal(requesting.state, "REQUESTING");
  assert.equal((await ledger.inspect(AUTHORIZATION)).state, "REQUESTING");

  await assert.rejects(
    () => ledger.claim({
      authorization_sha256: AUTHORIZATION,
      plan_body_sha256: HASH,
      operation_id: "item-FaisalX-1434",
      operation_body_sha256: "c".repeat(64),
      request_payload_sha256: "d".repeat(64),
      request_byte_length: 42,
      seller_account_fingerprint_sha256: "e".repeat(64),
      now: NOW,
    }),
    /exists/u,
  );
  await assert.rejects(
    () => ledger.markRequesting({
      authorization_sha256: AUTHORIZATION,
      request_manifest_sha256: "f".repeat(64),
      request_payload_sha256: "d".repeat(64),
      correlation_id: "43b197af-8d27-4206-bf9d-58b2ab610031",
      now: "2026-07-29T16:00:02.000Z",
    }),
    /requires CLAIMED/u,
  );
});

test("unknown mutation outcome becomes terminal and can never replay", async (t) => {
  const ledger = await fixture(t);
  await claimAndRequest(ledger);
  const terminal = await ledger.markTerminal({
    authorization_sha256: AUTHORIZATION,
    state: "UNKNOWN",
    error_code: "MUTATION_OUTCOME_UNKNOWN",
    now: "2026-07-29T16:00:02.000Z",
  });
  assert.equal(terminal.state, "UNKNOWN");
  const inspected = await ledger.inspect(AUTHORIZATION);
  assert.equal(inspected.state, "UNKNOWN");
  assert.equal(inspected.mutation_replay_allowed, false);
  assert.equal(inspected.get_only_resume_allowed, false);
  await assert.rejects(
    () => ledger.markAccepted({
      authorization_sha256: AUTHORIZATION,
      response_http_status: 200,
      response_headers_sha256: HASH,
      response_payload_sha256: HASH,
    }),
    /requires REQUESTING/u,
  );
});

test("accepted feed permits GET-only resume and success requires readback", async (t) => {
  const ledger = await fixture(t);
  await claimAndRequest(ledger);
  const accepted = await ledger.markAccepted({
    authorization_sha256: AUTHORIZATION,
    response_http_status: 202,
    response_headers_sha256: HASH,
    response_payload_sha256: "1".repeat(64),
    walmart_feed_id: "feed-123",
    now: "2026-07-29T16:00:02.000Z",
  });
  assert.equal(accepted.get_only_resume_allowed, true);
  const inspected = await ledger.inspect(AUTHORIZATION);
  assert.equal(inspected.state, "ACCEPTED");
  assert.equal(inspected.walmart_feed_id, "feed-123");
  assert.equal(inspected.mutation_replay_allowed, false);
  assert.equal(inspected.get_only_resume_allowed, true);
  await assert.rejects(
    () => ledger.markTerminal({
      authorization_sha256: AUTHORIZATION,
      state: "SUCCEEDED_AND_READ_BACK",
      now: "2026-07-29T16:00:03.000Z",
    }),
    /exact readback/u,
  );
  const terminal = await ledger.markTerminal({
    authorization_sha256: AUTHORIZATION,
    state: "SUCCEEDED_AND_READ_BACK",
    response_http_status: 202,
    response_headers_sha256: HASH,
    response_payload_sha256: "1".repeat(64),
    readback_sha256: "2".repeat(64),
    now: "2026-07-29T16:00:03.000Z",
  });
  assert.equal(terminal.state, "SUCCEEDED_AND_READ_BACK");
  assert.equal(
    (await ledger.inspect(AUTHORIZATION)).get_only_resume_allowed,
    false,
  );
});

test("reopening the same custody preserves identity and consumed state", async (t) => {
  const ledger = await fixture(t);
  await claimAndRequest(ledger);
  const reopened = await openWalmartListingFullSurfaceLedger({
    directory: ledger.directory,
    ledger_id: ledger.binding.ledger_id,
    ledger_epoch: ledger.binding.ledger_epoch,
    now: "2026-07-29T16:05:00.000Z",
  });
  assert.deepEqual(reopened.binding, ledger.binding);
  assert.equal((await reopened.inspect(AUTHORIZATION)).state, "REQUESTING");
  await assert.rejects(
    () => reopened.claim({
      authorization_sha256: AUTHORIZATION,
      plan_body_sha256: HASH,
      operation_id: "item-FaisalX-1434",
      operation_body_sha256: "c".repeat(64),
      request_payload_sha256: "d".repeat(64),
      request_byte_length: 42,
      seller_account_fingerprint_sha256: "e".repeat(64),
      now: NOW,
    }),
    /exists/u,
  );
});

