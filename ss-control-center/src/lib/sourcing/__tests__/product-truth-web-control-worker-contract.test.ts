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

test("worker script uses spawn shell:false and cannot invoke metered commands", async () => {
  const script = await readFile(
    new URL("../../../../scripts/product-truth-web-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /spawn\(process\.execPath/u);
  assert.match(script, /shell:\s*false/u);
  assert.doesNotMatch(script, /["'](?:execute|resume|backfill-apply|migrations-apply)["']/u);
  assert.doesNotMatch(script, /execSync|execFileSync|spawnSync|shell:\s*true/u);
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
