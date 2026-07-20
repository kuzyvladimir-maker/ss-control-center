import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  MeteredProviderBlockedError,
  assertMeteredProviderCall,
  currentMeteredRunPermit,
  encodeMeteredRunPermit,
  evaluateMeteredCall,
  expectedMeteredRunConfirmation,
  resetMeteredCallUsageForTests,
  type MeteredRunPermit,
} from "../metered-call-guard";

const NOW = Date.parse("2026-07-18T22:00:00.000Z");

function permit(overrides: Partial<MeteredRunPermit> = {}): MeteredRunPermit {
  return {
    version: 1,
    runId: "phase0-canary-001",
    approvalId: "owner-ok-001",
    approvedBy: "owner",
    issuedAt: "2026-07-18T21:00:00.000Z",
    expiresAt: "2026-07-18T23:00:00.000Z",
    providers: {
      unwrangle: { operations: ["search", "detail"], maxCalls: 2, maxUnits: 3 },
    },
    ...overrides,
  };
}

function envFor(p: MeteredRunPermit) {
  return {
    SS_METERED_RUN_PERMIT: encodeMeteredRunPermit(p),
    SS_METERED_RUN_CONFIRM: expectedMeteredRunConfirmation(p),
  };
}

afterEach(() => resetMeteredCallUsageForTests());

test("metered calls are denied by default", () => {
  const decision = evaluateMeteredCall({ provider: "unwrangle", operation: "search" }, {}, undefined, NOW);
  assert.deepEqual(decision, {
    allowed: false,
    code: "PERMIT_MISSING",
    reason: "no owner-approved metered run permit is configured",
  });
});

test("permit needs exact owner confirmation and explicit provider operation", () => {
  const p = permit();
  assert.equal(evaluateMeteredCall(
    { provider: "unwrangle", operation: "search" },
    { SS_METERED_RUN_PERMIT: encodeMeteredRunPermit(p), SS_METERED_RUN_CONFIRM: "yes" },
    undefined,
    NOW,
  ).allowed, false);

  const provider = evaluateMeteredCall({ provider: "anthropic", operation: "vision" }, envFor(p), undefined, NOW);
  assert.equal(provider.allowed, false);
  if (!provider.allowed) assert.equal(provider.code, "PROVIDER_NOT_ALLOWED");

  const operation = evaluateMeteredCall({ provider: "unwrangle", operation: "synthetic_probe" }, envFor(p), undefined, NOW);
  assert.equal(operation.allowed, false);
  if (!operation.allowed) assert.equal(operation.code, "OPERATION_NOT_ALLOWED");
});

test("expired, future and overlong permits are denied", () => {
  for (const p of [
    permit({ issuedAt: "2026-07-18T19:00:00.000Z", expiresAt: "2026-07-18T20:00:00.000Z" }),
    permit({ issuedAt: "2026-07-19T19:00:00.000Z", expiresAt: "2026-07-19T20:00:00.000Z" }),
    permit({ issuedAt: "2026-07-18T21:00:00.000Z", expiresAt: "2026-07-20T21:00:01.000Z" }),
  ]) {
    assert.equal(evaluateMeteredCall({ provider: "unwrangle", operation: "search" }, envFor(p), undefined, NOW).allowed, false);
  }
});

test("provenance exposes only a current explicitly confirmed owner permit", () => {
  const p = permit();
  assert.equal(currentMeteredRunPermit(envFor(p), NOW)?.runId, p.runId);
  assert.equal(currentMeteredRunPermit({
    SS_METERED_RUN_PERMIT: encodeMeteredRunPermit(p),
    SS_METERED_RUN_CONFIRM: "not-confirmed",
  }, NOW), null);
  assert.equal(currentMeteredRunPermit(envFor(permit({
    issuedAt: "2026-07-18T19:00:00.000Z",
    expiresAt: "2026-07-18T20:00:00.000Z",
  })), NOW), null);
});

test("reservation is fail-closed at both call and unit caps", () => {
  const p = permit();
  const env = envFor(p);
  assert.equal(evaluateMeteredCall({ provider: "unwrangle", operation: "detail", units: 2.5 }, env, { calls: 0, units: 0 }, NOW).allowed, true);

  const unitCap = evaluateMeteredCall({ provider: "unwrangle", operation: "search", units: 1 }, env, { calls: 1, units: 2.5 }, NOW);
  assert.equal(unitCap.allowed, false);
  if (!unitCap.allowed) assert.equal(unitCap.code, "UNIT_BUDGET_EXHAUSTED");

  const callCap = evaluateMeteredCall({ provider: "unwrangle", operation: "search" }, env, { calls: 2, units: 2 }, NOW);
  assert.equal(callCap.allowed, false);
  if (!callCap.allowed) assert.equal(callCap.code, "CALL_BUDGET_EXHAUSTED");
});

test("runtime reservation happens before a third request can proceed", () => {
  const p = permit({
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const env = envFor(p);
  assert.equal(assertMeteredProviderCall({ provider: "unwrangle", operation: "search" }, env).runId, p.runId);
  assert.equal(assertMeteredProviderCall({ provider: "unwrangle", operation: "detail", units: 2 }, env).runId, p.runId);
  assert.throws(
    () => assertMeteredProviderCall({ provider: "unwrangle", operation: "search" }, env),
    (error) => error instanceof MeteredProviderBlockedError && error.code === "CALL_BUDGET_EXHAUSTED",
  );
});
