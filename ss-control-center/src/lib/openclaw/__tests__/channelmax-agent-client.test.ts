// node --import tsx --test src/lib/openclaw/__tests__/channelmax-agent-client.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenClawChannelMaxAgentClient,
  OpenClawChannelMaxClientError,
  buildChannelMaxTaskEnvelope,
  extractOpenClawResponseText,
  parseOpenClawSseText,
  redactChannelMaxSecrets,
  type FetchLike,
} from "@/lib/openclaw/channelmax-agent-client";

const GATEWAY_TOKEN = "gateway-secret-never-log";
const APPROVAL_TOKEN = "one-time-approval-never-log";
const PLAN_SHA = "a".repeat(64);

function client(fetchImpl: FetchLike): OpenClawChannelMaxAgentClient {
  return new OpenClawChannelMaxAgentClient({
    gatewayUrl: "http://127.0.0.1:18789/",
    gatewayToken: GATEWAY_TOKEN,
    fetchImpl,
    now: () => new Date("2026-07-18T20:00:00.000Z"),
    newJobId: () => "generated-job-001",
    timeoutMs: 2_000,
  });
}

async function assertDispatchDisabled(
  promise: Promise<unknown>,
  action: string,
  jobId: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OpenClawChannelMaxClientError);
    assert.equal(error.code, "DIRECT_DISPATCH_DISABLED");
    assert.equal(error.jobId, jobId);
    assert.match(error.message, new RegExp(`ChannelMAX ${action} dispatch is disabled`));
    assert.match(error.message, /durable SS Command Center ChannelMAX queue job/i);
    return true;
  });
}

test("all legacy direct ChannelMAX actions fail before network dispatch", async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return Response.json({ should_not: "run" });
  });

  await assertDispatchDisabled(api.audit(), "audit", "generated-job-001");
  await assertDispatchDisabled(
    api.prepare({ jobId: "workflow-42", request: { target: "Manual model" } }),
    "prepare",
    "workflow-42",
  );
  await assertDispatchDisabled(
    api.status({ jobId: "workflow-42" }),
    "status",
    "workflow-42",
  );
  await assertDispatchDisabled(
    api.commit({
      jobId: "workflow-42",
      planSha256: PLAN_SHA,
      approvalToken: APPROVAL_TOKEN,
    }),
    "commit",
    "workflow-42",
  );
  assert.equal(calls, 0);
});

test("invalid job ids still fail closed before dispatch", () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return Response.json({ should_not: "run" });
  });
  assert.throws(
    () => api.status({ jobId: "not valid because spaces" }),
    (error: unknown) =>
      error instanceof OpenClawChannelMaxClientError &&
      error.code === "INVALID_INPUT",
  );
  assert.equal(calls, 0);
});

test("pure SSE parser and response-text extractor remain available", () => {
  assert.deepEqual(
    parseOpenClawSseText(
      "event: custom\r\ndata: first\r\ndata: second\r\n\r\n",
    ),
    [{ event: "custom", data: "first\nsecond" }],
  );
  assert.equal(
    extractOpenClawResponseText({
      output: [
        { content: [{ type: "output_text", text: "one" }] },
        { text: " two" },
      ],
    }),
    "one two",
  );
  assert.equal(extractOpenClawResponseText({ output_text: "direct" }), "direct");
});

test("pure envelope builder still enforces authorization boundaries", () => {
  assert.throws(
    () =>
      buildChannelMaxTaskEnvelope({
        action: "audit",
        jobId: "job-1",
        requestedAt: "2026-07-18T20:00:00.000Z",
        planSha256: PLAN_SHA,
      }),
    /read-only/,
  );
  const commit = buildChannelMaxTaskEnvelope({
    action: "commit",
    jobId: "job-1",
    requestedAt: "2026-07-18T20:00:00.000Z",
    planSha256: PLAN_SHA,
    approvalToken: APPROVAL_TOKEN,
  });
  assert.equal(commit.mode, "COMMIT_EXACT_PLAN");
  assert.notEqual(commit.authorization?.approval_token_sha256, APPROVAL_TOKEN);
});

test("secret redaction remains available to legacy output consumers", () => {
  assert.deepEqual(
    redactChannelMaxSecrets(
      { authorization: `Bearer ${GATEWAY_TOKEN}`, nested: { password: "x" } },
      [GATEWAY_TOKEN],
    ),
    { authorization: "[REDACTED]", nested: { password: "[REDACTED]" } },
  );
});

test("constructor validates Gateway transport even though dispatch is retired", () => {
  assert.throws(
    () =>
      new OpenClawChannelMaxAgentClient({
        gatewayUrl: "http://openclaw.example:18789",
        gatewayToken: GATEWAY_TOKEN,
      }),
    /remote gateways require HTTPS/,
  );
  assert.doesNotThrow(
    () =>
      new OpenClawChannelMaxAgentClient({
        gatewayUrl: "https://openclaw.example",
        gatewayToken: GATEWAY_TOKEN,
      }),
  );
});
