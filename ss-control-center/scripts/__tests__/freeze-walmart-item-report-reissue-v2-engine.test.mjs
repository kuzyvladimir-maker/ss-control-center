import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  WALMART_ITEM_REPORT_REISSUE_V2_FROZEN_ENGINE_SCHEMA,
  canonicalWalmartItemReportReissueV2EngineJson,
  parseWalmartItemReportReissueV2EngineFreezeCli,
  validateWalmartItemReportReissueV2EngineMetafile,
} from "../freeze-walmart-item-report-reissue-v2-engine.mjs";

const execFile = promisify(execFileCallback);
const TEST_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(TEST_PATH), "../..");
const FREEZER_PATH = path.join(
  PROJECT_ROOT,
  "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs",
);
const ENTRYPOINT = "scripts/walmart-item-report-reissue-v2-frozen-sealer.mjs";
const BUNDLE = "walmart-item-report-reissue-v2-frozen-sealer.bundle.mjs";
const EXPECTED_FILES = [
  "engine-release.json",
  "engine-release.json.sha256",
  "freeze-report.json",
  "freeze-report.json.sha256",
  BUNDLE,
  `${BUNDLE}.sha256`,
].sort();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanNodeEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

async function privateTemp(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const exact = await realpath(directory);
  await chmod(exact, 0o700);
  return exact;
}

async function makeWritable(directory) {
  await chmod(directory, 0o700).catch(() => {});
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else await chmod(target, 0o600).catch(() => {});
  }
}

async function cleanup(directory) {
  await makeWritable(directory).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

async function runFreezer(outputDirectory) {
  return execFile(
    process.execPath,
    [FREEZER_PATH, "freeze", `--out=${outputDirectory}`],
    { cwd: PROJECT_ROOT, env: cleanNodeEnv(), maxBuffer: 4 * 1024 * 1024 },
  );
}

function validSyntheticMetafile() {
  return {
    inputs: {
      [ENTRYPOINT]: {
        bytes: 40,
        imports: [{ path: "node:fs", kind: "import-statement", external: true }],
      },
    },
    outputs: {
      [BUNDLE]: {
        imports: [{ path: "node:fs", kind: "import-statement", external: true }],
        exports: [],
        entryPoint: ENTRYPOINT,
        inputs: { [ENTRYPOINT]: { bytesInOutput: 20 } },
        bytes: 100,
      },
    },
  };
}

test("freezer CLI has one exact offline command and --name=value argument", () => {
  assert.deepEqual(
    parseWalmartItemReportReissueV2EngineFreezeCli([
      "freeze",
      "--out=/private/tmp/new-frozen-engine",
    ]),
    {
      command: "freeze",
      output_directory: "/private/tmp/new-frozen-engine",
    },
  );
  assert.throws(
    () => parseWalmartItemReportReissueV2EngineFreezeCli([
      "freeze", "--out", "/private/tmp/new-frozen-engine",
    ]),
    /usage:/,
  );
  assert.throws(
    () => parseWalmartItemReportReissueV2EngineFreezeCli([
      "freeze", "--out=relative",
    ]),
    /absolute path/,
  );
});

test("metafile policy allows only node:* externals and rejects package, absolute, file, # and unknown imports", () => {
  assert.deepEqual(
    validateWalmartItemReportReissueV2EngineMetafile(validSyntheticMetafile()),
    {
      input_names: [ENTRYPOINT],
      external_runtime_imports: ["node:fs"],
    },
  );

  for (const forbiddenPath of [
    "typescript",
    "/absolute/module.mjs",
    "file:///absolute/module.mjs",
    "#private-import",
    "https://example.invalid/module.mjs",
  ]) {
    const metafile = validSyntheticMetafile();
    metafile.inputs[ENTRYPOINT].imports = [{
      path: forbiddenPath,
      kind: "import-statement",
      external: forbiddenPath === "typescript",
    }];
    assert.throws(
      () => validateWalmartItemReportReissueV2EngineMetafile(metafile),
      /forbidden|non-node external|unresolved or unknown/,
      forbiddenPath,
    );
  }

  const unknownKind = validSyntheticMetafile();
  unknownKind.inputs[ENTRYPOINT].imports[0].kind = "future-import-kind";
  assert.throws(
    () => validateWalmartItemReportReissueV2EngineMetafile(unknownKind),
    /unknown import kind/,
  );
});

test("actual freezer publishes exact manifest inputs and private immutable output", async (t) => {
  const parent = await privateTemp("walmart-reissue-v2-freeze-");
  t.after(() => cleanup(parent));
  const output = path.join(parent, "engine-v1");
  const { stdout, stderr } = await runFreezer(output);
  assert.equal(stderr, "");
  const cli = JSON.parse(stdout);
  assert.equal(cli.status, "FROZEN_OFFLINE_ENGINE");
  assert.equal(cli.output_directory, output);

  assert.equal((await stat(output)).mode & 0o777, 0o500);
  assert.deepEqual((await readdir(output)).sort(), EXPECTED_FILES);
  for (const fileName of EXPECTED_FILES) {
    assert.equal((await stat(path.join(output, fileName))).mode & 0o777, 0o400);
  }

  const manifestBytes = await readFile(path.join(output, "engine-release.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema_version, WALMART_ITEM_REPORT_REISSUE_V2_FROZEN_ENGINE_SCHEMA);
  assert.equal(manifest.bundle.file_name, BUNDLE);
  const bundleBytes = await readFile(path.join(output, BUNDLE));
  assert.equal(manifest.bundle.byte_length, bundleBytes.byteLength);
  assert.equal(manifest.bundle.sha256, sha256(bundleBytes));
  assert.equal(cli.bundle_sha256, manifest.bundle.sha256);
  assert.equal(cli.engine_manifest_sha256, sha256(manifestBytes));

  assert.ok(manifest.source_inputs.length >= 3);
  assert.deepEqual(
    [...manifest.source_inputs].sort((left, right) => (
      left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0
    )),
    manifest.source_inputs,
  );
  for (const input of manifest.source_inputs) {
    const bytes = await readFile(path.join(PROJECT_ROOT, input.relative_path));
    assert.equal(input.byte_length, bytes.byteLength, input.relative_path);
    assert.equal(input.sha256, sha256(bytes), input.relative_path);
  }
  assert.equal(
    manifest.source_inputs_sha256,
    sha256(Buffer.from(
      canonicalWalmartItemReportReissueV2EngineJson(manifest.source_inputs),
      "utf8",
    )),
  );

  assert.deepEqual(
    manifest.certification_files.map((entry) => entry.role),
    [
      "ABSENCE_PROBE_EVIDENCE_MODULE",
      "ABSENCE_PROBE_EVIDENCE_TEST",
      "FREEZER_BUILDER",
      "FREEZER_TEST",
      "FROZEN_SEALER",
      "FROZEN_SEALER_TEST",
      "OWNER_DISPOSITION_MODULE",
      "OWNER_DISPOSITION_TEST",
      "SOURCE_EVIDENCE_MODULE",
      "SOURCE_EVIDENCE_RENEWAL_MODULE",
      "SOURCE_EVIDENCE_RENEWAL_TEST",
      "SOURCE_EVIDENCE_TEST",
    ],
  );
  for (const input of manifest.certification_files) {
    const bytes = await readFile(path.join(PROJECT_ROOT, input.relative_path));
    assert.equal(input.byte_length, bytes.byteLength, input.relative_path);
    assert.equal(input.sha256, sha256(bytes), input.relative_path);
  }
  assert.equal(
    manifest.certification_files_sha256,
    sha256(Buffer.from(
      canonicalWalmartItemReportReissueV2EngineJson(manifest.certification_files),
      "utf8",
    )),
  );
  assert.ok(manifest.external_runtime_imports.length > 0);
  assert.ok(manifest.external_runtime_imports.every((value) => value.startsWith("node:")));
  assert.deepEqual(manifest.runtime.required_exec_argv, []);
  assert.equal(manifest.runtime.node_options_required, "ABSENT");
  assert.equal(manifest.runtime.node_path_required, "ABSENT");
  assert.equal(manifest.runtime.node_version, process.version);
  assert.equal(manifest.runtime.platform, process.platform);
  assert.equal(manifest.runtime.arch, process.arch);
  const nodePath = await realpath(process.execPath);
  assert.equal(
    manifest.runtime.exec_path_realpath_sha256,
    sha256(Buffer.from(nodePath, "utf8")),
  );
  assert.equal(
    manifest.runtime.exec_path_artifact_sha256,
    sha256(await readFile(nodePath)),
  );
  assert.deepEqual(manifest.entrypoint.exact_argv_order, [
    "evidence-seal",
    "--engine-manifest",
    "--expect-engine-manifest-sha256",
    "--expect-frozen-bundle-sha256",
    "--project-root",
    "--evidence-root",
    "--capture-root",
    "--prior-session-name",
    "--release-id",
    "--reviewed-at",
    "--out",
  ]);

  for (const [artifactName, sidecarName] of [
    [BUNDLE, `${BUNDLE}.sha256`],
    ["engine-release.json", "engine-release.json.sha256"],
    ["freeze-report.json", "freeze-report.json.sha256"],
  ]) {
    const expected = `${sha256(await readFile(path.join(output, artifactName)))}  ${artifactName}\n`;
    assert.equal(await readFile(path.join(output, sidecarName), "utf8"), expected);
  }

  await assert.rejects(runFreezer(output), /must not already exist/);
});

const CERTIFICATION_PATHS = [
  "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs",
  "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs",
  ENTRYPOINT,
  "scripts/__tests__/walmart-item-report-reissue-v2-frozen-sealer.test.mjs",
  "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs",
  "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
  "scripts/__tests__/capture-walmart-item-v6-absence-probe.test.mjs",
  "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
  "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs",
  "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
  "src/lib/walmart/__tests__/item-report-reissue-source-evidence-renewal-v1.test.mjs",
];

async function fixtureProject(marker) {
  const root = await privateTemp("walmart-reissue-v2-fixture-project-");
  for (const relativePath of CERTIFICATION_PATHS) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, `export const fixture = ${JSON.stringify(relativePath)};\n`, {
      mode: 0o600,
    });
  }
  await writeFile(
    path.join(root, "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, ENTRYPOINT),
    "import { marker } from '../src/lib/walmart/item-report-reissue-owner-disposition-v2.ts';\n"
      + "export const frozenFixture = marker;\n",
    { mode: 0o600 },
  );
  return root;
}

async function runExportedFreezerInCleanNode(projectRoot, outputDirectory, helperParent) {
  const helper = path.join(helperParent, `invoke-${createHash("sha256")
    .update(outputDirectory).digest("hex").slice(0, 12)}.mjs`);
  await writeFile(
    helper,
    `import { freezeWalmartItemReportReissueV2Engine } from ${JSON.stringify(pathToFileURL(FREEZER_PATH).href)};\n`
      + `await freezeWalmartItemReportReissueV2Engine(${JSON.stringify({
        project_root: projectRoot,
        output_directory: outputDirectory,
      })});\n`,
    { mode: 0o600 },
  );
  return execFile(process.execPath, [helper], {
    cwd: PROJECT_ROOT,
    env: cleanNodeEnv(),
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("an exact imported-source drift changes bundle and manifest bindings", async (t) => {
  const project = await fixtureProject("marker-one");
  const outputParent = await privateTemp("walmart-reissue-v2-fixture-output-");
  const helperParent = await privateTemp("walmart-reissue-v2-fixture-helper-");
  t.after(() => Promise.all([
    cleanup(project), cleanup(outputParent), cleanup(helperParent),
  ]));

  const firstOutput = path.join(outputParent, "engine-one");
  await runExportedFreezerInCleanNode(project, firstOutput, helperParent);
  const first = JSON.parse(await readFile(path.join(firstOutput, "engine-release.json")));

  await chmod(project, 0o700);
  await writeFile(
    path.join(project, "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"),
    "export const marker = 'marker-two';\n",
    { mode: 0o600 },
  );
  const secondOutput = path.join(outputParent, "engine-two");
  await runExportedFreezerInCleanNode(project, secondOutput, helperParent);
  const second = JSON.parse(await readFile(path.join(secondOutput, "engine-release.json")));

  assert.notEqual(first.bundle.sha256, second.bundle.sha256);
  assert.notEqual(first.source_inputs_sha256, second.source_inputs_sha256);
  assert.notEqual(first.certification_files_sha256, second.certification_files_sha256);
});

test("unsafe or in-project output parents fail before publication", async (t) => {
  const unsafeParent = await privateTemp("walmart-reissue-v2-unsafe-output-");
  t.after(() => cleanup(unsafeParent));
  await chmod(unsafeParent, 0o755);
  await assert.rejects(
    runFreezer(path.join(unsafeParent, "must-not-exist")),
    /exact private mode 0700/,
  );
  await chmod(unsafeParent, 0o700);

  await assert.rejects(
    runFreezer(path.join(PROJECT_ROOT, "must-not-publish-inside-project")),
    /private mode 0700|outside the project root/,
  );
});
