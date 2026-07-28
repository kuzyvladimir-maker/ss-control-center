// GET /api/integrations/drive-status
//
// Admin-only diagnostic. Returns the same `configured` / `reason` pair that
// google-drive.ts uses internally, plus a boolean snapshot of which env vars
// are present so the operator can verify what's actually deployed to Vercel
// without spelunking the dashboard. Values themselves are never returned —
// only presence.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import { getDriveStatus } from "@/lib/google-drive";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const status = getDriveStatus();
  const envSnapshot = {
    GOOGLE_OAUTH_CLIENT_ID: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: Boolean(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_OAUTH_REFRESH_TOKEN: Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN),
    GOOGLE_DRIVE_ROOT_FOLDER: Boolean(process.env.GOOGLE_DRIVE_ROOT_FOLDER),
    GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID: Boolean(
      process.env.GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID,
    ),
    // Stale env that confused the operator before: if it's set but OAuth
    // isn't, the operator probably followed the old service-account wiki.
    GOOGLE_SERVICE_ACCOUNT_JSON_PRESENT: Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    ),
  };

  return NextResponse.json({
    ...status,
    env: envSnapshot,
    legacyServiceAccountWarning:
      envSnapshot.GOOGLE_SERVICE_ACCOUNT_JSON_PRESENT &&
      !envSnapshot.GOOGLE_OAUTH_REFRESH_TOKEN
        ? "Legacy GOOGLE_SERVICE_ACCOUNT_JSON env is set but code uses OAuth. Follow wiki/google-drive-setup.md and switch to GOOGLE_OAUTH_* variables, then remove GOOGLE_SERVICE_ACCOUNT_JSON."
        : null,
  });
}
