#!/usr/bin/env -S node --experimental-strip-types

/**
 * Exact six-call maximum observer for one prepared Walmart catalog partition.
 *
 * It can only call the Claude subscription image worker. There is no Walmart,
 * database, repair, publish, price, inventory, or delist client in this file.
 * Every call is single-attempt and signed by the pinned worker identity.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseBlindResponse,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  adjudicateWalmartListingCatalogTriage,
  verifyWalmartListingCatalogTriagePlan,
} from "../src/lib/walmart/listing-integrity-catalog-triage.ts";
import { verifyPreparedWalmartListingCatalogTriage } from "./walmart-listing-integrity-triage.mjs";

const require = createRequire(import.meta.url);
const visionContract = require("../ops/codex-image-worker/vision-contract.js");

const TRUSTED_KEY_ID = "walmart-listing-vision-aaf60dc3afc25bba";
const TRUSTED_KEY_SHA256 = "aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3";
const DEFAULT_TRUST = Object.freeze({
  key_id: TRUSTED_KEY_ID,
  public_key_spki_sha256: TRUSTED_KEY_SHA256,
});
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_REQUEST_CHARACTERS = 20_000_000;
const SSH_WORKER_HOST = "openclaw";
const SSH_WORKER_HELPER = "/root/codex-image-worker/post-local-request.js";

const HELP = `Usage:
  npm run walmart-listing-triage-observer -- execute \
    --triage-plan=/absolute/triage-plan.json --expect-triage-plan-sha256=<sha256> \
    --output-dir=/absolute/new/directory

  npm run walmart-listing-triage-observer -- verify \
    --triage-plan=/absolute/triage-plan.json --expect-triage-plan-sha256=<sha256> \
    --execution-dir=/absolute/completed/directory

execute requires CODEX_IMAGE_WORKER_URL ending in /analyze-claude and
CODEX_IMAGE_WORKER_TOKEN. Maximum 6 Claude subscription calls, one attempt each.
No command contains a Walmart or database mutation path.
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be SHA-256`);
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactEqual(left, right) {
  return visionContract.canonicalJson(left) === visionContract.canonicalJson(right);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  if (argv.length === 1 && ["help", "--help"].includes(argv[0])) return { help: true };
  const command = argv[0];
  if (!["execute", "verify"].includes(command)) {
    throw new Error("first argument must be execute, verify, or --help");
  }
  const flags = new Map();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1])) throw new Error(`unsupported/duplicate argument: ${argument}`);
    flags.set(match[1], match[2]);
  }
  const expected = command === "execute"
    ? ["triage-plan", "expect-triage-plan-sha256", "output-dir"]
    : ["triage-plan", "expect-triage-plan-sha256", "execution-dir"];
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    throw new Error(`${command} arguments must be exactly: ${expected.map((key) => `--${key}`).join(", ")}`);
  }
  const result = { help: false, command };
  for (const key of expected) {
    const value = flags.get(key);
    result[key.replaceAll("-", "_")] = key.includes("sha256")
      ? digest(value, `--${key}`)
      : path.resolve(value);
  }
  return result;
}

async function writeExclusive(pathname, bytes) {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readExactJson(pathname, expectedSha256, label, maximum = 100_000_000) {
  const bytes = await readFile(pathname);
  if (bytes.length < 2 || bytes.length > maximum || sha256(bytes) !== expectedSha256) {
    throw new Error(`${label} exact-file SHA-256/size mismatch`);
  }
  return { bytes, sha256: expectedSha256, value: JSON.parse(bytes.toString("utf8")) };
}

function workerUrlFromEnvironment() {
  const raw = String(process.env.CODEX_IMAGE_WORKER_URL ?? "").trim();
  const token = String(process.env.CODEX_IMAGE_WORKER_TOKEN ?? "").trim();
  if (!raw || !token) {
    throw new Error("CODEX_IMAGE_WORKER_URL and CODEX_IMAGE_WORKER_TOKEN are required");
  }
  const url = new URL(raw);
  const localHttp = url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password
    || url.search || url.hash || !url.pathname.endsWith("/analyze-claude")
    || url.pathname.endsWith("/analyze-claude/")) {
    throw new Error("CODEX_IMAGE_WORKER_URL must be trusted HTTPS or loopback HTTP and end in /analyze-claude");
  }
  return { url, token };
}

async function sshWorkerTransport(_url, init, maximumBytes, timeoutMs) {
  const action = init.method === "GET" ? "health" : "analyze";
  const input = action === "analyze" ? Buffer.from(String(init.body ?? ""), "utf8") : Buffer.alloc(0);
  if (input.length > MAX_REQUEST_CHARACTERS) throw new Error("SSH worker request exceeds cap");
  const child = spawn(
    "ssh",
    [SSH_WORKER_HOST, "node", SSH_WORKER_HELPER, action],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maximumBytes * 2) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 20_000) stderr.push(chunk);
  });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SSH worker ${action} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (exitCode !== 0 || stdoutBytes > maximumBytes * 2) {
    throw new Error(`SSH worker ${action} failed: ${Buffer.concat(stderr).toString("utf8").slice(-1500)}`);
  }
  const envelope = record(JSON.parse(Buffer.concat(stdout).toString("utf8")), "SSH worker envelope");
  if (!Number.isSafeInteger(envelope.status) || typeof envelope.body_base64 !== "string") {
    throw new Error("SSH worker envelope shape is invalid");
  }
  const bytes = Buffer.from(envelope.body_base64, "base64");
  if (!bytes.length || bytes.length > maximumBytes
    || bytes.toString("base64") !== envelope.body_base64) {
    throw new Error("SSH worker response bytes are invalid");
  }
  return {
    status: envelope.status,
    bytes,
    value: JSON.parse(bytes.toString("utf8")),
    sha256: sha256(bytes),
  };
}

function healthUrl(analyzeUrl) {
  const url = new URL(analyzeUrl.toString());
  url.pathname = url.pathname.replace(/\/analyze-claude$/u, "/health");
  return url;
}

async function fetchBoundedJson(url, init, maximumBytes, timeoutMs) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("worker response Content-Length exceeds cap");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumBytes) {
    throw new Error("worker response body is empty or exceeds cap");
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("worker response is not valid JSON");
  }
  return { status: response.status, bytes, value, sha256: sha256(bytes) };
}

function assertWorkerHealth(health, plan, trust = DEFAULT_TRUST) {
  const raw = record(health, "worker health");
  const receipt = record(raw.signed_vision_receipts, "worker health signed_vision_receipts");
  const contracts = record(raw.vision_contracts, "worker health vision_contracts");
  const claude = record(contracts.claude_cli_subscription, "worker health Claude contract");
  if (raw.ok !== true || raw.health_authorization_verified !== true
    || raw.vision !== true || raw.worker_build !== plan.worker_contract.worker_build
    || raw.vision_timeout_ms !== plan.worker_contract.vision_timeout_ms
    || !Array.isArray(raw.vision_providers)
    || !raw.vision_providers.includes("claude_cli_subscription")
    || raw.durable_call_key_reservations !== true
    || receipt.schema_version !== "vision-worker-receipt/v2"
    || receipt.key_id !== trust.key_id
    || receipt.public_key_spki_sha256 !== trust.public_key_spki_sha256
    || claude.model !== plan.worker_contract.model
    || claude.reasoning_effort !== plan.worker_contract.reasoning_effort
    || claude.cli_version !== plan.worker_contract.cli_version
    || !exactEqual(raw.reservation_ledger, plan.worker_contract.reservation_ledger)) {
    throw new Error("authenticated worker health differs from the sealed triage plan");
  }
}

async function buildRequests(planPath, plan) {
  const root = path.dirname(planPath);
  const assetsById = new Map(plan.assets.map((asset) => [asset.image_id, asset]));
  const requests = [];
  for (const call of plan.calls) {
    const images = [];
    const imageShas = [];
    for (const imageId of call.image_ids) {
      const asset = assetsById.get(imageId);
      if (!asset) throw new Error(`call ${call.call_index} references an unknown image`);
      const pathname = path.resolve(root, asset.model_asset.path);
      if (!pathname.startsWith(`${root}${path.sep}`)) throw new Error("model asset escapes plan root");
      const info = await lstat(pathname);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("model asset is not a regular file");
      const bytes = await readFile(pathname);
      if (bytes.length !== asset.model_asset.bytes || sha256(bytes) !== asset.model_asset.sha256) {
        throw new Error("model asset bytes changed after triage preparation");
      }
      images.push(bytes.toString("base64"));
      imageShas.push(asset.model_asset.sha256);
    }
    const requestAttestation = {
      schema_version: "vision-request-attestation/v2",
      run_lock_sha256: plan.scope_sha256,
      shard_id: call.shard_id,
      call_index: call.call_index,
      call_key: call.call_key,
      prompt_sha256: call.prompt_sha256,
      execution_permit_sha256: plan.policy_sha256,
      partition_id: plan.source_binding.partition_id,
      image_sha256: imageShas,
    };
    const value = {
      prompt: call.prompt,
      images,
      request_attestation: requestAttestation,
    };
    const body = JSON.stringify(value);
    if (body.length > MAX_REQUEST_CHARACTERS || body.length > call.request_character_estimate) {
      throw new Error(`call ${call.call_index} exact request exceeds its bound`);
    }
    requests.push({ call, value, body, bytes: Buffer.from(body, "utf8"), requestAttestation });
  }
  return requests;
}

function validateWorkerResponse(input) {
  const response = record(input.response, `call ${input.call.call_index} worker response`);
  const contract = input.plan.worker_contract;
  if (input.httpStatus !== 200 || response.ok !== true
    || response.request_attestation_verified !== true
    || response.input_image_count !== input.call.image_ids.length
    || response.vision_provider !== "claude_cli_subscription"
    || response.vision_model !== contract.model
    || response.vision_reasoning_effort !== contract.reasoning_effort
    || response.cli_version !== contract.cli_version
    || response.node_version !== contract.node_version
    || response.runtime_platform !== contract.runtime_platform
    || response.runtime_arch !== contract.runtime_arch
    || response.worker_build !== contract.worker_build
    || response.vision_timeout_ms !== contract.vision_timeout_ms
    || !exactEqual(response.reservation_ledger, contract.reservation_ledger)) {
    throw new Error(`call ${input.call.call_index} worker response contract mismatch`);
  }
  const receipt = visionContract.verifyVisionWorkerReceipt(response.worker_receipt);
  const body = record(receipt.body, "worker receipt body");
  const worker = record(body.worker_contract, "worker receipt contract");
  const subscription = record(body.subscription_policy, "worker receipt subscription policy");
  if (receipt.key_id !== input.trust.key_id
    || receipt.public_key_spki_sha256 !== input.trust.public_key_spki_sha256
    || !exactEqual(body.request_attestation, input.requestAttestation)
    || body.result_canonical_sha256 !== sha256(Buffer.from(
      visionContract.canonicalJson(response.result),
      "utf8",
    ))
    || worker.worker_build !== contract.worker_build
    || !exactEqual(worker.reservation_ledger, contract.reservation_ledger)
    || subscription.auth_mode !== "claude_subscription_oauth"
    || subscription.paid_api_environment_absent !== true
    || subscription.alternate_cloud_routing_absent !== true) {
    throw new Error(`call ${input.call.call_index} signed receipt mismatch`);
  }
  const reservedAt = Date.parse(body.reservation_reserved_at);
  const issuedAt = Date.parse(body.issued_at);
  if (!Number.isFinite(reservedAt) || !Number.isFinite(issuedAt)
    || issuedAt < reservedAt || issuedAt - reservedAt > contract.vision_timeout_ms + 30_000) {
    throw new Error(`call ${input.call.call_index} signed timing mismatch`);
  }
  const observations = parseBlindResponse(response.result, input.call.image_ids);
  return { receipt, observations };
}

async function loadPlan(options) {
  await verifyPreparedWalmartListingCatalogTriage({
    triage_plan: options.triage_plan,
    expect_triage_plan_sha256: options.expect_triage_plan_sha256,
  });
  const artifact = await readExactJson(
    options.triage_plan,
    options.expect_triage_plan_sha256,
    "triage plan",
  );
  verifyWalmartListingCatalogTriagePlan(artifact.value);
  return artifact;
}

export async function executeWalmartListingCatalogTriage(options, injected = {}) {
  const planArtifact = await loadPlan(options);
  const plan = planArtifact.value;
  const requests = await buildRequests(options.triage_plan, plan);
  const useSshTransport = !injected.connection
    && process.env.WALMART_LISTING_TRIAGE_TRANSPORT === "ssh-openclaw";
  const connection = injected.connection ?? (useSshTransport
    ? { url: new URL("http://127.0.0.1:8791/analyze-claude"), token: "remote-managed" }
    : workerUrlFromEnvironment());
  const trust = injected.trust ?? DEFAULT_TRUST;
  const fetchFn = injected.fetch ?? (useSshTransport ? sshWorkerTransport : fetchBoundedJson);
  const health = await fetchFn(
    healthUrl(connection.url),
    { method: "GET", headers: { authorization: `Bearer ${connection.token}` } },
    MAX_RESPONSE_BYTES,
    30_000,
  );
  if (health.status !== 200) throw new Error(`authenticated worker health returned HTTP ${health.status}`);
  assertWorkerHealth(health.value, plan, trust);
  try {
    await lstat(options.output_dir);
    throw new Error("--output-dir must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(options.output_dir, { recursive: false, mode: 0o700 });
  await writeExclusive(path.join(options.output_dir, "worker-health.json"), health.bytes);
  const observations = [];
  const calls = [];
  const startedAt = new Date().toISOString();
  for (const request of requests) {
    const prefix = `call-${String(request.call.call_index).padStart(2, "0")}`;
    await writeExclusive(path.join(options.output_dir, `${prefix}-request.json`), request.bytes);
    const response = await fetchFn(
      connection.url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: request.body,
      },
      MAX_RESPONSE_BYTES,
      plan.worker_contract.vision_timeout_ms + 60_000,
    );
    await writeExclusive(path.join(options.output_dir, `${prefix}-response.json`), response.bytes);
    const verified = validateWorkerResponse({
      plan,
      call: request.call,
      requestAttestation: request.requestAttestation,
      httpStatus: response.status,
      response: response.value,
      trust,
    });
    observations.push(...verified.observations);
    calls.push({
      call_index: request.call.call_index,
      shard_id: request.call.shard_id,
      call_key: request.call.call_key,
      request_file_sha256: sha256(request.bytes),
      response_file_sha256: response.sha256,
      worker_receipt_key_id: verified.receipt.key_id,
      worker_receipt_result_sha256: verified.receipt.body.result_canonical_sha256,
      observations: verified.observations.length,
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
    });
  }
  const report = adjudicateWalmartListingCatalogTriage({ plan, observations });
  const reportBytes = jsonBytes(report);
  const reportSha256 = sha256(reportBytes);
  await writeExclusive(path.join(options.output_dir, "triage-report.json"), reportBytes);
  await writeExclusive(
    path.join(options.output_dir, "triage-report.sha256"),
    Buffer.from(`${reportSha256}\n`, "utf8"),
  );
  const index = {
    schema_version: "walmart-listing-integrity-catalog-triage-execution/v1",
    triage_plan_file_sha256: planArtifact.sha256,
    triage_plan_body_sha256: plan.body_sha256,
    partition_id: plan.source_binding.partition_id,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    worker_health_file_sha256: health.sha256,
    calls,
    report_file_sha256: reportSha256,
    outcome: report.summary,
    execution: {
      subscription_calls_consumed: calls.length,
      transport_attempts: calls.length,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  };
  const sealedIndex = {
    ...index,
    body_sha256: sha256(Buffer.from(visionContract.canonicalJson(index), "utf8")),
  };
  const indexBytes = jsonBytes(sealedIndex);
  const indexSha256 = sha256(indexBytes);
  await writeExclusive(path.join(options.output_dir, "execution-index.json"), indexBytes);
  await writeExclusive(
    path.join(options.output_dir, "execution-index.sha256"),
    Buffer.from(`${indexSha256}\n`, "utf8"),
  );
  await chmod(options.output_dir, 0o500);
  return {
    status: "TRIAGE_EXECUTION_COMPLETE",
    output_dir: options.output_dir,
    execution_index_sha256: indexSha256,
    triage_report_sha256: reportSha256,
    outcome: report.summary,
    execution: index.execution,
  };
}

export async function verifyWalmartListingCatalogTriageExecution(options, injected = {}) {
  const planArtifact = await loadPlan(options);
  const plan = planArtifact.value;
  const indexSha = (await readFile(path.join(options.execution_dir, "execution-index.sha256"), "utf8")).trim();
  const indexArtifact = await readExactJson(
    path.join(options.execution_dir, "execution-index.json"),
    digest(indexSha, "execution index sidecar"),
    "execution index",
    5_000_000,
  );
  const index = record(indexArtifact.value, "execution index");
  const indexBody = { ...index };
  delete indexBody.body_sha256;
  if (index.body_sha256 !== sha256(Buffer.from(visionContract.canonicalJson(indexBody), "utf8"))
    || index.triage_plan_file_sha256 !== planArtifact.sha256
    || index.triage_plan_body_sha256 !== plan.body_sha256
    || index.partition_id !== plan.source_binding.partition_id
    || !Array.isArray(index.calls) || index.calls.length !== plan.calls.length
    || index.execution?.subscription_calls_consumed !== plan.calls.length
    || index.execution?.transport_attempts !== plan.calls.length
    || index.execution?.retries !== 0 || index.execution?.fallbacks !== 0
    || index.execution?.paid_api_calls !== 0 || index.execution?.database_writes !== 0
    || index.execution?.walmart_reads !== 0 || index.execution?.walmart_writes !== 0) {
    throw new Error("execution index seal/binding/counters mismatch");
  }
  const healthBytes = await readFile(path.join(options.execution_dir, "worker-health.json"));
  if (sha256(healthBytes) !== index.worker_health_file_sha256) {
    throw new Error("worker health bytes changed after execution");
  }
  const trust = injected.trust ?? DEFAULT_TRUST;
  assertWorkerHealth(JSON.parse(healthBytes.toString("utf8")), plan, trust);
  const requests = await buildRequests(options.triage_plan, plan);
  const observations = [];
  for (const request of requests) {
    const prefix = `call-${String(request.call.call_index).padStart(2, "0")}`;
    const indexed = index.calls[request.call.call_index];
    if (!indexed || indexed.call_index !== request.call.call_index
      || indexed.call_key !== request.call.call_key
      || indexed.request_file_sha256 !== sha256(request.bytes)
      || indexed.subscription_calls_consumed !== 1 || indexed.transport_attempts !== 1
      || indexed.retries !== 0) {
      throw new Error(`execution call ${request.call.call_index} index mismatch`);
    }
    const requestBytes = await readFile(path.join(options.execution_dir, `${prefix}-request.json`));
    if (!requestBytes.equals(request.bytes)) {
      throw new Error(`execution call ${request.call.call_index} request bytes changed`);
    }
    const responseBytes = await readFile(path.join(options.execution_dir, `${prefix}-response.json`));
    if (sha256(responseBytes) !== indexed.response_file_sha256) {
      throw new Error(`execution call ${request.call.call_index} response bytes changed`);
    }
    const verified = validateWorkerResponse({
      plan,
      call: request.call,
      requestAttestation: request.requestAttestation,
      httpStatus: 200,
      response: JSON.parse(responseBytes.toString("utf8")),
      trust,
    });
    observations.push(...verified.observations);
  }
  const rebuiltReport = adjudicateWalmartListingCatalogTriage({ plan, observations });
  const reportBytes = await readFile(path.join(options.execution_dir, "triage-report.json"));
  const reportSidecar = (await readFile(
    path.join(options.execution_dir, "triage-report.sha256"),
    "utf8",
  )).trim();
  if (digest(reportSidecar, "report sidecar") !== sha256(reportBytes)
    || reportSidecar !== index.report_file_sha256
    || !exactEqual(JSON.parse(reportBytes.toString("utf8")), rebuiltReport)) {
    throw new Error("triage report does not rebuild exactly from signed observations");
  }
  const expectedNames = [
    "execution-index.json", "execution-index.sha256", "triage-report.json",
    "triage-report.sha256", "worker-health.json",
    ...requests.flatMap((request) => {
      const prefix = `call-${String(request.call.call_index).padStart(2, "0")}`;
      return [`${prefix}-request.json`, `${prefix}-response.json`];
    }),
  ].sort();
  const actualNames = (await readdir(options.execution_dir)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("execution directory contains missing or extra artifacts");
  }
  return {
    verified: true,
    listings: rebuiltReport.summary.listings,
    images: observations.length,
    calls: requests.length,
    outcome: rebuiltReport.summary,
    execution: index.execution,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = options.command === "execute"
    ? await executeWalmartListingCatalogTriage(options)
    : await verifyWalmartListingCatalogTriageExecution(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
