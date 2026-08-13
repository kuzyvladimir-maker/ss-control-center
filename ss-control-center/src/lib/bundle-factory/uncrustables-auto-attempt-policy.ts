export type UncrustablesCandidateOutcome =
  | { stage: "RENDER"; rendered: false }
  | { stage: "QA"; verified: false }
  | { stage: "QA"; verified: true; passed: boolean };

/** Only a rendered candidate that received a real QA verdict consumes a reroll. */
export function consumesUncrustablesQualityAttempt(
  outcome: UncrustablesCandidateOutcome,
): boolean {
  return outcome.stage === "QA" && outcome.verified;
}

export function nextUncrustablesQualityAttempt(
  currentAttempts: number,
  outcome: UncrustablesCandidateOutcome,
): number {
  if (!Number.isInteger(currentAttempts) || currentAttempts < 0) {
    throw new Error("currentAttempts must be a non-negative integer");
  }
  return currentAttempts + (consumesUncrustablesQualityAttempt(outcome) ? 1 : 0);
}
