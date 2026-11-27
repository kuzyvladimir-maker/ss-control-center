import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEDEX_ONE_RATE_WEIGHT_MULT,
  computeFedexWeight,
  isFedexOneRateService,
} from "../fedex-weight";

test("One Rate multiplier is +20%, not the stale 1.25", () => {
  assert.equal(FEDEX_ONE_RATE_WEIGHT_MULT, 1.2);
});

test("computeFedexWeight: weight × 1.20, rounded to hundredths", () => {
  assert.equal(computeFedexWeight(10), 12);
  assert.equal(computeFedexWeight(7.5), 9);
  assert.equal(computeFedexWeight(16.75), 20.1);
  // 3.33 × 1.2 = 3.996 → 4
  assert.equal(computeFedexWeight(3.33), 4);
  // 1.234 × 1.2 = 1.4808 → 1.48
  assert.equal(computeFedexWeight(1.234), 1.48);
  assert.equal(computeFedexWeight(0), 0);
});

test("computeFedexWeight matches the buy route's push formula", () => {
  // buy/route.ts: Math.round(item.weight * 1.2 * 100) / 100
  for (const w of [0.5, 2, 4.4, 9.99, 13, 21.37, 33]) {
    assert.equal(computeFedexWeight(w), Math.round(w * 1.2 * 100) / 100);
  }
});

test("isFedexOneRateService: case-insensitive 'one rate'", () => {
  assert.equal(isFedexOneRateService("FedEx 2Day® One Rate"), true);
  assert.equal(isFedexOneRateService("Fedex 2Day® One Rate (Saturday)"), true);
  assert.equal(isFedexOneRateService("FEDEX STANDARD OVERNIGHT ONE RATE"), true);
  assert.equal(isFedexOneRateService("fedex express saver one rate"), true);
});

test("isFedexOneRateService: other services and empty input are false", () => {
  assert.equal(isFedexOneRateService("FedEx Home Delivery®"), false);
  assert.equal(isFedexOneRateService("FedEx Ground Economy"), false);
  assert.equal(isFedexOneRateService("UPS® Ground"), false);
  assert.equal(isFedexOneRateService("USPS Ground Advantage Cubic"), false);
  assert.equal(isFedexOneRateService(""), false);
  assert.equal(isFedexOneRateService(null), false);
  assert.equal(isFedexOneRateService(undefined), false);
});
