/**
 * Which listing statuses may still be sent to the marketplace.
 *
 * One list, because there were three, and they were all wrong in the same way.
 *
 * The submission engine has always accepted PENDING, FAILED and RETRYABLE — a
 * RETRYABLE attempt is one that was refused BEFORE any POST left, so nothing is
 * in flight and sending is safe. But the drafts list, the drafts page counter
 * and the draft detail page each hard-coded only PENDING and FAILED, so the
 * moment a listing became RETRYABLE the operator lost the button for exactly
 * the listings the engine was willing to accept, with no explanation.
 *
 * Deliberately NOT here:
 *   · SUBMITTING / SUBMITTED / PENDING_REVIEW — a POST is in flight or awaiting
 *     Walmart; sending again would be a second POST.
 *   · SUBMISSION_UNKNOWN — the one status that must never be resent. Its
 *     outcome is resolved by reading (AGENTS.md §7).
 *   · LIVE — republishing is a separate, explicit decision.
 */
export const PUBLISHABLE_LISTING_STATUSES = [
  "PENDING",
  "FAILED",
  "RETRYABLE",
] as const;

export function isPublishableListingStatus(status: string): boolean {
  return (PUBLISHABLE_LISTING_STATUSES as readonly string[]).includes(status);
}
