import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProductTruthConsensusReuseScope,
} from "../src/lib/sourcing/product-truth-consensus-reuse-scope";
import {
  preflightProductTruthConsensusReuse,
  renderProductTruthConsensusReusePreflight,
} from "../src/lib/sourcing/product-truth-consensus-reuse-preflight";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  scopePath: string;
  expectedScopeSha256: string;
  checkedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:consensus-reuse-preflight --",
    "    (--url URL | --url-env ENV_NAME)",
    "    [--allow-remote --auth-token-env ENV_NAME]",
    "    --scope ABS_CONSENSUS_REUSE_SCOPE_JSON",
    "    --scope-sha256 SHA256 --checked-at ISO_TIMESTAMP",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: read-only database preflight. No canonical, provider, retailer,",
    "marketplace, price, inventory, procurement or consumer-cutover writes.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--url",
    "--url-env",
    "--auth-token-env",
    "--scope",
    "--scope-sha256",
    "--checked-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", flag);
      allowRemote = true;
      continue;
    }
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const literalUrl = values.get("--url")?.trim() || null;
  const urlEnv = values.get("--url-env")?.trim() || null;
  if ((literalUrl ? 1 : 0) + (urlEnv ? 1 : 0) !== 1) {
    fail(
      "DATABASE_URL_SOURCE_INVALID",
      "provide exactly one of --url or --url-env",
    );
  }
  const url = literalUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_ENV_EMPTY", urlEnv!);
  const scopePath = required("--scope");
  const outDir = required("--out");
  if (!isAbsolute(scopePath) || !isAbsolute(outDir)) {
    fail("ABSOLUTE_PATH_REQUIRED", "--scope and --out");
  }
  const expectedScopeSha256 = required("--scope-sha256");
  if (!/^[a-f0-9]{64}$/.test(expectedScopeSha256)) {
    fail("SHA256_REQUIRED", "--scope-sha256");
  }
  const checkedAt = required("--checked-at");
  if (
    !Number.isFinite(Date.parse(checkedAt))
    || new Date(Date.parse(checkedAt)).toISOString() !== checkedAt
  ) {
    fail("CLI_ARGUMENT_INVALID", "--checked-at must be canonical UTC");
  }
  return {
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    scopePath,
    expectedScopeSha256,
    checkedAt,
    outDir,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeNew(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (target.kind === "remote" && !options.allowRemote) {
    fail("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG", "pass --allow-remote");
  }
  if (target.kind === "local" && options.authTokenEnv) {
    fail("LOCAL_DATABASE_AUTH_FORBIDDEN", "--auth-token-env is remote-only");
  }
  const authToken = options.authTokenEnv
    ? process.env[options.authTokenEnv]?.trim()
    : undefined;
  if (target.kind === "remote" && (!options.authTokenEnv || !authToken)) {
    fail(
      "REMOTE_DATABASE_AUTH_REQUIRED",
      "--auth-token-env must name a populated environment variable",
    );
  }
  const scopeJson = await readFile(
    await realpath(options.scopePath),
    "utf8",
  );
  const actualScopeSha256 = sha256(scopeJson);
  if (actualScopeSha256 !== options.expectedScopeSha256) {
    fail(
      "SOURCE_SHA256_MISMATCH",
      `${actualScopeSha256} != ${options.expectedScopeSha256}`,
    );
  }
  let scope: ProductTruthConsensusReuseScope;
  try {
    scope = JSON.parse(scopeJson) as ProductTruthConsensusReuseScope;
  } catch {
    fail("SOURCE_JSON_INVALID", options.scopePath);
  }
  const db = createClient({
    url: target.clientUrl,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const report = await preflightProductTruthConsensusReuse({
      db,
      databaseTargetFingerprint: target.fingerprint,
      scope,
      scopeJson,
      scopeSha256: options.expectedScopeSha256,
      checkedAt: options.checkedAt,
    });
    const reportJson =
      renderProductTruthConsensusReusePreflight(report);
    const reportSha256 = sha256(reportJson);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion:
        "product-truth-consensus-reuse-preflight-artifact-index/1.0.0",
      checkedAt: report.checkedAt,
      status: report.status,
      databaseTargetFingerprint: report.databaseTargetFingerprint,
      source: report.source,
      counts: report.counts,
      claims: report.claims,
      artifacts: [{
        role: "consensus_reuse_preflight",
        file: "preflight-report.json",
        sha256: reportSha256,
      }],
    });
    const indexSha256 = sha256(indexJson);
    await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
    await mkdir(options.outDir, { recursive: false, mode: 0o700 });
    await Promise.all([
      writeNew(resolve(options.outDir, "preflight-report.json"), reportJson),
      writeNew(
        resolve(options.outDir, "preflight-report.sha256"),
        `${reportSha256}\n`,
      ),
      writeNew(resolve(options.outDir, "artifact-index.json"), indexJson),
      writeNew(
        resolve(options.outDir, "artifact-index.sha256"),
        `${indexSha256}\n`,
      ),
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(parseOptions(argv));
}

const isEntrypoint =
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
