/**
 * Amazon SP-API base HTTP client
 * Handles authentication, retries, and rate limiting
 */

import { getCachedAccessToken } from "./auth";

// Some deploy platforms (incl. Vercel via UI copy-paste) silently keep
// wrapping quotes or trailing newlines on env values. A stray newline in
// MARKETPLACE_ID makes Amazon's /orders endpoint return an empty list —
// no error, just zero rows — which is hard to spot. Strip defensively.
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.trim().replace(/^['"]|['"]$/g, "");
}

const SP_API_ENDPOINT =
  cleanEnv(process.env.AMAZON_SP_ENDPOINT) ||
  "https://sellingpartnerapi-na.amazon.com";

export const MARKETPLACE_ID =
  cleanEnv(process.env.AMAZON_SP_MARKETPLACE_ID) || "ATVPDKIKX0DER";

export interface SpApiOptions {
  storeId?: string;
  params?: Record<string, string>;
  body?: object;
  retries?: number;
}

export async function spApiGet(
  path: string,
  options: SpApiOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return spApiRequest("GET", path, options);
}

export async function spApiPost(
  path: string,
  body: object,
  options: SpApiOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return spApiRequest("POST", path, { ...options, body });
}

export async function spApiPatch(
  path: string,
  body: object,
  options: SpApiOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return spApiRequest("PATCH", path, { ...options, body });
}

// PUT for the Listings Items 2021-08-01 "create-or-replace" endpoint
// (Phase 2.5 Distribution). PUT is idempotent per Amazon docs: identical
// payloads to the same SKU produce the same submission_id on the second
// call, so re-running publish on an already-LIVE SKU is a safe no-op.
export async function spApiPut(
  path: string,
  body: object,
  options: SpApiOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return spApiRequest("PUT", path, { ...options, body });
}

async function spApiRequest(
  method: string,
  path: string,
  options: SpApiOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { storeId = "store1", params, body, retries = 3 } = options;

  const accessToken = await getCachedAccessToken(storeId);

  const url = new URL(SP_API_ENDPOINT + path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, v);
      }
    });
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
          "user-agent": "SS-Control-Center/1.0",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(
          response.headers.get("retry-after") || "5"
        );
        console.warn(
          `SP-API rate limited, waiting ${retryAfter}s (attempt ${attempt}/${retries})`
        );
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: response.statusText }));
        throw new Error(
          `SP-API ${response.status} on ${method} ${path}: ${JSON.stringify(error)}`
        );
      }

      if (response.status === 204) return null;

      return await response.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
