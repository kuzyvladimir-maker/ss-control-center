import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileProductTruthDirectRetailerIdentityEvidence,
  renderProductTruthDirectRetailerIdentityEvidence,
  type ProductTruthDirectRetailerIdentityEvidenceRetailer,
} from "../src/lib/sourcing/product-truth-direct-retailer-identity-evidence";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

type Options = {
  targetCanonicalVariantId: string;
  donorProductId: string;
  offerId: string;
  retailer: ProductTruthDirectRetailerIdentityEvidenceRetailer;
  contentUrl: string;
  capturedAt: string;
  outDir: string;
};

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-direct-retailer-identity-evidence.ts",
    "    --target-canonical-variant-id cpv1:... --donor-product-id ID --offer-id ID",
    "    --retailer walmart|target --content-url HTTPS_URL --captured-at ISO",
    "    --out ABS_NEW_DIR",
    "",
    "Safety: one bounded first-party retailer GET; zero provider/paid/model/DB/",
    "marketplace calls. Evidence is byte-bound and re-parsable offline.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const allowed = new Set([
    "--target-canonical-variant-id",
    "--donor-product-id",
    "--offer-id",
    "--retailer",
    "--content-url",
    "--captured-at",
    "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag)) fail("CLI_ARGUMENT_UNKNOWN", flag);
    if (values.has(flag)) fail("CLI_ARGUMENT_DUPLICATE", flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_VALUE_REQUIRED", flag);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const retailer = required("--retailer");
  if (retailer !== "walmart" && retailer !== "target") {
    fail("CLI_ARGUMENT_INVALID", "--retailer must be walmart or target");
  }
  const outDir = required("--out");
  if (!isAbsolute(outDir)) fail("ABSOLUTE_PATH_REQUIRED", "--out");
  return {
    targetCanonicalVariantId: required("--target-canonical-variant-id"),
    donorProductId: required("--donor-product-id"),
    offerId: required("--offer-id"),
    retailer,
    contentUrl: required("--content-url"),
    capturedAt: new Date(required("--captured-at")).toISOString(),
    outDir,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTENT_BYTES) {
    fail("RETAILER_CONTENT_TOO_LARGE", `declared=${declaredLength}`);
  }
  if (!response.body) fail("RETAILER_CONTENT_INVALID", "body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_CONTENT_BYTES) {
      await reader.cancel();
      fail("RETAILER_CONTENT_TOO_LARGE", `streamed>${MAX_CONTENT_BYTES}`);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function writeNewFile(
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function run(options: Options): Promise<void> {
  const response = await fetch(options.contentUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; SS-Product-Truth/1.0)",
    },
  });
  const htmlBytes = await readBoundedResponse(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status !== 200
    || !contentType.toLocaleLowerCase("en-US").includes("text/html")
  ) {
    fail(
      "RETAILER_CONTENT_FETCH_INVALID",
      `status=${response.status} content-type=${contentType}`,
    );
  }
  const evidence = compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: options.targetCanonicalVariantId,
    donorProductId: options.donorProductId,
    offerId: options.offerId,
    retailer: options.retailer,
    productUrl: options.contentUrl,
    finalUrl: response.url,
    httpStatus: response.status,
    capturedAt: options.capturedAt,
    htmlBytes,
  });
  const evidenceJson = renderProductTruthDirectRetailerIdentityEvidence(
    evidence,
  );
  const evidenceSha256 = sha256(evidenceJson);
  const artifactIndex = {
    schemaVersion:
      "product-truth-direct-retailer-identity-evidence-index/1.0.0",
    createdAt: options.capturedAt,
    targetCanonicalVariantId: options.targetCanonicalVariantId,
    artifacts: [
      {
        role: "evidence",
        file: "evidence.json",
        sha256: evidenceSha256,
      },
      {
        role: "retailer_content_html",
        file: evidence.retailerContent.htmlFile,
        sha256: evidence.retailerContent.htmlSha256,
      },
    ],
    safety: evidence.safety,
  };
  const artifactIndexJson = renderProductTruthOperationalJson(artifactIndex);
  await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeNewFile(resolve(options.outDir, "evidence.json"), evidenceJson),
    writeNewFile(
      resolve(options.outDir, "evidence.sha256"),
      `${evidenceSha256}\n`,
    ),
    writeNewFile(
      resolve(options.outDir, evidence.retailerContent.htmlFile),
      htmlBytes,
    ),
    writeNewFile(
      resolve(options.outDir, "artifact-index.json"),
      artifactIndexJson,
    ),
    writeNewFile(
      resolve(options.outDir, "artifact-index.sha256"),
      `${sha256(artifactIndexJson)}\n`,
    ),
  ]);
  await chmod(
    resolve(options.outDir, evidence.retailerContent.htmlFile),
    0o400,
  );
  process.stdout.write(artifactIndexJson);
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
