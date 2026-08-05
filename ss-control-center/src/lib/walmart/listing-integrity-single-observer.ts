/**
 * Bounded blind-observer contract for one exact Walmart listing.
 *
 * The model receives only deterministic image views plus opaque image IDs.
 * It never receives SKU, title, Product Truth, expected quantity, or a repair
 * instruction. Signed worker receipts bind the exact prompt and image bytes.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  BLIND_PROMPT_VERSION,
  buildBlindObservationPrompt,
  parseBlindResponse,
  type BlindObservation,
  type ImageSlot,
} from "./catalog-visual-audit.ts";
import {
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationSha256,
  type WalmartListingObservationImageBinding,
  type WalmartListingObservationWorkerContract,
} from "./listing-integrity-observation.ts";

const require = createRequire(import.meta.url);
const visionContract = require("../../../ops/codex-image-worker/vision-contract.js");

export const WALMART_LISTING_SINGLE_OBSERVER_PLAN_SCHEMA =
  "walmart-listing-single-observer-plan/v1" as const;
export const WALMART_LISTING_SINGLE_OBSERVER_MAX_IMAGES_PER_CALL = 6;
export const WALMART_LISTING_SINGLE_OBSERVER_MAX_CALLS = 6;

export const WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT:
  WalmartListingObservationWorkerContract = Object.freeze({
    worker_build: "sha256:bd6aa14f1b13622b482e66cdf19b44ba940c5959def67933f472e6beb1006125",
    model: "sonnet",
    reasoning_effort: null,
    cli_version: "2.1.179 (Claude Code)",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
    vision_timeout_ms: 300000,
    reservation_ledger: {
      schema_version: "vision-call-reservation-ledger-contract/v1" as const,
      ledger_id: "ledger-2c53fa5f-f761-4660-80b9-24e934e172aa" as const,
      ledger_epoch: "epoch-986b9a13-740b-4403-b433-378f2613d4f0" as const,
      state_directory_path_sha256:
        "ae43d594a2a43b6bc856529cfa729d73d9784d1dd3f3e4dffddf27feccfece53",
      directory_identity_sha256:
        "c0e7a611777a5b7063c36a94c3c4c27ea6943e34ba2622944c0426d7685c0db1",
      identity_artifact_sha256:
        "ffd380901c51e88205454d1ddd68141d94e811c286b62d556c60e335e84e3a68",
    },
  });

export const WALMART_LISTING_SINGLE_OBSERVER_CODEX_WORKER_CONTRACT:
  WalmartListingObservationWorkerContract = Object.freeze({
    worker_build: "sha256:bd6aa14f1b13622b482e66cdf19b44ba940c5959def67933f472e6beb1006125",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    cli_version: "codex-cli 0.144.5",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
    vision_timeout_ms: 300000,
    reservation_ledger: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.reservation_ledger,
  });

export const WALMART_LISTING_SINGLE_OBSERVER_TRUST = Object.freeze({
  key_id: "walmart-listing-vision-aaf60dc3afc25bba",
  public_key_spki_sha256:
    "aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3",
});

export interface WalmartListingSingleObserverPreparedAsset {
  slot: ImageSlot;
  source_asset_sha256: string;
  model_asset: {
    path: string;
    sha256: string;
    bytes: number;
    media_type: "image/jpeg";
    width: number;
    height: number;
  };
}

export interface WalmartListingSingleObserverPlan {
  schema_version: typeof WALMART_LISTING_SINGLE_OBSERVER_PLAN_SCHEMA;
  created_at: string;
  listing_key: string;
  item_id: string;
  intake_index_file_sha256: string;
  intake_index_body_sha256: string;
  policy: {
    mode: "READ_ONLY_SINGLE_SKU_BLIND_OBSERVATION";
    images_per_call_max: 6;
    calls_max: 6;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    walmart_reads: 0;
    walmart_writes: 0;
    database_reads: 0;
    database_writes: 0;
    may_issue_pass: false;
    may_prepare_repair: false;
  };
  policy_sha256: string;
  scope_sha256: string;
  worker_contract: WalmartListingObservationWorkerContract;
  assets: Array<WalmartListingSingleObserverPreparedAsset & {
    image_id: string;
    binding: WalmartListingObservationImageBinding;
  }>;
  calls: Array<{
    call_index: number;
    shard_id: string;
    call_key: string;
    prompt_version: typeof BLIND_PROMPT_VERSION;
    prompt: string;
    prompt_sha256: string;
    image_ids: string[];
    model_asset_paths: string[];
    model_asset_sha256: string[];
    request_character_estimate: number;
  }>;
  body_sha256: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("observer plan created_at must be canonical UTC ISO-8601");
  }
  return value;
}

export function buildWalmartListingSingleObserverPlan(input: {
  created_at: string;
  listing_key: string;
  item_id: string;
  intake_index_file_sha256: string;
  intake_index_body_sha256: string;
  prepared_assets: WalmartListingSingleObserverPreparedAsset[];
  worker_contract?: WalmartListingObservationWorkerContract;
}): WalmartListingSingleObserverPlan {
  canonicalTimestamp(input.created_at);
  if (!input.listing_key || input.listing_key !== input.listing_key.trim()) {
    throw new Error("observer listing_key must be explicit and trimmed");
  }
  if (!/^\d+$/u.test(input.item_id)) {
    throw new Error("observer item_id must contain digits only");
  }
  digest(input.intake_index_file_sha256, "intake index file SHA");
  digest(input.intake_index_body_sha256, "intake index body SHA");
  if (!input.prepared_assets.length
    || input.prepared_assets.length
      > WALMART_LISTING_SINGLE_OBSERVER_MAX_IMAGES_PER_CALL
        * WALMART_LISTING_SINGLE_OBSERVER_MAX_CALLS) {
    throw new Error("observer asset population is empty or exceeds six calls");
  }
  const workerContract = input.worker_contract
    ?? WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT;
  const policy = {
    mode: "READ_ONLY_SINGLE_SKU_BLIND_OBSERVATION" as const,
    images_per_call_max: 6 as const,
    calls_max: 6 as const,
    retries: 0 as const,
    fallbacks: 0 as const,
    paid_api_calls: 0 as const,
    walmart_reads: 0 as const,
    walmart_writes: 0 as const,
    database_reads: 0 as const,
    database_writes: 0 as const,
    may_issue_pass: false as const,
    may_prepare_repair: false as const,
  };
  const policySha256 = walmartListingObservationSha256(policy);
  const assets = input.prepared_assets.map((asset, index) => {
    digest(asset.source_asset_sha256, `prepared asset ${index} source SHA`);
    digest(asset.model_asset.sha256, `prepared asset ${index} model SHA`);
    if (!asset.model_asset.path
      || asset.model_asset.path.startsWith("/")
      || asset.model_asset.path.split("/").some((part) => !part || part === "..")
      || asset.model_asset.media_type !== "image/jpeg"
      || !Number.isSafeInteger(asset.model_asset.bytes)
      || asset.model_asset.bytes < 1
      || !Number.isSafeInteger(asset.model_asset.width)
      || asset.model_asset.width < 1
      || !Number.isSafeInteger(asset.model_asset.height)
      || asset.model_asset.height < 1) {
      throw new Error(`prepared asset ${index} is invalid`);
    }
    const imageId = walmartListingObservationImageId(
      asset.source_asset_sha256,
      asset.slot,
      input.listing_key,
    );
    const binding: WalmartListingObservationImageBinding = {
      listing_key: input.listing_key,
      item_id: input.item_id,
      slot: asset.slot,
      asset_sha256: asset.source_asset_sha256,
      model_view_sha256: asset.model_asset.sha256,
      image_id: imageId,
    };
    return { ...asset, image_id: imageId, binding };
  });
  if (new Set(assets.map((asset) => asset.slot)).size !== assets.length
    || assets[0]?.slot !== "main"
    || assets.some((asset, index) => (
      asset.slot !== (index === 0 ? "main" : `gallery-${index}`)
    ))) {
    throw new Error("observer assets must be MAIN then contiguous gallery slots");
  }
  const scopeSha256 = walmartListingObservationSha256({
    listing_key: input.listing_key,
    item_id: input.item_id,
    intake_index_file_sha256: input.intake_index_file_sha256,
    intake_index_body_sha256: input.intake_index_body_sha256,
    policy_sha256: policySha256,
    worker_contract: workerContract,
    assets,
  });
  const calls: WalmartListingSingleObserverPlan["calls"] = [];
  for (let offset = 0;
    offset < assets.length;
    offset += WALMART_LISTING_SINGLE_OBSERVER_MAX_IMAGES_PER_CALL) {
    const callAssets = assets.slice(
      offset,
      offset + WALMART_LISTING_SINGLE_OBSERVER_MAX_IMAGES_PER_CALL,
    );
    const callIndex = calls.length;
    const imageIds = callAssets.map((asset) => asset.image_id);
    const prompt = buildBlindObservationPrompt(imageIds);
    const promptSha256 = sha256(prompt);
    const shardId =
      `single-observer-${String(callIndex).padStart(2, "0")}-${sha256(JSON.stringify(imageIds)).slice(0, 16)}`;
    const callKey = walmartListingObservationCallKey({
      run_lock_sha256: scopeSha256,
      shard_id: shardId,
      call_index: callIndex,
      worker_contract: workerContract,
      prompt_sha256: promptSha256,
      image_bindings: callAssets.map((asset) => asset.binding),
    });
    calls.push({
      call_index: callIndex,
      shard_id: shardId,
      call_key: callKey,
      prompt_version: BLIND_PROMPT_VERSION,
      prompt,
      prompt_sha256: promptSha256,
      image_ids: imageIds,
      model_asset_paths: callAssets.map((asset) => asset.model_asset.path),
      model_asset_sha256: callAssets.map((asset) => asset.model_asset.sha256),
      request_character_estimate: prompt.length + callAssets.reduce(
        (sum, asset) => sum + Math.ceil(asset.model_asset.bytes / 3) * 4,
        20_000,
      ),
    });
  }
  const body = {
    schema_version: WALMART_LISTING_SINGLE_OBSERVER_PLAN_SCHEMA,
    created_at: input.created_at,
    listing_key: input.listing_key,
    item_id: input.item_id,
    intake_index_file_sha256: input.intake_index_file_sha256,
    intake_index_body_sha256: input.intake_index_body_sha256,
    policy,
    policy_sha256: policySha256,
    scope_sha256: scopeSha256,
    worker_contract: workerContract,
    assets,
    calls,
  };
  return {
    ...body,
    body_sha256: walmartListingObservationSha256(body),
  };
}

export function buildWalmartListingSingleObserverRequest(
  plan: WalmartListingSingleObserverPlan,
  callIndex: number,
  modelBytes: readonly Uint8Array[],
): {
  value: {
    prompt: string;
    images: string[];
    request_attestation: {
      schema_version: "vision-request-attestation/v2";
      run_lock_sha256: string;
      shard_id: string;
      call_index: number;
      call_key: string;
      prompt_sha256: string;
      execution_permit_sha256: string;
      partition_id: string;
      image_sha256: string[];
    };
  };
  body: string;
} {
  const call = plan.calls[callIndex];
  if (!call || modelBytes.length !== call.image_ids.length
    || modelBytes.some((bytes, index) => (
      sha256(bytes) !== call.model_asset_sha256[index]
    ))) {
    throw new Error(`observer call ${callIndex} exact model bytes mismatch`);
  }
  const requestAttestation = {
    schema_version: "vision-request-attestation/v2" as const,
    run_lock_sha256: plan.scope_sha256,
    shard_id: call.shard_id,
    call_index: call.call_index,
    call_key: call.call_key,
    prompt_sha256: call.prompt_sha256,
    execution_permit_sha256: plan.policy_sha256,
    partition_id: plan.listing_key,
    image_sha256: [...call.model_asset_sha256],
  };
  const value = {
    prompt: call.prompt,
    images: modelBytes.map((bytes) => Buffer.from(bytes).toString("base64")),
    request_attestation: requestAttestation,
  };
  const body = JSON.stringify(value);
  if (body.length > call.request_character_estimate || body.length > 20_000_000) {
    throw new Error(`observer call ${callIndex} request exceeds sealed bounds`);
  }
  return { value, body };
}

function exactEqual(left: unknown, right: unknown): boolean {
  return visionContract.canonicalJson(left) === visionContract.canonicalJson(right);
}

function providerForWorker(worker: WalmartListingObservationWorkerContract):
  "claude_cli_subscription" | "codex_cli_subscription" {
  return worker.model === "sonnet"
    ? "claude_cli_subscription"
    : "codex_cli_subscription";
}

function authModeForWorker(worker: WalmartListingObservationWorkerContract):
  "claude_subscription_oauth" | "codex_chatgpt_subscription_oauth" {
  return worker.model === "sonnet"
    ? "claude_subscription_oauth"
    : "codex_chatgpt_subscription_oauth";
}

export function verifyWalmartListingSingleWorkerHealth(
  raw: unknown,
  worker = WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  trust: { key_id: string; public_key_spki_sha256: string } =
    WALMART_LISTING_SINGLE_OBSERVER_TRUST,
): void {
  const health = raw as Record<string, unknown>;
  const receipts = health?.signed_vision_receipts as Record<string, unknown>;
  const contracts = health?.vision_contracts as Record<string, unknown>;
  const provider = providerForWorker(worker);
  const providerContract = contracts?.[provider] as Record<string, unknown>;
  if (health?.ok !== true
    || health?.health_authorization_verified !== true
    || health?.vision !== true
    || health?.worker_build !== worker.worker_build
    || health?.vision_timeout_ms !== worker.vision_timeout_ms
    || health?.durable_call_key_reservations !== true
    || receipts?.schema_version !== "vision-worker-receipt/v2"
    || receipts?.key_id !== trust.key_id
    || receipts?.public_key_spki_sha256 !== trust.public_key_spki_sha256
    || providerContract?.model !== worker.model
    || providerContract?.reasoning_effort !== worker.reasoning_effort
    || providerContract?.cli_version !== worker.cli_version
    || !exactEqual(health?.reservation_ledger, worker.reservation_ledger)) {
    throw new Error("authenticated worker health differs from the single-observer plan");
  }
}

export function verifyWalmartListingSingleWorkerResponse(input: {
  plan: WalmartListingSingleObserverPlan;
  call_index: number;
  request: ReturnType<typeof buildWalmartListingSingleObserverRequest>["value"];
  http_status: number;
  response: unknown;
  trust?: { key_id: string; public_key_spki_sha256: string };
}): { observations: BlindObservation[]; worker_receipt: unknown } {
  const call = input.plan.calls[input.call_index];
  if (!call) throw new Error("single-observer call is absent from the plan");
  const response = input.response as Record<string, unknown>;
  const worker = input.plan.worker_contract;
  const provider = providerForWorker(worker);
  const authMode = authModeForWorker(worker);
  const trust = input.trust ?? WALMART_LISTING_SINGLE_OBSERVER_TRUST;
  if (input.http_status !== 200
    || response?.ok !== true
    || response?.request_attestation_verified !== true
    || response?.input_image_count !== call.image_ids.length
    || response?.vision_provider !== provider
    || response?.vision_model !== worker.model
    || response?.vision_reasoning_effort !== worker.reasoning_effort
    || response?.cli_version !== worker.cli_version
    || response?.node_version !== worker.node_version
    || response?.runtime_platform !== worker.runtime_platform
    || response?.runtime_arch !== worker.runtime_arch
    || response?.worker_build !== worker.worker_build
    || response?.vision_timeout_ms !== worker.vision_timeout_ms
    || !exactEqual(response?.reservation_ledger, worker.reservation_ledger)) {
    throw new Error("single-observer worker response contract mismatch");
  }
  const receipt = visionContract.verifyVisionWorkerReceipt(response.worker_receipt);
  const body = receipt.body;
  if (receipt.key_id !== trust.key_id
    || receipt.public_key_spki_sha256 !== trust.public_key_spki_sha256
    || !exactEqual(body.request_attestation, input.request.request_attestation)
    || body.result_canonical_sha256 !== sha256(Buffer.from(
      visionContract.canonicalJson(response.result),
      "utf8",
    ))
    || !exactEqual(body.worker_contract, {
      input_image_count: call.image_ids.length,
      vision_provider: provider,
      vision_model: worker.model,
      vision_reasoning_effort: worker.reasoning_effort,
      cli_version: worker.cli_version,
      node_version: worker.node_version,
      runtime_platform: worker.runtime_platform,
      runtime_arch: worker.runtime_arch,
      worker_build: worker.worker_build,
      vision_timeout_ms: worker.vision_timeout_ms,
      reservation_ledger: worker.reservation_ledger,
    })
    || !exactEqual(body.subscription_policy, {
      auth_mode: authMode,
      paid_api_environment_absent: true,
      alternate_cloud_routing_absent: true,
    })) {
    throw new Error("single-observer signed worker receipt mismatch");
  }
  const reservedAt = Date.parse(body.reservation_reserved_at);
  const issuedAt = Date.parse(body.issued_at);
  if (!Number.isFinite(reservedAt) || !Number.isFinite(issuedAt)
    || issuedAt < reservedAt
    || issuedAt - reservedAt > worker.vision_timeout_ms + 30_000) {
    throw new Error("single-observer signed worker timing mismatch");
  }
  return {
    observations: parseBlindResponse(response.result, call.image_ids),
    worker_receipt: receipt,
  };
}
