import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileProductTruthDirectRetailerIdentityEvidence,
  productTruthDirectRetailerIdentityEvidenceSha256,
  renderProductTruthDirectRetailerIdentityEvidence,
  type ProductTruthDirectRetailerIdentityEvidence,
} from "../src/lib/sourcing/product-truth-direct-retailer-identity-evidence";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function parse(argv: readonly string[]) {
  const allowed = new Set([
    "--source-dir",
    "--source-evidence-sha256",
    "--target-canonical-variant-id",
    "--rebound-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !allowed.has(flag) || values.has(flag)) {
      fail("DIRECT_RETAILER_REBIND_ARGS_INVALID", String(flag));
    }
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) fail("DIRECT_RETAILER_REBIND_ARG_MISSING", flag);
    return value;
  };
  const sourceDir = required("--source-dir");
  const outDir = required("--out");
  if (
    !isAbsolute(sourceDir)
    || resolve(sourceDir) !== sourceDir
    || !isAbsolute(outDir)
    || resolve(outDir) !== outDir
  ) fail("DIRECT_RETAILER_REBIND_ABSOLUTE_PATH_REQUIRED", "source/out");
  const sourceEvidenceSha256 = required("--source-evidence-sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sourceEvidenceSha256)) {
    fail("DIRECT_RETAILER_REBIND_SHA256_INVALID", "source evidence");
  }
  return {
    sourceDir,
    sourceEvidenceSha256,
    targetCanonicalVariantId: required("--target-canonical-variant-id"),
    reboundAt: new Date(required("--rebound-at")).toISOString(),
    outDir,
  };
}

async function writeNew(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function run(options: ReturnType<typeof parse>): Promise<void> {
  const sourceEvidenceJson = await readFile(
    join(options.sourceDir, "evidence.json"),
    "utf8",
  );
  const sourceEvidence = JSON.parse(
    sourceEvidenceJson,
  ) as ProductTruthDirectRetailerIdentityEvidence;
  if (
    productTruthOperationalSha256(JSON.parse(sourceEvidenceJson) as unknown)
      !== options.sourceEvidenceSha256
    || productTruthDirectRetailerIdentityEvidenceSha256(sourceEvidence)
      !== options.sourceEvidenceSha256
  ) fail("DIRECT_RETAILER_REBIND_SOURCE_MISMATCH", options.sourceDir);
  const htmlBytes = await readFile(join(
    options.sourceDir,
    sourceEvidence.retailerContent.htmlFile,
  ));
  const evidence = compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: options.targetCanonicalVariantId,
    donorProductId: sourceEvidence.donorProductId,
    offerId: sourceEvidence.offerId,
    retailer: sourceEvidence.retailerContent.retailer,
    productUrl: sourceEvidence.retailerContent.productUrl,
    finalUrl: sourceEvidence.retailerContent.finalUrl,
    httpStatus: sourceEvidence.retailerContent.httpStatus,
    capturedAt: sourceEvidence.capturedAt,
    htmlFile: sourceEvidence.retailerContent.htmlFile,
    htmlBytes,
  });
  const evidenceJson = renderProductTruthDirectRetailerIdentityEvidence(evidence);
  const evidenceSha256 = productTruthDirectRetailerIdentityEvidenceSha256(evidence);
  const artifactIndex = {
    schemaVersion: "product-truth-direct-retailer-identity-rebind-index/1.0.0",
    reboundAt: options.reboundAt,
    sourceEvidenceSha256: options.sourceEvidenceSha256,
    targetCanonicalVariantId: options.targetCanonicalVariantId,
    evidenceSha256,
    htmlSha256: evidence.retailerContent.htmlSha256,
    safety: {
      networkCalls: 0,
      retailerReads: 0,
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      databaseWrites: 0,
      marketplaceMutations: 0,
    },
  };
  const artifactIndexJson = renderProductTruthOperationalJson(artifactIndex);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNew(join(options.outDir, "evidence.json"), evidenceJson),
    writeNew(join(options.outDir, "evidence.sha256"), `${evidenceSha256}\n`),
    writeNew(
      join(options.outDir, evidence.retailerContent.htmlFile),
      htmlBytes,
    ),
    writeNew(join(options.outDir, "artifact-index.json"), artifactIndexJson),
    writeNew(
      join(options.outDir, "artifact-index.sha256"),
      `${productTruthOperationalSha256(artifactIndex)}\n`,
    ),
  ]);
  await chmod(join(options.outDir, evidence.retailerContent.htmlFile), 0o400);
  process.stdout.write(`${JSON.stringify({
    status: "REBOUND_OFFLINE",
    targetCanonicalVariantId: options.targetCanonicalVariantId,
    evidenceSha256,
    outDir: options.outDir,
    safety: artifactIndex.safety,
  }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Rebind saved direct-retailer bytes to an existing canonical variant offline.\n");
    return;
  }
  await run(parse(argv));
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
