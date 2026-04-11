import { google } from "googleapis";
import { prisma } from "@/lib/prisma";

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

export const MAX_GMAIL_STORES = 5;

export function isGmailOauthConfigured(): boolean {
  return !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET);
}

// Resolve redirect URI at call time (not module load) so a missing env var in
// production doesn't crash the entire server on import.
// Priority: explicit env → Vercel deployment URL → local dev → error.
function resolveRedirectUri(): string {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api/auth/gmail/callback`;
  }
  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3000/api/auth/gmail/callback";
  }
  throw new Error(
    "GMAIL_REDIRECT_URI is not set. Define it in .env for production deployments."
  );
}

// Default email → store mapping. Used when an OAuth'd email matches a known
// account so we can auto-assign the refresh token to the right store.
const EMAIL_TO_STORE: Record<
  string,
  { storeIndex: number; storeName: string }
> = {
  "amazon@salutem.solutions": { storeIndex: 1, storeName: "Salutem Solutions" },
  "kuzy.vladimir@gmail.com": { storeIndex: 2, storeName: "Vladimir Personal" },
  "amz.commerce@salutem.solutions": { storeIndex: 3, storeName: "AMZ Commerce" },
  "ancienmadina2@gmail.com": { storeIndex: 4, storeName: "Sirius International" },
  "amazon.retailerdistributor@gmail.com": { storeIndex: 5, storeName: "Retailer Distributor" },
};

export function createOAuth2Client(refreshToken?: string) {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    throw new Error(
      "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env (see docs for Google Cloud Console setup)."
    );
  }
  const client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    resolveRedirectUri()
  );
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}

export function getAuthUrl(state?: string): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    state: state || "",
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function getGmailProfile(refreshToken: string): Promise<string> {
  const client = createOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.emailAddress || "";
}

export async function searchMessages(
  refreshToken: string,
  query: string,
  maxResults = 20
) {
  const client = createOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });
  return res.data.messages || [];
}

export async function readMessage(refreshToken: string, messageId: string) {
  const client = createOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Persistent Gmail account storage
// ---------------------------------------------------------------------------
// Refresh tokens are stored in the Setting table (key/value) so that new
// OAuth connections don't require editing .env + restarting the server.
// The legacy `GMAIL_REFRESH_TOKEN_STORE{N}` env vars are still honored as a
// read-only fallback so existing deployments keep working.

const TOKEN_KEY = (i: number) => `gmail_refresh_token_store${i}`;
const EMAIL_KEY = (i: number) => `gmail_email_store${i}`;

export async function saveGmailAccount(
  storeIndex: number,
  refreshToken: string,
  email: string
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: TOKEN_KEY(storeIndex) },
    create: { key: TOKEN_KEY(storeIndex), value: refreshToken },
    update: { value: refreshToken },
  });
  await prisma.setting.upsert({
    where: { key: EMAIL_KEY(storeIndex) },
    create: { key: EMAIL_KEY(storeIndex), value: email },
    update: { value: email },
  });
}

export async function deleteGmailAccount(storeIndex: number): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: { in: [TOKEN_KEY(storeIndex), EMAIL_KEY(storeIndex)] } },
  });
}

async function readStoredAccount(
  storeIndex: number
): Promise<{ refreshToken: string; email: string | null } | null> {
  const [tokenRow, emailRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: TOKEN_KEY(storeIndex) } }),
    prisma.setting.findUnique({ where: { key: EMAIL_KEY(storeIndex) } }),
  ]);
  if (tokenRow?.value) {
    return { refreshToken: tokenRow.value, email: emailRow?.value || null };
  }
  const envToken = process.env[`GMAIL_REFRESH_TOKEN_STORE${storeIndex}`];
  if (envToken) {
    return { refreshToken: envToken, email: null };
  }
  return null;
}

export interface GmailAccountStatus {
  storeIndex: number;
  storeName: string;
  expectedEmail: string | null;
  configured: boolean;
  email: string | null;
  source: "db" | "env" | null;
  error: string | null;
}

/**
 * List the configured status of all Gmail store slots without contacting
 * Google. Safe to call from the Settings UI on every render.
 */
export async function listGmailAccountStatus(): Promise<GmailAccountStatus[]> {
  const expectedByIndex = new Map<
    number,
    { email: string; storeName: string }
  >();
  for (const [email, info] of Object.entries(EMAIL_TO_STORE)) {
    expectedByIndex.set(info.storeIndex, { email, storeName: info.storeName });
  }

  const results: GmailAccountStatus[] = [];
  for (let i = 1; i <= MAX_GMAIL_STORES; i++) {
    const expected = expectedByIndex.get(i) || null;
    const [tokenRow, emailRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: TOKEN_KEY(i) } }),
      prisma.setting.findUnique({ where: { key: EMAIL_KEY(i) } }),
    ]);
    const envToken = process.env[`GMAIL_REFRESH_TOKEN_STORE${i}`];
    if (tokenRow?.value) {
      results.push({
        storeIndex: i,
        storeName: expected?.storeName || `Store ${i}`,
        expectedEmail: expected?.email || null,
        configured: true,
        email: emailRow?.value || null,
        source: "db",
        error: null,
      });
    } else if (envToken) {
      results.push({
        storeIndex: i,
        storeName: expected?.storeName || `Store ${i}`,
        expectedEmail: expected?.email || null,
        configured: true,
        email: null,
        source: "env",
        error: null,
      });
    } else {
      results.push({
        storeIndex: i,
        storeName: expected?.storeName || `Store ${i}`,
        expectedEmail: expected?.email || null,
        configured: false,
        email: null,
        source: null,
        error: null,
      });
    }
  }
  return results;
}

/**
 * Load all connected Gmail accounts and verify each refresh token still
 * works by calling Gmail's profile endpoint. Used by the Messages sync job.
 */
export async function getConnectedGmailAccounts(): Promise<
  Array<{
    storeIndex: number;
    storeName: string;
    email: string;
    refreshToken: string;
  }>
> {
  const accounts = [];
  for (let i = 1; i <= MAX_GMAIL_STORES; i++) {
    const stored = await readStoredAccount(i);
    if (!stored) continue;
    try {
      const email = await getGmailProfile(stored.refreshToken);
      const storeInfo = EMAIL_TO_STORE[email] || {
        storeIndex: i,
        storeName: `Store ${i}`,
      };
      accounts.push({
        ...storeInfo,
        email,
        refreshToken: stored.refreshToken,
      });
    } catch (e) {
      console.error(`Gmail Store${i} auth failed:`, e);
    }
  }
  return accounts;
}

export function getStoreByEmail(email: string) {
  return EMAIL_TO_STORE[email] || null;
}

export { EMAIL_TO_STORE };
