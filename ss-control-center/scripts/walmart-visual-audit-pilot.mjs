#!/usr/bin/env node
/**
 * Strict, subscription-only Walmart visual-audit pilot.
 *
 * Default is a zero-network plan/manifest validation. Add --run to download the
 * frozen artifact images and call exactly one explicitly selected subscription
 * worker. This script imports no DB, Walmart write, R2 upload, remediation, or
 * paid API client.
 *
 *   node --experimental-strip-types scripts/walmart-visual-audit-pilot.mjs
 *   node --experimental-strip-types scripts/walmart-visual-audit-pilot.mjs --run --provider=codex --call-budget=6
 */

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import sharp from "sharp";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
  WALMART_VISUAL_COMPARATOR_VERSION,
  buildBlindObservationPrompt,
  decideBlind,
  parseBlindResponse,
  shuffledWithSeed,
  validateAuditManifest,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_SCHEMA,
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  LOCAL_VISUAL_OCR_ENGINE,
  LOCAL_VISUAL_OCR_SCHEMA,
  parseLocalOcrOutput,
} from "../src/lib/walmart/local-visual-ocr.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER_SOURCE = fileURLToPath(import.meta.url);
const COMPARATOR_SOURCE = path.join(ROOT, "src/lib/walmart/catalog-visual-audit.ts");
const PREPROCESSOR_SOURCE = path.join(ROOT, "src/lib/walmart/catalog-visual-preprocess.ts");
const LOCAL_OCR_SCRIPT = path.join(ROOT, "scripts/walmart-visual-ocr.swift");
const SWIFT_EXECUTABLE = "/usr/bin/swift";
const LOCAL_OCR_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk";
const LOCAL_OCR_MODULE_CACHE = "/private/tmp/ss-walmart-visual-ocr-swift-module-cache";
const DEFAULT_MANIFEST = path.join(ROOT, "data/audits/walmart-visual-pilot-golden-pairs-v3.json");
const MAX_PILOT_CASES = 50;
const MAX_IMAGES_PER_CALL = 6;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const NORMALIZED_MAX_PX = 1800;
const NORMALIZED_JPEG_QUALITY = 92;
const LOCAL_OCR_VIEW_ROLES = new Set(["full", "tile_front", "bottom_label", "top_left_badge"]);
const execFile = promisify(execFileCallback);

loadEnv({ path: path.join(ROOT, ".env.local"), override: false, quiet: true });
loadEnv({ path: path.join(ROOT, ".env"), override: false, quiet: true });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseArgs(argv) {
  const out = {
    run: false,
    freezeOnly: false,
    provider: "codex",
    manifest: DEFAULT_MANIFEST,
    layout: null,
    callBudget: null,
    expectConsumed: null,
    localOcr: "required",
    replays: [],
  };
  for (const arg of argv) {
    if (arg === "--run") out.run = true;
    else if (arg === "--freeze-only") out.freezeOnly = true;
    else if (arg.startsWith("--provider=")) out.provider = arg.slice("--provider=".length);
    else if (arg.startsWith("--manifest=")) out.manifest = path.resolve(ROOT, arg.slice("--manifest=".length));
    else if (arg.startsWith("--layout=")) out.layout = arg.slice("--layout=".length);
    else if (arg.startsWith("--call-budget=")) out.callBudget = Number(arg.slice("--call-budget=".length));
    else if (arg.startsWith("--expect-consumed=")) out.expectConsumed = Number(arg.slice("--expect-consumed=".length));
    else if (arg.startsWith("--local-ocr=")) out.localOcr = arg.slice("--local-ocr=".length);
    else if (arg.startsWith("--replay=")) out.replays.push(path.resolve(ROOT, arg.slice("--replay=".length)));
    else if (arg.startsWith("--merge-reports=")) {
      for (const file of arg.slice("--merge-reports=".length).split(",").filter(Boolean)) out.replays.push(path.resolve(ROOT, file));
    }
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (out.provider !== "codex" && out.provider !== "claude") {
    throw new Error("--provider must be codex or claude; auto/paid providers are forbidden");
  }
  if (out.localOcr !== "required" && out.localOcr !== "off") {
    throw new Error("--local-ocr must be required or off");
  }
  if (out.run && out.freezeOnly) throw new Error("--run and --freeze-only are mutually exclusive");
  if (out.callBudget !== null && (!Number.isInteger(out.callBudget) || out.callBudget < 1)) {
    throw new Error("--call-budget must be a positive integer");
  }
  if (out.run && out.callBudget === null) {
    throw new Error("--run requires an explicit positive --call-budget");
  }
  if (out.expectConsumed !== null && (!Number.isInteger(out.expectConsumed) || out.expectConsumed < 0)) {
    throw new Error("--expect-consumed must be a non-negative integer");
  }
  if (out.expectConsumed !== null && !out.run) {
    throw new Error("--expect-consumed requires --run");
  }
  return out;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function safeStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

async function fileExists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function readJsonIfPresent(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeImmutableBytes(file, bytes, expectedSha = sha256(bytes)) {
  if (sha256(bytes) !== expectedSha) throw new Error(`immutable write hash mismatch for ${file}`);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(file);
    if (sha256(existing) !== expectedSha) throw new Error(`immutable artifact collision at ${file}`);
  }
}

async function buildArtifactAttestation() {
  const [runnerBytes, comparatorBytes, preprocessorBytes, ocrScriptBytes] = await Promise.all([
    readFile(RUNNER_SOURCE),
    readFile(COMPARATOR_SOURCE),
    readFile(PREPROCESSOR_SOURCE),
    readFile(LOCAL_OCR_SCRIPT),
  ]);
  return {
    runner_source_sha256: sha256(runnerBytes),
    comparator_version: WALMART_VISUAL_COMPARATOR_VERSION,
    comparator_source_sha256: sha256(comparatorBytes),
    preprocessor_schema: VISUAL_PREPROCESS_SCHEMA,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    preprocessor_source_sha256: sha256(preprocessorBytes),
    local_ocr_schema: LOCAL_VISUAL_OCR_SCHEMA,
    local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
    local_ocr_script_sha256: sha256(ocrScriptBytes),
    local_ocr_runtime: {
      executable: SWIFT_EXECUTABLE,
      sdk: path.basename(LOCAL_OCR_SDK),
    },
  };
}

async function assertLocalOcrAvailable() {
  const [swift, script, sdk] = await Promise.all([
    stat(SWIFT_EXECUTABLE),
    stat(LOCAL_OCR_SCRIPT),
    stat(LOCAL_OCR_SDK),
  ]);
  if (!swift.isFile() || !script.isFile() || !sdk.isDirectory()) {
    throw new Error("required local Apple Vision OCR is unavailable");
  }
}

function serializableView(view, snapshotDir, file) {
  return {
    view_id: view.view_id,
    role: view.role,
    media_type: view.media_type,
    width: view.width,
    height: view.height,
    byte_length: view.byte_length,
    sha256: view.sha256,
    provenance_sha256: view.provenance_sha256,
    transform: view.transform,
    file: path.relative(snapshotDir, file),
  };
}

async function invokeLocalOcr(imagePaths) {
  const requested = imagePaths.map((file) => path.resolve(file));
  await mkdir(LOCAL_OCR_MODULE_CACHE, { recursive: true });
  let stdout;
  try {
    ({ stdout } = await execFile(SWIFT_EXECUTABLE, [LOCAL_OCR_SCRIPT, ...requested], {
      encoding: "utf8",
      env: {
        ...process.env,
        SDKROOT: LOCAL_OCR_SDK,
        CLANG_MODULE_CACHE_PATH: LOCAL_OCR_MODULE_CACHE,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    }));
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 2_000);
    throw new Error(`required local Apple Vision OCR failed: ${detail}`);
  }
  let raw;
  try { raw = JSON.parse(stdout); } catch {
    throw new Error("required local Apple Vision OCR returned invalid JSON");
  }
  return { parsed: parseLocalOcrOutput(raw, requested), rawBytes: Buffer.from(stdout) };
}

async function prepareLocalVisualEvidence({ frozen, snapshotDir, localOcrMode, attestation }) {
  const rawBytes = await readFile(frozen.raw_path);
  if (sha256(rawBytes) !== frozen.raw_sha256) {
    throw new Error(`raw snapshot hash mismatch: ${frozen.raw_file}`);
  }
  const preprocessed = await preprocessCatalogVisual(rawBytes);
  if (preprocessed.preprocessor_version !== VISUAL_PREPROCESS_VERSION
    || preprocessed.schema_version !== VISUAL_PREPROCESS_SCHEMA
    || preprocessed.source.sha256 !== frozen.raw_sha256) {
    throw new Error("visual preprocessor attestation mismatch");
  }

  const persistedViews = [];
  const viewPaths = [];
  const seenViewIds = new Set();
  const seenViewRoles = new Set();
  const seenViewPaths = new Set();
  const seenViewTuples = new Set();
  for (const view of preprocessed.views) {
    if (!LOCAL_OCR_VIEW_ROLES.has(view.role)) throw new Error(`preprocessor emitted unsupported view role ${view.role}`);
    if (sha256(view.bytes) !== view.sha256 || view.bytes.length !== view.byte_length) {
      throw new Error(`derived view integrity mismatch: ${view.view_id}`);
    }
    const extension = view.media_type === "image/png" ? "png" : "jpg";
    const file = path.join(snapshotDir, "derived", `${view.role}-${view.sha256}.${extension}`);
    const tuple = `${view.view_id}|${view.role}|${view.sha256}|${file}`;
    if (seenViewIds.has(view.view_id)
      || seenViewRoles.has(view.role)
      || seenViewPaths.has(file)
      || seenViewTuples.has(tuple)) {
      throw new Error(`preprocessor emitted duplicate view identity: ${tuple}`);
    }
    seenViewIds.add(view.view_id);
    seenViewRoles.add(view.role);
    seenViewPaths.add(file);
    seenViewTuples.add(tuple);
    await writeImmutableBytes(file, view.bytes, view.sha256);
    persistedViews.push(serializableView(view, snapshotDir, file));
    viewPaths.push(file);
  }

  const provenance = {
    schema_version: preprocessed.schema_version,
    preprocessor_version: preprocessed.preprocessor_version,
    source: preprocessed.source,
    analysis: preprocessed.analysis,
    views: persistedViews,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  const provenanceSha = sha256(provenanceBytes);
  const provenanceFile = path.join(snapshotDir, "provenance", `${provenanceSha}.json`);
  await writeImmutableBytes(provenanceFile, provenanceBytes, provenanceSha);

  const common = {
    preprocessor: {
      schema_version: preprocessed.schema_version,
      version: preprocessed.preprocessor_version,
      source_sha256: preprocessed.source.sha256,
      analysis: preprocessed.analysis,
      views: persistedViews,
      provenance_sha256: provenanceSha,
      provenance_file: path.relative(snapshotDir, provenanceFile),
    },
  };
  if (localOcrMode === "off") {
    return { ...common, local_ocr: { mode: "off" }, auxiliary: undefined };
  }

  const evidenceKey = sha256(JSON.stringify({
    schema: LOCAL_VISUAL_OCR_SCHEMA,
    engine: LOCAL_VISUAL_OCR_ENGINE,
    script_sha256: attestation.local_ocr_script_sha256,
    runtime: attestation.local_ocr_runtime,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    views: persistedViews.map((view) => ({ role: view.role, sha256: view.sha256 })),
  }));
  const cacheFile = path.join(snapshotDir, "local-evidence-index.json");
  const cache = await readJsonIfPresent(cacheFile, {});
  const cached = cache[evidenceKey];
  let parsed;
  let rawSha;
  let rawFile;
  let reused = false;
  if (cached?.raw_file && /^[a-f0-9]{64}$/.test(cached?.raw_sha256 || "")) {
    rawFile = ensureUnderDirectory(snapshotDir, cached.raw_file, "cached OCR output");
    if (await fileExists(rawFile)) {
      const bytes = await readFile(rawFile);
      if (sha256(bytes) === cached.raw_sha256) {
        try {
          parsed = parseLocalOcrOutput(JSON.parse(bytes.toString("utf8")), viewPaths.map((file) => path.resolve(file)));
          rawSha = cached.raw_sha256;
          reused = true;
        } catch { /* fail closed into a fresh deterministic OCR invocation */ }
      }
    }
  }
  if (!parsed) {
    const invoked = await invokeLocalOcr(viewPaths);
    parsed = invoked.parsed;
    rawSha = sha256(invoked.rawBytes);
    rawFile = path.join(snapshotDir, "ocr", `${rawSha}.json`);
    await writeImmutableBytes(rawFile, invoked.rawBytes, rawSha);
    cache[evidenceKey] = {
      raw_sha256: rawSha,
      raw_file: path.relative(snapshotDir, rawFile),
      schema_version: parsed.schema_version,
      engine: parsed.engine,
      script_sha256: attestation.local_ocr_script_sha256,
      runtime: attestation.local_ocr_runtime,
      view_sha256: persistedViews.map((view) => view.sha256),
    };
    await atomicJson(cacheFile, cache);
  }

  const pathToView = new Map(viewPaths.map((file, index) => [path.resolve(file), persistedViews[index]]));
  const ocrViews = parsed.images.map((image) => {
    const view = pathToView.get(image.path);
    if (!view || !LOCAL_OCR_VIEW_ROLES.has(view.role)) throw new Error(`OCR returned an unpermitted image path: ${image.path}`);
    return {
      role: view.role,
      view_sha256: view.sha256,
      width: image.width,
      height: image.height,
      observations: image.observations,
    };
  });
  const trustedByLiteral = new Map();
  const trustedCandidates = ocrViews.flatMap((view) => view.observations)
    .filter((row) => row.confidence >= WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE);
  for (const row of trustedCandidates) {
    const key = row.text.trim().replace(/\s+/g, " ").toLowerCase();
    const prior = trustedByLiteral.get(key);
    if (!prior || row.confidence > prior.confidence) {
      trustedByLiteral.set(key, { text: row.text, confidence: row.confidence });
    }
  }
  const trustedUnique = [...trustedByLiteral.values()];
  const auxiliary = { ocr_texts: trustedUnique.slice(0, 100) };
  return {
    ...common,
    local_ocr: {
      mode: "required",
      schema_version: parsed.schema_version,
      engine: parsed.engine,
      script_sha256: attestation.local_ocr_script_sha256,
      runtime: attestation.local_ocr_runtime,
      evidence_key: evidenceKey,
      raw_sha256: rawSha,
      raw_file: path.relative(snapshotDir, rawFile),
      reused,
      auxiliary_selection: {
        minimum_confidence: WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
        trusted_candidates: trustedCandidates.length,
        unique_literals: trustedUnique.length,
        passed_to_comparator: auxiliary.ocr_texts.length,
        truncated: trustedUnique.length > auxiliary.ocr_texts.length,
      },
      views: ocrViews,
    },
    auxiliary,
  };
}

function decideWithLocalEvidence(caseInput, image, observation, localVisualEvidence) {
  const decision = decideBlind(caseInput, image, observation, localVisualEvidence.auxiliary);
  if (decision.verdict !== "PASS" || !localVisualEvidence.local_ocr?.auxiliary_selection?.truncated) {
    return decision;
  }
  return {
    ...decision,
    verdict: "REVIEW",
    unknowns: [...decision.unknowns, "local OCR evidence exceeded the conservative comparator limit"],
  };
}

function modelAttachmentFromEvidence(evidence, snapshotDir) {
  const fullViews = evidence.preprocessor.views.filter((view) => view.role === "full");
  if (fullViews.length !== 1 || fullViews[0].media_type !== "image/jpeg") {
    throw new Error("preprocessor must emit exactly one JPEG full view for the worker");
  }
  return {
    role: "full",
    sha256: fullViews[0].sha256,
    file: fullViews[0].file,
    path: ensureUnderDirectory(snapshotDir, fullViews[0].file, "model full attachment"),
  };
}

function extensionForFormat(format) {
  return ({ jpeg: "jpg", png: "png", webp: "webp", gif: "gif", tiff: "tif", avif: "avif" })[format] ?? "bin";
}

async function readResponseWithLimit(response, limit) {
  if (!response.body) throw new Error("response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchImageOnce(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "SS-Walmart-ReadOnly-Visual-Pilot/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error(`unexpected content-type ${contentType || "missing"}`);
  const raw = await readResponseWithLimit(response, MAX_IMAGE_BYTES);
  if (!raw.length || raw.length > MAX_IMAGE_BYTES) throw new Error(`invalid image byte length ${raw.length}`);
  return { raw, contentType };
}

async function freezeImage(input, dirs, prior) {
  const cached = prior?.[input.url];
  if (cached) {
    const rawPath = path.join(dirs.runDir, cached.raw_file);
    const normalizedPath = path.join(dirs.runDir, cached.normalized_file);
    if (await fileExists(rawPath) && await fileExists(normalizedPath)) {
      const [raw, normalized] = await Promise.all([readFile(rawPath), readFile(normalizedPath)]);
      if (sha256(raw) === cached.raw_sha256 && sha256(normalized) === cached.normalized_sha256) {
        return { ...cached, raw_path: rawPath, normalized_path: normalizedPath, reused_frozen_bytes: true };
      }
    }
  }

  const { raw, contentType } = await fetchImageOnce(input.url);
  const rawSha = sha256(raw);
  let metadata;
  try { metadata = await sharp(raw).metadata(); } catch (error) {
    throw new Error(`image decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("image dimensions/format unavailable");
  const normalized = await sharp(raw)
    .rotate()
    .resize(NORMALIZED_MAX_PX, NORMALIZED_MAX_PX, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: NORMALIZED_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const normalizedMeta = await sharp(normalized).metadata();
  const normalizedSha = sha256(normalized);
  const rawFile = path.join("raw", `${rawSha}.${extensionForFormat(metadata.format)}`);
  const normalizedFile = path.join("normalized", `${normalizedSha}.jpg`);
  const rawPath = path.join(dirs.runDir, rawFile);
  const normalizedPath = path.join(dirs.runDir, normalizedFile);
  if (!(await fileExists(rawPath))) await writeFile(rawPath, raw);
  if (!(await fileExists(normalizedPath))) await writeFile(normalizedPath, normalized);
  return {
    url: input.url,
    slot: input.slot,
    surface: input.surface,
    buyer_facing_verified: input.buyer_facing_verified,
    content_type: contentType,
    raw_sha256: rawSha,
    raw_bytes: raw.length,
    raw_width: metadata.width,
    raw_height: metadata.height,
    raw_format: metadata.format,
    normalized_sha256: normalizedSha,
    normalized_bytes: normalized.length,
    normalized_width: normalizedMeta.width,
    normalized_height: normalizedMeta.height,
    normalization: `jpeg-max${NORMALIZED_MAX_PX}-q${NORMALIZED_JPEG_QUALITY}-444-white`,
    raw_file: rawFile,
    normalized_file: normalizedFile,
    raw_path: rawPath,
    normalized_path: normalizedPath,
    reused_frozen_bytes: false,
    frozen_at: new Date().toISOString(),
  };
}

function workerEndpoint(provider) {
  const generationUrl = process.env.CODEX_IMAGE_WORKER_URL;
  const token = process.env.CODEX_IMAGE_WORKER_TOKEN;
  if (!generationUrl || !token) throw new Error("subscription worker is not configured");
  const url = new URL(generationUrl);
  if (url.protocol !== "https:") throw new Error("subscription worker must use HTTPS");
  url.pathname = url.pathname.replace(/\/generate\/?$/, provider === "codex" ? "/analyze" : "/analyze-claude");
  if (!url.pathname.endsWith(provider === "codex" ? "/analyze" : "/analyze-claude")) {
    throw new Error("CODEX_IMAGE_WORKER_URL must end in /generate");
  }
  return { url, token };
}

function expectedWorkerProvider(provider) {
  return provider === "codex" ? "codex_cli_subscription" : "claude_cli_subscription";
}

async function fetchWorkerContract(provider) {
  const { url } = workerEndpoint(provider);
  url.pathname = url.pathname.replace(/\/analyze(?:-claude)?\/?$/, "/health");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  const expectedProvider = expectedWorkerProvider(provider);
  if (!response.ok || body?.ok !== true) throw new Error(`worker health failed: HTTP ${response.status}`);
  if (typeof body.worker_build !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.worker_build)) {
    throw new Error("worker health has no valid build attestation");
  }
  if (!Array.isArray(body.vision_providers) || !body.vision_providers.includes(expectedProvider)) {
    throw new Error(`worker health does not attest ${expectedProvider}`);
  }
  return { worker_build: body.worker_build, vision_provider: expectedProvider };
}

async function postWorkerOnce({ provider, images, prompt, workerContract }) {
  const endpoint = workerEndpoint(provider);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ prompt, images }),
      signal: AbortSignal.timeout(220_000),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* captured as transport failure below */ }
    const expectedProvider = expectedWorkerProvider(provider);
    const attestedImageCount = Number.isInteger(body?.input_image_count)
      ? body.input_image_count
      : Number(response.headers.get("x-vision-image-count") || NaN);
    const workerProvider = body?.vision_provider ?? null;
    const workerBuild = body?.worker_build ?? null;
    const basicResultOk = response.ok
      && body?.ok === true
      && body?.result
      && typeof body.result === "object"
      && !Array.isArray(body.result);
    const contractErrors = [];
    if (attestedImageCount !== images.length) {
      contractErrors.push(`input_image_count ${Number.isFinite(attestedImageCount) ? attestedImageCount : "missing"} != ${images.length}`);
    }
    if (workerProvider !== expectedProvider) {
      contractErrors.push(`vision_provider ${workerProvider || "missing"} != ${expectedProvider}`);
    }
    if (typeof workerBuild !== "string" || !/^sha256:[a-f0-9]{64}$/.test(workerBuild)) {
      contractErrors.push("worker_build attestation missing or invalid");
    } else if (workerBuild !== workerContract.worker_build) {
      contractErrors.push(`worker_build ${workerBuild} != health-attested ${workerContract.worker_build}`);
    }
    const workerContractAttested = contractErrors.length === 0;
    const ok = basicResultOk && workerContractAttested;
    return {
      ok,
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      duration_ms: Date.now() - started,
      result: body?.result ?? null,
      error: ok
        ? null
        : response.ok
          ? (body?.error || contractErrors.join("; ") || (body ? "missing result" : "invalid JSON"))
          : (body?.error || `HTTP ${response.status}`),
      attested_image_count: attestedImageCount,
      worker_provider: workerProvider,
      worker_build: workerBuild,
      worker_contract_attested: workerContractAttested,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      duration_ms: Date.now() - started,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      attested_image_count: NaN,
      worker_provider: null,
      worker_build: null,
      worker_contract_attested: false,
    };
  }
}

async function callTransport({
  provider, images, prompt, workerContract, callBudget, state, stateFile,
}) {
  const attempts = [];
  const maxAttempts = Number.isFinite(callBudget.max) ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (callBudget.used >= callBudget.max) {
      throw new Error(`subscription call budget exhausted at ${callBudget.used}/${callBudget.max}`);
    }
    callBudget.used += 1;
    state.subscription_calls_consumed = callBudget.used;
    await atomicJson(stateFile, state);
    const response = await postWorkerOnce({ provider, images, prompt, workerContract });
    attempts.push({
      attempt: attempt + 1,
      status: response.status,
      duration_ms: response.duration_ms,
      ok: response.ok,
      error: response.error || null,
      attested_image_count: Number.isFinite(response.attested_image_count) ? response.attested_image_count : null,
      worker_provider: response.worker_provider,
      worker_build: response.worker_build,
      worker_contract_attested: response.worker_contract_attested,
    });
    if (response.ok) return { response, attempts };
    if (!response.retryable || attempt === maxAttempts - 1) return { response, attempts };
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2_000 : 5_000));
  }
  throw new Error("unreachable transport loop");
}

function imageIdFor(layoutName, batchIndex, position, normalizedSha) {
  return `i_${sha256(`${layoutName}|${batchIndex}|${position}|${normalizedSha}`).slice(0, 16)}`;
}

async function executeVisionCall({
  provider, layoutName, batchIndex, items, state, stateFile, workerContract, callBudget,
}) {
  const imageIds = items.map((item, index) => imageIdFor(layoutName, batchIndex, index, item.modelAttachment.sha256));
  const prompt = buildBlindObservationPrompt(imageIds);
  const promptSha = sha256(prompt);
  const callKey = sha256(JSON.stringify({
    provider,
    observation_schema: BLIND_OBSERVATION_SCHEMA,
    prompt_sha256: promptSha,
    worker_build: workerContract.worker_build,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    full_view_sha256: items.map((item) => item.modelAttachment.sha256),
  }));
  const prior = state.calls?.[callKey];
  if (prior?.schema_valid && prior?.observations && prior?.worker_contract_attested) {
    const observations = parseBlindResponse(prior.observations, imageIds);
    return { ...prior, call_key: callKey, image_ids: imageIds, prompt_sha256: promptSha, observations, resumed: true };
  }

  // Only the deterministic full view is sent to the worker. Detail crops are
  // local-OCR-only evidence and never alter model image count or grid semantics.
  const imageB64 = await Promise.all(items.map(async (item) => (await readFile(item.modelAttachment.path)).toString("base64")));
  const transport = await callTransport({
    provider,
    images: imageB64,
    prompt,
    workerContract,
    callBudget,
    state,
    stateFile,
  });
  let observations = null;
  let schemaError = null;
  if (transport.response.ok) {
    try { observations = parseBlindResponse(transport.response.result, imageIds); }
    catch (error) { schemaError = error instanceof Error ? error.message : String(error); }
  }
  const record = {
    call_key: callKey,
    provider,
    prompt_version: BLIND_PROMPT_VERSION,
    prompt_sha256: promptSha,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_ids: imageIds,
    full_view_sha256: items.map((item) => item.modelAttachment.sha256),
    transport_attempts: transport.attempts,
    transport_ok: transport.response.ok,
    schema_valid: !!observations,
    schema_error: schemaError,
    image_count_attested: transport.response.attested_image_count === items.length,
    worker_contract_attested: transport.response.worker_contract_attested,
    worker_provider: transport.response.worker_provider,
    worker_build: transport.response.worker_build,
    observations: transport.response.result,
    completed_at: new Date().toISOString(),
  };
  state.calls ??= {};
  state.calls[callKey] = record;
  await atomicJson(stateFile, state);
  return { ...record, observations, resumed: false };
}

async function runBatchWithSchemaFallback(args) {
  const primary = await executeVisionCall(args);
  if (primary.observations) return { primary, fallback: [], observations: primary.observations };
  if (Number.isFinite(args.callBudget.max)) {
    return { primary, fallback: [], observations: null };
  }
  // A malformed multi-image response is retried one image at a time. This can
  // recover the report, but first-attempt schema reliability remains failed.
  if (args.items.length === 1) return { primary, fallback: [], observations: null };
  const fallback = [];
  const observations = [];
  for (let index = 0; index < args.items.length; index++) {
    const item = args.items[index];
    const one = await executeVisionCall({
      ...args,
      layoutName: `${args.layoutName}-schema-fallback`,
      batchIndex: args.batchIndex * 100 + index,
      items: [item],
    });
    fallback.push(one);
    if (!one.observations) return { primary, fallback, observations: null };
    observations.push(one.observations[0]);
  }
  return { primary, fallback, observations };
}

function aggregateVerdicts(verdicts) {
  if (verdicts.includes("TECHNICAL_ERROR")) return "TECHNICAL_ERROR";
  if (verdicts.length && verdicts.every((verdict) => verdict === "PASS")) return "PASS";
  if (verdicts.length && verdicts.every((verdict) => verdict === "BAD")) return "BAD";
  return "REVIEW";
}

export function evaluate(manifest, layouts, localOcrMode) {
  const byCase = new Map(manifest.cases.map((item) => [item.case_id, []]));
  for (const layout of layouts) {
    for (const result of layout.case_results) byCase.get(result.case_id).push({ layout: layout.name, verdict: result.verdict });
  }
  const cases = manifest.cases.map((item) => {
    const runs = byCase.get(item.case_id);
    const verdicts = runs.map((run) => run.verdict);
    const aggregate = aggregateVerdicts(verdicts);
    const truth = item.ground_truth?.verdict ?? null;
    return {
      case_id: item.case_id,
      sku: item.sku,
      truth,
      runs,
      aggregate,
      stable: new Set(verdicts).size === 1,
      false_pass_any_run: truth === "BAD" && verdicts.includes("PASS"),
      false_bad_any_run: truth === "PASS" && verdicts.includes("BAD"),
    };
  });
  const calls = layouts.flatMap((layout) => layout.calls.flatMap((call) => [call.primary, ...call.fallback]));
  const knownPass = cases.filter((item) => item.truth === "PASS");
  const knownPassAutoPassRate = knownPass.length
    ? knownPass.filter((item) => item.aggregate === "PASS").length / knownPass.length
    : 1;
  const correctnessGates = {
    all_planned_layouts_completed: layouts.length === manifest.layouts.length
      && manifest.layouts.every((planned) => layouts.some((actual) => actual.name === planned.name)),
    zero_false_pass: cases.every((item) => !item.false_pass_any_run),
    zero_false_bad: cases.every((item) => !item.false_bad_any_run),
    zero_technical_errors: cases.every((item) => !item.runs.some((run) => run.verdict === "TECHNICAL_ERROR")),
    all_known_bad_detected_every_layout: cases.filter((item) => item.truth === "BAD").every((item) => item.aggregate === "BAD"),
    all_known_pass_avoid_bad: knownPass.every((item) => item.aggregate !== "BAD"),
    known_pass_auto_pass_rate_at_least_80pct: knownPassAutoPassRate >= 0.8,
    verdict_stability_100pct: cases.every((item) => item.stable),
    schema_valid_first_attempt_100pct: layouts.flatMap((layout) => layout.calls).every((call) => call.primary.schema_valid),
    schema_valid_after_fallback_100pct: layouts.flatMap((layout) => layout.calls).every((call) => !!call.observations),
    worker_contract_attested_100pct: calls.every((call) => call.worker_contract_attested === true),
    required_local_ocr_completed_100pct: localOcrMode === "required"
      && layouts.flatMap((layout) => layout.case_results).every(
        (result) => result.local_visual_evidence?.local_ocr?.mode === "required",
      ),
    no_paid_fallback: true,
    no_remote_writes: true,
  };
  const algorithmGo = Object.values(correctnessGates).every(Boolean);
  const readinessGates = {
    algorithm_golden_passed: algorithmGo,
    worker_image_count_attested_100pct: calls.every((call) => call.image_count_attested),
    worker_contract_attested_100pct: calls.every((call) => call.worker_contract_attested === true),
    buyer_facing_snapshot_validated: false,
    shadow_main_50_completed: false,
    gallery_golden_and_pilot_completed: false,
  };
  return {
    cases,
    known_pass_auto_pass_rate: knownPassAutoPassRate,
    correctness_gates: correctnessGates,
    algorithm_go: algorithmGo,
    mass_run_readiness_gates: readinessGates,
    mass_run_go: Object.values(readinessGates).every(Boolean),
  };
}

function ensureWorkspaceFile(file, label) {
  const resolved = path.resolve(ROOT, file);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function ensureUnderDirectory(directory, file, label) {
  if (typeof file !== "string" || !file.trim() || path.isAbsolute(file)) {
    throw new Error(`${label} must be a relative file`);
  }
  const base = path.resolve(directory);
  const resolved = path.resolve(base, file);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error(`${label} escapes its snapshot`);
  return ensureWorkspaceFile(resolved, label);
}

async function replayFrozenSources(priors, manifest) {
  const byUrl = new Map();
  for (const { report } of priors) {
    if (typeof report.source_index_file !== "string") continue;
    const indexFile = ensureWorkspaceFile(report.source_index_file, "replay source index");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    const snapshotDir = path.dirname(indexFile);
    for (const [url, record] of Object.entries(index)) {
      if (!byUrl.has(url)) byUrl.set(url, { record, snapshotDir });
    }
  }
  const out = new Map();
  for (const item of manifest.cases) {
    const image = item.images[0];
    const source = byUrl.get(image.url);
    if (!source) throw new Error(`replay has no frozen source for ${item.case_id}`);
    const normalizedPath = ensureUnderDirectory(
      source.snapshotDir,
      source.record.normalized_file,
      `replay normalized source for ${item.case_id}`,
    );
    const rawPath = ensureUnderDirectory(
      source.snapshotDir,
      source.record.raw_file,
      `replay raw source for ${item.case_id}`,
    );
    if (!(await fileExists(normalizedPath)) || !(await fileExists(rawPath))) {
      throw new Error(`replay frozen source is missing for ${item.case_id}`);
    }
    const [normalizedBytes, rawBytes] = await Promise.all([readFile(normalizedPath), readFile(rawPath)]);
    if (sha256(normalizedBytes) !== source.record.normalized_sha256
      || sha256(rawBytes) !== source.record.raw_sha256) {
      throw new Error(`replay frozen source hash mismatch for ${item.case_id}`);
    }
    out.set(item.case_id, {
      frozen: { ...source.record, normalized_path: normalizedPath, raw_path: rawPath },
      snapshotDir: source.snapshotDir,
    });
  }
  return out;
}

function executionEvidenceAttestation(attestation, localOcrMode, replay = false) {
  return {
    runner_source_sha256: attestation.runner_source_sha256,
    comparator_version: attestation.comparator_version,
    comparator_source_sha256: attestation.comparator_source_sha256,
    preprocessor_schema: attestation.preprocessor_schema,
    preprocessor_version: attestation.preprocessor_version,
    preprocessor_source_sha256: attestation.preprocessor_source_sha256,
    local_ocr_mode: localOcrMode,
    local_ocr_schema: attestation.local_ocr_schema,
    local_ocr_engine: attestation.local_ocr_engine,
    local_ocr_script_sha256: attestation.local_ocr_script_sha256,
    local_ocr_runtime: attestation.local_ocr_runtime,
    model_attachment_roles: [replay ? "historical_report_observation" : "preprocessed_full"],
    preprocessed_full_sent_to_model: !replay,
    detail_crops_sent_to_model: false,
  };
}

async function replayPriorReports({
  priorPaths, manifest, manifestPath, manifestSha, localOcrMode, attestation,
}) {
  const priors = await Promise.all(priorPaths.map(async (priorPath) => ({
    priorPath,
    report: JSON.parse(await readFile(priorPath, "utf8")),
  })));
  for (const { report } of priors) {
    if (report?.schema_version !== "walmart-visual-pilot-report/v1" || !Array.isArray(report.layouts)) {
      throw new Error("--replay input is not a v1 pilot report");
    }
    if (report.execution?.observation_schema !== BLIND_OBSERVATION_SCHEMA) {
      throw new Error(`replay observation schema ${report.execution?.observation_schema || "missing"} != ${BLIND_OBSERVATION_SCHEMA}`);
    }
  }
  const frozenSources = await replayFrozenSources(priors, manifest);
  const evidenceByCase = new Map();
  for (const item of manifest.cases) {
    const source = frozenSources.get(item.case_id);
    const evidence = await prepareLocalVisualEvidence({
      frozen: source.frozen,
      snapshotDir: source.snapshotDir,
      localOcrMode,
      attestation,
    });
    evidenceByCase.set(item.case_id, evidence);
  }
  const prior = priors[0].report;
  const currentByCase = new Map(manifest.cases.map((item) => [item.case_id, item]));
  const layoutNames = new Set();
  const sourceLayouts = priors.flatMap(({ report }) => report.layouts).filter((layout) => {
    if (layoutNames.has(layout.name)) throw new Error(`duplicate replay layout ${layout.name}`);
    layoutNames.add(layout.name);
    return true;
  });
  const layouts = sourceLayouts.map((layout) => ({
    ...layout,
    case_results: layout.case_results.map((result) => {
      const current = currentByCase.get(result.case_id);
      if (!current || current.sku !== result.sku) throw new Error(`replay case mismatch: ${result.case_id}`);
      const localVisualEvidence = evidenceByCase.get(result.case_id);
      if (!result.observation) {
        return {
          ...result,
          verdict: "TECHNICAL_ERROR",
          technical_error: "prior observation unavailable",
          local_visual_evidence: localVisualEvidence,
        };
      }
      const [observation] = parseBlindResponse({
        schema_version: BLIND_OBSERVATION_SCHEMA,
        observations: [result.observation],
      }, [result.observation.image_id]);
      const decision = decideWithLocalEvidence(current, current.images[0], observation, localVisualEvidence);
      const fullView = localVisualEvidence.preprocessor.views.find((view) => view.role === "full");
      return {
        ...result,
        verdict: decision.verdict,
        decision,
        observation,
        replay_preprocessed_full_sha256: fullView?.sha256 ?? null,
        local_visual_evidence: localVisualEvidence,
      };
    }),
  }));
  const evaluation = evaluate(manifest, layouts, localOcrMode);
  const replay = {
    ...prior,
    report_id: `${manifest.manifest_id}-replay-${safeStamp()}`,
    created_at: new Date().toISOString(),
    replayed_from: priorPaths.map((priorPath) => path.relative(ROOT, priorPath)),
    execution: {
      ...prior.execution,
      ...executionEvidenceAttestation(attestation, localOcrMode, true),
      provider_mode: "zero-model-call-replay",
      subscription_call_budget: 0,
      subscription_calls_used: 0,
      replay_model_calls: 0,
    },
    manifest: {
      path: path.relative(ROOT, manifestPath),
      id: manifest.manifest_id,
      sha256: manifestSha,
      cases: manifest.cases.length,
      buyer_facing_verified: manifest.cases.filter((item) => item.images[0].buyer_facing_verified).length,
      artifact_only: manifest.cases.filter((item) => !item.images[0].buyer_facing_verified).length,
    },
    layouts,
    evaluation,
  };
  const replayDir = path.join(ROOT, "data/audits/walmart-visual-pilot-replays");
  await mkdir(replayDir, { recursive: true });
  const replayFile = path.join(replayDir, `${manifest.manifest_id}-${safeStamp()}.json`);
  await atomicJson(replayFile, replay);
  console.log(`replay used 0 vision calls from ${priorPaths.length} report(s)`);
  console.log(`algorithm golden gate: ${evaluation.algorithm_go ? "GO" : "NO-GO"}`);
  console.log(`report: ${path.relative(ROOT, replayFile)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const attestation = await buildArtifactAttestation();
  if ((args.run || args.freezeOnly || args.replays.length) && args.localOcr === "required") {
    await assertLocalOcrAvailable();
  }
  const manifestPath = args.manifest;
  const manifestBytes = await readFile(manifestPath);
  const manifestSha = sha256(manifestBytes);
  const manifest = validateAuditManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.cases.length > MAX_PILOT_CASES) {
    throw new Error(`pilot refuses ${manifest.cases.length} cases; maximum is ${MAX_PILOT_CASES}`);
  }
  let layouts = args.layout ? manifest.layouts.filter((layout) => layout.name === args.layout) : manifest.layouts;
  if (!layouts.length) throw new Error(`layout not found: ${args.layout}`);
  for (const item of manifest.cases) {
    if (item.images.length !== 1 || item.images[0].slot !== "main") {
      throw new Error("v1 golden runner accepts exactly one MAIN image per case; gallery gets a separate pilot");
    }
  }
  const plannedCalls = layouts.reduce((sum, layout) => sum + Math.ceil(manifest.cases.length / layout.batch_size), 0);
  if (args.run && args.callBudget !== null && plannedCalls > args.callBudget) {
    throw new Error(`planned ${plannedCalls} primary calls exceeds explicit call budget ${args.callBudget}`);
  }
  const buyerFacing = manifest.cases.filter((item) => item.images[0].buyer_facing_verified).length;
  console.log(`manifest: ${manifest.manifest_id}`);
  console.log(`cases: ${manifest.cases.length} (${buyerFacing} buyer-facing verified, ${manifest.cases.length - buyerFacing} artifacts)`);
  console.log(`layouts: ${layouts.map((layout) => `${layout.name}:${layout.batch_size}`).join(", ")}`);
  console.log(args.replays.length
    ? "planned subscription calls: 0 (zero-model replay)"
    : `planned subscription calls: ${plannedCalls} (no undeclared fallback calls)`);
  console.log("remote writes: 0 · DB access: 0 · paid fallback: forbidden");
  if (args.replays.length) {
    await replayPriorReports({
      priorPaths: args.replays,
      manifest,
      manifestPath,
      manifestSha,
      localOcrMode: args.localOcr,
      attestation,
    });
    return;
  }
  if (!args.run && !args.freezeOnly) {
    console.log("validation-only complete; add --freeze-only to hash images or --run to execute the small pilot");
    return;
  }

  const workerContract = args.run ? await fetchWorkerContract(args.provider) : null;
  if (workerContract) {
    console.log(`worker contract: ${workerContract.vision_provider} ${workerContract.worker_build.slice(0, 19)}`);
  }
  const promptBaseSha = sha256(buildBlindObservationPrompt(["i_template"]));
  const runKey = workerContract
    ? `${manifest.manifest_id}-${manifestSha.slice(0, 12)}-${promptBaseSha.slice(0, 12)}-${sha256(VISUAL_PREPROCESS_VERSION).slice(0, 8)}-${workerContract.worker_build.slice(7, 19)}-${args.provider}`
    : `${manifest.manifest_id}-${manifestSha.slice(0, 12)}-${sha256(VISUAL_PREPROCESS_VERSION).slice(0, 8)}-freeze-only`;
  const sourceFingerprint = sha256(JSON.stringify(manifest.cases.map((item) => ({
    case_id: item.case_id,
    images: item.images.map((image) => ({ slot: image.slot, url: image.url, surface: image.surface })),
  }))));
  const snapshotKey = `walmart-main-${sourceFingerprint.slice(0, 20)}`;
  const runDir = path.join(ROOT, "data/audits/walmart-visual-pilot-runs", runKey);
  const snapshotDir = path.join(ROOT, "data/audits/walmart-visual-pilot-snapshots", snapshotKey);
  const dirs = {
    runDir: snapshotDir,
    raw: path.join(snapshotDir, "raw"),
    normalized: path.join(snapshotDir, "normalized"),
  };
  await Promise.all([
    mkdir(runDir, { recursive: true }),
    mkdir(dirs.raw, { recursive: true }),
    mkdir(dirs.normalized, { recursive: true }),
  ]);
  const sourceIndexFile = path.join(snapshotDir, "source-index.json");
  const stateFile = path.join(runDir, "checkpoint.json");
  if (args.expectConsumed !== null) {
    const expectedState = await readJsonIfPresent(stateFile, null);
    if (!expectedState) {
      throw new Error(`resume guard: checkpoint does not exist for run ${runKey}`);
    }
    const completedAttempts = Object.values(expectedState.calls || {}).reduce(
      (sum, call) => sum + (Array.isArray(call?.transport_attempts) ? call.transport_attempts.length : 0),
      0,
    );
    if (expectedState.manifest_sha256 !== manifestSha
      || expectedState.provider !== args.provider
      || expectedState.worker_build !== workerContract.worker_build
      || expectedState.preprocessor_version !== VISUAL_PREPROCESS_VERSION) {
      throw new Error("resume guard: checkpoint fingerprint mismatch");
    }
    if (expectedState.subscription_calls_consumed !== args.expectConsumed
      || completedAttempts !== args.expectConsumed) {
      throw new Error(
        `resume guard: expected ${args.expectConsumed} consumed/completed calls, found ${expectedState.subscription_calls_consumed ?? "missing"}/${completedAttempts}`,
      );
    }
    console.log(`resume guard: exact checkpoint confirmed at ${args.expectConsumed} consumed calls`);
  }
  const priorIndex = await readJsonIfPresent(sourceIndexFile, {});
  const sourceIndex = {};
  const frozenByCase = new Map();
  const evidenceByCase = new Map();
  for (let index = 0; index < manifest.cases.length; index++) {
    const item = manifest.cases[index];
    const frozen = await freezeImage(item.images[0], dirs, priorIndex);
    const localVisualEvidence = await prepareLocalVisualEvidence({
      frozen,
      snapshotDir,
      localOcrMode: args.localOcr,
      attestation,
    });
    sourceIndex[item.images[0].url] = {
      ...Object.fromEntries(Object.entries(frozen).filter(([key]) => !key.endsWith("_path") && key !== "visual_evidence")),
      visual_evidence: localVisualEvidence,
    };
    frozenByCase.set(item.case_id, frozen);
    evidenceByCase.set(item.case_id, localVisualEvidence);
    const ocrStatus = localVisualEvidence.local_ocr.mode === "off"
      ? "ocr-off"
      : localVisualEvidence.local_ocr.reused ? "ocr-reused" : "ocr-local";
    console.log(`snapshot ${index + 1}/${manifest.cases.length}: ${item.case_id} ${frozen.reused_frozen_bytes ? "reused" : "downloaded"} ${frozen.raw_sha256.slice(0, 12)} ${ocrStatus}`);
  }
  await atomicJson(sourceIndexFile, sourceIndex);
  if (args.freezeOnly) {
    console.log(`freeze-only complete: ${manifest.cases.length} immutable image snapshots, 0 vision calls`);
    console.log(`source index: ${path.relative(ROOT, sourceIndexFile)}`);
    return;
  }
  if (!workerContract) throw new Error("worker contract unavailable");
  const state = await readJsonIfPresent(stateFile, {
    schema_version: "walmart-visual-pilot-checkpoint/v1",
    manifest_sha256: manifestSha,
    provider: args.provider,
    worker_build: workerContract.worker_build,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    subscription_calls_consumed: 0,
    calls: {},
  });
  if (state.manifest_sha256 !== manifestSha
    || state.provider !== args.provider
    || state.worker_build !== workerContract.worker_build
    || state.preprocessor_version !== VISUAL_PREPROCESS_VERSION) {
    throw new Error("checkpoint fingerprint mismatch; use a new manifest id/version");
  }
  const derivedConsumedCalls = Object.values(state.calls || {}).reduce(
    (sum, call) => sum + (Array.isArray(call?.transport_attempts) ? call.transport_attempts.length : 0),
    0,
  );
  if (!Number.isInteger(state.subscription_calls_consumed)
    || state.subscription_calls_consumed < derivedConsumedCalls) {
    state.subscription_calls_consumed = derivedConsumedCalls;
    await atomicJson(stateFile, state);
  }
  const callBudget = {
    max: args.callBudget ?? Number.POSITIVE_INFINITY,
    used: state.subscription_calls_consumed,
  };
  if (callBudget.used > callBudget.max) {
    throw new Error(`checkpoint already consumed ${callBudget.used} calls, above budget ${callBudget.max}`);
  }

  const layoutResults = [];
  let stoppedEarlyReason = null;
  for (const layout of layouts) {
    const ordered = layout.shuffle_seed === null
      ? [...manifest.cases]
      : shuffledWithSeed(manifest.cases, layout.shuffle_seed);
    const batches = chunks(ordered, layout.batch_size);
    const layoutResult = { name: layout.name, batch_size: layout.batch_size, shuffle_seed: layout.shuffle_seed, calls: [], case_results: [] };
    console.log(`layout ${layout.name}: ${batches.length} call(s)`);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchCases = batches[batchIndex];
      const items = batchCases.map((item) => ({
        case: item,
        image: item.images[0],
        frozen: frozenByCase.get(item.case_id),
        localVisualEvidence: evidenceByCase.get(item.case_id),
        modelAttachment: modelAttachmentFromEvidence(evidenceByCase.get(item.case_id), snapshotDir),
      }));
      if (items.length > MAX_IMAGES_PER_CALL) throw new Error(`batch has ${items.length} images; max ${MAX_IMAGES_PER_CALL}`);
      const call = await runBatchWithSchemaFallback({
        provider: args.provider,
        layoutName: layout.name,
        batchIndex,
        items,
        state,
        stateFile,
        workerContract,
        callBudget,
      });
      layoutResult.calls.push(call);
      if (!call.observations) {
        for (const item of items) {
          layoutResult.case_results.push({
            case_id: item.case.case_id,
            sku: item.case.sku,
            verdict: "TECHNICAL_ERROR",
            technical_error: call.primary.schema_error || "vision transport unavailable",
            raw_sha256: item.frozen.raw_sha256,
            normalized_sha256: item.frozen.normalized_sha256,
            model_full_sha256: item.modelAttachment.sha256,
            local_visual_evidence: item.localVisualEvidence,
          });
        }
        stoppedEarlyReason = `technical/schema failure in ${layout.name} batch ${batchIndex + 1}`;
      } else {
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const observation = call.observations[index];
          const decision = decideWithLocalEvidence(item.case, item.image, observation, item.localVisualEvidence);
          layoutResult.case_results.push({
            case_id: item.case.case_id,
            sku: item.case.sku,
            verdict: decision.verdict,
            decision,
            observation,
            raw_sha256: item.frozen.raw_sha256,
            normalized_sha256: item.frozen.normalized_sha256,
            model_full_sha256: item.modelAttachment.sha256,
            local_visual_evidence: item.localVisualEvidence,
          });
          console.log(`  ${layout.name} ${item.case.case_id}: ${decision.verdict}`);
          const truth = item.case.ground_truth?.verdict;
          if (truth === "BAD" && decision.verdict !== "BAD" && !stoppedEarlyReason) {
            stoppedEarlyReason = `${item.case.case_id}: known BAD returned ${decision.verdict}`;
          }
          if (truth === "PASS" && decision.verdict === "BAD" && !stoppedEarlyReason) {
            stoppedEarlyReason = `${item.case.case_id}: known PASS returned BAD`;
          }
        }
        if (!call.primary.schema_valid && !stoppedEarlyReason) {
          stoppedEarlyReason = `first-attempt schema failure in ${layout.name} batch ${batchIndex + 1}`;
        }
      }
      if (stoppedEarlyReason) break;
    }
    layoutResults.push(layoutResult);
    if (stoppedEarlyReason) break;
  }

  const evaluation = evaluate(manifest, layoutResults, args.localOcr);
  const report = {
    schema_version: "walmart-visual-pilot-report/v1",
    report_id: `${runKey}-${safeStamp()}`,
    created_at: new Date().toISOString(),
    manifest: {
      path: path.relative(ROOT, manifestPath),
      id: manifest.manifest_id,
      sha256: manifestSha,
      cases: manifest.cases.length,
      buyer_facing_verified: buyerFacing,
      artifact_only: manifest.cases.length - buyerFacing,
    },
    execution: {
      provider: args.provider,
      provider_mode: "forced-subscription-worker-no-fallback",
      vision_provider_attested: workerContract.vision_provider,
      worker_build_attested: workerContract.worker_build,
      prompt_version: BLIND_PROMPT_VERSION,
      base_prompt_sha256: promptBaseSha,
      observation_schema: BLIND_OBSERVATION_SCHEMA,
      ...executionEvidenceAttestation(attestation, args.localOcr),
      remote_writes: 0,
      database_access: 0,
      paid_api_fallback: false,
      subscription_call_budget: Number.isFinite(callBudget.max) ? callBudget.max : null,
      subscription_calls_used: callBudget.used,
      stopped_early_reason: stoppedEarlyReason,
      frozen_image_normalization: `jpeg-max${NORMALIZED_MAX_PX}-q${NORMALIZED_JPEG_QUALITY}-444-white`,
      model_image_preprocessing: VISUAL_PREPROCESS_VERSION,
    },
    source_index_file: path.relative(ROOT, sourceIndexFile),
    checkpoint_file: path.relative(ROOT, stateFile),
    layouts: layoutResults,
    evaluation,
  };
  const reportFile = path.join(runDir, `report-${safeStamp()}.json`);
  await atomicJson(reportFile, report);
  if (stoppedEarlyReason) console.log(`stopped early: ${stoppedEarlyReason}`);
  console.log(`algorithm golden gate: ${evaluation.algorithm_go ? "GO" : "NO-GO"}`);
  console.log(`mass-run readiness: ${evaluation.mass_run_go ? "GO" : "NO-GO"}`);
  console.log(`report: ${path.relative(ROOT, reportFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`pilot failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
