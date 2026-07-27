import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ProductTruthDatabaseTarget {
  kind: "local" | "remote";
  clientUrl: string;
  displayUrl: string;
  fingerprint: string;
  localPath: string | null;
}

export class ProductTruthDatabaseTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthDatabaseTargetError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthDatabaseTargetError(code, message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLocalFileUrl(rawUrl: string, cwd: string): string {
  if (rawUrl === "file::memory:" || rawUrl.startsWith("file::memory:?")) {
    return rawUrl;
  }
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath) fail("DATABASE_URL_INVALID", "file: URL has no path");
  if (rawPath.startsWith("//")) {
    const parsed = new URL(rawUrl);
    if (parsed.search || parsed.hash) {
      fail(
        "DATABASE_URL_PARAMETERS_FORBIDDEN",
        "local database URL query parameters and fragments are forbidden",
      );
    }
    return parsed.href;
  }
  if (/[?#]/.test(rawPath)) {
    fail(
      "DATABASE_URL_PARAMETERS_FORBIDDEN",
      "local database URL query parameters and fragments are forbidden",
    );
  }
  return pathToFileURL(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)).href;
}

/**
 * Canonical Product Truth database identity. Authentication material is never
 * included in the URL or fingerprint and must be supplied out of band.
 */
export function resolveProductTruthDatabaseTarget(
  databaseUrl: string,
  cwd = process.cwd(),
): ProductTruthDatabaseTarget {
  const trimmed = databaseUrl.trim();
  if (!trimmed) fail("DATABASE_URL_REQUIRED", "database URL is empty");

  if (trimmed.startsWith("file:")) {
    const clientUrl = normalizeLocalFileUrl(trimmed, cwd);
    let localPath: string | null = null;
    if (!clientUrl.startsWith("file::memory:")) {
      try {
        localPath = fileURLToPath(clientUrl);
      } catch {
        fail(
          "DATABASE_URL_INVALID",
          "local database URL must resolve to one exact filesystem path",
        );
      }
    }
    return {
      kind: "local",
      clientUrl,
      displayUrl: clientUrl,
      fingerprint: sha256(clientUrl),
      localPath,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(
      "DATABASE_URL_INVALID",
      "database URL must be an explicit file: or libSQL-compatible remote URL",
    );
  }
  if (!["libsql:", "https:", "wss:"].includes(parsed.protocol)) {
    fail(
      "DATABASE_URL_SCHEME_FORBIDDEN",
      `unsupported database URL scheme ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    fail(
      "DATABASE_URL_CREDENTIALS_FORBIDDEN",
      "credentials must not be embedded in the database URL",
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:auth|token|secret|password|api[_-]?key)/i.test(key)) {
      fail(
        "DATABASE_URL_CREDENTIALS_FORBIDDEN",
        "remote database credentials must be supplied outside the database URL",
      );
    }
  }
  if (parsed.search || parsed.hash) {
    fail(
      "DATABASE_URL_PARAMETERS_FORBIDDEN",
      "remote database URL query parameters and fragments are forbidden",
    );
  }
  const clientUrl = parsed.href;
  const display = new URL(clientUrl);
  display.search = "";
  return {
    kind: "remote",
    clientUrl,
    displayUrl: display.href,
    fingerprint: sha256(clientUrl),
    localPath: null,
  };
}
