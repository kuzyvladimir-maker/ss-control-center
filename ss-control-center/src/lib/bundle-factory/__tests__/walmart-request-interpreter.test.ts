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

test("a mixed assortment is read, not silently dropped", async () => {
  // The real loss, 2026-08-06: "20 листингов по 8 банок, в каждом по 2 вида,
  // по 4 банки каждого" was reduced to 20 × 8 and would have built twenty
  // single-flavor eight-packs — the wrong product, at full cost.
  const result = await interpretWalmartRequest(
    "20 листингов по 8 банок, в каждом по 2 вида супа, по 4 банки каждого",
    {
      complete: async () => reply({
        search_query: "Campbell's condensed soup",
        listing_count: 20,
        pack_count: 8,
        flavors_per_listing: 2,
        units_per_flavor: 4,
        readback: "20 листингов по 8 банок: 2 вида по 4 банки.",
        assumptions: [],
        unsupported: [],
      }),
    },
  );
  assert.equal(result.listing_count, 20);
  assert.equal(result.pack_count, 8);
  assert.equal(result.flavors_per_listing, 2);
  assert.equal(result.units_per_flavor, 4);
});

test("the missing half of a mix is derived from the pack size", async () => {
  const result = await interpretWalmartRequest("листинги по 12 банок, 3 вида", {
    complete: async () => reply({
      search_query: "Campbell's condensed soup",
      pack_count: 12,
      flavors_per_listing: 3,
      readback: "12 банок, 3 вида.",
      assumptions: [],
      unsupported: [],
    }),
  });
  assert.equal(result.units_per_flavor, 4);
});

test("a contradictory mix is reported, not silently dropped", async () => {
  // Re-review 2026-08-08: the model path returned two nulls and said nothing,
  // so a mixed request quietly became a single-product pack.
  const result = await interpretWalmartRequest("8 банок, 3 вида по 3", {
    complete: async () => reply({
      search_query: "Campbell's soup",
      pack_count: 8,
      flavors_per_listing: 3,
      units_per_flavor: 3,
      readback: "8 банок.",
      assumptions: [],
      unsupported: [],
    }),
  });
  assert.equal(result.flavors_per_listing, null);
  assert.ok(result.unsupported.some((entry) => /does not add up to 8/.test(entry)));
});

test("numbers that do not multiply out are refused, not published", async () => {
  // 3 × 5 ≠ 8. Building on that would put the wrong number of cans in a box.
  const result = await interpretWalmartRequest("8 банок, 3 вида по 5", {
    complete: async () => reply({
      search_query: "Campbell's condensed soup",
      pack_count: 8,
      flavors_per_listing: 3,
      units_per_flavor: 5,
      readback: "8 банок.",
      assumptions: [],
      unsupported: [],
    }),
  });
  assert.equal(result.flavors_per_listing, null);
  assert.equal(result.units_per_flavor, null);
  assert.equal(result.pack_count, 8);
});

test("a single-flavor multipack reports no mix at all", async () => {
  const result = await interpretWalmartRequest("5 листингов Progresso по 8", {
    complete: async () => reply({
      search_query: "Progresso soup",
      listing_count: 5,
      pack_count: 8,
      flavors_per_listing: 1,
      units_per_flavor: 8,
      readback: "5 листингов по 8 банок.",
      assumptions: [],
      unsupported: [],
    }),
  });
  assert.equal(result.flavors_per_listing, null);
  assert.equal(result.units_per_flavor, null);
});
