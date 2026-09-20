import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileProductTruthAmazonCatalogListingEvidence,
  renderProductTruthAmazonCatalogCapture,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  type ProductTruthAmazonCatalogCapture,
  type ProductTruthAmazonCatalogCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";

type Options = {
  planPath: string;
  planSha256: string;
  capturePath: string;
  captureSha256: string;
  compiledAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--plan", "--plan-sha256", "--capture", "--capture-sha256",
    "--compiled-at", "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || values.has(flag)) fail("CLI_ARGUMENT_INVALID", flag);
    const value = argv[index + 1];
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
  const capturePath = required("--capture");
  const outDir = required("--out");
  if (![planPath, capturePath, outDir].every(isAbsolute)) {
    fail("ABSOLUTE_PATH_REQUIRED", "all paths");
  }
  return {
    planPath,
    planSha256: required("--plan-sha256"),
    capturePath,
    captureSha256: required("--capture-sha256"),
    compiledAt: new Date(required("--compiled-at")).toISOString(),
    outDir,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function load<T>(path: string): Promise<{ json: string; value: T }> {
  const json = (await readFile(await realpath(path))).toString("utf8");
  try {
    return { json, value: JSON.parse(json) as T };
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
  const [plan, capture] = await Promise.all([
    load<ProductTruthAmazonCatalogCapturePlan>(options.planPath),
    load<ProductTruthAmazonCatalogCapture>(options.capturePath),
  ]);
  if (
    plan.json !== renderProductTruthAmazonCatalogCapturePlan(plan.value)
    || capture.json !== renderProductTruthAmazonCatalogCapture(capture.value)
  ) fail("SOURCE_NOT_CANONICAL", "plan or capture");
  const rawResponses = new Map<string, { json: string; value: unknown }>();
  for (const entry of capture.value.entries) {
    if (basename(entry.rawFile) !== entry.rawFile || rawResponses.has(entry.rawFile)) {
      fail("RAW_FILE_INVALID", entry.rawFile);
    }
    rawResponses.set(
      entry.rawFile,
      await load(resolve(dirname(options.capturePath), entry.rawFile)),
    );
  }
  const evidence = compileProductTruthAmazonCatalogListingEvidence({
    compiledAt: options.compiledAt,
    plan: plan.value,
    planJson: plan.json,
    planSha256: options.planSha256,
    capture: capture.value,
    captureJson: capture.json,
    captureSha256: options.captureSha256,
    rawResponses,
  });
  const json = renderProductTruthAmazonCatalogListingEvidence(evidence);
  const digest = sha256(json);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "evidence.json"), json),
    writeNew(resolve(options.outDir, "evidence.sha256"), `${digest}\n`),
  ]);
  process.stdout.write(JSON.stringify({
    status: "EVIDENCE_COMPILED",
    outDir: options.outDir,
    evidenceSha256: digest,
    targetCount: evidence.counts.targets,
    entriesWithIdentifiers: evidence.counts.entriesWithIdentifiers,
    networkCalls: 0,
    marketplaceMutations: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Compile captured Amazon Catalog evidence offline.\n");
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
