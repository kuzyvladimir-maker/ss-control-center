import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseWalmartListingIntegrityControlWorkerArgs,
  walmartListingIntegrityDiagnosisProcessConfig,
  walmartListingIntegrityControlWorkerProcessConfig,
  walmartListingIntegrityRemediationConfig,
} from "../walmart-listing-integrity-control-worker.ts";

const SHA = "a".repeat(64);

test("doctor is read-only and accepts no ambient flags", () => {
  const parsed = parseWalmartListingIntegrityControlWorkerArgs(["doctor"]);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.permit_path, null);
  assert.throws(
    () => parseWalmartListingIntegrityControlWorkerArgs(["doctor", "--all", "1"]),
    /CONTROL_WORKER_CLI_INVALID/,
  );
});

test("once requires exactly one permit, package and private custody root", () => {
  const parsed = parseWalmartListingIntegrityControlWorkerArgs([
    "once",
    "--permit", "/private/permit.json",
    "--permit-file-sha256", SHA,
    "--package", "/private/package.json",
    "--package-sha256", SHA,
    "--custody-root", "/private/custody",
  ]);
  assert.equal(parsed.command, "once");
  assert.equal(parsed.package_sha256, SHA);
  for (const argv of [
    ["once", "--all", "1"],
    ["once", "--permit", "/private/permit.json"],
    ["once", "--permit", "relative.json"],
  ]) {
    assert.throws(
      () => parseWalmartListingIntegrityControlWorkerArgs(argv),
      /CONTROL_WORKER_CLI_INVALID/,
    );
  }
});

test("audit-once is read-only scoped and needs only private custody", () => {
  const parsed = parseWalmartListingIntegrityControlWorkerArgs([
    "audit-once",
    "--custody-root", "/private/custody",
  ]);
  assert.equal(parsed.command, "audit-once");
  assert.equal(parsed.custody_root, "/private/custody");
  assert.equal(parsed.permit_path, null);
  assert.throws(
    () => parseWalmartListingIntegrityControlWorkerArgs([
      "audit-once", "--custody-root", "/private/custody", "--all", "1",
    ]),
    /CONTROL_WORKER_CLI_INVALID/,
  );
});

test("prepare-once needs only private custody and binds the frozen owner compiler", () => {
  const parsed = parseWalmartListingIntegrityControlWorkerArgs([
    "prepare-once",
    "--custody-root", "/private/custody",
  ]);
  assert.equal(parsed.command, "prepare-once");
  assert.equal(parsed.custody_root, "/private/custody");
  assert.throws(
    () => parseWalmartListingIntegrityControlWorkerArgs([
      "prepare-once", "--custody-root", "/private/custody", "--all", "1",
    ]),
    /CONTROL_WORKER_CLI_INVALID/,
  );
  const config = walmartListingIntegrityRemediationConfig(
    "/Users/vladimirkuznetsov/SS Command Center/ss-control-center",
  );
  assert.match(config.process.frozen_engine_root, /walmart-listing-repair-engine-2026-08-01-v50/u);
  assert.equal(config.frozen_release_id_sha256,
    "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c");
  assert.equal(config.defer_image_repairs, true);
});

test("production config is pinned to V50 release and global admission identity", () => {
  const config = walmartListingIntegrityControlWorkerProcessConfig(
    "/Users/vladimirkuznetsov/SS Command Center/ss-control-center",
  );
  assert.equal(
    config.release_id_sha256,
    "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c",
  );
  assert.equal(
    config.manifest_sha256,
    "65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff",
  );
  assert.equal(
    config.global_admission_identity_sha256,
    "971d12097b154220d0818a03af8d78679aac26bf42a024ac654e7f4256232650",
  );
});

test("diagnosis process uses the workspace engine and explicit env file", () => {
  const config = walmartListingIntegrityDiagnosisProcessConfig(
    "/Users/vladimirkuznetsov/SS Command Center/ss-control-center",
  );
  assert.equal(
    config.engine_root,
    "/Users/vladimirkuznetsov/SS Command Center/ss-control-center",
  );
  assert.equal(
    config.env_file,
    "/Users/vladimirkuznetsov/SS Command Center/ss-control-center/.env",
  );
});

test("frozen supervisor separates immutable code from mutable workspace data", () => {
  const workspace = "/Users/vladimirkuznetsov/SS Command Center/ss-control-center";
  const engine = "/private/releases/walmart-listing-integrity-control/engine/ss-control-center";
  const diagnosis = walmartListingIntegrityDiagnosisProcessConfig(workspace, engine);
  assert.equal(diagnosis.engine_root, engine);
  assert.equal(diagnosis.env_file, `${workspace}/.env`);
  const remediation = walmartListingIntegrityRemediationConfig(workspace, engine);
  assert.equal(remediation.process.workspace_engine_root, engine);
  assert.equal(remediation.process.env_file, `${workspace}/.env`);
  assert.match(remediation.process.frozen_engine_root,
    /walmart-listing-repair-engine-2026-08-01-v50/u);
});

test("npm entrypoint loads the same .env used by frozen wrapper and Prisma", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../../package.json", import.meta.url),
    "utf8",
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["walmart:listing-integrity:worker"],
    "node --env-file=.env --import tsx scripts/walmart-listing-integrity-control-worker.ts",
  );
});
