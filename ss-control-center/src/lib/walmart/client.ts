/**
 * Walmart Marketplace API client.
 *
 * - OAuth 2.0 client_credentials flow against /v3/token (Basic Auth header).
 * - Cached access token, refreshes 60s before expiry.
 * - Rate-limit aware: respects x-current-token-count + x-next-replenish-time
 *   (sleeps automatically if tokens < 2). Exponential backoff on 429/5xx.
 * - Adds the full required header set (Authorization + WM_SEC.ACCESS_TOKEN
 *   + WM_QOS.CORRELATION_ID per request + WM_SVC.NAME + Accept) on every call.
 *
 * Per-store credentials: WALMART_CLIENT_ID_STORE{N},
 * WALMART_CLIENT_SECRET_STORE{N}, WALMART_STORE{N}_NAME,
 * WALMART_STORE{N}_SELLER_ID. Construct WalmartClient(storeIndex).
 */

import { randomUUID } from "crypto";

const DEFAULT_BASE_URL =
  process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";
const API_VERSION = process.env.WALMART_API_VERSION || "v3";
const SVC_NAME = "Walmart Marketplace";

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry
const MIN_TOKENS_BEFORE_SLEEP = 2;
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface WalmartCredentials {
  clientId: string;
  clientSecret: string;
  sellerId: string;
  storeName: string;
}

export interface WalmartTokenInfo {
  accessToken: string;
  expiresAt: Date;
}

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Override Accept header (default application/json). */
  accept?: string;
  /** Return raw Response (e.g. for binary downloads like XLSX). */
  raw?: boolean;
  /** Extra headers to merge in. */
  headers?: Record<string, string>;
}

export class WalmartApiError extends Error {
  status: number;
  path: string;
  correlationId: string;
  errorBody: unknown;

  constructor(args: {
    status: number;
    path: string;
    correlationId: string;
    errorBody: unknown;
    message?: string;
  }) {
    super(
      args.message ||
        `Walmart API ${args.status} on ${args.path} (cid=${args.correlationId})`
    );
    this.name = "WalmartApiError";
    this.status = args.status;
    this.path = args.path;
    this.correlationId = args.correlationId;
    this.errorBody = args.errorBody;
  }
}

function getCredentials(storeIndex: number): WalmartCredentials {
  const n = storeIndex;
  const clientId = process.env[`WALMART_CLIENT_ID_STORE${n}`];
  const clientSecret = process.env[`WALMART_CLIENT_SECRET_STORE${n}`];
  const sellerId = process.env[`WALMART_STORE${n}_SELLER_ID`];
  const storeName =
    process.env[`WALMART_STORE${n}_NAME`] || `Walmart Store ${n}`;

  if (!clientId || !clientSecret || !sellerId) {
    throw new Error(
      `Walmart credentials missing for store ${n}. ` +
        `Set WALMART_CLIENT_ID_STORE${n}, WALMART_CLIENT_SECRET_STORE${n}, ` +
        `WALMART_STORE${n}_SELLER_ID in env.`
    );
  }

  return { clientId, clientSecret, sellerId, storeName };
}

/** Sleep helper with jitter for backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQueryString(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [k, v] of entries) {
    search.append(k, String(v));
  }
  return `?${search.toString()}`;
}

export class WalmartClient {
  readonly storeIndex: number;
  readonly credentials: WalmartCredentials;
  private token: WalmartTokenInfo | null = null;
  /** Wait until this Date before issuing the next request (rate-limit aware). */
  private rateLimitWaitUntil: Date | null = null;

  constructor(storeIndex = 1) {
    this.storeIndex = storeIndex;
    this.credentials = getCredentials(storeIndex);
  }

  /** Get a cached or fresh access token. Refreshed 60s before expiry. */
  async getAccessToken(): Promise<WalmartTokenInfo> {
    const now = Date.now();
    if (
      this.token &&
      this.token.expiresAt.getTime() > now + TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.token;
    }

    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`
    ).toString("base64");

    const correlationId = randomUUID();
    const url = `${DEFAULT_BASE_URL}/${API_VERSION}/token`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "WM_QOS.CORRELATION_ID": correlationId,
        "WM_SVC.NAME": SVC_NAME,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new WalmartApiError({
        status: res.status,
        path: "/token",
        correlationId,
        errorBody: errBody,
        message: `Walmart token request failed: ${res.status} ${errBody.slice(0, 200)}`,
      });
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + (json.expires_in - 60) * 1000);
    this.token = { accessToken: json.access_token, expiresAt };

    console.log(
      `[WALMART][STORE${this.storeIndex}] token issued, expires at ${expiresAt.toISOString()}`
    );

    return this.token;
  }

  /** Issue a request to the Walmart API. Path should NOT include the /v3 prefix. */
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const tokenInfo = await this.getAccessToken();

    // Rate-limit gate — sleep if previous response told us we're nearly out
    if (this.rateLimitWaitUntil) {
      const waitMs = this.rateLimitWaitUntil.getTime() - Date.now();
      if (waitMs > 0) {
        console.warn(
          `[WALMART][STORE${this.storeIndex}] rate-limit wait ${waitMs}ms before ${method} ${path}`
        );
        await sleep(waitMs);
      }
      this.rateLimitWaitUntil = null;
    }

    const queryString = buildQueryString(options.params);
    const fullPath = `/${API_VERSION}${path.startsWith("/") ? path : `/${path}`}${queryString}`;
    const url = `${DEFAULT_BASE_URL}${fullPath}`;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const correlationId = randomUUID();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokenInfo.accessToken}`,
        "WM_SEC.ACCESS_TOKEN": tokenInfo.accessToken,
        "WM_QOS.CORRELATION_ID": correlationId,
        "WM_SVC.NAME": SVC_NAME,
        Accept: options.accept || "application/json",
        ...options.headers,
      };

      let body: BodyInit | undefined;
      if (options.body !== undefined) {
        if (typeof options.body === "string") {
          body = options.body;
        } else {
          body = JSON.stringify(options.body);
          headers["Content-Type"] = "application/json";
        }
      }

      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(
            BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 250,
            BACKOFF_MAX_MS
          );
          console.warn(
            `[WALMART][STORE${this.storeIndex}] network error on ${method} ${fullPath}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const elapsed = Date.now() - startedAt;
      const tokensLeft = res.headers.get("x-current-token-count");
      const replenishAt = res.headers.get("x-next-replenish-time");

      console.log(
        `[WALMART][STORE${this.storeIndex}] ${method} ${fullPath} → ${res.status} ` +
          `(tokens: ${tokensLeft ?? "?"}, ${elapsed}ms, cid=${correlationId})`
      );

      // Schedule a wait for next request if we're running low
      if (tokensLeft !== null && replenishAt) {
        const remaining = parseInt(tokensLeft, 10);
        if (Number.isFinite(remaining) && remaining < MIN_TOKENS_BEFORE_SLEEP) {
          const replenishMs = parseInt(replenishAt, 10);
          if (Number.isFinite(replenishMs) && replenishMs > Date.now()) {
            this.rateLimitWaitUntil = new Date(replenishMs);
          }
        }
      }

      if (res.ok) {
        if (options.raw) return res as unknown as T;
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }

      // 401 — token might have died early; clear cache and retry once
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        const fresh = await this.getAccessToken();
        tokenInfo.accessToken = fresh.accessToken;
        continue;
      }

      // Retry on 429 / 5xx
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        let delay = Math.min(
          BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 250,
          BACKOFF_MAX_MS
        );
        // Honor Retry-After if present
        const retryAfter = res.headers.get("retry-after");
        if (retryAfter) {
          const ra = parseInt(retryAfter, 10);
          if (Number.isFinite(ra)) delay = Math.max(delay, ra * 1000);
        }
        console.warn(
          `[WALMART][STORE${this.storeIndex}] ${res.status} on ${fullPath}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
        );
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      const errBody = await res.text().catch(() => "");
      let parsed: unknown = errBody;
      try {
        parsed = JSON.parse(errBody);
      } catch {
        // not JSON
      }
      throw new WalmartApiError({
        status: res.status,
        path: fullPath,
        correlationId,
        errorBody: parsed,
      });
    }

    throw (
      lastError ||
      new Error(`Walmart request failed after ${MAX_RETRIES} retries: ${method} ${url}`)
    );
  }
}

let cachedDefaultClient: WalmartClient | null = null;

/** Convenience accessor for the default store (index 1). */
export function getWalmartClient(storeIndex = 1): WalmartClient {
  if (storeIndex === 1) {
    if (!cachedDefaultClient) cachedDefaultClient = new WalmartClient(1);
    return cachedDefaultClient;
  }
  return new WalmartClient(storeIndex);
}
