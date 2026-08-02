import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_SCHEMA,
  type WalmartListingIntegrityRuntimeState,
  type WalmartListingIntegrityRuntimeStatus,
} from "./listing-integrity-runtime-status";

const DEFAULT_STATUS_ROOT = path.join(
  os.homedir(),
  ".ss-command-center-owner",
  "walmart",
);
const SUCCESSOR_STATUS_FILE = "listing-integrity-successor-watch-status.json";
const PREDECESSOR_MONITOR_FILE = "monitor-FaisalX-1144-v46-status.json";
const PREDECESSOR_MONITOR_LOCK_FILE = "monitor-FaisalX-1144-v46.lock";
const SUCCESSOR_SCHEMA = "walmart-listing-integrity-successor-watch-status/v1";
const SUCCESSOR_STATUSES = new Set([
  "WAITING_FOR_PREDECESSOR_QUALIFICATION",
  "SUCCESSOR_ACTIVE_CYCLE_PROGRESS",
  "SUCCESSOR_LIMIT_REACHED",
  "CONTROL_QUEUE_COMPLETE",
  "STOPPED_ON_UNSUPPORTED_CONTROL_STATE",
  "STOPPED_ON_ERROR",
] as const);

type JsonRecord = Record<string, unknown>;
type SuccessorStatus = NonNullable<
  WalmartListingIntegrityRuntimeStatus["successor"]
>["status"];

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_INVALID: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  const raw = exactText(value, label, 64);
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch)) fail(`${label} must be an ISO timestamp`);
  return new Date(epoch).toISOString();
}

function integer(value: unknown, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function writeCount(value: unknown, label: string): 0 | 1 {
  const parsed = integer(value, label, 0);
  if (parsed !== 0 && parsed !== 1) fail(`${label} must be 0 or 1`);
  return parsed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedJson(
  pathname: string,
  label: string,
): Promise<JsonRecord | null> {
  let info;
  try {
    info = await lstat(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1_000_000) {
    fail(`${label} must be a bounded regular file`);
  }
  return record(JSON.parse(await readFile(pathname, "utf8")), label);
}

async function readExactReferencedJson(input: {
  statusRoot: string;
  pathname: unknown;
  expectedSha256: unknown;
  label: string;
}): Promise<JsonRecord> {
  const root = path.resolve(input.statusRoot);
  const pathname = path.resolve(exactText(input.pathname, `${input.label}.path`, 2_048));
  if (pathname === root || !pathname.startsWith(`${root}${path.sep}`)) {
    fail(`${input.label}.path escapes status custody`);
  }
  const expectedSha = exactText(input.expectedSha256, `${input.label}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha)) fail(`${input.label}.sha256 is invalid`);
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1_000_000) {
    fail(`${input.label} must be a bounded regular file`);
  }
  const bytes = await readFile(pathname);
  if (digest(bytes) !== expectedSha) fail(`${input.label} exact-file SHA differs`);
  return record(JSON.parse(bytes.toString("utf8")), input.label);
}

function skuFromListingKey(listingKey: string | null): string | null {
  if (!listingKey) return null;
  const match = /^walmart:1:([A-Za-z0-9._-]{1,500})$/u.exec(listingKey);
  if (!match) fail("active_listing_key is invalid");
  return match[1];
}

function runtimeState(status: SuccessorStatus): WalmartListingIntegrityRuntimeState {
  if (status === "WAITING_FOR_PREDECESSOR_QUALIFICATION") return "WAITING_PREDECESSOR";
  if (status === "SUCCESSOR_ACTIVE_CYCLE_PROGRESS") return "ACTIVE_CYCLE";
  if (status === "SUCCESSOR_LIMIT_REACHED") return "PAUSED_LIMIT";
  if (status === "CONTROL_QUEUE_COMPLETE") return "QUEUE_COMPLETE";
  return "ERROR";
}

function emptyStatus(): WalmartListingIntegrityRuntimeStatus {
  return {
    schemaVersion: WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_SCHEMA,
    state: "NOT_AVAILABLE",
    checkedAt: null,
    activeListingKey: null,
    activeSku: null,
    successor: null,
    qualification: null,
    claims: {
      source: "LOCAL_SHA_CUSTODY_STATUS",
      statusLoaderWalmartReads: 0,
      statusLoaderWalmartWrites: 0,
      mutationControlsExposed: false,
    },
  };
}

export async function loadWalmartListingIntegrityRuntimeStatus(
  statusRoot = DEFAULT_STATUS_ROOT,
): Promise<WalmartListingIntegrityRuntimeStatus> {
  const successorRaw = await readBoundedJson(
    path.join(statusRoot, SUCCESSOR_STATUS_FILE),
    "successor status",
  );
  if (!successorRaw) return emptyStatus();
  if (successorRaw.schema_version !== SUCCESSOR_SCHEMA) {
    fail("successor schema differs");
  }
  const status = exactText(successorRaw.status, "successor.status", 80) as SuccessorStatus;
  if (!SUCCESSOR_STATUSES.has(status)) fail("successor.status is unsupported");
  const successorCheckedAt = instant(successorRaw.checked_at, "successor.checked_at");
  const successorPid = integer(successorRaw.pid, "successor.pid", 1);
  const lastCycleWalmartWrites = writeCount(
    successorRaw.walmart_writes,
    "successor.walmart_writes",
  );
  if (status === "WAITING_FOR_PREDECESSOR_QUALIFICATION"
    && lastCycleWalmartWrites !== 0) {
    fail("waiting successor cannot report a Walmart write");
  }
  const activeListingKey = successorRaw.active_listing_key === null
    || successorRaw.active_listing_key === undefined
    ? null
    : exactText(successorRaw.active_listing_key, "successor.active_listing_key");
  let activeSku = successorRaw.sku === undefined || successorRaw.sku === null
    ? skuFromListingKey(activeListingKey)
    : exactText(successorRaw.sku, "successor.sku", 500);
  let state = runtimeState(status);
  let qualification: WalmartListingIntegrityRuntimeStatus["qualification"] = null;

  const monitorRaw = await readBoundedJson(
    path.join(statusRoot, PREDECESSOR_MONITOR_FILE),
    "predecessor monitor status",
  );
  const monitorLock = await readBoundedJson(
    path.join(statusRoot, PREDECESSOR_MONITOR_LOCK_FILE),
    "predecessor monitor lock",
  );
  if (monitorRaw && status === "WAITING_FOR_PREDECESSOR_QUALIFICATION") {
    const monitorSku = exactText(monitorRaw.sku, "monitor.sku", 500);
    if (activeSku === monitorSku && monitorRaw.phase === "QUALIFICATION") {
      if (integer(
        monitorRaw.walmart_content_writes,
        "monitor.walmart_content_writes",
        0,
      ) !== 0) {
        fail("Qualification monitor must report zero Walmart writes");
      }
      const qualificationStatus = exactText(
        monitorRaw.qualification_status,
        "monitor.qualification_status",
        64,
      );
      if (!["PENDING_PROPAGATION", "PASS", "FAIL"].includes(qualificationStatus)) {
        fail("monitor.qualification_status is unsupported");
      }
      const monitorCheckedAt = instant(monitorRaw.checked_at, "monitor.checked_at");
      const qualificationReceipt = await readExactReferencedJson({
        statusRoot,
        pathname: monitorRaw.qualification_receipt_path,
        expectedSha256: monitorRaw.qualification_receipt_file_sha256,
        label: "qualification receipt",
      });
      const receiptListing = record(
        qualificationReceipt.listing,
        "qualification receipt.listing",
      );
      const receiptQualification = record(
        qualificationReceipt.qualification,
        "qualification receipt.qualification",
      );
      const receiptEffects = record(
        qualificationReceipt.external_effects,
        "qualification receipt.external_effects",
      );
      const facets = record(receiptQualification.facets, "qualification receipt.facets");
      if (qualificationReceipt.command !== "qualify"
        || qualificationReceipt.status !== qualificationStatus
        || receiptQualification.verdict !== qualificationStatus
        || receiptListing.sku !== monitorSku
        || integer(
          receiptEffects.walmart_content_writes,
          "qualification receipt Walmart writes",
          0,
        ) !== 0) {
        fail("qualification receipt identity/status/effects differ from monitor");
      }
      const primaryFacets = [
        "product_and_variant", "pack_count", "title", "description", "bullets",
        "attributes", "main", "gallery", "published_and_indexed",
      ];
      const blockingFacets = primaryFacets.filter((facet) => facets[facet] !== "PASS");
      const propagation = receiptQualification.propagation === undefined
        ? null
        : record(receiptQualification.propagation, "qualification receipt.propagation");
      const failureNotBefore = propagation?.failure_not_before === undefined
        ? null
        : instant(
          propagation.failure_not_before,
          "qualification receipt.propagation.failure_not_before",
        );
      let monitorIsAlive = false;
      if (monitorLock) {
        if (exactText(monitorLock.sku, "monitor lock.sku", 500) !== monitorSku
          || exactText(monitorLock.mode, "monitor lock.mode", 100)
            !== "FEED_GET_THEN_FRESH_QUALIFICATION_NO_WRITE") {
          fail("monitor lock identity or mode differs");
        }
        monitorIsAlive = processAlive(integer(monitorLock.pid, "monitor lock.pid", 1));
      }
      qualification = {
        status: qualificationStatus as "PENDING_PROPAGATION" | "PASS" | "FAIL",
        check: integer(monitorRaw.check, "monitor.check", 1),
        checkedAt: monitorCheckedAt,
        monitorAlive: monitorIsAlive,
        blockingFacets,
        publishedAndIndexedPreserved: facets.published_and_indexed === "PASS",
        failureNotBefore,
      };
      if (qualification.status === "PENDING_PROPAGATION") {
        state = "MONITORING_QUALIFICATION";
      } else if (qualification.status === "FAIL") {
        state = "REQUIRES_DISPOSITION";
      }
      activeSku = monitorSku;
    }
  }

  return {
    schemaVersion: WALMART_LISTING_INTEGRITY_RUNTIME_STATUS_SCHEMA,
    state,
    checkedAt: qualification?.checkedAt ?? successorCheckedAt,
    activeListingKey,
    activeSku,
    successor: {
      status,
      checkedAt: successorCheckedAt,
      pid: successorPid,
      processAlive: processAlive(successorPid),
      lastCycleWalmartWrites,
    },
    qualification,
    claims: {
      source: "LOCAL_SHA_CUSTODY_STATUS",
      statusLoaderWalmartReads: 0,
      statusLoaderWalmartWrites: 0,
      mutationControlsExposed: false,
    },
  };
}
