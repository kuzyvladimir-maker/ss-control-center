import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  ChannelMaxAgentOperation,
  ChannelMaxEvidenceRef,
} from "@/lib/channelmax-agent/contracts";

export const CHANNELMAX_BROWSER_HOST = "selling.channelmax.net" as const;
export const CHANNELMAX_BOUND_ACCOUNT_ID =
  "channelmax:amznus:salutem-solutions" as const;
export const CHANNELMAX_SELECTED_CHANNEL_MARKER =
  "AmznUS [Salutem Solutions]" as const;
export const CHANNELMAX_BROWSER_WORKER_OPERATIONS = [
  "SNAPSHOT_INVENTORY",
  "DISCOVER_MANUAL_MODEL",
] as const satisfies readonly ChannelMaxAgentOperation[];

const API_RESPONSE_LIMIT_BYTES = 2_000_000;
const CDP_OUTPUT_LIMIT_BYTES = 2_000_000;
const SCREENSHOT_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CDP_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_IDLE_POLL_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

type SupportedOperation =
  (typeof CHANNELMAX_BROWSER_WORKER_OPERATIONS)[number];

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WorkerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ChannelMaxBrowserWorkerConfig {
  controlPlaneBaseUrl: string;
  allowHttpLocalhost?: boolean;
  jackieApiToken: string;
  workerId: string;
  cdpScriptPath: string;
  pythonExecutable?: string;
  cdpPort?: number;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
  cdpTimeoutMs?: number;
  idlePollMs?: number;
  maxBackoffMs?: number;
}

export interface ChannelMaxBrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface LocalScreenshotCapture {
  sha256: string;
  byteSize: number;
  capturedAt: string;
  bytes: Uint8Array;
}

type ManagedEvidence = ChannelMaxEvidenceRef & { uri: string };

interface ManagedEvidenceArtifact {
  kind: "SCREENSHOT" | "DOM_SNAPSHOT";
  mediaType: "image/png" | "application/json";
  sha256: string;
  byteSize: number;
  capturedAt: string;
  bytes: Uint8Array;
}

export interface ChannelMaxManualModel {
  id: string;
  name: string;
}

export interface ChannelMaxManualModelDiscovery {
  selectedSiteId: string;
  selectedSiteName: string;
  scannedNodes: number;
  models: ChannelMaxManualModel[];
}

// This is the only JavaScript expression the worker may pass to CDP. It has no
// caller-controlled interpolation and only reads already-loaded Angular row
// entities. Do not turn this into a generic evaluate(request.script) surface.
export const CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION = String.raw`(() => {
  const angularApi = window.angular;
  if (!angularApi || typeof angularApi.element !== "function") {
    return { error: "ANGULAR_UNAVAILABLE", scanned_nodes: 0, models: [] };
  }
  const container = document.querySelector("#inventoryContainer");
  if (!container) {
    return { error: "INVENTORY_CONTAINER_UNAVAILABLE", scanned_nodes: 0, models: [] };
  }
  const containerScope = angularApi.element(container).scope();
  const channels = containerScope && Array.isArray(containerScope.userChannels)
    ? containerScope.userChannels
    : [];
  const channel = channels.find((item) => item && item.selected);
  if (!channel || channel.SiteID === undefined || channel.SiteID === null) {
    return { error: "SELECTED_CHANNEL_UNAVAILABLE", scanned_nodes: 0, models: [] };
  }
  const nodes = Array.from(
    document.querySelectorAll('[ng-click*="openQRM"]')
  ).slice(0, 500);
  const unique = new Map();
  for (const element of nodes) {
    let entity = null;
    try {
      const scope = angularApi.element(element).scope();
      entity = scope && scope.row && scope.row.entity;
    } catch (_) {
      entity = null;
    }
    const id = String(entity && entity.RepricingModelID || "").trim();
    const name = String(entity && entity.RepricingModelName || "").trim();
    if (/^\d{1,10}$/.test(id) && name && name.length <= 128) {
      unique.set(id + "\u0000" + name, { id, name });
    }
  }
  return {
    selected_site_id: String(channel.SiteID).trim(),
    selected_site_name: String(channel.SiteName || "").trim(),
    scanned_nodes: nodes.length,
    models: Array.from(unique.values()).slice(0, 100)
  };
})()`;

// Fixed, same-origin, read-only inventory query. ChannelMAX's Angular WebAPI
// service supplies its authenticated request headers; raw fetch is deliberately
// not used. The selected SellerID is needed in-page but is never returned.
export const CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION = String.raw`(async () => {
  try {
    const container = document.querySelector("#inventoryContainer");
    const angularApi = window.angular;
    if (!container || !angularApi || typeof angularApi.element !== "function") {
      return { error: "INVENTORY_ANGULAR_UNAVAILABLE" };
    }
    const scope = angularApi.element(container).scope();
    const channels = scope && Array.isArray(scope.userChannels)
      ? scope.userChannels
      : [];
    const channel = channels.find((item) => item && item.selected);
    if (!channel || channel.SiteID === undefined || channel.SiteID === null) {
      return { error: "SELECTED_CHANNEL_UNAVAILABLE" };
    }
    const injector = angularApi.element(document.body).injector();
    const WebAPI = injector && injector.get("WebAPI");
    if (!WebAPI || typeof WebAPI.postMessage !== "function") {
      return { error: "CHANNELMAX_WEBAPI_UNAVAILABLE" };
    }
    const query = {
      siteId: channel.SiteID,
      sellerId: channel.SellerID || "",
      viewType: "REPRICING",
      pagination: { page: 1, size: 600 },
      filter: null,
      filterCode: [
        {
          mode: "1",
          code: "ActiveSKUs",
          siteid: channel.SiteID,
          value: ""
        },
        {
          mode: "4",
          code: "srchTITLE",
          siteid: channel.SiteID,
          value: "Uncrustables"
        }
      ],
      sorting: null,
      filterRanges: [],
      filterMultiple: [],
      filterPriceView: [],
      filterAttributes: []
    };
    const envelope = (await WebAPI.postMessage("inventorylist", query)).data;
    if (!envelope || envelope.isValid !== true) {
      return { error: "INVENTORY_RESPONSE_INVALID" };
    }
    const payload = envelope.data;
    if (
      !payload ||
      !Number.isInteger(payload.totalItems) ||
      payload.totalItems < 0 ||
      payload.totalItems > 600 ||
      !Array.isArray(payload.rows) ||
      payload.rows.length > 600 ||
      payload.rows.length !== payload.totalItems
    ) {
      return { error: "INVENTORY_RESPONSE_OUT_OF_BOUNDS" };
    }
    const finite = (value) => {
      if (value == null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const text = (value, maximum) => String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, maximum);
    const launchPattern = /^[A-Z]{2}-AS[A-Z0-9]{2}-[A-Z0-9]{4}$/;
    const launchRows = payload.rows
      .filter((row) => row && launchPattern.test(String(row.SKU || "").trim()))
      .slice(0, 600)
      .map((row) => {
        const info = row._repriceInfo || {};
        return {
          item_id: text(row.ItemID, 128),
          sku: text(row.SKU, 64),
          asin: text(row.ASIN, 32),
          description: text(row.Description, 500),
          repricing_model_id: row.RepricingModelID == null
            ? null
            : text(row.RepricingModelID, 32),
          repricing_model_name: row.RepricingModelName == null
            ? null
            : text(row.RepricingModelName, 128),
          base_price: finite(row.BasePrice),
          unit_cost: finite(row.UnitCost),
          purchase_price: finite(row.PurchasePrice),
          actual_shipping_cost: finite(row.ActualShippingCost),
          qty_in_stock: finite(row.QtyInStock),
          quantity_ss: finite(row.QuantitySS),
          discontinued:
            row.Discontinued === true ||
            row.Discontinued === 1 ||
            String(row.Discontinued == null ? "" : row.Discontinued).trim() === "1",
          listing_status: text(row.ListingStatus, 64),
          repricing_status: text(row.xRepricingStat, 64),
          reprice_info: {
            my_price: finite(info.MyPrice),
            my_floor: finite(info.MyFloor),
            my_ceiling: finite(info.MyCeiling),
            net_profit_roi: finite(info.NetProfitROI)
          }
        };
      });
    const modelCounts = new Map();
    const statusCounts = new Map();
    let positiveCurrent = 0;
    for (const row of launchRows) {
      const modelKey = JSON.stringify([
        row.repricing_model_id,
        row.repricing_model_name
      ]);
      modelCounts.set(modelKey, (modelCounts.get(modelKey) || 0) + 1);
      const statusKey = typeof row.repricing_status === "string" && row.repricing_status
        ? row.repricing_status
        : "(empty)";
      statusCounts.set(statusKey, (statusCounts.get(statusKey) || 0) + 1);
      if (row.reprice_info.my_price !== null && row.reprice_info.my_price > 0) {
        positiveCurrent += 1;
      }
    }
    return {
      selected_site_id: text(channel.SiteID, 64),
      selected_site_name: text(channel.SiteName, 128),
      title_total: payload.totalItems,
      loaded_title_rows: payload.rows.length,
      launch_rows: launchRows,
      aggregate: {
        exact_launch_count: launchRows.length,
        positive_current_price_count: positiveCurrent,
        zero_or_missing_current_price_count: launchRows.length - positiveCurrent,
        model_distribution: Array.from(modelCounts.entries()).map(([key, count]) => {
          const parsed = JSON.parse(key);
          return { id: parsed[0], name: parsed[1], count };
        }),
        repricing_status_distribution: Array.from(statusCounts.entries()).map(
          ([status, count]) => ({ status, count })
        )
      },
      query_scope: {
        active_skus_only: true,
        title_contains: "Uncrustables",
        view_type: "REPRICING",
        page: 1,
        size: 600
      }
    };
  } catch (_) {
    return { error: "INVENTORY_SNAPSHOT_FAILED" };
  }
})()`;

export interface ChannelMaxInventorySnapshot {
  selectedSiteId: string;
  selectedSiteName: string;
  titleTotal: number;
  loadedTitleRows: number;
  launchRows: Array<Record<string, unknown>>;
  aggregate: Record<string, unknown>;
  queryScope: Record<string, unknown>;
}

export interface ReadOnlyCdp {
  ping(signal?: AbortSignal): Promise<void>;
  tabs(signal?: AbortSignal): Promise<ChannelMaxBrowserTab[]>;
  getText(tabId: string, signal?: AbortSignal): Promise<string>;
  discoverManualModels(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<ChannelMaxManualModelDiscovery>;
  snapshotInventory(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<ChannelMaxInventorySnapshot>;
  captureScreenshot(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<LocalScreenshotCapture>;
}

interface QueueJob {
  id: string;
  operation: SupportedOperation;
  mutation: false;
  accountId: string;
  expectedActiveRows: number;
  attempts: number;
  payload: Record<string, unknown>;
}

interface ClaimedJob {
  leaseToken: string;
  leaseExpiresAt: string;
  job: QueueJob;
}

interface WorkerFailure {
  code: string;
  message: string;
  phase: string;
  authRequired?: boolean;
  details?: Record<string, unknown>;
}

interface ExecutionResult {
  status: "SUCCEEDED" | "FAILED";
  message: string;
  result: Record<string, unknown>;
  evidence: ManagedEvidence[];
}

export type RunOnceOutcome = "NO_JOB" | "COMPLETED";

export class ChannelMaxBrowserWorkerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ChannelMaxBrowserWorkerError";
  }
}

class WorkerStoppedError extends Error {
  constructor() {
    super("ChannelMAX browser worker stopped.");
    this.name = "WorkerStoppedError";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkerStoppedError();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_EVIDENCE_JSON",
        "Evidence JSON contains a non-finite number.",
      );
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_EVIDENCE_JSON",
        "Evidence JSON contains an unsupported value.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function containsSellerIdentityKey(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSellerIdentityKey);
  const object = value as Record<string, unknown>;
  return Object.entries(object).some(
    ([key, nested]) => /seller/i.test(key) || containsSellerIdentityKey(nested),
  );
}

function jsonEvidenceArtifact(value: unknown): ManagedEvidenceArtifact {
  if (containsSellerIdentityKey(value)) {
    throw new ChannelMaxBrowserWorkerError(
      "SENSITIVE_FIELD_REFUSED",
      "Canonical evidence unexpectedly contained a seller identity field.",
    );
  }
  const bytes = new TextEncoder().encode(stableJson(value));
  if (bytes.byteLength < 1 || bytes.byteLength > SCREENSHOT_LIMIT_BYTES) {
    throw new ChannelMaxBrowserWorkerError(
      "EVIDENCE_JSON_TOO_LARGE",
      "Canonical JSON evidence exceeds the 5 MiB managed evidence limit.",
    );
  }
  return {
    kind: "DOM_SNAPSHOT",
    mediaType: "application/json",
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    capturedAt: new Date().toISOString(),
    bytes,
  };
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_RESPONSE",
      `${label} must be a non-empty string.`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maximum || /\p{Cc}/u.test(normalized)) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_RESPONSE",
      `${label} has an invalid length or contains control characters.`,
    );
  }
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_RESPONSE",
      `${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateControlPlaneBaseUrl(
  raw: string,
  options: { allowHttpLocalhost?: boolean } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "SSCC base URL is invalid.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "SSCC base URL cannot contain credentials, query, or fragment.",
    );
  }
  if (parsed.pathname !== "/") {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "SSCC base URL must be an origin without a path.",
    );
  }
  const localHttpAllowed =
    options.allowHttpLocalhost === true &&
    parsed.protocol === "http:" &&
    isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttpAllowed) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "SSCC base URL must use HTTPS; HTTP is allowed only for explicitly enabled loopback development.",
    );
  }
  return parsed.origin;
}

function validateConfig(config: ChannelMaxBrowserWorkerConfig) {
  const controlPlaneBaseUrl = validateControlPlaneBaseUrl(
    config.controlPlaneBaseUrl,
    {
      allowHttpLocalhost: config.allowHttpLocalhost === true,
    },
  );
  const jackieApiToken = config.jackieApiToken;
  if (
    typeof jackieApiToken !== "string" ||
    jackieApiToken.length < 16 ||
    jackieApiToken.length > 8_192 ||
    /[\r\n\0]/.test(jackieApiToken)
  ) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "JACKIE_API_TOKEN is missing or invalid.",
    );
  }
  const workerId = config.workerId;
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(workerId)) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "CHANNELMAX_WORKER_ID must be a stable 3-128 character identifier.",
    );
  }
  if (!isAbsolute(config.cdpScriptPath)) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "ChannelMAX CDP script path must be absolute.",
    );
  }
  const leaseSeconds = config.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "ChannelMAX lease must be 30-300 seconds.",
    );
  }
  const cdpPort = config.cdpPort ?? 9222;
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "CDP port must be between 1 and 65535.",
    );
  }
  const timingValues = {
    requestTimeoutMs: {
      value: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      min: 1_000,
      max: 120_000,
    },
    cdpTimeoutMs: {
      value: config.cdpTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS,
      min: 1_000,
      max: 60_000,
    },
    idlePollMs: {
      value: config.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
      min: 250,
      max: 300_000,
    },
    maxBackoffMs: {
      value: config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      min: 1_000,
      max: 600_000,
    },
  };
  for (const [name, timing] of Object.entries(timingValues)) {
    if (
      !Number.isInteger(timing.value) ||
      timing.value < timing.min ||
      timing.value > timing.max
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CONFIG",
        `${name} is outside its safe bounded range.`,
      );
    }
  }
  return {
    ...config,
    controlPlaneBaseUrl,
    leaseSeconds,
    cdpPort,
    pythonExecutable: config.pythonExecutable ?? "python3",
    requestTimeoutMs: timingValues.requestTimeoutMs.value,
    cdpTimeoutMs: timingValues.cdpTimeoutMs.value,
    idlePollMs: timingValues.idlePollMs.value,
    maxBackoffMs: timingValues.maxBackoffMs.value,
  };
}

function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}

async function readBoundedResponseJson(
  response: Response,
  secrets: readonly string[],
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > API_RESPONSE_LIMIT_BYTES) {
    throw new ChannelMaxBrowserWorkerError(
      "API_RESPONSE_TOO_LARGE",
      "SSCC API response exceeds the worker limit.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    byteSize += item.value.byteLength;
    if (byteSize > API_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new ChannelMaxBrowserWorkerError(
        "API_RESPONSE_TOO_LARGE",
        "SSCC API response exceeds the worker limit.",
      );
    }
    chunks.push(item.value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_API_RESPONSE",
      redact("SSCC returned invalid JSON.", secrets),
    );
  }
}

function combinedSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

class ChannelMaxQueueClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly workerId: string,
    private readonly leaseSeconds: number,
    private readonly requestTimeoutMs: number,
    private readonly fetchImpl: FetchLike,
  ) {}

  private async post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertNotAborted(signal);
    const target = new URL(path, `${this.baseUrl}/`);
    if (target.origin !== this.baseUrl) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_API_TARGET",
        "Refused an SSCC API request outside the configured origin.",
      );
    }
    const bounded = combinedSignal(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: bounded.signal,
      });
      const parsed = await readBoundedResponseJson(response, [this.token]);
      if (!response.ok) {
        const raw = record(parsed, "SSCC error response");
        const nested =
          raw.error && typeof raw.error === "object"
            ? (raw.error as Record<string, unknown>)
            : raw;
        const message =
          typeof nested.message === "string"
            ? nested.message
            : `SSCC API returned HTTP ${response.status}.`;
        throw new ChannelMaxBrowserWorkerError(
          "API_HTTP_ERROR",
          redact(message, [this.token]),
          { http_status: response.status },
        );
      }
      return parsed;
    } catch (error) {
      bounded.dispose();
      if (signal?.aborted) throw new WorkerStoppedError();
      if (error instanceof ChannelMaxBrowserWorkerError) throw error;
      throw new ChannelMaxBrowserWorkerError(
        "API_REQUEST_FAILED",
        redact(
          error instanceof Error ? error.message : "SSCC API request failed.",
          [this.token],
        ),
      );
    } finally {
      bounded.dispose();
    }
  }

  async claim(signal?: AbortSignal): Promise<ClaimedJob | null> {
    const parsed = record(
      await this.post(
        "/api/openclaw/channelmax/jobs/claim",
        {
          worker_id: this.workerId,
          supported_operations: [...CHANNELMAX_BROWSER_WORKER_OPERATIONS],
          lease_seconds: this.leaseSeconds,
        },
        signal,
      ),
      "claim response",
    );
    if (parsed.claimed === false) return null;
    if (parsed.claimed !== true) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM",
        "SSCC claim response did not declare claimed=true/false.",
      );
    }
    const leaseToken = boundedString(parsed.lease_token, "lease_token", 64);
    if (!/^[a-f0-9]{64}$/.test(leaseToken)) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM",
        "SSCC returned an invalid lease token.",
      );
    }
    const leaseExpiresAt = boundedString(
      parsed.lease_expires_at,
      "lease_expires_at",
      32,
    );
    if (!Number.isFinite(Date.parse(leaseExpiresAt))) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM",
        "SSCC returned an invalid lease expiry.",
      );
    }
    const rawJob = record(parsed.job, "claim job");
    const operation = rawJob.operation;
    if (
      operation !== "SNAPSHOT_INVENTORY" &&
      operation !== "DISCOVER_MANUAL_MODEL"
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "UNSUPPORTED_JOB",
        "SSCC returned a job outside this worker's exact read-only allowlist.",
      );
    }
    if (rawJob.mutation !== false) {
      throw new ChannelMaxBrowserWorkerError(
        "MUTATION_JOB_REFUSED",
        "This worker refuses every mutation-capable job.",
      );
    }
    const protocol = record(parsed.protocol, "claim protocol");
    if (
      protocol.read_only !== true ||
      protocol.external_writes_forbidden !== true
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM_PROTOCOL",
        "SSCC did not issue an explicit read-only, external-write-forbidden lease.",
      );
    }
    const payload = record(rawJob.payload, "claim job payload");
    const expectedActiveRows = payload.expected_active_rows;
    if (
      !Number.isInteger(expectedActiveRows) ||
      (expectedActiveRows as number) < 1 ||
      (expectedActiveRows as number) > 10_000
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM",
        "Job expected_active_rows is invalid.",
      );
    }
    const attempts = rawJob.attempts;
    if (!Number.isInteger(attempts) || (attempts as number) < 1) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CLAIM",
        "Job attempt number is invalid.",
      );
    }
    return {
      leaseToken,
      leaseExpiresAt,
      job: {
        id: boundedString(rawJob.id, "job.id", 128),
        operation,
        mutation: false,
        accountId: boundedString(payload.account_id, "payload.account_id", 128),
        expectedActiveRows: expectedActiveRows as number,
        attempts: attempts as number,
        payload,
      },
    };
  }

  async heartbeat(
    jobId: string,
    leaseToken: string,
    phase: string,
    progressPercent: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(
      `/api/openclaw/channelmax/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      {
        lease_token: leaseToken,
        phase,
        progress_percent: progressPercent,
      },
      signal,
    );
  }

  async event(
    job: QueueJob,
    leaseToken: string,
    input: {
      type: "PROGRESS" | "AUTH_REQUIRED" | "EVIDENCE_CAPTURED";
      message: string;
      step: string;
      progressPercent?: number;
      evidence?: ManagedEvidence[];
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const eventKey = stableKey(
      "worker:event",
      `${this.workerId}:${job.id}:${job.attempts}:${input.type}:${input.step}`,
    );
    await this.post(
      `/api/openclaw/channelmax/jobs/${encodeURIComponent(job.id)}/event`,
      {
        event_key: eventKey,
        lease_token: leaseToken,
        type: input.type,
        occurred_at: new Date().toISOString(),
        message: input.message,
        step: input.step,
        ...(input.progressPercent === undefined
          ? {}
          : { progress_percent: input.progressPercent }),
        evidence: input.evidence ?? [],
      },
      signal,
    );
  }

  async uploadManagedEvidence(
    claimed: ClaimedJob,
    artifact: ManagedEvidenceArtifact,
    signal?: AbortSignal,
  ): Promise<ManagedEvidence> {
    if (
      artifact.bytes.byteLength !== artifact.byteSize ||
      artifact.byteSize < 1 ||
      artifact.byteSize > SCREENSHOT_LIMIT_BYTES ||
      sha256(artifact.bytes) !== artifact.sha256
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_EVIDENCE_ARTIFACT",
        "Evidence bytes failed local size or SHA-256 verification before upload.",
      );
    }
    if (
      artifact.kind === "SCREENSHOT" &&
      !Buffer.from(artifact.bytes.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_SCREENSHOT",
        "Screenshot evidence does not have a valid PNG signature.",
      );
    }
    const target = new URL(
      `/api/openclaw/channelmax/jobs/${encodeURIComponent(claimed.job.id)}/evidence`,
      `${this.baseUrl}/`,
    );
    if (target.origin !== this.baseUrl) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_API_TARGET",
        "Refused an evidence upload outside the configured SSCC origin.",
      );
    }
    const bounded = combinedSignal(signal, this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": artifact.mediaType,
          "x-channelmax-lease-token": claimed.leaseToken,
          "x-channelmax-evidence-kind": artifact.kind,
          "x-channelmax-captured-at": artifact.capturedAt,
        },
        body: Buffer.from(artifact.bytes),
        redirect: "error",
        signal: bounded.signal,
      });
    } catch (error) {
      bounded.dispose();
      if (signal?.aborted) throw new WorkerStoppedError();
      throw new ChannelMaxBrowserWorkerError(
        "EVIDENCE_UPLOAD_FAILED",
        redact(
          error instanceof Error
            ? error.message
            : "Managed evidence upload failed.",
          [this.token, claimed.leaseToken],
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = await readBoundedResponseJson(response, [
        this.token,
        claimed.leaseToken,
      ]);
    } finally {
      bounded.dispose();
    }
    if (!response.ok) {
      const raw = record(parsed, "managed evidence error response");
      const message =
        typeof raw.message === "string"
          ? raw.message
          : `SSCC evidence upload returned HTTP ${response.status}.`;
      throw new ChannelMaxBrowserWorkerError(
        "EVIDENCE_UPLOAD_FAILED",
        redact(message, [this.token, claimed.leaseToken]),
        { http_status: response.status },
      );
    }
    const raw = record(
      record(parsed, "managed evidence response").evidence,
      "managed evidence response.evidence",
    );
    const uri = boundedString(raw.uri, "evidence.uri", 2_048);
    let parsedUri: URL;
    try {
      parsedUri = new URL(uri);
    } catch {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_EVIDENCE_RESPONSE",
        "SSCC returned an invalid managed evidence URI.",
      );
    }
    const expectedPathPrefix = `/api/openclaw/channelmax/jobs/${encodeURIComponent(claimed.job.id)}/evidence/`;
    if (
      parsedUri.protocol !== "https:" ||
      parsedUri.origin !== this.baseUrl ||
      parsedUri.username ||
      parsedUri.password ||
      !parsedUri.pathname.startsWith(expectedPathPrefix) ||
      parsedUri.search ||
      parsedUri.hash
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_EVIDENCE_RESPONSE",
        "SSCC returned a managed evidence URI outside the exact control-plane job path.",
      );
    }
    if (
      raw.kind !== artifact.kind ||
      raw.sha256 !== artifact.sha256 ||
      raw.byte_size !== artifact.byteSize ||
      raw.media_type !== artifact.mediaType ||
      raw.captured_at !== artifact.capturedAt
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "EVIDENCE_DIGEST_MISMATCH",
        "Server-managed evidence metadata does not match the locally verified screenshot.",
      );
    }
    return {
      kind: artifact.kind,
      sha256: artifact.sha256,
      byte_size: artifact.byteSize,
      media_type: artifact.mediaType,
      captured_at: artifact.capturedAt,
      uri,
    };
  }

  async complete(
    claimed: ClaimedJob,
    completion: ExecutionResult,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(
      `/api/openclaw/channelmax/jobs/${encodeURIComponent(claimed.job.id)}/complete`,
      {
        completion_key: stableKey(
          "worker:complete",
          `${this.workerId}:${claimed.job.id}:${claimed.job.attempts}`,
        ),
        lease_token: claimed.leaseToken,
        status: completion.status,
        message: completion.message,
        result: completion.result,
        evidence: completion.evidence,
      },
      signal,
    );
  }
}

function stableKey(prefix: string, value: string): string {
  return `${prefix}:${sha256(value).slice(0, 40)}`;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
    signal?: AbortSignal;
  },
  callback: ExecFileCallback,
) => unknown;

function parseCdpSuccess(
  stdout: string,
  expectedCommand: string,
): Record<string, unknown> {
  if (Buffer.byteLength(stdout, "utf8") > CDP_OUTPUT_LIMIT_BYTES) {
    throw new ChannelMaxBrowserWorkerError(
      "CDP_OUTPUT_TOO_LARGE",
      "CDP helper output exceeds the worker limit.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CDP_RESPONSE",
      "CDP helper returned invalid JSON.",
    );
  }
  const raw = record(parsed, "CDP response");
  if (raw.ok !== true || raw.command !== expectedCommand) {
    const error =
      raw.error && typeof raw.error === "object"
        ? (raw.error as Record<string, unknown>)
        : {};
    throw new ChannelMaxBrowserWorkerError(
      typeof error.code === "string" ? error.code : "CDP_COMMAND_FAILED",
      typeof error.message === "string"
        ? error.message
        : `CDP ${expectedCommand} command failed.`,
    );
  }
  return raw;
}

export class CdpBrowserReadOnlyClient implements ReadOnlyCdp {
  private readonly executable: string;
  private readonly scriptPath: string;
  private readonly cdpPort: number;
  private readonly timeoutMs: number;
  private readonly execFileImpl: ExecFileLike;

  constructor(input: {
    pythonExecutable: string;
    scriptPath: string;
    cdpPort: number;
    timeoutMs: number;
    execFileImpl?: ExecFileLike;
  }) {
    this.executable = input.pythonExecutable;
    this.scriptPath = resolve(input.scriptPath);
    this.cdpPort = input.cdpPort;
    this.timeoutMs = input.timeoutMs;
    this.execFileImpl = input.execFileImpl ?? (execFile as unknown as ExecFileLike);
  }

  private execute(
    command: "ping" | "tabs" | "get_text" | "evaluate" | "screenshot",
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    assertNotAborted(signal);
    return new Promise((resolvePromise, rejectPromise) => {
      this.execFileImpl(
        this.executable,
        [this.scriptPath, command, ...args],
        {
          cwd: dirname(this.scriptPath),
          // Do not inherit JACKIE_API_TOKEN or any other application secret.
          env: {
            PATH: process.env.PATH,
            NODE_ENV: process.env.NODE_ENV,
            CDP_PORT: String(this.cdpPort),
            PYTHONUNBUFFERED: "1",
          },
          encoding: "utf8",
          maxBuffer: CDP_OUTPUT_LIMIT_BYTES,
          timeout: this.timeoutMs,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (signal?.aborted) {
              rejectPromise(new WorkerStoppedError());
              return;
            }
            rejectPromise(
              new ChannelMaxBrowserWorkerError(
                "CDP_PROCESS_FAILED",
                "Read-only CDP helper failed.",
                {
                  // stderr can contain page data; retain only a bounded digest.
                  stderr_sha256: sha256(stderr.slice(0, CDP_OUTPUT_LIMIT_BYTES)),
                },
              ),
            );
            return;
          }
          try {
            resolvePromise(parseCdpSuccess(stdout, command));
          } catch (parseError) {
            rejectPromise(parseError);
          }
        },
      );
    });
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.execute("ping", [], signal);
  }

  async tabs(signal?: AbortSignal): Promise<ChannelMaxBrowserTab[]> {
    const raw = await this.execute("tabs", [], signal);
    if (!Array.isArray(raw.tabs) || raw.tabs.length > 100) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CDP_RESPONSE",
        "CDP tabs response is invalid or too large.",
      );
    }
    return raw.tabs.map((value, index) => {
      const tab = record(value, `tabs[${index}]`);
      return {
        id: boundedString(tab.id, `tabs[${index}].id`, 256),
        title:
          typeof tab.title === "string" ? tab.title.slice(0, 1_024) : "",
        url: boundedString(tab.url, `tabs[${index}].url`, 2_048),
      };
    });
  }

  async getText(tabId: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.execute(
      "get_text",
      ["--tab", tabId, "--expected-host", CHANNELMAX_BROWSER_HOST],
      signal,
    );
    if (typeof raw.text !== "string") {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CDP_RESPONSE",
        "CDP get_text response did not contain text.",
      );
    }
    if (Buffer.byteLength(raw.text, "utf8") > 1_000_000) {
      throw new ChannelMaxBrowserWorkerError(
        "CHANNELMAX_PAGE_TOO_LARGE",
        "Visible ChannelMAX text exceeds the worker limit.",
      );
    }
    return raw.text;
  }

  async discoverManualModels(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<ChannelMaxManualModelDiscovery> {
    const raw = await this.execute(
      "evaluate",
      [
        CHANNELMAX_MANUAL_MODEL_DISCOVERY_EXPRESSION,
        "--tab",
        tabId,
        "--expected-host",
        CHANNELMAX_BROWSER_HOST,
      ],
      signal,
    );
    const value = record(raw.value, "manual model discovery");
    if (value.error !== undefined) {
      throw new ChannelMaxBrowserWorkerError(
        "MANUAL_MODEL_DISCOVERY_UNAVAILABLE",
        "The fixed read-only ChannelMAX model discovery probe is unavailable on this page.",
      );
    }
    if (
      value.selected_site_id !== "300" ||
      value.selected_site_name !== CHANNELMAX_SELECTED_CHANNEL_MARKER ||
      !Number.isInteger(value.scanned_nodes) ||
      (value.scanned_nodes as number) < 0 ||
      (value.scanned_nodes as number) > 500 ||
      !Array.isArray(value.models) ||
      value.models.length > 100
    ) {
      throw new ChannelMaxBrowserWorkerError(
        value.selected_site_id !== "300" ||
          value.selected_site_name !== CHANNELMAX_SELECTED_CHANNEL_MARKER
          ? "CHANNELMAX_SELECTED_ACCOUNT_MISMATCH"
          : "INVALID_CDP_RESPONSE",
        value.selected_site_id !== "300" ||
          value.selected_site_name !== CHANNELMAX_SELECTED_CHANNEL_MARKER
          ? "Manual model discovery returned a different selected ChannelMAX account."
          : "Manual model discovery returned an invalid bounded result.",
      );
    }
    const models = value.models.map((item, index) => {
      const model = record(item, `manual models[${index}]`);
      const id = boundedString(model.id, `manual models[${index}].id`, 10);
      if (!/^\d{1,10}$/.test(id)) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "Manual model discovery returned an invalid model ID.",
        );
      }
      return {
        id,
        name: boundedString(model.name, `manual models[${index}].name`, 128),
      };
    });
    if (new Set(models.map((model) => `${model.id}\0${model.name}`)).size !== models.length) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CDP_RESPONSE",
        "Manual model discovery returned duplicate models.",
      );
    }
    return {
      selectedSiteId: value.selected_site_id,
      selectedSiteName: value.selected_site_name,
      scannedNodes: value.scanned_nodes as number,
      models,
    };
  }

  async snapshotInventory(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<ChannelMaxInventorySnapshot> {
    const raw = await this.execute(
      "evaluate",
      [
        CHANNELMAX_INVENTORY_SNAPSHOT_EXPRESSION,
        "--tab",
        tabId,
        "--expected-host",
        CHANNELMAX_BROWSER_HOST,
      ],
      signal,
    );
    const value = record(raw.value, "inventory snapshot");
    if (value.error !== undefined) {
      throw new ChannelMaxBrowserWorkerError(
        typeof value.error === "string"
          ? value.error.slice(0, 128)
          : "INVENTORY_SNAPSHOT_FAILED",
        "The fixed read-only ChannelMAX inventory snapshot probe failed.",
      );
    }
    if (
      typeof value.selected_site_id !== "string" ||
      value.selected_site_id.trim() !== "300" ||
      typeof value.selected_site_name !== "string" ||
      value.selected_site_name.trim().replace(/\s+/g, " ").toLowerCase() !==
        CHANNELMAX_SELECTED_CHANNEL_MARKER.toLowerCase() ||
      !Number.isInteger(value.title_total) ||
      (value.title_total as number) < 0 ||
      (value.title_total as number) > 600 ||
      !Number.isInteger(value.loaded_title_rows) ||
      (value.loaded_title_rows as number) < 0 ||
      (value.loaded_title_rows as number) > 600 ||
      value.loaded_title_rows !== value.title_total ||
      !Array.isArray(value.launch_rows) ||
      value.launch_rows.length > 600
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "INVALID_CDP_RESPONSE",
        "Inventory snapshot returned invalid bounded counts or rows.",
      );
    }
    const launchRows = value.launch_rows.map((item, index) => {
      const row = record(item, `launch_rows[${index}]`);
      const allowedKeys = new Set([
        "item_id",
        "sku",
        "asin",
        "description",
        "repricing_model_id",
        "repricing_model_name",
        "base_price",
        "unit_cost",
        "purchase_price",
        "actual_shipping_cost",
        "qty_in_stock",
        "quantity_ss",
        "discontinued",
        "listing_status",
        "repricing_status",
        "reprice_info",
      ]);
      if (
        Object.keys(row).length !== allowedKeys.size ||
        Object.keys(row).some((key) => !allowedKeys.has(key))
      ) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "Inventory snapshot row does not match the fixed projection schema.",
        );
      }
      const sku = boundedString(row.sku, `launch_rows[${index}].sku`, 64);
      if (!/^[A-Z]{2}-AS[A-Z0-9]{2}-[A-Z0-9]{4}$/.test(sku)) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "Inventory snapshot returned a non-launch SKU.",
        );
      }
      const serialized = stableJson(row);
      if (Buffer.byteLength(serialized, "utf8") > 10_000) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "One inventory row exceeds the bounded projection limit.",
        );
      }
      if (containsSellerIdentityKey(row)) {
        throw new ChannelMaxBrowserWorkerError(
          "SENSITIVE_FIELD_REFUSED",
          "Inventory snapshot unexpectedly contained a seller identity field.",
        );
      }
      const boundedTextFields: Array<[string, number]> = [
        ["item_id", 128],
        ["asin", 32],
        ["description", 500],
        ["listing_status", 64],
        ["repricing_status", 64],
      ];
      for (const [field, maximum] of boundedTextFields) {
        if (
          typeof row[field] !== "string" ||
          (row[field] as string).length > maximum
        ) {
          throw new ChannelMaxBrowserWorkerError(
            "INVALID_CDP_RESPONSE",
            `Inventory snapshot ${field} is invalid.`,
          );
        }
      }
      for (const field of ["repricing_model_id", "repricing_model_name"]) {
        if (
          row[field] !== null &&
          (typeof row[field] !== "string" || (row[field] as string).length > 128)
        ) {
          throw new ChannelMaxBrowserWorkerError(
            "INVALID_CDP_RESPONSE",
            `Inventory snapshot ${field} is invalid.`,
          );
        }
      }
      for (const field of [
        "base_price",
        "unit_cost",
        "purchase_price",
        "actual_shipping_cost",
        "qty_in_stock",
        "quantity_ss",
      ]) {
        if (
          row[field] !== null &&
          (typeof row[field] !== "number" || !Number.isFinite(row[field]))
        ) {
          throw new ChannelMaxBrowserWorkerError(
            "INVALID_CDP_RESPONSE",
            `Inventory snapshot ${field} is invalid.`,
          );
        }
      }
      if (typeof row.discontinued !== "boolean") {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "Inventory snapshot discontinued is invalid.",
        );
      }
      const repriceInfo = record(
        row.reprice_info,
        `launch_rows[${index}].reprice_info`,
      );
      const repriceKeys = ["my_price", "my_floor", "my_ceiling", "net_profit_roi"];
      if (
        Object.keys(repriceInfo).length !== repriceKeys.length ||
        Object.keys(repriceInfo).some((key) => !repriceKeys.includes(key)) ||
        repriceKeys.some(
          (key) =>
            repriceInfo[key] !== null &&
            (typeof repriceInfo[key] !== "number" ||
              !Number.isFinite(repriceInfo[key])),
        )
      ) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_CDP_RESPONSE",
          "Inventory snapshot reprice_info is invalid.",
        );
      }
      return { ...row, sku } as Record<string, unknown> & { sku: string };
    });
    if (new Set(launchRows.map((row) => row.sku)).size !== launchRows.length) {
      throw new ChannelMaxBrowserWorkerError(
        "DUPLICATE_LAUNCH_SKU",
        "Inventory snapshot returned duplicate exact launch SKUs.",
      );
    }
    const modelCounts = new Map<string, { id: unknown; name: unknown; count: number }>();
    const statusCounts = new Map<string, number>();
    let positiveCurrent = 0;
    for (const row of launchRows) {
      const id = row.repricing_model_id ?? null;
      const name = row.repricing_model_name ?? null;
      const modelKey = stableJson([id, name]);
      const prior = modelCounts.get(modelKey);
      modelCounts.set(modelKey, {
        id,
        name,
        count: (prior?.count ?? 0) + 1,
      });
      const repricingStatus = row.repricing_status;
      const status =
        typeof repricingStatus === "string" && repricingStatus
          ? repricingStatus.slice(0, 64)
          : repricingStatus &&
              typeof repricingStatus === "object" &&
              !Array.isArray(repricingStatus) &&
              typeof (repricingStatus as Record<string, unknown>).status === "string"
            ? String((repricingStatus as Record<string, unknown>).status).slice(0, 64)
            : "(empty)";
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      const repriceInfo =
        row.reprice_info &&
        typeof row.reprice_info === "object" &&
        !Array.isArray(row.reprice_info)
          ? (row.reprice_info as Record<string, unknown>)
          : {};
      if (
        typeof repriceInfo.my_price === "number" &&
        Number.isFinite(repriceInfo.my_price) &&
        repriceInfo.my_price > 0
      ) {
        positiveCurrent += 1;
      }
    }
    return {
      selectedSiteId: value.selected_site_id.trim(),
      selectedSiteName: value.selected_site_name.trim().replace(/\s+/g, " "),
      titleTotal: value.title_total as number,
      loadedTitleRows: value.loaded_title_rows as number,
      launchRows,
      aggregate: {
        exact_launch_count: launchRows.length,
        positive_current_price_count: positiveCurrent,
        zero_or_missing_current_price_count:
          launchRows.length - positiveCurrent,
        model_distribution: [...modelCounts.values()],
        repricing_status_distribution: [...statusCounts.entries()].map(
          ([status, count]) => ({ status, count }),
        ),
      },
      queryScope: {
        active_skus_only: true,
        title_contains: "Uncrustables",
        view_type: "REPRICING",
        page: 1,
        size: 600,
      },
    };
  }

  async captureScreenshot(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<LocalScreenshotCapture> {
    const directory = await mkdtemp(join(tmpdir(), "channelmax-evidence-"));
    try {
      const raw = await this.execute(
        "screenshot",
        [
          "--tab",
          tabId,
          "--expected-host",
          CHANNELMAX_BROWSER_HOST,
          "--output-dir",
          directory,
        ],
        signal,
      );
      const rawPath = boundedString(raw.path, "screenshot.path", 4_096);
      const screenshotPath = resolve(rawPath);
      const canonicalDirectory = await realpath(directory);
      const fileStat = await lstat(screenshotPath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_SCREENSHOT",
          "CDP screenshot is not a regular file.",
        );
      }
      const canonicalScreenshotPath = await realpath(screenshotPath);
      if (
        dirname(canonicalScreenshotPath) !== canonicalDirectory ||
        relative(canonicalDirectory, canonicalScreenshotPath).startsWith("..")
      ) {
        throw new ChannelMaxBrowserWorkerError(
          "UNSAFE_SCREENSHOT_PATH",
          "CDP screenshot was written outside its isolated temporary directory.",
        );
      }
      if (fileStat.size < 1 || fileStat.size > SCREENSHOT_LIMIT_BYTES) {
        throw new ChannelMaxBrowserWorkerError(
          "INVALID_SCREENSHOT",
          "CDP screenshot size is outside the worker limit.",
        );
      }
      const handle = await open(
        canonicalScreenshotPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      let bytes: Buffer;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const digest = sha256(bytes);
      if (
        raw.sha256 !== digest ||
        raw.bytes !== bytes.byteLength
      ) {
        throw new ChannelMaxBrowserWorkerError(
          "SCREENSHOT_DIGEST_MISMATCH",
          "CDP screenshot metadata does not match the locally verified bytes.",
        );
      }
      return {
        sha256: digest,
        byteSize: bytes.byteLength,
        capturedAt: new Date().toISOString(),
        bytes: Uint8Array.from(bytes),
      };
    } finally {
      // Once bytes are copied into memory for managed upload, the temporary
      // local artifact must not survive as an untracked evidence copy.
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function exactChannelMaxTab(tabs: readonly ChannelMaxBrowserTab[]): ChannelMaxBrowserTab {
  const matches = tabs.filter((tab) => {
    try {
      const parsed = new URL(tab.url);
      return (
        parsed.protocol === "https:" &&
        parsed.host === CHANNELMAX_BROWSER_HOST &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  });
  if (matches.length === 0) {
    throw new ChannelMaxBrowserWorkerError(
      "CHANNELMAX_TAB_NOT_FOUND",
      "No exact HTTPS selling.channelmax.net tab is open.",
      { exact_match_count: 0 },
    );
  }
  if (matches.length !== 1) {
    throw new ChannelMaxBrowserWorkerError(
      "CHANNELMAX_TAB_AMBIGUOUS",
      "More than one exact ChannelMAX tab is open; the worker refuses to choose.",
      { exact_match_count: matches.length },
    );
  }
  return matches[0];
}

function detectAuthBlocker(text: string): WorkerFailure | null {
  const normalized = text.toLowerCase();
  const checks: Array<[string, RegExp]> = [
    ["CAPTCHA_REQUIRED", /\b(?:captcha|recaptcha|verify you are human)\b/i],
    [
      "TWO_FACTOR_REQUIRED",
      /\b(?:two[- ]factor|2fa|verification code|one[- ]time (?:code|password)|authenticator code)\b/i,
    ],
    [
      "LOGIN_REQUIRED",
      /\b(?:sign in|log in|login|email address.*password|forgot (?:your )?password)\b/i,
    ],
  ];
  for (const [code, pattern] of checks) {
    if (pattern.test(normalized)) {
      return {
        code,
        message: "ChannelMAX requires interactive authentication; worker stopped without interaction.",
        phase: "auth_check",
        authRequired: true,
      };
    }
  }
  return null;
}

function assertSelectedChannelBinding(text: string): void {
  const normalizedPage = text.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedMarker = CHANNELMAX_SELECTED_CHANNEL_MARKER.toLowerCase();
  if (!normalizedPage.includes(normalizedMarker)) {
    throw new ChannelMaxBrowserWorkerError(
      "CHANNELMAX_SELECTED_ACCOUNT_MISMATCH",
      "The exact selected ChannelMAX account marker is missing; worker refused the page.",
      { expected_account_id: CHANNELMAX_BOUND_ACCOUNT_ID },
    );
  }
}

function operationObservation(
  job: QueueJob,
  text: string,
  manualDiscovery?: ChannelMaxManualModelDiscovery,
) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalized = text.toLowerCase();
  const operationPatterns: Record<SupportedOperation, RegExp[]> = {
    SNAPSHOT_INVENTORY: [
      /\binventory\b/i,
      /\bsku\b/i,
      /\brepric(?:e|ing)\b/i,
      /\bselling venue\b/i,
    ],
    DISCOVER_MANUAL_MODEL: [
      /\bmanual\b/i,
      /\brepric(?:e|ing) (?:model|strategy)\b/i,
      /\b44\s*\(?[ab]\)?\b/i,
    ],
  };
  const matchedMarkers = operationPatterns[job.operation]
    .filter((pattern) => pattern.test(normalized))
    .map((pattern) => pattern.source);
  if (matchedMarkers.length === 0) {
    throw new ChannelMaxBrowserWorkerError(
      "UNEXPECTED_CHANNELMAX_VIEW",
      `The active ChannelMAX tab does not visibly match ${job.operation}.`,
      { operation: job.operation },
    );
  }
  let canonicalManual: ChannelMaxManualModel | undefined;
  if (job.operation === "DISCOVER_MANUAL_MODEL") {
    canonicalManual = manualDiscovery?.models.find(
      (model) =>
        model.id === "59021" &&
        model.name.trim().replace(/\s+/g, " ").toLowerCase() ===
          "manual min/max",
    );
    if (!canonicalManual) {
      throw new ChannelMaxBrowserWorkerError(
        "MANUAL_MODEL_NOT_FOUND",
        "The fixed probe did not find the canonical Manual min/max repricing model ID 59021.",
        {
          discovered_model_count: manualDiscovery?.models.length ?? 0,
        },
      );
    }
  }
  return {
    operation: job.operation,
    account_id: job.accountId,
    expected_active_rows: job.expectedActiveRows,
    visible_text_sha256: sha256(text),
    visible_text_bytes: Buffer.byteLength(text, "utf8"),
    visible_nonempty_line_count: lines.length,
    matched_view_markers: matchedMarkers,
    ...(manualDiscovery
      ? {
          manual_model_discovery: {
            selected_site_id: manualDiscovery.selectedSiteId,
            selected_site_name: manualDiscovery.selectedSiteName,
            scanned_nodes: manualDiscovery.scannedNodes,
            models: manualDiscovery.models,
            canonical_manual_model: canonicalManual,
          },
        }
      : {}),
  };
}

function failureFromError(error: unknown, phase: string): WorkerFailure {
  if (error instanceof ChannelMaxBrowserWorkerError) {
    return {
      code: error.code,
      message: error.message,
      phase,
      details: error.details,
    };
  }
  return {
    code: "WORKER_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : "Worker execution failed.",
    phase,
  };
}

export class ChannelMaxBrowserWorker {
  private readonly config: ReturnType<typeof validateConfig>;
  private readonly queue: ChannelMaxQueueClient;
  private readonly cdp: ReadOnlyCdp;
  private readonly logger: WorkerLogger;
  private active = false;

  constructor(
    config: ChannelMaxBrowserWorkerConfig,
    dependencies: {
      fetchImpl?: FetchLike;
      cdp?: ReadOnlyCdp;
      logger?: WorkerLogger;
    } = {},
  ) {
    this.config = validateConfig(config);
    this.logger = dependencies.logger ?? consoleLogger;
    this.queue = new ChannelMaxQueueClient(
      this.config.controlPlaneBaseUrl,
      this.config.jackieApiToken,
      this.config.workerId,
      this.config.leaseSeconds,
      this.config.requestTimeoutMs,
      dependencies.fetchImpl ?? fetch,
    );
    this.cdp =
      dependencies.cdp ??
      new CdpBrowserReadOnlyClient({
        pythonExecutable: this.config.pythonExecutable,
        scriptPath: this.config.cdpScriptPath,
        cdpPort: this.config.cdpPort,
        timeoutMs: this.config.cdpTimeoutMs,
      });
  }

  async runOnce(signal?: AbortSignal): Promise<RunOnceOutcome> {
    assertNotAborted(signal);
    if (this.active) {
      throw new ChannelMaxBrowserWorkerError(
        "WORKER_BUSY",
        "This worker executes only one ChannelMAX job at a time.",
      );
    }
    this.active = true;
    try {
      const claimed = await this.queue.claim(signal);
      if (!claimed) return "NO_JOB";
      let completion: ExecutionResult;
      try {
        completion = await this.executeClaimedJob(claimed, signal);
      } catch (error) {
        if (error instanceof WorkerStoppedError) throw error;
        const failure = failureFromError(error, "execution");
        completion = {
          status: "FAILED",
          message: `${failure.code}: ${failure.message}`,
          result: { blocker: failure },
          evidence: [],
        };
      }
      // Exactly one completion attempt. The worker never replays page work or
      // completion blindly after an uncertain network outcome.
      await this.queue.complete(claimed, completion, signal);
      return "COMPLETED";
    } finally {
      this.active = false;
    }
  }

  private async executeClaimedJob(
    claimed: ClaimedJob,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const { job, leaseToken } = claimed;
    if (job.accountId !== CHANNELMAX_BOUND_ACCOUNT_ID) {
      throw new ChannelMaxBrowserWorkerError(
        "CHANNELMAX_ACCOUNT_ID_MISMATCH",
        "This worker is bound to one exact ChannelMAX account_id.",
        { expected_account_id: CHANNELMAX_BOUND_ACCOUNT_ID },
      );
    }
    if (
      job.operation === "SNAPSHOT_INVENTORY" &&
      job.payload.include_inactive !== false
    ) {
      throw new ChannelMaxBrowserWorkerError(
        "UNSUPPORTED_SNAPSHOT_SCOPE",
        "This fixed read-only probe covers ActiveSKUs only; include_inactive must be false.",
      );
    }
    await this.queue.heartbeat(job.id, leaseToken, "starting", 5, signal);
    await this.queue.event(
      job,
      leaseToken,
      {
        type: "PROGRESS",
        message: `Starting read-only ${job.operation}.`,
        step: "starting",
        progressPercent: 5,
      },
      signal,
    );

    await this.cdp.ping(signal);
    await this.queue.heartbeat(job.id, leaseToken, "browser_connected", 15, signal);
    const tab = exactChannelMaxTab(await this.cdp.tabs(signal));
    await this.queue.heartbeat(job.id, leaseToken, "tab_selected", 25, signal);

    const visibleText = await this.cdp.getText(tab.id, signal);
    const authBlocker = detectAuthBlocker(visibleText);
    await this.queue.heartbeat(job.id, leaseToken, "visible_text_read", 35, signal);
    if (!authBlocker) assertSelectedChannelBinding(visibleText);
    const screenshot = await this.cdp.captureScreenshot(tab.id, signal);
    await this.queue.heartbeat(job.id, leaseToken, "screenshot_captured", 45, signal);
    const screenshotEvidence = await this.queue.uploadManagedEvidence(
      claimed,
      {
        kind: "SCREENSHOT",
        mediaType: "image/png",
        ...screenshot,
      },
      signal,
    );
    await this.queue.heartbeat(job.id, leaseToken, "screenshot_stored", 55, signal);

    if (authBlocker) {
      await this.queue.event(
        job,
        leaseToken,
        {
          type: "AUTH_REQUIRED",
          message: authBlocker.message,
          step: "auth_required",
          progressPercent: 50,
          evidence: [screenshotEvidence],
        },
        signal,
      );
      return {
        status: "FAILED",
        message: `${authBlocker.code}: ${authBlocker.message}`,
        result: {
          blocker: authBlocker,
          evidence_sha256: screenshotEvidence.sha256,
          evidence_uri: screenshotEvidence.uri,
        },
        evidence: [screenshotEvidence],
      };
    }

    let observation: Record<string, unknown>;
    let evidenceDocument: Record<string, unknown>;
    let resultSummary: Record<string, unknown>;
    try {
      if (job.operation === "DISCOVER_MANUAL_MODEL") {
        const manualDiscovery = await this.cdp.discoverManualModels(
          tab.id,
          signal,
        );
        observation = operationObservation(job, visibleText, manualDiscovery);
        evidenceDocument = {
          schema_version: "channelmax-manual-model-discovery/v1",
          captured_at: new Date().toISOString(),
          observation,
        };
        resultSummary = {
          operation: job.operation,
          canonical_manual_model:
            manualDiscovery.models.find(
              (model) =>
                model.id === "59021" &&
                model.name.trim().replace(/\s+/g, " ").toLowerCase() ===
                  "manual min/max",
            ) ?? null,
          discovered_model_count: manualDiscovery.models.length,
        };
      } else {
        const snapshot = await this.cdp.snapshotInventory(tab.id, signal);
        if (snapshot.launchRows.length !== job.expectedActiveRows) {
          throw new ChannelMaxBrowserWorkerError(
            "ACTIVE_ROW_COUNT_MISMATCH",
            "Exact launch-row count does not match the job's expected_active_rows; snapshot refused.",
            {
              expected_active_rows: job.expectedActiveRows,
              observed_active_rows: snapshot.launchRows.length,
            },
          );
        }
        observation = operationObservation(job, visibleText);
        evidenceDocument = {
          schema_version: "channelmax-inventory-snapshot/v1",
          captured_at: new Date().toISOString(),
          account_id: job.accountId,
          expected_active_rows: job.expectedActiveRows,
          requested_include_inactive: job.payload.include_inactive === true,
          query_scope: snapshot.queryScope,
          selected_site_id: snapshot.selectedSiteId,
          selected_site_name: snapshot.selectedSiteName,
          title_total: snapshot.titleTotal,
          loaded_title_rows: snapshot.loadedTitleRows,
          aggregate: snapshot.aggregate,
          launch_rows: snapshot.launchRows,
        };
        resultSummary = {
          operation: job.operation,
          title_total: snapshot.titleTotal,
          loaded_title_rows: snapshot.loadedTitleRows,
          aggregate: snapshot.aggregate,
          query_scope: snapshot.queryScope,
          requested_include_inactive: job.payload.include_inactive === true,
          inactive_rows_included: false,
        };
      }
      await this.queue.heartbeat(
        job.id,
        leaseToken,
        "read_only_probe_complete",
        70,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkerStoppedError) throw error;
      const failure = failureFromError(error, "read_only_probe");
      return {
        status: "FAILED",
        message: `${failure.code}: ${failure.message}`,
        result: {
          blocker: failure,
          screenshot_evidence_uri: screenshotEvidence.uri,
        },
        evidence: [screenshotEvidence],
      };
    }

    const documentArtifact = jsonEvidenceArtifact(evidenceDocument);
    const evidence: ManagedEvidence[] = [screenshotEvidence];
    try {
      await this.queue.heartbeat(
        job.id,
        leaseToken,
        "json_evidence_ready",
        75,
        signal,
      );
      evidence.push(
        await this.queue.uploadManagedEvidence(
          claimed,
          documentArtifact,
          signal,
        ),
      );
      await this.queue.heartbeat(
        job.id,
        leaseToken,
        "evidence_stored",
        90,
        signal,
      );
      await this.queue.event(
        job,
        leaseToken,
        {
          type: "EVIDENCE_CAPTURED",
          message: "Read-only screenshot and canonical JSON are stored and server-verified by SSCC.",
          step: "managed_evidence_stored",
          progressPercent: 90,
          evidence,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof WorkerStoppedError) throw error;
      const failure = failureFromError(error, "managed_evidence");
      return {
        status: "FAILED",
        message: `${failure.code}: ${failure.message}`,
        result: {
          blocker: failure,
          stored_evidence: evidence.map((item) => ({
            kind: item.kind,
            sha256: item.sha256,
            uri: item.uri,
          })),
        },
        evidence,
      };
    }

    return {
      status: "SUCCEEDED",
      message: `${job.operation} completed with SSCC-managed screenshot and canonical JSON evidence.`,
      result: {
        observation,
        summary: resultSummary,
        managed_evidence: evidence.map((item) => ({
          kind: item.kind,
          sha256: item.sha256,
          byte_size: item.byte_size,
          uri: item.uri,
        })),
      },
      evidence,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const outcome = await this.runOnce(signal);
        consecutiveFailures = 0;
        await sleepWithSignal(
          outcome === "NO_JOB" ? this.config.idlePollMs : 250,
          signal,
        );
      } catch (error) {
        if (signal.aborted || error instanceof WorkerStoppedError) return;
        consecutiveFailures += 1;
        const safeMessage = redact(
          error instanceof Error ? error.message : "ChannelMAX worker error.",
          [this.config.jackieApiToken],
        );
        this.logger.error("ChannelMAX worker cycle failed.", {
          error: safeMessage,
          consecutive_failures: consecutiveFailures,
        });
        const delay = Math.min(
          this.config.maxBackoffMs,
          1_000 * 2 ** Math.min(consecutiveFailures - 1, 10),
        );
        await sleepWithSignal(delay, signal);
      }
    }
  }
}

async function sleepWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const consoleLogger: WorkerLogger = {
  info(message, fields) {
    console.info(JSON.stringify({ level: "info", message, ...fields }));
  },
  warn(message, fields) {
    console.warn(JSON.stringify({ level: "warn", message, ...fields }));
  },
  error(message, fields) {
    console.error(JSON.stringify({ level: "error", message, ...fields }));
  },
};
