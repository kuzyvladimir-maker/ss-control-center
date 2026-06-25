// Pure-function tests for image-generation. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-generation.test.ts
//
// Covers prompt augmentation on retry + the stubbed Codex-worker path (so
// no live worker / network is exercised here). Live integration is covered
// by scripts/smoke-image-pipeline.ts in stub mode.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalPrompt,
  generateMainImage,
} from "../image-generation";

type CodexStub = (args: { prompt: string; size?: string }) => Promise<Buffer>;
const STUB_KEY = "__SS_CODEX_IMAGE_STUB__";
function setStub(fn: CodexStub | undefined) {
  if (fn) (globalThis as Record<string, unknown>)[STUB_KEY] = fn;
  else delete (globalThis as Record<string, unknown>)[STUB_KEY];
}

// 1×1 transparent PNG — enough bytes for the upload/data-URL path.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

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

test("generateMainImage — dev-mock when worker unconfigured + no stub", async () => {
  const priorUrl = process.env.CODEX_IMAGE_WORKER_URL;
  const priorTok = process.env.CODEX_IMAGE_WORKER_TOKEN;
  delete process.env.CODEX_IMAGE_WORKER_URL;
  delete process.env.CODEX_IMAGE_WORKER_TOKEN;
  setStub(undefined);
  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.mock_mode, true);
    assert.equal(out.cost_cents, 0);
    assert.ok(out.image_url && out.image_url.startsWith("https://"));
    assert.equal(out.error, undefined);
  } finally {
    if (priorUrl) process.env.CODEX_IMAGE_WORKER_URL = priorUrl;
    if (priorTok) process.env.CODEX_IMAGE_WORKER_TOKEN = priorTok;
  }
});

test("generateMainImage — happy path via stub returns data: URL when R2 unconfigured", async () => {
  setStub(async () => TINY_PNG);

  const priorR2Account = process.env.R2_ACCOUNT_ID;
  const priorR2Public = process.env.R2_PUBLIC_URL;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_PUBLIC_URL;

  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.mock_mode, false);
    // Subscription path is free — cost is always 0 now.
    assert.equal(out.cost_cents, 0);
    assert.ok(
      out.image_url && out.image_url.startsWith("data:image/png;base64,"),
      `expected data: URL fallback, got ${out.image_url}`,
    );
    assert.match(out.error ?? "", /R2 not configured/);
  } finally {
    setStub(undefined);
    if (priorR2Account) process.env.R2_ACCOUNT_ID = priorR2Account;
    if (priorR2Public) process.env.R2_PUBLIC_URL = priorR2Public;
  }
});

test("generateMainImage — worker error via stub → error result, no URL", async () => {
  setStub(async () => {
    throw new Error("worker exploded");
  });
  try {
    const out = await generateMainImage(BASE_INPUT);
    assert.equal(out.image_url, null);
    assert.equal(out.cost_cents, 0);
    assert.match(out.error ?? "", /worker exploded/);
  } finally {
    setStub(undefined);
  }
});
