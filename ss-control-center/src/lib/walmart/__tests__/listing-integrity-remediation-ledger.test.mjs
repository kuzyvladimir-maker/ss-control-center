import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ledgerModule from "../listing-integrity-remediation-ledger.ts";

import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  WalmartListingRepairConsumptionLedgerError,
  bootstrapWalmartListingRepairConsumptionLedger,
  claimWalmartListingRepairPermit,
  consumeWalmartListingRepairPermit,
  loadWalmartListingRepairPermitAccepted,
  loadWalmartListingRepairPermitClaimed,
  loadWalmartListingRepairPermitRequesting,
  markWalmartListingRepairPermitRequesting,
  openWalmartListingRepairConsumptionLedger,
  readWalmartListingRepairPermitLedgerEvidence,
  recordWalmartListingRepairPermitAccepted,
  terminalizeWalmartListingRepairPermit,
} = ledgerModule;

const CREATED_AT = "2026-07-20T00:00:00.000Z";
const CLAIMED_AT = "2026-07-20T00:01:00.000Z";
const REQUESTING_AT = "2026-07-20T00:02:00.000Z";
const ACCEPTED_AT = "2026-07-20T00:03:00.000Z";
const TERMINAL_AT = "2026-07-20T00:04:00.000Z";
const LEDGER_UUID = "10000000-0000-4000-8000-000000000001";
const EPOCH_UUID = "10000000-0000-4000-8000-000000000002";
const CLAIM_UUID = "10000000-0000-4000-8000-000000000003";
const CONSUMPTION_UUID = "10000000-0000-4000-8000-000000000004";
const AUTHORIZATION_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);
const PAYLOAD_SHA = "c".repeat(64);
const RESPONSE_HTTP_SHA = "d".repeat(64);
const RESPONSE_SHA = "e".repeat(64);
const STATUS_HTTP_SHA = "f".repeat(64);
const STATUS_SHA = "1".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? CLAIM_UUID;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-listing-repair-ledger-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const stateDirectory = path.join(root, "ledger");
  const bootstrapped = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: stateDirectory,
    now: CREATED_AT,
    random_uuid: uuidSequence(LEDGER_UUID, EPOCH_UUID),
  });
  return { root, stateDirectory, ...bootstrapped };
}

function ledgerOptions(item) {
  return {
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  };
}

function consumeOptions(item, authorization = AUTHORIZATION_SHA) {
  return {
    ...ledgerOptions(item),
    permit_authorization_sha256: authorization,
    request_manifest_sha256: MANIFEST_SHA,
    request_payload_sha256: PAYLOAD_SHA,
    claimed_at: CLAIMED_AT,
    requesting_at: REQUESTING_AT,
    random_uuid: () => CLAIM_UUID,
  };
}

async function requesting(item, authorization = AUTHORIZATION_SHA) {
  return consumeWalmartListingRepairPermit(consumeOptions(item, authorization));
}

async function accepted(item, authorization = AUTHORIZATION_SHA) {
  const request = await requesting(item, authorization);
  return recordWalmartListingRepairPermitAccepted({
    ...ledgerOptions(item),
    requesting: request,
    accepted_at: ACCEPTED_AT,
    apply_id: "apply-1",
    feed_id: "feed-1",
    response_http_receipt_sha256: RESPONSE_HTTP_SHA,
    response_payload_sha256: RESPONSE_SHA,
  });
}

async function rejectsCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalmartListingRepairConsumptionLedgerError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function replaceCanonicalJson(file, value) {
  await chmod(file, 0o600);
  await writeFile(file, `${canonicalJson(value)}\n`, { mode: 0o600 });
  await chmod(file, 0o400);
}

test("bootstrap pins exact custody identity, 0700/0400 modes, and honest threat claims", async (t) => {
  const item = await fixture(t);
  const directory = await lstat(item.stateDirectory);
  const identity = await lstat(item.identity_artifact_path);
  const head = await lstat(item.head_artifact_path);
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(identity.mode & 0o777, 0o400);
  assert.equal(head.mode & 0o777, 0o400);
  assert.equal(identity.nlink, 1);
  assert.equal(head.nlink, 1);
  assert.equal(
    item.binding.identity_artifact_sha256,
    sha256(await readFile(item.identity_artifact_path)),
  );
  assert.equal(item.binding.trusted_single_custody_host_only, true);
  assert.equal(item.binding.distributed_at_most_once_claimed, false);
  const opened = await openWalmartListingRepairConsumptionLedger(ledgerOptions(item));
  assert.deepEqual(opened.permits, []);
  assert.equal(opened.head.event_count, 0);
  assert.equal(opened.at_most_once_scope, "INTACT_SINGLE_CUSTODY_DIRECTORY");
  assert.equal(opened.hostile_same_uid_resistance_claimed, false);
  assert.equal(opened.distributed_at_most_once_claimed, false);
});

test("REQUESTING durably burns one permit and binds exact manifest/payload before network", async (t) => {
  const item = await fixture(t);
  let networkCalls = 0;
  const receipt = await requesting(item);
  networkCalls += 1;
  assert.equal(networkCalls, 1);
  assert.equal(receipt.state, "REQUESTING");
  assert.equal(receipt.requesting_at, REQUESTING_AT);
  assert.equal(receipt.request_manifest_sha256, MANIFEST_SHA);
  assert.equal(receipt.request_payload_sha256, PAYLOAD_SHA);
  assert.equal(receipt.claim_file_sha256, sha256(await readFile(receipt.claim_path)));
  assert.equal(receipt.requesting_file_sha256, sha256(await readFile(receipt.requesting_path)));
  const loaded = await loadWalmartListingRepairPermitRequesting({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
  });
  assert.equal(loaded.receipt.requesting_file_sha256, loaded.requesting_sha256);
  assert.equal(loaded.exact_event_inventory.length, 2);
});

test("definite accepted POST is durable and permits only GET-only continuation", async (t) => {
  const item = await fixture(t);
  const receipt = await accepted(item);
  assert.equal(receipt.state, "ACCEPTED");
  assert.equal(receipt.marketplace_write_calls, 1);
  assert.equal(receipt.feed_id, "feed-1");
  const loaded = await loadWalmartListingRepairPermitAccepted({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
  });
  assert.equal(loaded.receipt.accepted_file_sha256, loaded.accepted_sha256);
  assert.equal(loaded.exact_event_inventory.length, 3);
  await rejectsCode(
    loadWalmartListingRepairPermitRequesting({
      ...ledgerOptions(item),
      permit_authorization_sha256: AUTHORIZATION_SHA,
    }),
    "PERMIT_NOT_REQUESTING",
  );
  await rejectsCode(
    recordWalmartListingRepairPermitAccepted({
      ...ledgerOptions(item),
      requesting: /** @type {any} */ (receipt),
      accepted_at: TERMINAL_AT,
      apply_id: "apply-1",
      feed_id: "feed-1",
      response_http_receipt_sha256: RESPONSE_HTTP_SHA,
      response_payload_sha256: RESPONSE_SHA,
    }),
    "REQUESTING_BINDING_MISMATCH",
  );
});

test("SUCCEEDED requires ACCEPTED plus exact feed-status evidence and cumulative head", async (t) => {
  const item = await fixture(t);
  const acceptedReceipt = await accepted(item);
  const terminal = await terminalizeWalmartListingRepairPermit({
    ...ledgerOptions(item),
    prior: acceptedReceipt,
    random_uuid: () => CONSUMPTION_UUID,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: TERMINAL_AT,
      apply_id: "apply-1",
      marketplace_write_calls: 1,
      feed_id: "feed-1",
      response_http_receipt_sha256: RESPONSE_HTTP_SHA,
      response_payload_sha256: RESPONSE_SHA,
      feed_status_http_receipt_sha256: STATUS_HTTP_SHA,
      feed_status_payload_sha256: STATUS_SHA,
      error_code: null,
    },
  });
  assert.equal(terminal.state, "SUCCEEDED");
  assert.equal(terminal.prior_state, "ACCEPTED");
  assert.equal(terminal.marketplace_write_calls, 1);
  const evidence = await readWalmartListingRepairPermitLedgerEvidence({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
  });
  assert.equal(evidence.state, "SUCCEEDED");
  assert.equal(evidence.head_sha256, sha256(evidence.head_bytes));
  assert.equal(evidence.terminal_sha256, sha256(evidence.terminal_bytes));
  assert.deepEqual(
    evidence.exact_event_inventory.map((event) => event.state).sort(),
    ["ACCEPTED", "CLAIMED", "REQUESTING", "SUCCEEDED"],
  );
  assert.equal(evidence.at_most_once_scope, "INTACT_SINGLE_CUSTODY_DIRECTORY");
  assert.equal(evidence.hostile_same_uid_resistance_claimed, false);
});

test("SUCCEEDED cannot skip ACCEPTED and terminal may occur after permit expiry elsewhere", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  await rejectsCode(
    terminalizeWalmartListingRepairPermit({
      ...ledgerOptions(item),
      prior: request,
      outcome: {
        state: "SUCCEEDED",
        terminal_at: "2026-07-21T00:00:00.000Z",
        apply_id: "apply-1",
        marketplace_write_calls: 1,
        feed_id: "feed-1",
        response_http_receipt_sha256: RESPONSE_HTTP_SHA,
        response_payload_sha256: RESPONSE_SHA,
        feed_status_http_receipt_sha256: STATUS_HTTP_SHA,
        feed_status_payload_sha256: STATUS_SHA,
        error_code: null,
      },
    }),
    "INVALID_INPUT",
  );
});

test("zero-call FAILED burns permit without claiming marketplace evidence", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  const terminal = await terminalizeWalmartListingRepairPermit({
    ...ledgerOptions(item),
    prior: request,
    random_uuid: () => CONSUMPTION_UUID,
    outcome: {
      state: "FAILED",
      terminal_at: TERMINAL_AT,
      apply_id: "apply-failed",
      marketplace_write_calls: 0,
      feed_id: null,
      response_http_receipt_sha256: null,
      response_payload_sha256: null,
      feed_status_http_receipt_sha256: null,
      feed_status_payload_sha256: null,
      error_code: "OAUTH_PRE_SEND_FAILED",
    },
  });
  assert.equal(terminal.state, "FAILED");
  assert.equal(terminal.marketplace_write_calls, 0);
  await rejectsCode(
    claimWalmartListingRepairPermit({
      ...ledgerOptions(item),
      permit_authorization_sha256: AUTHORIZATION_SHA,
      claimed_at: "2026-07-20T00:05:00.000Z",
    }),
    "PERMIT_ALREADY_CONSUMED",
  );
});

test("unknown one-call outcome becomes AMBIGUOUS and can never replay", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  const terminal = await terminalizeWalmartListingRepairPermit({
    ...ledgerOptions(item),
    prior: request,
    random_uuid: () => CONSUMPTION_UUID,
    outcome: {
      state: "AMBIGUOUS",
      terminal_at: TERMINAL_AT,
      apply_id: "apply-unknown",
      marketplace_write_calls: 1,
      feed_id: null,
      response_http_receipt_sha256: null,
      response_payload_sha256: null,
      feed_status_http_receipt_sha256: null,
      feed_status_payload_sha256: null,
      error_code: "POST_OUTCOME_UNKNOWN_MANUAL_REVIEW",
    },
  });
  assert.equal(terminal.state, "AMBIGUOUS");
  await rejectsCode(requesting(item), "PERMIT_ALREADY_CONSUMED");
  await rejectsCode(
    terminalizeWalmartListingRepairPermit({
      ...ledgerOptions(item),
      prior: request,
      outcome: {
        state: "FAILED",
        terminal_at: "2026-07-20T00:05:00.000Z",
        apply_id: "apply-unknown",
        marketplace_write_calls: 0,
        feed_id: null,
        response_http_receipt_sha256: null,
        response_payload_sha256: null,
        feed_status_http_receipt_sha256: null,
        feed_status_payload_sha256: null,
        error_code: "NO_REWRITE",
      },
    }),
    "PRIOR_STATE_BINDING_MISMATCH",
  );
});

test("CLAIMED crash state is permanently consumed and cannot be claimed again", async (t) => {
  const item = await fixture(t);
  const claim = await claimWalmartListingRepairPermit({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
    claimed_at: CLAIMED_AT,
    random_uuid: () => CLAIM_UUID,
  });
  assert.equal(claim.state, "CLAIMED");
  await rejectsCode(
    claimWalmartListingRepairPermit({
      ...ledgerOptions(item),
      permit_authorization_sha256: AUTHORIZATION_SHA,
      claimed_at: REQUESTING_AT,
    }),
    "PERMIT_ALREADY_CONSUMED",
  );

  const recovered = await loadWalmartListingRepairPermitClaimed({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
  });
  assert.equal(recovered.receipt.claim_file_sha256, recovered.claim_sha256);
  const resumed = await markWalmartListingRepairPermitRequesting({
    ...ledgerOptions(item),
    claim: recovered.receipt,
    request_manifest_sha256: MANIFEST_SHA,
    request_payload_sha256: PAYLOAD_SHA,
    requesting_at: REQUESTING_AT,
  });
  assert.equal(resumed.state, "REQUESTING");
  assert.equal(resumed.request_manifest_sha256, MANIFEST_SHA);
});

test("split claim→REQUESTING enforces exact durable claim and request hashes", async (t) => {
  const item = await fixture(t);
  const claim = await claimWalmartListingRepairPermit({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
    claimed_at: CLAIMED_AT,
    random_uuid: () => CLAIM_UUID,
  });
  const forged = { ...claim, claim_file_sha256: "9".repeat(64) };
  await rejectsCode(
    markWalmartListingRepairPermitRequesting({
      ...ledgerOptions(item),
      claim: forged,
      request_manifest_sha256: MANIFEST_SHA,
      request_payload_sha256: PAYLOAD_SHA,
      requesting_at: REQUESTING_AT,
    }),
    "CLAIM_BINDING_MISMATCH",
  );
  await rejectsCode(
    markWalmartListingRepairPermitRequesting({
      ...ledgerOptions(item),
      claim,
      request_manifest_sha256: MANIFEST_SHA.toUpperCase(),
      request_payload_sha256: PAYLOAD_SHA,
      requesting_at: REQUESTING_AT,
    }),
    "INVALID_INPUT",
  );
});

test("deleted event file is detected by cumulative head and cannot reopen", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  await unlink(request.claim_path);
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(item)),
    "LEDGER_CORRUPT",
  );
});

test("restoring an older head after a later event is detected as rollback", async (t) => {
  const item = await fixture(t);
  const claim = await claimWalmartListingRepairPermit({
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
    claimed_at: CLAIMED_AT,
    random_uuid: () => CLAIM_UUID,
  });
  const oldHead = await readFile(claim.ledger_head_path);
  await markWalmartListingRepairPermitRequesting({
    ...ledgerOptions(item),
    claim,
    request_manifest_sha256: MANIFEST_SHA,
    request_payload_sha256: PAYLOAD_SHA,
    requesting_at: REQUESTING_AT,
  });
  await chmod(claim.ledger_head_path, 0o600);
  await writeFile(claim.ledger_head_path, oldHead);
  await chmod(claim.ledger_head_path, 0o400);
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(item)),
    "LEDGER_ROLLBACK_OR_DELETION_DETECTED",
  );
});

test("self-consistent forged head with a missing exact event is rejected", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  const head = JSON.parse(await readFile(request.ledger_head_path, "utf8"));
  head.body.events = head.body.events.filter((event) => event.state !== "CLAIMED");
  head.body.event_count = head.body.events.length;
  head.body.events_sha256 = sha256(canonicalJson(head.body.events));
  head.body_sha256 = sha256(canonicalJson(head.body));
  await replaceCanonicalJson(request.ledger_head_path, head);
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(item)),
    "LEDGER_ROLLBACK_OR_DELETION_DETECTED",
  );
});

test("unexpected extra file and incomplete operation lock fail closed", async (t) => {
  const first = await fixture(t);
  const extra = path.join(first.stateDirectory, "unexpected.json");
  await writeFile(extra, "{}\n", { mode: 0o400 });
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(first)),
    "LEDGER_CORRUPT",
  );

  const second = await fixture(t);
  const lock = path.join(second.stateDirectory, ".ledger-operation.lock");
  await writeFile(lock, "{}\n", { mode: 0o400 });
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(second)),
    "LEDGER_MANUAL_REVIEW_REQUIRED",
  );
});

test("world-accessible directory, symlink path, and hardlinked artifact are rejected", async (t) => {
  const first = await fixture(t);
  await chmod(first.stateDirectory, 0o755);
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(first)),
    "LEDGER_CUSTODY_INVALID",
  );

  const second = await fixture(t);
  const alias = path.join(second.root, "ledger-alias");
  await symlink(second.stateDirectory, alias);
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger({
      state_directory: alias,
      expected_binding: second.binding,
    }),
    "LEDGER_CUSTODY_INVALID",
  );

  const third = await fixture(t);
  await link(third.identity_artifact_path, path.join(third.root, "identity-copy.json"));
  await rejectsCode(
    openWalmartListingRepairConsumptionLedger(ledgerOptions(third)),
    "LEDGER_CORRUPT",
  );
});

test("concurrent claims cannot both pass the single-custody operation fence", async (t) => {
  const item = await fixture(t);
  const options = {
    ...ledgerOptions(item),
    permit_authorization_sha256: AUTHORIZATION_SHA,
    claimed_at: CLAIMED_AT,
    random_uuid: () => CLAIM_UUID,
  };
  const results = await Promise.allSettled([
    claimWalmartListingRepairPermit(options),
    claimWalmartListingRepairPermit(options),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const opened = await openWalmartListingRepairConsumptionLedger(ledgerOptions(item));
  assert.equal(opened.permits.length, 1);
  assert.equal(opened.permits[0].state, "CLAIMED");
});

test("terminal evidence pair and outcome truth constraints fail closed", async (t) => {
  const item = await fixture(t);
  const request = await requesting(item);
  await rejectsCode(
    terminalizeWalmartListingRepairPermit({
      ...ledgerOptions(item),
      prior: request,
      outcome: {
        state: "FAILED",
        terminal_at: TERMINAL_AT,
        apply_id: "apply-bad",
        marketplace_write_calls: 1,
        feed_id: null,
        response_http_receipt_sha256: RESPONSE_HTTP_SHA,
        response_payload_sha256: null,
        feed_status_http_receipt_sha256: null,
        feed_status_payload_sha256: null,
        error_code: "HTTP_REJECTED",
      },
    }),
    "INVALID_INPUT",
  );
});
