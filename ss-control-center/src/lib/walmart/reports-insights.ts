/**
 * Walmart on-request Insights reports — Buy Box + Item Performance.
 *
 * These are ASYNC reports (not the synchronous recon reports in reports.ts):
 *
 *   1. POST /v3/reports/reportRequests?reportType={BUYBOX|ITEM_PERFORMANCE}&reportVersion=v1
 *      (Content-Type: application/json REQUIRED even with an empty {} body)
 *      → { requestId, requestSubmissionDate }
 *   2. GET  /v3/reports/reportRequests/{requestId}
 *      → { requestStatus: RECEIVED|SUBMITTED|INPROGRESS|READY|ERROR, ... }
 *   3. GET  /v3/reports/downloadReport?requestId={requestId}
 *      → { downloadURL, downloadURLExpirationTime }   (URL is pre-signed, no auth)
 *
 * Generation takes 15-45 min, and the /reports endpoint has a TINY rate bucket
 * (immediate 429 REQUEST_THRESHOLD_VIOLATED when hammered). So the cron drives
 * a state machine across runs (request → poll → download) rather than blocking.
 *
 * Buy Box report columns (no filters — you get all columns):
 *   SKU, Item ID, Product Name, Product Category,
 *   Seller Item Price, Seller Ship Price,
 *   isSellerBuyBoxWinner (Yes/No), BuyBox Item Price, BuyBox Ship Price
 */

import { gunzipSync, inflateRawSync } from "zlib";
import type { WalmartClient } from "./client";

export type InsightsReportType = "BUYBOX" | "ITEM_PERFORMANCE";

/** Custom error so the cron can detect rate-limit and back off vs. hard-fail. */
export class ReportRateLimitedError extends Error {
  constructor() {
    super("Walmart /reports rate bucket exhausted (REQUEST_THRESHOLD_VIOLATED)");
    this.name = "ReportRateLimitedError";
  }
}

/** Request a fresh report. Returns the requestId to poll. */
export async function requestReport(
  client: WalmartClient,
  reportType: InsightsReportType
): Promise<string> {
  const res = await client.requestRaw("POST", "/reports/reportRequests", {
    params: { reportType, reportVersion: "v1" },
    body: {},
    headers: { "Content-Type": "application/json" },
    noRetryOn429: true, // fail fast → caller defers to next tick (tiny rate bucket)
  });
  if (res.status === 429) throw new ReportRateLimitedError();
  if (!res.ok) {
    throw new Error(
      `requestReport ${reportType} ${res.status}: ${stringify(res.body)}`
    );
  }
  const b = res.body as { requestId?: string; requestID?: string };
  const id = b?.requestId ?? b?.requestID;
  if (!id) throw new Error(`requestReport ${reportType}: no requestId in ${stringify(res.body)}`);
  return id;
}

export interface ReportStatus {
  status: "RECEIVED" | "SUBMITTED" | "INPROGRESS" | "READY" | "ERROR" | string;
  raw: unknown;
}

export async function getReportStatus(
  client: WalmartClient,
  requestId: string
): Promise<ReportStatus> {
  const res = await client.requestRaw("GET", `/reports/reportRequests/${requestId}`, { noRetryOn429: true });
  if (res.status === 429) throw new ReportRateLimitedError();
  if (!res.ok) {
    throw new Error(`getReportStatus ${requestId} ${res.status}: ${stringify(res.body)}`);
  }
  const b = res.body as Record<string, unknown> | undefined;
  const nested = b?.reportRequest as Record<string, unknown> | undefined;
  const status = String(
    b?.requestStatus ?? b?.status ?? nested?.requestStatus ?? "UNKNOWN"
  ).toUpperCase();
  return { status, raw: res.body };
}

/** Get the pre-signed download URL once the report is READY. */
export async function getReportDownloadUrl(
  client: WalmartClient,
  requestId: string
): Promise<string> {
  // Walmart docs disagree on the param casing (requestId vs requestID); try both.
  for (const key of ["requestId", "requestID"] as const) {
    const res = await client.requestRaw("GET", "/reports/downloadReport", {
      params: { [key]: requestId },
      noRetryOn429: true,
    });
    if (res.status === 429) throw new ReportRateLimitedError();
    if (res.status === 400 || res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`getReportDownloadUrl ${requestId} ${res.status}: ${stringify(res.body)}`);
    }
    const b = res.body as { downloadURL?: string; downloadUrl?: string } | string;
    const url = typeof b === "string" ? b : b?.downloadURL ?? b?.downloadUrl;
    if (url) return url;
  }
  throw new Error(`getReportDownloadUrl ${requestId}: no downloadURL returned`);
}

/**
 * Fetch the pre-signed report file and return its text. Walmart serves these
 * gzipped, zipped, or plain depending on report — detect by magic bytes.
 * (zip is rare for these two; if we hit it we surface a clear error so we can
 * add a zip dep only if actually needed.)
 */
export async function fetchReportText(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`download ${res.status} from pre-signed URL`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString("utf8"); // gzip
  }
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return unzipFirstFile(buf); // ZIP archive (Buy Box reports ship as ZIP'd CSV)
  }
  return buf.toString("utf8"); // plain CSV / TSV
}

/**
 * Extract the first file from a single-entry ZIP using only Node's built-in
 * zlib (no dep). Reads the central directory for reliable sizes/offsets, then
 * inflates (deflate, method 8) or returns stored (method 0) bytes. Walmart
 * Insights report archives contain one CSV, so first-entry is enough.
 */
function unzipFirstFile(buf: Buffer): string {
  // Find End Of Central Directory record (PK\x05\x06), scanning from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: no End-Of-Central-Directory record");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("ZIP: no central directory entry");

  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP: bad local file header");
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);

  if (method === 0) return data.toString("utf8"); // stored
  if (method === 8) return inflateRawSync(data).toString("utf8"); // deflate
  throw new Error(`ZIP: unsupported compression method ${method}`);
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Minimal RFC-4180-ish parser (handles quoted fields + embedded commas). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = splitRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length === 1 && cells[0] === "") continue; // blank line
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) rec[header[c]] = (cells[c] ?? "").trim();
    out.push(rec);
  }
  return out;
}

function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Case/space-insensitive column lookup against a parsed CSV row. */
export function col(rec: Record<string, string>, ...names: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(rec)) map.set(norm(k), v);
  for (const n of names) {
    const v = map.get(norm(n));
    if (v !== undefined) return v;
  }
  return undefined;
}

function stringify(body: unknown): string {
  if (body == null) return "(empty)";
  if (typeof body === "string") return body.slice(0, 300);
  try { return JSON.stringify(body).slice(0, 300); } catch { return String(body); }
}
