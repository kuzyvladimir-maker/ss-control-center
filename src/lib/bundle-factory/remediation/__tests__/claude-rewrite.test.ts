// Tests for claude-rewrite. Run with:
//   set -a; source .env.local; set +a
//   npx tsx --test src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts
//
// Pure-function tests run unconditionally; the live-API test only runs
// when ANTHROPIC_API_KEY is set in the environment.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUserMessage,
  parseClaudeJson,
  validateRewrite,
  rewriteListingContentWithClient,
  rewriteListingContent,
  type RewriteInput,
} from "../claude-rewrite";

// ── parseClaudeJson ────────────────────────────────────────────────────

test("parseClaudeJson — plain JSON", () => {
  const out = parseClaudeJson(
    '{"bullets":["one","two"],"description":"hello"}',
  );
  assert.ok(out);
  assert.deepEqual(out!.bullets, ["one", "two"]);
  assert.equal(out!.description, "hello");
});

test("parseClaudeJson — strips ```json fences", () => {
  const raw = '```json\n{"bullets":["x"],"description":"y"}\n```';
  const out = parseClaudeJson(raw);
  assert.ok(out);
  assert.deepEqual(out!.bullets, ["x"]);
});

test("parseClaudeJson — tolerates surrounding prose", () => {
  const raw =
    'Here is the JSON you requested:\n{"bullets":["a"],"description":"b"}\nLet me know if you need changes.';
  const out = parseClaudeJson(raw);
  assert.ok(out);
  assert.deepEqual(out!.bullets, ["a"]);
});

test("parseClaudeJson — returns null on garbage", () => {
  assert.equal(parseClaudeJson(""), null);
  assert.equal(parseClaudeJson("not json"), null);
  assert.equal(parseClaudeJson("{not really json}"), null);
});

// ── validateRewrite ────────────────────────────────────────────────────

const VALID_BULLETS = [
  "Includes 8 Oscar Mayer Bun-Length Franks, 14 oz total",
  "Vacuum-sealed and shipped refrigerated with ice packs",
  "Ready to grill, pan-fry, or microwave; no thawing required",
  "Fits standard hot dog buns and slider rolls",
];
const VALID_DESCRIPTION =
  "This gift set contains Oscar Mayer Bun-Length Franks.\n\nKeep refrigerated until ready to cook.";

test("validateRewrite — accepts valid payload", () => {
  assert.equal(validateRewrite(VALID_BULLETS, VALID_DESCRIPTION), null);
});

test("validateRewrite — rejects non-array bullets", () => {
  assert.match(
    validateRewrite("oops" as unknown, VALID_DESCRIPTION) ?? "",
    /bullets is not an array/,
  );
});

test("validateRewrite — rejects bullets under min count", () => {
  assert.match(
    validateRewrite(["one", "two"], VALID_DESCRIPTION) ?? "",
    /bullets\.length=2/,
  );
});

test("validateRewrite — rejects bullets over max count", () => {
  const tooMany = Array.from({ length: 10 }, (_, i) => `Bullet ${i + 1} text`);
  assert.match(
    validateRewrite(tooMany, VALID_DESCRIPTION) ?? "",
    /bullets\.length=10/,
  );
});

test("validateRewrite — rejects bullet > 500 chars", () => {
  const tooLong = "A".repeat(501);
  const bullets = [tooLong, ...VALID_BULLETS.slice(1)];
  const out = validateRewrite(bullets, VALID_DESCRIPTION);
  assert.match(out ?? "", /bullets\[0\]\.length=501/);
});

test("validateRewrite — rejects emoji in bullet", () => {
  const bullets = ["Includes 8 Oscar Mayer Franks 🎉", ...VALID_BULLETS.slice(1)];
  assert.match(validateRewrite(bullets, VALID_DESCRIPTION) ?? "", /emoji/);
});

test("validateRewrite — rejects manual bullet marker", () => {
  const bullets = ["• Includes 8 Oscar Mayer Franks", ...VALID_BULLETS.slice(1)];
  assert.match(validateRewrite(bullets, VALID_DESCRIPTION) ?? "", /manual bullet/);
});

test("validateRewrite — rejects HTML in bullet", () => {
  const bullets = [
    "<p>Includes 8 Oscar Mayer Franks</p>",
    ...VALID_BULLETS.slice(1),
  ];
  assert.match(validateRewrite(bullets, VALID_DESCRIPTION) ?? "", /HTML tag/);
});

test("validateRewrite — rejects HTML in description", () => {
  const desc = "<p>This gift set contains Oscar Mayer.</p>";
  assert.match(validateRewrite(VALID_BULLETS, desc) ?? "", /HTML tag/);
});

test("validateRewrite — rejects description > 2000 chars", () => {
  const desc = "A".repeat(2001);
  assert.match(validateRewrite(VALID_BULLETS, desc) ?? "", /description\.length=2001/);
});

// ── buildUserMessage ───────────────────────────────────────────────────

test("buildUserMessage — includes asin, brand, bullets, description", () => {
  const msg = buildUserMessage({
    asin: "B0FG8623VZ",
    title: "Salutem Vita – Cheez-It",
    brand: "Salutem Vita",
    browse_node: "12011207011",
    original_bullets: ["bullet A", "bullet B"],
    original_description: "Original desc",
  });
  assert.match(msg, /ASIN: B0FG8623VZ/);
  assert.match(msg, /Brand: Salutem Vita/);
  assert.match(msg, /12011207011/);
  assert.match(msg, /- bullet A/);
  assert.match(msg, /- bullet B/);
  assert.match(msg, /Original desc/);
});

test("buildUserMessage — handles missing browse_node + empty bullets", () => {
  const msg = buildUserMessage({
    asin: "B0X",
    title: "T",
    brand: "B",
    browse_node: null,
    original_bullets: [],
    original_description: "",
  });
  assert.match(msg, /browse node \(Amazon category id\): unknown/i);
  assert.match(msg, /\(no bullets stored\)/);
  assert.match(msg, /\(no description stored\)/);
});

// ── rewriteListingContentWithClient — stub client tests ────────────────

const SAMPLE_INPUT: RewriteInput = {
  asin: "B0F794DNK5",
  title: "Salutem Vita – Bun Length Franks Hot Dogs, Gift Set – Pack of 4",
  brand: "Salutem Vita",
  browse_node: "16310101",
  original_bullets: [
    "• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling",
    "•  🎁 Comes in a convenient pack",
  ],
  original_description:
    "<p>Introducing the ultimate frozen food Gift Set, perfect for any occasion!</p>",
};

function stubClient(
  textOrFn: string | ((call: number) => string),
  usage = {
    input_tokens: 1200,
    output_tokens: 500,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1100,
  },
) {
  let calls = 0;
  return {
    messages: {
      create: async () => {
        calls++;
        const text = typeof textOrFn === "function" ? textOrFn(calls) : textOrFn;
        return {
          content: [{ type: "text", text }],
          usage,
        };
      },
    },
    get callCount() {
      return calls;
    },
  };
}

test("rewriteListingContentWithClient — happy path returns parsed payload + cost", async () => {
  const reply = JSON.stringify({
    bullets: VALID_BULLETS,
    description: VALID_DESCRIPTION,
  });
  const client = stubClient(reply);
  const out = await rewriteListingContentWithClient(client, SAMPLE_INPUT);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.bullets, VALID_BULLETS);
  assert.equal(out.description, VALID_DESCRIPTION);
  assert.ok(out.cost_cents > 0, `expected cost_cents > 0, got ${out.cost_cents}`);
  assert.equal(out.cache_hit, false);
  assert.equal(client.callCount, 1);
});

test("rewriteListingContentWithClient — JSON parse failure triggers ONE retry, then succeeds", async () => {
  const validReply = JSON.stringify({
    bullets: VALID_BULLETS,
    description: VALID_DESCRIPTION,
  });
  const client = stubClient((call) => (call === 1 ? "not json at all" : validReply));
  const out = await rewriteListingContentWithClient(client, SAMPLE_INPUT);
  assert.equal(out.error, undefined);
  assert.equal(client.callCount, 2);
});

test("rewriteListingContentWithClient — JSON parse failure twice → error result", async () => {
  const client = stubClient("still not json");
  const out = await rewriteListingContentWithClient(client, SAMPLE_INPUT);
  assert.match(out.error ?? "", /JSON parse failed after retry/);
  assert.equal(client.callCount, 2);
  assert.deepEqual(out.bullets, []);
  assert.equal(out.description, "");
});

test("rewriteListingContentWithClient — validation failure surfaces error, no partial data", async () => {
  // Claude returns valid JSON but one bullet has an emoji.
  const dirty = JSON.stringify({
    bullets: ["Includes 8 Oscar Mayer 🎉", ...VALID_BULLETS.slice(1)],
    description: VALID_DESCRIPTION,
  });
  const client = stubClient(dirty);
  const out = await rewriteListingContentWithClient(client, SAMPLE_INPUT);
  assert.match(out.error ?? "", /validation failed/);
  assert.match(out.error ?? "", /emoji/);
  assert.deepEqual(out.bullets, []);
});

test("rewriteListingContentWithClient — cache_hit reflects cache_read_input_tokens", async () => {
  const reply = JSON.stringify({
    bullets: VALID_BULLETS,
    description: VALID_DESCRIPTION,
  });
  const client = stubClient(reply, {
    input_tokens: 200,
    output_tokens: 500,
    cache_read_input_tokens: 1100,
    cache_creation_input_tokens: 0,
  });
  const out = await rewriteListingContentWithClient(client, SAMPLE_INPUT);
  assert.equal(out.cache_hit, true);
  // Cached read is 10× cheaper so cost should be lower than the cold-cache
  // happy-path test above.
  assert.ok(out.cost_cents > 0);
});

// ── Live API test — gated by ANTHROPIC_API_KEY ─────────────────────────

const liveTest = process.env.ANTHROPIC_API_KEY ? test : test.skip;

liveTest("rewriteListingContent — live API produces compliant rewrite", async () => {
  const out = await rewriteListingContent(SAMPLE_INPUT);
  if (out.error) {
    assert.fail(`live API returned error: ${out.error}`);
  }
  assert.ok(
    out.bullets.length >= 4 && out.bullets.length <= 9,
    `bullets.length=${out.bullets.length}, expected 4-9`,
  );
  for (const b of out.bullets) {
    assert.doesNotMatch(b, /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u, `bullet contains emoji: ${b}`);
    assert.doesNotMatch(b, /[•●►▪○]/u, `bullet contains manual marker: ${b}`);
    const lower = b.toLowerCase();
    for (const word of ["ultimate", "perfect", "delightful", "delicious", "ideal", "amazing", "premium"]) {
      assert.ok(!new RegExp(`\\b${word}\\b`, "i").test(lower), `bullet contains promo word "${word}": ${b}`);
    }
  }
  assert.ok(out.description.length <= 2000);
  assert.doesNotMatch(out.description, /<[a-zA-Z]/, "description contains HTML");
  assert.ok(out.cost_cents > 0, `expected cost_cents > 0, got ${out.cost_cents}`);
});
