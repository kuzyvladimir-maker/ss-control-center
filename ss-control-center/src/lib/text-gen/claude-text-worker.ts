/**
 * Claude text worker client — FREE Claude-subscription copy generation.
 *
 * Mirrors the image path (src/lib/image-gen/codex-worker.ts): the always-on
 * OpenClaw box runs the Claude Code CLI logged into the owner's Claude Max
 * subscription, behind the same tiny HTTP service as the Codex image worker:
 *   - endpoint:  POST /text-claude   { prompt, system?, model? }
 *   - returns:   { ok: true, text }  (the model's RAW text — the app keeps its
 *                own JSON parsing, validation and compliance gate)
 *   - queue:     shares the box's Claude queue (separate from ChatGPT images)
 *
 * The paid Anthropic API remains ONLY the fallback (content-generation.ts) —
 * same architecture as identify.ts vision: subscription first, API reserve.
 *
 * Env (already present for the image worker — nothing new to configure):
 *   CODEX_IMAGE_WORKER_URL    .../codex-image/generate  → derives /text-claude
 *   CODEX_IMAGE_WORKER_TOKEN  shared bearer secret
 */

// A single listing's copy takes ~20-90s on the box (plus queue wait behind
// COGS vision jobs). Keep under Vercel's 300s route ceiling.
import { completeWithSubscription } from "@/lib/llm/subscription";


/** Kept for callers that only need to know whether the worker is set up. */
export function claudeTextWorkerUrl(): string | null {
  const base = (process.env.CODEX_IMAGE_WORKER_URL ?? "").trim();
  if (!base) return null;
  return base.replace(/\/generate\/?$/, "/text-claude");
}

export interface ClaudeTextArgs {
  prompt: string;
  system?: string;
  /** Subscription model tier. Default "sonnet" (strong enough for factual
   *  listing copy); "opus" burns Max-plan quota ~5× faster. */
  model?: "sonnet" | "opus";
  timeoutMs?: number;
}

/** Raw text from the subscription worker. Throws on any transport/worker error
 *  so the caller can fall back to the paid API. */
export async function generateTextViaClaudeWorker(
  args: ClaudeTextArgs,
): Promise<{ text: string; model: string }> {
  // Delegates to the shared two-subscription client: Claude Max first, ChatGPT
  // Pro when it refuses. Both are subscriptions Vladimir already pays for, and
  // neither is a paid API — that path was removed on 2026-08-06.
  const result = await completeWithSubscription({
    prompt: args.prompt,
    ...(args.system ? { system: args.system } : {}),
    model: args.model ?? "sonnet",
  });
  return { text: result.text, model: result.model };
}

// ── AnthropicLike adapter ────────────────────────────────────────────────────
// content-generation.ts talks to an `AnthropicLike` client (messages.create →
// { id, content, usage }). This adapter speaks that shape but routes the call
// to the subscription worker, so the WHOLE pipeline (KB system blocks, JSON
// parsing, validation, compliance gate, retries) is reused untouched.

interface MessageCreateParams {
  model?: unknown;
  system?: unknown;
  messages?: Array<{ content?: unknown }>;
}

function blocksToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/** AnthropicLike client backed by the subscription worker, or null when the
 *  worker env isn't configured. */
export function claudeWorkerClient(): {
  messages: {
    create: (args: Record<string, unknown>) => Promise<{
      id: string;
      content: Array<{ type: string; text?: string }>;
      usage: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
    }>;
  };
} | null {
  if (!claudeTextWorkerUrl() || !(process.env.CODEX_IMAGE_WORKER_TOKEN ?? "").trim()) {
    return null;
  }
  return {
    messages: {
      create: async (params: MessageCreateParams) => {
        const system = blocksToText(params.system);
        const prompt = contentToText(params.messages?.[0]?.content);
        const model = /opus/i.test(String(params.model ?? "")) ? "opus" : "sonnet";
        const { text } = await generateTextViaClaudeWorker({ prompt, system, model });
        return {
          id: "claude-subscription-worker",
          content: [{ type: "text", text }],
          // Subscription run — no metered tokens, cost accounting stays $0.
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  };
}
