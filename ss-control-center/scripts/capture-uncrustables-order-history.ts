import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import { spApiGet, spApiPost, MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";
import { downloadReport, getReportDocumentUrl } from "../src/lib/amazon-sp-api/reports";
import {
  AMAZON_ALL_ORDERS_REPORT_TYPE,
  buildHistoricalWindows,
  sha256,
  type HistoricalWindow,
} from "../src/lib/amazon-sp-api/uncrustables-order-history";

const STATE_SCHEMA = "uncrustables-amazon-order-capture/v1";
const MAX_REPORT_BYTES = 256 * 1024 * 1024;
const CREATE_INTERVAL_MS = 65_000;
const POLL_INTERVAL_MS = 15_000;

type WindowStatus =
  | "PLANNED"
  | "CREATE_IN_FLIGHT"
  | "CREATE_AMBIGUOUS"
  | "REQUESTED"
  | "DONE"
  | "NO_DATA"
  | "FATAL";

interface WindowState extends HistoricalWindow {
  status: WindowStatus;
  reportId?: string;
  reportDocumentId?: string;
  createStartedAt?: string;
  requestedAt?: string;
  completedAt?: string;
  lastCheckedAt?: string;
  rawFile?: string;
  rawSha256?: string;
  rawBytes?: number;
  dataRows?: number;
  error?: string;
}

interface CaptureState {
  schemaVersion: typeof STATE_SCHEMA;
  createdAt: string;
  updatedAt: string;
  storeIndex: number;
  storeId: string;
  marketplaceId: string;
  reportType: typeof AMAZON_ALL_ORDERS_REPORT_TYPE;
  startTime: string;
  endTime: string;
  source: {
    marketplaceMutations: 0;
    reportCreateRetries: 0;
    rawReportsContainOrderData: true;
  };
  windows: WindowState[];
}

interface ReportDetail {
  reportId?: unknown;
  reportType?: unknown;
  processingStatus?: unknown;
  reportDocumentId?: unknown;
  dataStartTime?: unknown;
  dataEndTime?: unknown;
  marketplaceIds?: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

function exactArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} is required exactly once`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

function optionalIntegerArg(
  args: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!args.includes(name)) return fallback;
  const value = Number(exactArg(args, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function canonicalInstant(value: string, name: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${name} must be a valid ISO instant`);
  const canonical = new Date(milliseconds).toISOString();
  if (!value.endsWith("Z")) fail(`${name} must be expressed in UTC with a trailing Z`);
  return canonical;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function createOrLoadState(
  outDir: string,
  storeIndex: number,
  startTime: string,
  endTime: string,
): Promise<CaptureState> {
  const statePath = join(outDir, "capture-state.json");
  if (await pathExists(statePath)) {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as CaptureState;
    if (parsed.schemaVersion !== STATE_SCHEMA) fail("capture state schema is unsupported");
    if (
      parsed.storeIndex !== storeIndex
      || parsed.startTime !== startTime
      || parsed.endTime !== endTime
      || parsed.marketplaceId !== MARKETPLACE_ID
    ) {
      fail("existing capture state does not match the requested scope");
    }
    const unsafe = parsed.windows.find((window) =>
      window.status === "CREATE_IN_FLIGHT" || window.status === "CREATE_AMBIGUOUS");
    if (unsafe) {
      fail(
        `window ${unsafe.id} has an ambiguous report-create outcome; reconcile its reportId before any retry`,
      );
    }
    return parsed;
  }

  if (!(await pathExists(outDir))) await mkdir(outDir, { mode: 0o700 });
  if (await realpath(outDir) !== outDir) fail("--out-dir must not use a symlink alias");
  const now = new Date().toISOString();
  const state: CaptureState = {
    schemaVersion: STATE_SCHEMA,
    createdAt: now,
    updatedAt: now,
    storeIndex,
    storeId: `store${storeIndex}`,
    marketplaceId: MARKETPLACE_ID,
    reportType: AMAZON_ALL_ORDERS_REPORT_TYPE,
    startTime,
    endTime,
    source: {
      marketplaceMutations: 0,
      reportCreateRetries: 0,
      rawReportsContainOrderData: true,
    },
    windows: buildHistoricalWindows(startTime, endTime).map((window) => ({
      ...window,
      status: "PLANNED",
    })),
  };
  await writeJsonAtomic(statePath, state);
  return state;
}

async function persistState(outDir: string, state: CaptureState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(join(outDir, "capture-state.json"), state);
}

function knownNoCreateResponse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SP-API (?:4\d\d|rate limited) on POST/u.test(message);
}

async function createOneReport(outDir: string, state: CaptureState): Promise<boolean> {
  const window = state.windows.find((candidate) => candidate.status === "PLANNED");
  if (!window) return false;
  window.status = "CREATE_IN_FLIGHT";
  window.createStartedAt = new Date().toISOString();
  delete window.error;
  await persistState(outDir, state);

  let physicalRequestStarted = false;
  try {
    const response = await spApiPost(
      "/reports/2021-06-30/reports",
      {
        reportType: AMAZON_ALL_ORDERS_REPORT_TYPE,
        marketplaceIds: [MARKETPLACE_ID],
        dataStartTime: window.startTime,
        dataEndTime: window.endTime,
      },
      {
        storeId: state.storeId,
        retries: 1,
        beforeRequest: () => {
          physicalRequestStarted = true;
        },
      },
    ) as { reportId?: unknown };
    if (typeof response.reportId !== "string" || response.reportId.length < 1) {
      fail("Amazon report-create response has no reportId");
    }
    window.reportId = response.reportId;
    window.status = "REQUESTED";
    window.requestedAt = new Date().toISOString();
    await persistState(outDir, state);
    console.log(JSON.stringify({ event: "REPORT_REQUESTED", window: window.id, reportId: window.reportId }));
    return true;
  } catch (error) {
    window.error = error instanceof Error ? error.message : String(error);
    if (!physicalRequestStarted || knownNoCreateResponse(error)) {
      window.status = "PLANNED";
      await persistState(outDir, state);
      throw error;
    }
    window.status = "CREATE_AMBIGUOUS";
    await persistState(outDir, state);
    fail(`report-create outcome is ambiguous for ${window.id}; no automatic retry is allowed`);
  }
}

function exactInstantOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function assertReportBinding(window: WindowState, detail: ReportDetail, state: CaptureState): void {
  if (detail.reportId !== window.reportId) fail(`reportId mismatch for ${window.id}`);
  if (detail.reportType !== AMAZON_ALL_ORDERS_REPORT_TYPE) {
    fail(`reportType mismatch for ${window.id}`);
  }
  const start = exactInstantOrNull(detail.dataStartTime);
  const end = exactInstantOrNull(detail.dataEndTime);
  if (start && start !== window.startTime) fail(`dataStartTime mismatch for ${window.id}`);
  if (end && end !== window.endTime) fail(`dataEndTime mismatch for ${window.id}`);
  if (
    Array.isArray(detail.marketplaceIds)
    && !detail.marketplaceIds.includes(state.marketplaceId)
  ) {
    fail(`marketplace mismatch for ${window.id}`);
  }
}

async function captureDoneReport(
  outDir: string,
  state: CaptureState,
  window: WindowState,
  detail: ReportDetail,
): Promise<void> {
  if (typeof detail.reportDocumentId !== "string" || !detail.reportDocumentId) {
    fail(`DONE report ${window.reportId} has no document id`);
  }
  const content = await downloadReport(
    await getReportDocumentUrl(state.storeId, detail.reportDocumentId),
  );
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_REPORT_BYTES) {
    fail(`report ${window.reportId} byte length is outside the allowed range`);
  }
  const firstLine = content.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0] ?? "";
  const headers = new Set(firstLine.split("\t"));
  for (const required of ["amazon-order-id", "purchase-date", "product-name", "sku", "asin"]) {
    if (!headers.has(required)) fail(`report ${window.reportId} lacks ${required}`);
  }
  const rawFile = `orders-${window.id}-${window.reportId}.tsv`;
  await writeExclusive(join(outDir, rawFile), bytes);
  window.status = "DONE";
  window.reportDocumentId = detail.reportDocumentId;
  window.rawFile = rawFile;
  window.rawSha256 = sha256(bytes);
  window.rawBytes = bytes.length;
  window.dataRows = Math.max(0, content.split(/\r?\n/u).filter(Boolean).length - 1);
  window.completedAt = new Date().toISOString();
  await persistState(outDir, state);
  console.log(JSON.stringify({
    event: "REPORT_CAPTURED",
    window: window.id,
    reportId: window.reportId,
    dataRows: window.dataRows,
    rawSha256: window.rawSha256,
  }));
}

async function pollRequestedReports(outDir: string, state: CaptureState): Promise<void> {
  for (const window of state.windows.filter((candidate) => candidate.status === "REQUESTED")) {
    const detail = await spApiGet(
      `/reports/2021-06-30/reports/${encodeURIComponent(window.reportId ?? "")}`,
      { storeId: state.storeId, retries: 3 },
    ) as ReportDetail;
    assertReportBinding(window, detail, state);
    window.lastCheckedAt = new Date().toISOString();
    const status = detail.processingStatus;
    if (status === "DONE") {
      await captureDoneReport(outDir, state, window, detail);
    } else if (status === "CANCELLED") {
      window.status = "NO_DATA";
      window.completedAt = new Date().toISOString();
      await persistState(outDir, state);
      console.log(JSON.stringify({ event: "REPORT_NO_DATA", window: window.id, reportId: window.reportId }));
    } else if (status === "FATAL") {
      window.status = "FATAL";
      window.completedAt = new Date().toISOString();
      window.error = "Amazon processingStatus=FATAL";
      await persistState(outDir, state);
      console.log(JSON.stringify({ event: "REPORT_FATAL", window: window.id, reportId: window.reportId }));
    } else if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
      fail(`unexpected processingStatus for ${window.id}: ${String(status)}`);
    } else {
      await persistState(outDir, state);
    }
  }
}

function summarize(state: CaptureState): Record<string, unknown> {
  const counts = Object.fromEntries(
    [...new Set(state.windows.map((window) => window.status))]
      .sort()
      .map((status) => [status, state.windows.filter((window) => window.status === status).length]),
  );
  return {
    status: state.windows.every((window) => ["DONE", "NO_DATA"].includes(window.status))
      ? "COMPLETE"
      : state.windows.some((window) => ["CREATE_AMBIGUOUS", "FATAL"].includes(window.status))
        ? "BLOCKED"
        : "IN_PROGRESS",
    storeIndex: state.storeIndex,
    startTime: state.startTime,
    endTime: state.endTime,
    windows: state.windows.length,
    counts,
    reportCreateRetries: 0,
    marketplaceMutations: 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Capture immutable Amazon All Orders reports in <=30-day windows.\n"
      + "Required: --store-index 1..5 --start ISOZ --end ISOZ --out-dir /ABS/PATH\n"
      + "Optional: --max-runtime-minutes 1..120 (default 45)\n"
      + "The command creates reports read-only, never retries a physical POST, and resumes from capture-state.json.",
    );
    return;
  }
  const allowed = new Set(["--store-index", "--start", "--end", "--out-dir", "--max-runtime-minutes"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const storeIndex = Number(exactArg(args, "--store-index"));
  if (!Number.isInteger(storeIndex) || storeIndex < 1 || storeIndex > 5) {
    fail("--store-index must be an integer from 1 through 5");
  }
  const startTime = canonicalInstant(exactArg(args, "--start"), "--start");
  const endTime = canonicalInstant(exactArg(args, "--end"), "--end");
  if (Date.parse(endTime) > Date.now() + 60_000) fail("--end must not be in the future");
  const outDir = exactArg(args, "--out-dir");
  if (!isAbsolute(outDir) || normalize(outDir) !== outDir || basename(outDir).startsWith(".")) {
    fail("--out-dir must be one normalized absolute non-hidden path");
  }
  const parent = dirname(outDir);
  if (await realpath(parent) !== parent || !(await stat(parent)).isDirectory()) {
    fail("--out-dir parent must be one existing real directory");
  }
  const maximumRuntimeMinutes = optionalIntegerArg(
    args,
    "--max-runtime-minutes",
    45,
    1,
    120,
  );
  const lockPath = `${outDir}.capture-lock`;
  await mkdir(lockPath, { mode: 0o700 });
  try {
    const state = await createOrLoadState(outDir, storeIndex, startTime, endTime);
    const deadline = Date.now() + maximumRuntimeMinutes * 60_000;
    let lastCreateAt = 0;
    while (Date.now() < deadline) {
      await pollRequestedReports(outDir, state);
      const terminal = state.windows.every((window) => ["DONE", "NO_DATA"].includes(window.status));
      const blocked = state.windows.some((window) =>
        ["CREATE_AMBIGUOUS", "FATAL"].includes(window.status));
      if (terminal || blocked) break;
      if (Date.now() - lastCreateAt >= CREATE_INTERVAL_MS) {
        const created = await createOneReport(outDir, state);
        if (created) lastCreateAt = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
    }
    console.log(JSON.stringify(summarize(state), null, 2));
    if (!state.windows.every((window) => ["DONE", "NO_DATA"].includes(window.status))) {
      process.exitCode = 2;
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
