import { test } from "node:test";
import assert from "node:assert/strict";

import { predictProblemTypes, rankKnowledgeBase } from "../kb-retrieval";
import {
  evaluateAutosend,
  parseAutosendMode,
  replyContentViolations,
  type AutosendInput,
} from "../autosend-policy";
import { answeredAfter } from "../thread-state";

// ── KB retrieval ──────────────────────────────────────────────────────

test("pre-classifier finds T1 for a where-is-my-order message", () => {
  const p = predictProblemTypes("Hi, where is my order? I haven't received it yet.");
  assert.equal(p[0].problemType, "T1");
});

test("shipping mismatch always puts T21 first", () => {
  const p = predictProblemTypes("my box melted", { shippingMismatch: true });
  assert.equal(p[0].problemType, "T21");
  assert.ok(p.some((x) => x.problemType === "T4"));
});

test("ranking prefers same-type owner example over an unrelated seed", () => {
  const rows = [
    { problemType: "T8", scenario: "expired item", customerSaid: "the cookies are expired", source: "manual", channel: "Amazon" },
    { problemType: "T1", scenario: "package in transit, buyer asks where", customerSaid: "where is my package, it has not arrived", source: "manual", channel: "Amazon" },
    { problemType: "T1", scenario: "in transit within EDD", customerSaid: "where is my package? still not arrived", source: "owner_chatgpt", channel: "Amazon" },
  ];
  const msg = "Where is my package? It has not arrived yet";
  const ranked = rankKnowledgeBase(rows, {
    customerMessage: msg,
    channel: "Amazon",
    predicted: predictProblemTypes(msg),
  });
  assert.equal(ranked[0].row.source, "owner_chatgpt");
  assert.ok(ranked.every((r) => r.row.problemType === "T1"));
});

test("ranking drops rows with no overlap and no type match", () => {
  const ranked = rankKnowledgeBase(
    [{ problemType: "T12", scenario: "fraud", customerSaid: "I did not place this", channel: "Amazon" }],
    { customerMessage: "do you have gluten free options", predicted: predictProblemTypes("do you have gluten free options") }
  );
  assert.equal(ranked.length, 0);
});

// ── Auto-send policy ──────────────────────────────────────────────────

const base: AutosendInput = {
  channel: "Amazon",
  language: "English",
  problemType: "T1",
  action: "reassure",
  riskLevel: "LOW",
  foodSafetyRisk: false,
  atozRisk: "low",
  factCheckConfidence: "HIGH",
  kbTopScore: 0.9,
  responseText: "Dear Anna,\n\nYour package is with UPS and is expected on October 21.\n\nBest regards,\nSalutem Solutions",
  alreadyRepliedOnOrder: false,
  reasoning: "Table A row 1",
  customerEmail: "abc123@marketplace.amazon.com",
  autoSentToday: 0,
  dailyCap: 10,
};

test("mode parsing defaults to shadow", () => {
  assert.equal(parseAutosendMode(null), "shadow");
  assert.equal(parseAutosendMode("ON"), "on");
  assert.equal(parseAutosendMode("garbage"), "shadow");
});

test("informational T1 with a close example is eligible", () => {
  const d = evaluateAutosend(base);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.eligible, true);
});

test("money and claims are never eligible", () => {
  for (const patch of [
    { problemType: "T4", action: "replacement" },
    { problemType: "T11", action: "full_refund" },
    { problemType: "T1", action: "partial_refund" },
    { foodSafetyRisk: true },
    { atozRisk: "high" },
    { riskLevel: "MEDIUM" },
    { factCheckConfidence: "MEDIUM" },
    { kbTopScore: 0.3 },
    { language: "Spanish" },
    { alreadyRepliedOnOrder: true },
    { isFallback: true },
    { channel: "Walmart" },
    { reasoning: "x [NEEDS REVIEW: tone]" },
    { customerEmail: "buyer@gmail.com" },
    { autoSentToday: 10 },
  ] as Partial<AutosendInput>[]) {
    const d = evaluateAutosend({ ...base, ...patch });
    assert.equal(d.eligible, false, JSON.stringify(patch));
    assert.ok(d.reasons.length > 0);
  }
});

test("reply content rules catch links, contacts, review asks, emoji", () => {
  assert.ok(replyContentViolations("see https://example.com").length > 0);
  assert.ok(replyContentViolations("email us at help@salutem.solutions").length > 0);
  assert.ok(replyContentViolations("call 727-555-1234").length > 0);
  assert.ok(replyContentViolations("please leave us a positive review").length > 0);
  assert.ok(replyContentViolations("Thanks 😊").length > 0);
  assert.deepEqual(replyContentViolations(base.responseText as string), []);
});

// ── Thread state ──────────────────────────────────────────────────────

const SELLER = "amazon@salutem.solutions";
const hdr = (from: string, subject = "Order inquiry") => ({
  headers: [
    { name: "From", value: from },
    { name: "Subject", value: subject },
  ],
});

test("buyer follow-up in the thread is NOT an answer", () => {
  const msgs = [
    { id: "b1", internalDate: "1000", labelIds: ["INBOX"], payload: hdr("Buyer <x@marketplace.amazon.com>") },
    { id: "b2", internalDate: "2000", labelIds: ["INBOX"], payload: hdr("Buyer <x@marketplace.amazon.com>") },
  ];
  assert.equal(answeredAfter(msgs, "b1", SELLER), false);
});

test("our sent reply after the buyer message is an answer", () => {
  const msgs = [
    { id: "b1", internalDate: "1000", labelIds: ["INBOX"], payload: hdr("Buyer <x@marketplace.amazon.com>") },
    { id: "s1", internalDate: "2000", labelIds: ["SENT"], payload: hdr(`Salutem <${SELLER}>`) },
  ];
  assert.equal(answeredAfter(msgs, "b1", SELLER), true);
});

test("an older reply does not answer a newer buyer message", () => {
  const msgs = [
    { id: "s1", internalDate: "1000", labelIds: ["SENT"], payload: hdr(`Salutem <${SELLER}>`) },
    { id: "b2", internalDate: "2000", labelIds: ["INBOX"], payload: hdr("Buyer <x@marketplace.amazon.com>") },
  ];
  assert.equal(answeredAfter(msgs, "b2", SELLER), false);
});

test("Seller Central confirmation counts as an answer", () => {
  const msgs = [
    { id: "b1", internalDate: "1000", labelIds: ["INBOX"], payload: hdr("Buyer <x@marketplace.amazon.com>") },
    { id: "c1", internalDate: "3000", labelIds: ["INBOX"], payload: hdr("donotreply@amazon.com", "Your e-mail to Anna") },
  ];
  assert.equal(answeredAfter(msgs, "b1", SELLER), true);
});
