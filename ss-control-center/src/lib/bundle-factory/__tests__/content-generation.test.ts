// Pure-function tests for content-generation. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/content-generation.test.ts
//
// We test the JSON parser and the per-channel output validator. The
// Claude HTTP call is covered by scripts/smoke-content-pipeline.ts in
// mock mode and by the orchestrator smoke run.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseClaudeJson,
  validateOutput,
  CHANNEL_LIMITS,
} from "../content-generation";

const VALID_BULLETS = [
  "Includes 12 retail-packaged Lunchables in the original kid-meal trays.",
  "Each tray is shelf-stable until opened and refrigerator-stable thereafter.",
  "Pack ships in insulated packaging from Salutem Solutions LLC.",
  "Compatible with standard refrigerator drawers and lunchbox carriers.",
];

test("parseClaudeJson — plain JSON", () => {
  const out = parseClaudeJson(
    '{"title":"A title","bullets":["one","two"],"description":"hello"}',
  );
  assert.ok(out);
  assert.equal(out!.title, "A title");
  assert.deepEqual(out!.bullets, ["one", "two"]);
});

test("parseClaudeJson — strips ```json fences", () => {
  const raw =
    '```json\n{"title":"X","bullets":["a"],"description":"y"}\n```';
  const out = parseClaudeJson(raw);
  assert.ok(out);
  assert.equal(out!.title, "X");
});

test("parseClaudeJson — tolerates surrounding prose", () => {
  const raw =
    'Here is the JSON you requested:\n{"title":"A","bullets":["b"],"description":"c"}\nLet me know.';
  const out = parseClaudeJson(raw);
  assert.ok(out);
  assert.equal(out!.title, "A");
});

test("parseClaudeJson — returns null on missing braces", () => {
  const out = parseClaudeJson("title: A");
  assert.equal(out, null);
});

test("validateOutput — amazon valid case", () => {
  const err = validateOutput(
    {
      title:
        "Salutem Vita Curated Lunchables Variety Gift Basket - Pack of 12 with 4 Flavors",
      bullets: VALID_BULLETS,
      description: "Plain text paragraph 1.\n\nParagraph 2.",
    },
    "amazon",
  );
  assert.equal(err, null);
});

test("validateOutput — amazon title too long", () => {
  const err = validateOutput(
    {
      title: "x".repeat(CHANNEL_LIMITS.amazon.title_max + 1),
      bullets: VALID_BULLETS,
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /title\.length/);
});

test("validateOutput — walmart title 80 chars fails", () => {
  const err = validateOutput(
    {
      title: "x".repeat(80),
      bullets: VALID_BULLETS,
      description: "ok",
    },
    "walmart",
  );
  assert.match(err ?? "", /title\.length/);
});

test("validateOutput — bullet with emoji fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: [...VALID_BULLETS.slice(0, 3), "Premium snacks 🎁 inside"],
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /emoji/);
});

test("validateOutput — bullet with HTML fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: [...VALID_BULLETS.slice(0, 3), "Includes <strong>12</strong> items"],
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /HTML/);
});

test("validateOutput — manual bullet marker fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: [...VALID_BULLETS.slice(0, 3), "• Includes 12 items"],
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /manual bullet/);
});

test("validateOutput — too few bullets fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: ["one", "two"],
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /bullets\.length/);
});

test("validateOutput — too many bullets fails (>9)", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: Array.from({ length: 10 }, (_, i) => `Bullet ${i}`),
      description: "ok",
    },
    "amazon",
  );
  assert.match(err ?? "", /bullets\.length/);
});

test("validateOutput — description with HTML fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: VALID_BULLETS,
      description: "<p>Description here</p>",
    },
    "amazon",
  );
  assert.match(err ?? "", /HTML/);
});

test("validateOutput — description with emoji fails", () => {
  const err = validateOutput(
    {
      title: "Clean title",
      bullets: VALID_BULLETS,
      description: "Includes 🎁 gifts",
    },
    "amazon",
  );
  assert.match(err ?? "", /emoji/);
});

test("CHANNEL_LIMITS — amazon title 200, walmart 75", () => {
  assert.equal(CHANNEL_LIMITS.amazon.title_max, 200);
  assert.equal(CHANNEL_LIMITS.walmart.title_max, 75);
  // Both leave a slot for the compliance disclaimer bullet.
  assert.equal(CHANNEL_LIMITS.amazon.bullets_max, 9);
  assert.equal(CHANNEL_LIMITS.walmart.bullets_max, 9);
});
