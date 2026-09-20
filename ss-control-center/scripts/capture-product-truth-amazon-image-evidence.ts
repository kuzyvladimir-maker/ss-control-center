import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
  PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
  renderProductTruthAmazonImageCapture,
  renderProductTruthAmazonImageCapturePlan,
  validateProductTruthAmazonImageCapturePlan,
  type ProductTruthAmazonImageCapture,
  type ProductTruthAmazonImageCapturePlan,
} from "../src/lib/sourcing/product-truth-amazon-image-evidence";

type JsonObject = Record<string, unknown>;

const SWIFT_OBSERVER = String.raw`
import AppKit
import Foundation
import ImageIO
import Vision

func box(_ value: CGRect) -> [String: Double] {
  return ["x": value.origin.x, "y": value.origin.y,
          "width": value.size.width, "height": value.size.height]
}

func observe(_ path: String) throws -> [String: Any] {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw NSError(domain: "ProductTruthAmazonImage", code: 2,
                  userInfo: [NSLocalizedDescriptionKey: "image decode failed"])
  }
  let text = VNRecognizeTextRequest()
  text.recognitionLevel = .accurate
  text.recognitionLanguages = ["en-US"]
  text.usesLanguageCorrection = false
  text.minimumTextHeight = 0.003
  let barcode = VNDetectBarcodesRequest()
  barcode.symbologies = [.ean13, .upce, .ean8]
  let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
  try handler.perform([text, barcode])
  let texts: [[String: Any]] = (text.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let b = observation.boundingBox
    guard b.minX >= 0, b.minY >= 0, b.width > 0, b.height > 0,
          b.maxX <= 1, b.maxY <= 1 else { return nil }
    return ["text": candidate.string, "confidence": candidate.confidence,
            "boundingBox": box(b)]
  }
  let barcodes: [[String: Any]] = (barcode.results ?? []).compactMap { observation in
    guard let payload = observation.payloadStringValue, !payload.isEmpty else { return nil }
    return ["symbology": observation.symbology.rawValue,
            "payload": payload, "confidence": observation.confidence]
  }
  return ["width": image.width, "height": image.height,
          "ocr": texts, "barcodes": barcodes]
}

do {
  let rows = try CommandLine.arguments.dropFirst().map { try observe($0) }
  let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
} catch {
  fputs("APPLE_VISION_FAILED: \(error)\n", stderr)
  exit(1)
}
`;

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

function options(argv: readonly string[]) {
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

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("APPLE_VISION_OUTPUT_INVALID", label);
  }
  return value as JsonObject;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("APPLE_VISION_OUTPUT_INVALID", label);
  }
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
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

async function writeNew(path: string, value: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail("AMAZON_IMAGE_TOO_LARGE", `declared=${declared}`);
  }
  if (!response.body) fail("AMAZON_IMAGE_RESPONSE_INVALID", "body missing");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const row = await reader.read();
    if (row.done) break;
    total += row.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail("AMAZON_IMAGE_TOO_LARGE", `streamed>${maxBytes}`);
    }
    chunks.push(Buffer.from(row.value));
  }
  return Buffer.concat(chunks, total);
}

async function observe(paths: string[]): Promise<JsonObject[]> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const exitCode = await new Promise<number>((resolveCode, reject) => {
    const child = spawn("swift", ["-", ...paths], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveCode(code ?? 1));
    child.stdin.end(SWIFT_OBSERVER);
  });
  if (exitCode !== 0) {
    fail("APPLE_VISION_FAILED", Buffer.concat(stderr).toString("utf8").trim());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch {
    fail("APPLE_VISION_OUTPUT_INVALID", "not JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== paths.length) {
    fail("APPLE_VISION_OUTPUT_INVALID", "cardinality");
  }
  return parsed.map((value, index) => object(value, `image[${index}]`));
}

async function run(input: ReturnType<typeof options>): Promise<void> {
  const planBytes = await readFile(await realpath(input.planPath));
  const planJson = planBytes.toString("utf8");
  const expectedSha = input.planSha256.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(expectedSha) || sha256(planBytes) !== expectedSha) {
    fail("IMAGE_PLAN_SHA_MISMATCH", input.planPath);
  }
  let plan: ProductTruthAmazonImageCapturePlan;
  try {
    plan = JSON.parse(planJson) as ProductTruthAmazonImageCapturePlan;
  } catch {
    fail("IMAGE_PLAN_JSON_INVALID", input.planPath);
  }
  validateProductTruthAmazonImageCapturePlan(plan);
  if (renderProductTruthAmazonImageCapturePlan(plan) !== planJson) {
    fail("IMAGE_PLAN_NOT_CANONICAL", input.planPath);
  }
  const parent = dirname(input.outDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) fail("OUTPUT_PARENT_NOT_REALPATH", parent);
  await assertAbsent(input.outDir);
  const temporary = join(parent, `.${basename(input.outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  let getCalls = 0;
  try {
    const downloaded: Array<{
      file: string;
      path: string;
      bytes: Buffer;
      mimeType: ProductTruthAmazonImageCapture["entries"][number]["mimeType"];
      finalUrl: string;
      capturedAt: string;
    }> = [];
    for (const target of plan.targets) {
      getCalls += 1;
      const response = await fetch(target.imageUrl, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "image/jpeg,image/png,image/webp" },
      });
      let finalUrl: URL;
      try {
        finalUrl = new URL(response.url);
      } catch {
        fail("AMAZON_IMAGE_RESPONSE_INVALID", target.listingKey);
      }
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim()
        .toLocaleLowerCase("en-US");
      if (
        response.status !== 200
        || finalUrl.protocol !== "https:"
        || finalUrl.hostname !== plan.requestContract.allowedHost
        || !["image/jpeg", "image/png", "image/webp"].includes(mimeType ?? "")
      ) fail("AMAZON_IMAGE_RESPONSE_INVALID", `${target.listingKey} status=${response.status}`);
      const bytes = await boundedBody(response, plan.requestContract.maxImageBytes);
      const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
      const file = `${String(target.ordinal).padStart(4, "0")}-${target.asin}-${target.variants.join("-")}.${extension}`;
      const path = resolve(temporary, file);
      await writeNew(path, bytes);
      downloaded.push({
        file,
        path,
        bytes,
        mimeType: mimeType as ProductTruthAmazonImageCapture["entries"][number]["mimeType"],
        finalUrl: finalUrl.href,
        capturedAt: new Date().toISOString(),
      });
    }
    const observations = await observe(downloaded.map((row) => row.path));
    const entries = plan.targets.map((target, index) => {
      const downloadedImage = downloaded[index]!;
      const observation = observations[index]!;
      if (
        !Number.isInteger(observation.width)
        || !Number.isInteger(observation.height)
        || !Array.isArray(observation.ocr)
        || !Array.isArray(observation.barcodes)
        || observation.ocr.length > 500
        || observation.barcodes.length > 20
      ) fail("APPLE_VISION_OUTPUT_INVALID", target.listingKey);
      const ocr = observation.ocr.map((value, rowIndex) => {
        const row = object(value, `${target.listingKey}.ocr[${rowIndex}]`);
        const box = object(row.boundingBox, `${target.listingKey}.boundingBox`);
        if (typeof row.text !== "string" || !row.text.trim()) {
          fail("APPLE_VISION_OUTPUT_INVALID", `${target.listingKey}.text`);
        }
        return {
          text: row.text.trim(),
          confidence: finite(row.confidence, `${target.listingKey}.confidence`),
          boundingBox: {
            x: finite(box.x, "x"), y: finite(box.y, "y"),
            width: finite(box.width, "width"), height: finite(box.height, "height"),
          },
        };
      });
      const barcodes = observation.barcodes.map((value, rowIndex) => {
        const row = object(value, `${target.listingKey}.barcode[${rowIndex}]`);
        if (
          typeof row.symbology !== "string"
          || typeof row.payload !== "string"
          || !row.symbology.trim()
          || !row.payload.trim()
        ) fail("APPLE_VISION_OUTPUT_INVALID", `${target.listingKey}.barcode`);
        return {
          symbology: row.symbology.trim(),
          payload: row.payload.trim(),
          confidence: finite(row.confidence, `${target.listingKey}.barcode confidence`),
        };
      });
      return {
        ordinal: target.ordinal,
        listingKey: target.listingKey,
        storeIndex: target.storeIndex,
        sku: target.sku,
        asin: target.asin,
        variants: target.variants,
        requestedUrl: target.imageUrl,
        finalUrl: downloadedImage.finalUrl,
        capturedAt: downloadedImage.capturedAt,
        imageFile: downloadedImage.file,
        mimeType: downloadedImage.mimeType,
        byteLength: downloadedImage.bytes.byteLength,
        imageSha256: sha256(downloadedImage.bytes),
        decodedWidth: Number(observation.width),
        decodedHeight: Number(observation.height),
        ocr,
        barcodes,
        observationAuthority: {
          engine: "APPLE_VISION_LOCAL" as const,
          modelCalls: 0 as const,
          barcodeIsBaseUnitProof: false as const,
          ocrIsExactIdentityProof: false as const,
          authorizesCanonicalMaterialization: false as const,
        },
      };
    });
    if (getCalls !== plan.targets.length) fail("AMAZON_IMAGE_GET_COUNT_INVALID", `${getCalls}`);
    const capture: ProductTruthAmazonImageCapture = {
      schemaVersion: PRODUCT_TRUTH_AMAZON_IMAGE_CAPTURE_VERSION,
      capturedAt: new Date().toISOString(),
      source: {
        imagePlanSha256: expectedSha,
        imageSetSha256: plan.imageSetSha256,
        targetCount: plan.targets.length,
      },
      entries,
      counts: {
        planned: plan.targets.length,
        captured: entries.length,
        amazonCdnGetCalls: getCalls,
        retries: 0,
        imagesWithText: entries.filter((row) => row.ocr.length > 0).length,
        imagesWithBarcodes: entries.filter((row) => row.barcodes.length > 0).length,
        barcodeObservations: entries.reduce((sum, row) => sum + row.barcodes.length, 0),
      },
      claims: {
        localAppleVision: true,
        modelCalls: 0,
        providerCalls: 0,
        paidCalls: 0,
        databaseWrites: 0,
        marketplaceMutations: 0,
        barcodeIsBaseUnitProof: false,
        ocrIsExactIdentityProof: false,
        authorizesCanonicalMaterialization: false,
      },
    };
    const captureJson = renderProductTruthAmazonImageCapture(capture);
    const captureSha = sha256(captureJson);
    await Promise.all([
      writeNew(resolve(temporary, "image-capture.json"), captureJson),
      writeNew(resolve(temporary, "image-capture.sha256"), `${captureSha}\n`),
    ]);
    await assertAbsent(input.outDir);
    await rename(temporary, input.outDir);
    process.stdout.write(JSON.stringify({
      status: "IMAGE_EVIDENCE_CAPTURED",
      outDir: input.outDir,
      imageCaptureSha256: captureSha,
      counts: capture.counts,
      modelCalls: 0,
      providerCalls: 0,
      marketplaceMutations: 0,
    }, null, 2) + "\n");
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write("Capture Amazon gallery bytes and local Apple Vision OCR/barcodes from an exact image plan.\n");
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
