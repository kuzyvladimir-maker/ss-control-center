/**
 * The rule this file defends: no paid API, ever, not even as a fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  completeJsonWithSubscription,
  completeWithSubscription,
  completionEndpoint,
  SubscriptionLlmUnavailable,
} from "../subscription";

const URL_ENV = "CODEX_IMAGE_WORKER_URL";
const TOKEN_ENV = "CODEX_IMAGE_WORKER_TOKEN";

function withWorker<T>(run: () => T): T {
  const url = process.env[URL_ENV];
  const token = process.env[TOKEN_ENV];
  process.env[URL_ENV] = "https://box.example/codex-image/generate";
  process.env[TOKEN_ENV] = "test-token";
  try {
    return run();
  } finally {
    if (url === undefined) delete process.env[URL_ENV];
    else process.env[URL_ENV] = url;
    if (token === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = token;
  }
}

const ok = (text: string) =>
  (async () => new Response(JSON.stringify({ ok: true, text, model: "sonnet" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

test("the completion endpoint is derived from the image worker's URL", () => {
  assert.equal(
    completionEndpoint("https://box.example/codex-image/generate"),
    "https://box.example/codex-image/complete",
  );
  assert.equal(
    completionEndpoint("https://box.example/codex-image/generate/"),
    "https://box.example/codex-image/complete",
  );
});

test("a completion always reports zero cost", async () => {
  const result = await withWorker(() =>
    completeWithSubscription({ prompt: "hi", fetchImpl: ok("ready") }));
  assert.equal(result.text, "ready");
  assert.equal(result.costCents, 0);
});

test("the request carries the bearer token and the prompt", async () => {
  let seenUrl = "";
  let seenInit: { headers: Record<string, string>; body: string } | null = null;
  const spy = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenInit = init as unknown as { headers: Record<string, string>; body: string };
    return new Response(JSON.stringify({ ok: true, text: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  await withWorker(() =>
    completeWithSubscription({ prompt: "brief", system: "rules", fetchImpl: spy }));
  assert.match(seenUrl, /\/complete$/);
  const init = seenInit as unknown as { headers: Record<string, string>; body: string };
  assert.equal(init.headers.authorization, "Bearer test-token");
  const body = JSON.parse(init.body) as { prompt: string; system: string };
  assert.equal(body.prompt, "brief");
  assert.equal(body.system, "rules");
});

test("an unreachable worker fails — it does not fall back to a paid API", async () => {
  const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  await assert.rejects(
    () => withWorker(() => completeWithSubscription({ prompt: "hi", fetchImpl: dead })),
    (error: unknown) => {
      assert.ok(error instanceof SubscriptionLlmUnavailable);
      assert.match(error.message, /could not be reached/);
      return true;
    },
  );
});

test("a missing worker configuration says there is no fallback", async () => {
  const url = process.env[URL_ENV];
  delete process.env[URL_ENV];
  try {
    await assert.rejects(
      () => completeWithSubscription({ prompt: "hi" }),
      /does not use paid API keys/,
    );
  } finally {
    if (url !== undefined) process.env[URL_ENV] = url;
  }
});

test("JSON is taken from inside prose or a fenced block", async () => {
  const wrapped = 'Here you go:\n```json\n{"a":1,"b":"two"}\n```\nHope that helps.';
  const parsed = await withWorker(() =>
    completeJsonWithSubscription<{ a: number; b: string }>({
      prompt: "hi",
      fetchImpl: ok(wrapped),
    }));
  assert.deepEqual(parsed, { a: 1, b: "two" });
});

test("an answer with no JSON object is refused, not guessed at", async () => {
  await assert.rejects(
    () => withWorker(() => completeJsonWithSubscription({ prompt: "hi", fetchImpl: ok("no json here") })),
    /did not return a JSON object/,
  );
});
