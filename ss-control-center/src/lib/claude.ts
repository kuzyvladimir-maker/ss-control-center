/**
 * Read screenshots and get JSON back.
 *
 * Was a direct Anthropic SDK client on a paid key; since 2026-08-06 the
 * platform holds no paid API tokens, so this runs on Vladimir's Claude Max
 * subscription through the box worker. The worker parses the model's JSON, so
 * what used to be regex-hunting for a `{…}` block now arrives as an object.
 *
 * Claude only, deliberately: callers of this helper want the stronger reader.
 * For work that should survive an exhausted Claude limit, use
 * `analyzeImagesWithFallback` in `ai-vision.ts`, which tries ChatGPT Pro next.
 */

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";

export async function analyzeScreenshots(
  base64Images: string[],
  systemPrompt: string,
): Promise<Record<string, unknown>> {
  const result = await identifyImageViaClaudeCli(base64Images, systemPrompt);
  if (!result) {
    throw new Error(
      "The Claude subscription vision lane did not answer. This platform does "
      + "not use paid API keys, so there is no fallback here — see "
      + "analyzeImagesWithFallback for the two-lane version.",
    );
  }
  return result;
}
