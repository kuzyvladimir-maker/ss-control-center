import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertCardDecisionEvidence } from "../decision-send-gate";
import { MINIMUM } from "../case-data-gate";

test("SEND rejects incomplete, legacy, changed and stale evidence; allows current owner-approved evidence", async () => {
  const snapshot = { collectedAt: new Date().toISOString(), decision: { ready: true }, items: Object.keys(MINIMUM).map(key => ({ key, present: true })) };
  const json = JSON.stringify(snapshot);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const m = { id: "test-message", caseDataJson: json };
  const payload: Record<string, unknown> = { draftEn: "Food is not returnable", draftSource: "analysis", evidenceHash: hash(json) };
  const check = () => assertCardDecisionEvidence(m, { buyerMessageId: m.id, status: "PUBLISHED", cardJson: JSON.stringify(payload) });
  payload.missingRu = "Missing live tracking";
  assert.throws(check, /no verified decision/);
  delete payload.missingRu;
  delete payload.evidenceHash;
  assert.throws(check, /different fact snapshot/);
  payload.evidenceHash = hash("different snapshot");
  assert.throws(check, /different fact snapshot/);
  const stale = JSON.stringify({ ...snapshot, collectedAt: "2020-01-01T00:00:00Z" });
  m.caseDataJson = stale; payload.evidenceHash = hash(stale);
  assert.throws(check, /Recollect facts/);
  m.caseDataJson = json; payload.evidenceHash = hash(json);
  assert.doesNotThrow(check);
  assert.throws(() => assertCardDecisionEvidence(m, { buyerMessageId: m.id, status: "SUPERSEDED", cardJson: JSON.stringify(payload) }), /no longer actionable/);
});
