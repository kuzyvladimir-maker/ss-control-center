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

// Email → store mapping is resolved dynamically from the Setting table
// (gmail_email_storeN keys populated during OAuth) paired with STORE{N}_NAME
// env vars for display labels. See `loadEmailToStoreMap()` below.

export interface EmailToStoreInfo {
  storeIndex: number;
  storeName: string;
}

export type EmailToStoreMap = Map<string, EmailToStoreInfo>;

function storeNameForIndex(i: number): string {
  return process.env[`STORE${i}_NAME`] || `Store ${i}`;
}

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

/** Read a thread with all its messages. Used to detect whether a buyer
 * message has already been responded to — when the seller replies via
 * Amazon Seller Central, Amazon sends a confirmation email to the seller
 * Gmail inbox which lands in the same thread. Thread size > 1 is our
 * heuristic for "already handled". `format: metadata` is enough — we only
 * need message IDs, not full bodies, and it's much cheaper. */
export async function readThread(refreshToken: string, threadId: string) {
  const client = createOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
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

/**
 * Build email → store mapping from the Setting table. Call this once per
 * sync job and pass the result into parseAmazonBuyerEmail so lookups are
 * O(1) without hitting the DB per message.
 */
export async function loadEmailToStoreMap(): Promise<EmailToStoreMap> {
  const map: EmailToStoreMap = new Map();
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: Array.from({ length: MAX_GMAIL_STORES }, (_, idx) =>
          EMAIL_KEY(idx + 1)
        ),
      },
    },
  });
  for (const row of rows) {
    // key is "gmail_email_storeN" — parse out N
    const match = row.key.match(/gmail_email_store(\d+)/);
    if (!match) continue;
    const storeIndex = parseInt(match[1], 10);
    if (!row.value) continue;
    map.set(row.value.toLowerCase(), {
      storeIndex,
      storeName: storeNameForIndex(storeIndex),
    });
  }
  return map;
}

/** Case-insensitive lookup against a pre-loaded map. */
export function lookupStoreByEmail(
  email: string,
  map: EmailToStoreMap
): EmailToStoreInfo | null {
  return map.get(email.toLowerCase()) || null;
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
 *
 * storeName comes from STORE{N}_NAME env var (operator-controlled label).
 * email comes from the Setting table (set during OAuth) with env fallback.
 */
export async function listGmailAccountStatus(): Promise<GmailAccountStatus[]> {
  const results: GmailAccountStatus[] = [];
  for (let i = 1; i <= MAX_GMAIL_STORES; i++) {
    const storeName = storeNameForIndex(i);
    const [tokenRow, emailRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: TOKEN_KEY(i) } }),
      prisma.setting.findUnique({ where: { key: EMAIL_KEY(i) } }),
    ]);
    const envToken = process.env[`GMAIL_REFRESH_TOKEN_STORE${i}`];
    const storedEmail = emailRow?.value || null;

    if (tokenRow?.value) {
      results.push({
        storeIndex: i,
        storeName,
        expectedEmail: storedEmail,
        configured: true,
        email: storedEmail,
        source: "db",
        error: null,
      });
    } else if (envToken) {
      results.push({
        storeIndex: i,
        storeName,
        expectedEmail: storedEmail,
        configured: true,
        email: null,
        source: "env",
        error: null,
      });
    } else {
      results.push({
        storeIndex: i,
        storeName,
        expectedEmail: storedEmail,
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
 *
 * Store metadata comes from STORE{N}_NAME env var, not from the legacy
 * hardcoded EMAIL_TO_STORE constant.
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
      accounts.push({
        storeIndex: i,
        storeName: storeNameForIndex(i),
        email,
        refreshToken: stored.refreshToken,
      });
    } catch (e) {
      console.error(`Gmail Store${i} auth failed:`, e);
    }
  }
  return accounts;
}
