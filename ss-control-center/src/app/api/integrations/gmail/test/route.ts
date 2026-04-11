import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  createOAuth2Client,
  MAX_GMAIL_STORES,
  isGmailOauthConfigured,
} from "@/lib/gmail-api";
import { google } from "googleapis";

// GET /api/integrations/gmail/test
// Pings every connected Gmail account by fetching profile + message count
// against the Amazon buyer-message query. Used by the Settings UI to verify
// all stored refresh tokens still work and how much mail is waiting to sync.

interface TestResult {
  storeIndex: number;
  ok: boolean;
  email: string | null;
  messagesTotal: number | null;
  buyerMessagesLast2d: number | null;
  error: string | null;
}

async function testAccount(
  storeIndex: number,
  refreshToken: string
): Promise<TestResult> {
  try {
    const client = createOAuth2Client(refreshToken);
    const gmail = google.gmail({ version: "v1", auth: client });

    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress || null;
    const messagesTotal = profile.data.messagesTotal ?? null;

    // Count buyer messages from the last 2 days so the user sees "sync will
    // pull ~X messages" rather than just "connection works".
    const search = await gmail.users.messages.list({
      userId: "me",
      q: `from:marketplace.amazon.com newer_than:2d`,
      maxResults: 50,
    });
    const buyerMessagesLast2d = search.data.messages?.length ?? 0;

    return {
      storeIndex,
      ok: true,
      email,
      messagesTotal,
      buyerMessagesLast2d,
      error: null,
    };
  } catch (err) {
    return {
      storeIndex,
      ok: false,
      email: null,
      messagesTotal: null,
      buyerMessagesLast2d: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function GET() {
  if (!isGmailOauthConfigured()) {
    return NextResponse.json(
      { error: "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env." },
      { status: 400 }
    );
  }

  // Load stored refresh tokens from Setting table (with env fallback) in one
  // pass, then test each in parallel — 5 Gmail API round trips instead of 5
  // sequential ones.
  const tests: Promise<TestResult>[] = [];
  for (let i = 1; i <= MAX_GMAIL_STORES; i++) {
    const tokenRow = await prisma.setting.findUnique({
      where: { key: `gmail_refresh_token_store${i}` },
    });
    const token = tokenRow?.value || process.env[`GMAIL_REFRESH_TOKEN_STORE${i}`];
    if (token) {
      tests.push(testAccount(i, token));
    }
  }

  const results = await Promise.all(tests);
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };

  return NextResponse.json({ summary, results });
}
