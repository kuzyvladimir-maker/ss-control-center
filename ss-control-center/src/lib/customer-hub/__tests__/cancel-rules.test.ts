import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cancelAlertRu,
  cancelFactForPrompt,
  cancelInstruction,
  parseCancelNotice,
  requestedBeforeLabel,
  type CancelRequestFact,
} from "../cancel-rules";
import { ATOZ_REDIRECT_RE, REFUND_REFUSAL_RE, refundBasis } from "../refund-rule";
import { renderCardText } from "../card-format";

const t = (iso: string) => new Date(iso);

const brenda: CancelRequestFact = {
  requestedAt: "2026-10-17T15:46:47.000Z",
  source: "amazon-notification",
  kind: "REQUEST",
  labelPurchasedAt: "2026-10-20T14:05:00.000Z",
  labelSource: "veeqo",
  beforeShipment: true,
  orderTotal: 144.55,
};

test("notice subjects: request vs cancelled vs unrelated", () => {
  assert.deepEqual(parseCancelNotice("Order cancelation request for Order ID: 114-2471869-1927461"), {
    orderId: "114-2471869-1927461",
    kind: "REQUEST",
  });
  assert.deepEqual(parseCancelNotice("Your order 113-2281407-1887407 has been cancelled as per customer’s request"), {
    orderId: "113-2281407-1887407",
    kind: "CANCELLED",
  });
  assert.equal(parseCancelNotice("Order inquiry from Amazon customer brenda"), null);
  assert.equal(parseCancelNotice("Order cancelation request"), null);
});

test("brenda: request 17.10 11:46 ET, Veeqo label 20.10 → before shipment", () => {
  assert.equal(requestedBeforeLabel(t(brenda.requestedAt), { at: t(brenda.labelPurchasedAt!), precise: true }), true);
});

test("request after the label → not before shipment", () => {
  assert.equal(requestedBeforeLabel(t("2026-10-20T15:00:00Z"), { at: t("2026-10-20T14:05:00Z"), precise: true }), false);
});

test("date-only label: earlier day proves before, same day stays unknown, later day proves after", () => {
  const label = { at: t("2026-10-20T12:00:00Z"), precise: false };
  assert.equal(requestedBeforeLabel(t("2026-10-17T15:46:47Z"), label), true);
  // 20.10 23:30 UTC is still 20.10 in New York
  assert.equal(requestedBeforeLabel(t("2026-10-20T23:30:00Z"), label), null);
  assert.equal(requestedBeforeLabel(t("2026-10-21T16:00:00Z"), label), false);
  assert.equal(requestedBeforeLabel(t("2026-10-17T15:46:47Z"), null), null);
});

test("refund rule: cancellation before shipment → allowed, no replacement-first, over $50 the owner decides", () => {
  const b = refundBasis({ customerMessage: "Return my money immediately", cancelBeforeShipment: true, orderTotal: 144.55 });
  assert.equal(b.allowed, true);
  assert.equal(b.cancelBeforeShipment, true);
  assert.equal(b.ownerDecides, true);
  const small = refundBasis({ customerMessage: "please refund", cancelBeforeShipment: true, orderTotal: 39.82 });
  assert.equal(small.ownerDecides, false);
  const none = refundBasis({ customerMessage: "Return my money immediately" });
  assert.equal(none.allowed, false);
  assert.equal(none.ownerDecides, false);
});

test("refusal / A-to-Z redirect detectors catch brenda's 01.11 refusal wording", () => {
  const refusal =
    "Because the order shipped on time through Amazon Buy Shipping and delivery is confirmed by the carrier, we are unable to issue a refund or replacement directly from our side for this order. The appropriate next step is to contact Amazon Customer Service and request an A-to-Z Guarantee review.";
  assert.ok(REFUND_REFUSAL_RE.test(refusal));
  assert.ok(ATOZ_REDIRECT_RE.test(refusal));
  assert.ok(!REFUND_REFUSAL_RE.test("We have reviewed your order together with your cancellation request and will follow up shortly."));
});

test("prompt fact, instruction and red card line for brenda", () => {
  assert.match(cancelFactForPrompt(brenda), /CANCELLATION REQUESTED BEFORE SHIPMENT/);
  assert.match(cancelInstruction(brenda)!, /investigate/);
  assert.match(cancelInstruction({ ...brenda, orderTotal: 39.82 })!, /full_refund/);
  assert.equal(cancelInstruction({ ...brenda, beforeShipment: false }), null);
  const alert = cancelAlertRu(brenda)!;
  assert.match(alert, /до отгрузки \(17\.10 11:46 ET\), вина наша/);
  assert.match(alert, /\$144\.55 > \$50 — решите вы/);
  assert.equal(cancelAlertRu({ ...brenda, beforeShipment: null }), null);
});

test("info card text: red line under the title, no draft section", () => {
  const text = renderCardText({
    orderId: "114-2471869-1927461",
    store: "Salutem Solutions",
    version: 4,
    alertRu: cancelAlertRu(brenda),
    infoOnly: true,
    deadlineRu: "срок ответа прошёл",
    clientRu: "Верните деньги",
    historyRu: null,
    facts: [{ what: "Отмена", value: "запрос отмены 17.10 11:46 ET — ДО покупки этикетки" }],
    verdictRu: "Нужно решение по возврату",
    pointsRu: [],
    missing: [],
    draftRu: null,
    draftEn: "",
    attachments: [],
  });
  const lines = text.split("\n\n");
  assert.match(lines[2], /^\*\*🔴 Отмена была запрошена до отгрузки/);
  assert.ok(!text.includes("Что уйдёт покупателю"));
  assert.match(text, /кнопок нет/);
});
