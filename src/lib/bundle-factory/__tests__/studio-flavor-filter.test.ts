import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFlavorFilter, normalizeFlavorToken, parsePrompt } from "../studio-engine";

const ENTRIES = [
  { key: "peanut butter & strawberry jam", label: "Peanut Butter & Strawberry Jam" },
  { key: "peanut butter & grape jelly", label: "Smuckers Peanut Butter & Grape Jelly" },
  { key: "peanut butter", label: "Peanut Butter" },
  { key: "chocolate hazelnut", label: "Chocolate Flavored Hazelnut Spread" },
];

test("exact key match (what the module UI sends)", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["peanut butter & grape jelly"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].key, "peanut butter & grape jelly");
  assert.deepEqual(unmatched, []);
});

test("brand words never break identity (label with Smuckers prefix)", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["Peanut Butter & Grape Jelly"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].key, "peanut butter & grape jelly");
  assert.deepEqual(unmatched, []);
});

test("NO substring over-match: 'Peanut Butter' selects ONLY the plain flavor", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["Peanut Butter"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].key, "peanut butter");
  assert.deepEqual(unmatched, []);
});

test("partial words are fail-closed, not fuzzy-matched", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["grape jelly", "hazelnut"]);
  assert.deepEqual(matched, []);
  assert.deepEqual(unmatched, ["grape jelly", "hazelnut"]);
});

test("unknown flavor reported, never silently dropped", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, [
    "Peanut Butter & Strawberry Jam",
    "banana split",
  ]);
  assert.equal(matched.length, 1);
  assert.deepEqual(unmatched, ["banana split"]);
});

test("output preserves catalog entry order regardless of request order", () => {
  const { matched } = matchFlavorFilter(ENTRIES, [
    "Chocolate Flavored Hazelnut Spread",
    "Peanut Butter & Strawberry Jam",
  ]);
  assert.deepEqual(matched.map((m) => m.key), [
    "peanut butter & strawberry jam",
    "chocolate hazelnut",
  ]);
});

test("blank requests are ignored", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["  ", ""]);
  assert.deepEqual(matched, []);
  assert.deepEqual(unmatched, []);
});

test("normalizeFlavorToken strips brand + punctuation only", () => {
  assert.equal(
    normalizeFlavorToken("Smucker's Uncrustables Peanut Butter & Grape Jelly"),
    "peanut butter grape jelly",
  );
  assert.equal(normalizeFlavorToken("Peanut Butter & Grape Jelly"), "peanut butter grape jelly");
  assert.notEqual(
    normalizeFlavorToken("Whole Wheat Peanut Butter & Grape Jelly"),
    normalizeFlavorToken("Peanut Butter & Grape Jelly"),
  );
});

test("parsePrompt still extracts count and theme (regression)", () => {
  const p = parsePrompt("50 Uncrustables listings in different variations");
  assert.equal(p.count, 50);
  assert.match(p.theme.toLowerCase(), /uncrustables/);
});
