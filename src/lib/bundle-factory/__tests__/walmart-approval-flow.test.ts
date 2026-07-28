import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Walmart approval persists a current-validation seal before APPROVED states", () => {
  const source = readFileSync(
    new URL("../approval.ts", import.meta.url),
    "utf8",
  );
  const transaction = source.slice(source.indexOf("await prisma.$transaction"));
  const seal = transaction.indexOf("sealWalmartDistributionApproval({");
  const persistSeal = transaction.indexOf("data: { attributes: sealed.attributes }");
  const approveMaster = transaction.indexOf(
    'data: { lifecycle_status: "APPROVED" }',
  );
  const approveDraft = transaction.indexOf('status: "APPROVED"', approveMaster);

  assert.ok(seal >= 0, "approval must build the Walmart distribution seal");
  assert.ok(persistSeal > seal, "approval must persist the built seal");
  assert.ok(
    approveMaster > persistSeal,
    "the seal must be persisted before marketplace entities become APPROVED",
  );
  assert.ok(
    approveDraft > approveMaster,
    "the draft must become APPROVED only after the seal and child lifecycle updates",
  );
  assert.match(
    transaction,
    /validationRunId:\s*sku\.validation_check_id \?\? ""/,
  );
  assert.match(transaction, /assertValidWalmartDistributionApproval\(sku\)/);
});
