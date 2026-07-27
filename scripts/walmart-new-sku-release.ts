#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";

import {
  createWalmartNewSkuFrozenRelease,
  verifyWalmartNewSkuFrozenRelease,
  WalmartNewSkuSourceReleaseError,
} from "../src/lib/bundle-factory/walmart-new-sku-source-release";

type Command = "freeze" | "verify" | "help";
export type WalmartNewSkuReleaseCliSurface = "verify" | "freeze";

interface CliOptions {
  command: Command;
  sourceRoot?: string;
  outputDirectory?: string;
  createdAt?: string;
  releaseRoot?: string;
  manifestPath?: string;
  manifestSha256Path?: string;
  expectedEngineReleaseSha256?: string;
}

function usage(): string {
  return [
    "Walmart new-SKU frozen source release (no credentials, DB or marketplace calls)",
    "",
    "Verify exact bytes and read-only source modes:",
    "  npm run walmart:new-sku:release -- verify",
    "    --release-root /ABS/RELEASE_DIR/release",
    "    --manifest /ABS/RELEASE_DIR/release-manifest.json",
    "    --manifest-sha /ABS/RELEASE_DIR/release-manifest.sha256",
    "    --expected-engine-release-sha SHA256",
    "",
    "The snapshot excludes ambient .env/.env.local and application data.",
    "It seals AGENTS.md plus the CLAUDE.md bootstrap with the exact Claude/operator allowlist and owner-only prohibitions.",
    "It includes an exact read-only runtime dependency closure; embedded-secret scanning is out of scope.",
    "It is a Walmart new-SKU runtime snapshot, not a redefinition of the Product Truth Git release.",
  ].join("\n");
}

function parseArgs(
  argv: string[],
  surface: WalmartNewSkuReleaseCliSurface,
): CliOptions {
  const rawCommand = argv[0] ?? "help";
  if (rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    return { command: "help" };
  }
  if (rawCommand !== "freeze" && rawCommand !== "verify") {
    throw new WalmartNewSkuSourceReleaseError(
      "CLI_COMMAND_INVALID",
      `unknown command ${rawCommand}`,
    );
  }
  if (rawCommand !== surface) {
    throw new WalmartNewSkuSourceReleaseError(
      "CLI_COMMAND_FORBIDDEN_ON_SURFACE",
      `${rawCommand} is not available on the ${surface} release surface`,
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new WalmartNewSkuSourceReleaseError(
        "CLI_ARGUMENT_INVALID",
        `expected --flag value near ${flag ?? "end of input"}`,
      );
    }
    if (values.has(flag)) {
      throw new WalmartNewSkuSourceReleaseError(
        "CLI_ARGUMENT_DUPLICATE",
        flag,
      );
    }
    values.set(flag, value);
  }
  const allowed = rawCommand === "freeze"
    ? new Set(["--source-root", "--out", "--created-at"])
    : new Set([
        "--release-root",
        "--manifest",
        "--manifest-sha",
        "--expected-engine-release-sha",
      ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) {
      throw new WalmartNewSkuSourceReleaseError(
        "CLI_ARGUMENT_FORBIDDEN",
        flag,
      );
    }
  }
  if (rawCommand === "freeze") {
    return {
      command: "freeze",
      sourceRoot: values.get("--source-root"),
      outputDirectory: values.get("--out"),
      createdAt: values.get("--created-at"),
    };
  }
  return {
    command: "verify",
    releaseRoot: values.get("--release-root"),
    manifestPath: values.get("--manifest"),
    manifestSha256Path: values.get("--manifest-sha"),
    expectedEngineReleaseSha256: values.get("--expected-engine-release-sha"),
  };
}

function requireAbsolute(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value)) {
    throw new WalmartNewSkuSourceReleaseError(
      "CLI_ABSOLUTE_PATH_REQUIRED",
      `${flag} must be an absolute path`,
    );
  }
  return resolve(value);
}

export async function runWalmartNewSkuReleaseCli(
  argv = process.argv.slice(2),
  surface: WalmartNewSkuReleaseCliSurface = "verify",
): Promise<unknown> {
  const options = parseArgs(argv, surface);
  if (options.command === "help") {
    return { help: usage() };
  }
  if (options.command === "freeze") {
    const result = await createWalmartNewSkuFrozenRelease({
      sourceRoot: requireAbsolute(options.sourceRoot, "--source-root"),
      outputDirectory: requireAbsolute(options.outputDirectory, "--out"),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
    return {
      ok: true,
      command: "freeze",
      marketplace_mutated: false,
      database_mutated: false,
      ambient_credential_files_included: false,
      embedded_secret_scan_performed: false,
      runtime_dependencies_sealed: true,
      ...result,
    };
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedEngineReleaseSha256 ?? "")) {
    throw new WalmartNewSkuSourceReleaseError(
      "CLI_ENGINE_RELEASE_SHA_INVALID",
      "--expected-engine-release-sha must be lowercase SHA-256",
    );
  }
  const result = await verifyWalmartNewSkuFrozenRelease({
    releaseRoot: requireAbsolute(options.releaseRoot, "--release-root"),
    manifestPath: requireAbsolute(options.manifestPath, "--manifest"),
    manifestSha256Path: requireAbsolute(
      options.manifestSha256Path,
      "--manifest-sha",
    ),
    expectedEngineReleaseSha256: options.expectedEngineReleaseSha256!,
  });
  return {
    ...result,
    command: "verify",
    marketplace_mutated: false,
    database_mutated: false,
  };
}

export async function runWalmartNewSkuReleaseProcess(
  surface: WalmartNewSkuReleaseCliSurface = "verify",
  argv = process.argv.slice(2),
): Promise<void> {
  try {
    const result = await runWalmartNewSkuReleaseCli(argv, surface);
    if ("help" in (result as Record<string, unknown>)) {
      process.stdout.write(`${(result as { help: string }).help}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof WalmartNewSkuSourceReleaseError
      ? error.code
      : "WALMART_NEW_SKU_RELEASE_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code, message },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("walmart-new-sku-release.ts")) {
  void runWalmartNewSkuReleaseProcess("verify");
}
