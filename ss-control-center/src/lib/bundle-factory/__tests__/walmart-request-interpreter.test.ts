import assert from "node:assert/strict";
import test from "node:test";

import { SubscriptionLlmUnavailable } from "@/lib/llm/subscription";
import {
  WALMART_REQUEST_INTERPRETATION_SCHEMA,
  WalmartRequestInterpreterError,
  interpretWalmartRequest,
} from "../walmart-request-interpreter";

/** The subscription worker answers with a parsed JSON object. */
function reply(input: Record<string, unknown>): Record<string, unknown> {
  return input;
}

test("a spoken Russian request becomes a Latin catalogue query", async () => {
  // The real failure: "Прогрессо" matched zero products and the build died
  // with a blank error, while the same request typed "Progresso" worked.
  const result = await interpretWalmartRequest(
    "сделай пять листингов супа Прогрессо по восемь банок",
    {
      complete: async () => reply({
        search_query: "Progresso soup",
        brand: "Progresso",
        product: "soup",
        listing_count: 5,
        pack_count: 8,
        readback: "Создам 5 листингов супа Progresso, по 8 банок в каждом.",
        assumptions: [],
        unsupported: [],
      }),
    },
  );
  assert.equal(result.schema_version, WALMART_REQUEST_INTERPRETATION_SCHEMA);
  assert.equal(result.search_query, "Progresso soup");
  assert.equal(result.listing_count, 5);
  assert.equal(result.pack_count, 8);
  assert.match(result.readback, /Progresso/);
});

test("a query that stayed in Cyrillic is refused, not searched", async () => {
  // Searching it would reproduce the exact zero-match dead end this module
  // exists to remove, so it fails loudly with what to type instead.
  await assert.rejects(
    () => interpretWalmartRequest("суп Прогрессо", {
      complete: async () => reply({
        search_query: "Прогрессо суп",
        readback: "…",
        assumptions: [],
        unsupported: [],
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartRequestInterpreterError);
      assert.equal(error.code, "QUERY_NOT_LATIN");
      return true;
    },
  );
});

test("counts are never invented and out-of-range values are dropped", async () => {
  const result = await interpretWalmartRequest("нужны листинги Campbell's", {
    complete: async () => reply({
      search_query: "Campbell's soup",
      brand: "Campbell's",
      listing_count: null,
      pack_count: 0,
      target_margin_pct: 900,
      readback: "Сколько листингов и по сколько штук?",
      assumptions: ["Количество листингов не указано"],
      unsupported: [],
    }),
  });
  assert.equal(result.listing_count, null);
  assert.equal(result.pack_count, null, "0 is not a pack size");
  assert.equal(result.target_margin_pct, null, "900% is not a margin");
  assert.deepEqual(result.assumptions, ["Количество листингов не указано"]);
});

test("what the lane cannot do comes back as unsupported, not silently dropped", async () => {
  const result = await interpretWalmartRequest(
    "собери подарочный набор из разных супов и выложи на Амазон",
    {
      complete: async () => reply({
        search_query: "assorted soup",
        readback: "Это смешанный набор для Amazon.",
        assumptions: [],
        unsupported: ["mixed assortment", "Amazon channel"],
      }),
    },
  );
  assert.deepEqual(result.unsupported, ["mixed assortment", "Amazon channel"]);
});

test("an empty request never reaches the model", async () => {
  let called = false;
  await assert.rejects(
    () => interpretWalmartRequest("  ", {
      complete: async () => {
        called = true;
        return reply({ search_query: "x", readback: "x", assumptions: [], unsupported: [] });
      },
    }),
    /3-1000 characters/,
  );
  assert.equal(called, false);
});

test("there is no paid fallback — an unreachable worker says so plainly", async () => {
  // Until 2026-08-06 this fell back to OpenAI on a paid key. The owner's
  // instruction removed paid APIs entirely, so the only honest outcome is a
  // sentence the operator can act on.
  await assert.rejects(
    () => interpretWalmartRequest("пять листингов Прогрессо", {
      complete: async () => {
        throw new SubscriptionLlmUnavailable("worker unreachable");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartRequestInterpreterError);
      assert.equal(error.code, "LLM_UNAVAILABLE");
      assert.match(error.message, /Latin letters/);
      assert.doesNotMatch(error.message, /OpenAI|Anthropic|balance/i);
      return true;
    },
  );
});

test("an empty answer is a failed interpretation, not an empty spec", async () => {
  await assert.rejects(
    () => interpretWalmartRequest("пять листингов Progresso", {
      complete: async () => ({}),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartRequestInterpreterError);
      assert.equal(error.code, "NO_INTERPRETATION");
      return true;
    },
  );
});
