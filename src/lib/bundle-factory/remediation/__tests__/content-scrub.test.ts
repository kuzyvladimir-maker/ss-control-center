// Unit tests for content-scrub. Run with:
//   npx tsx --test src/lib/bundle-factory/remediation/__tests__/content-scrub.test.ts
//
// Uses node:test (built into Node ≥18) so we don't pull in a test
// framework just for one module. Each test asserts on a fragment seen
// in the AMZCOM/SALUTEM failed-content discovery dumps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scrubBullet,
  scrubBulletArray,
  scrubDescription,
} from "../content-scrub";

test("scrubBullet — AMZCOM Oscar Mayer two-line bullet splits and cleans", () => {
  const input =
    "• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling \n•  🍽️ Ideal for family barbecues and gatherings";
  const out = scrubBullet(input);
  assert.deepEqual(out, [
    "Includes 8 Oscar Mayer Bun Length Franks for grilling",
    "For family barbecues and gatherings",
  ]);
});

test("scrubBullet — strips multiple emoji types + manual bullet markers", () => {
  const input = "•  🎁 Comes in a convenient pack for easy storage 🧊";
  const out = scrubBullet(input);
  assert.deepEqual(out, ["Comes in a convenient pack for easy storage"]);
});

test("scrubBullet — drops bullets that become too short after scrub", () => {
  // Once "ultimate" and the emoji are stripped, only "!" is left → drop.
  const input = "• ✅ ultimate!";
  const out = scrubBullet(input);
  assert.deepEqual(out, []);
});

test("scrubBullet — capitalises first letter if scrub lowercased the start", () => {
  const input = "perfect for grilling and serving"; // no leading marker
  const out = scrubBullet(input);
  assert.deepEqual(out, ["For grilling and serving"]);
});

test("scrubBullet — preserves brand names verbatim", () => {
  const input =
    "🍽️ Premium Oscar Mayer Bologna sliced for sandwiches and snacks";
  const out = scrubBullet(input);
  // "premium" stripped, "Oscar Mayer" kept exactly.
  assert.deepEqual(out, [
    "Oscar Mayer Bologna sliced for sandwiches and snacks",
  ]);
});

test("scrubBulletArray — flattens multi-line bullets across the array", () => {
  const input = [
    "• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling \n•  🍽️ Ideal for family barbecues and gatherings",
    "•  🎁 Comes in a convenient pack for easy storage 🧊",
    "• 💚 Made with quality ingredients for a delicious taste",
  ];
  const out = scrubBulletArray(input);
  assert.deepEqual(out, [
    "Includes 8 Oscar Mayer Bun Length Franks for grilling",
    "For family barbecues and gatherings",
    "Comes in a convenient pack for easy storage",
    "Made with quality ingredients for a taste",
  ]);
});

test("scrubDescription — strips <p>/<ul>/<li> and emojis, preserves text", () => {
  const input =
    '<p>Introducing the ultimate frozen food Gift Set, perfect for any occasion!</p>\n<ul>\n  <li>Includes a variety of premium Oscar Mayer Bun-Length Franks.</li>\n  <li>Shipped in insulated packaging with ice packs.</li>\n</ul>';
  const out = scrubDescription(input);
  // Promotional words stripped, HTML converted to plain markers.
  assert.match(out, /Introducing the frozen food Gift Set, for any occasion!/);
  assert.match(out, /- Includes a variety of Oscar Mayer Bun-Length Franks\./);
  assert.match(out, /- Shipped in insulated packaging with ice packs\./);
  // No HTML left.
  assert.equal(out.includes("<"), false);
  assert.equal(out.includes(">"), false);
});

test("scrubDescription — decodes common HTML entities", () => {
  const input =
    "Salt &amp; pepper combo &mdash; great for grilling. Salt&nbsp;and pepper.";
  const out = scrubDescription(input);
  assert.match(out, /Salt & pepper combo/);
  assert.match(out, /Salt and pepper\./);
});

test("scrubDescription — empty input returns empty string", () => {
  assert.equal(scrubDescription(""), "");
  assert.equal(scrubDescription(null as unknown as string), "");
});

test("scrubDescription — fully clean text passes through unchanged-ish", () => {
  const input = "Salutem Vita gift set. Includes 8 sandwich rolls.";
  const out = scrubDescription(input);
  assert.equal(out, input);
});
