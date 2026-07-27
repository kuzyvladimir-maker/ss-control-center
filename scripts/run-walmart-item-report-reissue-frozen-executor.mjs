#!/usr/bin/env node

/**
 * Credential loader for the manifest-bound frozen ITEM-v6 executor.
 *
 * The child remains the security boundary: it verifies the frozen bundle,
 * manifest, all exact SHA-256 arguments, authorization, account and ledger.
 * This launcher only loads the project's local dotenv files into the child
 * environment. It never prints credential names or values.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const EXPECTED_NODE = "/opt/homebrew/Cellar/node@24/24.18.0/bin/node";
const EXPECTED_BUNDLE = "walmart-item-report-reissue-v2-frozen-executor.bundle.mjs";

function fail(message) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error_code: "FROZEN_EXECUTOR_LAUNCHER_ERROR",
    message,
  })}\n`);
  process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  if (argv.length < 3 || argv[0] !== EXPECTED_NODE
    || path.basename(argv[1]) !== EXPECTED_BUNDLE || argv[2] !== "execute-create") {
    throw new Error("launcher requires the exact Node 24 frozen execute-create command");
  }
  const env = { ...(injected.base_env ?? process.env) };
  for (const name of [".env.local", ".env"]) {
    const result = loadEnv({
      path: path.join(PROJECT_ROOT, name),
      processEnv: env,
      override: false,
      quiet: true,
    });
    if (result.error && result.error.code !== "ENOENT") {
      throw new Error("local credential file could not be parsed");
    }
  }
  const child = (injected.spawn ?? spawn)(argv[0], argv.slice(1), {
    cwd: PROJECT_ROOT,
    env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error("frozen executor terminated by signal"));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`frozen executor exited with code ${exitCode}`);
  return { status: "FROZEN_EXECUTOR_COMPLETED", exit_code: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => fail(error instanceof Error ? error.message : "launcher failed"));
}
