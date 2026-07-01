/**
 * ─────────────────────────────────────────────────────────────────────────
 *  SINGLE SOURCE OF TRUTH for every LLM model the app uses.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * To upgrade a model EVERYWHERE it is used, change ONE line here — every
 * feature (Bundle Factory, Customer Hub, Growth Advisor, vision, OCR,
 * classification, scripts …) imports its model from this file, so you never
 * have to hunt through the codebase again.
 *
 * To check whether Anthropic has shipped something newer than what is pinned
 * below, run:   npx tsx scripts/check-model-updates.ts
 * It queries Anthropic's live model list and tells you if a newer model is
 * available — you approve, and we change the one line here.
 *
 * ── Claude tiers ──
 *   premium  → deepest reasoning (per-listing deep advisor, A+ storyboards)
 *   balanced → the default workhorse (content, analysis, vision, OCR, …)
 *   cheap    → fast & high-volume / prompt-cached calls (catalog, title clean)
 *
 * ⚠️  Before bumping a Claude model, glance at the migration notes:
 *   https://platform.claude.com/docs/en/about-claude/models/migration-guide
 *   New generations occasionally change the API (e.g. Sonnet 5 turns "thinking"
 *   ON by default and rejects a non-default `temperature`). That is why we do
 *   NOT auto-pull the newest model at runtime — a human vets each bump.
 */

// ── Anthropic / Claude ─────────────────────────────────────────────────────
export const CLAUDE = {
  /** Deepest reasoning. */
  premium: "claude-opus-4-8",
  /** Default workhorse (was Sonnet 4.6 / 4.5 / 4.0 before 2026-06-30). */
  balanced: "claude-sonnet-5",
  /** Fast & cheap — high-volume / cached calls. */
  cheap: "claude-haiku-4-5",
} as const;

// ── OpenAI (text) ──────────────────────────────────────────────────────────
export const OPENAI = {
  default: "gpt-4o",
  cheap: "gpt-4o-mini",
  large: "gpt-4.1",
} as const;

// ── Image generation (OpenAI gpt-image) ────────────────────────────────────
export const IMAGE = {
  default: "gpt-image-2",
  cheap: "gpt-image-1",
} as const;

// ── Perplexity (grounded web research) ─────────────────────────────────────
export const PERPLEXITY = "sonar-pro";

// ── Human-friendly labels for the Settings dropdowns ───────────────────────
export const CLAUDE_MODEL_LABELS: Record<string, string> = {
  [CLAUDE.premium]: "Claude Opus 4.8 (best quality)",
  [CLAUDE.balanced]: "Claude Sonnet 5 (balanced, default)",
  [CLAUDE.cheap]: "Claude Haiku 4.5 (fastest, cheapest)",
};

export const OPENAI_MODEL_LABELS: Record<string, string> = {
  [OPENAI.default]: "GPT-4o (default)",
  [OPENAI.cheap]: "GPT-4o mini (cheapest)",
  [OPENAI.large]: "GPT-4.1 (large context)",
};
