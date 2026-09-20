import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  compileProductTruthAmazonComponentGraphEvidence,
  productTruthAmazonComponentGraphEvidenceSha256,
  renderProductTruthAmazonComponentGraphEvidence,
  type ProductTruthAmazonComponentGraphAdjudication,
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
import type {
  ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";

type Args = Record<string, string>;

function args(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("AMAZON_COMPONENT_GRAPH_ARGS_INVALID");
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function required(value: Args, key: string): string {
  const result = value[key];
  if (!result) throw new Error(`AMAZON_COMPONENT_GRAPH_ARG_MISSING:${key}`);
  return resolve(result);
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

async function main(): Promise<void> {
  const input = args(process.argv.slice(2));
  const legacySnapshotPath = required(input, "legacy-snapshot");
  const catalogPlanDir = required(input, "catalog-plan-dir");
  const catalogCaptureDir = required(input, "catalog-capture-dir");
  const catalogEvidenceDir = required(input, "catalog-evidence-dir");
  const decompositionDir = required(input, "decomposition-dir");
  const imagePlanDir = required(input, "image-plan-dir");
  const imageCaptureDir = required(input, "image-capture-dir");
  const imageVerificationDir = required(input, "image-verification-dir");
  const imageAssessmentDir = required(input, "image-assessment-dir");
  const directRetailerDir = required(input, "direct-retailer-dir");
  const adjudicationPath = required(input, "adjudication");
  const outDir = required(input, "out");

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
  const direct = await json<ProductTruthDirectRetailerIdentityEvidence>(
    join(directRetailerDir, "evidence.json"),
  );
  const adjudication = (await json<ProductTruthAmazonComponentGraphAdjudication>(
    adjudicationPath,
  )).value;

  const rawResponses = new Map<string, { json: string; value: unknown }>();
  for (const entry of catalogCapture.value.entries) {
    const raw = await json<unknown>(join(catalogCaptureDir, entry.rawFile));
    rawResponses.set(entry.rawFile, raw);
  }
  const imageBytes = new Map<string, Uint8Array>();
  for (const entry of imageCapture.value.entries) {
    imageBytes.set(entry.imageFile, await readFile(join(imageCaptureDir, entry.imageFile)));
  }
  const legacySnapshotSha256 = await digest(
    `${legacySnapshotPath.slice(0, -".json".length)}.sha256`,
  );
  const evidence = compileProductTruthAmazonComponentGraphEvidence({
    adjudication,
    source: {
      legacySnapshot: legacy.value,
      legacySnapshotJson: legacy.json,
      legacySnapshotSha256,
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
      directRetailerEvidence: direct.value,
      directRetailerEvidenceJson: direct.json,
      directRetailerEvidenceSha256: await digest(
        join(directRetailerDir, "evidence.sha256"),
      ),
      directRetailerHtmlBytes: await readFile(
        join(directRetailerDir, direct.value.retailerContent.htmlFile),
      ),
    },
  });
  const body = renderProductTruthAmazonComponentGraphEvidence(evidence);
  const evidenceSha256 = productTruthAmazonComponentGraphEvidenceSha256(evidence);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "amazon-component-graph-evidence.json"), body);
  await writeFile(
    join(outDir, "amazon-component-graph-evidence.sha256"),
    `${evidenceSha256}\n`,
  );
  process.stdout.write(JSON.stringify({
    status: "COMPILED",
    listingKey: evidence.listingKey,
    evidenceRowSha256: evidence.evidenceRowSha256,
    artifactSha256: evidenceSha256,
    output: join(outDir, "amazon-component-graph-evidence.json"),
    sourceSnapshot: basename(legacySnapshotPath),
    safety: evidence.safety,
  }, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
