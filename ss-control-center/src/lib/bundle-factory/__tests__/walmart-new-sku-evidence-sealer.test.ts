import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  sealWalmartNewSkuCertificationEvidenceDraft,
} from "../walmart-new-sku-evidence-sealer";

async function fixtureRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-evidence-sealer-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function draft(artifactPath: string): Record<string, unknown> {
  return {
    schema_version: "draft-fixture",
    untouched: { exact: true },
    evidence_artifacts: [{
      ref: "fixture-evidence://exact/one",
      kind: "POLICY_REVIEW",
      path: artifactPath,
      sha256: "TODO_ENGINE_SEALS_SHA256",
      byte_size: null,
      captured_at: "TODO_REVIEW_TIME",
      source_url: null,
    }],
  };
}

test("seals exact bytes while changing only sha256 and byte_size", async (t) => {
  const root = await fixtureRoot(t);
  const artifactPath = path.join(root, "evidence.json");
  const bytes = Buffer.from("exact immutable evidence bytes\n", "utf8");
  await writeFile(artifactPath, bytes);
  const input = draft(artifactPath);
  const original = structuredClone(input);
  const result = await sealWalmartNewSkuCertificationEvidenceDraft({ draft: input });
  const row = (result.sealed.evidence_artifacts as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(input, original, "the draft object must not be mutated");
  assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(row.byte_size, bytes.length);
  const restored = structuredClone(result.sealed);
  const restoredRow = (
    restored.evidence_artifacts as Array<Record<string, unknown>>
  )[0]!;
  restoredRow.sha256 = (
    original.evidence_artifacts as Array<Record<string, unknown>>
  )[0]!.sha256;
  restoredRow.byte_size = (
    original.evidence_artifacts as Array<Record<string, unknown>>
  )[0]!.byte_size;
  assert.deepEqual(restored, original);
});

test("missing, symlink, and multi-link artifacts fail closed", async (t) => {
  const root = await fixtureRoot(t);
  await assert.rejects(
    sealWalmartNewSkuCertificationEvidenceDraft({
      draft: draft(path.join(root, "missing.json")),
    }),
    /single-link regular file/,
  );

  const target = path.join(root, "target.json");
  const symlinkPath = path.join(root, "symlink.json");
  await writeFile(target, "evidence\n", "utf8");
  await symlink(target, symlinkPath);
  await assert.rejects(
    sealWalmartNewSkuCertificationEvidenceDraft({ draft: draft(symlinkPath) }),
    /single-link regular file/,
  );

  const hardlinkPath = path.join(root, "hardlink.json");
  await link(target, hardlinkPath);
  await assert.rejects(
    sealWalmartNewSkuCertificationEvidenceDraft({ draft: draft(target) }),
    /single-link regular file/,
  );
});

test("an artifact mutation after safe open is detected as a read race", async (t) => {
  const root = await fixtureRoot(t);
  const artifactPath = path.join(root, "racing.json");
  await writeFile(artifactPath, "before-race-evidence\n", "utf8");
  await assert.rejects(
    sealWalmartNewSkuCertificationEvidenceDraft({
      draft: draft(artifactPath),
      testOnlyAfterOpen: async (openedPath) => {
        await writeFile(openedPath, "changed-during-read\n", "utf8");
      },
    }),
    /changed during read/,
  );
});

test("stable parent aliases resolve canonically but a parent retarget race fails", async (t) => {
  const root = await fixtureRoot(t);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const alias = path.join(root, "alias");
  await Promise.all([mkdir(first), mkdir(second)]);
  await Promise.all([
    writeFile(path.join(first, "evidence.json"), "first evidence\n", "utf8"),
    writeFile(path.join(second, "evidence.json"), "other evidence\n", "utf8"),
  ]);
  await symlink(first, alias);
  const aliasedPath = path.join(alias, "evidence.json");
  await assert.doesNotReject(
    sealWalmartNewSkuCertificationEvidenceDraft({ draft: draft(aliasedPath) }),
  );
  await assert.rejects(
    sealWalmartNewSkuCertificationEvidenceDraft({
      draft: draft(aliasedPath),
      testOnlyAfterOpen: async () => {
        await unlink(alias);
        await symlink(second, alias);
      },
    }),
    /changed during read/,
  );
});
