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
  compileProductTruthConsensusReuseScope,
  renderProductTruthConsensusReuseScope,
} from "../src/lib/sourcing/product-truth-consensus-reuse-scope";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthRecipeRepairScope,
} from "../src/lib/sourcing/product-truth-recipe-repair-scope";

type Options = {
  generatedAt: string;
  rawSourcePath: string;
  corpusPath: string;
  acceptanceReviewAPath: string;
  acceptanceReviewBPath: string;
  blindTaskPath: string;
  frozenReviewAPath: string;
  frozenReviewBPath: string;
  reconciliationMapPath: string;
  repairScopePath: string;
  outDir: string;
};

type JsonArtifact = {
  path: string;
  json: string;
  sha256: string;
  value: unknown;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run product-truth:consensus-reuse-scope --",
    "    --generated-at ISO_TIMESTAMP",
    "    --raw-source ABS_GEN_ENRICHED_STATE_JSON",
    "    --corpus ABS_MATCHER_REPLAY_V22_CORPUS_JSON",
    "    --acceptance-review-a ABS_POST_BLIND_REVIEW_A_JSON",
    "    --acceptance-review-b ABS_POST_BLIND_REVIEW_B_JSON",
    "    --blind-task ABS_BLIND_TASK_JSON",
    "    --frozen-review-a ABS_FROZEN_BLIND_REVIEW_A_JSON",
    "    --frozen-review-b ABS_FROZEN_BLIND_REVIEW_B_JSON",
    "    --reconciliation-map ABS_RECONCILIATION_MAP_JSON",
    "    --repair-scope ABS_RECIPE_REPAIR_SCOPE_JSON",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: immutable local evidence analysis only. No DB, provider, retailer",
    "or marketplace access and no writes outside the new output directory.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const flags = {
    "--generated-at": "generatedAt",
    "--raw-source": "rawSourcePath",
    "--corpus": "corpusPath",
    "--acceptance-review-a": "acceptanceReviewAPath",
    "--acceptance-review-b": "acceptanceReviewBPath",
    "--blind-task": "blindTaskPath",
    "--frozen-review-a": "frozenReviewAPath",
    "--frozen-review-b": "frozenReviewBPath",
    "--reconciliation-map": "reconciliationMapPath",
    "--repair-scope": "repairScopePath",
    "--out": "outDir",
  } as const;
  const values = new Map<keyof Options, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as keyof typeof flags;
    const key = flags[flag];
    if (!key) fail("CLI_ARGUMENT_UNKNOWN", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    if (values.has(key)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    values.set(key, value);
    index += 1;
  }
  const required = (key: keyof Options): string => {
    const value = values.get(key)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", key);
    return value;
  };
  const options: Options = {
    generatedAt: required("generatedAt"),
    rawSourcePath: required("rawSourcePath"),
    corpusPath: required("corpusPath"),
    acceptanceReviewAPath: required("acceptanceReviewAPath"),
    acceptanceReviewBPath: required("acceptanceReviewBPath"),
    blindTaskPath: required("blindTaskPath"),
    frozenReviewAPath: required("frozenReviewAPath"),
    frozenReviewBPath: required("frozenReviewBPath"),
    reconciliationMapPath: required("reconciliationMapPath"),
    repairScopePath: required("repairScopePath"),
    outDir: required("outDir"),
  };
  if (
    !Number.isFinite(Date.parse(options.generatedAt))
    || new Date(Date.parse(options.generatedAt)).toISOString()
      !== options.generatedAt
  ) {
    fail("CLI_ARGUMENT_INVALID", "--generated-at must be canonical UTC");
  }
  for (const [key, value] of Object.entries(options)) {
    if (key !== "generatedAt" && !isAbsolute(value)) {
      fail("ABSOLUTE_PATH_REQUIRED", key);
    }
  }
  return options;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<JsonArtifact> {
  const resolved = await realpath(path);
  const json = await readFile(resolved, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    fail(
      "SOURCE_JSON_INVALID",
      `${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path: resolved,
    json,
    sha256: sha256(json),
    value,
  };
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
  const [
    rawSource,
    corpus,
    acceptanceReviewA,
    acceptanceReviewB,
    blindTask,
    frozenReviewA,
    frozenReviewB,
    reconciliationMap,
    repairScope,
  ] = await Promise.all([
    readJson(options.rawSourcePath),
    readJson(options.corpusPath),
    readJson(options.acceptanceReviewAPath),
    readJson(options.acceptanceReviewBPath),
    readJson(options.blindTaskPath),
    readJson(options.frozenReviewAPath),
    readJson(options.frozenReviewBPath),
    readJson(options.reconciliationMapPath),
    readJson(options.repairScopePath),
  ]);
  const report = compileProductTruthConsensusReuseScope({
    generatedAt: options.generatedAt,
    rawSource: rawSource.value,
    rawSourceJson: rawSource.json,
    rawSourceSha256: rawSource.sha256,
    corpus: corpus.value,
    corpusJson: corpus.json,
    corpusSha256: corpus.sha256,
    acceptanceReviewA: acceptanceReviewA.value,
    acceptanceReviewAJson: acceptanceReviewA.json,
    acceptanceReviewASha256: acceptanceReviewA.sha256,
    acceptanceReviewB: acceptanceReviewB.value,
    acceptanceReviewBJson: acceptanceReviewB.json,
    acceptanceReviewBSha256: acceptanceReviewB.sha256,
    blindTask: blindTask.value,
    blindTaskJson: blindTask.json,
    blindTaskSha256: blindTask.sha256,
    frozenReviewA: frozenReviewA.value,
    frozenReviewAJson: frozenReviewA.json,
    frozenReviewASha256: frozenReviewA.sha256,
    frozenReviewB: frozenReviewB.value,
    frozenReviewBJson: frozenReviewB.json,
    frozenReviewBSha256: frozenReviewB.sha256,
    reconciliationMap: reconciliationMap.value,
    reconciliationMapJson: reconciliationMap.json,
    reconciliationMapSha256: reconciliationMap.sha256,
    recipeRepairScope:
      repairScope.value as ProductTruthRecipeRepairScope,
    recipeRepairScopeJson: repairScope.json,
    recipeRepairScopeSha256: repairScope.sha256,
  });
  const reportJson = renderProductTruthConsensusReuseScope(report);
  const reportSha256 = sha256(reportJson);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion:
      "product-truth-consensus-reuse-scope-artifact-index/1.0.0",
    generatedAt: report.generatedAt,
    source: report.source,
    selectionPolicy: report.selectionPolicy,
    counts: report.counts,
    exclusionCounts: report.exclusionCounts,
    claims: report.claims,
    artifacts: [{
      role: "consensus_reuse_scope",
      file: "consensus-reuse-scope.json",
      sha256: reportSha256,
    }],
  });
  const indexSha256 = sha256(indexJson);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(
      resolve(options.outDir, "consensus-reuse-scope.json"),
      reportJson,
    ),
    writeNew(
      resolve(options.outDir, "consensus-reuse-scope.sha256"),
      `${reportSha256}\n`,
    ),
    writeNew(resolve(options.outDir, "artifact-index.json"), indexJson),
    writeNew(
      resolve(options.outDir, "artifact-index.sha256"),
      `${indexSha256}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
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
