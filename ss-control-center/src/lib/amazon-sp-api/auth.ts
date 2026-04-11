/**
 * Amazon SP-API Authentication
 * Per-store credentials: AMAZON_SP_CLIENT_ID_STORE{N}, SECRET, REFRESH_TOKEN
 * Falls back to shared AMAZON_SP_CLIENT_ID / AMAZON_SP_CLIENT_SECRET if per-store not set
 */

const LWA_ENDPOINT = "https://api.amazon.com/auth/o2/token";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

interface StoreCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Get credentials for a store index (1-5). Per-store vars take priority over shared. */
export function getStoreCredentials(storeIndex: number): StoreCredentials | null {
  const n = storeIndex;
  const refreshToken =
    process.env[`AMAZON_SP_REFRESH_TOKEN_STORE${n}`];
  if (!refreshToken) return null;

  const clientId =
    process.env[`AMAZON_SP_CLIENT_ID_STORE${n}`] ||
    process.env.AMAZON_SP_CLIENT_ID;
  const clientSecret =
    process.env[`AMAZON_SP_CLIENT_SECRET_STORE${n}`] ||
    process.env.AMAZON_SP_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  return { clientId, clientSecret, refreshToken };
}

/** Exchange refresh token for access token via LWA */
async function exchangeToken(creds: StoreCredentials): Promise<string> {
  const response = await fetch(LWA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `LWA auth failed: ${error.error_description || error.error}`
    );
  }

  const data = await response.json();
  return data.access_token;
}

/** Get cached access token for a storeId like "store1" */
export async function getCachedAccessToken(storeId: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(storeId);

  if (cached && cached.expiresAt > now + 5 * 60 * 1000) {
    return cached.token;
  }

  const match = storeId.match(/^store([1-5])$/);
  if (!match) {
    throw new Error(
      `Invalid storeId "${storeId}". Expected "store1"–"store5".`
    );
  }
  const index = parseInt(match[1], 10);
  const creds = getStoreCredentials(index);
  if (!creds) {
    throw new Error(`No credentials configured for ${storeId}`);
  }

  const accessToken = await exchangeToken(creds);

  tokenCache.set(storeId, {
    token: accessToken,
    expiresAt: now + 55 * 60 * 1000,
  });

  return accessToken;
}

/** Get access token by raw refresh token.
 *  Only succeeds if the refresh token matches a configured store — no silent
 *  fallback to STORE1, because LWA client credentials must match the app that
 *  issued the refresh token (using another store's creds would either fail or,
 *  worse, dereference the wrong account if apps happen to share credentials).
 */
export async function getAccessToken(refreshToken: string): Promise<string> {
  for (let i = 1; i <= 5; i++) {
    const creds = getStoreCredentials(i);
    if (creds && creds.refreshToken === refreshToken) {
      return exchangeToken(creds);
    }
  }
  throw new Error(
    "No matching store credentials found for the provided refresh token. " +
    "Ensure AMAZON_SP_REFRESH_TOKEN_STORE{N} is set and matches the token in use."
  );
}

/** Get list of configured store IDs */
export function getConfiguredStores(): string[] {
  const result: string[] = [];
  for (let i = 1; i <= 5; i++) {
    if (getStoreCredentials(i)) {
      result.push(`store${i}`);
    }
  }
  return result;
}
