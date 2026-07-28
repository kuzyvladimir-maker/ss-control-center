import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  runWalmartNewSkuReleaseCli,
} from "../../../../scripts/walmart-new-sku-release";
import {
  canonicalWalmartNewSkuFrozenReleaseArtifact,
  createWalmartNewSkuFrozenRelease,
  inspectWalmartNewSkuSourceRelease,
  verifyWalmartNewSkuFrozenRelease,
  WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS,
  WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS,
  WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS,
  WalmartNewSkuSourceReleaseError,
  walmartNewSkuSourceReleaseSha256,
  type WalmartNewSkuFrozenReleaseManifest,
} from "../walmart-new-sku-source-release";

async function makeDirectoriesWritable(root: string): Promise<void> {
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  await chmod(root, 0o755);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesWritable(join(root, entry.name));
    }
  }
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "walmart-new-sku-release-"));
  t.after(async () => {
    await makeDirectoriesWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    mkdir(join(root, "src", "nested"), { recursive: true }),
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "prisma", "migrations", "20260719000000_fixture"), {
      recursive: true,
    }),
    mkdir(join(root, "data", "secret"), { recursive: true }),
    mkdir(join(root, "node_modules", "fixture"), { recursive: true }),
  ]);
  for (const packageName of WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS) {
    if (packageName === "tsx") continue;
    const packageRoot = join(root, "node_modules", ...packageName.split("/"));
    await mkdir(packageRoot, { recursive: true });
    const isEsmRuntimePackage = packageName === "@libsql/client";
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      version: "1.0.0-fixture",
      ...(isEsmRuntimePackage
        ? { type: "module", exports: "./index.mjs" }
        : {}),
      ...(packageName === "next"
        ? { optionalDependencies: { "next-unused-native": "1.0.0" } }
        : {}),
    }));
    if (isEsmRuntimePackage) {
      await writeFile(
        join(packageRoot, "index.mjs"),
        packageName === "@libsql/client"
          ? "export const createClient = () => { throw new Error('fixture only'); };\n"
          : "export {};\n",
      );
    }
  }
  await mkdir(
    join(root, "node_modules", "next", "node_modules", "next-unused-native"),
    { recursive: true },
  );
  await writeFile(
    join(
      root,
      "node_modules",
      "next",
      "node_modules",
      "next-unused-native",
      "package.json",
    ),
    JSON.stringify({ name: "next-unused-native", version: "1.0.0" }),
  );
  for (const packageName of ["tsx", "esbuild", "get-tsconfig", "resolve-pkg-maps"]) {
    await cp(
      join(process.cwd(), "node_modules", packageName),
      join(root, "node_modules", packageName),
      { recursive: true },
    );
  }
  const installedEsbuildPlatforms = await readdir(
    join(process.cwd(), "node_modules", "@esbuild"),
  );
  for (const platformPackage of installedEsbuildPlatforms) {
    await cp(
      join(process.cwd(), "node_modules", "@esbuild", platformPackage),
      join(root, "node_modules", "@esbuild", platformPackage),
      { recursive: true },
    );
  }
  await mkdir(join(root, "src", "lib", "bundle-factory"), { recursive: true });
  await Promise.all([
    copyFile(join(process.cwd(), "AGENTS.md"), join(root, "AGENTS.md")),
    copyFile(join(process.cwd(), "CLAUDE.md"), join(root, "CLAUDE.md")),
    ...[
      "_gen.ts",
      "_gimgres.ts",
      "_multi.ts",
      "_qavalidate.ts",
      "_trial100.ts",
      "prisma.config.ts",
      "vercel.json",
    ].map((file) => copyFile(join(process.cwd(), file), join(root, file))),
    writeFile(join(root, "src", "index.ts"), "export const fixture = 1;\n"),
    writeFile(join(root, "src", "nested", "value.ts"), "export const value = 2;\n"),
    copyFile(
      join(process.cwd(), "scripts", "walmart-new-sku-engine.ts"),
      join(root, "scripts", "walmart-new-sku-engine.ts"),
    ),
    copyFile(
      join(process.cwd(), "scripts", "walmart-new-sku-release.ts"),
      join(root, "scripts", "walmart-new-sku-release.ts"),
    ),
    copyFile(
      join(
        process.cwd(),
        "src", "lib", "bundle-factory", "walmart-new-sku-source-release.ts",
      ),
      join(
        root,
        "src", "lib", "bundle-factory", "walmart-new-sku-source-release.ts",
      ),
    ),
    writeFile(
      join(root, "prisma", "migrations", "20260719000000_fixture", "migration.sql"),
      "CREATE TABLE Fixture (id TEXT PRIMARY KEY);\n",
    ),
    writeFile(join(root, "prisma", "schema.prisma"), "generator client {}\n"),
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "fixture",
      private: true,
      engines: { node: ">=24.0.0 <26" },
      scripts: {
        "walmart:new-sku": "node --import tsx scripts/walmart-new-sku-engine.ts",
        "walmart:new-sku:release": "node --import tsx scripts/walmart-new-sku-release.ts",
      },
    }, null, 2)}\n`),
    writeFile(join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n"),
    writeFile(join(root, "tsconfig.json"), "{}\n"),
    writeFile(join(root, ".env"), "PRODUCTION_SECRET=must-not-copy\n"),
    writeFile(join(root, "data", "secret", "row.json"), "{\"secret\":true}\n"),
    writeFile(join(root, "node_modules", "fixture", "index.js"), "module.exports=1;\n"),
  ]);
  return root;
}

async function outsideReleaseOutput(t: TestContext, name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "walmart-new-sku-release-output-"));
  t.after(async () => {
    await makeDirectoriesWritable(parent);
    await rm(parent, { recursive: true, force: true });
  });
  return join(parent, name);
}

async function runProcess(command: string, args: string[], cwd = process.cwd()): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout,
      stderr,
    }));
  });
}

async function runNode(args: string[], cwd = process.cwd()) {
  return runProcess(process.execPath, args, cwd);
}

test("source release inspection is deterministic and excludes runtime secrets/data", async (t) => {
  const root = await fixture(t);
  const first = await inspectWalmartNewSkuSourceRelease(root);
  const second = await inspectWalmartNewSkuSourceRelease(root);
  assert.deepEqual(first, second);
  assert.equal(
    first.engine_release_sha256,
    walmartNewSkuSourceReleaseSha256(first.descriptor),
  );
  assert.match(first.engine_release_sha256, /^[a-f0-9]{64}$/);
  const sourcePaths = first.descriptor.source_entries.map(
    (entry) => entry.relative_path,
  );
  const dependencyPaths = first.descriptor.runtime_dependencies.entries.map(
    (entry) => entry.relative_path,
  );
  const sorted = (values: string[]) => [...values].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  assert.deepEqual(sourcePaths, sorted(sourcePaths));
  assert.deepEqual(dependencyPaths, sorted(dependencyPaths));
  assert.equal(sourcePaths.includes(".env"), false);
  assert.equal(sourcePaths.includes("AGENTS.md"), true);
  assert.equal(sourcePaths.includes("CLAUDE.md"), true);
  assert.equal(sourcePaths.includes("vercel.json"), true);
  assert.equal(sourcePaths.includes("_trial100.ts"), true);
  assert.equal(sourcePaths.some((path) => path.startsWith("data/")), false);
  assert.equal(sourcePaths.some((path) => path.startsWith("node_modules/")), false);
  assert.equal(dependencyPaths.includes("node_modules/fixture"), false);
  assert.equal(
    dependencyPaths.some((entry) => entry.includes("next-unused-native")),
    false,
  );
  assert.equal(
    first.descriptor.runtime_dependencies.packages.some(
      (pkg) => pkg.name === "next-unused-native",
    ),
    false,
  );
  assert.deepEqual(
    first.descriptor.runtime_dependencies.optional_dependency_omissions,
    WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS,
  );
  assert.equal(first.descriptor.node_runtime.platform, process.platform);
  assert.equal(first.descriptor.node_runtime.arch, process.arch);
});

test("operator engine accepts credentials only from externally injected process env", async () => {
  const source = await readFile(
    join(process.cwd(), "scripts", "walmart-new-sku-engine.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']dotenv["']/);
  assert.doesNotMatch(source, /dotenv\/config/);
  assert.doesNotMatch(source, /config\(\{\s*path:\s*["']\.env/);
});

test("source inspection deterministically excludes .DS_Store metadata", async (t) => {
  const root = await fixture(t);
  const metadataPath = join(root, "src", "nested", ".DS_Store");
  await writeFile(metadataPath, "first ambient Finder state\n");
  const first = await inspectWalmartNewSkuSourceRelease(root);
  await writeFile(metadataPath, "different ambient Finder state\n");
  const second = await inspectWalmartNewSkuSourceRelease(root);
  assert.equal(second.engine_release_sha256, first.engine_release_sha256);
  assert.deepEqual(second.descriptor, first.descriptor);
  assert.deepEqual(
    first.descriptor.excluded_source_metadata_basenames,
    WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS,
  );
  assert.equal(
    first.descriptor.source_entries.some(
      (entry) => entry.relative_path.endsWith("/.DS_Store"),
    ),
    false,
  );
});

test("freeze creates a self-verifying read-only source snapshot and never overwrites", async (t) => {
  const root = await fixture(t);
  const outputDirectory = await outsideReleaseOutput(t, "release-001");
  const result = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory,
    createdAt: "2026-07-19T04:30:00.000Z",
  });
  const verified = await verifyWalmartNewSkuFrozenRelease({
    releaseRoot: result.release_root,
    manifestPath: result.manifest_path,
    manifestSha256Path: result.manifest_sha256_path,
    expectedEngineReleaseSha256: result.engine_release_sha256,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.entry_count, result.entry_count);
  const manifestBytes = await readFile(result.manifest_path, "utf8");
  const manifest = JSON.parse(manifestBytes) as WalmartNewSkuFrozenReleaseManifest;
  assert.equal(
    canonicalWalmartNewSkuFrozenReleaseArtifact(manifest),
    manifestBytes,
  );
  assert.equal(manifest.claims.ambient_credential_files_included, false);
  assert.equal(manifest.claims.embedded_secret_scan_performed, false);
  assert.equal(manifest.claims.application_data_directory_included, false);
  assert.equal(manifest.claims.runtime_dependencies_included, true);
  assert.equal(manifest.claims.runtime_dependencies_sealed, true);
  assert.equal(manifest.claims.operator_contract_file_included, true);
  assert.equal(manifest.claims.claude_operator_contract_bootstrap_included, true);
  assert.equal(manifest.claims.operator_surface_isolated, false);
  assert.equal(manifest.claims.product_truth_git_release_redefined, false);
  await assert.rejects(readFile(join(result.release_root, ".env")));
  await assert.rejects(readFile(join(result.release_root, "data", "secret", "row.json")));
  await assert.rejects(readFile(
    join(result.release_root, "node_modules", "fixture", "index.js"),
  ));
  assert.match(
    await readFile(join(result.release_root, "AGENTS.md"), "utf8"),
    /Claude Code may run only the frozen operator commands/,
  );
  assert.match(
    await readFile(join(result.release_root, "CLAUDE.md"), "utf8"),
    /@AGENTS\.md/,
  );
  assert.match(
    await readFile(join(result.release_root, "node_modules", "tsx", "package.json"), "utf8"),
    /4\.20\.6/,
  );
  const frozenFile = await lstat(join(result.release_root, "src", "index.ts"));
  const frozenDirectory = await lstat(join(result.release_root, "src"));
  const frozenRoot = await lstat(result.release_root);
  assert.equal(frozenFile.mode & 0o222, 0);
  assert.equal(frozenDirectory.mode & 0o222, 0);
  assert.equal(frozenRoot.mode & 0o777, 0o555);
  await assert.rejects(
    createWalmartNewSkuFrozenRelease({
      sourceRoot: root,
      outputDirectory,
      createdAt: "2026-07-19T04:30:00.000Z",
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "RELEASE_OUTPUT_EXISTS_OR_UNWRITABLE",
  );
});

test("verify rejects byte drift and sidecar tampering", async (t) => {
  const root = await fixture(t);
  const firstOutput = await outsideReleaseOutput(t, "release-byte-drift");
  const first = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: firstOutput,
    createdAt: "2026-07-19T04:31:00.000Z",
  });
  const copiedFile = join(first.release_root, "src", "index.ts");
  await chmod(join(first.release_root, "src"), 0o755);
  await chmod(copiedFile, 0o644);
  await writeFile(copiedFile, "export const fixture = 999;\n");
  await chmod(copiedFile, 0o444);
  await chmod(join(first.release_root, "src"), 0o555);
  await chmod(first.release_root, 0o555);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: first.release_root,
      manifestPath: first.manifest_path,
      manifestSha256Path: first.manifest_sha256_path,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_TOPOLOGY_OR_CONTENT_DRIFT",
  );

  const secondOutput = await outsideReleaseOutput(t, "release-sidecar-drift");
  const second = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: secondOutput,
    createdAt: "2026-07-19T04:32:00.000Z",
  });
  await chmod(second.manifest_sha256_path, 0o600);
  await writeFile(second.manifest_sha256_path, `${"0".repeat(64)}\n`);
  await chmod(second.manifest_sha256_path, 0o444);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: second.release_root,
      manifestPath: second.manifest_path,
      manifestSha256Path: second.manifest_sha256_path,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_MANIFEST_SHA_MISMATCH",
  );
});

test("inspection rejects symlinks anywhere inside the release boundary", async (t) => {
  const root = await fixture(t);
  await symlink(join(root, "package.json"), join(root, "src", "linked-package.json"));
  await assert.rejects(
    inspectWalmartNewSkuSourceRelease(root),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "RELEASE_SYMLINK_FORBIDDEN",
  );
});

test("inspection rejects an ambient credential file inside a selected source tree", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "scripts", ".env.local"), "DATABASE_URL=file:attack.db\n");
  await assert.rejects(
    inspectWalmartNewSkuSourceRelease(root),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "RELEASE_AMBIENT_CREDENTIAL_FILE_FORBIDDEN"
      && error.message.includes("scripts/.env.local"),
  );
});

test("engine digest binds dependency bytes, executable mode, platform and arch", async (t) => {
  const root = await fixture(t);
  const dependency = join(root, "node_modules", "tsx", "dist", "loader.mjs");
  const originalMode = (await lstat(dependency)).mode & 0o777;
  const original = await inspectWalmartNewSkuSourceRelease(root);
  await chmod(dependency, 0o644);
  await writeFile(dependency, "export const changed = true;\n");
  await chmod(dependency, originalMode);
  const byteChanged = await inspectWalmartNewSkuSourceRelease(root);
  assert.notEqual(byteChanged.engine_release_sha256, original.engine_release_sha256);
  await chmod(dependency, (originalMode & 0o111) === 0 ? 0o755 : 0o644);
  const modeChanged = await inspectWalmartNewSkuSourceRelease(root);
  assert.notEqual(modeChanged.engine_release_sha256, byteChanged.engine_release_sha256);
  const otherRuntime = structuredClone(modeChanged.descriptor);
  otherRuntime.node_runtime.arch = `${process.arch}-other`;
  assert.notEqual(
    walmartNewSkuSourceReleaseSha256(otherRuntime),
    modeChanged.engine_release_sha256,
  );
});

test("verify rejects an injected root .env even when it is read-only", async (t) => {
  const root = await fixture(t);
  const output = await outsideReleaseOutput(t, "release-extra-env");
  const frozen = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: output,
  });
  await chmod(frozen.release_root, 0o755);
  await writeFile(join(frozen.release_root, ".env"), "DATABASE_URL=file:attack.db\n", {
    mode: 0o444,
  });
  await chmod(frozen.release_root, 0o555);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: frozen.release_root,
      manifestPath: frozen.manifest_path,
      manifestSha256Path: frozen.manifest_sha256_path,
      expectedEngineReleaseSha256: frozen.engine_release_sha256,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_TOPOLOGY_OR_CONTENT_DRIFT"
      && error.message.includes(".env"),
  );
});

test("verify rejects dependency byte and exact mode drift", async (t) => {
  const root = await fixture(t);
  const byteOutput = await outsideReleaseOutput(t, "release-dependency-byte");
  const byteFrozen = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: byteOutput,
  });
  const byteTarget = join(
    byteFrozen.release_root,
    "node_modules", "tsx", "dist", "loader.mjs",
  );
  await chmod(join(byteFrozen.release_root, "node_modules", "tsx"), 0o755);
  await chmod(byteTarget, 0o644);
  await writeFile(byteTarget, "export const tampered = true;\n");
  await chmod(byteTarget, 0o444);
  await chmod(join(byteFrozen.release_root, "node_modules", "tsx"), 0o555);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: byteFrozen.release_root,
      manifestPath: byteFrozen.manifest_path,
      manifestSha256Path: byteFrozen.manifest_sha256_path,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_TOPOLOGY_OR_CONTENT_DRIFT",
  );

  const modeOutput = await outsideReleaseOutput(t, "release-dependency-mode");
  const modeFrozen = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: modeOutput,
  });
  const modeTarget = join(
    modeFrozen.release_root,
    "node_modules", "tsx", "dist", "loader.mjs",
  );
  await chmod(modeTarget, 0o444);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: modeFrozen.release_root,
      manifestPath: modeFrozen.manifest_path,
      manifestSha256Path: modeFrozen.manifest_sha256_path,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_TOPOLOGY_OR_CONTENT_DRIFT",
  );
});

test("verify rejects a dependency symlink before following it", async (t) => {
  const root = await fixture(t);
  const output = await outsideReleaseOutput(t, "release-dependency-symlink");
  const frozen = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: output,
  });
  const packageRoot = join(frozen.release_root, "node_modules", "tsx");
  await chmod(packageRoot, 0o755);
  await symlink("index.mjs", join(packageRoot, "injected-link.mjs"));
  await chmod(packageRoot, 0o555);
  await assert.rejects(
    verifyWalmartNewSkuFrozenRelease({
      releaseRoot: frozen.release_root,
      manifestPath: frozen.manifest_path,
      manifestSha256Path: frozen.manifest_sha256_path,
    }),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "FROZEN_RELEASE_SYMLINK_FORBIDDEN",
  );
});

test("frozen root runs actual operator help and release verify without workspace dependencies", async (t) => {
  const root = await fixture(t);
  const output = await outsideReleaseOutput(t, "release-runnable");
  const frozen = await createWalmartNewSkuFrozenRelease({
    sourceRoot: root,
    outputDirectory: output,
  });
  const help = await runProcess(
    "npm",
    ["--silent", "run", "walmart:new-sku", "--", "--help"],
    frozen.release_root,
  );
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /doctor/);
  assert.match(help.stdout, /engine-emitted exact next command/);
  assert.match(help.stdout, /schedule\/cron/);
  const verified = await runProcess(
    "npm",
    [
      "--silent", "run", "walmart:new-sku:release", "--", "verify",
      "--release-root", frozen.release_root,
      "--manifest", frozen.manifest_path,
      "--manifest-sha", frozen.manifest_sha256_path,
      "--expected-engine-release-sha", frozen.engine_release_sha256,
    ],
    frozen.release_root,
  );
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /"ok": true/);
  assert.match(verified.stdout, /"command": "verify"/);
});

test("release CLI freezes and verifies only explicit absolute paths", async (t) => {
  const help = await runWalmartNewSkuReleaseCli(["help"]) as {
    help: string;
  };
  assert.match(help.help, /--expected-engine-release-sha SHA256/);
  assert.match(help.help, /seals AGENTS\.md/);
  assert.doesNotMatch(
    help.help,
    /\[--expected-engine-release-sha SHA256\]/,
  );
  const root = await fixture(t);
  const outputDirectory = await outsideReleaseOutput(t, "cli-release");
  const frozen = await runWalmartNewSkuReleaseCli([
    "freeze",
    "--source-root", root,
    "--out", outputDirectory,
    "--created-at", "2026-07-19T04:33:00.000Z",
  ], "freeze") as Record<string, unknown>;
  assert.equal(frozen.ok, true);
  assert.equal(frozen.command, "freeze");
  assert.equal(frozen.marketplace_mutated, false);
  assert.equal(frozen.database_mutated, false);
  const verified = await runWalmartNewSkuReleaseCli([
    "verify",
    "--release-root", join(outputDirectory, "release"),
    "--manifest", join(outputDirectory, "release-manifest.json"),
    "--manifest-sha", join(outputDirectory, "release-manifest.sha256"),
    "--expected-engine-release-sha", String(frozen.engine_release_sha256),
  ]) as Record<string, unknown>;
  assert.equal(verified.ok, true);
  assert.equal(verified.command, "verify");
  await assert.rejects(
    runWalmartNewSkuReleaseCli([
      "verify",
      "--release-root", join(outputDirectory, "release"),
      "--manifest", join(outputDirectory, "release-manifest.json"),
      "--manifest-sha", join(outputDirectory, "release-manifest.sha256"),
    ]),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "CLI_ENGINE_RELEASE_SHA_INVALID",
  );
  await assert.rejects(
    runWalmartNewSkuReleaseCli([
      "freeze",
      "--source-root", root,
      "--out", join(outputDirectory, "operator-forbidden-freeze"),
    ]),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "CLI_COMMAND_FORBIDDEN_ON_SURFACE",
  );
  await assert.rejects(
    runWalmartNewSkuReleaseCli([
      "freeze",
      "--source-root", root,
      "--out", "relative-release",
    ], "freeze"),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "CLI_ABSOLUTE_PATH_REQUIRED",
  );
  await assert.rejects(
    runWalmartNewSkuReleaseCli([
      "freeze",
      "--source-root", root,
      "--out", join(root, "src", "forbidden-release"),
    ], "freeze"),
    (error: unknown) =>
      error instanceof WalmartNewSkuSourceReleaseError
      && error.code === "RELEASE_OUTPUT_INSIDE_SOURCE_FORBIDDEN",
  );
  await assert.rejects(lstat(join(root, "src", "forbidden-release")));

  const wrapperOutput = await outsideReleaseOutput(t, "cli-freeze-wrapper");
  const wrapper = await runNode([
    "--import", "tsx",
    join(process.cwd(), "scripts", "walmart-new-sku-release-freeze.ts"),
    "--source-root", root,
    "--out", wrapperOutput,
    "--created-at", "2026-07-19T04:34:00.000Z",
  ]);
  assert.equal(wrapper.code, 0, wrapper.stderr);
  const wrapperResult = JSON.parse(wrapper.stdout) as Record<string, unknown>;
  assert.equal(wrapperResult.command, "freeze");
  assert.equal(wrapperResult.marketplace_mutated, false);
});
