import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFromFacts, type DecisionEvidence } from "../decision-facts";
import { missingKeys, nextStep, factsForPrompt, MINIMUM, type CaseDataSnapshot } from "../case-data-gate";
const now = Date.parse("2026-11-13T19:00:00Z");
const evidence = (): DecisionEvidence => ({
  receivedAt: "2026-11-13T17:30:00Z", threadMode: "new", previousBuyerMessages: 0,
  label: { state: "purchased", at: "2026-11-08T22:41:56.066Z", checkedAt: new Date(now).toISOString(), source: "Veeqo live" },
  tracking: { live: true, checkedAt: new Date(now).toISOString(), source: "UPS API", events: [
    { date: "2026-11-09", time: "18:51", status: "I", description: "Origin Scan", location: "US" },
    { date: "2026-11-12", time: "12:17", status: "D", description: "DELIVERED", location: "ERLANGER KY US" },
  ] }, issues: [],
});
const decide = (e = evidence(), extra = {}) => decideFromFacts({ customerMessage: "We want to return the item. The item is totally unopened. Please share the return label.", productType: "Frozen", orderTotal: 28.34, evidence: e, ...extra }, now);
test("113-7298846: delivered frozen unopened return with no cancellation evidence selects no refund", () => {
  const p = decide(); assert.equal(p.ready, true); assert.equal(p.pattern, "FOOD_CHANGE_OF_MIND"); assert.equal(p.action, "no_refund");
});
test("actual historical cancellation is preserved and escalated, never silently ignored or applied", () => {
  const p = decide(evidence(), { cancelRequest: { kind: "REQUEST", requestedAt: "2026-11-08T04:54:44Z", beforeShipment: true, labelPurchasedAt: "2026-11-08T22:41:56Z", labelSource: "veeqo", source: "amazon-notification", orderTotal: 28.34 } });
  assert.equal(p.ready, false); assert.equal(p.pattern, "POLICY_CONFLICT"); assert.equal(p.action, null);
});
test("request before confirmed label and first scan permits cancellation exception", () => {
  const e = evidence(); e.receivedAt = "2026-11-07T12:00:00Z";
  assert.equal(decide(e, { customerMessage: "Please cancel my order" }).action, "full_refund");
  assert.equal(decide(e, { customerMessage: "Please cancel my order", orderTotal: 50.01 }).action, "investigate");
});
test("verified absence of label permits current cancellation; no carrier call is applicable", () => {
  const e = evidence(); e.label.state = "absent"; e.label.at = null; e.tracking.events = []; e.tracking.live = false;
  assert.equal(decide(e, { customerMessage: "Please cancel my order" }).pattern, "CANCEL_BEFORE_LABEL");
});
test("new cancellation after delivery cannot borrow an old notice timestamp", () => {
  assert.notEqual(decide(evidence(), { customerMessage: "Please cancel my order" }).pattern, "CANCEL_BEFORE_LABEL");
});
test("stale cache or failed API does not provide proof of no first scan", () => {
  for (const change of [ (e: DecisionEvidence) => { e.tracking.live = false; }, (e: DecisionEvidence) => { e.tracking.checkedAt = "2026-11-12T00:00:00Z"; }, (e: DecisionEvidence) => { e.tracking.events = []; }, (e: DecisionEvidence) => { e.label.state = "unknown"; } ]) {
    const e = evidence(); change(e); assert.equal(decide(e).ready, false);
  }
});
test("contradictory dates and incomplete event dates block decisions", () => {
  const e = evidence(); e.label.at = "2026-11-12T18:00:00Z"; assert.equal(decide(e).ready, false);
  const bad = evidence(); bad.tracking.events[0].date = "invalid"; assert.equal(decide(bad).ready, false);
});
test("reply context survives pattern selection, spoilage gets replacement first", () => {
  const e = evidence(); e.threadMode = "reply";
  const p = decide(e, { customerMessage: "It arrived thawed and smells rotten. I want to return it." });
  assert.equal(p.threadMode, "reply"); assert.equal(p.action, "replacement");
});
test("empty snapshot is missing all eight required facts; provenance reaches prompt", () => {
  assert.equal(missingKeys({ collectedAt: "", items: [] }).length, 8);
  const s: CaseDataSnapshot = { collectedAt: new Date(now).toISOString(), decision: decide(), items: Object.keys(MINIMUM).map(key => ({ key: key as keyof typeof MINIMUM, present: true, fact: "fact", factRu: "факт", tried: [{ source: "UPS API", ok: true }] })) };
  assert.equal(nextStep(s), "READY"); assert.match(factsForPrompt(s), /source: UPS API/);
  s.decision!.ready = false; assert.equal(nextStep(s), "OWNER");
});


test("a policy mentioning refund is not an owner refund authorization", async () => {
  const { refundBasis } = await import("../refund-rule");
  assert.equal(refundBasis({ customerMessage: "changed my mind", extraInstruction: "Never refund without our-fault basis" }).ownerOrderedRefund, false);
  assert.equal(refundBasis({ customerMessage: "changed my mind", ownerRefundAuthorized: true }).ownerOrderedRefund, true);
});

test("same-day scan without timezone cannot prove pre-shipment cancellation", () => {
  const e = evidence(); e.receivedAt = "2026-11-09T01:00:00Z"; e.label.at = "2026-11-09T02:00:00Z";
  assert.equal(decide(e, { customerMessage: "Please cancel" }).ready, false);
});
test("explicit absence of damage is not a spoilage complaint", () => {
  assert.equal(decide(evidence(), { customerMessage: "Not damaged. I want to return this unopened item." }).action, "no_refund");
});
