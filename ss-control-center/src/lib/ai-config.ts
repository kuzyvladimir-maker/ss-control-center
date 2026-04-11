/**
 * AI Decision Engine runtime configuration.
 *
 * Reads operator-configured preferences from the Setting table:
 *   - ai_primary_provider   "claude" | "openai"   (which one to try first)
 *   - ai_claude_model       Anthropic model ID    (e.g. claude-sonnet-4-20250514)
 *   - ai_openai_model       OpenAI model ID       (e.g. gpt-4o)
 *
 * Falls back to sensible defaults if no Setting row exists. Respects which
 * API keys are actually configured in .env — a provider without a key is
 * removed from the fallback chain regardless of stored priority.
 */

import { prisma } from "@/lib/prisma";

export type ProviderName = "claude" | "openai";

export interface AIConfig {
  // Ordered fallback chain — first is tried first
  providerChain: ProviderName[];
  claudeModel: string;
  openaiModel: string;
  claudeConfigured: boolean;
  openaiConfigured: boolean;
}

// Models the UI lets the operator choose from. Keeping this list in code
// (not DB) so the UI can show a dropdown with known options, but any
// string stored in Setting is still honoured at call time.
export const CLAUDE_MODELS: Array<{ id: string; label: string }> = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 (best quality)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)" },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4 (legacy, currently used)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest, cheapest)" },
];

export const OPENAI_MODELS: Array<{ id: string; label: string }> = [
  { id: "gpt-4o", label: "GPT-4o (default)" },
  { id: "gpt-4o-mini", label: "GPT-4o mini (cheapest)" },
  { id: "gpt-4.1", label: "GPT-4.1 (large context)" },
];

export const DEFAULT_PRIMARY_PROVIDER: ProviderName = "claude";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

export function isClaudeKeyValid(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.startsWith("sk-ant-");
}

export function isOpenAiKeyValid(): boolean {
  const k = process.env.OPENAI_API_KEY;
  return !!k && k.startsWith("sk-");
}

async function readSetting(key: string): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective AI config: operator priority + keys available.
 * Providers without a valid API key are stripped from the chain, so the
 * caller can iterate the result and always get a functioning provider.
 */
export async function getAIConfig(): Promise<AIConfig> {
  const [rawPrimary, rawClaude, rawOpenai] = await Promise.all([
    readSetting("ai_primary_provider"),
    readSetting("ai_claude_model"),
    readSetting("ai_openai_model"),
  ]);

  const claudeConfigured = isClaudeKeyValid();
  const openaiConfigured = isOpenAiKeyValid();

  const primary: ProviderName =
    rawPrimary === "openai" || rawPrimary === "claude"
      ? rawPrimary
      : DEFAULT_PRIMARY_PROVIDER;
  const secondary: ProviderName = primary === "claude" ? "openai" : "claude";

  const chain: ProviderName[] = [];
  for (const provider of [primary, secondary]) {
    if (provider === "claude" && claudeConfigured) chain.push(provider);
    if (provider === "openai" && openaiConfigured) chain.push(provider);
  }

  return {
    providerChain: chain,
    claudeModel: rawClaude || DEFAULT_CLAUDE_MODEL,
    openaiModel: rawOpenai || DEFAULT_OPENAI_MODEL,
    claudeConfigured,
    openaiConfigured,
  };
}
