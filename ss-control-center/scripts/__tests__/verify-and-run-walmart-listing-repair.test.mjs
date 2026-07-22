import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseWalmartListingRepairReleaseWrapperArgs,
  verifyFrozenWalmartListingRepairRelease,
  WalmartListingRepairReleaseVerificationError,
} from "../verify-and-run-walmart-listing-repair.mjs";

const RELEASE_ID = "7".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("undefined fixture value");
  return encoded;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function buildFixture() {
  const privateRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "walmart-repair-release-wrapper-")),
  );
  const gitRoot = path.join(privateRoot, "checkout");
  const engineRoot = path.join(gitRoot, "ss-control-center");
  const manifestPath = path.join(privateRoot, "release-manifest.json");
  const sources = new Map([
    ["package-lock.json", "{\"lockfileVersion\":3}\n"],
    ["package.json", "{\"private\":true}\n"],
    ["scripts/verify-and-run-walmart-listing-repair.mjs", "// verified wrapper fixture\n"],
    ["scripts/walmart-listing-repair-operator.ts", "// operator fixture\n"],
    ["src/lib/walmart/listing-integrity-remediation-qualification.ts",
      `const PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256: string | null = "${RELEASE_ID}";\n`],
    ["src/lib/walmart/listing-integrity-remediation-writer.ts",
      `const PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256: string | null = "${RELEASE_ID}";\n`],
  ]);
  await mkdir(engineRoot, { recursive: true, mode: 0o700 });
  for (const [relative, source] of sources) {
    const absolute = path.join(engineRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source, { mode: 0o600 });
  }
  git(gitRoot, ["init", "--quiet"]);
  git(gitRoot, ["config", "user.email", "release-test@example.invalid"]);
  git(gitRoot, ["config", "user.name", "Release Test"]);
  git(gitRoot, ["add", "."]);
  git(gitRoot, ["commit", "--quiet", "-m", "fixture"]);
  const inventory = [];
  for (const relative of [...sources.keys()].sort()) {
    const bytes = await readFile(path.join(engineRoot, relative));
    inventory.push({ path: relative, byte_length: bytes.byteLength, sha256: sha256(bytes) });
  }
  const body = {
    schema_version: "walmart-listing-repair-frozen-release/v1",
    created_at: "2026-07-22T12:00:00.000Z",
    release_id_sha256: RELEASE_ID,
    git: {
      commit: git(gitRoot, ["rev-parse", "HEAD"]),
      tree: git(gitRoot, ["rev-parse", "HEAD^{tree}"]),
      clean_checkout: true,
    },
    runtime: {
      entrypoints: [
        "scripts/verify-and-run-walmart-listing-repair.mjs",
        "scripts/walmart-listing-repair-operator.ts",
      ],
      normalized_closure_file_count: 2,
      pinned_apply_release_matches: true,
      pinned_verifier_release_matches: true,
      caller_dependency_injection_allowed: false,
      automatic_retry_allowed: false,
      marketplace_write_calls_maximum: 1,
    },
    certification: { test_entrypoints: [], expected_test_count: 0, logs: [] },
    source_inventory: inventory,
    owner_gate: {
      owner_public_trust_root_enrolled: false,
      live_canary_authorized: false,
      mass_run_authorized: false,
    },
  };
  const manifest = { ...body, body_sha256: sha256(canonicalJson(body)) };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  await writeFile(manifestPath, manifestBytes, { mode: 0o400 });
  return {
    privateRoot,
    engineRoot,
    manifestPath,
    manifestSha: sha256(manifestBytes),
  };
}

test("wrapper CLI requires exact external trust inputs and one bounded operator command", () => {
  const parsed = parseWalmartListingRepairReleaseWrapperArgs([
    "--engine-root", "/private/tmp/engine",
    "--manifest", "/private/tmp/release-manifest.json",
    "--manifest-sha256", "a".repeat(64),
    "--release-id-sha256", "b".repeat(64),
    "--", "doctor", "--out", "/private/tmp/doctor.json",
  ]);
  assert.equal(parsed.operator_args[0], "doctor");
  assert.throws(
    () => parseWalmartListingRepairReleaseWrapperArgs([
      "--engine-root", "/private/tmp/engine", "--", "execute",
    ]),
    /all four wrapper trust inputs/u,
  );
  assert.throws(
    () => parseWalmartListingRepairReleaseWrapperArgs([
      "--engine-root", "/private/tmp/engine",
      "--manifest", "/private/tmp/release-manifest.json",
      "--manifest-sha256", "a".repeat(64),
      "--release-id-sha256", "b".repeat(64),
      "--", "help",
    ]),
    /operator command is missing or forbidden/u,
  );
});

test("wrapper verifies canonical manifest, clean Git identity, inventory, and release pins", async () => {
  const fixture = await buildFixture();
  try {
    const verified = await verifyFrozenWalmartListingRepairRelease({
      engine_root: fixture.engineRoot,
      manifest_path: fixture.manifestPath,
      expected_manifest_sha256: fixture.manifestSha,
      expected_release_id_sha256: RELEASE_ID,
    });
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.release_id_sha256, RELEASE_ID);
    assert.equal(verified.source_file_count, 6);
  } finally {
    await chmod(fixture.manifestPath, 0o600).catch(() => undefined);
    await rm(fixture.privateRoot, { recursive: true, force: true });
  }
});

test("wrapper fails closed on source drift and noncanonical manifest bytes", async (t) => {
  await t.test("dirty source", async () => {
    const fixture = await buildFixture();
    try {
      await writeFile(
        path.join(fixture.engineRoot, "scripts/walmart-listing-repair-operator.ts"),
        "// drift\n",
      );
      await assert.rejects(
        verifyFrozenWalmartListingRepairRelease({
          engine_root: fixture.engineRoot,
          manifest_path: fixture.manifestPath,
          expected_manifest_sha256: fixture.manifestSha,
          expected_release_id_sha256: RELEASE_ID,
        }),
        (error) => error instanceof WalmartListingRepairReleaseVerificationError
          && error.code === "DIRTY_OR_WRONG_CHECKOUT",
      );
    } finally {
      await chmod(fixture.manifestPath, 0o600).catch(() => undefined);
      await rm(fixture.privateRoot, { recursive: true, force: true });
    }
  });
  await t.test("manifest byte drift", async () => {
    const fixture = await buildFixture();
    try {
      await chmod(fixture.manifestPath, 0o600);
      const original = await readFile(fixture.manifestPath);
      const drifted = Buffer.concat([original, Buffer.from("\n")]);
      await writeFile(fixture.manifestPath, drifted);
      await chmod(fixture.manifestPath, 0o400);
      await assert.rejects(
        verifyFrozenWalmartListingRepairRelease({
          engine_root: fixture.engineRoot,
          manifest_path: fixture.manifestPath,
          expected_manifest_sha256: sha256(drifted),
          expected_release_id_sha256: RELEASE_ID,
        }),
        (error) => error instanceof WalmartListingRepairReleaseVerificationError
          && error.code === "NON_CANONICAL_MANIFEST",
      );
    } finally {
      await chmod(fixture.manifestPath, 0o600).catch(() => undefined);
      await rm(fixture.privateRoot, { recursive: true, force: true });
    }
  });
});
