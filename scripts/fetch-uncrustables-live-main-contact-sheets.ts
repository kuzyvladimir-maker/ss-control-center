/**
 * Fetch and seal the exact live.main_image_url bytes from an explicit,
 * SHA-pinned Uncrustables ledger, then build recipe-labelled contact sheets.
 *
 * Safety boundaries:
 * - public image GETs only; no Amazon API, Prisma, DB, or R2 client/import
 * - default mode is an offline preflight (zero network and zero writes)
 * - network mode requires both --execute-network and an exact confirmation
 * - exactly 164 fetched ledger rows are required; there is no limit/SKU subset
 * - success manifest is written last and only after every row and sheet passes
 *
 * Usage:
 *   npx tsx scripts/fetch-uncrustables-live-main-contact-sheets.ts \
 *     --ledger=data/audits/uncrustables-ledger-....json \
 *     --ledger-sha256=<64-hex-sha> \
 *     --reviewed-overrides=data/repairs/uncrustables-reviewed-overrides-20260717.json \
 *     --reviewed-overrides-sha256=<64-hex-sha> \
 *     --output-dir=data/audits/uncrustables-live-main-fetch-YYYYMMDD \
 *     --execute-network \
 *     --confirm=FETCH_UNCRUSTABLES_LIVE_MAIN_BYTES
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  DEFAULT_LIVE_MAIN_HOSTS,
  UNCRUSTABLES_LIVE_MAIN_EXPECTED_ROWS,
  applyReviewedTotalOverrides,
  assertAllowedLiveMainUrl,
  extensionForSharpFormat,
  isRetryableHttpStatus,
  parseRetryAfterMs,
  retryBackoffMs,
  safeFilePart,
  sealManifestBody,
  selectSealedLiveMainTargets,
  sha256,
  type LiveMainFetchTarget,
// @ts-expect-error -- explicit .ts supports tsx and Node's native type-stripping loader.
} from "../src/lib/bundle-factory/audit/uncrustables-live-main-contact-sheets.ts";

const CONFIRM = "FETCH_UNCRUSTABLES_LIVE_MAIN_BYTES";
const TILE_WIDTH = 520;
const IMAGE_SIZE = 480;
const LABEL_HEIGHT = 190;
const TILE_HEIGHT = IMAGE_SIZE + LABEL_HEIGHT;

interface Options {
  ledger: string;
  ledgerSha256: string;
  reviewedOverrides: string;
  reviewedOverridesSha256: string;
  outputDir: string;
  executeNetwork: boolean;
  confirm: string | null;
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
  maxBytes: number;
  retryBaseMs: number;
  maxRedirects: number;
  columns: number;
  rows: number;
}

interface RedirectRecord {
  status: number;
  from: string;
  to: string;
}

interface AttemptRecord {
  attempt: number;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  outcome: "SUCCEEDED" | "RETRY" | "FAILED";
  status: number | null;
  request_count: number;
  redirect_count: number;
  error: string | null;
  retry_delay_ms: number | null;
}

interface HttpImageResult {
  bytes: Buffer;
  requested_url: string;
  final_url: string;
  redirects: RedirectRecord[];
  status: number;
  fetched_at: string;
  etag: string | null;
  last_modified: string | null;
  content_type: string;
  content_length_header: number | null;
  cache_control: string | null;
  content_encoding: string | null;
  request_count: number;
}

interface FetchedRowRecord {
  ordinal: number;
  ledger_row_index: number;
  sku: string;
  asin: string;
  title: string | null;
  canonical_total_units: number;
  reviewed_total_units: number | null;
  effective_total_units: number;
  total_units_source: LiveMainFetchTarget["total_units_source"];
  recipe_components: LiveMainFetchTarget["recipe_components"];
  requested_main_image_url: string;
  http: Omit<HttpImageResult, "bytes"> & {
    attempts: number;
    attempt_history: AttemptRecord[];
  };
  asset: {
    local_path: string;
    sha256: string;
    bytes: number;
    content_type: string;
    format: string;
    width: number;
    height: number;
    pages: number;
    has_alpha: boolean;
    orientation: number | null;
  };
}

interface DownloadedRow {
  record: FetchedRowRecord;
  absoluteAssetPath: string;
}

interface DownloadFailure {
  ordinal: number;
  sku: string;
  asin: string;
  url: string;
  error: string;
  attempt_history: AttemptRecord[];
}

interface ContactSheetRecord {
  sheet_number: number;
  local_path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  tiles: Array<{
    asset_sha256: string;
    representative_local_asset: string;
    mappings: Array<{
      ordinal: number;
      sku: string;
      asin: string;
      canonical_total_units: number;
      reviewed_total_units: number | null;
      effective_total_units: number;
      total_units_source: LiveMainFetchTarget["total_units_source"];
      recipe_components: LiveMainFetchTarget["recipe_components"];
    }>;
  }>;
}

class FetchAttemptError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly requestCount: number;
  readonly redirects: RedirectRecord[];

  constructor(
    message: string,
    details: {
      retryable: boolean;
      status?: number | null;
      retryAfterMs?: number | null;
      requestCount?: number;
      redirects?: RedirectRecord[];
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "FetchAttemptError";
    this.retryable = details.retryable;
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.requestCount = details.requestCount ?? 0;
    this.redirects = details.redirects ?? [];
  }
}

class ExhaustedFetchError extends Error {
  readonly attemptHistory: AttemptRecord[];

  constructor(message: string, attemptHistory: AttemptRecord[]) {
    super(message);
    this.name = "ExhaustedFetchError";
    this.attemptHistory = attemptHistory;
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/fetch-uncrustables-live-main-contact-sheets.ts \\",
    "    --ledger=SEALED_LEDGER.json \\",
    "    --ledger-sha256=<64-hex> \\",
    "    --reviewed-overrides=SEALED_OVERRIDES.json \\",
    "    --reviewed-overrides-sha256=<64-hex> \\",
    "    --output-dir=NEW_DIRECTORY [options]",
    "",
    "Default: offline preflight only (no network, no writes).",
    "Network execution additionally requires:",
    "  --execute-network --confirm=FETCH_UNCRUSTABLES_LIVE_MAIN_BYTES",
    "",
    "Options:",
    "  --concurrency=4       1-8 concurrent rows",
    "  --max-attempts=3      1-5 attempts per row",
    "  --timeout-ms=45000    5000-120000 ms per attempt",
    "  --max-bytes=26214400  1048576-52428800 bytes per image",
    "  --retry-base-ms=750   100-10000 ms exponential-backoff base",
    "  --max-redirects=3     0-5 HTTPS allow-listed redirects",
    "  --columns=4           1-6 contact-sheet columns",
    "  --rows=3              1-6 contact-sheet rows",
  ].join("\n");
}

function boundedInteger(
  flag: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    ledger: "",
    ledgerSha256: "",
    reviewedOverrides: "",
    reviewedOverridesSha256: "",
    outputDir: "",
    executeNetwork: false,
    confirm: null,
    concurrency: 4,
    maxAttempts: 3,
    timeoutMs: 45_000,
    maxBytes: 25 * 1024 * 1024,
    retryBaseMs: 750,
    maxRedirects: 3,
    columns: 4,
    rows: 3,
  };
  for (const arg of argv) {
    if (arg.startsWith("--ledger=")) options.ledger = arg.slice(9).trim();
    else if (arg.startsWith("--ledger-sha256=")) {
      options.ledgerSha256 = arg.slice(16).trim().toLowerCase();
    } else if (arg.startsWith("--reviewed-overrides=")) {
      options.reviewedOverrides = arg.slice(21).trim();
    } else if (arg.startsWith("--reviewed-overrides-sha256=")) {
      options.reviewedOverridesSha256 = arg.slice(28).trim().toLowerCase();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice(13).trim();
    } else if (arg === "--execute-network") options.executeNetwork = true;
    else if (arg.startsWith("--confirm=")) options.confirm = arg.slice(10).trim();
    else if (arg.startsWith("--concurrency=")) {
      options.concurrency = boundedInteger("--concurrency", arg.slice(14), 1, 8);
    } else if (arg.startsWith("--max-attempts=")) {
      options.maxAttempts = boundedInteger("--max-attempts", arg.slice(15), 1, 5);
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = boundedInteger("--timeout-ms", arg.slice(13), 5_000, 120_000);
    } else if (arg.startsWith("--max-bytes=")) {
      options.maxBytes = boundedInteger("--max-bytes", arg.slice(12), 1_048_576, 52_428_800);
    } else if (arg.startsWith("--retry-base-ms=")) {
      options.retryBaseMs = boundedInteger("--retry-base-ms", arg.slice(16), 100, 10_000);
    } else if (arg.startsWith("--max-redirects=")) {
      options.maxRedirects = boundedInteger("--max-redirects", arg.slice(16), 0, 5);
    } else if (arg.startsWith("--columns=")) {
      options.columns = boundedInteger("--columns", arg.slice(10), 1, 6);
    } else if (arg.startsWith("--rows=")) {
      options.rows = boundedInteger("--rows", arg.slice(7), 1, 6);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.ledger) throw new Error("--ledger=PATH is required");
  if (!/^[a-f0-9]{64}$/.test(options.ledgerSha256)) {
    throw new Error("--ledger-sha256 must be an explicit 64-character lowercase hex digest");
  }
  if (!options.reviewedOverrides) {
    throw new Error("--reviewed-overrides=PATH is required");
  }
  if (!/^[a-f0-9]{64}$/.test(options.reviewedOverridesSha256)) {
    throw new Error(
      "--reviewed-overrides-sha256 must be an explicit 64-character lowercase hex digest",
    );
  }
  if (!options.outputDir) throw new Error("--output-dir=NEW_DIRECTORY is required");
  if (options.executeNetwork && options.confirm !== CONFIRM) {
    throw new Error(`Network execution requires --confirm=${CONFIRM}`);
  }
  if (!options.executeNetwork && options.confirm != null) {
    throw new Error("--confirm is valid only with --execute-network");
  }
  return options;
}

function stamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const claimed = Number(lengthHeader);
    if (Number.isFinite(claimed) && claimed > maxBytes) {
      throw new FetchAttemptError(
        `Content-Length ${claimed} exceeds --max-bytes=${maxBytes}`,
        { retryable: false, status: response.status },
      );
    }
  }
  if (!response.body) {
    throw new FetchAttemptError("Image response has no body", {
      retryable: true,
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel("image exceeds configured byte limit");
        throw new FetchAttemptError(
          `Response body exceeds --max-bytes=${maxBytes}`,
          { retryable: false, status: response.status },
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof FetchAttemptError) throw error;
    throw new FetchAttemptError(`Failed while reading image body: ${errorMessage(error)}`, {
      retryable: true,
      status: response.status,
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new FetchAttemptError("Image response body is empty", {
      retryable: true,
      status: response.status,
    });
  }
  return Buffer.concat(chunks, total);
}

async function fetchImageOnce(
  requestedUrl: string,
  options: Pick<Options, "timeoutMs" | "maxBytes" | "maxRedirects">,
): Promise<HttpImageResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`GET timed out after ${options.timeoutMs} ms`)),
    options.timeoutMs,
  );
  let currentUrl = requestedUrl;
  let requestCount = 0;
  const redirects: RedirectRecord[] = [];
  try {
    while (true) {
      assertAllowedLiveMainUrl(currentUrl, DEFAULT_LIVE_MAIN_HOSTS);
      let response: Response;
      try {
        requestCount += 1;
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
            "accept-encoding": "identity",
            "cache-control": "no-cache",
            "user-agent": "SS-Command-Center-Uncrustables-Live-Main-Forensics/1.0",
          },
        });
      } catch (error) {
        throw new FetchAttemptError(`GET failed: ${errorMessage(error)}`, {
          retryable: true,
          requestCount,
          redirects,
          cause: error,
        });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects.length >= options.maxRedirects) {
          throw new FetchAttemptError(
            `Redirect limit ${options.maxRedirects} exceeded`,
            { retryable: false, status: response.status, requestCount, redirects },
          );
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new FetchAttemptError("Redirect response has no Location header", {
            retryable: false,
            status: response.status,
            requestCount,
            redirects,
          });
        }
        const nextUrl = new URL(location, currentUrl).toString();
        assertAllowedLiveMainUrl(nextUrl, DEFAULT_LIVE_MAIN_HOSTS);
        redirects.push({ status: response.status, from: currentUrl, to: nextUrl });
        currentUrl = nextUrl;
        continue;
      }

      if (response.status !== 200) {
        const retryable = isRetryableHttpStatus(response.status);
        throw new FetchAttemptError(`HTTP ${response.status} for ${currentUrl}`, {
          retryable,
          status: response.status,
          retryAfterMs: retryable
            ? parseRetryAfterMs(response.headers.get("retry-after"))
            : null,
          requestCount,
          redirects,
        });
      }

      const rawContentType = response.headers.get("content-type") ?? "";
      const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        throw new FetchAttemptError(
          `Expected image Content-Type, received ${rawContentType || "<missing>"}`,
          { retryable: false, status: response.status, requestCount, redirects },
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedBody(response, options.maxBytes);
      } catch (error) {
        if (error instanceof FetchAttemptError) {
          throw new FetchAttemptError(error.message, {
            retryable: error.retryable,
            status: error.status,
            retryAfterMs: error.retryAfterMs,
            requestCount,
            redirects,
            cause: error,
          });
        }
        throw error;
      }
      const lengthHeader = response.headers.get("content-length");
      const parsedLength = lengthHeader == null ? null : Number(lengthHeader);
      return {
        bytes,
        requested_url: requestedUrl,
        final_url: currentUrl,
        redirects,
        status: response.status,
        fetched_at: new Date().toISOString(),
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        content_type: contentType,
        content_length_header:
          parsedLength != null && Number.isSafeInteger(parsedLength)
            ? parsedLength
            : null,
        cache_control: response.headers.get("cache-control"),
        content_encoding: response.headers.get("content-encoding"),
        request_count: requestCount,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchImageWithRetry(
  target: LiveMainFetchTarget,
  options: Pick<
    Options,
    "timeoutMs" | "maxBytes" | "maxRedirects" | "maxAttempts" | "retryBaseMs"
  >,
): Promise<{
  result: HttpImageResult;
  attemptHistory: AttemptRecord[];
}> {
  const attemptHistory: AttemptRecord[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const startedAt = new Date();
    const startedMonotonic = performance.now();
    try {
      const result = await fetchImageOnce(target.main_image_url, options);
      attemptHistory.push({
        attempt,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        elapsed_ms: elapsedMs(startedMonotonic),
        outcome: "SUCCEEDED",
        status: result.status,
        request_count: result.request_count,
        redirect_count: result.redirects.length,
        error: null,
        retry_delay_ms: null,
      });
      return { result, attemptHistory };
    } catch (error) {
      const fetchError =
        error instanceof FetchAttemptError
          ? error
          : new FetchAttemptError(errorMessage(error), {
              retryable: false,
              cause: error,
            });
      const willRetry = fetchError.retryable && attempt < options.maxAttempts;
      const delay = willRetry
        ? fetchError.retryAfterMs ??
          retryBackoffMs(attempt, options.retryBaseMs)
        : null;
      attemptHistory.push({
        attempt,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        elapsed_ms: elapsedMs(startedMonotonic),
        outcome: willRetry ? "RETRY" : "FAILED",
        status: fetchError.status,
        request_count: fetchError.requestCount,
        redirect_count: fetchError.redirects.length,
        error: fetchError.message,
        retry_delay_ms: delay,
      });
      if (!willRetry) {
        throw new ExhaustedFetchError(
          `${target.sku}/${target.asin}: ${fetchError.message}`,
          attemptHistory,
        );
      }
      console.warn(
        `[${target.ordinal}/${UNCRUSTABLES_LIVE_MAIN_EXPECTED_ROWS}] ${target.sku}: ` +
          `retry ${attempt + 1}/${options.maxAttempts} in ${delay} ms (${fetchError.message})`,
      );
      await sleep(delay ?? 0);
    }
  }
  throw new ExhaustedFetchError(
    `${target.sku}/${target.asin}: exhausted retry loop`,
    attemptHistory,
  );
}

async function writeExclusiveBuffer(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertContentTypeMatchesFormat(contentType: string, format: string): void {
  const expected = new Map<string, Set<string>>([
    ["image/jpeg", new Set(["jpeg"])],
    ["image/jpg", new Set(["jpeg"])],
    ["image/pjpeg", new Set(["jpeg"])],
    ["image/png", new Set(["png"])],
    ["image/webp", new Set(["webp"])],
    ["image/gif", new Set(["gif"])],
    ["image/avif", new Set(["avif", "heif"])],
    ["image/heif", new Set(["heif"])],
    ["image/tiff", new Set(["tiff"])],
  ]).get(contentType);
  if (expected && !expected.has(format)) {
    throw new Error(`Content-Type ${contentType} disagrees with decoded format ${format}`);
  }
}

async function downloadOne(
  target: LiveMainFetchTarget,
  assetsDir: string,
  outputDir: string,
  options: Options,
): Promise<DownloadedRow> {
  const { result, attemptHistory } = await fetchImageWithRetry(target, options);
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(result.bytes, { failOn: "error" }).metadata();
  } catch (error) {
    throw new ExhaustedFetchError(
      `${target.sku}/${target.asin}: downloaded bytes are not a decodable image: ${errorMessage(error)}`,
      attemptHistory,
    );
  }
  if (
    !metadata.format ||
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    (metadata.width ?? 0) < 1 ||
    (metadata.height ?? 0) < 1
  ) {
    throw new ExhaustedFetchError(
      `${target.sku}/${target.asin}: image metadata lacks format/dimensions`,
      attemptHistory,
    );
  }
  try {
    assertContentTypeMatchesFormat(result.content_type, metadata.format);
  } catch (error) {
    throw new ExhaustedFetchError(
      `${target.sku}/${target.asin}: ${errorMessage(error)}`,
      attemptHistory,
    );
  }

  const digest = sha256(result.bytes);
  const extension = extensionForSharpFormat(metadata.format);
  if (extension === "img") {
    throw new ExhaustedFetchError(
      `${target.sku}/${target.asin}: unsupported decoded image format ${metadata.format}`,
      attemptHistory,
    );
  }
  const name =
    `${String(target.ordinal).padStart(3, "0")}-` +
    `${safeFilePart(target.sku)}-${target.asin}-${digest.slice(0, 12)}.${extension}`;
  const absoluteAssetPath = path.join(assetsDir, name);
  await writeExclusiveBuffer(absoluteAssetPath, result.bytes);

  const localPath = path.relative(outputDir, absoluteAssetPath);
  const httpEvidence: Omit<HttpImageResult, "bytes"> = {
    requested_url: result.requested_url,
    final_url: result.final_url,
    redirects: result.redirects,
    status: result.status,
    fetched_at: result.fetched_at,
    etag: result.etag,
    last_modified: result.last_modified,
    content_type: result.content_type,
    content_length_header: result.content_length_header,
    cache_control: result.cache_control,
    content_encoding: result.content_encoding,
    request_count: result.request_count,
  };
  return {
    absoluteAssetPath,
    record: {
      ordinal: target.ordinal,
      ledger_row_index: target.ledger_row_index,
      sku: target.sku,
      asin: target.asin,
      title: target.title,
      canonical_total_units: target.canonical_total_units,
      reviewed_total_units: target.reviewed_total_units,
      effective_total_units: target.effective_total_units,
      total_units_source: target.total_units_source,
      recipe_components: target.recipe_components,
      requested_main_image_url: target.main_image_url,
      http: {
        ...httpEvidence,
        attempts: attemptHistory.length,
        attempt_history: attemptHistory,
      },
      asset: {
        local_path: localPath,
        sha256: digest,
        bytes: result.bytes.length,
        content_type: result.content_type,
        format: metadata.format,
        width: metadata.width as number,
        height: metadata.height as number,
        pages: metadata.pages ?? 1,
        has_alpha: metadata.hasAlpha ?? false,
        orientation: metadata.orientation ?? null,
      },
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compactProductName(value: string): string {
  return value
    .replace(/Smucker(?:'s|s)?\s+Uncrustables/gi, "")
    .replace(/\bFrozen\b/gi, "")
    .replace(/\bSandwich(?:es)?\b/gi, "")
    .replace(/\s+-\s+\d+(?:\.\d+)?\s*(?:oz|ct).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recipeLabel(row: FetchedRowRecord): string {
  return row.recipe_components
    .map((component) => {
      const identity = compactProductName(component.flavor ?? component.product_name);
      return `${component.qty}× ${identity}`;
    })
    .join(" + ");
}

function totalLabel(row: FetchedRowRecord): string {
  if (
    row.reviewed_total_units != null &&
    row.reviewed_total_units !== row.canonical_total_units
  ) {
    return `ledger C${row.canonical_total_units} → reviewed C${row.reviewed_total_units}`;
  }
  return `${row.total_units_source === "HIGH_REVIEWED_OVERRIDE" ? "reviewed" : "canonical"} C${row.effective_total_units}`;
}

function wrapText(value: string, width: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let consumed = 0;
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      consumed += 1;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maxLines) break;
    current = word;
    consumed += 1;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (consumed < words.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[. ]+$/, "")}…`;
  }
  return lines;
}

interface VisualAssetGroup {
  sha256: string;
  representative: DownloadedRow;
  mappings: DownloadedRow[];
}

function groupByExactHash(rows: DownloadedRow[]): VisualAssetGroup[] {
  const groups = new Map<string, VisualAssetGroup>();
  for (const row of rows) {
    const key = row.record.asset.sha256;
    const group = groups.get(key) ?? {
      sha256: key,
      representative: row,
      mappings: [],
    };
    group.mappings.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.representative.record.ordinal - right.representative.record.ordinal,
  );
}

function groupLabelSvg(group: VisualAssetGroup): Buffer {
  const uniqueRecipes = [
    ...new Set(
      group.mappings.map(
        ({ record }) => `${totalLabel(record)}: ${recipeLabel(record)}`,
      ),
    ),
  ];
  const skuText = group.mappings.map(({ record }) => record.sku).join(", ");
  const asinText = group.mappings.map(({ record }) => record.asin).join(", ");
  const lines = [
    `${group.sha256.slice(0, 12)} | ${group.mappings.length} listing${group.mappings.length === 1 ? "" : "s"}`,
    ...uniqueRecipes.flatMap((recipe) => wrapText(recipe, 66, 2)).slice(0, 3),
    ...wrapText(`SKU: ${skuText}`, 66, 1),
    ...wrapText(`ASIN: ${asinText}`, 66, 1),
  ].slice(0, 6);
  if (uniqueRecipes.length > 3 && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]} (+more in manifest)`;
  }
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="14" y="${28 + index * 28}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${TILE_WIDTH}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#f4f6f4"/>` +
      `<text font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#102018">${tspans}</text>` +
      `</svg>`,
  );
}

async function buildTile(group: VisualAssetGroup): Promise<Buffer> {
  const image = await readFile(group.representative.absoluteAssetPath);
  const actual = sha256(image);
  if (actual !== group.sha256) {
    throw new Error(
      `Local asset SHA changed for ${group.representative.record.sku}: ${actual} != ${group.sha256}`,
    );
  }
  const resized = await sharp(image, { failOn: "error" })
    .rotate()
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "contain", background: "white" })
    .extend({
      top: 0,
      bottom: 0,
      left: (TILE_WIDTH - IMAGE_SIZE) / 2,
      right: (TILE_WIDTH - IMAGE_SIZE) / 2,
      background: "white",
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      channels: 3,
      background: "white",
    },
  })
    .composite([
      { input: resized, left: 0, top: 0 },
      { input: groupLabelSvg(group), left: 0, top: IMAGE_SIZE },
    ])
    .png()
    .toBuffer();
}

async function buildContactSheets(
  rows: DownloadedRow[],
  sheetsDir: string,
  outputDir: string,
  options: Pick<Options, "columns" | "rows">,
): Promise<ContactSheetRecord[]> {
  const groups = groupByExactHash(rows);
  const perSheet = options.columns * options.rows;
  const sheets: ContactSheetRecord[] = [];
  for (let offset = 0; offset < groups.length; offset += perSheet) {
    const group = groups.slice(offset, offset + perSheet);
    const tiles: Buffer[] = [];
    for (const asset of group) tiles.push(await buildTile(asset));
    const width = options.columns * TILE_WIDTH;
    const height = options.rows * TILE_HEIGHT;
    const sheet = await sharp({
      create: { width, height, channels: 3, background: "white" },
    })
      .composite(
        tiles.map((input, index) => ({
          input,
          left: (index % options.columns) * TILE_WIDTH,
          top: Math.floor(index / options.columns) * TILE_HEIGHT,
        })),
      )
      .png()
      .toBuffer();
    const sheetNumber = sheets.length + 1;
    const name = `live-main-contact-sheet-${String(sheetNumber).padStart(2, "0")}.png`;
    const absolutePath = path.join(sheetsDir, name);
    await writeExclusiveBuffer(absolutePath, sheet);
    sheets.push({
      sheet_number: sheetNumber,
      local_path: path.relative(outputDir, absolutePath),
      sha256: sha256(sheet),
      bytes: sheet.length,
      width,
      height,
      tiles: group.map((asset) => ({
        asset_sha256: asset.sha256,
        representative_local_asset: asset.representative.record.asset.local_path,
        mappings: asset.mappings.map(({ record }) => ({
          ordinal: record.ordinal,
          sku: record.sku,
          asin: record.asin,
          canonical_total_units: record.canonical_total_units,
          reviewed_total_units: record.reviewed_total_units,
          effective_total_units: record.effective_total_units,
          total_units_source: record.total_units_source,
          recipe_components: record.recipe_components,
        })),
      })),
    });
  }
  return sheets;
}

async function outputDirectoryMustNotExist(outputDir: string): Promise<void> {
  try {
    await stat(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`--output-dir must not already exist: ${outputDir}`);
}

async function writeSealedJson(
  outputPath: string,
  body: Record<string, unknown>,
): Promise<{ bodySha256: string; fileSha256: string }> {
  const manifest = { ...body, body_sha256: sealManifestBody(body) };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const tempPath = `${outputPath}.${randomUUID()}.tmp`;
  await writeExclusiveBuffer(tempPath, bytes);
  const fileSha = sha256(bytes);
  await writeExclusiveBuffer(
    `${outputPath}.sha256`,
    Buffer.from(`${fileSha}  ${path.basename(outputPath)}\n`, "utf8"),
  );
  await rename(tempPath, outputPath);
  return { bodySha256: manifest.body_sha256, fileSha256: fileSha };
}

async function downloadAll(
  targets: LiveMainFetchTarget[],
  assetsDir: string,
  outputDir: string,
  options: Options,
): Promise<{ successes: DownloadedRow[]; failures: DownloadFailure[] }> {
  const successes = new Array<DownloadedRow | undefined>(targets.length);
  const failures: DownloadFailure[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const target = targets[index];
      try {
        const downloaded = await downloadOne(target, assetsDir, outputDir, options);
        successes[index] = downloaded;
        console.log(
          `[${target.ordinal}/${targets.length}] ${target.sku}/${target.asin} ` +
            `${downloaded.record.asset.width}x${downloaded.record.asset.height} ` +
            `${downloaded.record.asset.sha256.slice(0, 12)}`,
        );
      } catch (error) {
        failures.push({
          ordinal: target.ordinal,
          sku: target.sku,
          asin: target.asin,
          url: target.main_image_url,
          error: errorMessage(error),
          attempt_history:
            error instanceof ExhaustedFetchError ? error.attemptHistory : [],
        });
        console.error(
          `[${target.ordinal}/${targets.length}] FAILED ${target.sku}/${target.asin}: ${errorMessage(error)}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, targets.length) }, () => worker()),
  );
  return {
    successes: successes.filter((row): row is DownloadedRow => row != null),
    failures: failures.sort((left, right) => left.ordinal - right.ordinal),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = path.resolve(options.ledger);
  const reviewedOverridesPath = path.resolve(options.reviewedOverrides);
  const outputDir = path.resolve(options.outputDir);
  const ledgerBytes = await readFile(ledgerPath);
  const actualLedgerSha = sha256(ledgerBytes);
  if (actualLedgerSha !== options.ledgerSha256) {
    throw new Error(
      `Sealed ledger SHA mismatch: expected ${options.ledgerSha256}, actual ${actualLedgerSha}`,
    );
  }
  const ledger = JSON.parse(ledgerBytes.toString("utf8")) as unknown;
  const reviewedOverrideBytes = await readFile(reviewedOverridesPath);
  const actualReviewedOverridesSha = sha256(reviewedOverrideBytes);
  if (actualReviewedOverridesSha !== options.reviewedOverridesSha256) {
    throw new Error(
      `Reviewed override SHA mismatch: expected ${options.reviewedOverridesSha256}, ` +
        `actual ${actualReviewedOverridesSha}`,
    );
  }
  const reviewedOverrideManifest = JSON.parse(
    reviewedOverrideBytes.toString("utf8"),
  ) as unknown;
  const selectedIdentity = selectSealedLiveMainTargets(ledger);
  const overrideResult = applyReviewedTotalOverrides(
    selectedIdentity,
    reviewedOverrideManifest,
    actualLedgerSha,
  );
  const identity = overrideResult.identity;

  if (!options.executeNetwork) {
    console.log(
      JSON.stringify(
        {
          mode: "OFFLINE_PREFLIGHT",
          source_ledger: {
            path: ledgerPath,
            sha256: actualLedgerSha,
            schema_version: identity.schema_version,
            audit_id: identity.audit_id,
            marketplace_observed_at: identity.marketplace_observed_at,
          },
          reviewed_overrides: {
            path: reviewedOverridesPath,
            sha256: actualReviewedOverridesSha,
            applied_total_overrides: overrideResult.applied,
          },
          exact_targets: identity.targets.length,
          unique_skus: new Set(identity.targets.map((row) => row.sku)).size,
          unique_asins: new Set(identity.targets.map((row) => row.asin)).size,
          allowed_hosts: [...DEFAULT_LIVE_MAIN_HOSTS],
          planned_output_dir: outputDir,
          external_calls: 0,
          local_writes: 0,
          execute_requires: `--execute-network --confirm=${CONFIRM}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  await outputDirectoryMustNotExist(outputDir);
  // Parent must already exist. This prevents a typo from recursively creating a
  // broad, unexpected path; the explicit leaf directory is created once.
  await mkdir(outputDir);
  const assetsDir = path.join(outputDir, "assets");
  const sheetsDir = path.join(outputDir, "contact-sheets");
  await mkdir(assetsDir);
  await mkdir(sheetsDir);

  const startedAt = new Date();
  const runId = `ULMC-${stamp(startedAt)}-${actualLedgerSha.slice(0, 12)}`;
  const { successes, failures } = await downloadAll(
    identity.targets,
    assetsDir,
    outputDir,
    options,
  );

  const source = {
    path: ledgerPath,
    sha256: actualLedgerSha,
    schema_version: identity.schema_version,
    audit_id: identity.audit_id,
    marketplace_observed_at: identity.marketplace_observed_at,
    reviewed_overrides: {
      path: reviewedOverridesPath,
      sha256: actualReviewedOverridesSha,
      applied_total_overrides: overrideResult.applied,
    },
  };
  const policy = {
    expected_rows: UNCRUSTABLES_LIVE_MAIN_EXPECTED_ROWS,
    allowed_hosts: [...DEFAULT_LIVE_MAIN_HOSTS],
    concurrency: options.concurrency,
    max_attempts: options.maxAttempts,
    timeout_ms: options.timeoutMs,
    max_bytes: options.maxBytes,
    retry_base_ms: options.retryBaseMs,
    max_redirects: options.maxRedirects,
    contact_sheet_columns: options.columns,
    contact_sheet_rows: options.rows,
  };

  if (failures.length > 0 || successes.length !== identity.targets.length) {
    const failureBody = {
      schema_version: "uncrustables-live-main-fetch-failure/v1.0",
      immutable: true,
      status: "FAILED_CLOSED",
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      source_ledger: source,
      policy,
      summary: {
        expected: identity.targets.length,
        succeeded: successes.length,
        failed: failures.length,
        success_manifest_written: false,
        contact_sheets_written: 0,
      },
      safety: {
        public_image_gets_only: true,
        amazon_api_calls: 0,
        prisma_or_database_calls: 0,
        r2_calls_or_uploads: 0,
        marketplace_mutations: 0,
      },
      failures,
      succeeded_rows: successes.map((row) => row.record),
    };
    await writeSealedJson(path.join(outputDir, "failure-manifest.json"), failureBody);
    throw new Error(
      `Failed closed: ${failures.length} row(s) failed; no contact sheets or success manifest were written`,
    );
  }

  let sheets: ContactSheetRecord[];
  try {
    sheets = await buildContactSheets(
      successes,
      sheetsDir,
      outputDir,
      options,
    );
  } catch (error) {
    const failureBody = {
      schema_version: "uncrustables-live-main-fetch-failure/v1.0",
      immutable: true,
      status: "FAILED_CLOSED",
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      source_ledger: source,
      policy,
      summary: {
        expected: identity.targets.length,
        succeeded: successes.length,
        failed: 0,
        success_manifest_written: false,
        contact_sheet_stage_failed: true,
      },
      safety: {
        public_image_gets_only: true,
        amazon_api_calls: 0,
        prisma_or_database_calls: 0,
        r2_calls_or_uploads: 0,
        marketplace_mutations: 0,
      },
      error: errorMessage(error),
      succeeded_rows: successes.map((row) => row.record),
    };
    await writeSealedJson(path.join(outputDir, "failure-manifest.json"), failureBody);
    throw new Error(`Failed closed during contact-sheet build: ${errorMessage(error)}`);
  }

  const uniqueHashes = new Set(successes.map((row) => row.record.asset.sha256));
  const completedAt = new Date();
  const manifestBody = {
    schema_version: "uncrustables-live-main-contact-sheets/v1.0",
    immutable: true,
    status: "COMPLETE",
    run_id: runId,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    source_ledger: source,
    policy,
    summary: {
      expected: identity.targets.length,
      fetched: successes.length,
      failed: 0,
      unique_exact_image_hashes: uniqueHashes.size,
      duplicate_hash_mappings: successes.length - uniqueHashes.size,
      contact_sheets: sheets.length,
      total_http_get_requests: successes.reduce(
        (total, row) =>
          total +
          row.record.http.attempt_history.reduce(
            (attemptTotal, attempt) => attemptTotal + attempt.request_count,
            0,
          ),
        0,
      ),
    },
    safety: {
      public_image_gets_only: true,
      amazon_api_calls: 0,
      prisma_or_database_calls: 0,
      r2_calls_or_uploads: 0,
      marketplace_mutations: 0,
      local_writes_only: true,
    },
    rows: successes.map((row) => row.record),
    contact_sheets: sheets,
  };
  const seal = await writeSealedJson(
    path.join(outputDir, "manifest.json"),
    manifestBody,
  );
  console.log(
    JSON.stringify(
      {
        status: "COMPLETE",
        run_id: runId,
        output_dir: outputDir,
        manifest: path.join(outputDir, "manifest.json"),
        manifest_body_sha256: seal.bodySha256,
        manifest_file_sha256: seal.fileSha256,
        ...manifestBody.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
