import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";

export const WALMART_LISTING_INTEGRITY_MONITOR_TERMINAL_SCHEMA =
  "walmart-listing-integrity-qualification-monitor-terminal/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityMonitorIdentity {
  listing_key: string;
  execution_package_sha256: string;
  terminal_execute_receipt_sha256: string;
}

export interface WalmartListingIntegrityMonitorTerminal {
  schema_version: typeof WALMART_LISTING_INTEGRITY_MONITOR_TERMINAL_SCHEMA;
  completed_at: string;
  final_status: "PASS" | "FAIL";
  identity: WalmartListingIntegrityMonitorIdentity;
  qualification_receipt_file_sha256: string;
  next_action:
    | "ADVANCE_TO_NEXT_SKU"
    | "QUARANTINE_UNRESOLVED_AND_ADVANCE";
  automatic_reapply_allowed: false;
  walmart_content_writes: 0;
  body_sha256: string;
}

export type WalmartListingIntegrityMonitorRunResult =
  | {
      status: "TERMINAL_ALREADY_RECORDED";
      terminal: WalmartListingIntegrityMonitorTerminal;
      run_once_called: false;
    }
  | {
      status: "MONITOR_ALREADY_RUNNING";
      terminal: null;
      run_once_called: false;
    }
  | {
      status: "NONTERMINAL_CHECK_COMPLETE";
      terminal: null;
      run_once_called: true;
    }
  | {
      status: "TERMINAL_RECORDED";
      terminal: WalmartListingIntegrityMonitorTerminal;
      run_once_called: true;
    };

export class WalmartListingIntegrityMonitorLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalmartListingIntegrityMonitorLifecycleError";
  }
}

function fail(message: string): never {
  throw new WalmartListingIntegrityMonitorLifecycleError(message);
}

function text(value: unknown, label: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(`${label} must be canonical UTC`);
  }
  return parsed;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactIdentity(
  left: WalmartListingIntegrityMonitorIdentity,
  right: WalmartListingIntegrityMonitorIdentity,
): boolean {
  return left.listing_key === right.listing_key
    && left.execution_package_sha256 === right.execution_package_sha256
    && left.terminal_execute_receipt_sha256
      === right.terminal_execute_receipt_sha256;
}

function parseIdentity(value: unknown): WalmartListingIntegrityMonitorIdentity {
  const identity = record(value, "monitor identity");
  return {
    listing_key: text(identity.listing_key, "identity.listing_key", 768),
    execution_package_sha256: digest(
      identity.execution_package_sha256,
      "identity.execution_package_sha256",
    ),
    terminal_execute_receipt_sha256: digest(
      identity.terminal_execute_receipt_sha256,
      "identity.terminal_execute_receipt_sha256",
    ),
  };
}

export function sealWalmartListingIntegrityMonitorTerminal(input: {
  completed_at: string;
  final_status: "PASS" | "FAIL";
  identity: WalmartListingIntegrityMonitorIdentity;
  qualification_receipt_file_sha256: string;
}): WalmartListingIntegrityMonitorTerminal {
  const finalStatus = input.final_status;
  if (finalStatus !== "PASS" && finalStatus !== "FAIL") {
    fail("final_status must be PASS or FAIL");
  }
  const identity = parseIdentity(input.identity);
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_MONITOR_TERMINAL_SCHEMA,
    completed_at: instant(input.completed_at, "completed_at"),
    final_status: finalStatus,
    identity,
    qualification_receipt_file_sha256: digest(
      input.qualification_receipt_file_sha256,
      "qualification_receipt_file_sha256",
    ),
    next_action: finalStatus === "PASS"
      ? "ADVANCE_TO_NEXT_SKU" as const
      : "QUARANTINE_UNRESOLVED_AND_ADVANCE" as const,
    automatic_reapply_allowed: false as const,
    walmart_content_writes: 0 as const,
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  });
}

export function verifyWalmartListingIntegrityMonitorTerminal(
  value: unknown,
): WalmartListingIntegrityMonitorTerminal {
  const terminal = record(value, "monitor terminal");
  const claimed = digest(terminal.body_sha256, "monitor terminal body_sha256");
  const body = { ...terminal };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed
    || terminal.schema_version !== WALMART_LISTING_INTEGRITY_MONITOR_TERMINAL_SCHEMA
    || !["PASS", "FAIL"].includes(String(terminal.final_status))
    || terminal.automatic_reapply_allowed !== false
    || terminal.walmart_content_writes !== 0) {
    fail("monitor terminal seal or policy differs");
  }
  const parsed = terminal as unknown as WalmartListingIntegrityMonitorTerminal;
  parseIdentity(parsed.identity);
  instant(parsed.completed_at, "completed_at");
  digest(
    parsed.qualification_receipt_file_sha256,
    "qualification_receipt_file_sha256",
  );
  const expectedAction = parsed.final_status === "PASS"
    ? "ADVANCE_TO_NEXT_SKU"
    : "QUARANTINE_UNRESOLVED_AND_ADVANCE";
  if (parsed.next_action !== expectedAction) {
    fail("monitor terminal next_action differs from final status");
  }
  return parsed;
}

async function stableTerminal(
  file: string,
): Promise<WalmartListingIntegrityMonitorTerminal | null> {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > 1024 * 1024
    || await realpath(file) !== file) {
    fail("monitor terminal must be one bounded canonical regular file");
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size) {
    fail("monitor terminal changed while read");
  }
  return verifyWalmartListingIntegrityMonitorTerminal(
    JSON.parse(bytes.toString("utf8")),
  );
}

async function writeTerminalExclusive(
  file: string,
  terminal: WalmartListingIntegrityMonitorTerminal,
): Promise<WalmartListingIntegrityMonitorTerminal> {
  const bytes = Buffer.from(`${JSON.stringify(terminal, null, 2)}\n`, "utf8");
  try {
    const handle = await open(file, "wx", 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return terminal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await stableTerminal(file);
    if (!existing || !exactIdentity(existing.identity, terminal.identity)) {
      fail("existing monitor terminal belongs to another execution");
    }
    return existing;
  }
}

export async function runWalmartListingIntegrityMonitorOnce(input: {
  terminal_file: string;
  identity: WalmartListingIntegrityMonitorIdentity;
  run_once: () => Promise<WalmartListingIntegrityMonitorTerminal | null>;
}): Promise<WalmartListingIntegrityMonitorRunResult> {
  const requestedTerminalFile = path.resolve(input.terminal_file);
  if (requestedTerminalFile !== input.terminal_file
    || typeof input.run_once !== "function") {
    fail("monitor terminal path/callback is invalid");
  }
  const terminalFile = path.join(
    await realpath(path.dirname(requestedTerminalFile)),
    path.basename(requestedTerminalFile),
  );
  const expectedIdentity = parseIdentity(input.identity);
  const existing = await stableTerminal(terminalFile);
  if (existing) {
    if (!exactIdentity(existing.identity, expectedIdentity)) {
      fail("existing monitor terminal belongs to another execution");
    }
    return {
      status: "TERMINAL_ALREADY_RECORDED",
      terminal: existing,
      run_once_called: false,
    };
  }

  const lockFile = `${terminalFile}.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return {
      status: "MONITOR_ALREADY_RUNNING",
      terminal: null,
      run_once_called: false,
    };
  }
  try {
    const raced = await stableTerminal(terminalFile);
    if (raced) {
      if (!exactIdentity(raced.identity, expectedIdentity)) {
        fail("raced monitor terminal belongs to another execution");
      }
      return {
        status: "TERMINAL_ALREADY_RECORDED",
        terminal: raced,
        run_once_called: false,
      };
    }
    const candidate = await input.run_once();
    if (candidate === null) {
      return {
        status: "NONTERMINAL_CHECK_COMPLETE",
        terminal: null,
        run_once_called: true,
      };
    }
    const verified = verifyWalmartListingIntegrityMonitorTerminal(candidate);
    if (!exactIdentity(verified.identity, expectedIdentity)) {
      fail("monitor callback returned another execution identity");
    }
    return {
      status: "TERMINAL_RECORDED",
      terminal: await writeTerminalExclusive(terminalFile, verified),
      run_once_called: true,
    };
  } finally {
    await lock.close();
    await unlink(lockFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export function walmartListingIntegrityMonitorFileSha256(
  value: Uint8Array,
): string {
  return sha256(value);
}
