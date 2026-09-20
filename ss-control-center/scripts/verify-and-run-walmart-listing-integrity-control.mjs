#!/usr/bin/env node

/** Verify the sealed supervisor release, then run only its bounded successor. */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_SCHEMA = "walmart-listing-integrity-control-frozen-release/v1";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("CONTROL_RELEASE_NON_CANONICAL", "undefined is forbidden");
  return encoded;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value
    || value.includes("\u0000")) {
    fail("CONTROL_RELEASE_CLI_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

function exactSha(value, label) {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CONTROL_RELEASE_CLI_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) fail("CONTROL_RELEASE_CLI_INVALID", "missing exact -- separator");
  const wrapper = argv.slice(0, separator);
  const successor = argv.slice(separator + 1);
  const allowed = new Set([
    "engine-root", "manifest", "manifest-sha256", "workspace-root",
  ]);
  const values = new Map();
  for (let index = 0; index < wrapper.length; index += 2) {
    const token = wrapper[index];
    const value = wrapper[index + 1];
    if (!token?.startsWith("--") || token.includes("=") || !value || value.startsWith("--")) {
      fail("CONTROL_RELEASE_CLI_INVALID", "wrapper flags must be exact --name value pairs");
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) {
      fail("CONTROL_RELEASE_CLI_INVALID", `forbidden or repeated flag ${token}`);
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("CONTROL_RELEASE_CLI_INVALID", "wrapper flags are incomplete");
  }
  if (!successor.length || !["doctor", "once", "watch"].includes(successor[0])) {
    fail("CONTROL_RELEASE_CLI_INVALID", "successor command must be doctor, once, or watch");
  }
  if (successor.some((token) => token === "--all" || token.startsWith("--all="))) {
    fail("CONTROL_RELEASE_CLI_INVALID", "mass scope is forbidden");
  }
  return {
    engine_root: absolute(values.get("engine-root"), "--engine-root"),
    manifest_path: absolute(values.get("manifest"), "--manifest"),
    manifest_sha256: exactSha(values.get("manifest-sha256"), "--manifest-sha256"),
    workspace_root: absolute(values.get("workspace-root"), "--workspace-root"),
    successor,
  };
}

async function safeFile(file, maximum = MAX_MANIFEST_BYTES) {
  const metadata = await lstat(file).catch(() => fail(
    "CONTROL_RELEASE_FILE_INVALID",
    `missing file ${file}`,
  ));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maximum || await realpath(file) !== file) {
    fail("CONTROL_RELEASE_FILE_INVALID", `unsafe file ${file}`);
  }
  return { metadata, bytes: await readFile(file) };
}

async function verifyRelease(input) {
  const manifestFile = await safeFile(input.manifest_path);
  if (sha256(manifestFile.bytes) !== input.manifest_sha256) {
    fail("CONTROL_RELEASE_MANIFEST_MISMATCH", "manifest file SHA-256 differs");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestFile.bytes));
  } catch {
    fail("CONTROL_RELEASE_MANIFEST_INVALID", "manifest is not UTF-8 JSON");
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA) {
    fail("CONTROL_RELEASE_MANIFEST_INVALID", "manifest schema differs");
  }
  const body = { ...manifest };
  delete body.body_sha256;
  if (manifest.body_sha256 !== sha256(Buffer.from(canonical(body), "utf8"))) {
    fail("CONTROL_RELEASE_MANIFEST_INVALID", "manifest body seal differs");
  }
  const expectedEngineRoot = path.join(path.dirname(input.manifest_path), "engine", "ss-control-center");
  if (input.engine_root !== expectedEngineRoot || await realpath(input.engine_root) !== input.engine_root) {
    fail("CONTROL_RELEASE_ENGINE_INVALID", "engine root differs from manifest custody");
  }
  if (manifest.workspace?.root_path_sha256 !== sha256(input.workspace_root)
    || await realpath(input.workspace_root) !== input.workspace_root) {
    fail("CONTROL_RELEASE_WORKSPACE_INVALID", "workspace root differs from sealed binding");
  }
  const inventory = manifest.source_inventory;
  if (!Array.isArray(inventory) || inventory.length < 2) {
    fail("CONTROL_RELEASE_MANIFEST_INVALID", "source inventory is empty");
  }
  const seen = new Set();
  for (const row of inventory) {
    if (!row || typeof row.path !== "string" || seen.has(row.path)
      || path.isAbsolute(row.path) || row.path.includes("..") || row.path.includes("\u0000")
      || !Number.isSafeInteger(row.byte_length) || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
      fail("CONTROL_RELEASE_MANIFEST_INVALID", "source inventory row is invalid");
    }
    seen.add(row.path);
    const file = path.join(input.engine_root, row.path);
    if (!file.startsWith(`${input.engine_root}${path.sep}`)) {
      fail("CONTROL_RELEASE_ENGINE_INVALID", "inventory path escaped engine root");
    }
    const exact = await safeFile(file, 64 * 1024 * 1024);
    if ((exact.metadata.mode & 0o022) !== 0
      || exact.bytes.byteLength !== row.byte_length || sha256(exact.bytes) !== row.sha256) {
      fail("CONTROL_RELEASE_SOURCE_MISMATCH", `frozen source differs: ${row.path}`);
    }
  }
  const wrapperRelative = "scripts/verify-and-run-walmart-listing-integrity-control.mjs";
  if (!seen.has(wrapperRelative)) {
    fail("CONTROL_RELEASE_MANIFEST_INVALID", "wrapper is outside the source inventory");
  }
  const modulesLink = path.join(input.engine_root, "node_modules");
  const linkMetadata = await lstat(modulesLink).catch(() => fail(
    "CONTROL_RELEASE_RUNTIME_INVALID",
    "node_modules link is missing",
  ));
  if (!linkMetadata.isSymbolicLink()
    || await realpath(modulesLink) !== manifest.runtime.node_modules_realpath
    || path.resolve(input.engine_root, await readlink(modulesLink)) !== manifest.runtime.node_modules_realpath) {
    fail("CONTROL_RELEASE_RUNTIME_INVALID", "node_modules binding differs");
  }
  if (manifest.runtime.node !== process.versions.node
    || manifest.runtime.platform !== process.platform || manifest.runtime.arch !== process.arch) {
    fail("CONTROL_RELEASE_RUNTIME_INVALID", "Node runtime differs from certification");
  }
  const writer = await safeFile(manifest.writer_release.manifest_path);
  if (sha256(writer.bytes) !== manifest.writer_release.manifest_sha256) {
    fail("CONTROL_RELEASE_WRITER_INVALID", "V50 manifest SHA differs");
  }
  const writerManifest = JSON.parse(writer.bytes.toString("utf8"));
  if (writerManifest.release_id_sha256 !== manifest.writer_release.release_id_sha256) {
    fail("CONTROL_RELEASE_WRITER_INVALID", "V50 release ID differs");
  }
  for (const row of manifest.workspace.pinned_inputs) {
    const file = path.join(input.workspace_root, row.relative_path);
    const exact = await safeFile(file, 256 * 1024 * 1024);
    if (exact.bytes.byteLength !== row.byte_length || sha256(exact.bytes) !== row.sha256) {
      fail("CONTROL_RELEASE_INPUT_MISMATCH", `workspace input differs: ${row.relative_path}`);
    }
  }
  return manifest;
}

async function run(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  const manifest = await verifyRelease(input);
  const entrypoint = path.join(
    input.engine_root,
    "scripts/walmart-listing-integrity-successor-worker.ts",
  );
  const child = spawn(process.execPath, [
    `--env-file=${path.join(input.workspace_root, ".env")}`,
    "--import",
    "tsx",
    entrypoint,
    ...input.successor,
  ], {
    cwd: input.workspace_root,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  const forward = (signal) => child.kill(signal);
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  const exitCode = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`successor terminated by ${signal}`));
      else accept(code ?? 1);
    });
  });
  process.off("SIGTERM", forward);
  process.off("SIGINT", forward);
  if (exitCode !== 0) fail("CONTROL_RELEASE_SUCCESSOR_FAILED", `successor exit ${exitCode}`);
  return manifest.release_id_sha256;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schema_version: "walmart-listing-integrity-control-wrapper-error/v1",
      status: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
    })}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, verifyRelease };
