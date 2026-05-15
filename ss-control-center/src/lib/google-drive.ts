// Google Drive upload for shipping label PDFs.
//
// The original n8n workflow uploaded to a hierarchical structure under
// the folder `Shipping Labels`:
//   MM Month / DD / Channel / <filename>.pdf
//
// Authentication uses a Google service account. The service account
// JSON key must be available as the `GOOGLE_SERVICE_ACCOUNT_JSON` env
// var (single-line JSON or base64-encoded JSON — both handled). The
// target folder (env `GOOGLE_DRIVE_ROOT_FOLDER`) must be shared with
// the service account's email, with at least Editor access.
//
// Behaviour: if either env var is missing or auth fails, every function
// in this module returns `null` and the caller falls back to whatever
// URL is available (typically Veeqo's hosted label URL). The buy flow
// is never blocked by Drive being unavailable.

import { google, type drive_v3 } from "googleapis";
import { Readable } from "stream";

// Lazy-initialised Drive client. Re-used across requests for the
// lifetime of the serverless function instance.
let driveClient: drive_v3.Drive | null = null;
let driveClientError: string | null = null;

function getDriveClient(): drive_v3.Drive | null {
  if (driveClient) return driveClient;
  if (driveClientError) return null;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    driveClientError = "GOOGLE_SERVICE_ACCOUNT_JSON not set";
    return null;
  }

  try {
    // Accept either raw JSON or base64-encoded JSON. Vercel sometimes
    // mangles multi-line env vars; base64 sidesteps that.
    let parsed: Record<string, unknown>;
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      parsed = JSON.parse(trimmed);
    } else {
      const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
      parsed = JSON.parse(decoded);
    }

    // Cast to satisfy GoogleAuth's credentials type without dragging
    // in the deep typing — the runtime accepts any object shaped like
    // a service account key (private_key, client_email, etc.).
    const auth = new google.auth.GoogleAuth({
      credentials: parsed as {
        client_email?: string;
        private_key?: string;
        [k: string]: unknown;
      },
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    driveClient = google.drive({ version: "v3", auth });
    return driveClient;
  } catch (e) {
    driveClientError = `service account parse/auth failed: ${
      e instanceof Error ? e.message : String(e)
    }`;
    console.error("[drive]", driveClientError);
    return null;
  }
}

// Returns the existing folder's id if one named `name` lives directly
// under `parentId`, otherwise creates it and returns the new id. We
// always pass `supportsAllDrives: true` so this works against shared
// drives and "Shared with me" folders both.
async function getOrCreateFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string
): Promise<string | null> {
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
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    return created.data.id ?? null;
  } catch (e) {
    console.error(
      `[drive] getOrCreateFolder(${name}) failed:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

// Walk a path like "04 April/07/Amazon", creating folders as needed,
// and return the leaf folder id (or null on failure).
async function resolveFolderPath(
  drive: drive_v3.Drive,
  rootId: string,
  segments: string[]
): Promise<string | null> {
  let current = rootId;
  for (const seg of segments) {
    const next = await getOrCreateFolder(drive, current, seg);
    if (!next) return null;
    current = next;
  }
  return current;
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
  const drive = getDriveClient();
  if (!drive) {
    return { ok: false, reason: driveClientError ?? "Drive client unavailable" };
  }

  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER;
  if (!rootId) {
    return { ok: false, reason: "GOOGLE_DRIVE_ROOT_FOLDER not set" };
  }

  try {
    const folderId = await resolveFolderPath(
      drive,
      rootId,
      params.folderSegments
    );
    if (!folderId) {
      return {
        ok: false,
        reason: `Could not resolve folder path: ${params.folderSegments.join("/")}`,
      };
    }

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

// Diagnostic — returns the reason Drive is unconfigured, if any. Useful
// for surfacing "not set up" warnings in the UI without leaking the
// service account JSON itself.
export function getDriveStatus(): {
  configured: boolean;
  reason: string | null;
} {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { configured: false, reason: "GOOGLE_SERVICE_ACCOUNT_JSON not set" };
  }
  if (!process.env.GOOGLE_DRIVE_ROOT_FOLDER) {
    return { configured: false, reason: "GOOGLE_DRIVE_ROOT_FOLDER not set" };
  }
  if (driveClientError) {
    return { configured: false, reason: driveClientError };
  }
  return { configured: true, reason: null };
}
