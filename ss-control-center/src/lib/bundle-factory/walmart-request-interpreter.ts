/**
 * Free-form request → strict build spec.
 *
 * The owner writes what he wants in Russian, the way he would say it out loud:
 * "сделай пять листингов супа Прогрессо по восемь банок". The catalogue does
 * not speak that. It indexes the manufacturer's own Latin wording, so
 * "Прогрессо" matched nothing and the build died with a blank error while the
 * identical request typed as "Progresso" worked. That gap is a translation
 * problem, not a search problem.
 *
 * This module translates once, up front, and shows the result back for
 * confirmation before anything is built. It decides nothing else: it does not
 * search, does not spend, does not create. Its whole output is a spec the
 * existing build page already knows how to run — plus a plain readback and an
 * honest list of what it had to assume.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { CLAUDE, OPENAI } from "@/lib/ai-models";

export const WALMART_REQUEST_INTERPRETATION_SCHEMA =
  "bundle-factory.walmart-request-interpretation/1.0.0" as const;

export interface WalmartRequestInterpretation {
  schema_version: typeof WALMART_REQUEST_INTERPRETATION_SCHEMA;
  /** What the catalogue should be searched with — Latin, as the manufacturer writes it. */
  search_query: string;
  /** Manufacturer brand alone, when the request names one. */
  brand: string | null;
  /** Product/category words without the brand, e.g. "chunky soup". */
  product: string | null;
  listing_count: number | null;
  pack_count: number | null;
  target_margin_pct: number | null;
  /** One sentence back to the owner, in his own language. */
  readback: string;
  /** Anything filled in that the request did not actually say. */
  assumptions: string[];
  /** Anything asked for that this lane cannot do. */
  unsupported: string[];
  model: string;
}

const SYSTEM_PROMPT = `You turn a seller's free-form request into a strict Walmart listing-build spec.

The seller writes in Russian or English, often the way people speak: brands may be
transliterated into Cyrillic ("Прогрессо", "Кэмпбелл"), numbers may be words
("пять листингов", "по восемь банок").

Your job:
1. Recover the MANUFACTURER BRAND in its official Latin spelling as it appears on
   the package and on US retailer sites: Прогрессо -> Progresso, Кэмпбелл /
   Кэмпбеллс -> Campbell's, Хайнц -> Heinz. Never invent a brand that was not
   asked for. If no brand is named, brand is null.
2. Build search_query: the Latin words the product catalogue should be searched
   with — brand plus product words, no counts, no marketing words, no Cyrillic.
3. Extract listing_count (how many DIFFERENT listings to create) and pack_count
   (how many identical retail units inside ONE listing). "5 листингов по 8 банок"
   means listing_count 5, pack_count 8. If a number is not stated, use null —
   never guess a count.
4. target_margin_pct only if the request states a margin.
5. readback: one short sentence IN THE SELLER'S OWN LANGUAGE stating what will be
   built, so he can confirm or correct it.
6. assumptions: anything you filled in that the request did not literally say.
7. unsupported: anything requested that this lane cannot do — it only builds
   homogeneous multipacks of ONE exact product per listing for Walmart. Mixed
   assortments, gift baskets, Amazon, frozen goods and price overrides belong in
   unsupported.

Answer with the interpret_request tool. Never add commentary.`;

const TOOL = {
  name: "interpret_request",
  description: "Return the strict build spec for this request.",
  input_schema: {
    type: "object" as const,
    properties: {
      search_query: { type: "string" },
      brand: { type: ["string", "null"] },
      product: { type: ["string", "null"] },
      listing_count: { type: ["integer", "null"], minimum: 1, maximum: 500 },
      pack_count: { type: ["integer", "null"], minimum: 1, maximum: 500 },
      target_margin_pct: { type: ["number", "null"], minimum: 1, maximum: 50 },
      readback: { type: "string" },
      assumptions: { type: "array", items: { type: "string" } },
      unsupported: { type: "array", items: { type: "string" } },
    },
    required: ["search_query", "readback", "assumptions", "unsupported"],
  },
};

export class WalmartRequestInterpreterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartRequestInterpreterError";
    this.code = code;
  }
}

function positiveInteger(value: unknown, max: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Latin letters, digits, spaces and the punctuation real brands use. */
const LATIN_QUERY = /^[\p{Script=Latin}\p{Nd}\s&'’.,+()/-]+$/u;

export interface InterpretWalmartRequestDependencies {
  createMessage?: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => Promise<Anthropic.Message>;
  /** Used only when Claude is unreachable (no key, no credit, provider down). */
  createFallback?: (prompt: string) => Promise<Record<string, unknown>>;
  model?: string;
}

/**
 * OpenAI answering the same question, in the same shape.
 *
 * Reading a request is a small, self-contained task, and the whole feature
 * going dark because one provider's balance ran out would put the operator
 * straight back to the dead end this module removes.
 */
async function interpretWithOpenAI(
  prompt: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new WalmartRequestInterpreterError(
      "LLM_NOT_CONFIGURED",
      "No language-model provider is reachable, so free-form requests cannot be interpreted. Type the request with the brand in Latin letters instead.",
    );
  }
  const completion = await new OpenAI({ apiKey }).chat.completions.create({
    model: OPENAI.default,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nReturn a single JSON object with exactly these keys: `
          + "search_query, brand, product, listing_count, pack_count, "
          + "target_margin_pct, readback, assumptions, unsupported.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new WalmartRequestInterpreterError(
      "NO_INTERPRETATION",
      "The request could not be turned into a build spec.",
    );
  }
}

export async function interpretWalmartRequest(
  prompt: string,
  dependencies: InterpretWalmartRequestDependencies = {},
): Promise<WalmartRequestInterpretation> {
  const request = prompt.trim();
  if (request.length < 3 || request.length > 1_000) {
    throw new WalmartRequestInterpreterError(
      "PROMPT_LENGTH",
      "Describe the request in 3-1000 characters.",
    );
  }
  const model = dependencies.model ?? CLAUDE.balanced;
  const createMessage = dependencies.createMessage
    ?? (async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey === "<api_key>") {
        throw new WalmartRequestInterpreterError(
          "LLM_NOT_CONFIGURED",
          "ANTHROPIC_API_KEY is not configured, so free-form requests cannot be interpreted. Type the request with the brand in Latin letters instead.",
        );
      }
      return new Anthropic({ apiKey }).messages.create(params);
    });

  const fallback = dependencies.createFallback ?? interpretWithOpenAI;
  let raw: Record<string, unknown>;
  let usedModel = model;
  try {
    const response = await createMessage({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: request }],
    });
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new WalmartRequestInterpreterError(
        "NO_INTERPRETATION",
        "The request could not be turned into a build spec.",
      );
    }
    raw = toolUse.input as Record<string, unknown>;
  } catch (error) {
    // A missing key, an exhausted balance or a provider outage must not take
    // the feature down; the second provider answers the same question.
    if (error instanceof WalmartRequestInterpreterError
      && error.code !== "LLM_NOT_CONFIGURED") {
      throw error;
    }
    try {
      raw = await fallback(request);
      usedModel = OPENAI.default;
    } catch (fallbackError) {
      if (fallbackError instanceof WalmartRequestInterpreterError) {
        throw fallbackError;
      }
      // Both providers refused. Say so in one sentence the operator can act
      // on, rather than leaking a raw provider error into the page.
      throw new WalmartRequestInterpreterError(
        "LLM_UNAVAILABLE",
        "Neither language-model provider answered (check the Anthropic and OpenAI "
        + "balances). You can still type the request yourself with the brand in "
        + "Latin letters, exactly as it appears on the package.",
      );
    }
    if (Object.keys(raw).length === 0) throw error;
  }
  const searchQuery = cleanText(raw.search_query);
  if (!searchQuery) {
    throw new WalmartRequestInterpreterError(
      "NO_SEARCH_QUERY",
      "The request names no product to search for.",
    );
  }
  // The catalogue indexes the manufacturer's Latin wording. A query that came
  // back still in Cyrillic would repeat the exact failure this module exists to
  // remove, so it is refused here rather than silently searched for nothing.
  if (!LATIN_QUERY.test(searchQuery)) {
    throw new WalmartRequestInterpreterError(
      "QUERY_NOT_LATIN",
      `Could not resolve "${searchQuery}" to the manufacturer's Latin brand spelling. Type the brand as it appears on the package.`,
    );
  }

  return {
    schema_version: WALMART_REQUEST_INTERPRETATION_SCHEMA,
    search_query: searchQuery,
    brand: cleanText(raw.brand),
    product: cleanText(raw.product),
    listing_count: positiveInteger(raw.listing_count, 500),
    pack_count: positiveInteger(raw.pack_count, 500),
    target_margin_pct:
      typeof raw.target_margin_pct === "number"
        && raw.target_margin_pct >= 1
        && raw.target_margin_pct <= 50
        ? raw.target_margin_pct
        : null,
    readback: cleanText(raw.readback) ?? searchQuery,
    assumptions: stringList(raw.assumptions),
    unsupported: stringList(raw.unsupported),
    model: usedModel,
  };
}
