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


import {
  completeJsonWithSubscription,
  SubscriptionLlmUnavailable,
} from "@/lib/llm/subscription";

/** A CLI alias, not an API model id — the worker runs `claude --model`. */
const SUBSCRIPTION_MODEL = "sonnet";

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
  /** Total retail units inside ONE listing, across all flavors. */
  pack_count: number | null;
  /**
   * How many DIFFERENT exact products share one listing.
   *
   * 1 (or null) is the homogeneous multipack this lane has always built. 2+ is
   * a mixed assortment — "20 листингов по 8 банок, по 2 вида, по 4 банки
   * каждого" is listing_count 20, pack_count 8, flavors_per_listing 2,
   * units_per_flavor 4. The request used to lose that entirely: the reading
   * kept only 20 × 8 and would have built twenty single-flavor eight-packs.
   */
  flavors_per_listing: number | null;
  /** Units of EACH flavor. `flavors_per_listing × units_per_flavor = pack_count`. */
  units_per_flavor: number | null;
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
   (how many retail units inside ONE listing, counting every flavor together).
   "5 листингов по 8 банок" means listing_count 5, pack_count 8. If a number is
   not stated, use null — never guess a count.
3a. A listing may mix several DIFFERENT products. When the request says so, set
   flavors_per_listing and units_per_flavor. "20 листингов по 8 банок, в каждом
   по 2 вида супа, по 4 банки каждого" means listing_count 20, pack_count 8,
   flavors_per_listing 2, units_per_flavor 4. Their product must equal
   pack_count. For a plain single-product multipack use flavors_per_listing 1
   and units_per_flavor equal to pack_count.
4. target_margin_pct only if the request states a margin.
5. readback: one short sentence IN THE SELLER'S OWN LANGUAGE stating what will be
   built, so he can confirm or correct it.
6. assumptions: anything you filled in that the request did not literally say.
7. unsupported: anything requested that this lane cannot do — it builds Walmart
   multipacks, of one product or of several mixed in one listing. Gift baskets,
   Amazon, frozen goods and price overrides belong in unsupported.

Never silently drop part of the request. If you cannot express something in
these fields, say so in unsupported rather than leaving it out.`;

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
  /** Test seam. Production always goes to the subscription worker. */
  complete?: (input: { prompt: string; system: string; model?: string })
    => Promise<Record<string, unknown>>;
  model?: string;
}

/**
 * Exactly what the model must return, spelled out.
 *
 * The Anthropic SDK's tool-use schema did this before. The subscription path
 * runs the `claude` CLI, which answers in text, so the shape is stated in the
 * prompt and the reply is parsed as JSON instead. Same contract, different
 * transport.
 */
const JSON_CONTRACT = `Return ONE JSON object and nothing else \u2014 no prose, no code fence.
Keys, all required (use null when a value is absent):
  search_query      string  the manufacturer's Latin wording to search for
  brand             string|null
  product           string|null
  listing_count     integer|null  1-500
  pack_count        integer|null  1-500  total units in one listing
  flavors_per_listing integer|null 1-20  different products sharing one listing
  units_per_flavor  integer|null  1-500  units of each; × flavors = pack_count
  target_margin_pct number|null   1-50
  readback          string  one sentence restating the request as understood
  assumptions       string[]  what you filled in that the request did not say
  unsupported       string[]  what was asked for and cannot be done`;

/**
 * The mixed-assortment part of a reading, made consistent.
 *
 * A model asked for three related numbers will occasionally return two that
 * disagree with the third. Rather than trusting the arithmetic, this derives
 * what it can and drops what it cannot prove — a listing built on a wrong unit
 * count is worse than one built on a missing one.
 */
function mixedComposition(raw: Record<string, unknown>): {
  flavors_per_listing: number | null;
  units_per_flavor: number | null;
  unsupported?: string;
} {
  const pack = positiveInteger(raw.pack_count, 500);
  let flavors = positiveInteger(raw.flavors_per_listing, 20);
  let units = positiveInteger(raw.units_per_flavor, 500);

  // Either one plus the pack size determines the other.
  if (flavors && !units && pack && pack % flavors === 0) units = pack / flavors;
  if (units && !flavors && pack && pack % units === 0) flavors = pack / units;

  // They must multiply out. When they do not, the reading is not trustworthy
  // enough to spend a build on — but dropping it silently turned a mixed
  // request into a single-product pack with nothing said (re-review
  // 2026-08-08), so the caller is told.
  if (flavors && units && pack && flavors * units !== pack) {
    return {
      flavors_per_listing: null,
      units_per_flavor: null,
      unsupported: `${flavors} kinds of ${units} does not add up to ${pack} units`,
    };
  }
  if (flavors && flavors > 1 && !units && pack && pack % flavors !== 0) {
    return {
      flavors_per_listing: null,
      units_per_flavor: null,
      unsupported: `${flavors} kinds does not divide ${pack} units evenly`,
    };
  }
  // One flavor is not a mix; say nothing rather than decorate it.
  if (flavors === 1) return { flavors_per_listing: null, units_per_flavor: null };
  return { flavors_per_listing: flavors, units_per_flavor: units };
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
  const model = dependencies.model ?? SUBSCRIPTION_MODEL;

  // One provider, no fallback. The platform holds no paid API keys — the
  // owner's instruction on 2026-08-06 — so "the other provider" does not exist,
  // and pretending otherwise would only hide a broken worker behind a second
  // failure message.
  const complete = dependencies.complete
    ?? (async (input: { prompt: string; system: string; model?: string }) =>
      completeJsonWithSubscription<Record<string, unknown>>({
        prompt: input.prompt,
        system: input.system,
        ...(input.model ? { model: input.model } : {}),
      }));

  let raw: Record<string, unknown>;
  try {
    raw = await complete({
      prompt: request,
      system: `${SYSTEM_PROMPT}\n\n${JSON_CONTRACT}`,
      model,
    });
  } catch (error) {
    if (error instanceof WalmartRequestInterpreterError) throw error;
    if (error instanceof SubscriptionLlmUnavailable) {
      throw new WalmartRequestInterpreterError(
        "LLM_UNAVAILABLE",
        "The subscription model worker did not answer, so free-form requests "
        + "cannot be read right now. You can still type the request yourself "
        + "with the brand in Latin letters, exactly as it appears on the package.",
      );
    }
    throw new WalmartRequestInterpreterError(
      "NO_INTERPRETATION",
      "The request could not be turned into a build spec.",
    );
  }
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new WalmartRequestInterpreterError(
      "NO_INTERPRETATION",
      "The request could not be turned into a build spec.",
    );
  }
  const usedModel = model;

  const composition = mixedComposition(raw);
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
    ...composition,
    target_margin_pct:
      typeof raw.target_margin_pct === "number"
        && raw.target_margin_pct >= 1
        && raw.target_margin_pct <= 50
        ? raw.target_margin_pct
        : null,
    readback: cleanText(raw.readback) ?? searchQuery,
    assumptions: stringList(raw.assumptions),
    unsupported: composition.unsupported
      ? [...stringList(raw.unsupported), composition.unsupported]
      : stringList(raw.unsupported),
    model: usedModel,
  };
}
