import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  createWalmartNewSkuFrozenRelease,
  WalmartNewSkuSourceReleaseError,
} from "@/lib/bundle-factory/walmart-new-sku-source-release";

const APP_ROOT = process.cwd();
const CLI = path.join(APP_ROOT, "scripts", "walmart-new-sku-engine.ts");
const OWNER_CLI = path.join(APP_ROOT, "scripts", "walmart-new-sku-owner.ts");

interface FrozenRuntime {
  outputRoot: string;
  releaseRoot: string;
  manifestPath: string;
  manifestShaPath: string;
  engineReleaseSha256: string;
}

let frozenRuntime: FrozenRuntime;

async function makeDirectoriesWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesWritable(path.join(root, entry.name));
    }
  }
}

before(async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "walmart-new-sku-config-release-"));
  let result: Awaited<ReturnType<typeof createWalmartNewSkuFrozenRelease>> | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5 && !result; attempt += 1) {
    try {
      result = await createWalmartNewSkuFrozenRelease({
        sourceRoot: APP_ROOT,
        outputDirectory: path.join(parent, `frozen-${attempt}`),
      });
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof WalmartNewSkuSourceReleaseError) ||
        error.code !== "RELEASE_COPY_VERIFICATION_FAILED"
      ) {
        throw error;
      }
    }
  }
  if (!result) throw lastError;
  frozenRuntime = {
    outputRoot: parent,
    releaseRoot: result.release_root,
    manifestPath: result.manifest_path,
    manifestShaPath: result.manifest_sha256_path,
    engineReleaseSha256: result.engine_release_sha256,
  };
});

after(async () => {
  if (!frozenRuntime) return;
  await makeDirectoriesWritable(frozenRuntime.outputRoot);
  await rm(frozenRuntime.outputRoot, { recursive: true, force: true });
});

async function runDoctor(
  env: Record<string, string>,
  commandInput: string | string[] = "doctor",
  options: {
    cli?: string;
    injectExpectedRelease?: boolean;
    injectAsOf?: boolean;
    injectReleaseManifest?: boolean;
    injectCatalogSource?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const commandParts = Array.isArray(commandInput) ? commandInput : [commandInput];
  const requestedCli = options.cli ?? CLI;
  const runtimeCli = requestedCli.startsWith(`${APP_ROOT}${path.sep}`)
    ? path.join(frozenRuntime.releaseRoot, path.relative(APP_ROOT, requestedCli))
    : requestedCli;
  const commandArgs = ["--import", "tsx", runtimeCli, ...commandParts];
  if (
    commandParts[0] === "doctor" &&
    options.injectExpectedRelease !== false &&
    !commandParts.includes("--expected-engine-release-sha")
  ) {
    commandArgs.push(
      "--expected-engine-release-sha",
      frozenRuntime.engineReleaseSha256,
    );
  }
  if (
    commandParts[0] === "doctor" &&
    options.injectAsOf !== false &&
    !commandParts.includes("--as-of")
  ) {
    commandArgs.push("--as-of", new Date().toISOString());
  }
  if (
    commandParts[0] === "doctor" &&
    options.injectReleaseManifest !== false &&
    !commandParts.includes("--release-manifest")
  ) {
    commandArgs.push(
      "--release-manifest", frozenRuntime.manifestPath,
      "--release-manifest-sha", frozenRuntime.manifestShaPath,
    );
  }
  if (
    commandParts[0] === "doctor" &&
    options.injectCatalogSource !== false &&
    !commandParts.includes("--item-report-catalog-source")
  ) {
    commandArgs.push(
      "--item-report-catalog-source",
      path.join(frozenRuntime.releaseRoot, "test-item-report-catalog-source.json"),
      "--expected-item-report-catalog-source-sha256",
      "0".repeat(64),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      commandArgs,
      {
        cwd: frozenRuntime.releaseRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

test("plan refuses to seal an artifact without a fresh doctor receipt", async () => {
  const result = await runDoctor({
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "",
    DATABASE_URL: "file:/tmp/walmart-new-sku-plan-must-not-open.db",
    WALMART_CLIENT_ID_STORE1: "",
    WALMART_CLIENT_SECRET_STORE1: "",
    WALMART_STORE1_SELLER_ID: "",
  }, "plan");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /plan requires --doctor-receipt/,
  );
  assert.doesNotMatch(result.stderr, /plan-must-not-open/);
});

test("remote TURSO_DATABASE_URL never falls back without its auth token", async () => {
  const result = await runDoctor({
    TURSO_DATABASE_URL: "libsql://sealed-target.invalid",
    TURSO_AUTH_TOKEN: "",
    DATABASE_URL: "file:/tmp/walmart-new-sku-fallback-must-not-open.db",
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /TURSO_AUTH_TOKEN is required when remote TURSO_DATABASE_URL is selected/,
  );
  assert.doesNotMatch(result.stderr, /sealed-target|fallback-must-not-open/);
});

test("local Turso selector without auth must equal Prisma DATABASE_URL target", async () => {
  const result = await runDoctor({
    TURSO_DATABASE_URL: "file:/tmp/walmart-new-sku-read-target.db",
    TURSO_AUTH_TOKEN: "",
    DATABASE_URL: "file:/tmp/walmart-new-sku-write-target.db",
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /DATABASE_URL resolves to the same file target/,
  );
  assert.doesNotMatch(result.stderr, /read-target|write-target/);
});

test("operator CLI rejects irrelevant flags and every out-of-pilot scope", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["verify", "--limit", "1"], /verify does not accept --limit/],
    [["stage", "--zip", "33765"], /stage does not accept --zip/],
    [["plan", "--limit", "2"], /--limit must be exactly 1/],
    [["doctor", "--store-index", "2"], /--store-index must be exactly 1/],
    [["doctor", "--zip", "90210"], /--zip must be exactly 33765/],
    [["doctor", "--pack-count", "4"], /--pack-count must be exactly 2 or 3/],
    [["doctor", "--max-price-age-hours", "23"],
      /--max-price-age-hours must be exactly 24/],
    [["stage", "--plan", "/tmp/plan", "--doctor-receipt", "/tmp/doctor",
      "--mode", "preview", "--actor", "ignored"],
      /stage --mode preview does not accept --actor/],
    [["apply", "--certification", "/tmp/cert", "--mode", "preview",
      "--owner-permit", "/tmp/permit"],
      /apply --mode preview does not accept --owner-permit/],
    [["approve", "--certification", "/tmp/cert", "--mode", "preview",
      "--confirm", "ignored"],
      /approve --mode preview does not accept --confirm/],
  ];
  for (const [args, expected] of cases) {
    const result = await runDoctor({}, args);
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, expected);
  }
});

test("doctor requires and checks the frozen release SHA before DB or Walmart", async () => {
  const missing = await runDoctor({}, ["doctor"], {
    injectExpectedRelease: false,
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /requires --expected-engine-release-sha/);

  const missingAsOf = await runDoctor({}, ["doctor"], {
    injectAsOf: false,
  });
  assert.equal(missingAsOf.code, 1);
  assert.match(missingAsOf.stderr, /doctor requires --as-of/);

  const missingManifest = await runDoctor({}, ["doctor"], {
    injectReleaseManifest: false,
  });
  assert.equal(missingManifest.code, 1);
  assert.match(missingManifest.stderr, /requires absolute --release-manifest/);

  const missingCatalogSource = await runDoctor({}, ["doctor"], {
    injectCatalogSource: false,
  });
  assert.equal(missingCatalogSource.code, 1);
  assert.match(
    missingCatalogSource.stderr,
    /requires normalized absolute --item-report-catalog-source/,
  );

  const relativeManifest = await runDoctor({}, [
    "doctor",
    "--release-manifest", "relative-manifest.json",
    "--release-manifest-sha", "relative-manifest.sha256",
  ], { injectReleaseManifest: false });
  assert.equal(relativeManifest.code, 1);
  assert.match(relativeManifest.stderr, /requires absolute --release-manifest/);

  const mismatch = await runDoctor({
    TURSO_DATABASE_URL: "libsql://must-not-open.invalid",
    TURSO_AUTH_TOKEN: "",
  }, [
    "doctor",
    "--expected-engine-release-sha", "0".repeat(64),
  ], { injectExpectedRelease: false });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /FROZEN_RELEASE_EXPECTED_ENGINE_SHA_MISMATCH/);
  assert.doesNotMatch(mismatch.stderr, /TURSO_AUTH_TOKEN|must-not-open/);

  for (const asOf of [
    new Date(Date.now() - 16 * 60_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  ]) {
    const staleOrFuture = await runDoctor({
      TURSO_DATABASE_URL: "libsql://must-not-open.invalid",
      TURSO_AUTH_TOKEN: "",
    }, ["doctor", "--as-of", asOf]);
    assert.equal(staleOrFuture.code, 1);
    assert.match(staleOrFuture.stderr, /DOCTOR_AS_OF_NOT_FRESH/);
    assert.doesNotMatch(staleOrFuture.stderr, /TURSO_AUTH_TOKEN|must-not-open/);
  }
});

test("operator and owner executables expose disjoint command sets", async () => {
  const operatorDenied = await runDoctor({}, ["owner-permit-request"]);
  assert.equal(operatorDenied.code, 1);
  assert.match(operatorDenied.stderr, /not available on the operator CLI surface/);

  const ownerDenied = await runDoctor({}, ["doctor"], {
    cli: OWNER_CLI,
    injectExpectedRelease: false,
  });
  assert.equal(ownerDenied.code, 1);
  assert.match(ownerDenied.stderr, /not available on the owner CLI surface/);
});
