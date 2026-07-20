import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_EVIDENCE_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface SealedWalmartNewSkuEvidenceRow {
  index: number;
  path: string;
  sha256: string;
  byte_size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error("Evidence artifact path must be a normalized absolute path");
  }
  return value;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === 1 &&
    right.nlink === 1
  );
}

export async function hashWalmartNewSkuEvidenceArtifact(input: {
  path: string;
  testOnlyAfterOpen?: (path: string) => Promise<void> | void;
}): Promise<{ sha256: string; byte_size: number; bytes: Uint8Array }> {
  const canonicalBefore = await realpath(input.path).catch(() => null);
  const before = await lstat(input.path).catch(() => null);
  if (
    !canonicalBefore ||
    !before ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > MAX_EVIDENCE_ARTIFACT_BYTES
  ) {
    throw new Error(
      `Evidence artifact must be a non-empty single-link regular file: ${input.path}`,
    );
  }
  const handle = await open(
    canonicalBefore,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    throw new Error(`Evidence artifact cannot be opened safely: ${input.path}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`Evidence artifact changed before read: ${input.path}`);
    }
    if (input.testOnlyAfterOpen) await input.testOnlyAfterOpen(input.path);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const canonicalAfter = await realpath(input.path).catch(() => null);
    const pathAfter = await lstat(input.path).catch(() => null);
    if (
      canonicalAfter !== canonicalBefore ||
      !pathAfter ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, pathAfter) ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error(`Evidence artifact changed during read: ${input.path}`);
    }
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.byteLength,
      bytes,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Non-mutating evidence helper. It copies a draft certification object and
 * changes only each evidence row's sha256 and byte_size fields after a
 * no-follow, single-link, race-checked read. It deliberately performs no
 * certification, Product Truth, database, or Walmart validation.
 */
export async function sealWalmartNewSkuCertificationEvidenceDraft(input: {
  draft: unknown;
  testOnlyAfterOpen?: (path: string, index: number) => Promise<void> | void;
  validateArtifactBytes?: (input: {
    path: string;
    index: number;
    row: Record<string, unknown>;
    bytes: Uint8Array;
  }) => Promise<void> | void;
}): Promise<{
  sealed: Record<string, unknown>;
  evidence: SealedWalmartNewSkuEvidenceRow[];
}> {
  if (!isRecord(input.draft)) {
    throw new Error("Certification evidence draft must be a JSON object");
  }
  if (!Array.isArray(input.draft.evidence_artifacts)) {
    throw new Error("Certification evidence draft requires evidence_artifacts[]");
  }
  const sealed = structuredClone(input.draft);
  const sealedRows = sealed.evidence_artifacts;
  if (!Array.isArray(sealedRows)) {
    throw new Error("Certification evidence draft requires evidence_artifacts[]");
  }
  const evidence: SealedWalmartNewSkuEvidenceRow[] = [];
  for (const [index, row] of sealedRows.entries()) {
    if (!isRecord(row)) {
      throw new Error(`Evidence artifact ${index} must be an object`);
    }
    const path = normalizedAbsolutePath(row.path);
    const digest = await hashWalmartNewSkuEvidenceArtifact({
      path,
      testOnlyAfterOpen: input.testOnlyAfterOpen
        ? () => input.testOnlyAfterOpen!(path, index)
        : undefined,
    });
    if (input.validateArtifactBytes) {
      await input.validateArtifactBytes({
        path,
        index,
        row,
        bytes: digest.bytes,
      });
    }
    row.sha256 = digest.sha256;
    row.byte_size = digest.byte_size;
    evidence.push({
      index,
      path,
      sha256: digest.sha256,
      byte_size: digest.byte_size,
    });
  }
  return { sealed, evidence };
}
