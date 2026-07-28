import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWalmartItemReportReissueV2EngineRelease,
  collectWalmartItemReportReissueV2EngineClosure,
  runWalmartItemReportReissueV2Cli,
  verifyWalmartItemReportReissueV2EngineRelease,
} from "../walmart-item-report-reissue-v2.mjs";
import { canonicalWalmartItemReportJson } from "../../src/lib/walmart/item-report-published-source.ts";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("help exposes enrolled trust root but no live request command", async () => {
  const help = await runWalmartItemReportReissueV2Cli(["help"]);
  assert.equal(help.network_calls, 0);
  assert.equal(
    help.retired_commands["evidence-seal"],
    "superseded by separately frozen content-addressed sealer",
  );
  assert.ok(help.unavailable_until_owner_key_enrollment_and_execution_certification
    .includes("execute-create"));
  const status = await runWalmartItemReportReissueV2Cli(["trust-root-status"]);
  assert.equal(status.trust_root.ready, true);
  assert.deepEqual(status.trust_root.active_key_ids, [
    "walmart-owner-control-2026-01",
  ]);
  assert.equal(status.live_report_create_path_enabled, false);
  assert.equal(status.network_calls, 0);
});

test("in-process evidence-seal is hard-retired", async () => {
  await assert.rejects(
    runWalmartItemReportReissueV2Cli(["evidence-seal"]),
    /in-process evidence-seal is retired/,
  );
});

test("uncertified execution command is unavailable", async () => {
  await assert.rejects(
    runWalmartItemReportReissueV2Cli(["execute-create"]),
    /unsupported or not-yet-certified command/,
  );
});

test("engine release binds the complete local transitive closure and rejects omission", async () => {
  const release = await buildWalmartItemReportReissueV2EngineRelease();
  assert.equal(release.schema_version, "walmart-item-report-reissue-v2-engine-release/2.0.0");
  for (const requiredPath of [
    "scripts/walmart-item-report-reissue-v2.mjs",
    "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
    "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
    "src/lib/walmart/owner-control-trust-root.ts",
    "src/lib/walmart/item-report-published-source.ts",
    "src/lib/walmart/item-report-reissue-permit.ts",
    "src/lib/walmart/catalog-truth-export.ts",
    "package.json",
    "package-lock.json",
  ]) {
    assert.ok(release.files.some((file) => file.path === requiredPath), requiredPath);
  }
  assert.ok(release.files.length > release.entrypoints.length);
  await verifyWalmartItemReportReissueV2EngineRelease(release);

  const omitted = structuredClone(release);
  omitted.files = omitted.files.filter(
    (file) => file.path !== "src/lib/walmart/item-report-published-source.ts",
  );
  omitted.files_sha256 = sha256(canonicalWalmartItemReportJson(omitted.files));
  await assert.rejects(
    verifyWalmartItemReportReissueV2EngineRelease(omitted),
    /does not exactly match the current transitive dependency closure/,
  );
});

test("engine closure detects drift in a local transitive dependency", async (t) => {
  const created = await mkdtemp(path.join(tmpdir(), "walmart-reissue-v2-engine-"));
  const projectRoot = await realpath(created);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, "package.json"), "{}\n", { mode: 0o600 });
  await writeFile(path.join(projectRoot, "package-lock.json"), "{}\n", { mode: 0o600 });
  await writeFile(path.join(projectRoot, "entry.ts"), 'import { value } from "./dep.ts";\nexport { value };\n', {
    mode: 0o600,
  });
  await writeFile(path.join(projectRoot, "dep.ts"), "export const value = 1;\n", { mode: 0o600 });
  const input = { project_root: projectRoot, entrypoints: ["entry.ts"] };
  const before = await buildWalmartItemReportReissueV2EngineRelease(input);
  assert.deepEqual(
    (await collectWalmartItemReportReissueV2EngineClosure(input)).files.map((file) => file.path),
    ["dep.ts", "entry.ts", "package-lock.json", "package.json"],
  );
  await writeFile(path.join(projectRoot, "dep.ts"), "export const value = 2;\n", { mode: 0o600 });
  const after = await buildWalmartItemReportReissueV2EngineRelease(input);
  assert.notEqual(before.files_sha256, after.files_sha256);
  await assert.rejects(
    verifyWalmartItemReportReissueV2EngineRelease(before, input),
    /does not exactly match the current transitive dependency closure/,
  );
});
