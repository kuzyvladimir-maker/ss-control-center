import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { canonicalWalmartItemReportJson } from "./item-report-published-source.ts";

export const WALMART_EXTERNAL_OWNER_ARTIFACT_MAX_BYTES = 256 * 1024;

export interface ReadCanonicalWalmartExternalOwnerArtifactFileInput {
  artifact_path: string;
  expected_sha256: string;
  repository_root: string;
  capture_root: string;
  maximum_bytes?: number;
}

export interface CanonicalWalmartExternalOwnerArtifactFile {
  artifact_path: string;
  artifact_sha256: string;
  byte_length: number;
  artifact_bytes: Uint8Array;
  canonical_json: string;
  value: Record<string, unknown>;
}

export class WalmartExternalOwnerArtifactFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartExternalOwnerArtifactFileError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartExternalOwnerArtifactFileError(code, message);
}

function exactAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail("INVALID_EXTERNAL_ARTIFACT_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return value;
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(
      "INVALID_EXTERNAL_ARTIFACT_INPUT",
      "expected_sha256 must be a lowercase SHA-256 digest",
    );
  }
  return value;
}

function maximumBytes(value: unknown): number {
  const parsed = value ?? WALMART_EXTERNAL_OWNER_ARTIFACT_MAX_BYTES;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 2
    || Number(parsed) > WALMART_EXTERNAL_OWNER_ARTIFACT_MAX_BYTES) {
    fail(
      "INVALID_EXTERNAL_ARTIFACT_INPUT",
      `maximum_bytes must be between 2 and ${WALMART_EXTERNAL_OWNER_ARTIFACT_MAX_BYTES}`,
    );
  }
  return Number(parsed);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function assertPrivateFileMode(mode: number): void {
  const permissions = mode & 0o777;
  if ((permissions & 0o077) !== 0 || (permissions & 0o400) === 0
    || (permissions & 0o111) !== 0) {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_MODE",
      "external owner artifact must be owner-readable, non-executable, and inaccessible to group/other",
    );
  }
}

function assertPrivateParentMode(mode: number): void {
  const permissions = mode & 0o777;
  if ((permissions & 0o077) !== 0 || (permissions & 0o500) !== 0o500) {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_PARENT",
      "external owner artifact parent must be owner-readable/searchable and inaccessible to group/other",
    );
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function realForbiddenRoot(value: string, label: string): Promise<string> {
  const info = await lstat(value).catch(() => fail(
    "INVALID_EXTERNAL_ARTIFACT_ROOT",
    `${label} must be an existing real directory`,
  ));
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("INVALID_EXTERNAL_ARTIFACT_ROOT", `${label} must be a non-symlink directory`);
  }
  const resolved = await realpath(value);
  if (resolved !== value) {
    fail("INVALID_EXTERNAL_ARTIFACT_ROOT", `${label} must not contain symlink aliases`);
  }
  return resolved;
}

function sameOpenFile(
  before: Stats,
  after: Stats,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/**
 * Read one externally owner-custodied canonical JSON artifact without treating
 * a repository or capture-session file as owner authority.
 *
 * This verifies filesystem custody and byte integrity only. It does not claim
 * that the artifact is digitally signed or authenticate its author.
 */
export async function readCanonicalWalmartExternalOwnerArtifactFile(
  input: ReadCanonicalWalmartExternalOwnerArtifactFileInput,
): Promise<CanonicalWalmartExternalOwnerArtifactFile> {
  const artifactPath = exactAbsolutePath(input.artifact_path, "artifact_path");
  const repositoryRootInput = exactAbsolutePath(input.repository_root, "repository_root");
  const captureRootInput = exactAbsolutePath(input.capture_root, "capture_root");
  const expectedSha256 = exactSha256(input.expected_sha256);
  const byteCap = maximumBytes(input.maximum_bytes);

  const [repositoryRoot, captureRoot] = await Promise.all([
    realForbiddenRoot(repositoryRootInput, "repository_root"),
    realForbiddenRoot(captureRootInput, "capture_root"),
  ]);
  const parent = path.dirname(artifactPath);
  const parentInfo = await lstat(parent).catch(() => fail(
    "UNSAFE_EXTERNAL_ARTIFACT_PARENT",
    "external owner artifact parent must be an existing private real directory",
  ));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_PARENT",
      "external owner artifact parent must be a non-symlink directory",
    );
  }
  assertPrivateParentMode(parentInfo.mode);
  const parentReal = await realpath(parent);
  if (parentReal !== parent) {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_PARENT",
      "external owner artifact parent path must not contain symlink aliases",
    );
  }
  if (isWithin(parentReal, repositoryRoot) || isWithin(parentReal, captureRoot)) {
    fail(
      "EXTERNAL_ARTIFACT_INSIDE_FORBIDDEN_ROOT",
      "external owner artifact must be outside both the repository and capture root",
    );
  }

  const pathInfo = await lstat(artifactPath).catch(() => fail(
    "EXTERNAL_ARTIFACT_NOT_FOUND",
    "external owner artifact must be an existing regular file",
  ));
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1) {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_PATH",
      "external owner artifact must be a single-link non-symlink regular file",
    );
  }
  assertPrivateFileMode(pathInfo.mode);

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(artifactPath, flags);
  } catch {
    fail(
      "UNSAFE_EXTERNAL_ARTIFACT_PATH",
      "external owner artifact could not be opened without following symlinks",
    );
  }
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      fail("UNSAFE_EXTERNAL_ARTIFACT_PATH", "opened external owner artifact is not a file");
    }
    assertPrivateFileMode(before.mode);
    if (before.size < 2 || before.size > byteCap) {
      fail(
        "EXTERNAL_ARTIFACT_SIZE_CAP",
        `external owner artifact must contain 2..${byteCap} bytes`,
      );
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || !sameOpenFile(before, after)) {
      fail(
        "EXTERNAL_ARTIFACT_CHANGED_DURING_READ",
        "external owner artifact changed while being read",
      );
    }
  } finally {
    await handle.close();
  }

  const afterPath = await lstat(artifactPath).catch(() => fail(
    "EXTERNAL_ARTIFACT_CHANGED_DURING_READ",
    "external owner artifact disappeared after it was read",
  ));
  const artifactReal = await realpath(artifactPath).catch(() => fail(
    "EXTERNAL_ARTIFACT_CHANGED_DURING_READ",
    "external owner artifact path changed after it was read",
  ));
  if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1
    || artifactReal !== artifactPath
    || afterPath.dev !== pathInfo.dev || afterPath.ino !== pathInfo.ino) {
    fail(
      "EXTERNAL_ARTIFACT_CHANGED_DURING_READ",
      "external owner artifact path identity changed while it was read",
    );
  }
  assertPrivateFileMode(afterPath.mode);
  if (isWithin(artifactReal, repositoryRoot) || isWithin(artifactReal, captureRoot)) {
    fail(
      "EXTERNAL_ARTIFACT_INSIDE_FORBIDDEN_ROOT",
      "external owner artifact resolved inside a forbidden root",
    );
  }

  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) {
    fail(
      "EXTERNAL_ARTIFACT_SHA256_MISMATCH",
      "external owner artifact bytes do not match expected_sha256",
    );
  }
  let jsonText: string;
  let value: unknown;
  try {
    jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(jsonText);
  } catch {
    fail(
      "EXTERNAL_ARTIFACT_INVALID_JSON",
      "external owner artifact must be valid UTF-8 JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "EXTERNAL_ARTIFACT_INVALID_JSON",
      "external owner artifact JSON must be an object",
    );
  }
  const canonicalJson = canonicalWalmartItemReportJson(value);
  if (jsonText !== canonicalJson) {
    fail(
      "EXTERNAL_ARTIFACT_NON_CANONICAL_JSON",
      "external owner artifact bytes must equal canonical Walmart item-report JSON",
    );
  }

  return {
    artifact_path: artifactPath,
    artifact_sha256: actualSha256,
    byte_length: bytes.byteLength,
    artifact_bytes: Uint8Array.from(bytes),
    canonical_json: canonicalJson,
    value: value as Record<string, unknown>,
  };
}
