/**
 * AI vision helper — analyze one or more base64-encoded screenshots on
 * Vladimir's subscriptions, Claude Max first and ChatGPT Pro behind it.
 * Both lanes return a JSON object matching the schema in systemPrompt; the
 * box worker does the parsing, so nothing here touches a provider SDK.
 *
 * Usage:
 *   const result = await analyzeImagesWithFallback(images, WALMART_PROMPT);
 *
 * Throws only if BOTH subscriptions fail. One lane's error is logged and
 * swallowed so the other gets its turn — an exhausted monthly limit on one
 * subscription must not take vision down.
 */

import {
  identifyImageViaClaudeCli,
  identifyImageViaCodex,
} from "@/lib/image-gen/codex-worker";
import { getAIConfig } from "@/lib/ai-config";

/**
 * Both vision lanes ride subscriptions on the box worker — Claude Max via
 * `/analyze-claude`, ChatGPT Pro via `/analyze`. The paid SDK path was removed
 * on 2026-08-06 (owner instruction: no paid API tokens, ever).
 *
 * The worker returns a parsed JSON object, so the JSON-extraction the SDK path
 * had to do here now happens on the box.
 */
export async function analyzeImagesWithFallback(
  base64Images: string[],
  systemPrompt: string,
): Promise<unknown> {
  const config = await getAIConfig();
  if (config.providerChain.length === 0) {
    throw new Error(
      "No AI providers configured. Check the provider chain in Settings; both "
      + "lanes run on the box worker's subscriptions, not on API keys.",
    );
  }

  let lastError = "";
  for (const provider of config.providerChain) {
    try {
      console.log(`[AI-Vision] Trying ${provider} on its subscription…`);
      const result = provider === "claude"
        ? await identifyImageViaClaudeCli(base64Images, systemPrompt)
        : await identifyImageViaCodex(base64Images, systemPrompt);
      if (result) {
        console.log(`[AI-Vision] Success with ${provider}`);
        return result;
      }
      lastError = `${provider} returned nothing`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    console.error(`[AI-Vision] ${provider} failed: ${lastError}`);
  }

  throw new Error(`No subscription vision lane answered. Last error: ${lastError}`);
}
