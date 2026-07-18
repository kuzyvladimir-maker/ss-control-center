import { inflateSync } from "node:zlib";

import type { ChannelMaxManagedEvidenceUploadInput } from "./contracts";
import {
  assertChannelMaxVcRowSnapshot,
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA,
  ChannelMaxVcCanaryError,
  type ChannelMaxVcCanaryDirection,
  type ChannelMaxVcRowSnapshot,
} from "./uncrustables-same-model-canary";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IHDR_BYTES = 13;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_COLOR_CHANNELS = new Map<number, number>([
  // Chromium's Page.captureScreenshot encoder emits direct-colour PNGs. It
  // may omit alpha for an opaque page, so accept only RGB and RGBA here.
  [2, 3],
  [6, 4],
]);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 25_000_000;
const MAX_SCREENSHOT_EDGE = 8_192;
const MIN_SCREENSHOT_WIDTH = 320;
const MIN_SCREENSHOT_HEIGHT = 200;
const INVENTORY_SCHEMA = "channelmax-inventory-snapshot/v1";
const MANUAL_MODEL_SCHEMA = "channelmax-manual-model-discovery/v1";
const EXPECTED_SITE_ID = "300";
const EXPECTED_SITE_NAME = "AmznUS [Salutem Solutions]";
const LAUNCH_SKU = /^[A-Z]{2}-AS[A-Z0-9]{2}-[A-Z0-9]{4}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ChannelMaxEvidenceJobBinding {
  operation: string;
  accountId: string;
  payloadJson: string;
}

export class ChannelMaxEvidenceContentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChannelMaxEvidenceContentError";
  }
}

function invalid(message: string): never {
  throw new ChannelMaxEvidenceContentError(
    "EVIDENCE_CONTENT_INVALID",
    message,
  );
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? (0xedb88320 ^ (value >>> 1)) >>> 0
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(
  bytes: Buffer,
  typeOffset: number,
  dataEndOffset: number,
): number {
  let crc = 0xffffffff;
  for (let offset = typeOffset; offset < dataEndOffset; offset += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isAsciiLetter(value: number): boolean {
  return (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a)
  );
}

interface ParsedPngHeader {
  width: number;
  height: number;
  channels: number;
}

function parsePngHeader(data: Buffer): ParsedPngHeader {
  if (data.byteLength !== PNG_IHDR_BYTES) {
    invalid("Screenshot PNG IHDR has an invalid length.");
  }
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compressionMethod = data[10];
  const filterMethod = data[11];
  const interlaceMethod = data[12];
  const channels = PNG_COLOR_CHANNELS.get(colorType);

  if (
    width < MIN_SCREENSHOT_WIDTH ||
    height < MIN_SCREENSHOT_HEIGHT ||
    width > MAX_SCREENSHOT_EDGE ||
    height > MAX_SCREENSHOT_EDGE ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    invalid(
      "Screenshot PNG dimensions or page count are outside the evidence contract.",
    );
  }
  if (
    bitDepth !== 8 ||
    channels === undefined ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    interlaceMethod !== 0
  ) {
    invalid(
      "Screenshot PNG must be an 8-bit, non-interlaced Chromium RGB or RGBA image.",
    );
  }
  return { width, height, channels };
}

function assertDecodedPngScanlines(
  compressed: Buffer,
  header: ParsedPngHeader,
): void {
  const rowBytes = header.width * header.channels;
  const expectedBytes = (rowBytes + 1) * header.height;
  try {
    // `info` exposes how many compressed bytes zlib consumed. Without this
    // check inflateSync would silently accept junk or a second stream after a
    // valid stream inside IDAT.
    const result = inflateSync(compressed, {
      info: true,
      maxOutputLength: expectedBytes,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (
      result.buffer.byteLength !== expectedBytes ||
      result.engine.bytesWritten !== compressed.byteLength
    ) {
      invalid("Screenshot PNG IDAT does not contain the exact image scanlines.");
    }
    for (
      let rowOffset = 0;
      rowOffset < result.buffer.byteLength;
      rowOffset += rowBytes + 1
    ) {
      if (result.buffer[rowOffset] > 4) {
        invalid("Screenshot PNG contains an invalid scanline filter byte.");
      }
    }
  } catch (error) {
    if (error instanceof ChannelMaxEvidenceContentError) throw error;
    invalid("Screenshot evidence is not a decodable PNG.");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid(`${label} is outside its allowed integer range.`);
  }
  return value as number;
}

function normalized(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

function containsSellerIdentityKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSellerIdentityKey);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => /seller/i.test(key) || containsSellerIdentityKey(nested),
  );
}

function parsePayload(job: ChannelMaxEvidenceJobBinding): Record<string, unknown> {
  try {
    return record(JSON.parse(job.payloadJson) as unknown, "Stored job payload");
  } catch (error) {
    if (error instanceof ChannelMaxEvidenceContentError) throw error;
    return invalid("Stored job payload is not valid JSON.");
  }
}

function assertCapturedAtBinding(
  document: Record<string, unknown>,
  input: ChannelMaxManagedEvidenceUploadInput,
): void {
  if (typeof document.captured_at !== "string") {
    invalid("DOM snapshot captured_at is missing.");
  }
  const documentTime = Date.parse(document.captured_at);
  const headerTime = Date.parse(input.captured_at);
  if (
    !Number.isFinite(documentTime) ||
    !Number.isFinite(headerTime) ||
    Math.abs(documentTime - headerTime) > 5_000
  ) {
    invalid("DOM snapshot captured_at does not match its upload metadata.");
  }
}

function assertInventorySnapshot(
  document: Record<string, unknown>,
  job: ChannelMaxEvidenceJobBinding,
): void {
  if (job.operation !== "SNAPSHOT_INVENTORY") {
    invalid("Inventory snapshot evidence is not valid for this job operation.");
  }
  const payload = parsePayload(job);
  const expectedRows = integer(
    payload.expected_active_rows,
    "Stored expected_active_rows",
    1,
    600,
  );
  if (
    payload.account_id !== job.accountId ||
    payload.include_inactive !== false ||
    document.account_id !== job.accountId ||
    document.expected_active_rows !== expectedRows ||
    document.requested_include_inactive !== false
  ) {
    invalid("Inventory snapshot is not bound to the exact active-only job scope.");
  }

  const queryScope = record(document.query_scope, "query_scope");
  if (
    queryScope.active_skus_only !== true ||
    queryScope.title_contains !== "Uncrustables" ||
    queryScope.view_type !== "REPRICING" ||
    queryScope.page !== 1 ||
    queryScope.size !== 600
  ) {
    invalid("Inventory snapshot query_scope is not the fixed active-only query.");
  }
  if (
    document.selected_site_id !== EXPECTED_SITE_ID ||
    normalized(document.selected_site_name).toLowerCase() !==
      EXPECTED_SITE_NAME.toLowerCase()
  ) {
    invalid("Inventory snapshot selected ChannelMAX site is not the bound account.");
  }

  const titleTotal = integer(document.title_total, "title_total", 0, 600);
  const loadedTitleRows = integer(
    document.loaded_title_rows,
    "loaded_title_rows",
    0,
    600,
  );
  if (titleTotal !== loadedTitleRows) {
    invalid("Inventory snapshot is incomplete.");
  }
  if (!Array.isArray(document.launch_rows)) {
    invalid("Inventory snapshot launch_rows must be an array.");
  }
  const launchRows = document.launch_rows;
  if (launchRows.length !== expectedRows || titleTotal < launchRows.length) {
    invalid("Inventory snapshot launch row count does not match the job.");
  }
  const skus = launchRows.map((value, index) => {
    const row = record(value, `launch_rows[${index}]`);
    if (containsSellerIdentityKey(row)) {
      invalid("Inventory snapshot contains a seller identity field.");
    }
    if (typeof row.sku !== "string" || !LAUNCH_SKU.test(row.sku)) {
      invalid("Inventory snapshot contains a non-launch SKU.");
    }
    return row.sku;
  });
  if (new Set(skus).size !== skus.length) {
    invalid("Inventory snapshot contains duplicate launch SKUs.");
  }

  const aggregate = record(document.aggregate, "aggregate");
  const exactCount = integer(
    aggregate.exact_launch_count,
    "aggregate.exact_launch_count",
    0,
    600,
  );
  const positiveCount = integer(
    aggregate.positive_current_price_count,
    "aggregate.positive_current_price_count",
    0,
    600,
  );
  const zeroCount = integer(
    aggregate.zero_or_missing_current_price_count,
    "aggregate.zero_or_missing_current_price_count",
    0,
    600,
  );
  if (
    exactCount !== launchRows.length ||
    positiveCount + zeroCount !== launchRows.length ||
    !Array.isArray(aggregate.model_distribution) ||
    !Array.isArray(aggregate.repricing_status_distribution)
  ) {
    invalid("Inventory snapshot aggregate does not match its rows.");
  }
}

function assertManualModelSnapshot(
  document: Record<string, unknown>,
  job: ChannelMaxEvidenceJobBinding,
): void {
  if (job.operation !== "DISCOVER_MANUAL_MODEL") {
    invalid("Manual-model evidence is not valid for this job operation.");
  }
  const payload = parsePayload(job);
  const expectedRows = integer(
    payload.expected_active_rows,
    "Stored expected_active_rows",
    1,
    10_000,
  );
  const observation = record(document.observation, "observation");
  if (
    payload.account_id !== job.accountId ||
    observation.operation !== "DISCOVER_MANUAL_MODEL" ||
    observation.account_id !== job.accountId ||
    observation.expected_active_rows !== expectedRows ||
    typeof observation.visible_text_sha256 !== "string" ||
    !SHA256.test(observation.visible_text_sha256)
  ) {
    invalid("Manual-model evidence is not bound to the exact job scope.");
  }
  integer(observation.visible_text_bytes, "visible_text_bytes", 1, 1_000_000);
  integer(
    observation.visible_nonempty_line_count,
    "visible_nonempty_line_count",
    0,
    100_000,
  );
  if (
    !Array.isArray(observation.matched_view_markers) ||
    observation.matched_view_markers.length < 1
  ) {
    invalid("Manual-model evidence has no matched view marker.");
  }
  const discovery = record(
    observation.manual_model_discovery,
    "manual_model_discovery",
  );
  if (
    discovery.selected_site_id !== EXPECTED_SITE_ID ||
    normalized(discovery.selected_site_name).toLowerCase() !==
      EXPECTED_SITE_NAME.toLowerCase()
  ) {
    invalid("Manual-model evidence selected ChannelMAX site is not the bound account.");
  }
  integer(discovery.scanned_nodes, "scanned_nodes", 0, 500);
  if (!Array.isArray(discovery.models) || discovery.models.length > 100) {
    invalid("Manual-model evidence contains an invalid model list.");
  }
  const canonical = record(
    discovery.canonical_manual_model,
    "canonical_manual_model",
  );
  if (
    canonical.id !== "59021" ||
    normalized(canonical.name).toLowerCase() !== "manual min/max"
  ) {
    invalid("Manual-model evidence does not identify canonical model 59021.");
  }
}

async function assertPngScreenshot(content: Uint8Array): Promise<void> {
  const bytes = Buffer.from(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength + PNG_CHUNK_OVERHEAD_BYTES ||
    bytes.byteLength > MAX_SCREENSHOT_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    invalid("Screenshot evidence does not have a PNG signature.");
  }

  let offset = PNG_SIGNATURE.byteLength;
  let header: ParsedPngHeader | null = null;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  const idatParts: Buffer[] = [];

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < PNG_CHUNK_OVERHEAD_BYTES) {
      invalid("Screenshot PNG contains a truncated chunk.");
    }
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || length > bytes.byteLength - offset - 12) {
      invalid("Screenshot PNG contains an invalid chunk length.");
    }
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEndOffset = dataOffset + length;
    const crcOffset = dataEndOffset;
    const chunkEndOffset = crcOffset + 4;
    const typeBytes = bytes.subarray(typeOffset, dataOffset);
    if (
      typeBytes.length !== 4 ||
      ![...typeBytes].every(isAsciiLetter) ||
      // The PNG chunk type's reserved bit (third byte) must be zero/uppercase.
      (typeBytes[2] & 0x20) !== 0
    ) {
      invalid("Screenshot PNG contains an invalid chunk type.");
    }
    const type = typeBytes.toString("ascii");
    if (
      pngCrc32(bytes, typeOffset, dataEndOffset) !==
      bytes.readUInt32BE(crcOffset)
    ) {
      invalid(`Screenshot PNG ${type} chunk has an invalid CRC.`);
    }
    const data = bytes.subarray(dataOffset, dataEndOffset);

    if (header === null && type !== "IHDR") {
      invalid("Screenshot PNG IHDR must be the first chunk.");
    }
    if (type === "IHDR") {
      if (header !== null || offset !== PNG_SIGNATURE.byteLength) {
        invalid("Screenshot PNG must contain exactly one leading IHDR chunk.");
      }
      header = parsePngHeader(data);
    } else if (type === "IDAT") {
      if (seenIend || idatEnded) {
        invalid("Screenshot PNG IDAT chunks must be consecutive and precede IEND.");
      }
      seenIdat = true;
      idatParts.push(data);
    } else if (type === "IEND") {
      if (!seenIdat || seenIend || length !== 0) {
        invalid("Screenshot PNG contains an invalid IEND chunk.");
      }
      seenIend = true;
      if (chunkEndOffset !== bytes.byteLength) {
        invalid("Screenshot PNG contains data after IEND.");
      }
    } else {
      if ((typeBytes[0] & 0x20) === 0) {
        invalid(`Screenshot PNG contains unsupported critical chunk ${type}.`);
      }
      if (seenIdat) idatEnded = true;
    }

    offset = chunkEndOffset;
  }

  if (header === null || !seenIdat || !seenIend) {
    invalid("Screenshot PNG is missing IHDR, IDAT, or IEND.");
  }
  assertDecodedPngScanlines(Buffer.concat(idatParts), header);
}

function assertDomSnapshot(
  input: ChannelMaxManagedEvidenceUploadInput,
  content: Uint8Array,
  job: ChannelMaxEvidenceJobBinding,
): void {
  let document: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    document = record(JSON.parse(text) as unknown, "DOM snapshot");
  } catch (error) {
    if (error instanceof ChannelMaxEvidenceContentError) throw error;
    return invalid("DOM snapshot evidence must be valid UTF-8 JSON.");
  }
  if (containsSellerIdentityKey(document)) {
    invalid("DOM snapshot contains a seller identity field.");
  }
  assertCapturedAtBinding(document, input);
  if (document.schema_version === CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA) {
    const payload = parsePayload(job);
    const artifact = record(payload.assignment_artifact, "assignment_artifact");
    const direction: ChannelMaxVcCanaryDirection | null =
      artifact.sha256 === CHANNELMAX_VC_CANARY.forward.assignment_sha256
        ? "FORWARD"
        : artifact.sha256 === CHANNELMAX_VC_CANARY.rollback.assignment_sha256
          ? "ROLLBACK"
          : null;
    if (
      job.operation !== "UPLOAD_MANUAL_ASSIGNMENT" ||
      job.accountId !== CHANNELMAX_VC_CANARY.account_id ||
      payload.account_id !== CHANNELMAX_VC_CANARY.account_id ||
      payload.expected_active_rows !== 1 ||
      payload.manual_model_id !== CHANNELMAX_VC_CANARY.manual_model.id ||
      payload.manual_model_name !== CHANNELMAX_VC_CANARY.manual_model.name ||
      direction == null ||
      (document.phase !== "PREWRITE" && document.phase !== "POSTWRITE")
    ) {
      invalid("VC canary snapshot is not bound to the exact mutation job.");
    }
    try {
      assertChannelMaxVcRowSnapshot(
        document as unknown as ChannelMaxVcRowSnapshot,
        direction,
        document.phase,
      );
    } catch (error) {
      if (error instanceof ChannelMaxVcCanaryError) {
        invalid(error.message);
      }
      throw error;
    }
    return;
  }
  if (document.schema_version === INVENTORY_SCHEMA) {
    assertInventorySnapshot(document, job);
    return;
  }
  if (document.schema_version === MANUAL_MODEL_SCHEMA) {
    assertManualModelSnapshot(document, job);
    return;
  }
  invalid("DOM snapshot schema_version is not allow-listed.");
}

export async function assertChannelMaxManagedEvidenceContent(
  input: ChannelMaxManagedEvidenceUploadInput,
  content: Uint8Array,
  job: ChannelMaxEvidenceJobBinding,
): Promise<void> {
  if (input.kind === "SCREENSHOT") {
    if (input.media_type !== "image/png") {
      invalid("SCREENSHOT evidence requires media_type=image/png.");
    }
    await assertPngScreenshot(content);
    return;
  }
  if (input.kind === "DOM_SNAPSHOT") {
    if (input.media_type !== "application/json") {
      invalid("DOM_SNAPSHOT evidence requires media_type=application/json.");
    }
    assertDomSnapshot(input, content, job);
  }
}
