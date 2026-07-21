import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFlavorFilter, parsePrompt } from "../studio-engine";

const ENTRIES = [
  { key: "peanut butter & strawberry jam", label: "Peanut Butter & Strawberry Jam" },
  { key: "peanut butter & grape jelly", label: "Peanut Butter & Grape Jelly" },
  { key: "chocolate hazelnut", label: "Chocolate Flavored Hazelnut Spread" },
];

test("exact label match (what the module UI sends)", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["Peanut Butter & Grape Jelly"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].key, "peanut butter & grape jelly");
  assert.deepEqual(unmatched, []);
});

test("case-insensitive + containment both ways (hand-typed prompts)", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["grape jelly", "HAZELNUT"]);
  assert.deepEqual(matched.map((m) => m.key).sort(), [
    "chocolate hazelnut",
    "peanut butter & grape jelly",
  ]);
  assert.deepEqual(unmatched, []);
});

test("unmatched request is reported, never silently dropped", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["grape jelly", "banana split"]);
  assert.equal(matched.length, 1);
  assert.deepEqual(unmatched, ["banana split"]);
});

test("one request matching several entries keeps them all, deduped", () => {
  const { matched } = matchFlavorFilter(ENTRIES, ["peanut butter", "peanut butter & grape jelly"]);
  assert.equal(matched.length, 2);
});

test("blank requests are ignored", () => {
  const { matched, unmatched } = matchFlavorFilter(ENTRIES, ["  ", ""]);
  assert.deepEqual(matched, []);
  assert.deepEqual(unmatched, []);
});

test("parsePrompt still extracts count and theme (regression)", () => {
  const p = parsePrompt("50 Uncrustables listings in different variations");
  assert.equal(p.count, 50);
  assert.match(p.theme.toLowerCase(), /uncrustables/);
});
