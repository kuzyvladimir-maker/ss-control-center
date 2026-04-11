import { google } from "googleapis";

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

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

// Email → store mapping
const EMAIL_TO_STORE: Record<
  string,
  { storeIndex: number; storeName: string }
> = {
  "amazon@salutem.solutions": { storeIndex: 1, storeName: "Salutem Solutions" },
  "kuzy.vladimir@gmail.com": { storeIndex: 2, storeName: "Vladimir Personal" },
};

export function createOAuth2Client(refreshToken?: string) {
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

export async function getConnectedGmailAccounts(): Promise<
  Array<{
    storeIndex: number;
    storeName: string;
    email: string;
    refreshToken: string;
  }>
> {
  const accounts = [];
  for (let i = 1; i <= 6; i++) {
    const token = process.env[`GMAIL_REFRESH_TOKEN_STORE${i}`];
    if (token) {
      try {
        const email = await getGmailProfile(token);
        const storeInfo = EMAIL_TO_STORE[email] || {
          storeIndex: i,
          storeName: `Store ${i}`,
        };
        accounts.push({ ...storeInfo, email, refreshToken: token });
      } catch (e) {
        console.error(`Gmail Store${i} auth failed:`, e);
      }
    }
  }
  return accounts;
}

export function getStoreByEmail(email: string) {
  return EMAIL_TO_STORE[email] || null;
}

export { EMAIL_TO_STORE };
