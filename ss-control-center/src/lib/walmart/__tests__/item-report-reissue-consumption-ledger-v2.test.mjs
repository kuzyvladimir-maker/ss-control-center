import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WalmartItemReportReissueConsumptionLedgerV2Error,
  bootstrapWalmartItemReportReissueConsumptionLedgerV2,
  claimWalmartItemReportReissueAuthorizationV2,
  consumeWalmartItemReportReissueAuthorizationV2,
  markWalmartItemReportReissueAuthorizationRequestingV2,
  openWalmartItemReportReissueConsumptionLedgerV2,
  terminalizeWalmartItemReportReissueAuthorizationV2,
} from "../item-report-reissue-consumption-ledger-v2.ts";

const CREATED_AT = "2026-07-20T00:00:00.000Z";
const CLAIMED_AT = "2026-07-20T00:01:00.000Z";
const REQUESTING_AT = "2026-07-20T00:01:01.000Z";
const TERMINAL_AT = "2026-07-20T00:01:02.000Z";
const LEDGER_UUID = "10000000-0000-4000-8000-000000000001";
const EPOCH_UUID = "10000000-0000-4000-8000-000000000002";
const CLAIM_UUID = "10000000-0000-4000-8000-000000000003";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? CLAIM_UUID;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-item-reissue-ledger-v2-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const stateDirectory = path.join(root, "ledger");
  const bootstrapped = await bootstrapWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: stateDirectory,
    now: CREATED_AT,
    random_uuid: uuidSequence(LEDGER_UUID, EPOCH_UUID),
  });
  return { root, stateDirectory, ...bootstrapped };
}

async function rejectsCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalmartItemReportReissueConsumptionLedgerV2Error);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function consumeOptions(item, authorizationSha256 = "a".repeat(64), claimUuid = CLAIM_UUID) {
  return {
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    authorization_sha256: authorizationSha256,
    claimed_at: CLAIMED_AT,
    requesting_at: REQUESTING_AT,
    random_uuid: () => claimUuid,
  };
}

test("bootstrap pins realpath, directory inode, exact identity bytes, and private modes", async (t) => {
  const item = await fixture(t);
  const directoryInfo = await lstat(item.stateDirectory);
  const identityInfo = await lstat(item.identity_artifact_path);
  const headInfo = await lstat(item.head_artifact_path);
  const canonicalPath = await realpath(item.stateDirectory);

  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(identityInfo.mode & 0o777, 0o400);
  assert.equal(identityInfo.nlink, 1);
  assert.equal(headInfo.mode & 0o777, 0o400);
  assert.equal(headInfo.nlink, 1);
  assert.equal(
    item.binding.state_directory_path_sha256,
    sha256(Buffer.from(canonicalPath, "utf8")),
  );
  assert.equal(
    item.binding.directory_identity_sha256,
    sha256(`{"device":"${directoryInfo.dev}","inode":"${directoryInfo.ino}"}`),
  );
  assert.equal(
    item.binding.identity_artifact_sha256,
    sha256(await readFile(item.identity_artifact_path)),
  );
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  assert.deepEqual(opened.authorizations, []);
  assert.equal(opened.head.artifact_sha256, item.head_artifact_sha256);
  assert.equal(opened.head.previous_head_artifact_sha256, null);
  assert.equal(opened.head.event_count, 0);
  assert.deepEqual(opened.head.events, []);
  assert.equal(opened.head.at_most_once_scope, "INTACT_SINGLE_CUSTODY_DIRECTORY");
  assert.equal(opened.head.hostile_same_uid_resistance_claimed, false);
  assert.equal(opened.head.distributed_at_most_once_claimed, false);
  await rejectsCode(
    bootstrapWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
    }),
    "LEDGER_ALREADY_INITIALIZED",
  );
});

test("consume durably records CLAIMED then REQUESTING before any caller network work", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "b".repeat(64);
  const receipt = await consumeWalmartItemReportReissueAuthorizationV2(
    consumeOptions(item, authorizationSha256),
  );

  assert.equal(receipt.state, "REQUESTING");
  assert.equal(path.basename(receipt.reservation_path), `${authorizationSha256}.json`);
  assert.equal(
    path.basename(receipt.requesting_path),
    `.${authorizationSha256}.requesting.json`,
  );
  for (const file of [receipt.reservation_path, receipt.requesting_path]) {
    const info = await lstat(file);
    assert.equal(info.mode & 0o777, 0o400);
    assert.equal(info.nlink, 1);
  }
  assert.equal(receipt.reservation_file_sha256, sha256(await readFile(receipt.reservation_path)));
  assert.equal(receipt.requesting_file_sha256, sha256(await readFile(receipt.requesting_path)));

  const opened = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  assert.deepEqual(opened.authorizations, [receipt]);
  await rejectsCode(
    consumeWalmartItemReportReissueAuthorizationV2(
      consumeOptions(item, authorizationSha256, "10000000-0000-4000-8000-000000000004"),
    ),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );
});

test("concurrent double consume has exactly one winner", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "c".repeat(64);
  const attempts = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => (
    consumeWalmartItemReportReissueAuthorizationV2(consumeOptions(
      item,
      authorizationSha256,
      `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    ))
  )));
  const fulfilled = attempts.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.state, "REQUESTING");
  assert.equal(
    (await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    })).authorizations.length,
    1,
  );
});

test("a crash after CLAIMED burns authorization, and only the exact claim can advance once", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "d".repeat(64);
  const claim = await claimWalmartItemReportReissueAuthorizationV2({
    ...consumeOptions(item, authorizationSha256),
  });
  assert.equal(claim.state, "CLAIMED");
  await rejectsCode(
    claimWalmartItemReportReissueAuthorizationV2(consumeOptions(item, authorizationSha256)),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );
  await rejectsCode(
    consumeWalmartItemReportReissueAuthorizationV2(consumeOptions(item, authorizationSha256)),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );

  const requesting = await markWalmartItemReportReissueAuthorizationRequestingV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    claim,
    requesting_at: REQUESTING_AT,
  });
  assert.equal(requesting.state, "REQUESTING");
  await rejectsCode(
    markWalmartItemReportReissueAuthorizationRequestingV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      claim,
      requesting_at: REQUESTING_AT,
    }),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );
});

test("concurrent CLAIMED to REQUESTING transition has exactly one winner", async (t) => {
  const item = await fixture(t);
  const claim = await claimWalmartItemReportReissueAuthorizationV2({
    ...consumeOptions(item, "e".repeat(64)),
  });
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => (
    markWalmartItemReportReissueAuthorizationRequestingV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      claim,
      requesting_at: REQUESTING_AT,
    })
  )));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    (await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    })).authorizations[0].state,
    "REQUESTING",
  );
});

test("REQUESTING survives restart as a terminal replay fence and terminal outcome is append-only", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "f".repeat(64);
  const requesting = await consumeWalmartItemReportReissueAuthorizationV2(
    consumeOptions(item, authorizationSha256),
  );

  const terminal = await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    requesting,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: TERMINAL_AT,
      http_status: 201,
      response_body_sha256: "1".repeat(64),
      report_request_id_sha256: "2".repeat(64),
      error_code: null,
    },
  });
  assert.equal(terminal.state, "SUCCEEDED");
  assert.equal((await lstat(terminal.terminal_path)).mode & 0o777, 0o400);
  assert.equal(terminal.terminal_file_sha256, sha256(await readFile(terminal.terminal_path)));
  assert.equal(
    (await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    })).authorizations[0].state,
    "SUCCEEDED",
  );
  await rejectsCode(
    consumeWalmartItemReportReissueAuthorizationV2(consumeOptions(item, authorizationSha256)),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );
  await rejectsCode(
    terminalizeWalmartItemReportReissueAuthorizationV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      requesting,
      outcome: {
        state: "FAILED",
        terminal_at: TERMINAL_AT,
        http_status: 500,
        response_body_sha256: "3".repeat(64),
        report_request_id_sha256: null,
        error_code: "SECOND_TERMINAL_FORBIDDEN",
      },
    }),
    "AUTHORIZATION_ALREADY_CONSUMED",
  );
});

test("AMBIGUOUS and FAILED outcomes remain consumed and invalid success cannot terminalize", async (t) => {
  const item = await fixture(t);
  const first = await consumeWalmartItemReportReissueAuthorizationV2(
    consumeOptions(item, "1".repeat(64)),
  );
  await rejectsCode(
    terminalizeWalmartItemReportReissueAuthorizationV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      requesting: first,
      outcome: {
        state: "SUCCEEDED",
        terminal_at: TERMINAL_AT,
        http_status: 201,
        response_body_sha256: null,
        report_request_id_sha256: null,
        error_code: null,
      },
    }),
    "INVALID_INPUT",
  );
  const ambiguous = await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    requesting: first,
    outcome: {
      state: "AMBIGUOUS",
      terminal_at: TERMINAL_AT,
      http_status: null,
      response_body_sha256: null,
      report_request_id_sha256: null,
      error_code: "CONNECTION_CLOSED_AFTER_REQUESTING",
    },
  });
  assert.equal(ambiguous.state, "AMBIGUOUS");

  const second = await consumeWalmartItemReportReissueAuthorizationV2(consumeOptions(
    item,
    "2".repeat(64),
    "10000000-0000-4000-8000-000000000005",
  ));
  const failed = await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    requesting: second,
    outcome: {
      state: "FAILED",
      terminal_at: TERMINAL_AT,
      http_status: 400,
      response_body_sha256: "4".repeat(64),
      report_request_id_sha256: null,
      error_code: "DEFINITIVE_HTTP_REJECTION",
    },
  });
  assert.equal(failed.state, "FAILED");
});

test("every signed identity binding component is checked before reservation", async (t) => {
  const item = await fixture(t);
  for (const [field, value] of [
    ["ledger_id", "ledger-wrong"],
    ["ledger_epoch", "epoch-wrong"],
    ["state_directory_path_sha256", "3".repeat(64)],
    ["directory_identity_sha256", "4".repeat(64)],
    ["identity_artifact_sha256", "5".repeat(64)],
  ]) {
    await rejectsCode(
      consumeWalmartItemReportReissueAuthorizationV2({
        ...consumeOptions(item, "6".repeat(64)),
        expected_binding: { ...item.binding, [field]: value },
      }),
      "LEDGER_BINDING_MISMATCH",
    );
  }
  assert.deepEqual(await readdirWithoutLedgerMetadata(item.stateDirectory), []);
});

async function readdirWithoutLedgerMetadata(directory) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directory)).filter(
    (name) => name !== ".ledger-identity.json" && name !== ".ledger-head.json",
  );
}

test("cumulative head advances across CLAIMED, REQUESTING, and terminal states", async (t) => {
  const item = await fixture(t);
  const initial = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  const claim = await claimWalmartItemReportReissueAuthorizationV2({
    ...consumeOptions(item, "7".repeat(64)),
  });
  const claimed = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  assert.equal(claimed.head.event_count, 1);
  assert.equal(claimed.head.previous_head_artifact_sha256, initial.head.artifact_sha256);
  assert.deepEqual(claimed.head.events.map((event) => event.state), ["CLAIMED"]);

  const requesting = await markWalmartItemReportReissueAuthorizationRequestingV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    claim,
    requesting_at: REQUESTING_AT,
  });
  const requestingSnapshot = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  assert.equal(requestingSnapshot.head.event_count, 2);
  assert.equal(
    requestingSnapshot.head.previous_head_artifact_sha256,
    claimed.head.artifact_sha256,
  );
  assert.deepEqual(
    requestingSnapshot.head.events.map((event) => event.state).sort(),
    ["CLAIMED", "REQUESTING"],
  );

  await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
    requesting,
    outcome: {
      state: "FAILED",
      terminal_at: TERMINAL_AT,
      http_status: 400,
      response_body_sha256: "8".repeat(64),
      report_request_id_sha256: null,
      error_code: "DEFINITIVE_HTTP_REJECTION",
    },
  });
  const terminal = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: item.stateDirectory,
    expected_binding: item.binding,
  });
  assert.equal(terminal.head.event_count, 3);
  assert.equal(
    terminal.head.previous_head_artifact_sha256,
    requestingSnapshot.head.artifact_sha256,
  );
  assert.deepEqual(
    terminal.head.events.map((event) => event.state).sort(),
    ["CLAIMED", "FAILED", "REQUESTING"],
  );
});

test("missing, truncated, and rolled-back ledger heads fail closed", async (t) => {
  await t.test("missing head", async (t) => {
    const item = await fixture(t);
    await unlink(item.head_artifact_path);
    await rejectsCode(
      openWalmartItemReportReissueConsumptionLedgerV2({
        state_directory: item.stateDirectory,
        expected_binding: item.binding,
      }),
      "LEDGER_CORRUPT",
    );
  });

  await t.test("truncated head", async (t) => {
    const item = await fixture(t);
    await unlink(item.head_artifact_path);
    await writeFile(item.head_artifact_path, "{\n", { flag: "wx", mode: 0o400 });
    await rejectsCode(
      openWalmartItemReportReissueConsumptionLedgerV2({
        state_directory: item.stateDirectory,
        expected_binding: item.binding,
      }),
      "LEDGER_CORRUPT",
    );
  });

  await t.test("older head restored over newer events", async (t) => {
    const item = await fixture(t);
    const claim = await claimWalmartItemReportReissueAuthorizationV2({
      ...consumeOptions(item, "9".repeat(64)),
    });
    const oldHeadBytes = await readFile(item.head_artifact_path);
    await markWalmartItemReportReissueAuthorizationRequestingV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      claim,
      requesting_at: REQUESTING_AT,
    });
    await unlink(item.head_artifact_path);
    await writeFile(item.head_artifact_path, oldHeadBytes, { flag: "wx", mode: 0o400 });
    await rejectsCode(
      openWalmartItemReportReissueConsumptionLedgerV2({
        state_directory: item.stateDirectory,
        expected_binding: item.binding,
      }),
      "LEDGER_ROLLBACK_OR_DELETION_DETECTED",
    );
  });
});

test("directory/file mode, symlink, hardlink, copied identity, and unexpected inventory fail closed", async (t) => {
  const item = await fixture(t);

  await chmod(item.stateDirectory, 0o755);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CUSTODY_INVALID",
  );
  await chmod(item.stateDirectory, 0o700);

  await chmod(item.identity_artifact_path, 0o600);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
  await chmod(item.identity_artifact_path, 0o400);

  const hardlink = path.join(item.root, "identity-hardlink.json");
  await link(item.identity_artifact_path, hardlink);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
  await unlink(hardlink);

  const alias = path.join(item.root, "ledger-alias");
  await symlink(item.stateDirectory, alias);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: alias,
      expected_binding: item.binding,
    }),
    "LEDGER_CUSTODY_INVALID",
  );

  const copied = path.join(item.root, "copied-ledger");
  await mkdir(copied, { mode: 0o700 });
  await copyFile(item.identity_artifact_path, path.join(copied, ".ledger-identity.json"));
  await chmod(path.join(copied, ".ledger-identity.json"), 0o400);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: copied,
      expected_binding: item.binding,
    }),
    "LEDGER_BINDING_MISMATCH",
  );

  const unexpected = path.join(item.stateDirectory, "unexpected.json");
  await writeFile(unexpected, "{}\n", { flag: "wx", mode: 0o400 });
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
});

test("reservation symlinks, hardlinks, noncanonical bytes, and receipt drift cannot advance", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "7".repeat(64);
  const claim = await claimWalmartItemReportReissueAuthorizationV2(
    consumeOptions(item, authorizationSha256),
  );

  const hardlink = path.join(item.root, "claim-hardlink.json");
  await link(claim.reservation_path, hardlink);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
  await unlink(hardlink);

  await rejectsCode(
    markWalmartItemReportReissueAuthorizationRequestingV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
      claim: { ...claim, reservation_file_sha256: "8".repeat(64) },
      requesting_at: REQUESTING_AT,
    }),
    "CLAIM_BINDING_MISMATCH",
  );

  const original = `${claim.reservation_path}.original`;
  await rename(claim.reservation_path, original);
  await symlink(original, claim.reservation_path);
  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
});

test("a partial REQUESTING fence from a crash is permanently fail-closed", async (t) => {
  const item = await fixture(t);
  const authorizationSha256 = "9".repeat(64);
  await claimWalmartItemReportReissueAuthorizationV2(consumeOptions(item, authorizationSha256));
  const partialFence = path.join(
    item.stateDirectory,
    `.${authorizationSha256}.requesting.json`,
  );
  await writeFile(partialFence, "", { flag: "wx", mode: 0o400 });

  await rejectsCode(
    openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.stateDirectory,
      expected_binding: item.binding,
    }),
    "LEDGER_CORRUPT",
  );
  await rejectsCode(
    consumeWalmartItemReportReissueAuthorizationV2(
      consumeOptions(item, authorizationSha256),
    ),
    "LEDGER_CORRUPT",
  );
});
