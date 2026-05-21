// Phase 3 — Jackie MCP registry + auth unit tests.
//
//   npx tsx --test src/lib/jackie-mcp/__tests__/registry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyJackieAuth } from "../registry";
import {
  amazonChannelToAccount,
  amazonChannelToStoreIndex,
  channelSkipReason,
  isJackieChannel,
  optionalNumber,
  optionalString,
  requireChannel,
  requireString,
} from "../channels";

// ── verifyJackieAuth ──────────────────────────────────────────────────

test("verifyJackieAuth — null header rejected", () => {
  assert.match(verifyJackieAuth(null) ?? "", /Missing/);
});

test("verifyJackieAuth — empty bearer rejected", () => {
  assert.match(verifyJackieAuth("Bearer ") ?? "", /Empty/);
});

test("verifyJackieAuth — accepts JACKIE_API_TOKEN", () => {
  const prior = process.env.JACKIE_API_TOKEN;
  process.env.JACKIE_API_TOKEN = "secret-jackie-123";
  try {
    assert.equal(verifyJackieAuth("Bearer secret-jackie-123"), null);
  } finally {
    if (prior) process.env.JACKIE_API_TOKEN = prior;
    else delete process.env.JACKIE_API_TOKEN;
  }
});

test("verifyJackieAuth — accepts SSCC_API_TOKEN as fallback", () => {
  const prior = process.env.SSCC_API_TOKEN;
  process.env.SSCC_API_TOKEN = "sscc-admin-token";
  delete process.env.JACKIE_API_TOKEN;
  try {
    assert.equal(verifyJackieAuth("Bearer sscc-admin-token"), null);
  } finally {
    if (prior) process.env.SSCC_API_TOKEN = prior;
    else delete process.env.SSCC_API_TOKEN;
  }
});

test("verifyJackieAuth — wrong token rejected", () => {
  process.env.JACKIE_API_TOKEN = "secret";
  try {
    assert.match(verifyJackieAuth("Bearer wrong") ?? "", /Invalid/);
  } finally {
    delete process.env.JACKIE_API_TOKEN;
  }
});

// ── channels ───────────────────────────────────────────────────────────

test("isJackieChannel — accepts known values", () => {
  for (const c of [
    "AMAZON_SALUTEM",
    "AMAZON_AMZCOM",
    "AMAZON_PERSONAL",
    "AMAZON_SIRIUS",
    "AMAZON_RETAILER",
    "WALMART",
  ]) {
    assert.equal(isJackieChannel(c), true);
  }
});

test("isJackieChannel — rejects bad input", () => {
  assert.equal(isJackieChannel("EBAY"), false);
  assert.equal(isJackieChannel(""), false);
  assert.equal(isJackieChannel(123), false);
  assert.equal(isJackieChannel(undefined), false);
});

test("requireChannel — throws on missing", () => {
  assert.throws(() => requireChannel({}), /channel/);
});

test("requireChannel — returns valid channel", () => {
  assert.equal(requireChannel({ channel: "WALMART" }), "WALMART");
});

test("amazonChannelToAccount — maps each channel", () => {
  assert.equal(amazonChannelToAccount("AMAZON_SALUTEM"), "SALUTEM");
  assert.equal(amazonChannelToAccount("AMAZON_AMZCOM"), "AMZCOM");
  assert.equal(amazonChannelToAccount("AMAZON_PERSONAL"), "PERSONAL");
  assert.equal(amazonChannelToAccount("AMAZON_SIRIUS"), "SIRIUS");
  assert.equal(amazonChannelToAccount("AMAZON_RETAILER"), "RETAILER");
});

test("amazonChannelToStoreIndex — maps to 1..5", () => {
  assert.equal(amazonChannelToStoreIndex("AMAZON_SALUTEM"), 1);
  assert.equal(amazonChannelToStoreIndex("AMAZON_PERSONAL"), 2);
  assert.equal(amazonChannelToStoreIndex("AMAZON_AMZCOM"), 3);
  assert.equal(amazonChannelToStoreIndex("AMAZON_SIRIUS"), 4);
  assert.equal(amazonChannelToStoreIndex("AMAZON_RETAILER"), 5);
});

test("channelSkipReason — SIRIUS + RETAILER flagged, others clean", () => {
  assert.match(channelSkipReason("AMAZON_SIRIUS") ?? "", /SIRIUS/);
  assert.match(channelSkipReason("AMAZON_RETAILER") ?? "", /suspended/i);
  assert.equal(channelSkipReason("AMAZON_SALUTEM"), null);
  assert.equal(channelSkipReason("WALMART"), null);
});

// ── optional/required helpers ──────────────────────────────────────────

test("requireString — throws on missing/non-string", () => {
  assert.throws(() => requireString({}, "foo"), /required/);
  assert.throws(() => requireString({ foo: 1 }, "foo"), /required/);
  assert.throws(() => requireString({ foo: "" }, "foo"), /required/);
});

test("requireString — returns value", () => {
  assert.equal(requireString({ foo: "bar" }, "foo"), "bar");
});

test("optionalString — undefined on missing, value on string, throws on wrong type", () => {
  assert.equal(optionalString({}, "foo"), undefined);
  assert.equal(optionalString({ foo: null }, "foo"), undefined);
  assert.equal(optionalString({ foo: "bar" }, "foo"), "bar");
  assert.throws(() => optionalString({ foo: 1 }, "foo"), /string/);
});

test("optionalNumber — undefined on missing, value on number, throws on wrong type", () => {
  assert.equal(optionalNumber({}, "foo"), undefined);
  assert.equal(optionalNumber({ foo: 42 }, "foo"), 42);
  assert.throws(() => optionalNumber({ foo: "x" }, "foo"), /number/);
});
