/**
 * Offline verifier for the bounded FaisalX-1183 shadow visual calls.
 *
 * It accepts no credentials and performs no network/database/marketplace I/O.
 * Exact request bytes, signed worker receipts, model result bytes, worker
 * identity and deterministic Product Truth comparisons are rebuilt before an
 * immutable evidence artifact is written.
 */

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  WALMART_VISUAL_COMPARATOR_VERSION,
  buildBlindObservationPrompt,
  decideBlind,
  parseBlindResponse,
  type AuditCase,
  type AuditImageInput,
  type BlindObservation,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  type WalmartListingObservationImageBinding,
  type WalmartListingObservationWorkerContract,
} from "../src/lib/walmart/listing-integrity-observation.ts";

type JsonRecord = Record<string, unknown>;

interface VisionContractModule {
  canonicalJson(value: unknown): string;
  verifyVisionWorkerReceipt(value: unknown): JsonRecord;
}

interface ShadowPlanCall extends JsonRecord {
  call_index: number;
  shard_id: string;
  call_key: string;
  prompt_sha256: string;
  request_path: string;
  request_file_sha256: string;
  image_bindings: WalmartListingObservationImageBinding[];
}

interface VerifiedCall {
  call_index: number;
  shard_id: string;
  call_key: string;
  raw_response_sha256: string;
  worker_receipt: JsonRecord;
  observations: BlindObservation[];
  decisions: Array<{
    image_id: string;
    slot: string;
    asset_sha256: string;
    surface: "buyer_pdp" | "last_applied_artifact";
    verdict: "PASS" | "BAD" | "REVIEW";
    checks: JsonRecord;
    hard_failures: string[];
    unknowns: string[];
  }>;
}

const require = createRequire(import.meta.url);
const visionContract = require("../ops/codex-image-worker/vision-contract.js") as VisionContractModule;

const HELP = `Usage:
  node --import tsx scripts/verify-walmart-listing-integrity-shadow-vision.ts \\
    --plan=/absolute/plan.json \\
    --current-response=/absolute/call-1-response.json \\
    --target-response=/absolute/call-2-response.json \\
    --output=/absolute/new/attestation.json

Offline only: 0 network, 0 model calls, 0 Walmart/database writes.
`;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing or extra fields`);
  }
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded exact string`);
  }
  return value;
}

function multilineText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded exact multiline string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`${label} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactEqual(left: unknown, right: unknown): boolean {
  return visionContract.canonicalJson(left) === visionContract.canonicalJson(right);
}

async function readJson(pathname: string, label: string, maximum: number) {
  const bytes = await readFile(pathname);
  if (bytes.byteLength < 2 || bytes.byteLength > maximum) {
    throw new Error(`${label} byte size is invalid`);
  }
  const value = record(JSON.parse(bytes.toString("utf8")), label);
  return { bytes, value, sha256: sha256(bytes) };
}

function parseArgs(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--help") return null;
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error(`invalid/duplicate argument ${arg}`);
    values.set(match[1]!, match[2]!);
  }
  const expected = ["plan", "current-response", "target-response", "output"];
  if (values.size !== expected.length || expected.some((name) => !values.has(name))) {
    throw new Error(`arguments must be exactly ${expected.map((name) => `--${name}`).join(", ")}`);
  }
  const resolved = Object.fromEntries(expected.map((name) => [name, path.resolve(values.get(name)!)]));
  if (resolved.output === resolved.plan
    || resolved.output === resolved["current-response"]
    || resolved.output === resolved["target-response"]) {
    throw new Error("output must be a new distinct path");
  }
  return resolved;
}

function parseWorkerContract(value: unknown): WalmartListingObservationWorkerContract {
  const raw = record(value, "plan.worker_contract");
  exactKeys(raw, [
    "worker_build", "model", "reasoning_effort", "cli_version", "node_version",
    "runtime_platform", "runtime_arch", "vision_timeout_ms", "reservation_ledger",
  ], "plan.worker_contract");
  if (!/^sha256:[a-f0-9]{64}$/u.test(text(raw.worker_build, "worker_build"))
    || raw.model !== "sonnet" || raw.reasoning_effort !== null) {
    throw new Error("plan worker model/build is invalid");
  }
  return raw as unknown as WalmartListingObservationWorkerContract;
}

function parseBinding(value: unknown, label: string): WalmartListingObservationImageBinding {
  const raw = record(value, label);
  exactKeys(raw, [
    "listing_key", "item_id", "slot", "asset_sha256", "model_view_sha256", "image_id",
  ], label);
  const slot = text(raw.slot, `${label}.slot`) as WalmartListingObservationImageBinding["slot"];
  const binding = {
    listing_key: text(raw.listing_key, `${label}.listing_key`),
    item_id: text(raw.item_id, `${label}.item_id`),
    slot,
    asset_sha256: digest(raw.asset_sha256, `${label}.asset_sha256`),
    model_view_sha256: digest(raw.model_view_sha256, `${label}.model_view_sha256`),
    image_id: text(raw.image_id, `${label}.image_id`),
  };
  if (binding.image_id !== walmartListingObservationImageId(
    binding.asset_sha256,
    binding.slot,
    binding.listing_key,
  )) throw new Error(`${label}.image_id does not rebuild`);
  return binding;
}

function parsePlanCall(value: unknown, index: number): ShadowPlanCall {
  const label = `plan.calls[${index}]`;
  const raw = record(value, label);
  exactKeys(raw, [
    "call_index", "shard_id", "call_key", "prompt_sha256", "request_path",
    "request_file_sha256", "image_bindings",
  ], label);
  if (!Array.isArray(raw.image_bindings) || raw.image_bindings.length < 1
    || raw.image_bindings.length > 4) throw new Error(`${label}.image_bindings is invalid`);
  return {
    call_index: integer(raw.call_index, `${label}.call_index`),
    shard_id: text(raw.shard_id, `${label}.shard_id`),
    call_key: digest(raw.call_key, `${label}.call_key`),
    prompt_sha256: digest(raw.prompt_sha256, `${label}.prompt_sha256`),
    request_path: path.resolve(text(raw.request_path, `${label}.request_path`)),
    request_file_sha256: digest(raw.request_file_sha256, `${label}.request_file_sha256`),
    image_bindings: raw.image_bindings.map((binding, bindingIndex) => (
      parseBinding(binding, `${label}.image_bindings[${bindingIndex}]`)
    )),
  };
}

const EXPECTED_TRUTH: AuditCase["expected"] = {
  title: "Pepperidge Farm Butter Hot Dog Buns, Top Sliced, 8-Ct Bag (Pack of 6)",
  outer_units: 6,
  identity: {
    brand_aliases: ["pepperidge farm"],
    product_marker_groups: [["hot dog buns", "hot dog bun"]],
    variant_marker_groups: [["butter"], ["top sliced"]],
    forbidden_markers: [
      { role: "product", aliases: ["cookies", "cookie", "hamburger buns"] },
    ],
  },
  package_facts: [
    { kind: "inner_item_count", value: 8, unit: "count", requirement: "required" },
    { kind: "net_content", value: 14, unit: "oz", requirement: "if_visible" },
  ],
  truth_source: "manual_verified",
};

async function verifyCall(input: {
  planCall: ShadowPlanCall;
  responsePath: string;
  workerContract: WalmartListingObservationWorkerContract;
  runLockSha256: string;
  partitionId: string;
  authorizationSha256: string;
  authorizationIssuedAt: string;
  authorizationExpiresAt: string;
  targetCall: boolean;
}): Promise<VerifiedCall> {
  const requestArtifact = await readJson(input.planCall.request_path, "exact request", 32_000_000);
  if (requestArtifact.sha256 !== input.planCall.request_file_sha256) {
    throw new Error(`call ${input.planCall.call_index} request bytes changed`);
  }
  const request = requestArtifact.value;
  exactKeys(request, ["prompt", "images", "request_attestation"], "exact request");
  const prompt = multilineText(request.prompt, "request.prompt", 200_000);
  const imageIds = input.planCall.image_bindings.map((binding) => binding.image_id);
  if (prompt !== buildBlindObservationPrompt(imageIds)
    || input.planCall.prompt_sha256 !== walmartListingObservationPromptSha256(imageIds)) {
    throw new Error(`call ${input.planCall.call_index} prompt does not rebuild`);
  }
  if (!Array.isArray(request.images) || request.images.length !== input.planCall.image_bindings.length) {
    throw new Error(`call ${input.planCall.call_index} request image count mismatch`);
  }
  const requestImageShas = request.images.map((value, index) => {
    const encoded = text(value, `request.images[${index}]`, 12_000_000);
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.byteLength || bytes.toString("base64") !== encoded) {
      throw new Error(`request.images[${index}] is not canonical base64`);
    }
    return sha256(bytes);
  });
  if (!exactEqual(
    requestImageShas,
    input.planCall.image_bindings.map((binding) => binding.model_view_sha256),
  )) throw new Error(`call ${input.planCall.call_index} image bytes differ from bindings`);
  const expectedCallKey = walmartListingObservationCallKey({
    run_lock_sha256: input.runLockSha256,
    shard_id: input.planCall.shard_id,
    call_index: input.planCall.call_index,
    worker_contract: input.workerContract,
    prompt_sha256: input.planCall.prompt_sha256,
    image_bindings: input.planCall.image_bindings,
  });
  if (expectedCallKey !== input.planCall.call_key) throw new Error("call_key does not rebuild");
  const expectedRequestAttestation = {
    schema_version: "vision-request-attestation/v2",
    run_lock_sha256: input.runLockSha256,
    shard_id: input.planCall.shard_id,
    call_index: input.planCall.call_index,
    call_key: input.planCall.call_key,
    prompt_sha256: input.planCall.prompt_sha256,
    execution_permit_sha256: input.authorizationSha256,
    partition_id: input.partitionId,
    image_sha256: requestImageShas,
  };
  if (!exactEqual(request.request_attestation, expectedRequestAttestation)) {
    throw new Error(`call ${input.planCall.call_index} request attestation mismatch`);
  }

  const responseArtifact = await readJson(input.responsePath, "worker response", 2_000_000);
  const response = responseArtifact.value;
  exactKeys(response, [
    "ok", "result", "input_image_count", "vision_provider", "vision_model",
    "vision_reasoning_effort", "cli_version", "node_version", "runtime_platform",
    "runtime_arch", "worker_build", "reservation_ledger", "vision_timeout_ms",
    "request_attestation_verified", "worker_receipt",
  ], "worker response");
  if (response.ok !== true || response.request_attestation_verified !== true
    || response.vision_provider !== "claude_cli_subscription"
    || response.vision_model !== input.workerContract.model
    || response.vision_reasoning_effort !== input.workerContract.reasoning_effort
    || response.cli_version !== input.workerContract.cli_version
    || response.node_version !== input.workerContract.node_version
    || response.runtime_platform !== input.workerContract.runtime_platform
    || response.runtime_arch !== input.workerContract.runtime_arch
    || response.worker_build !== input.workerContract.worker_build
    || response.vision_timeout_ms !== input.workerContract.vision_timeout_ms
    || response.input_image_count !== requestImageShas.length
    || !exactEqual(response.reservation_ledger, input.workerContract.reservation_ledger)) {
    throw new Error(`call ${input.planCall.call_index} worker contract mismatch`);
  }
  const receipt = visionContract.verifyVisionWorkerReceipt(response.worker_receipt);
  const receiptBody = record(receipt.body, "worker receipt body");
  const receiptContract = record(receiptBody.worker_contract, "worker receipt contract");
  const subscription = record(receiptBody.subscription_policy, "worker receipt subscription policy");
  if (!exactEqual(receiptBody.request_attestation, expectedRequestAttestation)
    || digest(receiptBody.result_canonical_sha256, "receipt result SHA")
      !== sha256(Buffer.from(visionContract.canonicalJson(response.result), "utf8"))
    || text(receipt.key_id, "worker receipt key_id") !== "walmart-listing-vision-aaf60dc3afc25bba"
    || digest(receipt.public_key_spki_sha256, "worker receipt key SHA")
      !== "aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3"
    || receiptContract.worker_build !== input.workerContract.worker_build
    || !exactEqual(receiptContract.reservation_ledger, input.workerContract.reservation_ledger)
    || subscription.auth_mode !== "claude_subscription_oauth"
    || subscription.paid_api_environment_absent !== true
    || subscription.alternate_cloud_routing_absent !== true) {
    throw new Error(`call ${input.planCall.call_index} signed receipt mismatch`);
  }
  const reservedAt = text(receiptBody.reservation_reserved_at, "receipt reserved_at");
  const issuedAt = text(receiptBody.issued_at, "receipt issued_at");
  if (new Date(reservedAt).toISOString() !== reservedAt
    || new Date(issuedAt).toISOString() !== issuedAt
    || Date.parse(reservedAt) < Date.parse(input.authorizationIssuedAt)
    || Date.parse(reservedAt) >= Date.parse(input.authorizationExpiresAt)
    || Date.parse(issuedAt) < Date.parse(reservedAt)
    || Date.parse(issuedAt) - Date.parse(reservedAt) > input.workerContract.vision_timeout_ms + 30_000) {
    throw new Error(`call ${input.planCall.call_index} signed timing mismatch`);
  }
  const observations = parseBlindResponse(response.result, imageIds);
  const decisions = observations.map((observation) => {
    const binding = input.planCall.image_bindings.find((row) => row.image_id === observation.image_id);
    if (!binding) throw new Error(`call ${input.planCall.call_index} observation binding is missing`);
    const surface: "buyer_pdp" | "last_applied_artifact" = input.targetCall
      ? "last_applied_artifact"
      : "buyer_pdp";
    const image: AuditImageInput = {
      slot: binding.slot,
      url: `https://evidence.invalid/${binding.asset_sha256}`,
      buyer_facing_verified: !input.targetCall,
      surface,
    };
    const decision = decideBlind({
      case_id: `shadow:${input.planCall.call_key}:${binding.slot}`,
      sku: "FaisalX-1183",
      expected: EXPECTED_TRUTH,
      images: [image],
    }, image, observation, { ocr_texts: [] });
    return {
      image_id: binding.image_id,
      slot: binding.slot,
      asset_sha256: binding.asset_sha256,
      surface,
      verdict: decision.verdict,
      checks: decision.checks as unknown as JsonRecord,
      hard_failures: decision.hard_failures,
      unknowns: decision.unknowns,
    };
  });
  return {
    call_index: input.planCall.call_index,
    shard_id: input.planCall.shard_id,
    call_key: input.planCall.call_key,
    raw_response_sha256: responseArtifact.sha256,
    worker_receipt: receipt,
    observations,
    decisions,
  };
}

export async function verifyWalmartShadowVisualResponses(input: {
  planPath: string;
  currentResponsePath: string;
  targetResponsePath: string;
}) {
  const planArtifact = await readJson(input.planPath, "shadow visual plan", 2_000_000);
  const plan = planArtifact.value;
  exactKeys(plan, [
    "schema_version", "created_at", "authority_path", "authority_sha256",
    "canary_preview_path", "canary_preview_sha256", "worker_contract",
    "partition_id", "calls", "execution_policy",
  ], "shadow visual plan");
  if (plan.schema_version !== "walmart-listing-integrity-shadow-vision-plan/v1"
    || !Array.isArray(plan.calls) || plan.calls.length !== 2) {
    throw new Error("shadow visual plan schema/call population is invalid");
  }
  const authorityArtifact = await readJson(
    path.resolve(text(plan.authority_path, "plan.authority_path")),
    "shadow authorization",
    100_000,
  );
  const authority = authorityArtifact.value;
  const claims = record(authority.claims, "shadow authorization claims");
  const scope = record(authority.scope, "shadow authorization scope");
  if (authorityArtifact.sha256 !== digest(plan.authority_sha256, "plan.authority_sha256")
    || authority.schema_version !== "walmart-listing-integrity-shadow-vision-authorization/v1"
    || authority.action !== "READ_ONLY_VISUAL_ATTESTATION"
    || authority.authority !== "EVIDENCE_ONLY_NOT_MARKETPLACE_WRITE_AUTHORITY"
    || claims.walmart_reads !== 0 || claims.walmart_writes !== 0
    || claims.database_writes !== 0 || claims.paid_api_calls !== 0
    || claims.openai_model_calls !== 0 || claims.retries !== 0 || claims.fallbacks !== 0
    || claims.live_canary_authorized !== false || claims.mass_run !== false
    || scope.canary_preview_sha256 !== plan.canary_preview_sha256
    || scope.partition_id !== plan.partition_id
    || scope.maximum_subscription_calls !== 2) {
    throw new Error("shadow authorization does not bind the exact read-only plan");
  }
  const previewArtifact = await readJson(
    path.resolve(text(plan.canary_preview_path, "plan.canary_preview_path")),
    "canary preview",
    250_000,
  );
  if (previewArtifact.sha256 !== digest(plan.canary_preview_sha256, "plan preview SHA")) {
    throw new Error("canary preview bytes changed after planning");
  }
  const workerContract = parseWorkerContract(plan.worker_contract);
  const calls = plan.calls.map(parsePlanCall);
  if (calls[0]!.call_index !== 0 || calls[1]!.call_index !== 1
    || !exactEqual(scope.shard_ids, calls.map((call) => call.shard_id))) {
    throw new Error("shadow calls are not the exact authorized ordered shards");
  }
  const common = {
    workerContract,
    runLockSha256: previewArtifact.sha256,
    partitionId: text(plan.partition_id, "plan.partition_id"),
    authorizationSha256: authorityArtifact.sha256,
    authorizationIssuedAt: text(authority.issued_at, "authorization.issued_at"),
    authorizationExpiresAt: text(authority.expires_at, "authorization.expires_at"),
  };
  const current = await verifyCall({
    ...common,
    planCall: calls[0]!,
    responsePath: input.currentResponsePath,
    targetCall: false,
  });
  const target = await verifyCall({
    ...common,
    planCall: calls[1]!,
    responsePath: input.targetResponsePath,
    targetCall: true,
  });
  const currentMain = current.decisions.find((row) => row.slot === "main");
  const targetMain = target.decisions.find((row) => row.slot === "main");
  const gallery = current.decisions.filter((row) => row.slot !== "main");
  const qualificationFailures = [
    ...(!currentMain || currentMain.verdict !== "BAD"
      ? ["CURRENT_MAIN_DEFECT_NOT_REPRODUCED"]
      : []),
    ...(!targetMain || targetMain.verdict !== "PASS"
      ? ["TARGET_MAIN_NOT_PASS"]
      : []),
    ...(gallery.some((row) => row.verdict === "BAD")
      ? ["CURRENT_GALLERY_BAD"]
      : []),
  ];
  if (qualificationFailures.length > 0) {
    throw new Error(`fresh signed visual qualification failed: ${visionContract.canonicalJson({
      failures: qualificationFailures,
      current_main: currentMain ?? null,
      target_main: targetMain ?? null,
      gallery,
    })}`);
  }
  const status = gallery.every((row) => row.verdict === "PASS")
    ? "SIGNED_SHADOW_VISUAL_PASS"
    : "SIGNED_TARGET_PASS_GALLERY_REVIEW_REQUIRED";
  const body = {
    schema_version: "walmart-listing-integrity-shadow-visual-attestation/v1",
    created_at: new Date().toISOString(),
    status,
    comparator_version: WALMART_VISUAL_COMPARATOR_VERSION,
    authority: {
      artifact_sha256: authorityArtifact.sha256,
      marketplace_write_authority: false,
    },
    canary_preview_sha256: previewArtifact.sha256,
    plan_sha256: planArtifact.sha256,
    worker: {
      build: workerContract.worker_build,
      key_id: "walmart-listing-vision-aaf60dc3afc25bba",
      public_key_spki_sha256: "aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3",
      reservation_ledger: workerContract.reservation_ledger,
    },
    calls: [current, target],
    qualification: {
      current_main_defect_reproduced: true,
      target_main_pass: true,
      gallery_bad_count: gallery.filter((row) => row.verdict === "BAD").length,
      gallery_review_count: gallery.filter((row) => row.verdict === "REVIEW").length,
      full_production_image_certificate: false,
      live_canary_authorized: false,
    },
    external_effects: {
      claude_subscription_calls: 2,
      transport_attempts: 2,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      database_writes: 0,
    },
  };
  const bodySha = sha256(Buffer.from(visionContract.canonicalJson(body), "utf8"));
  return {
    ...body,
    artifact_id: `walmart-shadow-visual-attestation-${bodySha.slice(0, 20)}`,
    body_sha256: bodySha,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stdout.write(HELP);
    return;
  }
  const artifact = await verifyWalmartShadowVisualResponses({
    planPath: args.plan,
    currentResponsePath: args["current-response"],
    targetResponsePath: args["target-response"],
  });
  await writeFile(args.output, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  await chmod(args.output, 0o400);
  const bytes = await readFile(args.output);
  process.stdout.write(`${JSON.stringify({
    status: artifact.status,
    output: args.output,
    file_sha256: sha256(bytes),
    body_sha256: artifact.body_sha256,
    qualification: artifact.qualification,
    external_effects: artifact.external_effects,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
