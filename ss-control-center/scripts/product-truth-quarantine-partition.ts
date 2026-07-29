import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildProductTruthQuarantinePartition,
  renderProductTruthQuarantinePartition,
} from "../src/lib/sourcing/product-truth-quarantine-partition";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthLegacyBridgePlan,
} from "../src/lib/sourcing/product-truth-legacy-bridge";

type Options = {
  planPath: string;
  planShaPath: string;
  generatedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:quarantine-partition --",
    "    --plan ABS_BRIDGE_PLAN_JSON --plan-sha ABS_SHA_FILE",
    "    --generated-at ISO_TIMESTAMP --out ABS_NEW_DIR",
    "",
    "Safety: local sealed-artifact analysis only; no DB, provider or marketplace access.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--plan", "--plan-sha", "--generated-at", "--out"].includes(flag)) {
      fail("CLI_ARGUMENT_UNKNOWN", flag);
    }
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
  const options = {
    planPath: required("--plan"),
    planShaPath: required("--plan-sha"),
    generatedAt: required("--generated-at"),
    outDir: required("--out"),
  };
  if (
    !isAbsolute(options.planPath)
    || !isAbsolute(options.planShaPath)
    || !isAbsolute(options.outDir)
  ) {
    fail("ABSOLUTE_PATH_REQUIRED", "--plan, --plan-sha and --out");
  }
  return options;
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
  const [planPath, planShaPath] = await Promise.all([
    realpath(options.planPath),
    realpath(options.planShaPath),
  ]);
  const [planJson, planShaFile] = await Promise.all([
    readFile(planPath, "utf8"),
    readFile(planShaPath, "utf8"),
  ]);
  const planSha256 = planShaFile.trim();
  let bridgePlan: ProductTruthLegacyBridgePlan;
  try {
    bridgePlan = JSON.parse(planJson) as ProductTruthLegacyBridgePlan;
  } catch (error) {
    fail(
      "QUARANTINE_PARTITION_PLAN_JSON_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  const report = buildProductTruthQuarantinePartition({
    bridgePlan,
    bridgePlanJson: planJson,
    bridgePlanSha256: planSha256,
    generatedAt: options.generatedAt,
  });
  const reportJson = renderProductTruthQuarantinePartition(report);
  const reportSha256 = createHash("sha256").update(reportJson).digest("hex");
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion: "product-truth-quarantine-partition-artifact-index/1.0.0",
    generatedAt: report.generatedAt,
    source: report.source,
    counts: report.counts,
    claims: report.claims,
    artifacts: [{
      role: "quarantine_partition",
      file: "quarantine-partition.json",
      sha256: reportSha256,
    }],
  });
  const indexSha256 = createHash("sha256").update(indexJson).digest("hex");
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(resolve(options.outDir, "quarantine-partition.json"), reportJson),
    writeNew(
      resolve(options.outDir, "quarantine-partition.sha256"),
      `${reportSha256}\n`,
    ),
    writeNew(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNew(
      resolve(options.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(`${indexJson}`);
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
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
