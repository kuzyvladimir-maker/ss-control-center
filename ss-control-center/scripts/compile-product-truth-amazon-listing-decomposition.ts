import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProductTruthAmazonCatalogCapturePlan,
  ProductTruthAmazonCatalogListingEvidence,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";
import {
  compileProductTruthAmazonListingDecomposition,
  renderProductTruthAmazonListingDecomposition,
} from "../src/lib/sourcing/product-truth-amazon-listing-decomposition";
import type { ProductTruthLegacyBridgeSnapshot } from "../src/lib/sourcing/product-truth-legacy-bridge";

type Options = {
  planPath: string;
  planSha256: string;
  evidencePath: string;
  evidenceSha256: string;
  snapshotPath: string;
  snapshotSha256: string;
  compiledAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--plan", "--plan-sha256", "--evidence", "--evidence-sha256",
    "--legacy-snapshot", "--legacy-snapshot-sha256", "--compiled-at", "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag)) fail("CLI_ARGUMENT_INVALID", flag);
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const planPath = required("--plan");
  const evidencePath = required("--evidence");
  const snapshotPath = required("--legacy-snapshot");
  const outDir = required("--out");
  if (![planPath, evidencePath, snapshotPath, outDir].every(isAbsolute)) {
    fail("ABSOLUTE_PATH_REQUIRED", "all file and output paths");
  }
  return {
    planPath,
    planSha256: required("--plan-sha256"),
    evidencePath,
    evidenceSha256: required("--evidence-sha256"),
    snapshotPath,
    snapshotSha256: required("--legacy-snapshot-sha256"),
    compiledAt: new Date(required("--compiled-at")).toISOString(),
    outDir,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function load<T>(path: string): Promise<{ value: T; json: string }> {
  const json = (await readFile(await realpath(path))).toString("utf8");
  try {
    return { value: JSON.parse(json) as T, json };
  } catch {
    fail("SOURCE_JSON_INVALID", path);
  }
}

async function writeNew(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const [plan, evidence, snapshot] = await Promise.all([
    load<ProductTruthAmazonCatalogCapturePlan>(options.planPath),
    load<ProductTruthAmazonCatalogListingEvidence>(options.evidencePath),
    load<ProductTruthLegacyBridgeSnapshot>(options.snapshotPath),
  ]);
  const result = compileProductTruthAmazonListingDecomposition({
    compiledAt: options.compiledAt,
    plan: plan.value,
    planJson: plan.json,
    planSha256: options.planSha256,
    evidence: evidence.value,
    evidenceJson: evidence.json,
    evidenceSha256: options.evidenceSha256,
    legacySnapshot: snapshot.value,
    legacySnapshotJson: snapshot.json,
    legacySnapshotSha256: options.snapshotSha256,
  });
  const json = renderProductTruthAmazonListingDecomposition(result);
  const digest = sha256(json);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "decomposition.json"), json),
    writeNew(resolve(options.outDir, "decomposition.sha256"), `${digest}\n`),
  ]);
  process.stdout.write(JSON.stringify({
    status: "DECOMPOSITION_COMPILED",
    outDir: options.outDir,
    decompositionSha256: digest,
    counts: result.counts,
    networkCalls: 0,
    databaseWrites: 0,
    marketplaceMutations: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Compile Amazon structural signals and non-authoritative existing-catalog candidates offline.\n");
    return;
  }
  await run(parseOptions(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
