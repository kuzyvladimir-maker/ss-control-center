/**
 * Render-runner tests: injectable renderer/fetcher, no network, no worker.
 * Run: npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-render-runner.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  renderUncrustablesMainCandidate,
  MIN_MAIN_DIMENSION_PX,
} from "../uncrustables-render-runner";

function pngOf(width: number, height: number): Buffer {
  // Минимальный валидный заголовок PNG: сигнатура + IHDR c размерами.
  const bytes = Buffer.alloc(64, 0);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const REQUEST = {
  slug: "test-slug",
  prompt: "prompt",
  referenceUrls: ["https://refs.example/r1.png"],
  r2Prefix: "studio",
};

test("success: url + sha256 + dims + model, r2 path prefixed", async () => {
  const png = pngOf(2048, 2048);
  let renderedPath = "";
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async (input) => {
      renderedPath = input.r2_path_slug;
      return {
        image_url: "https://pub.r2.dev/studio-test-slug/main.png",
        cost_cents: 0,
        prompt_used: input.prompt,
        mock_mode: false,
        model: "image_gen",
        reference_count: 1,
        error: undefined,
      } as never;
    },
    fetchBytes: async () => png,
  });
  assert.equal(renderedPath, "studio-test-slug");
  assert.ok(result.ok);
  assert.equal(
    result.imageSha256,
    createHash("sha256").update(png).digest("hex"),
  );
  assert.deepEqual(result.pixelDimensions, { width: 2048, height: 2048 });
  assert.equal(result.model, "image_gen");
});

test("worker 502 → WORKER_ERROR, no throw", async () => {
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async () => {
      throw new Error("Codex worker HTTP 502");
    },
    fetchBytes: async () => pngOf(2048, 2048),
  });
  assert.ok(!result.ok && result.code === "WORKER_ERROR");
  assert.match(result.error, /502/);
});

test("worker null url → WORKER_NO_IMAGE with worker's error text", async () => {
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async () =>
      ({
        image_url: null,
        error: "codex produced no image",
      }) as never,
    fetchBytes: async () => pngOf(2048, 2048),
  });
  assert.ok(!result.ok && result.code === "WORKER_NO_IMAGE");
  assert.match(result.error, /no image/);
});

test("postcheck: non-PNG bytes rejected", async () => {
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async () =>
      ({ image_url: "https://pub.r2.dev/x/main.png", error: undefined }) as never,
    fetchBytes: async () => Buffer.from("not a png"),
  });
  assert.ok(!result.ok && result.code === "POSTCHECK_NOT_PNG");
});

test(`postcheck: below ${MIN_MAIN_DIMENSION_PX}px rejected`, async () => {
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async () =>
      ({ image_url: "https://pub.r2.dev/x/main.png", error: undefined }) as never,
    fetchBytes: async () => pngOf(1536, 1536),
  });
  assert.ok(!result.ok && result.code === "POSTCHECK_TOO_SMALL");
});

test("postcheck: fetch failure surfaces as POSTCHECK_FETCH_FAILED with url kept", async () => {
  const result = await renderUncrustablesMainCandidate(REQUEST, {
    render: async () =>
      ({ image_url: "https://pub.r2.dev/x/main.png", error: undefined }) as never,
    fetchBytes: async () => {
      throw new Error("R2 returned HTTP 500.");
    },
  });
  assert.ok(!result.ok && result.code === "POSTCHECK_FETCH_FAILED");
  assert.equal(result.imageUrl, "https://pub.r2.dev/x/main.png");
});
