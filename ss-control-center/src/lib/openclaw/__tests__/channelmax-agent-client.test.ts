// npx tsx --test src/lib/openclaw/__tests__/channelmax-agent-client.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY,
  OPENCLAW_CHANNELMAX_TASK_SCHEMA,
  OpenClawChannelMaxAgentClient,
  OpenClawChannelMaxClientError,
  buildChannelMaxTaskEnvelope,
  extractOpenClawResponseText,
  parseOpenClawSseText,
  type FetchLike,
} from "@/lib/openclaw/channelmax-agent-client";

const GATEWAY_TOKEN = "gateway-secret-never-log";
const APPROVAL_TOKEN = "one-time-approval-never-log";
const PLAN_SHA = "a".repeat(64);

function outputResponse(text: string, id = "resp_123"): Response {
  return Response.json({
    id,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
  });
}

function decodeRequest(init?: RequestInit): {
  headers: Headers;
  body: Record<string, unknown>;
  envelope: Record<string, unknown>;
} {
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const envelope = JSON.parse(String(body.input)) as Record<string, unknown>;
  return { headers, body, envelope };
}

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

test("audit defaults to a stable read-only session and carries job idempotency", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await client(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return outputResponse("audit complete");
  }).audit({ request: { scope: "164 Uncrustables SKUs" } });

  assert.equal(capturedUrl, "http://127.0.0.1:18789/v1/responses");
  const request = decodeRequest(capturedInit);
  assert.equal(request.headers.get("authorization"), `Bearer ${GATEWAY_TOKEN}`);
  assert.equal(
    request.headers.get("x-openclaw-session-key"),
    DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY,
  );
  assert.equal(request.body.user, DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY);
  assert.equal(request.body.model, "openclaw/channelmax");
  assert.equal(request.body.stream, false);
  assert.equal(request.envelope.schema, OPENCLAW_CHANNELMAX_TASK_SCHEMA);
  assert.equal(request.envelope.job_id, "generated-job-001");
  assert.equal(request.envelope.idempotency_key, "channelmax:audit:generated-job-001");
  assert.equal(request.envelope.mode, "READ_ONLY");
  assert.equal(request.envelope.mutation_authorized, false);
  assert.equal(
    (request.envelope.constraints as Record<string, unknown>).read_only,
    true,
  );
  assert.equal(request.envelope.authorization, null);
  assert.equal(JSON.stringify(request.body).includes(GATEWAY_TOKEN), false);
  assert.equal(result.text, "audit complete");
  assert.equal(result.mode, "READ_ONLY");
});

test("prepare and status remain read-only; status addresses the same job", async () => {
  const envelopes: Record<string, unknown>[] = [];
  const api = client(async (_input, init) => {
    envelopes.push(decodeRequest(init).envelope);
    return outputResponse("ok");
  });

  await api.prepare({ jobId: "workflow-42", request: { target: "Manual model" } });
  await api.status({ jobId: "workflow-42" });

  assert.deepEqual(
    envelopes.map((envelope) => [
      envelope.action,
      envelope.mode,
      envelope.mutation_authorized,
    ]),
    [
      ["prepare", "READ_ONLY", false],
      ["status", "READ_ONLY", false],
    ],
  );
  assert.equal(
    (envelopes[1].request as Record<string, unknown>).status_query_for_job_id,
    "workflow-42",
  );
});

test("commit fails closed without an exact plan hash and approval proof", async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return outputResponse("should not run");
  });

  await assert.rejects(
    api.commit({
      jobId: "job-commit-1",
      planSha256: "bad",
      approvalToken: APPROVAL_TOKEN,
    }),
    (error: unknown) =>
      error instanceof OpenClawChannelMaxClientError &&
      error.code === "INVALID_INPUT" &&
      /64 hexadecimal/.test(error.message),
  );
  await assert.rejects(
    api.commit({
      jobId: "job-commit-1",
      planSha256: PLAN_SHA,
      approvalToken: "",
    }),
    /approvalToken/,
  );
  assert.equal(calls, 0);
});

test("commit sends a plan-bound idempotency key but never serializes raw approval proof", async () => {
  let capturedInit: RequestInit | undefined;
  const result = await client(async (_input, init) => {
    capturedInit = init;
    return outputResponse("committed");
  }).commit({
    jobId: "job-commit-2",
    planSha256: PLAN_SHA.toUpperCase(),
    approvalToken: APPROVAL_TOKEN,
    request: { canary_sku: "QX-AS89-H8YC" },
  });

  const { body, envelope } = decodeRequest(capturedInit);
  const authorization = envelope.authorization as Record<string, unknown>;
  assert.equal(envelope.mode, "COMMIT_EXACT_PLAN");
  assert.equal(envelope.mutation_authorized, true);
  assert.equal(authorization.plan_sha256, PLAN_SHA);
  assert.match(String(authorization.approval_token_sha256), /^[a-f0-9]{64}$/);
  assert.equal(
    envelope.idempotency_key,
    `channelmax:commit:job-commit-2:${PLAN_SHA}`,
  );
  assert.equal(JSON.stringify(body).includes(APPROVAL_TOKEN), false);
  assert.equal(result.mode, "COMMIT_EXACT_PLAN");
});

test("SSE parser and client handle chunk boundaries and emit sanitized events", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: response.created\ndata: {\"response\":{\"id\":\"resp_sse\"}}\n\n",
    "event: response.output_text.delta\ndata: {\"delta\":\"hel",
    "lo\"}\n\nevent: response.output_text.delta\ndata: {\"delta\":\" world\"}\n\n",
    "event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse\",\"output\":[]}}\n\ndata: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const observed: string[] = [];
  const result = await client(async () =>
    new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  ).audit({
    stream: true,
    onEvent: (event) => {
      observed.push(event.event);
    },
  });

  assert.equal(result.transport, "sse");
  assert.equal(result.response_id, "resp_sse");
  assert.equal(result.text, "hello world");
  assert.deepEqual(observed, [
    "response.created",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.completed",
    "message",
  ]);

  const parsed = parseOpenClawSseText(
    "event: custom\r\ndata: first\r\ndata: second\r\n\r\n",
  );
  assert.deepEqual(parsed, [{ event: "custom", data: "first\nsecond" }]);
});

test("HTTP and network errors redact credentials and are never retried automatically", async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: `Authorization: Bearer ${GATEWAY_TOKEN}`,
        approval_token: APPROVAL_TOKEN,
      }),
      { status: 503 },
    );
  });

  await assert.rejects(
    api.commit({
      jobId: "job-no-retry",
      planSha256: PLAN_SHA,
      approvalToken: APPROVAL_TOKEN,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenClawChannelMaxClientError);
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.httpStatus, 503);
      assert.equal(error.message.includes(GATEWAY_TOKEN), false);
      assert.equal(error.message.includes(APPROVAL_TOKEN), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("request payloads containing credential fields or values fail before dispatch", async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return outputResponse("should not run");
  });

  await assert.rejects(
    api.audit({ request: { gateway_token: "something" } }),
    /must not contain credential field/,
  );
  await assert.rejects(
    api.audit({ request: { note: `accidental ${GATEWAY_TOKEN}` } }),
    /contains a credential value/,
  );
  assert.equal(calls, 0);
});

test("timeout aborts one request and requires reconciliation instead of retry", async () => {
  let calls = 0;
  const api = client(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      }),
  );

  await assert.rejects(
    api.commit({
      jobId: "job-timeout",
      planSha256: PLAN_SHA,
      approvalToken: APPROVAL_TOKEN,
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenClawChannelMaxClientError);
      assert.equal(error.code, "TIMEOUT");
      assert.match(error.message, /reconciled by job_id/i);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("response text extraction supports OpenResponses output shapes", () => {
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

test("pure envelope builder rejects commit authorization on read-only actions", () => {
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
});
