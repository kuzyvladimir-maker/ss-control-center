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

import {
  compileProductTruthAmazonImageVerification,
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  renderProductTruthAmazonImageVerification,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-image-evidence";

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
  const allowed = new Set([
    "--plan", "--plan-sha256", "--capture", "--capture-sha256",
    "--image-dir", "--out",
  ]);
  if (argv.some((value) => value.startsWith("--") && !allowed.has(value))) {
    fail("CLI_ARGUMENT_UNKNOWN", argv.join(" "));
  }
  const result = {
    planPath: exactArg(argv, "--plan"),
    planSha256: exactSha(exactArg(argv, "--plan-sha256"), "--plan-sha256"),
    capturePath: exactArg(argv, "--capture"),
    captureSha256: exactSha(
      exactArg(argv, "--capture-sha256"),
      "--capture-sha256",
    ),
    imageDir: exactArg(argv, "--image-dir"),
    outDir: exactArg(argv, "--out"),
  };
  for (const [label, value] of Object.entries(result).filter(([key]) =>
    key.endsWith("Path") || key.endsWith("Dir"))) {
    if (!isAbsolute(value) || normalize(value) !== value) {
      fail("ABSOLUTE_NORMALIZED_PATH_REQUIRED", label);
    }
  }
  return result;
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

async function boundJson<T>(input: {
  path: string;
  expectedSha256: string;
  render: (value: T) => string;
}): Promise<{ value: T; json: string }> {
  const bytes = await readFile(await realpath(input.path));
  const json = bytes.toString("utf8");
  if (sha256(bytes) !== input.expectedSha256) {
    fail("SOURCE_SHA256_MISMATCH", input.path);
  }
  let value: T;
  try {
    value = JSON.parse(json) as T;
  } catch {
    fail("SOURCE_JSON_INVALID", input.path);
  }
  if (input.render(value) !== json) fail("SOURCE_NOT_CANONICAL", input.path);
  return { value, json };
}

async function run(input: ReturnType<typeof options>): Promise<void> {
  const plan = await boundJson<ProductTruthAmazonImageCapturePlan>({
    path: input.planPath,
    expectedSha256: input.planSha256,
    render: renderProductTruthAmazonImageCapturePlan,
  });
  const capture = await boundJson<ProductTruthAmazonImageCapture>({
    path: input.capturePath,
    expectedSha256: input.captureSha256,
    render: renderProductTruthAmazonImageCapture,
  });
  const imageDir = await realpath(input.imageDir);
  if (imageDir !== input.imageDir) fail("IMAGE_DIR_NOT_REALPATH", input.imageDir);
  const imageBytesByFile = new Map<string, Uint8Array>();
  for (const entry of capture.value.entries) {
    if (imageBytesByFile.has(entry.imageFile)) {
      fail("DUPLICATE_IMAGE_FILE", entry.imageFile);
    }
    const path = resolve(imageDir, entry.imageFile);
    if (dirname(path) !== imageDir) fail("IMAGE_FILE_OUTSIDE_DIRECTORY", path);
    imageBytesByFile.set(entry.imageFile, await readFile(path));
  }
  const verification = compileProductTruthAmazonImageVerification({
    verifiedAt: new Date().toISOString(),
    plan: plan.value,
    planJson: plan.json,
    planSha256: input.planSha256,
    capture: capture.value,
    captureJson: capture.json,
    captureSha256: input.captureSha256,
    imageBytesByFile,
  });
  const json = renderProductTruthAmazonImageVerification(verification);
  const digest = sha256(json);
  const parent = dirname(input.outDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) fail("OUTPUT_PARENT_NOT_REALPATH", parent);
  await assertAbsent(input.outDir);
  const temporary = join(parent, `.${basename(input.outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeNew(resolve(temporary, "image-verification.json"), json),
      writeNew(resolve(temporary, "image-verification.sha256"), `${digest}\n`),
    ]);
    await assertAbsent(input.outDir);
    await rename(temporary, input.outDir);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(JSON.stringify({
    status: "IMAGE_EVIDENCE_VERIFIED",
    outDir: input.outDir,
    imageVerificationSha256: digest,
    counts: verification.counts,
    networkCalls: 0,
    providerCalls: 0,
    marketplaceMutations: 0,
  }, null, 2) + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Verify Amazon image capture metadata and every saved image byte offline.\n");
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
