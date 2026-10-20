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
  hasOrderContext: true,
  reasoning: "Table A row 1",
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
    { hasOrderContext: false },
    { isFallback: true },
    { channel: "Walmart" },
    { reasoning: "x [NEEDS REVIEW: tone]" },
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
  assert.ok(replyContentViolations("this snack cures headaches").length > 0);
  assert.deepEqual(replyContentViolations("so we can prevent any future issues"), []);
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

// ── Owner reply import ────────────────────────────────────────────────

import { inferOwnerAction, parseConfirmationText } from "../owner-reply-import";

test("parses an Amazon 'Your e-mail to' confirmation", () => {
  const text = `Dear Salutem Solutions,
Here is a copy of the e-mail that you sent to Debbi.
Order ID: 112-0463352-2305004:
B097S4JNKY
Tyson Grilled Chicken Fillets (Pack of 3)
------------- Begin message -------------
Hello Debbi,
Could you please clarify whether there was any actual damage?
Best regards,
Customer Support Team
------------- End message -------------
Warmest Regards`;
  const c = parseConfirmationText(text, "Your e-mail to Debbi");
  assert.ok(c);
  assert.equal(c.orderId, "112-0463352-2305004");
  assert.equal(c.buyerName, "Debbi");
  assert.equal(c.product, "Tyson Grilled Chicken Fillets (Pack of 3)");
  assert.match(c.replyText, /^Hello Debbi,/);
  assert.match(c.replyText, /Customer Support Team$/);
  assert.equal(parseConfirmationText("no markers here", "x"), null);
});

test("infers the owner's action from reply text", () => {
  assert.equal(inferOwnerAction("We will send a replacement at no cost."), "replacement");
  assert.equal(inferOwnerAction("We have issued a full refund."), "full_refund");
  assert.equal(inferOwnerAction("Could you please provide a photo of the box?"), "clarify");
  assert.equal(inferOwnerAction("Your package is on the way."), "reassure");
});

// ── Transit facts ─────────────────────────────────────────────────────

import { transitFacts } from "../transit";

test("transit hours run from the first real carrier scan to delivery", () => {
  const tf = transitFacts([
    { date: "2026-10-07", time: "14:06", description: "Shipper created a label, UPS has not received the package yet.", status: "M" },
    { date: "2026-10-08", time: "19:30", description: "Pickup Scan", status: "P", location: "CLEARWATER, FL" },
    { date: "2026-10-10", time: "15:34", description: "DELIVERED", status: "D", location: "MARTINSBURG, WV" },
  ]);
  assert.equal(tf.firstCarrierScan, "2026-10-08 19:30");
  assert.equal(tf.transitHours, 44);
  assert.equal(tf.deliveryDetail, "DELIVERED @ MARTINSBURG, WV");
});

test("no delivery yet → transit hours unknown", () => {
  const tf = transitFacts([{ date: "2026-10-08", time: "10:00", description: "Origin Scan", status: "I" }]);
  assert.equal(tf.delivered, null);
  assert.equal(tf.transitHours, null);
});

test("label-only tracking = carrier never accepted the package", () => {
  // Real case 2026-10-20: 16 days on this single event; the hub had called it
  // "shipped on time" and sent the buyer to A-to-Z.
  const tf = transitFacts([
    { date: "2026-10-04", time: "16:29", description: "Shipper created a label, UPS has not received the package yet. ", status: "M", location: "US" },
  ]);
  assert.equal(tf.firstCarrierScan, null);
  assert.equal(tf.transitHours, null);
  for (const d of ["Shipping Label Created, USPS Awaiting Item", "Shipment information sent to FedEx"]) {
    assert.equal(transitFacts([{ date: "2026-10-04", time: "10:00", description: d, status: "I" }]).firstCarrierScan, null, d);
  }
});

// ── Minimum case data gate ────────────────────────────────────────────

import { exhaustedNoteRu, nextStep, type CaseDataSnapshot } from "../case-data-gate";

function snap(missing: string[], vps?: string): CaseDataSnapshot {
  const keys = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"] as const;
  return {
    collectedAt: "2026-10-20T00:00:00Z",
    items: keys.map((k) => ({
      key: k,
      present: !missing.includes(k),
      fact: missing.includes(k) ? "" : `${k} fact`,
      factRu: missing.includes(k) ? "" : `${k} факт`,
      tried: missing.includes(k) ? [{ source: "Veeqo", ok: false, note: "не найдено" }] : [],
    })),
    vpsLookup: vps ? { status: vps, at: "2026-10-20T00:00:00Z" } : null,
  };
}

test("complete data → READY", () => {
  assert.equal(nextStep(snap([])), "READY");
});

test("missing tracking → VPS lookup first, owner only after it", () => {
  assert.equal(nextStep(snap(["M6"])), "VPS_LOOKUP");
  assert.equal(nextStep(snap(["M6"], "QUEUED")), "VPS_LOOKUP");
  assert.equal(nextStep(snap(["M6"], "DONE")), "OWNER");
  assert.equal(nextStep(snap(["M6"], "FAILED")), "OWNER");
});

test("product type cannot come from Seller Central → straight to owner", () => {
  assert.equal(nextStep(snap(["M7"])), "OWNER");
});

test("owner note says what was searched and where", () => {
  const note = exhaustedNoteRu(snap(["M7"]));
  assert.match(note, /Нет: тип товара/);
  assert.match(note, /Искали: Veeqo \(не найдено\)/);
});

// ── Card text format (owner-approved, 2026-10-20) ─────────────────────

import { renderCardText } from "../card-format";

test("card text follows the approved Telegram format", () => {
  const t = renderCardText({
    orderId: "114-1631599-6877866",
    store: "Salutem Solutions",
    version: 2,
    deadlineRu: "ответить до 20.10, 23:29 ET (осталось ~5 ч)",
    clientRu: "Просит отправить заказ повторно.",
    historyRu: null,
    facts: [{ what: "Отгрузка", value: "UPS Ground, трек `1Z29K3Y40313308184` | этикетка 04.10" }],
    verdictRu: "Наша вина — отправляем повторно за 1–2 рабочих дня",
    pointsRu: ["Не упоминаем A-to-Z"],
    missing: [],
    draftRu: "Здравствуйте,\n\nПриносим извинения.",
    draftEn: "Hello,\n\nWe are sorry.\n\nBest regards,\nCustomer Support Team",
    attachments: [],
  });
  assert.match(t, /^# Заказ 114-1631599-6877866 · Salutem Solutions\n\n\*\*ответить до .*\*\* · v2/);
  assert.match(t, /## Факты\n\n\| Что \| Данные \|\n\|---\|---\|\n\| Отгрузка \| UPS Ground, трек `1Z29K3Y40313308184` \/ этикетка 04\.10 \|/);
  assert.match(t, /## Решение движка\n\n\*\*Наша вина — .*\*\*\n\n- Не упоминаем A-to-Z/);
  assert.doesNotMatch(t, /Не удалось проверить/);
  assert.match(t, /## Ответ покупателю \(по-русски, для тебя\)\n\n> Здравствуйте,/);
  assert.match(t, /## Что уйдёт покупателю \(по-английски\)\n\n> Hello,\n>\n> We are sorry\./);
  assert.ok(t.indexOf("по-русски") < t.indexOf("по-английски"));
});
