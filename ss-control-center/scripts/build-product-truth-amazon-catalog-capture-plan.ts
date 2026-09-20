import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Phase1ScopeManifest } from "../src/lib/sourcing/phase1-scope-manifest";
import {
  compileProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";
import type { ProductTruthRecipeRepairScope } from "../src/lib/sourcing/product-truth-recipe-repair-scope";

type Options = {
  manifestPath: string;
  manifestSha256: string;
  recipeScopePath: string;
  recipeScopeSha256: string;
  listingKeys: string[];
  generatedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-amazon-catalog-capture-plan.ts",
    "    --manifest ABS_JSON --manifest-sha256 SHA256",
    "    --recipe-scope ABS_JSON --recipe-scope-sha256 SHA256",
    "    --listing-key amazon:STORE:SKU (repeat 1-50 times)",
    "    --generated-at ISO --out ABS_NEW_DIR",
    "",
    "Offline only. Scope is exact and explicit; no DB/network/provider/marketplace calls.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const singles = new Set([
    "--manifest",
    "--manifest-sha256",
    "--recipe-scope",
    "--recipe-scope-sha256",
    "--generated-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  const listingKeys: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (flag === "--listing-key") {
      listingKeys.push(value);
    } else if (singles.has(flag)) {
      if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    } else {
      fail("CLI_ARGUMENT_UNKNOWN", flag);
    }
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const manifestPath = required("--manifest");
  const recipeScopePath = required("--recipe-scope");
  const outDir = required("--out");
  if (![manifestPath, recipeScopePath, outDir].every(isAbsolute)) {
    fail("ABSOLUTE_PATH_REQUIRED", "--manifest, --recipe-scope and --out");
  }
  return {
    manifestPath,
    manifestSha256: required("--manifest-sha256"),
    recipeScopePath,
    recipeScopeSha256: required("--recipe-scope-sha256"),
    listingKeys,
    generatedAt: new Date(required("--generated-at")).toISOString(),
    outDir,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadJson<T>(path: string): Promise<{ value: T; json: string }> {
  const bytes = await readFile(await realpath(path));
  const json = bytes.toString("utf8");
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
  const [manifest, recipeScope] = await Promise.all([
    loadJson<Phase1ScopeManifest>(options.manifestPath),
    loadJson<ProductTruthRecipeRepairScope>(options.recipeScopePath),
  ]);
  const plan = compileProductTruthAmazonCatalogCapturePlan({
    generatedAt: options.generatedAt,
    listingKeys: options.listingKeys,
    manifest: manifest.value,
    manifestJson: manifest.json,
    manifestSha256: options.manifestSha256,
    recipeRepairScope: recipeScope.value,
    recipeRepairScopeJson: recipeScope.json,
    recipeRepairScopeSha256: options.recipeScopeSha256,
  });
  const json = renderProductTruthAmazonCatalogCapturePlan(plan);
  const digest = sha256(json);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "plan.json"), json),
    writeNew(resolve(options.outDir, "plan.sha256"), `${digest}\n`),
  ]);
  process.stdout.write(JSON.stringify({
    status: "PLAN_READY",
    outDir: options.outDir,
    planSha256: digest,
    targetCount: plan.targets.length,
    targetSetSha256: plan.targetSetSha256,
    networkCalls: 0,
    databaseWrites: 0,
    marketplaceMutations: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
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
