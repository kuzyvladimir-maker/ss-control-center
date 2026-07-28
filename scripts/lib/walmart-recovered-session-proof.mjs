import { createHash, timingSafeEqual } from "node:crypto";

import sharp from "sharp";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[a-f0-9-]{36}$/;
const DATA_URL_PREFIX = "data:image/jpeg;base64,";
const CANONICAL_PIXEL_SIZE = 256;
const MAX_SESSION_LOG_BYTES = 20 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * A deliberately strict visual link. It is deterministic for the supplied
 * bytes and this Sharp/libvips runtime, but it is not a cryptographic identity:
 * Codex re-encodes the runner's 1800 px JPEG as a lossy 1600 px JPEG.
 */
export const RECOVERED_SESSION_VISUAL_LINK_POLICY = Object.freeze({
  policy_version: "walmart-recovered-session-visual-link/2026-07-18-v1",
  canonical_pixel_size: CANONICAL_PIXEL_SIZE,
  resize_kernel: "lanczos3",
  colourspace: "srgb",
  max_mean_absolute_error: 2,
  max_root_mean_square_error: 4,
  min_pearson_correlation: 0.998,
  max_fraction_absolute_difference_above_8: 0.035,
  max_fraction_absolute_difference_above_16: 0.008,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function byteBuffer(value, label) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new Error(`${label} must be a Buffer or Uint8Array`);
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length === 0) throw new Error(`${label} must not be empty`);
  return bytes;
}

function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  exactObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
  return value;
}

function exactString(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function exactIso(value, label) {
  exactString(value, label);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return time;
}

function sameSha(actual, expected, label) {
  exactSha(expected, label);
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (!timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error(`${label} mismatch`);
  }
}

function validateExpected(expected) {
  const value = exactKeys(expected, [
    "session_log", "session", "prompt", "result", "result_canonical_sha256",
    "embedded_image", "local_full_view",
  ], "expected proof");
  const sessionLog = exactKeys(value.session_log, ["sha256", "byte_length"], "expected session_log");
  exactSha(sessionLog.sha256, "expected session_log.sha256");
  exactPositiveInteger(sessionLog.byte_length, "expected session_log.byte_length");
  if (sessionLog.byte_length > MAX_SESSION_LOG_BYTES) {
    throw new Error("expected session_log.byte_length exceeds the proof limit");
  }

  const session = exactKeys(value.session, [
    "id", "cli_version", "model", "reasoning_effort", "started_at", "completed_at", "duration_ms",
  ], "expected session");
  if (typeof session.id !== "string" || !SESSION_ID_RE.test(session.id)) {
    throw new Error("expected session.id is invalid");
  }
  exactString(session.cli_version, "expected session.cli_version");
  exactString(session.model, "expected session.model");
  exactString(session.reasoning_effort, "expected session.reasoning_effort");
  const started = exactIso(session.started_at, "expected session.started_at");
  const completed = exactIso(session.completed_at, "expected session.completed_at");
  exactPositiveInteger(session.duration_ms, "expected session.duration_ms");
  if (completed <= started || completed - started !== session.duration_ms) {
    throw new Error("expected session timestamps do not exactly match duration_ms");
  }

  const prompt = exactKeys(value.prompt, ["base", "base_sha256", "wrapped"], "expected prompt");
  exactString(prompt.base, "expected prompt.base");
  exactString(prompt.wrapped, "expected prompt.wrapped");
  sameSha(sha256(prompt.base), prompt.base_sha256, "expected prompt.base_sha256");
  if (prompt.wrapped !== buildCodexVisionWrappedPrompt(prompt.base, 1)) {
    throw new Error("expected prompt.wrapped is not the deterministic one-image worker wrapper");
  }

  exactObject(value.result, "expected result");
  sameSha(
    canonicalSha256(value.result),
    value.result_canonical_sha256,
    "expected result_canonical_sha256",
  );

  const embedded = exactKeys(value.embedded_image, [
    "sha256", "byte_length", "width", "height",
  ], "expected embedded_image");
  exactSha(embedded.sha256, "expected embedded_image.sha256");
  exactPositiveInteger(embedded.byte_length, "expected embedded_image.byte_length");
  exactPositiveInteger(embedded.width, "expected embedded_image.width");
  exactPositiveInteger(embedded.height, "expected embedded_image.height");
  if (embedded.byte_length > MAX_EMBEDDED_IMAGE_BYTES) {
    throw new Error("expected embedded_image.byte_length exceeds the proof limit");
  }

  const local = exactKeys(value.local_full_view, [
    "sha256", "byte_length", "width", "height",
  ], "expected local_full_view");
  exactSha(local.sha256, "expected local_full_view.sha256");
  exactPositiveInteger(local.byte_length, "expected local_full_view.byte_length");
  exactPositiveInteger(local.width, "expected local_full_view.width");
  exactPositiveInteger(local.height, "expected local_full_view.height");
  if (local.byte_length > MAX_EMBEDDED_IMAGE_BYTES) {
    throw new Error("expected local_full_view.byte_length exceeds the proof limit");
  }
  return value;
}

/** Replicates the pinned worker's prompt wrapper without I/O. */
export function buildCodexVisionWrappedPrompt(basePrompt, imageCount) {
  const prompt = exactString(basePrompt, "basePrompt");
  exactPositiveInteger(imageCount, "imageCount");
  const names = Array.from({ length: imageCount }, (_, index) => `ref-${index + 1}.png`).join(", ");
  return `${prompt}\n\n`
    + `The image file(s) ${names} are attached to this message — look at them. `
    + "Respond with ONLY a single JSON object (no markdown, no code fences, no prose, no explanation). "
    + "Do NOT generate or create any image. Do NOT ask questions or request confirmation.";
}

function parseJsonl(sessionLogBytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sessionLogBytes);
  } catch (error) {
    throw new Error("session log is not valid UTF-8", { cause: error });
  }
  if (!text.endsWith("\n") || text.startsWith("\uFEFF") || text.includes("\r")) {
    throw new Error("session log must be BOM-free LF-delimited JSONL with one trailing LF");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) {
    throw new Error("session log contains an empty JSONL record");
  }
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`session log line ${index + 1} is invalid JSON`, { cause: error });
    }
    exactKeys(record, ["timestamp", "type", "payload"], `session log line ${index + 1}`);
    exactIso(record.timestamp, `session log line ${index + 1}.timestamp`);
    exactString(record.type, `session log line ${index + 1}.type`);
    exactObject(record.payload, `session log line ${index + 1}.payload`);
    return record;
  });
}

function only(values, label) {
  if (values.length !== 1) throw new Error(`session log must contain exactly one ${label}`);
  return values[0];
}

function event(records, type) {
  return records.filter((record) => record.type === "event_msg" && record.payload.type === type);
}

function responseMessages(records, role) {
  return records.filter((record) => (
    record.type === "response_item"
    && record.payload.type === "message"
    && record.payload.role === role
  ));
}

function decodeStrictJpegDataUrl(imageUrl) {
  if (typeof imageUrl !== "string" || !imageUrl.startsWith(DATA_URL_PREFIX)) {
    throw new Error("the sole input_image must be an inline image/jpeg base64 data URL");
  }
  const encoded = imageUrl.slice(DATA_URL_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("input_image base64 is not canonical");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_EMBEDDED_IMAGE_BYTES
    || bytes.toString("base64") !== encoded) {
    throw new Error("input_image base64 does not round-trip canonically");
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("input_image is not a complete JPEG byte stream");
  }
  return bytes;
}

async function jpegMetadata(bytes, label) {
  let metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
  } catch (error) {
    throw new Error(`${label} cannot be decoded as a strict raster image`, { cause: error });
  }
  if (metadata.format !== "jpeg" || metadata.hasAlpha
    || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
    throw new Error(`${label} must be an opaque JPEG with exact dimensions`);
  }
  return metadata;
}

function assertImageMetadata(bytes, metadata, expected, label) {
  sameSha(sha256(bytes), expected.sha256, `${label}.sha256`);
  if (bytes.length !== expected.byte_length) throw new Error(`${label}.byte_length mismatch`);
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(`${label} dimensions mismatch`);
  }
}

async function canonicalPixels(bytes) {
  const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .resize(CANONICAL_PIXEL_SIZE, CANONICAL_PIXEL_SIZE, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== CANONICAL_PIXEL_SIZE || info.height !== CANONICAL_PIXEL_SIZE
    || info.channels !== 3 || data.length !== CANONICAL_PIXEL_SIZE * CANONICAL_PIXEL_SIZE * 3) {
    throw new Error("canonical image transform did not produce 256x256 sRGB pixels");
  }
  return data;
}

function pixelSimilarity(left, right) {
  let absolute = 0;
  let squared = 0;
  let above8 = 0;
  let above16 = 0;
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < left.length; index++) {
    const difference = Math.abs(left[index] - right[index]);
    absolute += difference;
    squared += difference * difference;
    if (difference > 8) above8 += 1;
    if (difference > 16) above16 += 1;
    leftSum += left[index];
    rightSum += right[index];
  }
  const leftMean = leftSum / left.length;
  const rightMean = rightSum / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return {
    mean_absolute_error: absolute / left.length,
    root_mean_square_error: Math.sqrt(squared / left.length),
    pearson_correlation: denominator === 0 ? (absolute === 0 ? 1 : 0) : covariance / denominator,
    fraction_absolute_difference_above_8: above8 / left.length,
    fraction_absolute_difference_above_16: above16 / left.length,
  };
}

function assertVisualSimilarity(metrics) {
  const policy = RECOVERED_SESSION_VISUAL_LINK_POLICY;
  const failures = [];
  if (metrics.mean_absolute_error > policy.max_mean_absolute_error) failures.push("MAE");
  if (metrics.root_mean_square_error > policy.max_root_mean_square_error) failures.push("RMSE");
  if (metrics.pearson_correlation < policy.min_pearson_correlation) failures.push("correlation");
  if (metrics.fraction_absolute_difference_above_8
    > policy.max_fraction_absolute_difference_above_8) failures.push("difference>8");
  if (metrics.fraction_absolute_difference_above_16
    > policy.max_fraction_absolute_difference_above_16) failures.push("difference>16");
  if (failures.length) {
    throw new Error(`embedded image is not the deterministic visual counterpart of local full-view (${failures.join(", ")})`);
  }
}

/**
 * Validate one interrupted Codex call from caller-supplied bytes only.
 *
 * This function performs no filesystem, network, subprocess, or persistence I/O.
 * The caller must read the immutable JSONL and local full-view JPEG first and
 * supply independently expected hashes/metadata.
 */
export async function validateRecoveredCodexSessionProof({
  sessionLogBytes: rawSessionLogBytes,
  localFullViewJpegBytes: rawLocalFullViewJpegBytes,
  expected: rawExpected,
}) {
  const sessionLogBytes = byteBuffer(rawSessionLogBytes, "sessionLogBytes");
  const localFullViewJpegBytes = byteBuffer(rawLocalFullViewJpegBytes, "localFullViewJpegBytes");
  const expected = validateExpected(rawExpected);
  if (sessionLogBytes.length > MAX_SESSION_LOG_BYTES) throw new Error("session log exceeds the proof limit");
  sameSha(sha256(sessionLogBytes), expected.session_log.sha256, "session_log.sha256");
  if (sessionLogBytes.length !== expected.session_log.byte_length) {
    throw new Error("session_log.byte_length mismatch");
  }

  const records = parseJsonl(sessionLogBytes);
  const allowedRecordTypes = new Set(["session_meta", "event_msg", "response_item", "world_state", "turn_context"]);
  if (records.some((record) => !allowedRecordTypes.has(record.type))) {
    throw new Error("session log contains an unsupported record type");
  }
  const firstTime = Date.parse(records[0].timestamp);
  const lastTime = Date.parse(records.at(-1).timestamp);
  if (records.some((record, index) => (
    index > 0 && Date.parse(record.timestamp) < Date.parse(records[index - 1].timestamp)
  ))) {
    throw new Error("session log timestamps are not monotonic");
  }
  if (records[0].timestamp !== expected.session.started_at
    || records.at(-1).timestamp !== expected.session.completed_at
    || lastTime - firstTime !== expected.session.duration_ms) {
    throw new Error("session log boundary timestamps do not match the expected session");
  }

  const sessionMetaRecord = only(records.filter((record) => record.type === "session_meta"), "session_meta");
  if (sessionMetaRecord !== records[0]) throw new Error("session_meta must be the first JSONL record");
  const sessionMeta = sessionMetaRecord.payload;
  if (sessionMeta.session_id !== expected.session.id || sessionMeta.id !== expected.session.id
    || sessionMeta.cli_version !== expected.session.cli_version
    || sessionMeta.originator !== "codex_exec" || sessionMeta.source !== "exec"
    || sessionMeta.model_provider !== "openai") {
    throw new Error("session_meta identity/CLI/origin does not match the expected Codex exec session");
  }
  const metaTime = exactIso(sessionMeta.timestamp, "session_meta.payload.timestamp");
  if (metaTime > firstTime || firstTime - metaTime > 1_000) {
    throw new Error("session_meta payload timestamp is outside the session boundary");
  }
  exactString(sessionMeta.cwd, "session_meta.cwd");
  if (!/^\/tmp\/codex-vis-[A-Za-z0-9_-]+$/.test(sessionMeta.cwd)) {
    throw new Error("session_meta.cwd is not a staged Codex vision directory");
  }

  const turnContextRecord = only(records.filter((record) => record.type === "turn_context"), "turn_context");
  const turnContext = turnContextRecord.payload;
  if (turnContext.model !== expected.session.model || turnContext.effort !== expected.session.reasoning_effort
    || turnContext.collaboration_mode?.settings?.model !== expected.session.model
    || turnContext.collaboration_mode?.settings?.reasoning_effort !== expected.session.reasoning_effort) {
    throw new Error("turn_context model/reasoning effort does not match the expected contract");
  }
  if (turnContext.cwd !== sessionMeta.cwd
    || turnContext.workspace_roots?.length !== 1
    || turnContext.workspace_roots[0] !== sessionMeta.cwd
    || turnContext.approval_policy !== "never"
    || turnContext.sandbox_policy?.type !== "read-only"
    || turnContext.permission_profile?.type !== "managed"
    || turnContext.permission_profile?.network !== "restricted"
    || turnContext.permission_profile?.file_system?.type !== "restricted"
    || turnContext.permission_profile?.file_system?.entries?.length !== 1
    || turnContext.permission_profile.file_system.entries[0]?.access !== "read"
    || turnContext.permission_profile.file_system.entries[0]?.path?.type !== "special"
    || turnContext.permission_profile.file_system.entries[0]?.path?.value?.kind !== "root"
    || turnContext.network !== undefined) {
    throw new Error("turn_context is not the expected isolated read-only vision session");
  }

  const taskStartedRecord = only(event(records, "task_started"), "task_started event");
  const taskCompleteRecord = only(event(records, "task_complete"), "task_complete event");
  if (taskCompleteRecord !== records.at(-1)) throw new Error("task_complete must be the final JSONL record");
  const turnId = exactString(turnContext.turn_id, "turn_context.turn_id");
  if (taskStartedRecord.payload.turn_id !== turnId || taskCompleteRecord.payload.turn_id !== turnId) {
    throw new Error("task event turn_id does not match turn_context");
  }
  if (taskStartedRecord.payload.started_at !== Math.trunc(firstTime / 1_000)
    || taskCompleteRecord.payload.completed_at !== Math.trunc(lastTime / 1_000)
    || !Number.isInteger(taskCompleteRecord.payload.duration_ms)
    || Math.abs(taskCompleteRecord.payload.duration_ms - expected.session.duration_ms) > 1_000) {
    throw new Error("task event timestamps are inconsistent with the JSONL session boundary");
  }

  const unsupportedResponse = records.find((record) => (
    record.type === "response_item"
    && !["message", "reasoning"].includes(record.payload.type)
  ));
  if (unsupportedResponse) throw new Error("session contains a tool/function response item");

  const allUserMessages = responseMessages(records, "user");
  const allInputImages = allUserMessages.flatMap((record) => (
    Array.isArray(record.payload.content)
      ? record.payload.content.filter((item) => item?.type === "input_image")
      : []
  ));
  const inputImage = only(allInputImages, "user input_image");
  exactKeys(inputImage, ["type", "image_url", "detail"], "input_image");
  if (inputImage.detail !== "high") throw new Error("input_image detail must be high");
  const imageMessageRecord = only(allUserMessages.filter((record) => (
    record.payload.content?.some((item) => item?.type === "input_image")
  )), "user image message");
  const imagePath = `${sessionMeta.cwd}/ref-1.png`;
  const imageContent = imageMessageRecord.payload.content;
  if (!Array.isArray(imageContent) || imageContent.length !== 4) {
    throw new Error("user image message must contain the exact image/prompt wrapper sequence");
  }
  for (const [index, item] of imageContent.entries()) {
    exactKeys(
      item,
      index === 1 ? ["type", "image_url", "detail"] : ["type", "text"],
      `user image message content[${index}]`,
    );
  }
  if (imageContent[0].type !== "input_text"
    || imageContent[0].text !== `<image name=[Image #1] path="${imagePath}">`
    || imageContent[1] !== inputImage
    || imageContent[2].type !== "input_text" || imageContent[2].text !== "</image>"
    || imageContent[3].type !== "input_text" || imageContent[3].text !== expected.prompt.wrapped) {
    throw new Error("user image message does not contain the exact wrapped prompt and staged path");
  }
  if (imageMessageRecord.payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId) {
    throw new Error("user image message turn_id does not match turn_context");
  }
  const userMessageEvent = only(event(records, "user_message"), "user_message event");
  if (userMessageEvent.payload.message !== expected.prompt.wrapped
    || canonicalJson(userMessageEvent.payload.images) !== "[]"
    || canonicalJson(userMessageEvent.payload.local_images) !== canonicalJson([imagePath])
    || canonicalJson(userMessageEvent.payload.text_elements) !== "[]") {
    throw new Error("user_message event does not attest the exact prompt and sole local image");
  }

  const embeddedImageBytes = decodeStrictJpegDataUrl(inputImage.image_url);
  const embeddedMetadata = await jpegMetadata(embeddedImageBytes, "embedded_image");
  assertImageMetadata(embeddedImageBytes, embeddedMetadata, expected.embedded_image, "embedded_image");

  if (localFullViewJpegBytes[0] !== 0xff || localFullViewJpegBytes[1] !== 0xd8) {
    throw new Error("local_full_view is not a JPEG byte stream");
  }
  const localMetadata = await jpegMetadata(localFullViewJpegBytes, "local_full_view");
  assertImageMetadata(localFullViewJpegBytes, localMetadata, expected.local_full_view, "local_full_view");
  if (expected.local_full_view.width !== 1_800 || expected.local_full_view.height !== 1_800
    || expected.embedded_image.width !== 1_600 || expected.embedded_image.height !== 1_600) {
    throw new Error("proof must bind the observed Codex 1800-to-1600 image transform");
  }

  const assistantMessageRecord = only(responseMessages(records, "assistant"), "assistant message");
  if (assistantMessageRecord.payload.phase !== "final_answer"
    || !Array.isArray(assistantMessageRecord.payload.content)
    || assistantMessageRecord.payload.content.length !== 1) {
    throw new Error("assistant message must be one final_answer output_text");
  }
  const output = assistantMessageRecord.payload.content[0];
  exactKeys(output, ["type", "text"], "assistant output");
  const expectedResultText = JSON.stringify(expected.result);
  if (output.type !== "output_text" || output.text !== expectedResultText) {
    throw new Error("assistant final JSON text does not exactly match the expected result");
  }
  let parsedResult;
  try {
    parsedResult = JSON.parse(output.text);
  } catch (error) {
    throw new Error("assistant final output is not JSON", { cause: error });
  }
  sameSha(
    canonicalSha256(parsedResult),
    expected.result_canonical_sha256,
    "assistant result_canonical_sha256",
  );
  if (assistantMessageRecord.payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId) {
    throw new Error("assistant final message turn_id does not match turn_context");
  }
  const agentMessageEvent = only(event(records, "agent_message"), "agent_message event");
  if (agentMessageEvent.payload.phase !== "final_answer"
    || agentMessageEvent.payload.message !== expectedResultText
    || taskCompleteRecord.payload.last_agent_message !== expectedResultText
    || agentMessageEvent.timestamp !== assistantMessageRecord.timestamp) {
    throw new Error("final result is not identical across assistant/task completion records");
  }

  const [localPixels, embeddedPixels] = await Promise.all([
    canonicalPixels(localFullViewJpegBytes),
    canonicalPixels(embeddedImageBytes),
  ]);
  const similarity = pixelSimilarity(localPixels, embeddedPixels);
  assertVisualSimilarity(similarity);

  return Object.freeze({
    valid: true,
    proof_kind: "raw_codex_session_recovery",
    session: Object.freeze({
      id: expected.session.id,
      sha256: expected.session_log.sha256,
      byte_length: sessionLogBytes.length,
      cli_version: expected.session.cli_version,
      model: expected.session.model,
      reasoning_effort: expected.session.reasoning_effort,
      started_at: expected.session.started_at,
      completed_at: expected.session.completed_at,
      duration_ms: expected.session.duration_ms,
      cryptographic_binding: true,
    }),
    prompt: Object.freeze({
      base_sha256: expected.prompt.base_sha256,
      exact_wrapped_prompt: true,
    }),
    result: Object.freeze({
      canonical_sha256: expected.result_canonical_sha256,
      exact_final_json: true,
    }),
    embedded_image: Object.freeze({
      sha256: expected.embedded_image.sha256,
      byte_length: embeddedImageBytes.length,
      width: embeddedMetadata.width,
      height: embeddedMetadata.height,
      cryptographically_contained_in_session_log: true,
    }),
    local_full_view: Object.freeze({
      sha256: expected.local_full_view.sha256,
      byte_length: localFullViewJpegBytes.length,
      width: localMetadata.width,
      height: localMetadata.height,
      cryptographic_binding: true,
    }),
    image_link: Object.freeze({
      kind: "deterministic_canonical_pixel_similarity",
      deterministic: true,
      cryptographic: false,
      byte_identical: false,
      reason: "Codex CLI performed a lossy 1800x1800 to 1600x1600 JPEG transform",
      policy: RECOVERED_SESSION_VISUAL_LINK_POLICY,
      sharp_version: sharp.versions.sharp,
      libvips_version: sharp.versions.vips,
      metrics: Object.freeze(similarity),
    }),
  });
}
