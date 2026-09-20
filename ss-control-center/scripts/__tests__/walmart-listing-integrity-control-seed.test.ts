import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseWalmartListingIntegrityControlSeedArgs,
  walmartListingIntegrityControlRunBlocksFreshSeed,
} from "../walmart-listing-integrity-control-seed.ts";

const SHA = "a".repeat(64);

test("seed plan accepts only one exact pinned pool and output directory", () => {
  const parsed = parseWalmartListingIntegrityControlSeedArgs([
    "plan",
    "--pool", "/private/pool.json",
    "--pool-file-sha256", SHA,
    "--output-dir", "/private/seed-plan",
  ]);
  assert.deepEqual(parsed, {
    command: "plan",
    input_path: "/private/pool.json",
    input_file_sha256: SHA,
    output_dir: "/private/seed-plan",
  });
  for (const argv of [
    ["plan", "--all", "1"],
    ["plan", "--pool", "relative.json"],
    ["plan", "--pool", "/private/pool.json", "--pool-file-sha256", SHA],
  ]) {
    assert.throws(
      () => parseWalmartListingIntegrityControlSeedArgs(argv),
      /CONTROL_SEED_CLI_INVALID/,
    );
  }
});

test("seed apply accepts only one exact immutable plan", () => {
  const parsed = parseWalmartListingIntegrityControlSeedArgs([
    "apply",
    "--plan", "/private/control-seed-plan.json",
    "--plan-file-sha256", SHA,
  ]);
  assert.deepEqual(parsed, {
    command: "apply",
    input_path: "/private/control-seed-plan.json",
    input_file_sha256: SHA,
    output_dir: null,
  });
  assert.throws(
    () => parseWalmartListingIntegrityControlSeedArgs([
      "apply",
      "--plan", "/private/control-seed-plan.json",
      "--plan-file-sha256", SHA,
      "--retry", "1",
    ]),
    /CONTROL_SEED_CLI_INVALID/,
  );
});

test("npm seed entrypoint loads production environment explicitly", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../../package.json", import.meta.url),
    "utf8",
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["walmart:listing-integrity:seed"],
    "node --env-file=.env --import tsx scripts/walmart-listing-integrity-control-seed.ts",
  );
});

test("only a completed prior epoch permits a fresh seed", () => {
  const snapshot = (status: "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED" | null) => ({
    installation: "INSTALLED",
    runtime_policy_stage: "OFF",
    run: status === null ? null : { status },
  }) as never;
  assert.equal(walmartListingIntegrityControlRunBlocksFreshSeed(snapshot(null)), false);
  assert.equal(walmartListingIntegrityControlRunBlocksFreshSeed(snapshot("COMPLETED")), false);
  assert.equal(walmartListingIntegrityControlRunBlocksFreshSeed(snapshot("ACTIVE")), true);
  assert.equal(walmartListingIntegrityControlRunBlocksFreshSeed(snapshot("PAUSED")), true);
  assert.equal(walmartListingIntegrityControlRunBlocksFreshSeed(snapshot("FAILED")), true);
});
