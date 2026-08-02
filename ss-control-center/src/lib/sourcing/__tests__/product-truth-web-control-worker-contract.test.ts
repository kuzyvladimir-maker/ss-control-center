import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRODUCT_TRUTH_WORKER_RESULT_VERSION,
  ProductTruthWorkerContractError,
  parseProductTruthWorkerResult,
  verifyProductTruthWorkerBearer,
} from "../product-truth-web-control-worker-contract";

function file(name: string, text: string) {
  const content = Buffer.from(text, "utf8");
  return {
    name,
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64"),
  };
}

function isWorkerError(code: string) {
  return (error: unknown) =>
    error instanceof ProductTruthWorkerContractError
    && error.code === code;
}

test("worker bearer is separate, hashed, and timing-safe at the contract boundary", () => {
  const token = "worker-token-with-at-least-thirty-two-characters";
  const expectedSha256 = createHash("sha256").update(token).digest("hex");
  assert.equal(
    verifyProductTruthWorkerBearer({ bearer: token, expectedSha256 }),
    true,
  );
  assert.equal(
    verifyProductTruthWorkerBearer({
      bearer: `${token}-wrong`,
      expectedSha256,
    }),
    false,
  );
  assert.equal(
    verifyProductTruthWorkerBearer({ bearer: token, expectedSha256: null }),
    false,
  );
});

test("failed no-spend result remains bounded and cannot claim provider or marketplace effects", () => {
  const result = {
    schemaVersion: PRODUCT_TRUTH_WORKER_RESULT_VERSION,
    commandId: "ptc-command-00000001",
    commandKind: "DOCTOR",
    exitCode: 1,
    files: [
      file("stderr.txt", "doctor failed before any provider call\n"),
      file("stdout.txt", "no output\n"),
    ],
    claims: {
      shell: false,
      providerCalls: 0,
      marketplaceMutations: 0,
    },
  };
  assert.deepEqual(parseProductTruthWorkerResult(result), result);
  assert.throws(
    () =>
      parseProductTruthWorkerResult({
        ...result,
        claims: { ...result.claims, providerCalls: 1 },
      }),
    isWorkerError("WORKER_RESULT_INVALID"),
  );
  assert.throws(
    () =>
      parseProductTruthWorkerResult({
        ...result,
        claims: { ...result.claims, shell: true },
      }),
    isWorkerError("WORKER_RESULT_INVALID"),
  );
});

test("successful result requires exact allowlisted artifact names", () => {
  assert.throws(
    () =>
      parseProductTruthWorkerResult({
        schemaVersion: PRODUCT_TRUTH_WORKER_RESULT_VERSION,
        commandId: "ptc-command-00000001",
        commandKind: "DOCTOR",
        exitCode: 0,
        files: [file("stdout.txt", "pretend success\n")],
        claims: {
          shell: false,
          providerCalls: 0,
          marketplaceMutations: 0,
        },
      }),
    isWorkerError("WORKER_RESULT_INVALID"),
  );
});

test("worker script keeps shell:false and meters only the exact owner-gated execute lane", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /spawn\(process\.execPath/u);
  assert.match(script, /shell:\s*false/u);
  assert.match(script, /claim\.spec\.kind === "EXECUTE"/u);
  assert.match(script, /withMeteredProviderCall/u);
  assert.match(script, /oneInitialBalanceProbeMaximum:\s*true/u);
  assert.match(script, /automaticReplay:\s*false/u);
  assert.match(
    script,
    /DETAIL_RESPONSE_OMITTED_BALANCE_EVIDENCE_NO_EXTRA_PROBE_AUTHORIZED/u,
  );
  assert.doesNotMatch(script, /["'](?:resume|backfill-apply|migrations-apply)["']/u);
  assert.doesNotMatch(script, /execSync|execFileSync|spawnSync|shell:\s*true/u);
});

test("local owner agent keeps the private key off-server and signs only exact pinned quotes", async () => {
  const script = await readFile(
    new URL(
      "../../../../scripts/product-truth-owner-control-agent.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(script, /const LOOPBACK_HOST = "127\.0\.0\.1"/u);
  assert.match(script, /cipher: "aes-256-cbc"/u);
  assert.match(script, /MACOS_LOGIN_KEYCHAIN/u);
  assert.match(script, /origin !== allowedOrigin/u);
  assert.match(
    script,
    /envelope\.engine\.executableTreeSha256 !== pins\.executableTreeSha256/u,
  );
  assert.match(
    script,
    /signed command does not bind every exact plan/u,
  );
  assert.match(script, /private_key_disclosed:\s*false/u);
  assert.match(script, /provider_calls:\s*0/u);
  assert.match(script, /marketplace_mutations:\s*0/u);
  assert.doesNotMatch(script, /UNWRANGLE_API_KEY|OXYLABS|WALMART_CLIENT_ID/u);
});

test("worker proves its clean pinned checkout before its first control API call", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  const verifierAt = script.indexOf("await verifyPinnedCheckout(runtime)");
  const claimAt = script.indexOf('"/api/external/product-truth/control/claim"');
  assert.ok(verifierAt >= 0);
  assert.ok(claimAt > verifierAt);
  assert.match(script, /rev-parse",\s*"HEAD\^\{tree\}"/u);
  assert.match(script, /--porcelain=v1/u);
  assert.match(script, /--untracked-files=all/u);
  assert.match(
    script,
    /productTruthExecutableTreeSha256\(treeSha\)[\s\S]*!==\s*runtime\.release\.executableTreeSha256/u,
  );
});

test("worker canonicalizes its temporary artifact root before invoking the strict runner", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /const root = await realpath\(\s*await mkdtemp\(/u,
  );
});

test("worker drains an in-flight heartbeat before completing a runner result", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  const closeAt = script.indexOf('child.on("close", async (code)');
  const awaitAt = script.indexOf(
    "if (pendingHeartbeat !== null) await pendingHeartbeat",
    closeAt,
  );
  const resolveAt = script.indexOf("resolvePromise({", closeAt);
  assert.ok(closeAt >= 0);
  assert.ok(awaitAt > closeAt);
  assert.ok(resolveAt > awaitAt);
  assert.match(script, /if \(heartbeatInFlight !== null\) return/u);
  assert.match(script, /heartbeatError = error[\s\S]*child\.kill\("SIGTERM"\)/u);
  assert.match(script, /CONTROL_API_TIMEOUT_MS = 150_000/u);
  assert.match(
    script,
    /heartbeatError === undefined[\s\S]*exitCode[\s\S]*heartbeatFailure/u,
  );
});

test("metered worker reports durable per-product progress and preserves balance when detail was skipped", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /CHECKING_PROVIDER_BALANCE/u);
  assert.match(script, /CHECKING_EXACT_WALMART_ITEM/u);
  assert.match(script, /CHECKING_EXACT_PRODUCT_CONTENT/u);
  assert.match(script, /VERIFYING_EXACT_PRODUCT_DATA/u);
  assert.match(script, /inspectCurrentEnrichmentStage/u);
  assert.match(script, /progress: input\.progress/u);
  assert.match(
    script,
    /else if \(!detailCalled\)[\s\S]*current[\s\S]*balance observation[\s\S]*remains/u,
  );
});

test("worker reports the structured control API error code without response details", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /returned HTTP \$\{response\.status\}\$\{code\}/u);
  assert.doesNotMatch(script, /JSON\.stringify\(value\)/u);
});

test("worker verifies runner artifacts with the canonical Product Truth renderer", async () => {
  const contract = await readFile(
    new URL("../product-truth-web-control-worker-contract.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    contract,
    /text !== renderProductTruthOperationalJson\(request\)/u,
  );
  assert.match(
    contract,
    /text !== renderProductTruthOperationalJson\(plan\)/u,
  );
  assert.doesNotMatch(
    contract,
    /text !== `\$\{JSON\.stringify\((?:request|plan)\)\}\\n`/u,
  );
});

test("metered completion preserves an ambiguous paid outcome as terminal ambiguous", async () => {
  const server = await readFile(
    new URL("../product-truth-web-control-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    server,
    /result\.status === "AMBIGUOUS"\s*\?\s*"AMBIGUOUS"/u,
  );
  assert.match(
    server,
    /terminalStatus === "AMBIGUOUS"[\s\S]*executionBoundary: "UNKNOWN"/u,
  );
});

test("worker start commits the execution boundary with a remote-safe atomic batch", async () => {
  const server = await readFile(
    new URL("../product-truth-web-control-worker.ts", import.meta.url),
    "utf8",
  );
  const startAt = server.indexOf(
    "export async function startProductTruthNoSpendCommand",
  );
  const heartbeatAt = server.indexOf(
    "export async function heartbeatProductTruthNoSpendCommand",
    startAt,
  );
  assert.ok(startAt >= 0);
  assert.ok(heartbeatAt > startAt);
  const start = server.slice(startAt, heartbeatAt);
  assert.match(start, /await prisma\.\$transaction\(\[/u);
  assert.match(start, /productTruthControlCommand\.update/u);
  assert.match(start, /productTruthControlEvent\.create/u);
  assert.doesNotMatch(start, /\$transaction\(async/u);
  assert.match(start, /row\.status === "RUNNING"/u);
});

test("worker heartbeat uses a remote-safe lease CAS before its audit append", async () => {
  const server = await readFile(
    new URL("../product-truth-web-control-worker.ts", import.meta.url),
    "utf8",
  );
  const heartbeatAt = server.indexOf(
    "export async function heartbeatProductTruthNoSpendCommand",
  );
  const completeAt = server.indexOf(
    "export async function completeProductTruthNoSpendCommand",
    heartbeatAt,
  );
  assert.ok(heartbeatAt >= 0);
  assert.ok(completeAt > heartbeatAt);
  const heartbeat = server.slice(heartbeatAt, completeAt);
  assert.match(heartbeat, /productTruthControlCommand\.updateMany/u);
  assert.match(heartbeat, /updated\.count !== 1/u);
  assert.match(heartbeat, /await appendWorkerEvent\(prisma/u);
  assert.match(heartbeat, /eventType: "HEARTBEAT"/u);
  assert.doesNotMatch(heartbeat, /\$transaction\(/u);
});

test("worker completion is content-addressed, idempotent, and uses no remote transaction", async () => {
  const server = await readFile(
    new URL("../product-truth-web-control-worker.ts", import.meta.url),
    "utf8",
  );
  const completeAt = server.indexOf(
    "export async function completeProductTruthNoSpendCommand",
  );
  assert.ok(completeAt >= 0);
  const completion = server.slice(completeAt);
  assert.match(completion, /persistWorkerTerminalState/u);
  assert.doesNotMatch(completion, /\$transaction\(/u);
  const persistenceAt = server.indexOf("async function persistWorkerTerminalState");
  const buildClaimAt = server.indexOf("function buildClaimSpec", persistenceAt);
  assert.ok(persistenceAt >= 0);
  assert.ok(buildClaimAt > persistenceAt);
  const persistence = server.slice(persistenceAt, buildClaimAt);
  assert.match(persistence, /const statements: InStatement\[\]/u);
  assert.match(persistence, /UPDATE "ProductTruthControlCommand"/u);
  assert.match(persistence, /INSERT INTO "ProductTruthControlArtifact"/u);
  assert.match(persistence, /INSERT INTO "ProductTruthControlEvent"/u);
  assert.match(persistence, /await client\.batch\(statements, "write"\)/u);
  assert.match(persistence, /verifyWorkerTerminalState/u);
  assert.doesNotMatch(persistence, /\$transaction\(/u);
});

test("worker retries only the immutable completion receipt, never provider execution", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  const completeAt = script.indexOf("async function completeClaim");
  const parseClaimAt = script.indexOf("function parseClaim", completeAt);
  assert.ok(completeAt >= 0);
  assert.ok(parseClaimAt > completeAt);
  const completion = script.slice(completeAt, parseClaimAt);
  assert.match(completion, /COMPLETION_ATTEMPTS/u);
  assert.match(completion, /\/complete`/u);
  assert.doesNotMatch(completion, /executeEnrichmentBatch|withMeteredProviderCall/u);
  assert.equal(
    script.match(/executeEnrichmentBatch\(/gu)?.length,
    2,
    "one definition and one execution call are expected",
  );
});

test("proxy reserves Product Truth control routes for the separate worker token", async () => {
  const proxy = await readFile(
    new URL("../../../proxy.ts", import.meta.url),
    "utf8",
  );
  const workerGuardAt = proxy.indexOf(
    'pathname.startsWith("/api/external/product-truth/control/")',
  );
  const genericApiAt = proxy.indexOf(
    'if (pathname.startsWith("/api/"))',
  );
  assert.ok(workerGuardAt >= 0);
  assert.ok(genericApiAt > workerGuardAt);
  assert.match(
    proxy,
    /PRODUCT_TRUTH_WEB_CONTROL_WORKER_TOKEN_SHA256/u,
  );
  assert.match(proxy, /timingSafeEqual/u);
});
