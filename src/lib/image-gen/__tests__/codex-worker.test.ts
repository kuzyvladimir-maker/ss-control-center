import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateImagePngViaCodex,
  REQUIRED_CODEX_IMAGE_MODEL,
} from "../codex-worker";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type FetchFn = typeof globalThis.fetch;

async function withWorkerFetch(
  fetchImpl: FetchFn,
  run: () => Promise<void>,
): Promise<void> {
  const priorFetch = globalThis.fetch;
  const priorUrl = process.env.CODEX_IMAGE_WORKER_URL;
  const priorToken = process.env.CODEX_IMAGE_WORKER_TOKEN;
  process.env.CODEX_IMAGE_WORKER_URL = "https://worker.example/generate";
  process.env.CODEX_IMAGE_WORKER_TOKEN = "test-token";
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.CODEX_IMAGE_WORKER_URL;
    else process.env.CODEX_IMAGE_WORKER_URL = priorUrl;
    if (priorToken === undefined) delete process.env.CODEX_IMAGE_WORKER_TOKEN;
    else process.env.CODEX_IMAGE_WORKER_TOKEN = priorToken;
  }
}

test("requires GPT Image 2 and exact staged-reference attestation", async () => {
  await withWorkerFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.required_model, REQUIRED_CODEX_IMAGE_MODEL);
    assert.deepEqual(body.reference_urls, ["https://example.com/anchor.png", "https://example.com/donor.png"]);
    return new Response(TINY_PNG, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-image-model": REQUIRED_CODEX_IMAGE_MODEL,
        "x-image-reference-count": "2",
      },
    });
  }, async () => {
    const result = await generateImagePngViaCodex({
      prompt: "test",
      referenceUrls: [
        "https://example.com/anchor.png",
        "https://example.com/donor.png",
      ],
    });
    assert.ok(result.png);
    assert.equal(result.model, REQUIRED_CODEX_IMAGE_MODEL);
    assert.equal(result.reference_count, 2);
  });
});

test("fails closed when the worker does not attest GPT Image 2", async () => {
  await withWorkerFetch(async () => new Response(TINY_PNG, {
    status: 200,
    headers: { "x-image-reference-count": "0" },
  }), async () => {
    const result = await generateImagePngViaCodex({ prompt: "test" });
    assert.equal(result.png, null);
    assert.match(result.error ?? "", /model attestation missing or invalid/i);
  });
});

test("fails closed when any ordered reference is missing at the worker", async () => {
  await withWorkerFetch(async () => new Response(TINY_PNG, {
    status: 200,
    headers: {
      "x-image-model": REQUIRED_CODEX_IMAGE_MODEL,
      "x-image-reference-count": "1",
    },
  }), async () => {
    const result = await generateImagePngViaCodex({
      prompt: "test",
      referenceUrls: [
        "https://example.com/anchor.png",
        "https://example.com/donor-a.png",
        "https://example.com/donor-b.png",
      ],
    });
    assert.equal(result.png, null);
    assert.match(result.error ?? "", /reference attestation mismatch/i);
  });
});
