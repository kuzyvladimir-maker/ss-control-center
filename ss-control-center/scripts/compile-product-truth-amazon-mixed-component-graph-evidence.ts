import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileProductTruthAmazonMixedComponentGraphEvidence,
  productTruthAmazonComponentGraphEvidenceSha256,
  renderProductTruthAmazonComponentGraphEvidence,
  type ProductTruthAmazonComponentGraphSourceSet,
  type ProductTruthAmazonMixedComponentGraphAdjudication,
} from "../src/lib/sourcing/product-truth-amazon-component-graph-evidence";
import type {
  ProductTruthAmazonCatalogCapture,
  ProductTruthAmazonCatalogCapturePlan,
  ProductTruthAmazonCatalogListingEvidence,
} from "../src/lib/sourcing/product-truth-amazon-catalog-evidence";
import type {
  ProductTruthDirectRetailerIdentityEvidence,
} from "../src/lib/sourcing/product-truth-direct-retailer-identity-evidence";
import type {
  ProductTruthAmazonImageAssessment,
} from "../src/lib/sourcing/product-truth-amazon-image-assessment";
import type {
  ProductTruthAmazonImageCapture,
  ProductTruthAmazonImageCapturePlan,
  ProductTruthAmazonImageVerification,
} from "../src/lib/sourcing/product-truth-amazon-image-evidence";
import type {
  ProductTruthAmazonListingDecomposition,
} from "../src/lib/sourcing/product-truth-amazon-listing-decomposition";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import type {
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";

type ParsedArgs = {
  values: Map<string, string>;
  directRetailerDirs: string[];
};

const SINGLE_FLAGS = new Set([
  "--legacy-snapshot",
  "--catalog-plan-dir",
  "--catalog-capture-dir",
  "--catalog-evidence-dir",
  "--decomposition-dir",
  "--image-plan-dir",
  "--image-capture-dir",
  "--image-verification-dir",
  "--image-assessment-dir",
  "--adjudication",
  "--out",
]);

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Compile one complete mixed-component Amazon graph offline.",
    "Use --direct-retailer-dir once per adjudicated component.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const directRetailerDirs: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith("--") || value.startsWith("--")) {
      fail("AMAZON_MIXED_COMPONENT_GRAPH_ARGS_INVALID", String(flag));
    }
    if (flag === "--direct-retailer-dir") {
      directRetailerDirs.push(value);
      continue;
    }
    if (!SINGLE_FLAGS.has(flag) || values.has(flag)) {
      fail("AMAZON_MIXED_COMPONENT_GRAPH_ARGS_INVALID", flag);
    }
    values.set(flag, value);
  }
  if (directRetailerDirs.length < 2) {
    fail("AMAZON_MIXED_COMPONENT_GRAPH_DIRECT_SOURCES_REQUIRED", "minimum 2");
  }
  return { values, directRetailerDirs };
}

function required(parsed: ParsedArgs, flag: string): string {
  const value = parsed.values.get(flag);
  if (!value) fail("AMAZON_MIXED_COMPONENT_GRAPH_ARG_MISSING", flag);
  const normalized = resolve(value);
  if (!isAbsolute(value) || value !== normalized) {
    fail("AMAZON_MIXED_COMPONENT_GRAPH_ABSOLUTE_PATH_REQUIRED", flag);
  }
  return normalized;
}

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function digest(path: string): Promise<string> {
  return (await text(path)).trim();
}

async function json<T>(path: string): Promise<{ json: string; value: T }> {
  const body = await text(path);
  return { json: body, value: JSON.parse(body) as T };
}

async function writeNew(path: string, bytes: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function run(parsed: ParsedArgs): Promise<void> {
  const legacySnapshotPath = required(parsed, "--legacy-snapshot");
  const catalogPlanDir = required(parsed, "--catalog-plan-dir");
  const catalogCaptureDir = required(parsed, "--catalog-capture-dir");
  const catalogEvidenceDir = required(parsed, "--catalog-evidence-dir");
  const decompositionDir = required(parsed, "--decomposition-dir");
  const imagePlanDir = required(parsed, "--image-plan-dir");
  const imageCaptureDir = required(parsed, "--image-capture-dir");
  const imageVerificationDir = required(parsed, "--image-verification-dir");
  const imageAssessmentDir = required(parsed, "--image-assessment-dir");
  const adjudicationPath = required(parsed, "--adjudication");
  const outDir = required(parsed, "--out");
  const directRetailerDirs = parsed.directRetailerDirs.map((value) => {
    if (!isAbsolute(value) || resolve(value) !== value) {
      fail("AMAZON_MIXED_COMPONENT_GRAPH_ABSOLUTE_PATH_REQUIRED", value);
    }
    return value;
  });

  const legacy = await json<ProductTruthLegacyBridgeSnapshot>(legacySnapshotPath);
  const catalogPlan = await json<ProductTruthAmazonCatalogCapturePlan>(
    join(catalogPlanDir, "plan.json"),
  );
  const catalogCapture = await json<ProductTruthAmazonCatalogCapture>(
    join(catalogCaptureDir, "capture.json"),
  );
  const catalogEvidence = await json<ProductTruthAmazonCatalogListingEvidence>(
    join(catalogEvidenceDir, "evidence.json"),
  );
  const decomposition = await json<ProductTruthAmazonListingDecomposition>(
    join(decompositionDir, "decomposition.json"),
  );
  const imagePlan = await json<ProductTruthAmazonImageCapturePlan>(
    join(imagePlanDir, "image-plan.json"),
  );
  const imageCapture = await json<ProductTruthAmazonImageCapture>(
    join(imageCaptureDir, "image-capture.json"),
  );
  const imageVerification = await json<ProductTruthAmazonImageVerification>(
    join(imageVerificationDir, "image-verification.json"),
  );
  const imageAssessment = await json<ProductTruthAmazonImageAssessment>(
    join(imageAssessmentDir, "image-assessment.json"),
  );
  const adjudication = (await json<ProductTruthAmazonMixedComponentGraphAdjudication>(
    adjudicationPath,
  )).value;

  const rawResponses = new Map<string, { json: string; value: unknown }>();
  for (const entry of catalogCapture.value.entries) {
    rawResponses.set(entry.rawFile, await json<unknown>(
      join(catalogCaptureDir, entry.rawFile),
    ));
  }
  const imageBytes = new Map<string, Uint8Array>();
  for (const entry of imageCapture.value.entries) {
    imageBytes.set(
      entry.imageFile,
      await readFile(join(imageCaptureDir, entry.imageFile)),
    );
  }
  const common = {
    legacySnapshot: legacy.value,
    legacySnapshotJson: legacy.json,
    legacySnapshotSha256: await digest(
      `${legacySnapshotPath.slice(0, -".json".length)}.sha256`,
    ),
    catalogPlan: catalogPlan.value,
    catalogPlanJson: catalogPlan.json,
    catalogPlanSha256: await digest(join(catalogPlanDir, "plan.sha256")),
    catalogCapture: catalogCapture.value,
    catalogCaptureJson: catalogCapture.json,
    catalogCaptureSha256: await digest(join(catalogCaptureDir, "capture.sha256")),
    catalogRawResponses: rawResponses,
    catalogEvidence: catalogEvidence.value,
    catalogEvidenceJson: catalogEvidence.json,
    catalogEvidenceSha256: await digest(join(catalogEvidenceDir, "evidence.sha256")),
    decomposition: decomposition.value,
    decompositionJson: decomposition.json,
    decompositionSha256: await digest(join(decompositionDir, "decomposition.sha256")),
    imagePlan: imagePlan.value,
    imagePlanJson: imagePlan.json,
    imagePlanSha256: await digest(join(imagePlanDir, "image-plan.sha256")),
    imageCapture: imageCapture.value,
    imageCaptureJson: imageCapture.json,
    imageCaptureSha256: await digest(join(imageCaptureDir, "image-capture.sha256")),
    imageVerification: imageVerification.value,
    imageVerificationJson: imageVerification.json,
    imageVerificationSha256: await digest(
      join(imageVerificationDir, "image-verification.sha256"),
    ),
    imageAssessment: imageAssessment.value,
    imageAssessmentJson: imageAssessment.json,
    imageAssessmentSha256: await digest(
      join(imageAssessmentDir, "image-assessment.sha256"),
    ),
    imageBytesByFile: imageBytes,
  };
  const sources: ProductTruthAmazonComponentGraphSourceSet[] = [];
  for (const directDir of directRetailerDirs) {
    const direct = await json<ProductTruthDirectRetailerIdentityEvidence>(
      join(directDir, "evidence.json"),
    );
    sources.push({
      ...common,
      directRetailerEvidence: direct.value,
      directRetailerEvidenceJson: direct.json,
      directRetailerEvidenceSha256: await digest(join(directDir, "evidence.sha256")),
      directRetailerHtmlBytes: await readFile(
        join(directDir, direct.value.retailerContent.htmlFile),
      ),
    });
  }
  const rows = compileProductTruthAmazonMixedComponentGraphEvidence({
    adjudication,
    sources,
  });
  const artifacts = rows.map((row) => {
    const file = `component-${String(row.componentIndex).padStart(4, "0")}.json`;
    const body = renderProductTruthAmazonComponentGraphEvidence(row);
    return {
      componentIndex: row.componentIndex,
      donorProductId: row.donorProductId,
      evidenceRowSha256: row.evidenceRowSha256,
      file,
      body,
      sha256: productTruthAmazonComponentGraphEvidenceSha256(row),
    };
  });
  const graph = {
    schemaVersion: "product-truth-amazon-mixed-component-graph-index/1.0.0",
    listingKey: adjudication.listingKey,
    componentCount: artifacts.length,
    evidenceRows: artifacts.map((artifact) => ({
      componentIndex: artifact.componentIndex,
      donorProductId: artifact.donorProductId,
      evidenceRowSha256: artifact.evidenceRowSha256,
      file: artifact.file,
      sha256: artifact.sha256,
    })),
    safety: {
      networkCallsDuringCompilation: 0,
      modelCallsDuringCompilation: 0,
      providerCallsDuringCompilation: 0,
      paidCallsDuringCompilation: 0,
      databaseWritesDuringCompilation: 0,
      marketplaceMutationsDuringCompilation: 0,
    },
  };
  const graphJson = renderProductTruthOperationalJson(graph);
  const graphSha256 = productTruthOperationalSha256(graph);
  await mkdir(dirname(outDir), { recursive: true, mode: 0o700 });
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    ...artifacts.flatMap((artifact) => [
      writeNew(join(outDir, artifact.file), artifact.body),
      writeNew(join(outDir, `${artifact.file}.sha256`), `${artifact.sha256}\n`),
    ]),
    writeNew(join(outDir, "graph-index.json"), graphJson),
    writeNew(join(outDir, "graph-index.sha256"), `${graphSha256}\n`),
  ]);
  process.stdout.write(`${JSON.stringify({
    status: "COMPILED",
    listingKey: adjudication.listingKey,
    componentCount: rows.length,
    graphSha256,
    output: outDir,
    sourceSnapshot: basename(legacySnapshotPath),
    safety: graph.safety,
  }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(parseArgs(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
