import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { test } from "node:test";

import {
  CHANNELMAX_VC_CDP_ADAPTER_RELEASED,
  CHANNELMAX_VC_CDP_BLOCKERS,
  CHANNELMAX_VC_CDP_INTERFACE_PLAN,
  CHANNELMAX_VC_REVIEWED_DOM_CONTRACT,
  ChannelMaxVcCdpAdapterError,
  ChannelMaxVcCdpBrowserAdapter,
  channelMaxVcCdpAdapterReadiness,
  withPreparedChannelMaxVcArtifact,
} from "../uncrustables-same-model-cdp-adapter";
import {
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_PRODUCTION_READY,
  channelMaxVcCanaryArtifact,
} from "../uncrustables-same-model-canary";

function exactError(code: string, interfaceName?: string) {
  return (error: unknown) =>
    error instanceof ChannelMaxVcCdpAdapterError &&
    error.code === code &&
    (interfaceName === undefined || error.interfaceName === interfaceName);
}

test("finite CDP plan is exact-target and hard disabled without reviewed DOM evidence", () => {
  const readiness = channelMaxVcCdpAdapterReadiness();
  assert.equal(readiness.production_ready, false);
  assert.equal(readiness.state_machine_release_gate, false);
  assert.equal(readiness.adapter_release_gate, false);
  assert.equal(CHANNELMAX_VC_CANARY_PRODUCTION_READY, false);
  assert.equal(CHANNELMAX_VC_CDP_ADAPTER_RELEASED, false);
  assert.equal(CHANNELMAX_VC_REVIEWED_DOM_CONTRACT, null);
  assert.deepEqual(readiness.blockers, CHANNELMAX_VC_CDP_BLOCKERS);
  assert.deepEqual(readiness.target, {
    account_id: "channelmax:amznus:salutem-solutions",
    host: "selling.channelmax.net",
    selected_site_id: "300",
    selected_site_name: "AmznUS [Salutem Solutions]",
    sku: "VC-ASV1-378P",
    asin: "B0H786L5MW",
  });
});

test("file-input plan can call only hardened upload_file with the two exact one-row hashes", () => {
  const plan = CHANNELMAX_VC_CDP_INTERFACE_PLAN.exact_file_input;
  assert.deepEqual(plan.cdp_commands, ["upload_file"]);
  assert.equal(plan.selector, null);
  assert.deepEqual(plan.required_cli_options, [
    "--allowed-root",
    "--expected-sha256",
  ]);
  assert.equal(plan.exact_byte_size, 103);
  assert.deepEqual(plan.allowed_sha256, [
    CHANNELMAX_VC_CANARY.forward.assignment_sha256,
    CHANNELMAX_VC_CANARY.rollback.assignment_sha256,
  ]);
  assert.equal(CHANNELMAX_VC_CDP_INTERFACE_PLAN.single_submit.maximum_calls, 1);
  assert.equal(
    CHANNELMAX_VC_CDP_INTERFACE_PLAN.single_submit.retry_after_possible_click,
    false,
  );
  assert.equal(CHANNELMAX_VC_CDP_INTERFACE_PLAN.analyze_preview.expected_rows, 1);
  assert.equal(
    CHANNELMAX_VC_CDP_INTERFACE_PLAN.row_readback.expected_sku,
    "VC-ASV1-378P",
  );
  assert.equal(
    CHANNELMAX_VC_CDP_INTERFACE_PLAN.row_readback.expected_asin,
    "B0H786L5MW",
  );
});
test("exact artifact workspace is 0600, hash-pinned, isolated, and removed", async () => {
  const sealed = channelMaxVcCanaryArtifact("FORWARD");
  let root = "";
  let path = "";
  const result = await withPreparedChannelMaxVcArtifact(
    {
      bytes: sealed.bytes,
      sha256: sealed.sha256,
      direction: "FORWARD",
    },
    async (artifact) => {
      root = artifact.root;
      path = artifact.path;
      assert.equal(artifact.sha256, sealed.sha256);
      assert.equal(artifact.byteSize, 103);
      assert.ok(artifact.path.startsWith(`${artifact.root}/`));
      assert.deepEqual(await readFile(artifact.path), sealed.bytes);
      assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
      return "callback-completed";
    },
  );
  assert.equal(result, "callback-completed");
  await assert.rejects(access(path));
  await assert.rejects(access(root));
});

test("artifact workspace rejects tampering before creating any workspace", async () => {
  const sealed = channelMaxVcCanaryArtifact("FORWARD");
  const tampered = Buffer.from(sealed.bytes);
  tampered[tampered.byteLength - 3] ^= 1;
  await assert.rejects(
    withPreparedChannelMaxVcArtifact(
      {
        bytes: tampered,
        sha256: sealed.sha256,
        direction: "FORWARD",
      },
      () => undefined,
    ),
    exactError("SEALED_ARTIFACT_MISMATCH", "EXACT_FILE_INPUT"),
  );
});

test("browser-port skeleton validates exact bytes, then stops before CDP", async () => {
  const adapter = new ChannelMaxVcCdpBrowserAdapter();
  const sealed = channelMaxVcCanaryArtifact("ROLLBACK");
  await assert.rejects(
    adapter.analyzeExactArtifact({
      bytes: sealed.bytes,
      sha256: sealed.sha256,
      direction: "ROLLBACK",
    }),
    exactError("PINNED_DOM_CONTRACT_MISSING", "ANALYZE_PREVIEW"),
  );
  await assert.rejects(
    adapter.submitAnalyzedFileOnce(),
    exactError("PINNED_DOM_CONTRACT_MISSING", "SINGLE_SUBMIT"),
  );
  await assert.rejects(
    adapter.verifyUploadTask("CM-VC-327781"),
    exactError("PINNED_DOM_CONTRACT_MISSING", "TASK_RECEIPT"),
  );
  await assert.rejects(
    adapter.snapshot("FORWARD", "PREWRITE", null),
    exactError("PINNED_DOM_CONTRACT_MISSING", "ROW_READBACK"),
  );
});

test("browser-port skeleton rejects wrong artifact, task ID, and readback binding first", async () => {
  const adapter = new ChannelMaxVcCdpBrowserAdapter();
  const forward = channelMaxVcCanaryArtifact("FORWARD");
  await assert.rejects(
    adapter.analyzeExactArtifact({
      bytes: forward.bytes,
      sha256: CHANNELMAX_VC_CANARY.rollback.assignment_sha256,
      direction: "FORWARD",
    }),
    exactError("SEALED_ARTIFACT_MISMATCH", "EXACT_FILE_INPUT"),
  );
  await assert.rejects(
    adapter.verifyUploadTask("task id with spaces"),
    exactError("UPLOAD_TASK_ID_INVALID", "TASK_RECEIPT"),
  );
  await assert.rejects(
    adapter.snapshot("FORWARD", "PREWRITE", "CM-VC-327781"),
    exactError("ROW_READBACK_BINDING_INVALID", "ROW_READBACK"),
  );
  await assert.rejects(
    adapter.snapshot("FORWARD", "POSTWRITE", null),
    exactError("ROW_READBACK_BINDING_INVALID", "ROW_READBACK"),
  );
});
