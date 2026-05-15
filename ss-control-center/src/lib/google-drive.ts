// Google Drive upload for shipping label PDFs.
//
// The original n8n workflow uploaded to a hierarchical structure under
// the folder `Shipping Labels`:
//   MM Month / DD / Channel / <filename>.pdf
//
// Authentication uses OAuth2 on behalf of a real Google user.
// We tried a service account first but personal-Gmail Drive doesn't
// allow service accounts to actually write — they don't have any
// storage quota of their own and you'd need Workspace Shared Drives
// for that to work, which kuzy.vladimir@gmail.com (the folder owner)
// doesn't have. So we fell back to the same approach Jackie's n8n
// flow uses: OAuth refresh token on behalf of that same user.
//
// Required env vars:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN  (with scope auth/drive or auth/drive.file)
//   GOOGLE_DRIVE_ROOT_FOLDER    (or GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID)
//
// Behaviour: if anything is missing or auth fails, uploadLabelPdf
// returns `{ ok: false, reason }` with a human-readable explanation,
// and the buy flow falls back to the `/api/shipping/label-pdf` proxy
// (label still purchasable, just not archived to Drive).

import { google, type drive_v3 } from "googleapis";
import { Readable } from "stream";

// Lazy-initialised Drive client. Re-used across requests for the
// lifetime of the serverless function instance. We never cache the
// failure case any more — env vars or token state can change between
// invocations and a permanent sticky failure mode is worse than
// retrying.
let driveClient: drive_v3.Drive | null = null;

function getDriveRootFolderId(): string | null {
  return (
    process.env.GOOGLE_DRIVE_ROOT_FOLDER ||
    process.env.GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID ||
    null
  );
}

type DriveClientOutcome =
  | { ok: true; drive: drive_v3.Drive }
  | { ok: false; reason: string };

function getDriveClient(): DriveClientOutcome {
  if (driveClient) return { ok: true, drive: driveClient };

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (missing.length) {
    return { ok: false, reason: `${missing.join(", ")} not set` };
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    driveClient = google.drive({ version: "v3", auth });
    return { ok: true, drive: driveClient };
  } catch (e) {
    return {
      ok: false,
      reason: `OAuth client init failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

// Returns the existing folder's id if one named `name` lives directly
// under `parentId`, otherwise creates it and returns the new id.
type FolderOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: string };

async function getOrCreateFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string
): Promise<FolderOutcome> {
  try {
    // Escape single-quotes in the folder name for the search query so
    // names like "FedEx One Rate" don't break the query syntax.
    const safeName = name.replace(/'/g, "\\'");
    const list = await drive.files.list({
      q:
        `name = '${safeName}' and ` +
        `mimeType = 'application/vnd.google-apps.folder' and ` +
        `'${parentId}' in parents and trashed = false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existing = list.data.files?.[0]?.id;
    if (existing) return { ok: true, id: existing };

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    const newId = created.data.id;
    if (!newId) {
      return {
        ok: false,
        reason: `create returned no id for "${name}"`,
      };
    }
    return { ok: true, id: newId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[drive] getOrCreateFolder(${name}) failed:`, msg);
    return { ok: false, reason: `"${name}": ${msg}` };
  }
}

// Walk a path like "04 April/07/Amazon", creating folders as needed.
// Returns leaf id on success or a reason string with the *specific*
// segment that failed — silent nulls made it impossible for the
// operator to tell whether the failure was scope/auth, an existing-
// folder ownership issue, or quota.
async function resolveFolderPath(
  drive: drive_v3.Drive,
  rootId: string,
  segments: string[]
): Promise<FolderOutcome> {
  let current = rootId;
  for (const seg of segments) {
    const next = await getOrCreateFolder(drive, current, seg);
    if (!next.ok) return next;
    current = next.id;
  }
  return { ok: true, id: current };
}

export interface DriveUploadResult {
  fileId: string;
  webViewLink: string;
}

export type DriveUploadOutcome =
  | { ok: true; result: DriveUploadResult }
  | { ok: false; reason: string };

// Upload a PDF buffer to Drive under <root>/<...folderSegments>/<filename>.
// Returns a discriminated outcome — on failure, `reason` carries a short
// human-readable explanation that callers can surface to the operator
// (UI modal, audit log) so silent failures don't disappear into Vercel
// logs they can't see.
export async function uploadLabelPdf(params: {
  folderSegments: string[]; // e.g. ["04 April", "07", "Amazon"]
  filename: string;
  pdf: Buffer;
}): Promise<DriveUploadOutcome> {
  const driveOutcome = getDriveClient();
  if (!driveOutcome.ok) return { ok: false, reason: driveOutcome.reason };
  const drive = driveOutcome.drive;

  const rootId = getDriveRootFolderId();
  if (!rootId) {
    return {
      ok: false,
      reason:
        "GOOGLE_DRIVE_ROOT_FOLDER not set (or GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID)",
    };
  }

  try {
    const folderOutcome = await resolveFolderPath(
      drive,
      rootId,
      params.folderSegments
    );
    if (!folderOutcome.ok) {
      return {
        ok: false,
        reason: `Could not resolve ${params.folderSegments.join("/")} — ${folderOutcome.reason}`,
      };
    }
    const folderId = folderOutcome.id;

    const res = await drive.files.create({
      requestBody: {
        name: params.filename,
        parents: [folderId],
      },
      media: {
        mimeType: "application/pdf",
        // googleapis accepts a Readable stream for media uploads;
        // wrapping the buffer avoids loading the whole thing twice.
        body: Readable.from(params.pdf),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    const fileId = res.data.id;
    const webViewLink = res.data.webViewLink;
    if (!fileId || !webViewLink) {
      return {
        ok: false,
        reason: "Drive create returned without id or webViewLink",
      };
    }
    return { ok: true, result: { fileId, webViewLink } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[drive] uploadLabelPdf failed:", msg);
    return { ok: false, reason: msg };
  }
}

// Diagnostic — returns the reason Drive is unconfigured, if any. Used
// by /api/integrations so the operator can see configuration health
// without spelunking server logs.
export function getDriveStatus(): {
  configured: boolean;
  reason: string | null;
} {
  const missing: string[] = [];
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET)
    missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN)
    missing.push("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (missing.length) {
    return { configured: false, reason: `${missing.join(", ")} not set` };
  }
  if (!getDriveRootFolderId()) {
    return {
      configured: false,
      reason:
        "GOOGLE_DRIVE_ROOT_FOLDER not set (or GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID)",
    };
  }
  return { configured: true, reason: null };
}
