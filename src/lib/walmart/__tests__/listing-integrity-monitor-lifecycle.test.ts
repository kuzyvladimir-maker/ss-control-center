import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runWalmartListingIntegrityMonitorOnce,
  sealWalmartListingIntegrityMonitorTerminal,
  verifyWalmartListingIntegrityMonitorTerminal,
} from "../listing-integrity-monitor-lifecycle.ts";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const IDENTITY = {
  listing_key: "walmart:1:FaisalX-2768",
  execution_package_sha256: H("package"),
  terminal_execute_receipt_sha256: H("execute"),
};

function terminal(status: "PASS" | "FAIL" = "FAIL") {
  return sealWalmartListingIntegrityMonitorTerminal({
    completed_at: "2026-07-28T04:45:10.000Z",
    final_status: status,
    identity: IDENTITY,
    qualification_receipt_file_sha256: H("qualification"),
  });
}

test("a terminal monitor restart exits successfully without calling Qualification again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "listing-monitor-"));
  const terminalFile = path.join(root, "terminal.json");
  let calls = 0;
  const first = await runWalmartListingIntegrityMonitorOnce({
    terminal_file: terminalFile,
    identity: IDENTITY,
    run_once: async () => {
      calls += 1;
      return terminal();
    },
  });
  assert.equal(first.status, "TERMINAL_RECORDED");
  assert.equal(first.run_once_called, true);
  assert.equal(calls, 1);

  const second = await runWalmartListingIntegrityMonitorOnce({
    terminal_file: terminalFile,
    identity: IDENTITY,
    run_once: async () => {
      calls += 1;
      throw new Error("must not run after terminal");
    },
  });
  assert.equal(second.status, "TERMINAL_ALREADY_RECORDED");
  assert.equal(second.run_once_called, false);
  assert.equal(calls, 1);
  assert.equal(
    verifyWalmartListingIntegrityMonitorTerminal(
      JSON.parse((await readFile(terminalFile)).toString("utf8")),
    ).next_action,
    "QUARANTINE_UNRESOLVED_AND_ADVANCE",
  );
});

test("an active lock prevents a second local monitor from doing any work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "listing-monitor-lock-"));
  const terminalFile = path.join(root, "terminal.json");
  const lock = await open(`${terminalFile}.lock`, "wx", 0o400);
  try {
    let called = false;
    const result = await runWalmartListingIntegrityMonitorOnce({
      terminal_file: terminalFile,
      identity: IDENTITY,
      run_once: async () => {
        called = true;
        return terminal("PASS");
      },
    });
    assert.equal(result.status, "MONITOR_ALREADY_RUNNING");
    assert.equal(result.run_once_called, false);
    assert.equal(called, false);
  } finally {
    await lock.close();
  }
});

test("a terminal file for another package fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "listing-monitor-mismatch-"));
  const terminalFile = path.join(root, "terminal.json");
  await runWalmartListingIntegrityMonitorOnce({
    terminal_file: terminalFile,
    identity: IDENTITY,
    run_once: async () => terminal(),
  });
  await assert.rejects(
    runWalmartListingIntegrityMonitorOnce({
      terminal_file: terminalFile,
      identity: {
        ...IDENTITY,
        execution_package_sha256: H("another-package"),
      },
      run_once: async () => null,
    }),
    /belongs to another execution/,
  );
});
