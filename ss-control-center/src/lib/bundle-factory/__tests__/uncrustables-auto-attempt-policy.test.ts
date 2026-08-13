import assert from "node:assert/strict";
import { test } from "node:test";

import {
  consumesUncrustablesQualityAttempt,
  nextUncrustablesQualityAttempt,
} from "@/lib/bundle-factory/uncrustables-auto-attempt-policy";

test("worker and postcheck failures do not consume a quality attempt", () => {
  assert.equal(consumesUncrustablesQualityAttempt({ stage: "RENDER", rendered: false }), false);
  assert.equal(nextUncrustablesQualityAttempt(2, { stage: "RENDER", rendered: false }), 2);
});

test("unavailable vision does not consume a quality attempt", () => {
  assert.equal(consumesUncrustablesQualityAttempt({ stage: "QA", verified: false }), false);
  assert.equal(nextUncrustablesQualityAttempt(2, { stage: "QA", verified: false }), 2);
});

test("a verified QA pass or rejection consumes exactly one attempt", () => {
  assert.equal(nextUncrustablesQualityAttempt(2, { stage: "QA", verified: true, passed: true }), 3);
  assert.equal(nextUncrustablesQualityAttempt(2, { stage: "QA", verified: true, passed: false }), 3);
});
