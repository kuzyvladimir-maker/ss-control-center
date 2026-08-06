/**
 * Customer Hub translator — provides EN↔RU translation for customer
 * messages and AI-generated responses so Vladimir can read and edit both
 * sides without leaving the app. Uses the same AI provider chain as the
 * analyzer (Claude primary, OpenAI fallback).
 *
 * Translations are cached in BuyerMessage (customerMessageRu,
 * suggestedResponseRu, editedResponseRu). The canonical language for
 * anything we send to Amazon customers is English — Russian is strictly
 * a working language for the operator.
 */

import { completeWithSubscription } from "@/lib/llm/subscription";
import { getAIConfig } from "@/lib/ai-config";

export type TranslateDirection = "en-ru" | "ru-en";

function buildPrompt(text: string, direction: TranslateDirection): string {
  const isEnToRu = direction === "en-ru";
  const sourceLabel = isEnToRu ? "English" : "Russian";
  const targetLabel = isEnToRu ? "Russian" : "English";

  // Tight prompt: the model MUST return only the translation, no preamble,
  // no quotes, no explanations. Preserve Markdown / line breaks / greetings
  // verbatim in structure, translate only the natural-language content.
  return `Translate the following ${sourceLabel} text into ${targetLabel}.

RULES:
- Preserve all line breaks, paragraph structure, and any markdown formatting.
- Preserve product names, tracking numbers, order IDs, carrier names, and dates verbatim.
- Use a natural, professional tone appropriate for Amazon customer service correspondence.
- Do NOT add any commentary, quotes, preamble, or explanation.
- Return ONLY the translated text.

TEXT TO TRANSLATE:
${text}`;
}

async function callClaude(prompt: string): Promise<string> {
  const { text } = await completeWithSubscription({ prompt, lanes: ["claude"] });
  return text;
}

async function callOpenAI(prompt: string): Promise<string> {
  const { text } = await completeWithSubscription({ prompt, lanes: ["codex"] });
  return text;
}

/**
 * Translate a single piece of text. Returns null on total failure (missing
 * keys, all providers down) so callers can gracefully leave the cached
 * field null and retry later.
 */
export async function translateText(
  text: string,
  direction: TranslateDirection
): Promise<string | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const config = await getAIConfig();
  if (config.providerChain.length === 0) {
    console.warn(
      "[Translator] No AI providers configured — skipping translation"
    );
    return null;
  }

  const prompt = buildPrompt(trimmed, direction);

  for (const provider of config.providerChain) {
    try {
      const raw =
        provider === "claude"
          ? await callClaude(prompt)
          : await callOpenAI(prompt);
      const cleaned = raw.trim();
      if (cleaned) {
        return cleaned;
      }
    } catch (e) {
      console.warn(
        `[Translator] ${provider} translation failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  console.error("[Translator] All providers failed for translation");
  return null;
}
