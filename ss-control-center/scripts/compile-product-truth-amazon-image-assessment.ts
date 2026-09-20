import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileProductTruthAmazonImageAssessment,
  renderProductTruthAmazonImageAssessment,
} from "../src/lib/sourcing/product-truth-amazon-image-assessment";
import {
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageVerification,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
  type ProductTruthAmazonImageVerification,
} from "../src/lib/sourcing/product-truth-amazon-image-evidence";
import {
  renderProductTruthAmazonListingDecomposition,
  type ProductTruthAmazonListingDecomposition,
} from "../src/lib/sourcing/product-truth-amazon-listing-decomposition";

type BoundInput<T> = { path: string; sha256: string; render: (value: T) => string };

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function exactSha(value: string, label: string): string {
  const normalized = value.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) fail("SHA256_INVALID", label);
  return normalized;
}

function options(argv: readonly string[]) {
  const flags = [
    "--image-plan", "--image-plan-sha256", "--image-capture",
    "--image-capture-sha256", "--image-verification",
    "--image-verification-sha256", "--image-dir", "--decomposition",
    "--decomposition-sha256", "--out",
  ];
  const allowed = new Set(flags);
  if (argv.some((value) => value.startsWith("--") && !allowed.has(value))) {
    fail("CLI_ARGUMENT_UNKNOWN", argv.join(" "));
  }
  const result = Object.fromEntries(flags.map((flag) => [
    flag.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
    flag.endsWith("sha256")
      ? exactSha(exactArg(argv, flag), flag)
      : exactArg(argv, flag),
  ])) as {
    imagePlan: string; imagePlanSha256: string;
    imageCapture: string; imageCaptureSha256: string;
    imageVerification: string; imageVerificationSha256: string;
    imageDir: string; decomposition: string; decompositionSha256: string;
    out: string;
  };
  for (const [label, value] of Object.entries(result).filter(([key]) =>
    !key.endsWith("Sha256"))) {
    if (!isAbsolute(value) || normalize(value) !== value) {
      fail("ABSOLUTE_NORMALIZED_PATH_REQUIRED", label);
    }
  }
  return result;
}

async function boundJson<T>(input: BoundInput<T>): Promise<{ value: T; json: string }> {
  const bytes = await readFile(await realpath(input.path));
  const json = bytes.toString("utf8");
  if (sha256(bytes) !== input.sha256) fail("SOURCE_SHA256_MISMATCH", input.path);
  let value: T;
  try {
    value = JSON.parse(json) as T;
  } catch {
    fail("SOURCE_JSON_INVALID", input.path);
  }
  if (input.render(value) !== json) fail("SOURCE_NOT_CANONICAL", input.path);
  return { value, json };
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

async function run(input: ReturnType<typeof options>): Promise<void> {
  const imagePlan = await boundJson<ProductTruthAmazonImageCapturePlan>({
    path: input.imagePlan, sha256: input.imagePlanSha256,
    render: renderProductTruthAmazonImageCapturePlan,
  });
  const imageCapture = await boundJson<ProductTruthAmazonImageCapture>({
    path: input.imageCapture, sha256: input.imageCaptureSha256,
    render: renderProductTruthAmazonImageCapture,
  });
  const imageVerification = await boundJson<ProductTruthAmazonImageVerification>({
    path: input.imageVerification, sha256: input.imageVerificationSha256,
    render: renderProductTruthAmazonImageVerification,
  });
  const decomposition = await boundJson<ProductTruthAmazonListingDecomposition>({
    path: input.decomposition, sha256: input.decompositionSha256,
    render: renderProductTruthAmazonListingDecomposition,
  });
  const imageDir = await realpath(input.imageDir);
  if (imageDir !== input.imageDir) fail("IMAGE_DIR_NOT_REALPATH", input.imageDir);
  const imageBytesByFile = new Map<string, Uint8Array>();
  for (const entry of imageCapture.value.entries) {
    const path = resolve(imageDir, entry.imageFile);
    if (dirname(path) !== imageDir || imageBytesByFile.has(entry.imageFile)) {
      fail("IMAGE_FILE_SET_INVALID", entry.imageFile);
    }
    imageBytesByFile.set(entry.imageFile, await readFile(path));
  }
  const assessment = compileProductTruthAmazonImageAssessment({
    assessedAt: new Date().toISOString(),
    imagePlan: imagePlan.value,
    imagePlanJson: imagePlan.json,
    imagePlanSha256: input.imagePlanSha256,
    imageCapture: imageCapture.value,
    imageCaptureJson: imageCapture.json,
    imageCaptureSha256: input.imageCaptureSha256,
    imageVerification: imageVerification.value,
    imageVerificationJson: imageVerification.json,
    imageVerificationSha256: input.imageVerificationSha256,
    imageBytesByFile,
    decomposition: decomposition.value,
    decompositionJson: decomposition.json,
    decompositionSha256: input.decompositionSha256,
  });
  const json = renderProductTruthAmazonImageAssessment(assessment);
  const digest = sha256(json);
  const parent = dirname(input.out);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) fail("OUTPUT_PARENT_NOT_REALPATH", parent);
  await assertAbsent(input.out);
  const temporary = join(parent, `.${basename(input.out)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeNew(resolve(temporary, "image-assessment.json"), json),
      writeNew(resolve(temporary, "image-assessment.sha256"), `${digest}\n`),
    ]);
    await assertAbsent(input.out);
    await rename(temporary, input.out);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(JSON.stringify({
    status: "IMAGE_COMPONENT_ASSESSMENT_COMPILED",
    outDir: input.out,
    imageAssessmentSha256: digest,
    counts: assessment.counts,
    networkCalls: 0,
    databaseWrites: 0,
    canonicalMaterializationsAuthorized: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Compile a byte-bound, non-authoritative Amazon image component assessment.\n");
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
