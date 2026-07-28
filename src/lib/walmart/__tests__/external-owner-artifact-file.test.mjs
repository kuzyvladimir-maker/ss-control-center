import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readCanonicalWalmartExternalOwnerArtifactFile,
} from "../external-owner-artifact-file.ts";
import { canonicalWalmartItemReportJson } from "../item-report-published-source.ts";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "walmart-external-owner-artifact-"),
  ));
  const repositoryRoot = path.join(root, "repository");
  const captureRoot = path.join(repositoryRoot, "capture-root");
  const externalParent = path.join(root, "owner-custody");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(captureRoot, { mode: 0o700 });
  await mkdir(externalParent, { mode: 0o700 });
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await chmod(repositoryRoot, 0o700).catch(() => {});
    await chmod(captureRoot, 0o700).catch(() => {});
    await chmod(externalParent, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, repositoryRoot, captureRoot, externalParent };
}

async function writeArtifact(parent, name, value, mode = 0o600) {
  const bytes = Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
  const artifactPath = path.join(parent, name);
  await writeFile(artifactPath, bytes, { flag: "wx", mode });
  return { artifactPath, bytes, sha256: sha256(bytes) };
}

function input(fx, artifact, overrides = {}) {
  return {
    artifact_path: artifact.artifactPath,
    expected_sha256: artifact.sha256,
    repository_root: fx.repositoryRoot,
    capture_root: fx.captureRoot,
    ...overrides,
  };
}

test("reads exact canonical bytes only from a private external owner directory", async (t) => {
  const fx = await fixture(t);
  const value = {
    action: "REISSUE_WALMART_ITEM_REPORT",
    permit_id: "permit-1",
    claims: { report_create_post_calls: 1, retries: 0 },
  };
  const artifact = await writeArtifact(fx.externalParent, "permit.json", value);

  const result = await readCanonicalWalmartExternalOwnerArtifactFile(input(fx, artifact));

  assert.equal(result.artifact_path, artifact.artifactPath);
  assert.equal(result.artifact_sha256, artifact.sha256);
  assert.equal(result.byte_length, artifact.bytes.byteLength);
  assert.deepEqual(Buffer.from(result.artifact_bytes), artifact.bytes);
  assert.equal(result.canonical_json, artifact.bytes.toString("utf8"));
  assert.deepEqual(result.value, value);
});

test("rejects relative, symlink, directory, and forbidden-root paths", async (t) => {
  const fx = await fixture(t);
  const external = await writeArtifact(fx.externalParent, "permit.json", { permit_id: "permit-1" });

  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, external, {
      artifact_path: "permit.json",
    })),
    /exact normalized absolute path/,
  );

  const symlinkPath = path.join(fx.externalParent, "permit-link.json");
  await symlink(external.artifactPath, symlinkPath);
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, {
      ...external,
      artifactPath: symlinkPath,
    })),
    /non-symlink regular file/,
  );

  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, {
      ...external,
      artifactPath: fx.externalParent,
    })),
    /non-symlink regular file/,
  );

  const hardLinkPath = path.join(fx.externalParent, "permit-hard-link.json");
  await link(external.artifactPath, hardLinkPath);
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, external)),
    /single-link non-symlink regular file/,
  );

  const inRepository = await writeArtifact(fx.repositoryRoot, "repo-permit.json", {
    permit_id: "permit-repo",
  });
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, inRepository)),
    /outside both the repository and capture root/,
  );

  const inCapture = await writeArtifact(fx.captureRoot, "capture-permit.json", {
    permit_id: "permit-capture",
  });
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, inCapture)),
    /outside both the repository and capture root/,
  );
});

test("rejects non-private file or parent modes and symlinked parents", async (t) => {
  const fx = await fixture(t);
  const publicFile = await writeArtifact(
    fx.externalParent,
    "public-permit.json",
    { permit_id: "permit-public" },
    0o644,
  );
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, publicFile)),
    /inaccessible to group\/other/,
  );

  const privateFile = await writeArtifact(
    fx.externalParent,
    "private-permit.json",
    { permit_id: "permit-private" },
  );
  await chmod(fx.externalParent, 0o755);
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, privateFile)),
    /parent must be owner-readable\/searchable/,
  );
  await chmod(fx.externalParent, 0o700);

  const linkedParent = path.join(fx.root, "linked-owner-custody");
  await symlink(fx.externalParent, linkedParent);
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, {
      ...privateFile,
      artifactPath: path.join(linkedParent, "private-permit.json"),
    })),
    /parent must be a non-symlink directory/,
  );
});

test("rejects wrong hashes, oversized bytes, and non-canonical JSON", async (t) => {
  const fx = await fixture(t);
  const canonical = await writeArtifact(fx.externalParent, "permit.json", {
    action: "REISSUE",
    permit_id: "permit-1",
  });
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, canonical, {
      expected_sha256: "0".repeat(64),
    })),
    /do not match expected_sha256/,
  );
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, canonical, {
      maximum_bytes: canonical.bytes.byteLength - 1,
    })),
    /must contain 2\.\./,
  );

  const nonCanonicalBytes = Buffer.from('{"permit_id": "permit-2"}\n', "utf8");
  const nonCanonical = {
    artifactPath: path.join(fx.externalParent, "non-canonical.json"),
    bytes: nonCanonicalBytes,
    sha256: sha256(nonCanonicalBytes),
  };
  await writeFile(nonCanonical.artifactPath, nonCanonical.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await assert.rejects(
    readCanonicalWalmartExternalOwnerArtifactFile(input(fx, nonCanonical)),
    /must equal canonical Walmart item-report JSON/,
  );
});

test("accepts a read-only private artifact file", async (t) => {
  const fx = await fixture(t);
  const artifact = await writeArtifact(
    fx.externalParent,
    "read-only-permit.json",
    { permit_id: "permit-read-only" },
    0o400,
  );
  const result = await readCanonicalWalmartExternalOwnerArtifactFile(input(fx, artifact));
  assert.equal(result.artifact_sha256, artifact.sha256);
});
