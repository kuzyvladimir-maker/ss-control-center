// Pure-function tests for image-generation. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-generation.test.ts
//
// Covers prompt augmentation on retry + stubbed OpenAI path (so the
// real OpenAI call is never exercised here). Live OpenAI integration is
// covered by scripts/smoke-image-pipeline.ts in mock mode.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalPrompt,
  generateMainImage,
} from "../image-generation";

const BASE_INPUT = {
  prompt: "Photograph of a gift basket with shelf-stable snacks.",
  r2_path_slug: "draft-abc-amazon-salutem",
};

test("buildFinalPrompt — first attempt returns prompt unchanged", () => {
  const out = buildFinalPrompt({
    ...BASE_INPUT,
    retry_context: { attempt: 1 },
  });
  assert.equal(out, BASE_INPUT.prompt);
});

test("buildFinalPrompt — retry with no context returns base prompt", () => {
  const out = buildFinalPrompt(BASE_INPUT);
  assert.equal(out, BASE_INPUT.prompt);
});

test("buildFinalPrompt — retry with detected_logos appends ban list", () => {
  const out = buildFinalPrompt({
    ...BASE_INPUT,
    retry_context: {
      attempt: 2,
      detected_logos: ["Oscar Mayer", "Cheez-It"],
    },
  });
  assert.ok(out.includes(BASE_INPUT.prompt));
  assert.match(out, /CRITICAL/);
  assert.match(out, /"Oscar Mayer"/);
  assert.match(out, /"Cheez-It"/);
  assert.match(out, /entirely generic, unbranded packaging/i);
});

test("buildFinalPrompt — retry with failure_reason but no logos still warns", () => {
  const out = buildFinalPrompt({
    ...BASE_INPUT,
    retry_context: {
      attempt: 3,
      failure_reason: "image_vision_error",
    },
  });
  assert.match(out, /Previous attempt failed/i);
  assert.match(out, /image_vision_error/);
});

test("buildFinalPrompt — never contains promo language even after augmentation", () => {
  const out = buildFinalPrompt({
    ...BASE_INPUT,
    retry_context: {
      attempt: 2,
      detected_logos: ["Salutem"],
    },
  });
  for (const word of [
    "perfect",
    "ultimate",
    "amazing",
    "premium",
    "delicious",
    "incredible",
  ]) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, "i").test(out),
      `prompt contains promo word "${word}": ${out}`,
    );
  }
});

// ── generateMainImage — dev-mock + stub paths ──────────────────────────

test("generateMainImage — dev-mock when no client + no stub", async () => {
  // Snapshot + unset OPENAI_API_KEY for this test.
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const stub = (
    globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown }
  ).__BUNDLE_FACTORY_OPENAI_STUB__;
  delete (globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown })
    .__BUNDLE_FACTORY_OPENAI_STUB__;
  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.mock_mode, true);
    assert.equal(out.cost_cents, 0);
    assert.ok(out.image_url && out.image_url.startsWith("https://"));
    assert.equal(out.error, undefined);
  } finally {
    if (prior) process.env.OPENAI_API_KEY = prior;
    if (stub)
      (
        globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown }
      ).__BUNDLE_FACTORY_OPENAI_STUB__ = stub;
  }
});

test("generateMainImage — happy path via stub returns data: URL when R2 unconfigured", async () => {
  // Stub OpenAI to return a tiny base64 PNG (1×1 transparent).
  const tinyPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const stub = {
    images: {
      generate: async () => ({
        data: [{ b64_json: tinyPng }],
      }),
    },
  };
  (
    globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown }
  ).__BUNDLE_FACTORY_OPENAI_STUB__ = stub;

  // Ensure R2 not configured for this test.
  const priorR2Account = process.env.R2_ACCOUNT_ID;
  const priorR2Public = process.env.R2_PUBLIC_URL;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_PUBLIC_URL;

  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.mock_mode, false);
    assert.ok(out.cost_cents > 0, `expected cost_cents > 0, got ${out.cost_cents}`);
    assert.ok(
      out.image_url && out.image_url.startsWith("data:image/png;base64,"),
      `expected data: URL fallback, got ${out.image_url}`,
    );
    // R2-not-configured carries an info error string, not a hard failure.
    assert.match(out.error ?? "", /R2 not configured/);
  } finally {
    delete (globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown })
      .__BUNDLE_FACTORY_OPENAI_STUB__;
    if (priorR2Account) process.env.R2_ACCOUNT_ID = priorR2Account;
    if (priorR2Public) process.env.R2_PUBLIC_URL = priorR2Public;
  }
});

test("generateMainImage — OpenAI throw → error result, no URL", async () => {
  const stub = {
    images: {
      generate: async () => {
        throw new Error("rate limited");
      },
    },
  };
  (
    globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown }
  ).__BUNDLE_FACTORY_OPENAI_STUB__ = stub;
  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.image_url, null);
    assert.equal(out.cost_cents, 0);
    assert.match(out.error ?? "", /rate limited/);
  } finally {
    delete (globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown })
      .__BUNDLE_FACTORY_OPENAI_STUB__;
  }
});

test("generateMainImage — empty data array → error", async () => {
  const stub = {
    images: {
      generate: async () => ({ data: [] }),
    },
  };
  (
    globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown }
  ).__BUNDLE_FACTORY_OPENAI_STUB__ = stub;
  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.image_url, null);
    assert.match(out.error ?? "", /no image data/);
  } finally {
    delete (globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: unknown })
      .__BUNDLE_FACTORY_OPENAI_STUB__;
  }
});
