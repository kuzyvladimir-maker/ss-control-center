/**
 * The only way this platform is allowed to talk to a language model.
 *
 * Owner instruction, 2026-08-06: *«забудь про API навсегда. Про платные API
 * токены забудь навсегда.»* He already pays for Claude Max and ChatGPT Pro;
 * paying a second time per token for the same models is waste, and a paid
 * fallback quietly reintroduces exactly the cost the subscription path exists
 * to remove. So there is no fallback here. If the subscription worker cannot be
 * reached, the call fails and says so.
 *
 * The transport is the one already proven for image generation and vision:
 * Vercel → HTTPS + Bearer → systemd worker on the OpenClaw box → the `claude`
 * CLI running on the subscription's OAuth credentials. The worker strips
 * ANTHROPIC_API_KEY from the child environment, so even a stray key on the box
 * cannot turn a subscription call into a billed one.
 *
 * There are TWO subscription lanes, because Vladimir pays for two and an
 * exhausted monthly limit on one should be a slowdown, not an outage:
 *
 *   /text-claude  → `claude` CLI on Claude Max
 *   /text-codex   → `codex exec` on ChatGPT Pro
 *
 * Claude goes first (it answers faster and follows a JSON contract more
 * reliably); Codex picks up whatever it refuses. Both cost nothing. Neither is
 * an API key.
 *
 * See `ops/codex-image-worker/server.js` for the other end.
 */

/**
 * Same host and token as the image worker — one worker, several endpoints.
 *
 * `CODEX_IMAGE_WORKER_URL` holds the full /generate URL, and every other
 * endpoint is derived from it exactly as the vision client does, so adding a
 * capability never means adding an environment variable to two places.
 */
const WORKER_URL_ENV = "CODEX_IMAGE_WORKER_URL";
const WORKER_TOKEN_ENV = "CODEX_IMAGE_WORKER_TOKEN";

/** Long, because a subscription CLI is slower than an API and that is fine. */
const REQUEST_TIMEOUT_MS = 300_000;

export class SubscriptionLlmUnavailable extends Error {}

export interface SubscriptionCompletionInput {
  prompt: string;
  /** Extra system instruction, appended to the CLI's own. */
  system?: string;
  /** `sonnet`, `opus`, `haiku` — CLI aliases, not API model IDs. */
  model?: string;
  /** Restrict to one subscription. Default: try both, Claude first. */
  lanes?: readonly SubscriptionLane[];
  /** Overrides the test seam; production never sets this. */
  fetchImpl?: typeof fetch;
}

export interface SubscriptionCompletion {
  text: string;
  model: string;
  /** Which subscription answered. Worth logging when one lane is degraded. */
  lane: SubscriptionLane;
  /** Always zero. Kept so callers can record cost without special-casing. */
  costCents: 0;
}

/** Which subscription answered, or should. */
export type SubscriptionLane = "claude" | "codex";

/** Tried in order. Claude first: faster, and steadier on a JSON contract. */
export const SUBSCRIPTION_LANES: readonly SubscriptionLane[] = ["claude", "codex"];

const LANE_PATH: Record<SubscriptionLane, string> = {
  claude: "/text-claude",
  codex: "/text-codex",
};

/** …/generate → the lane's endpoint, the same derivation the vision client uses. */
export function completionEndpoint(
  generateUrl: string,
  lane: SubscriptionLane = "claude",
): string {
  return generateUrl.replace(/\/generate\/?$/, LANE_PATH[lane]);
}

export function subscriptionLlmConfigured(): boolean {
  return Boolean(process.env[WORKER_URL_ENV] && process.env[WORKER_TOKEN_ENV]);
}

/**
 * Ask the model a question and get its answer as text.
 *
 * Throws `SubscriptionLlmUnavailable` when the worker is not configured or does
 * not answer. Callers must handle that as "this feature is unavailable right
 * now" — never by reaching for an API key.
 */
export async function completeWithSubscription(
  input: SubscriptionCompletionInput,
): Promise<SubscriptionCompletion> {
  const base = process.env[WORKER_URL_ENV];
  const token = process.env[WORKER_TOKEN_ENV];
  if (!base || !token) {
    throw new SubscriptionLlmUnavailable(
      `The subscription model worker is not configured (${WORKER_URL_ENV} / ${WORKER_TOKEN_ENV}). `
      + "This platform does not use paid API keys, so there is no fallback.",
    );
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new SubscriptionLlmUnavailable("An empty prompt was requested");

  const lanes = input.lanes ?? SUBSCRIPTION_LANES;
  const failures: string[] = [];
  for (const lane of lanes) {
    try {
      return await askLane(lane, base, token, prompt, input);
    } catch (error) {
      // A lane that is out of monthly quota, or a worker that is down, is not
      // the end of the call — the other subscription is right there. Only when
      // both refuse does the caller hear about it.
      failures.push(`${lane}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new SubscriptionLlmUnavailable(
    `No subscription lane answered. ${failures.join(" | ")}`,
  );
}

async function askLane(
  lane: SubscriptionLane,
  base: string,
  token: string,
  prompt: string,
  input: SubscriptionCompletionInput,
): Promise<SubscriptionCompletion> {
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(completionEndpoint(base, lane), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        ...(input.system ? { system: input.system } : {}),
        // The model alias is Claude's; Codex picks its own.
        ...(input.model && lane === "claude" ? { model: input.model } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new SubscriptionLlmUnavailable(
      `could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; text?: string; model?: string; error?: string }
    | null;
  if (!response.ok || !body?.text) {
    throw new SubscriptionLlmUnavailable(
      `HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`,
    );
  }
  return {
    text: body.text,
    model: body.model ?? (lane === "claude" ? "sonnet" : "codex"),
    lane,
    costCents: 0,
  };
}

/**
 * The same call, when the answer must be a JSON object.
 *
 * A model asked for JSON often wraps it in prose or a fenced block; this takes
 * the outermost object rather than trusting the whole reply to parse.
 */
export async function completeJsonWithSubscription<T = unknown>(
  input: SubscriptionCompletionInput,
): Promise<T> {
  const { text } = await completeWithSubscription(input);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new SubscriptionLlmUnavailable(
      `The model did not return a JSON object: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (error) {
    throw new SubscriptionLlmUnavailable(
      `The model returned malformed JSON: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}
