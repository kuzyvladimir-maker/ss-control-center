import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrubBuyerReply,
  hasVerifiedCarrierScan,
} from "../message-analyzer";

// Owner, topic 42, 2026-10-25:
//  (1) never concede "something went wrong",
//  (2) no "in transit" / carrier ETA without a verified carrier scan.

test("drops the 'something went wrong' concession, keeps the apology", () => {
  const input =
    "Hello Brenda,\n\nWe understand something went wrong with your order, we apologize for the inconvenience; we will resend your order right away.\n\nBest regards,\nCustomer Support Team";
  const out = scrubBuyerReply(input, false);
  assert.ok(!/something (went|has gone) wrong/i.test(out), "concession removed");
  assert.ok(/We apologize for the inconvenience/.test(out), "apology kept, capitalised");
  assert.ok(/resend your order/.test(out), "resend commitment kept");
});

test("bare 'something went wrong' sentence is removed too", () => {
  const out = scrubBuyerReply(
    "Hello,\n\nUnfortunately, something went wrong. We apologize for the inconvenience.\n\nBest regards,\nCustomer Support Team",
    true,
  );
  assert.ok(!/something went wrong/i.test(out));
  assert.ok(/We apologize for the inconvenience/.test(out));
});

test("unverified tracking: drops 'in transit' claim and the carrier ETA", () => {
  const input =
    "Hello,\n\nAt this stage, the package is already in transit with UPS and is currently scheduled for delivery on April 15. Unfortunately, once an order has been shipped, we are unable to cancel it.\n\nBest regards,\nCustomer Support Team";
  const out = scrubBuyerReply(input, false);
  assert.ok(!/in transit/i.test(out), "no in-transit claim");
  assert.ok(!/scheduled for delivery/i.test(out), "no carrier ETA");
  assert.ok(/has been shipped with UPS/.test(out), "neutral 'has been shipped' kept");
  assert.ok(/unable to cancel it/.test(out), "rest of the sentence survives");
});

test("verified tracking: 'in transit' and ETA are allowed to stay", () => {
  const input =
    "Hello,\n\nYour order was shipped via UPS and is currently in transit. It is scheduled for delivery on April 15.\n\nBest regards,\nCustomer Support Team";
  const out = scrubBuyerReply(input, true);
  assert.ok(/in transit/i.test(out), "transit kept when verified");
  assert.ok(/scheduled for delivery/i.test(out), "ETA kept when verified");
});

test("hasVerifiedCarrierScan: label-only is NOT verified, a real scan IS", () => {
  assert.equal(
    hasVerifiedCarrierScan([
      { date: "2026-04-10", time: "09:00", description: "Shipping label created", status: "M" },
    ]),
    false,
  );
  assert.equal(
    hasVerifiedCarrierScan([
      { date: "2026-04-10", time: "09:00", description: "Shipping label created", status: "M" },
      { date: "2026-04-11", time: "14:06", description: "Picked up", status: "P" },
    ]),
    true,
  );
  assert.equal(hasVerifiedCarrierScan([]), false);
  assert.equal(hasVerifiedCarrierScan(null), false);
});

test("idempotent — scrubbing twice changes nothing", () => {
  const once = scrubBuyerReply(
    "Hello,\n\nWe understand something went wrong, we apologize for the inconvenience. The package is already in transit with FedEx.\n\nBest regards,\nCustomer Support Team",
    false,
  );
  assert.equal(scrubBuyerReply(once, false), once);
});
