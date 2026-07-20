import assert from "node:assert/strict";
import { test } from "node:test";

import { expectedMeteredRunConfirmation, type MeteredRunPermit } from "../metered-call-guard";
import {
  METERED_BUDGET_UNIT_SCALE,
  MeteredBudgetContractError,
  meteredUnitsToMicros,
  prepareMeteredProviderBudget,
  prepareMeteredReservation,
} from "../metered-budget-contract";

const NOW = "2026-07-18T22:00:00.000Z";

function permit(overrides: Partial<MeteredRunPermit> = {}): MeteredRunPermit {
  return {
    version: 1,
    runId: "phase0-canary-001",
    approvalId: "owner-ok-001",
    approvedBy: "owner",
    issuedAt: "2026-07-18T21:00:00.000Z",
    expiresAt: "2026-07-18T23:00:00.000Z",
    providers: {
      unwrangle: {
        operations: ["search", "detail"],
        maxCalls: 7,
        maxUnits: 12.5,
      },
    },
    ...overrides,
  };
}

test("canonical permit uses exact integer micro-units and stable identities", () => {
  const p = permit();
  const confirmation = expectedMeteredRunConfirmation(p);
  const budget = prepareMeteredProviderBudget({
    permit: p,
    confirmation,
    provider: "unwrangle",
    at: NOW,
  });
  assert.deepEqual(budget.operations, ["detail", "search"]);
  assert.equal(budget.operationsJson, '["detail","search"]');
  assert.equal(budget.maxUnitsMicros, 12.5 * METERED_BUDGET_UNIT_SCALE);

  const first = prepareMeteredReservation({
    permit: p,
    confirmation,
    provider: "unwrangle",
    operation: "detail",
    units: 2.25,
    reservationKey: "sku:ABC:detail:v1",
    at: NOW,
  });
  const second = prepareMeteredReservation({
    permit: p,
    confirmation,
    provider: "unwrangle",
    operation: "detail",
    units: 2.25,
    reservationKey: "sku:ABC:detail:v1",
    at: NOW,
  });
  assert.equal(first.reservation.unitsMicros, 2_250_000);
  assert.equal(first.reservation.id, second.reservation.id);
  assert.equal(first.budget.id, second.budget.id);
});

test("owner confirmation, current expiry, provider and operation are all mandatory", () => {
  const p = permit();
  assert.throws(
    () => prepareMeteredProviderBudget({
      permit: p,
      confirmation: "yes",
      provider: "unwrangle",
      at: NOW,
    }),
    (error) => error instanceof MeteredBudgetContractError && error.code === "CONFIRMATION_MISMATCH",
  );

  const expired = permit({
    issuedAt: "2026-07-18T19:00:00.000Z",
    expiresAt: "2026-07-18T20:00:00.000Z",
  });
  assert.throws(
    () => prepareMeteredProviderBudget({
      permit: expired,
      confirmation: expectedMeteredRunConfirmation(expired),
      provider: "unwrangle",
      at: NOW,
    }),
    (error) => error instanceof MeteredBudgetContractError && error.code === "PERMIT_NOT_CURRENT",
  );

  assert.throws(
    () => prepareMeteredProviderBudget({
      permit: p,
      confirmation: expectedMeteredRunConfirmation(p),
      provider: "anthropic",
      at: NOW,
    }),
    (error) => error instanceof MeteredBudgetContractError && error.code === "PROVIDER_NOT_ALLOWED",
  );

  assert.throws(
    () => prepareMeteredReservation({
      permit: p,
      confirmation: expectedMeteredRunConfirmation(p),
      provider: "unwrangle",
      operation: "synthetic_probe",
      reservationKey: "probe-1",
      at: NOW,
    }),
    (error) => error instanceof MeteredBudgetContractError && error.code === "OPERATION_NOT_ALLOWED",
  );
});

test("ambiguous operations and sub-micro unit values fail closed", () => {
  const duplicateOperations = permit({
    providers: {
      unwrangle: { operations: ["search", "search"], maxCalls: 2 },
    },
  });
  assert.throws(
    () => prepareMeteredProviderBudget({
      permit: duplicateOperations,
      confirmation: expectedMeteredRunConfirmation(duplicateOperations),
      provider: "unwrangle",
      at: NOW,
    }),
    (error) => error instanceof MeteredBudgetContractError && error.code === "PERMIT_INVALID",
  );

  assert.equal(meteredUnitsToMicros(0.000001), 1);
  assert.throws(
    () => meteredUnitsToMicros(0.0000001),
    (error) => error instanceof MeteredBudgetContractError && error.code === "UNIT_PRECISION_UNSUPPORTED",
  );
});
