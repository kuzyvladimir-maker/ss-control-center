/**
 * What a mixed listing says it contains.
 *
 * The homogeneous builder states in its bullets and description that every
 * package is identical and that the pack is "not a mixed assortment". Reusing
 * it for a real mix would print a false sentence on a live product page, so a
 * mix has its own wording — held to the same brand-voice rules.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeterministicWalmartMixedPackContent,
} from "../walmart-new-sku-engine";

const soup = (flavor: string, qty: number) => ({
  product_name: `Campbell's Condensed ${flavor} Soup, 10.5 oz Can`,
  manufacturer_brand: "Campbell's",
  flavor,
  qty,
});

test("the title names every variety and how many of each", () => {
  const content = buildDeterministicWalmartMixedPackContent({
    components: [soup("Tomato", 4), soup("Chicken Noodle", 4)],
    packCount: 8,
  });
  assert.match(content.title, /Variety Pack/);
  assert.match(content.title, /Tomato/);
  assert.match(content.title, /Chicken Noodle/);
  assert.match(content.title, /8-Pack, 2 Varieties, 4 of Each/);
  assert.ok(content.title.length <= 150);
  assert.equal(content.generator, "deterministic-product-truth-mixed-pack/v1");
});

test("it never claims the packages are identical", () => {
  const content = buildDeterministicWalmartMixedPackContent({
    components: [soup("Tomato", 4), soup("Chicken Noodle", 4)],
    packCount: 8,
  });
  const everything = [content.title, ...content.bullets, content.description].join(" ");
  assert.doesNotMatch(everything, /identical/i);
  assert.doesNotMatch(everything, /not a mixed assortment/i);
  assert.doesNotMatch(everything, /homogeneous/i);
  // And it does state the real contents, per variety.
  assert.match(content.description, /4 packages of Campbell's Condensed Tomato Soup/);
  assert.match(content.description, /4 packages of Campbell's Condensed Chicken Noodle Soup/);
});

test("the brand voice holds: no emoji, no promotional adjectives, no shipping claims", () => {
  const content = buildDeterministicWalmartMixedPackContent({
    components: [soup("Tomato", 4), soup("Chicken Noodle", 4)],
    packCount: 8,
  });
  const everything = [content.title, ...content.bullets, content.description].join(" ");
  assert.doesNotMatch(everything, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(
    everything,
    /\b(ultimate|perfect|delicious|premium|best|amazing|exclusive|must-have)\b/i,
  );
  assert.doesNotMatch(everything, /\b(free shipping|ships frozen|on sale|limited time)\b/i);
});

test("uneven counts are described without claiming an even split", () => {
  const content = buildDeterministicWalmartMixedPackContent({
    components: [soup("Tomato", 5), soup("Chicken Noodle", 3)],
    packCount: 8,
  });
  assert.doesNotMatch(content.title, /of Each/);
  assert.match(content.description, /5 packages of/);
  assert.match(content.description, /3 packages of/);
});

test("quantities that miss the pack count are refused", () => {
  assert.throws(
    () => buildDeterministicWalmartMixedPackContent({
      components: [soup("Tomato", 4), soup("Chicken Noodle", 3)],
      packCount: 8,
    }),
    /RECIPE_QTY_MISMATCH:7!=8/,
  );
});

test("one component is not an assortment", () => {
  assert.throws(
    () => buildDeterministicWalmartMixedPackContent({
      components: [soup("Tomato", 8)],
      packCount: 8,
    }),
    /MIXED_PACK_NEEDS_TWO_COMPONENTS/,
  );
});

test("a title too long to list every variety degrades instead of failing", () => {
  // A real build died with WALMART_TITLE_TOO_LONG:225>150 because each variety
  // contributed its full identity label. The listing must still be buildable.
  const longNames = [
    "Chunky Pub-Style Chicken Pot Pie with Seasoned White Meat Chicken",
    "Chunky Baked Potato with Steak and Cheese Flavored Hearty Soup",
  ];
  const content = buildDeterministicWalmartMixedPackContent({
    components: longNames.map((flavor) => ({
      product_name: `Campbell's ${flavor} Soup, 18.8 oz Can`,
      manufacturer_brand: "Campbell's",
      flavor,
      qty: 4,
    })),
    packCount: 8,
  });
  assert.ok(content.title.length <= 150, `title was ${content.title.length}`);
  assert.match(content.title, /Variety Pack/);
  // What did not fit in the title is still stated in full in the description.
  for (const flavor of longNames) assert.match(content.description, new RegExp(flavor));
});

test("varieties with no short flavor still fit the bullets", () => {
  // Independent review 2026-08-08: fixing the title moved the failure into the
  // bullets — two identities of 181 characters gave BULLET_2_TOO_LONG:181>100.
  const identity = (n: number) =>
    `Chunky Pub-Style Chicken Pot Pie with Seasoned White Meat Chicken and Garden Vegetables `
    + `in a Rich Savory Broth Recipe Number ${n}`;
  const content = buildDeterministicWalmartMixedPackContent({
    components: [1, 2].map((n) => ({
      product_name: `Campbell's ${identity(n)} Soup, 18.8 oz Can`,
      manufacturer_brand: "Campbell's",
      flavor: null,
      qty: 4,
    })),
    packCount: 8,
  });
  assert.ok(content.title.length <= 150, `title ${content.title.length}`);
  for (const [index, bullet] of content.bullets.entries()) {
    assert.ok(bullet.length <= 100, `bullet ${index + 1} was ${bullet.length}: ${bullet}`);
  }
  // The full names are dropped from the short labels but kept in the body.
  assert.match(content.description, /Recipe Number 1/);
  assert.match(content.description, /Recipe Number 2/);
});
