import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInboxResult, replyAnswers, urgencyOf } from "../inbox-rules";

const t = (iso: string) => new Date(iso);

test("brenda: our 26.10 reply does not answer her 31.10 follow-up", () => {
  assert.equal(replyAnswers(t("2026-10-31T16:35:00Z"), t("2026-10-26T01:23:42Z")), false);
});

test("Rosemarie: 30.10 22:00 reply answers her 30.10 19:41 message", () => {
  assert.equal(replyAnswers(t("2026-10-30T19:41:54Z"), t("2026-10-30T22:00:50Z")), true);
});

test("a reply two minutes before the buyer's message does not answer it", () => {
  assert.equal(replyAnswers(t("2026-10-28T22:08:24Z"), t("2026-10-28T22:06:29Z")), false);
});

test("Michael: card posted 30.10, no decision, past the 24 h window → overdue + card_stale", () => {
  const u = urgencyOf({
    receivedAt: t("2026-10-30T23:36:03Z"),
    now: t("2026-11-01T21:00:00Z"),
    card: { status: "PUBLISHED", createdAt: t("2026-10-30T23:41:51Z") },
    covered: true,
  });
  assert.equal(u.level, "overdue");
  assert.deepEqual(u.flags, ["overdue", "card_stale"]);
  assert.ok(u.hoursLeft < 0);
});

test("message with no card is flagged no_card; under 6 h left → due_soon first", () => {
  const u = urgencyOf({ receivedAt: t("2026-11-01T00:00:00Z"), now: t("2026-11-01T20:00:00Z"), covered: false });
  assert.deepEqual(u.flags, ["due_soon", "no_card"]);
  assert.equal(u.hoursLeft, 4);
});

test("fresh card with time left → ok", () => {
  const u = urgencyOf({
    receivedAt: t("2026-11-01T18:00:00Z"),
    now: t("2026-11-01T19:00:00Z"),
    card: { status: "PENDING", createdAt: t("2026-11-01T18:30:00Z") },
    covered: true,
  });
  assert.equal(u.level, "ok");
});

test("approved reply not sent by the VPS agent within an hour → send_stuck", () => {
  const u = urgencyOf({
    receivedAt: t("2026-11-01T10:00:00Z"),
    now: t("2026-11-01T13:00:00Z"),
    card: { status: "APPROVED", createdAt: t("2026-11-01T10:30:00Z") },
    sendTask: { status: "QUEUED", createdAt: t("2026-11-01T11:00:00Z") },
    covered: true,
  });
  assert.deepEqual(u.flags, ["send_stuck"]);
});

test("INBOX_SCAN result parsing: order id from text, Over SLA from status", () => {
  const items = parseInboxResult({
    items: [
      { order: "Order 113-8615743-9544212", buyer: "Michael", status: "Over SLA", message: "We only received 16" },
      { orderId: "114-2471869-1927461", buyerName: "brenda", overSla: true, subject: "Order inquiry" },
      { buyerName: "no order" },
    ],
  });
  assert.equal(items[0].orderId, "113-8615743-9544212");
  assert.equal(items[0].overSla, true);
  assert.equal(items[0].text, "We only received 16");
  assert.equal(items[1].buyerName, "brenda");
  assert.equal(items[2].orderId, null);
  assert.deepEqual(parseInboxResult({ responseNeeded: [] }), []);
  assert.deepEqual(parseInboxResult(null), []);
});

import { validateInboxScan } from '../inbox-rules';
import { needsOwnerDecision } from '../inbox-rules';
test('answered cards and stale snapshots never enter decision digests', () => {
  for (const cardStatus of ['SENT', 'SUPERSEDED', 'CLOSED', 'RESOLVED']) {
    assert.equal(needsOwnerDecision({fresh:true, cardStatus}), false);
  }
  assert.equal(needsOwnerDecision({fresh:false, cardStatus:'PUBLISHED'}), false);
  assert.equal(needsOwnerDecision({fresh:true, cardStatus:'PUBLISHED', responseSentAt:new Date()}), false);
  assert.equal(needsOwnerDecision({fresh:true, cardStatus:'PUBLISHED', messageStatus:'SENT'}), false);
  assert.equal(needsOwnerDecision({fresh:true, cardStatus:'PUBLISHED', messageStatus:'ANALYZED'}), true);
  assert.equal(needsOwnerDecision({fresh:true, cardStatus:null}), true);
});
test('absence is only authoritative for a complete, fresh, exact-account two-folder scan', () => {
  const now = t('2026-11-06T14:00:00Z');
  const good = {storeIndex:1, accountName:'Salutem Solutions', complete:true, scannedAt:now.toISOString(), items:[], resolved:[]};
  assert.deepEqual(validateInboxScan(good, now).items, []);
  for (const bad of [{}, {...good,complete:false}, {...good,storeIndex:2}, {...good,resolved:undefined}, {...good,items:[{}]}, {...good,scannedAt:'2026-11-06T12:00:00Z'}]) assert.throws(()=>validateInboxScan(bad,now));
});
