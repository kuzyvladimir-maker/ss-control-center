import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { spApiGet } from "../src/lib/amazon-sp-api/client";
import {
  downloadReport,
  getReportDocumentUrl,
} from "../src/lib/amazon-sp-api/reports";

const REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const RECEIPT_VERSION = "amazon-existing-all-listings-capture/v1";
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return fail(`${label} is missing or invalid`);
  }
  return new Date(Date.parse(value)).toISOString();
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    fail("--out-dir already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

interface ReportDetail {
  reportId?: unknown;
  reportType?: unknown;
  processingStatus?: unknown;
  reportDocumentId?: unknown;
  createdTime?: unknown;
  processingStartTime?: unknown;
  processingEndTime?: unknown;
  marketplaceIds?: unknown;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Capture one already-existing DONE Amazon GET_MERCHANT_LISTINGS_ALL_DATA report.\n" +
      "Required: --store-index 1..5 --report-id ID --out-dir /ABS/NEW\n" +
      "This command performs no Amazon report-create call and no marketplace mutation.",
    );
    return;
  }
  if (args.some((arg) => arg.startsWith("--")
    && !["--store-index", "--report-id", "--out-dir"].includes(arg))) {
    fail("unknown argument");
  }

  const storeIndex = Number(exactArg(args, "--store-index"));
  if (!Number.isInteger(storeIndex) || storeIndex < 1 || storeIndex > 5) {
    fail("--store-index must be an integer from 1 to 5");
  }
  const reportId = exactArg(args, "--report-id");
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(reportId)) fail("--report-id is invalid");
  const outDir = exactArg(args, "--out-dir");
  if (!isAbsolute(outDir) || normalize(outDir) !== outDir) {
    fail("--out-dir must be one normalized absolute path");
  }
  const parent = dirname(outDir);
  if (await realpath(parent) !== parent || !(await stat(parent)).isDirectory()) {
    fail("--out-dir parent must be one existing real directory");
  }
  await assertAbsent(outDir);
  const storeId = `store${storeIndex}`;
  const detail = await spApiGet(
    `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    { storeId, retries: 1 },
  ) as ReportDetail;
  if (detail.reportId !== reportId) fail("Amazon reportId does not match the request");
  if (detail.reportType !== REPORT_TYPE) fail("Amazon report type is not All Listings");
  if (detail.processingStatus !== "DONE") fail("Amazon report is not DONE");
  if (typeof detail.reportDocumentId !== "string" || !detail.reportDocumentId) {
    fail("Amazon DONE report has no document id");
  }
  if (!Array.isArray(detail.marketplaceIds)
    || !detail.marketplaceIds.includes(MARKETPLACE_ID)) {
    fail("Amazon report is not bound to the US marketplace");
  }

  const content = await downloadReport(
    await getReportDocumentUrl(storeId, detail.reportDocumentId),
  );
  const reportBytes = Buffer.from(content, "utf8");
  if (reportBytes.length < 1 || reportBytes.length > MAX_REPORT_BYTES) {
    fail("Amazon report byte length is outside the allowed range");
  }
  const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);
  const header = lines[0] ?? "";
  if (header.split("\t").length !== 29) fail("Amazon All Listings header is unexpected");

  const rawName = `amazon-${storeId}-${REPORT_TYPE}.tsv`;
  const capturedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: RECEIPT_VERSION,
    capturedAt,
    source: {
      api: "Amazon SP-API Reports 2021-06-30",
      access: "EXISTING_REPORT_GET_ONLY",
      reportCreateCalls: 0,
      marketplaceMutations: 0,
    },
    scope: { storeId, storeIndex, marketplaceId: MARKETPLACE_ID },
    report: {
      reportType: REPORT_TYPE,
      reportId,
      createdTime: canonicalInstant(detail.createdTime, "createdTime"),
      processingStartTime: canonicalInstant(detail.processingStartTime, "processingStartTime"),
      processingEndTime: canonicalInstant(detail.processingEndTime, "processingEndTime"),
      processingStatus: "DONE",
    },
    artifact: {
      sourceName: basename(rawPath),
      contentSha256: sha256(reportBytes),
      byteLength: reportBytes.length,
      headerSha256: sha256(header),
      headerColumns: 29,
      dataRows: Math.max(0, lines.length - 1),
    },
  };
  const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  const temporaryDirectory = join(
    parent,
    `.${basename(outDir)}.tmp-${randomUUID()}`,
  );
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    if (await realpath(temporaryDirectory) !== temporaryDirectory) {
      fail("temporary output must not use a symlink alias");
    }
    await writeExclusive(join(temporaryDirectory, rawName), reportBytes);
    await writeExclusive(
      join(temporaryDirectory, "capture-receipt.json"),
      receiptBytes,
    );
    await writeExclusive(
      join(temporaryDirectory, "capture.sha256"),
      Buffer.from(
        `${sha256(reportBytes)}  ${rawName}\n${sha256(receiptBytes)}  capture-receipt.json\n`,
        "utf8",
      ),
    );
    await assertAbsent(outDir);
    await rename(temporaryDirectory, outDir);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({
    status: "CAPTURED_EXISTING_REPORT",
    outDir: resolve(outDir),
    storeId,
    reportId,
    reportCreateCalls: 0,
    contentSha256: receipt.artifact.contentSha256,
    dataRows: receipt.artifact.dataRows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
