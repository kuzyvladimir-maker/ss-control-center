/**
 * Fetch every live MAIN and gallery slot from an explicit SHA-pinned
 * Uncrustables ledger, deduplicate exact URLs/bytes, and build listing-labelled
 * local contact sheets.
 *
 * Safety boundaries:
 * - public Amazon image-CDN HTTPS GETs only;
 * - no Amazon API, Prisma/database, R2/S3, upload, or marketplace mutation;
 * - default mode is an offline preflight with zero network and zero writes;
 * - the 164-row ledger and reviewed count overrides are both byte-SHA pinned;
 * - prior/future `verified:true` gallery manifests are never read or trusted;
 * - the success manifest is written last, only after every row/slot passes.
 *
 * Network execution additionally requires:
 *   --execute-network --confirm=FETCH_UNCRUSTABLES_LIVE_GALLERY_BYTES
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS,
  UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS,
  assertAllowedLiveGalleryUrl,
  groupLiveGalleryMappingsByExactUrl,
  groupLiveGalleryReferencesByExactSha256,
  isUncrustablesLiveGalleryRetryableStatus,
  parseUncrustablesLiveGalleryRetryAfterMs,
  sealUncrustablesLiveGalleryManifestBody,
  selectReviewedTotalOverrides,
  selectSealedLiveGallery,
  uncrustablesLiveGalleryFileExtension,
  uncrustablesLiveGalleryRecipeLabel,
  uncrustablesLiveGalleryRetryBackoffMs,
  uncrustablesLiveGallerySha256,
  uncrustablesLiveGalleryTotalLabel,
  type ExactUrlGroup,
  type LiveGalleryMapping,
  type LiveGalleryRow,
  type SealedLiveGallerySelection,
} from "@/lib/bundle-factory/audit/uncrustables-live-gallery";

const NETWORK_CONFIRMATION = "FETCH_UNCRUSTABLES_LIVE_GALLERY_BYTES";
const ROW_LABEL_WIDTH = 560;
const SLOT_WIDTH = 300;
const IMAGE_SIZE = 280;
const SLOT_LABEL_HEIGHT = 105;
const ROW_HEIGHT = IMAGE_SIZE + SLOT_LABEL_HEIGHT;

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
  listingsPerSheet: number;
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

interface UrlFetchRecord {
  url_ordinal: number;
  source_ledger_sha256: string;
  requested_url: string;
  mapping_ordinals: number[];
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
    orientation: number | null;
    has_alpha: boolean;
  };
}

interface DownloadedUrl {
  record: UrlFetchRecord;
  absoluteAssetPath: string;
}

interface DownloadFailure {
  url_ordinal: number;
  requested_url: string;
  mapping_ordinals: number[];
  affected_rows: Array<{ sku: string; asin: string; slot: string }>;
  error: string;
  attempt_history: AttemptRecord[];
}

interface ExactHashAssetRecord {
  sha256: string;
  local_path: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
  exact_urls: Array<{
    url_ordinal: number;
    requested_url: string;
    final_url: string;
    fetched_at: string;
    etag: string | null;
    last_modified: string | null;
    content_type: string;
  }>;
  mapping_ordinals: number[];
}

interface ContactSheetRecord {
  sheet_number: number;
  local_path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  rows: Array<{
    row_ordinal: number;
    sku: string;
    asin: string;
    canonical_total_units: number;
    reviewed_total_units: number | null;
    expected_total_units: number;
    expected_total_source: LiveGalleryRow["expected_total_source"];
    recipe_components: LiveGalleryRow["recipe_components"];
    slots: Array<{
      mapping_ordinal: number;
      slot: string;
      asset_sha256: string;
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
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
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
    "  npx --yes tsx scripts/fetch-uncrustables-live-gallery-contact-sheets.ts \\",
    "    --ledger=SEALED_LEDGER.json \\",
    "    --ledger-sha256=<64-hex> \\",
    "    --reviewed-overrides=SEALED_REVIEWED_OVERRIDES.json \\",
    "    --reviewed-overrides-sha256=<64-hex> \\",
    "    --output-dir=NEW_DIRECTORY [options]",
    "",
    "Default: offline preflight only (no network, no writes).",
    "Network execution additionally requires:",
    `  --execute-network --confirm=${NETWORK_CONFIRMATION}`,
    "",
    "Options:",
    "  --concurrency=4          1-8 simultaneous unique-URL fetches",
    "  --max-attempts=3         1-5 attempts per unique URL",
    "  --timeout-ms=45000       5000-120000 ms per attempt",
    "  --max-bytes=26214400     1048576-52428800 bytes per image",
    "  --retry-base-ms=750      100-10000 ms exponential-backoff base",
    "  --max-redirects=3        0-5 HTTPS allow-listed redirects",
    "  --listings-per-sheet=4   1-6 listing rows per contact sheet",
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
    listingsPerSheet: 4,
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
      options.timeoutMs = boundedInteger(
        "--timeout-ms",
        arg.slice(13),
        5_000,
        120_000,
      );
    } else if (arg.startsWith("--max-bytes=")) {
      options.maxBytes = boundedInteger(
        "--max-bytes",
        arg.slice(12),
        1_048_576,
        52_428_800,
      );
    } else if (arg.startsWith("--retry-base-ms=")) {
      options.retryBaseMs = boundedInteger(
        "--retry-base-ms",
        arg.slice(16),
        100,
        10_000,
      );
    } else if (arg.startsWith("--max-redirects=")) {
      options.maxRedirects = boundedInteger(
        "--max-redirects",
        arg.slice(16),
        0,
        5,
      );
    } else if (arg.startsWith("--listings-per-sheet=")) {
      options.listingsPerSheet = boundedInteger(
        "--listings-per-sheet",
        arg.slice(21),
        1,
        6,
      );
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.ledger) throw new Error("--ledger=PATH is required");
  if (!/^[a-f0-9]{64}$/.test(options.ledgerSha256)) {
    throw new Error("--ledger-sha256 must be an explicit lowercase SHA-256");
  }
  if (!options.reviewedOverrides) {
    throw new Error("--reviewed-overrides=PATH is required");
  }
  if (!/^[a-f0-9]{64}$/.test(options.reviewedOverridesSha256)) {
    throw new Error(
      "--reviewed-overrides-sha256 must be an explicit lowercase SHA-256",
    );
  }
  if (!options.outputDir) throw new Error("--output-dir=NEW_DIRECTORY is required");
  if (options.executeNetwork && options.confirm !== NETWORK_CONFIRMATION) {
    throw new Error(
      `Network execution requires --confirm=${NETWORK_CONFIRMATION}`,
    );
  }
  if (!options.executeNetwork && options.confirm != null) {
    throw new Error("--confirm is valid only with --execute-network");
  }
  return options;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function stamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
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
    throw new FetchAttemptError(
      `Failed while reading image body: ${errorMessage(error)}`,
      { retryable: true, status: response.status, cause: error },
    );
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

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heif",
  "image/tiff",
]);

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
      assertAllowedLiveGalleryUrl(
        currentUrl,
        UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS,
      );
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
            "user-agent": "SS-Command-Center-Uncrustables-Live-Gallery-Forensics/1.0",
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
        await response.body?.cancel();
        if (redirects.length >= options.maxRedirects) {
          throw new FetchAttemptError(
            `Redirect limit ${options.maxRedirects} exceeded`,
            {
              retryable: false,
              status: response.status,
              requestCount,
              redirects,
            },
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
        assertAllowedLiveGalleryUrl(
          nextUrl,
          UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS,
        );
        redirects.push({ status: response.status, from: currentUrl, to: nextUrl });
        currentUrl = nextUrl;
        continue;
      }

      if (response.status !== 200) {
        await response.body?.cancel();
        const retryable = isUncrustablesLiveGalleryRetryableStatus(response.status);
        throw new FetchAttemptError(`HTTP ${response.status} for ${currentUrl}`, {
          retryable,
          status: response.status,
          retryAfterMs: retryable
            ? parseUncrustablesLiveGalleryRetryAfterMs(
                response.headers.get("retry-after"),
              )
            : null,
          requestCount,
          redirects,
        });
      }

      const rawContentType = response.headers.get("content-type") ?? "";
      const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        await response.body?.cancel();
        throw new FetchAttemptError(
          `Disallowed image Content-Type ${rawContentType || "<missing>"}`,
          {
            retryable: false,
            status: response.status,
            requestCount,
            redirects,
          },
        );
      }
      const bytes = await readBoundedBody(response, options.maxBytes);
      const rawLength = response.headers.get("content-length");
      const parsedLength = rawLength == null ? null : Number(rawLength);
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
  group: ExactUrlGroup,
  options: Pick<
    Options,
    "timeoutMs" | "maxBytes" | "maxRedirects" | "maxAttempts" | "retryBaseMs"
  >,
): Promise<{ result: HttpImageResult; attemptHistory: AttemptRecord[] }> {
  const attemptHistory: AttemptRecord[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const startedAt = new Date();
    const startedMonotonic = performance.now();
    try {
      const result = await fetchImageOnce(group.requested_url, options);
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
      const retryDelay = willRetry
        ? fetchError.retryAfterMs ??
          uncrustablesLiveGalleryRetryBackoffMs(attempt, options.retryBaseMs)
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
        retry_delay_ms: retryDelay,
      });
      if (!willRetry) {
        throw new ExhaustedFetchError(
          `${group.requested_url}: ${fetchError.message}`,
          attemptHistory,
        );
      }
      await sleep(retryDelay ?? 0);
    }
  }
  throw new ExhaustedFetchError(
    `${group.requested_url}: exhausted retry loop`,
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

async function writeContentAddressedBuffer(
  filePath: string,
  bytes: Buffer,
  expectedSha256: string,
): Promise<void> {
  try {
    await writeExclusiveBuffer(filePath, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(filePath);
    const actual = uncrustablesLiveGallerySha256(existing);
    if (actual !== expectedSha256) {
      throw new Error(
        `Content-address collision at ${filePath}: ${actual} != ${expectedSha256}`,
      );
    }
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
  if (!expected || !expected.has(format)) {
    throw new Error(
      `Content-Type ${contentType} disagrees with decoded format ${format}`,
    );
  }
}

async function downloadOneExactUrl(
  group: ExactUrlGroup,
  urlOrdinal: number,
  ledgerSha256: string,
  assetsDir: string,
  outputDir: string,
  options: Options,
): Promise<DownloadedUrl> {
  const { result, attemptHistory } = await fetchImageWithRetry(group, options);
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(result.bytes, { failOn: "error" }).metadata();
  } catch (error) {
    throw new ExhaustedFetchError(
      `${group.requested_url}: bytes are not a decodable image: ${errorMessage(error)}`,
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
      `${group.requested_url}: decoded metadata lacks format/dimensions`,
      attemptHistory,
    );
  }
  const pages = metadata.pages ?? 1;
  if (pages !== 1) {
    throw new ExhaustedFetchError(
      `${group.requested_url}: animated/multi-page image (${pages} pages) is not auditable`,
      attemptHistory,
    );
  }
  try {
    assertContentTypeMatchesFormat(result.content_type, metadata.format);
  } catch (error) {
    throw new ExhaustedFetchError(
      `${group.requested_url}: ${errorMessage(error)}`,
      attemptHistory,
    );
  }

  const digest = uncrustablesLiveGallerySha256(result.bytes);
  let extension: string;
  try {
    extension = uncrustablesLiveGalleryFileExtension(metadata.format);
  } catch (error) {
    throw new ExhaustedFetchError(
      `${group.requested_url}: ${errorMessage(error)}`,
      attemptHistory,
    );
  }
  const absoluteAssetPath = path.join(assetsDir, `sha256-${digest}.${extension}`);
  await writeContentAddressedBuffer(absoluteAssetPath, result.bytes, digest);
  const localPath = path.relative(outputDir, absoluteAssetPath);
  const { bytes: _bytes, ...http } = result;
  void _bytes;
  return {
    absoluteAssetPath,
    record: {
      url_ordinal: urlOrdinal,
      source_ledger_sha256: ledgerSha256,
      requested_url: group.requested_url,
      mapping_ordinals: group.mappings.map((mapping) => mapping.mapping_ordinal),
      http: {
        ...http,
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
        pages,
        orientation: metadata.orientation ?? null,
        has_alpha: metadata.hasAlpha ?? false,
      },
    },
  };
}

async function downloadAllExactUrls(
  groups: ExactUrlGroup[],
  ledgerSha256: string,
  assetsDir: string,
  outputDir: string,
  options: Options,
): Promise<{ successes: DownloadedUrl[]; failures: DownloadFailure[] }> {
  const successes = new Array<DownloadedUrl | undefined>(groups.length);
  const failures: DownloadFailure[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= groups.length) return;
      const group = groups[index];
      try {
        const downloaded = await downloadOneExactUrl(
          group,
          index + 1,
          ledgerSha256,
          assetsDir,
          outputDir,
          options,
        );
        successes[index] = downloaded;
        console.log(
          `[URL ${index + 1}/${groups.length}] ` +
            `${downloaded.record.asset.width}x${downloaded.record.asset.height} ` +
            `${downloaded.record.asset.sha256.slice(0, 12)} ` +
            `(${group.mappings.length} slot mappings)`,
        );
      } catch (error) {
        failures.push({
          url_ordinal: index + 1,
          requested_url: group.requested_url,
          mapping_ordinals: group.mappings.map((mapping) => mapping.mapping_ordinal),
          affected_rows: group.mappings.map((mapping) => ({
            sku: mapping.sku,
            asin: mapping.asin,
            slot: mapping.slot,
          })),
          error: errorMessage(error),
          attempt_history:
            error instanceof ExhaustedFetchError ? error.attemptHistory : [],
        });
        console.error(
          `[URL ${index + 1}/${groups.length}] FAILED: ${errorMessage(error)}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, groups.length) },
      () => worker(),
    ),
  );
  return {
    successes: successes.filter((item): item is DownloadedUrl => item != null),
    failures: failures.sort((left, right) => left.url_ordinal - right.url_ordinal),
  };
}

function buildExactHashAssets(downloads: DownloadedUrl[]): ExactHashAssetRecord[] {
  const byUrlOrdinal = new Map(
    downloads.map((downloaded) => [downloaded.record.url_ordinal, downloaded]),
  );
  const groups = groupLiveGalleryReferencesByExactSha256(
    downloads.map((downloaded) => ({
      sha256: downloaded.record.asset.sha256,
      url_ordinal: downloaded.record.url_ordinal,
      mapping_ordinals: downloaded.record.mapping_ordinals,
    })),
  );
  return groups.map((group) => {
    const groupedDownloads = group.url_ordinals.map((urlOrdinal) => {
      const downloaded = byUrlOrdinal.get(urlOrdinal);
      if (!downloaded) throw new Error(`Missing exact URL ordinal ${urlOrdinal}`);
      return downloaded;
    });
    const representative = groupedDownloads[0].record;
    for (const downloaded of groupedDownloads.slice(1)) {
      const record = downloaded.record;
      if (
        record.asset.bytes !== representative.asset.bytes ||
        record.asset.format !== representative.asset.format ||
        record.asset.width !== representative.asset.width ||
        record.asset.height !== representative.asset.height ||
        record.asset.local_path !== representative.asset.local_path
      ) {
        throw new Error(`Exact hash metadata disagrees for ${group.sha256}`);
      }
    }
    return {
      sha256: group.sha256,
      local_path: representative.asset.local_path,
      bytes: representative.asset.bytes,
      format: representative.asset.format,
      width: representative.asset.width,
      height: representative.asset.height,
      exact_urls: groupedDownloads.map(({ record }) => ({
        url_ordinal: record.url_ordinal,
        requested_url: record.requested_url,
        final_url: record.http.final_url,
        fetched_at: record.http.fetched_at,
        etag: record.http.etag,
        last_modified: record.http.last_modified,
        content_type: record.http.content_type,
      })),
      mapping_ordinals: group.mapping_ordinals,
    };
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value: string, width: number, maximumLines: number): string[] {
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
    if (lines.length >= maximumLines) break;
    current = word;
    consumed += 1;
  }
  if (current && lines.length < maximumLines) lines.push(current);
  if (consumed < words.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[. ]+$/, "")}...`;
  }
  return lines;
}

function svgText(
  lines: string[],
  options: { x: number; y: number; step: number; fontSize: number },
): string {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${options.x}" y="${options.y + index * options.step}">` +
        `${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function listingLabelSvg(row: LiveGalleryRow): Buffer {
  const lines = [
    `${row.ordinal}/${UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS} | SKU ${row.sku}`,
    `ASIN ${row.asin}`,
    uncrustablesLiveGalleryTotalLabel(row),
    ...wrapText(`Allocation: ${uncrustablesLiveGalleryRecipeLabel(row)}`, 52, 6),
  ];
  return Buffer.from(
    `<svg width="${ROW_LABEL_WIDTH}" height="${ROW_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#eef3ef"/>` +
      `<rect x="0" y="0" width="8" height="100%" fill="#176b3a"/>` +
      `<text font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#102018">` +
      svgText(lines, { x: 22, y: 34, step: 31, fontSize: 18 }) +
      `</text></svg>`,
  );
}

function slotLabelSvg(mapping: LiveGalleryMapping, assetSha256: string): Buffer {
  const total =
    mapping.expected_total_source === "HIGH_REVIEWED_OVERRIDE" &&
    mapping.expected_total_units !== mapping.canonical_total_units
      ? `Total ${mapping.expected_total_units} reviewed / C${mapping.canonical_total_units}`
      : `Total ${mapping.expected_total_units}`;
  const allocation = mapping.recipe_components
    .map(
      (component) =>
        `${component.qty}x ${component.flavor ?? component.product_name}`,
    )
    .join(" + ");
  const lines = [
    `${mapping.slot} | ${mapping.sku}`,
    `${mapping.asin} | ${total}`,
    ...wrapText(allocation, 38, 2),
    `sha ${assetSha256.slice(0, 12)}`,
  ].slice(0, 5);
  return Buffer.from(
    `<svg width="${SLOT_WIDTH}" height="${SLOT_LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#f5f6f5"/>` +
      `<text font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#101810">` +
      svgText(lines, { x: 8, y: 17, step: 20, fontSize: 12 }) +
      `</text></svg>`,
  );
}

function blankSlot(): Buffer {
  return Buffer.from(
    `<svg width="${SLOT_WIDTH}" height="${ROW_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#fafafa"/>` +
      `<path d="M0 0 L${SLOT_WIDTH} ${ROW_HEIGHT} M${SLOT_WIDTH} 0 L0 ${ROW_HEIGHT}" ` +
      `stroke="#eeeeee" stroke-width="2"/></svg>`,
  );
}

async function buildContactSheets(
  selection: SealedLiveGallerySelection,
  downloads: DownloadedUrl[],
  sheetsDir: string,
  outputDir: string,
  listingsPerSheet: number,
): Promise<ContactSheetRecord[]> {
  const byUrl = new Map(
    downloads.map((downloaded) => [downloaded.record.requested_url, downloaded]),
  );
  const resizedBySha = new Map<string, Promise<Buffer>>();
  const resized = (downloaded: DownloadedUrl): Promise<Buffer> => {
    const sha = downloaded.record.asset.sha256;
    const existing = resizedBySha.get(sha);
    if (existing) return existing;
    const created = (async () => {
      const bytes = await readFile(downloaded.absoluteAssetPath);
      const actual = uncrustablesLiveGallerySha256(bytes);
      if (actual !== sha) {
        throw new Error(`Local asset SHA changed: ${actual} != ${sha}`);
      }
      return sharp(bytes, { failOn: "error" })
        .rotate()
        .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "contain", background: "white" })
        .png()
        .toBuffer();
    })();
    resizedBySha.set(sha, created);
    return created;
  };

  const maxSlots = Math.max(...selection.rows.map((row) => row.images.length));
  const sheetWidth = ROW_LABEL_WIDTH + maxSlots * SLOT_WIDTH;
  const sheets: ContactSheetRecord[] = [];
  for (
    let offset = 0;
    offset < selection.rows.length;
    offset += listingsPerSheet
  ) {
    const rows = selection.rows.slice(offset, offset + listingsPerSheet);
    const composites: sharp.OverlayOptions[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      const top = rowIndex * ROW_HEIGHT;
      composites.push({ input: listingLabelSvg(row), left: 0, top });
      for (let imageIndex = 0; imageIndex < maxSlots; imageIndex++) {
        const left = ROW_LABEL_WIDTH + imageIndex * SLOT_WIDTH;
        const mapping = row.images[imageIndex];
        if (!mapping) {
          composites.push({ input: blankSlot(), left, top });
          continue;
        }
        const downloaded = byUrl.get(mapping.requested_url);
        if (!downloaded) {
          throw new Error(
            `Missing fetched URL for ${mapping.sku}/${mapping.asin}/${mapping.slot}`,
          );
        }
        composites.push({
          input: await resized(downloaded),
          left: left + (SLOT_WIDTH - IMAGE_SIZE) / 2,
          top,
        });
        composites.push({
          input: slotLabelSvg(mapping, downloaded.record.asset.sha256),
          left,
          top: top + IMAGE_SIZE,
        });
      }
    }
    const sheetHeight = rows.length * ROW_HEIGHT;
    const sheet = await sharp({
      create: {
        width: sheetWidth,
        height: sheetHeight,
        channels: 3,
        background: "white",
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
    const sheetNumber = sheets.length + 1;
    const filename = `live-gallery-contact-sheet-${String(sheetNumber).padStart(3, "0")}.png`;
    const absolutePath = path.join(sheetsDir, filename);
    await writeExclusiveBuffer(absolutePath, sheet);
    sheets.push({
      sheet_number: sheetNumber,
      local_path: path.relative(outputDir, absolutePath),
      sha256: uncrustablesLiveGallerySha256(sheet),
      bytes: sheet.length,
      width: sheetWidth,
      height: sheetHeight,
      rows: rows.map((row) => ({
        row_ordinal: row.ordinal,
        sku: row.sku,
        asin: row.asin,
        canonical_total_units: row.canonical_total_units,
        reviewed_total_units: row.reviewed_total_units,
        expected_total_units: row.expected_total_units,
        expected_total_source: row.expected_total_source,
        recipe_components: row.recipe_components,
        slots: row.images.map((mapping) => {
          const downloaded = byUrl.get(mapping.requested_url);
          if (!downloaded) {
            throw new Error(`Missing downloaded mapping ${mapping.mapping_ordinal}`);
          }
          return {
            mapping_ordinal: mapping.mapping_ordinal,
            slot: mapping.slot,
            asset_sha256: downloaded.record.asset.sha256,
          };
        }),
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
  const bodySha256 = sealUncrustablesLiveGalleryManifestBody(body);
  const manifest = { ...body, body_sha256: bodySha256 };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const fileSha256 = uncrustablesLiveGallerySha256(bytes);
  const tempPath = `${outputPath}.${randomUUID()}.tmp`;
  await writeExclusiveBuffer(tempPath, bytes);
  await writeExclusiveBuffer(
    `${outputPath}.sha256`,
    Buffer.from(`${fileSha256}  ${path.basename(outputPath)}\n`, "utf8"),
  );
  await rename(tempPath, outputPath);
  return { bodySha256, fileSha256 };
}

function completedRowCount(
  selection: SealedLiveGallerySelection,
  downloads: DownloadedUrl[],
): number {
  const fetchedUrls = new Set(
    downloads.map((downloaded) => downloaded.record.requested_url),
  );
  return selection.rows.filter((row) =>
    row.images.every((mapping) => fetchedUrls.has(mapping.requested_url)),
  ).length;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = path.resolve(options.ledger);
  const reviewedOverridesPath = path.resolve(options.reviewedOverrides);
  const outputDir = path.resolve(options.outputDir);

  const [ledgerBytes, reviewedOverrideBytes] = await Promise.all([
    readFile(ledgerPath),
    readFile(reviewedOverridesPath),
  ]);
  const actualLedgerSha = uncrustablesLiveGallerySha256(ledgerBytes);
  const actualReviewedOverridesSha = uncrustablesLiveGallerySha256(
    reviewedOverrideBytes,
  );
  if (actualLedgerSha !== options.ledgerSha256) {
    throw new Error(
      `Sealed ledger SHA mismatch: expected ${options.ledgerSha256}, actual ${actualLedgerSha}`,
    );
  }
  if (actualReviewedOverridesSha !== options.reviewedOverridesSha256) {
    throw new Error(
      "Reviewed overrides SHA mismatch: " +
        `expected ${options.reviewedOverridesSha256}, actual ${actualReviewedOverridesSha}`,
    );
  }

  const reviewedTotals = selectReviewedTotalOverrides(
    JSON.parse(reviewedOverrideBytes.toString("utf8")) as unknown,
    actualLedgerSha,
  );
  const selection = selectSealedLiveGallery(
    JSON.parse(ledgerBytes.toString("utf8")) as unknown,
    reviewedTotals,
  );
  const urlGroups = groupLiveGalleryMappingsByExactUrl(selection.mappings);
  const staleTotalRows = selection.rows
    .filter((row) => row.expected_total_units !== row.canonical_total_units)
    .map((row) => ({
      sku: row.sku,
      asin: row.asin,
      canonical_total_units: row.canonical_total_units,
      reviewed_total_units: row.reviewed_total_units,
      expected_total_units: row.expected_total_units,
      label: uncrustablesLiveGalleryTotalLabel(row),
    }));

  if (!options.executeNetwork) {
    console.log(
      JSON.stringify(
        {
          mode: "OFFLINE_PREFLIGHT",
          source_ledger: {
            path: ledgerPath,
            sha256: actualLedgerSha,
            schema_version: selection.schema_version,
            audit_id: selection.audit_id,
            marketplace_observed_at: selection.marketplace_observed_at,
          },
          reviewed_overrides: {
            path: reviewedOverridesPath,
            sha256: actualReviewedOverridesSha,
            source_ledger_sha256: actualLedgerSha,
            high_reviewed_count_overrides: reviewedTotals.size,
          },
          exact_rows: selection.rows.length,
          slot_mappings: selection.mappings.length,
          unique_exact_urls: urlGroups.length,
          duplicate_url_mappings: selection.mappings.length - urlGroups.length,
          maximum_slots_per_listing: Math.max(
            ...selection.rows.map((row) => row.images.length),
          ),
          stale_total_rows: staleTotalRows,
          allowed_hosts: [...UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS],
          trust_policy: {
            live_url_source: "SEALED_LEDGER_ONLY",
            prior_verified_flags_trusted: false,
            future_gallery_manifest_verified_flags_trusted: false,
          },
          planned_output_dir: outputDir,
          external_calls: 0,
          local_writes: 0,
          execute_requires:
            `--execute-network --confirm=${NETWORK_CONFIRMATION}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  await outputDirectoryMustNotExist(outputDir);
  await mkdir(outputDir);
  const assetsDir = path.join(outputDir, "assets");
  const sheetsDir = path.join(outputDir, "contact-sheets");
  await mkdir(assetsDir);
  await mkdir(sheetsDir);

  const startedAt = new Date();
  const runId = `ULG-${stamp(startedAt)}-${actualLedgerSha.slice(0, 12)}`;
  const sourceLedger = {
    path: ledgerPath,
    sha256: actualLedgerSha,
    schema_version: selection.schema_version,
    audit_id: selection.audit_id,
    marketplace_observed_at: selection.marketplace_observed_at,
  };
  const sourceReviewedOverrides = {
    path: reviewedOverridesPath,
    sha256: actualReviewedOverridesSha,
    source_ledger_sha256: actualLedgerSha,
    high_reviewed_count_overrides: [...reviewedTotals.values()],
  };
  const policy = {
    expected_rows: UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS,
    source_of_live_urls: "SEALED_LEDGER_ONLY",
    prior_or_future_verified_flags_trusted: false,
    allowed_hosts: [...UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS],
    exact_url_dedup_before_fetch: true,
    exact_sha256_dedup_after_fetch: true,
    concurrency: options.concurrency,
    max_attempts: options.maxAttempts,
    timeout_ms: options.timeoutMs,
    max_bytes: options.maxBytes,
    retry_base_ms: options.retryBaseMs,
    max_redirects: options.maxRedirects,
    listings_per_contact_sheet: options.listingsPerSheet,
  };

  const { successes, failures } = await downloadAllExactUrls(
    urlGroups,
    actualLedgerSha,
    assetsDir,
    outputDir,
    options,
  );
  const fetchedRows = completedRowCount(selection, successes);
  if (
    failures.length > 0 ||
    successes.length !== urlGroups.length ||
    fetchedRows !== UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS
  ) {
    const failureBody = {
      schema_version: "uncrustables-live-gallery-fetch-failure/v1.0",
      immutable: true,
      status: "FAILED_CLOSED",
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      source_ledger: sourceLedger,
      source_reviewed_overrides: sourceReviewedOverrides,
      policy,
      summary: {
        expected_rows: UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS,
        fetched_rows: fetchedRows,
        expected_exact_urls: urlGroups.length,
        fetched_exact_urls: successes.length,
        failed_exact_urls: failures.length,
        expected_slot_mappings: selection.mappings.length,
        success_manifest_written: false,
        contact_sheets_written: 0,
      },
      safety: {
        public_image_gets_only: true,
        amazon_api_calls: 0,
        prisma_or_database_calls: 0,
        r2_or_s3_calls: 0,
        uploads: 0,
        marketplace_mutations: 0,
      },
      failures,
      succeeded_url_fetches: successes.map((item) => item.record),
    };
    await writeSealedJson(
      path.join(outputDir, "failure-manifest.json"),
      failureBody,
    );
    throw new Error(
      `Failed closed: ${failures.length} exact URL(s) failed and only ` +
        `${fetchedRows}/164 rows are complete`,
    );
  }

  let exactHashAssets: ExactHashAssetRecord[];
  let contactSheets: ContactSheetRecord[];
  try {
    exactHashAssets = buildExactHashAssets(successes);
    contactSheets = await buildContactSheets(
      selection,
      successes,
      sheetsDir,
      outputDir,
      options.listingsPerSheet,
    );
  } catch (error) {
    const failureBody = {
      schema_version: "uncrustables-live-gallery-fetch-failure/v1.0",
      immutable: true,
      status: "FAILED_CLOSED",
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      source_ledger: sourceLedger,
      source_reviewed_overrides: sourceReviewedOverrides,
      policy,
      summary: {
        expected_rows: UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS,
        fetched_rows: fetchedRows,
        expected_exact_urls: urlGroups.length,
        fetched_exact_urls: successes.length,
        failed_exact_urls: 0,
        expected_slot_mappings: selection.mappings.length,
        success_manifest_written: false,
        contact_sheet_stage_failed: true,
      },
      safety: {
        public_image_gets_only: true,
        amazon_api_calls: 0,
        prisma_or_database_calls: 0,
        r2_or_s3_calls: 0,
        uploads: 0,
        marketplace_mutations: 0,
      },
      error: errorMessage(error),
      succeeded_url_fetches: successes.map((item) => item.record),
    };
    await writeSealedJson(
      path.join(outputDir, "failure-manifest.json"),
      failureBody,
    );
    throw new Error(
      `Failed closed during hash/contact-sheet stage: ${errorMessage(error)}`,
    );
  }

  const completedAt = new Date();
  const manifestBody = {
    schema_version: "uncrustables-live-gallery-contact-sheets/v1.0",
    immutable: true,
    status: "COMPLETE",
    run_id: runId,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    source_ledger: sourceLedger,
    source_reviewed_overrides: sourceReviewedOverrides,
    policy,
    summary: {
      expected_rows: UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS,
      fetched_rows: fetchedRows,
      failed_rows: 0,
      slot_mappings: selection.mappings.length,
      unique_exact_urls: urlGroups.length,
      fetched_exact_urls: successes.length,
      duplicate_url_mappings: selection.mappings.length - urlGroups.length,
      unique_exact_sha256_assets: exactHashAssets.length,
      duplicate_hash_url_count: successes.length - exactHashAssets.length,
      contact_sheets: contactSheets.length,
      total_http_get_requests: successes.reduce(
        (total, item) =>
          total +
          item.record.http.attempt_history.reduce(
            (attemptTotal, attempt) => attemptTotal + attempt.request_count,
            0,
          ),
        0,
      ),
      stale_canonical_total_rows: staleTotalRows,
    },
    safety: {
      public_image_gets_only: true,
      amazon_api_calls: 0,
      prisma_or_database_calls: 0,
      r2_or_s3_calls: 0,
      uploads: 0,
      marketplace_mutations: 0,
      local_writes_only: true,
    },
    rows: selection.rows,
    exact_url_fetches: successes.map((item) => item.record),
    exact_hash_assets: exactHashAssets,
    contact_sheets: contactSheets,
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
