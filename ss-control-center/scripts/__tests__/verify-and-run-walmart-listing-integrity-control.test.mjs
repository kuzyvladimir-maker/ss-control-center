import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArgs,
  verifyRelease,
} from "../verify-and-run-walmart-listing-integrity-control.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
};

test("control release wrapper rejects mass scope before loading runtime", () => {
  assert.throws(() => parseArgs([
    "--engine-root", "/private/release/engine/ss-control-center",
    "--manifest", "/private/release/release-manifest.json",
    "--manifest-sha256", "a".repeat(64),
    "--workspace-root", "/private/workspace",
    "--",
    "watch", "--all", "1",
  ]), /mass scope is forbidden/u);
});

test("control release verifies exact bytes and rejects a tampered source", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wli-control-release-")));
  const release = path.join(root, "release");
  const engine = path.join(release, "engine", "ss-control-center");
  const workspace = path.join(root, "workspace");
  const modules = path.join(root, "modules");
  const writerPath = path.join(root, "writer-manifest.json");
  const wrapperRelative = "scripts/verify-and-run-walmart-listing-integrity-control.mjs";
  const successorRelative = "scripts/walmart-listing-integrity-successor-worker.ts";
  const inputRelative = "data/audits/walmart-listing-integrity-catalog/census.json";
  await Promise.all([
    mkdir(path.join(engine, "scripts"), { recursive: true }),
    mkdir(path.join(workspace, path.dirname(inputRelative)), { recursive: true }),
    mkdir(modules, { recursive: true }),
  ]);
  const wrapperBytes = Buffer.from("export const wrapper = true;\n");
  const successorBytes = Buffer.from("export const successor = true;\n");
  const inputBytes = Buffer.from("{}\n");
  const writer = { release_id_sha256: "b".repeat(64) };
  const writerBytes = Buffer.from(`${JSON.stringify(writer)}\n`);
  const wrapperPath = path.join(engine, wrapperRelative);
  const successorPath = path.join(engine, successorRelative);
  await Promise.all([
    writeFile(wrapperPath, wrapperBytes, { mode: 0o400 }),
    writeFile(successorPath, successorBytes, { mode: 0o400 }),
    writeFile(path.join(workspace, inputRelative), inputBytes, { mode: 0o400 }),
    writeFile(writerPath, writerBytes, { mode: 0o400 }),
    symlink(modules, path.join(engine, "node_modules"), "dir"),
  ]);
  const body = {
    schema_version: "walmart-listing-integrity-control-frozen-release/v1",
    release_id_sha256: "c".repeat(64),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      node_modules_realpath: modules,
    },
    writer_release: {
      manifest_path: writerPath,
      manifest_sha256: sha256(writerBytes),
      release_id_sha256: writer.release_id_sha256,
    },
    workspace: {
      root_path_sha256: sha256(workspace),
      pinned_inputs: [{
        relative_path: inputRelative,
        byte_length: inputBytes.byteLength,
        sha256: sha256(inputBytes),
      }],
    },
    source_inventory: [
      { path: wrapperRelative, byte_length: wrapperBytes.byteLength, sha256: sha256(wrapperBytes) },
      { path: successorRelative, byte_length: successorBytes.byteLength, sha256: sha256(successorBytes) },
    ],
  };
  const manifest = { ...body, body_sha256: sha256(Buffer.from(canonical(body))) };
  const manifestBytes = Buffer.from(`${canonical(manifest)}\n`);
  const manifestPath = path.join(release, "release-manifest.json");
  await writeFile(manifestPath, manifestBytes, { mode: 0o400 });
  const input = {
    engine_root: engine,
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifestBytes),
    workspace_root: workspace,
  };
  try {
    const verified = await verifyRelease(input);
    assert.equal(verified.release_id_sha256, manifest.release_id_sha256);
    await chmod(successorPath, 0o600);
    await writeFile(successorPath, Buffer.from("tampered\n"));
    await assert.rejects(() => verifyRelease(input), /frozen source differs/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
