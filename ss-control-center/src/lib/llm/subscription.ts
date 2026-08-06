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
 * See `ops/codex-image-worker/server.js` (`/complete`) for the other end.
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
  /** Overrides the test seam; production never sets this. */
  fetchImpl?: typeof fetch;
}

export interface SubscriptionCompletion {
  text: string;
  model: string;
  /** Always zero. Kept so callers can record cost without special-casing. */
  costCents: 0;
}

/** …/generate → …/complete, the same derivation the vision client uses. */
export function completionEndpoint(generateUrl: string): string {
  return generateUrl.replace(/\/generate\/?$/, "/complete");
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

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(completionEndpoint(base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        ...(input.system ? { system: input.system } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new SubscriptionLlmUnavailable(
      `The subscription model worker could not be reached: `
      + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; text?: string; model?: string; error?: string }
    | null;
  if (!response.ok || !body?.text) {
    throw new SubscriptionLlmUnavailable(
      `The subscription model worker returned HTTP ${response.status}`
      + (body?.error ? `: ${body.error}` : ""),
    );
  }
  return { text: body.text, model: body.model ?? "sonnet", costCents: 0 };
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
