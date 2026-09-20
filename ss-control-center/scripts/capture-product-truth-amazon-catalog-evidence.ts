import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { spApiGet } from "../src/lib/amazon-sp-api/client";
import {
  PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION,
  renderProductTruthAmazonCatalogCapture,
  renderProductTruthAmazonCatalogCapturePlan,
  validateProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogCapture,
  type ProductTruthAmazonCatalogCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";
import { renderProductTruthOperationalJson } from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = { planPath: string; planSha256: string; outDir: string };

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function exactArg(argv: readonly string[], flag: string): string {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length !== 1) fail("CLI_ARGUMENT_REQUIRED_EXACTLY_ONCE", flag);
  const value = argv[indexes[0]! + 1];
  if (!value || value.startsWith("--") || value !== value.trim()) {
    fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.some((value) => value.startsWith("--")
    && !["--plan", "--plan-sha256", "--out"].includes(value))) {
    fail("CLI_ARGUMENT_UNKNOWN", argv.join(" "));
  }
  const planPath = exactArg(argv, "--plan");
  const planSha256 = exactArg(argv, "--plan-sha256");
  const outDir = exactArg(argv, "--out");
  if (!isAbsolute(planPath) || !isAbsolute(outDir) || normalize(outDir) !== outDir) {
    fail("ABSOLUTE_PATH_REQUIRED", "--plan and normalized --out");
  }
  return { planPath, planSha256, outDir };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    fail("OUTPUT_ALREADY_EXISTS", path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
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
  const planBytes = await readFile(await realpath(options.planPath));
  const planJson = planBytes.toString("utf8");
  const expectedPlanSha = options.planSha256.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(expectedPlanSha) || sha256(planBytes) !== expectedPlanSha) {
    fail("PLAN_SHA_MISMATCH", options.planPath);
  }
  let plan: ProductTruthAmazonCatalogCapturePlan;
  try {
    plan = JSON.parse(planJson) as ProductTruthAmazonCatalogCapturePlan;
  } catch {
    fail("PLAN_JSON_INVALID", options.planPath);
  }
  validateProductTruthAmazonCatalogCapturePlan(plan);
  if (renderProductTruthAmazonCatalogCapturePlan(plan) !== planJson) {
    fail("PLAN_NOT_CANONICAL", options.planPath);
  }
  const parent = dirname(options.outDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  if (realParent !== parent) fail("OUTPUT_PARENT_NOT_REALPATH", parent);
  await assertAbsent(options.outDir);
  const temporary = join(parent, `.${basename(options.outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  let amazonGetCalls = 0;
  try {
    const entries: ProductTruthAmazonCatalogCapture["entries"] = [];
    for (const target of plan.targets) {
      const raw = await spApiGet(
        `/catalog/2022-04-01/items/${encodeURIComponent(target.asin)}`,
        {
          storeId: `store${target.storeIndex}`,
          params: {
            marketplaceIds: plan.requestContract.marketplaceId,
            includedData: plan.requestContract.includedData,
          },
          retries: 1,
          signal: AbortSignal.timeout(30_000),
          beforeRequest: () => { amazonGetCalls += 1; },
        },
      ) as unknown;
      const rawJson = renderProductTruthOperationalJson(raw);
      const rawFile = `${String(target.ordinal).padStart(4, "0")}-${target.asin}.json`;
      await writeNew(resolve(temporary, rawFile), rawJson);
      entries.push({
        ordinal: target.ordinal,
        listingKey: target.listingKey,
        storeIndex: target.storeIndex,
        asin: target.asin,
        capturedAt: new Date().toISOString(),
        rawFile,
        rawSha256: sha256(rawJson),
        rawByteLength: Buffer.byteLength(rawJson, "utf8"),
      });
    }
    if (amazonGetCalls !== plan.targets.length) {
      fail("AMAZON_GET_CALL_COUNT_INVALID", `${amazonGetCalls}`);
    }
    const capture: ProductTruthAmazonCatalogCapture = {
      schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION,
      capturedAt: new Date().toISOString(),
      plan: {
        sha256: expectedPlanSha,
        targetSetSha256: plan.targetSetSha256,
        targetCount: plan.targets.length,
      },
      requestContract: plan.requestContract,
      entries,
      counts: {
        planned: plan.targets.length,
        attempted: amazonGetCalls,
        captured: entries.length,
        failed: 0,
      },
      claims: {
        amazonGetCalls,
        retries: 0,
        databaseWrites: 0,
        providerCalls: 0,
        paidCalls: 0,
        marketplaceMutations: 0,
      },
    };
    const captureJson = renderProductTruthAmazonCatalogCapture(capture);
    const captureSha256 = sha256(captureJson);
    await Promise.all([
      writeNew(resolve(temporary, "capture.json"), captureJson),
      writeNew(resolve(temporary, "capture.sha256"), `${captureSha256}\n`),
    ]);
    await assertAbsent(options.outDir);
    await rename(temporary, options.outDir);
    process.stdout.write(JSON.stringify({
      status: "CAPTURED",
      outDir: options.outDir,
      captureSha256,
      targetCount: entries.length,
      amazonGetCalls,
      retries: 0,
      marketplaceMutations: 0,
    }, null, 2) + "\n");
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(
      "Capture exact Amazon Catalog Items evidence. Required: --plan ABS_JSON --plan-sha256 SHA --out ABS_NEW_DIR. Read-only GET, one physical attempt per target.\n",
    );
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
