import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProductTruthAmazonCatalogCapturePlan,
  ProductTruthAmazonCatalogListingEvidence,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";
import {
  compileProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-image-evidence";

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function options(argv: readonly string[]) {
  const allowed = new Set([
    "--catalog-plan", "--catalog-plan-sha256", "--catalog-evidence",
    "--catalog-evidence-sha256", "--generated-at", "--out",
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
  const catalogPlanPath = required("--catalog-plan");
  const catalogEvidencePath = required("--catalog-evidence");
  const outDir = required("--out");
  if (![catalogPlanPath, catalogEvidencePath, outDir].every(isAbsolute)) {
    fail("ABSOLUTE_PATH_REQUIRED", "all paths");
  }
  return {
    catalogPlanPath,
    catalogPlanSha256: required("--catalog-plan-sha256"),
    catalogEvidencePath,
    catalogEvidenceSha256: required("--catalog-evidence-sha256"),
    generatedAt: new Date(required("--generated-at")).toISOString(),
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

async function run(input: ReturnType<typeof options>): Promise<void> {
  const [catalogPlan, catalogEvidence] = await Promise.all([
    load<ProductTruthAmazonCatalogCapturePlan>(input.catalogPlanPath),
    load<ProductTruthAmazonCatalogListingEvidence>(input.catalogEvidencePath),
  ]);
  const plan = compileProductTruthAmazonImageCapturePlan({
    generatedAt: input.generatedAt,
    catalogPlan: catalogPlan.value,
    catalogPlanJson: catalogPlan.json,
    catalogPlanSha256: input.catalogPlanSha256,
    catalogEvidence: catalogEvidence.value,
    catalogEvidenceJson: catalogEvidence.json,
    catalogEvidenceSha256: input.catalogEvidenceSha256,
  });
  const json = renderProductTruthAmazonImageCapturePlan(plan);
  const digest = sha256(json);
  await mkdir(dirname(input.outDir), { recursive: true, mode: 0o700 });
  await mkdir(input.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(input.outDir, "image-plan.json"), json),
    writeNew(resolve(input.outDir, "image-plan.sha256"), `${digest}\n`),
  ]);
  process.stdout.write(JSON.stringify({
    status: "IMAGE_PLAN_READY",
    outDir: input.outDir,
    imagePlanSha256: digest,
    imageSetSha256: plan.imageSetSha256,
    targetCount: plan.targets.length,
    networkCalls: 0,
    marketplaceMutations: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Build an offline Amazon image capture plan from exact Catalog evidence.\n");
    return;
  }
  await run(options(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
