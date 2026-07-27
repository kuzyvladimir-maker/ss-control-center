import { NextResponse } from "next/server";
import {
  getAIConfig,
  CLAUDE_MODELS,
  OPENAI_MODELS,
} from "@/lib/ai-config";

// GET /api/integrations/ai-providers
// Returns:
//   - configured status for each provider (no keys leaked)
//   - current effective AI config (primary provider + selected models)
//   - catalogs of available models per provider for the UI dropdowns
export async function GET() {
  const config = await getAIConfig();
  const primary = config.providerChain[0] || null;

  return NextResponse.json({
    claude: {
      configured: config.claudeConfigured,
      model: config.claudeModel,
      role: primary === "claude" ? "primary" : "fallback",
    },
    openai: {
      configured: config.openaiConfigured,
      model: config.openaiModel,
      role: primary === "openai" ? "primary" : "fallback",
    },
    primaryProvider: primary,
    providerChain: config.providerChain,
    availableModels: {
      claude: CLAUDE_MODELS,
      openai: OPENAI_MODELS,
    },
    anyConfigured: config.providerChain.length > 0,
    bothConfigured: config.claudeConfigured && config.openaiConfigured,
  });
}
