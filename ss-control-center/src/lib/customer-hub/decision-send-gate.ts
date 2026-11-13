import { createHash } from "node:crypto";
import { nextStep, type CaseDataSnapshot } from "./case-data-gate";

export function assertGeneratedDecisionEvidence(json: string | null, now = Date.now()) {
  const s: CaseDataSnapshot | null = json ? JSON.parse(json) : null;
  const age = s ? now - Date.parse(s.collectedAt) : NaN;
  if (!s?.decision?.ready || nextStep(s) !== "READY" || !Number.isFinite(age) || age < -60_000 || age > 2 * 3600_000) {
    throw new Error("Recollect facts before approving this generated reply");
  }
}

export function assertCardDecisionEvidence(
  m: { id: string; caseDataJson: string | null },
  card: { buyerMessageId: string; status: string; cardJson: string } | null,
  now = Date.now(),
) {
  if (!card || card.buyerMessageId !== m.id || !["PENDING", "PUBLISHED", "WRONG", "REWORK", "APPROVED"].includes(card.status)) throw new Error("Card is no longer actionable");
  const payload = JSON.parse(card.cardJson);
  if (payload.missingRu || payload.kind === "info" || !payload.draftEn) throw new Error("Card has no verified decision to send");
  if (payload.draftSource !== "owner_verbatim") {
    if (payload.evidenceHash !== createHash("sha256").update(m.caseDataJson || "").digest("hex")) throw new Error("Card was prepared from a different fact snapshot; re-analyze");
    assertGeneratedDecisionEvidence(m.caseDataJson, now);
  }
}
