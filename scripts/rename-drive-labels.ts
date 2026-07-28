/**
 * rename-drive-labels.ts — strip the legacy "[FROZEN-RISK …]" prefix from
 * shipping-label PDF filenames already saved in Google Drive.
 *
 * Dry-run (default): lists what WOULD be renamed, changes nothing.
 * Apply:            pass `--apply` to actually rename.
 *
 * Run: cd ss-control-center && npx tsx scripts/rename-drive-labels.ts [--apply]
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
// Google OAuth creds live only in Vercel prod env — pull with
// `vercel env pull --environment=production /tmp/ss-prod.env` first.
dotenvConfig({ path: "/tmp/ss-prod.env" });
import { google } from "googleapis";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all"); // ignore the date filter, do every prefixed file
const PREFIX_RE = /^\[FROZEN-RISK[^\]]*\]\s*/;
// Only touch files created today (Eastern) unless --all. Drive createdTime is
// UTC; 2026-06-12T00:00:00Z safely covers all of 6/12 Eastern.
const SINCE = "2026-06-12T00:00:00";

function getDrive() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN in env");
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
}

async function main() {
  const drive = getDrive();
  console.log(`\nMode: ${APPLY ? "APPLY (renaming)" : "DRY-RUN (no changes)"}\n`);

  // All non-trashed files whose name contains the legacy prefix marker.
  let pageToken: string | undefined;
  const hits: { id: string; name: string }[] = [];
  do {
    const res = await drive.files.list({
      q:
        "name contains 'FROZEN-RISK' and trashed = false" +
        (ALL ? "" : ` and createdTime > '${SINCE}'`),
      fields: "nextPageToken, files(id, name)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name && PREFIX_RE.test(f.name)) hits.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (hits.length === 0) {
    console.log("No files with a [FROZEN-RISK …] prefix found.");
    return;
  }
  console.log(`Found ${hits.length} file(s):\n`);
  let renamed = 0;
  for (const f of hits) {
    const newName = f.name.replace(PREFIX_RE, "");
    if (newName === f.name) continue;
    console.log(`  OLD: ${f.name}`);
    console.log(`  NEW: ${newName}`);
    if (APPLY) {
      await drive.files.update({
        fileId: f.id,
        requestBody: { name: newName },
        supportsAllDrives: true,
      });
      renamed++;
      console.log("       ✓ renamed");
    }
    console.log();
  }
  console.log(
    APPLY
      ? `Done — ${renamed} renamed.`
      : `Dry-run — ${hits.length} would be renamed. Re-run with --apply to do it.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
