import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelErrorInfo,
  classifyTracking,
  isDefinitiveRefusal,
} from "../label-discard";

const ev = (status: string | null, description: string, date = "2026-10-20") => ({
  date,
  time: "10:00",
  description,
  status,
  location: null,
});
const info = (events: ReturnType<typeof ev>[], extra: Partial<{ currentStatus: string | null; delivered: boolean; actualDelivery: string | null }> = {}) => ({
  currentStatus: extra.currentStatus ?? null,
  delivered: extra.delivered ?? false,
  actualDelivery: extra.actualDelivery ?? null,
  events,
});

test("label created only → not scanned (refundable)", () => {
  // FedEx OC, UPS M, USPS pre-shipment.
  for (const e of [
    ev("OC", "Shipment information sent to FedEx"),
    ev("M", "Shipper created a label, UPS has not received the package yet."),
    ev(null, "Shipping Label Created, USPS Awaiting Item"),
    ev(null, "Pre-Shipment Info Sent to USPS"),
  ]) {
    const c = classifyTracking(info([e], { currentStatus: "Label created" }));
    assert.equal(c.scanned, false, e.description);
    assert.equal(c.delivered, false);
    assert.equal(c.cancelled, false);
  }
});

test("picked up / in transit → scanned (refused)", () => {
  const c = classifyTracking(
    info([ev("OC", "Shipment information sent to FedEx"), ev("PU", "Picked up", "2026-10-21")], {
      currentStatus: "In transit",
    }),
  );
  assert.equal(c.scanned, true);
  assert.match(c.lastEvent ?? "", /Picked up/);
});

test("delivered → delivered + scanned", () => {
  const c = classifyTracking(
    info([ev("DL", "Delivered")], { currentStatus: "Delivered", delivered: true, actualDelivery: "2026-10-22" }),
  );
  assert.equal(c.delivered, true);
  assert.equal(c.scanned, true);
  assert.equal(c.deliveredOn, "2026-10-22");
});

test("carrier already shows the label cancelled → cancelled, not scanned", () => {
  const c = classifyTracking(
    info([ev("OC", "Shipment information sent to FedEx"), ev("CA", "Shipment cancelled by sender")]),
  );
  assert.equal(c.cancelled, true);
  assert.equal(c.scanned, false);
});

test("no events but an in-transit status → scanned", () => {
  assert.equal(classifyTracking(info([], { currentStatus: "In Transit" })).scanned, true);
  assert.equal(classifyTracking(info([], { currentStatus: "Label Created" })).scanned, false);
  assert.equal(classifyTracking(info([], {})).scanned, false);
});

test("Veeqo error → status + plain text, no HTML", () => {
  const e = new Error('Veeqo API error 422: <p>Shipment <b>cannot</b> be cancelled</p>');
  assert.deepEqual(cancelErrorInfo(e), { status: 422, text: "Shipment cannot be cancelled" });
  assert.equal(cancelErrorInfo(new Error("fetch failed")).status, null);
});

test("Walmart error body → its description", () => {
  const e = Object.assign(new Error("Walmart API 400"), {
    status: 400,
    errorBody: { errors: [{ code: "INVALID", description: "Label already used" }] },
  });
  assert.deepEqual(cancelErrorInfo(e), { status: 400, text: "Label already used" });
});

test("only a real 4xx counts as a definite refusal", () => {
  assert.equal(isDefinitiveRefusal(422), true);
  assert.equal(isDefinitiveRefusal(404), true);
  assert.equal(isDefinitiveRefusal(429), false);
  assert.equal(isDefinitiveRefusal(408), false);
  assert.equal(isDefinitiveRefusal(502), false);
  assert.equal(isDefinitiveRefusal(null), false);
});
