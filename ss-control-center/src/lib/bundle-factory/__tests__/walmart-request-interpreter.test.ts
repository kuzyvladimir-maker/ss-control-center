import assert from "node:assert/strict";
import test from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import {
  WALMART_REQUEST_INTERPRETATION_SCHEMA,
  WalmartRequestInterpreterError,
  interpretWalmartRequest,
} from "../walmart-request-interpreter";

function reply(input: Record<string, unknown>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: "tool_1", name: "interpret_request", input }],
  } as unknown as Anthropic.Message;
}

test("a spoken Russian request becomes a Latin catalogue query", async () => {
  // The real failure: "Прогрессо" matched zero products and the build died
  // with a blank error, while the same request typed "Progresso" worked.
  const result = await interpretWalmartRequest(
    "сделай пять листингов супа Прогрессо по восемь банок",
    {
      createMessage: async () => reply({
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
      createMessage: async () => reply({
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
    createMessage: async () => reply({
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
      createMessage: async () => reply({
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
      createMessage: async () => {
        called = true;
        return reply({ search_query: "x", readback: "x", assumptions: [], unsupported: [] });
      },
    }),
    /3-1000 characters/,
  );
  assert.equal(called, false);
});

test("OpenAI answers when Claude is unreachable", async () => {
  const result = await interpretWalmartRequest("пять листингов Progresso по 8", {
    createMessage: async () => {
      throw new Error("400 credit balance is too low");
    },
    createFallback: async () => ({
      search_query: "Progresso soup",
      listing_count: 5,
      pack_count: 8,
      readback: "5 листингов Progresso по 8 банок.",
      assumptions: [],
      unsupported: [],
    }),
  });
  assert.equal(result.search_query, "Progresso soup");
  assert.equal(result.listing_count, 5);
});

test("when no provider answers, the operator is told what to do instead", async () => {
  // Both balances empty is the state this was written in; the page must not
  // show a raw provider error, and typing Latin by hand must still work.
  await assert.rejects(
    () => interpretWalmartRequest("пять листингов Прогрессо", {
      createMessage: async () => { throw new Error("429 no credits"); },
      createFallback: async () => { throw new Error("429 no credits"); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartRequestInterpreterError);
      assert.equal(error.code, "LLM_UNAVAILABLE");
      assert.match(error.message, /Latin letters/);
      return true;
    },
  );
});
