/**
 * "Has this buyer email already been answered?" — pure, Gmail-thread based.
 *
 * Until 2026-10-19 sync-messages.ts treated "thread has more than one
 * message" as answered. That also fires when the BUYER writes a follow-up
 * into the same thread, so an unanswered case was closed as RESOLVED and
 * left the Active queue. Now a case counts as answered only when, after the
 * buyer's message, the thread holds something that came from us:
 *   - a message with Gmail's SENT label (our email-relay reply), or
 *   - a message From the seller mailbox itself, or
 *   - Amazon's Seller Central delivery confirmation (donotreply@amazon.com,
 *     "Your e-mail to …"), which lands in the same thread.
 */

export interface ThreadMessageMeta {
  id?: string | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
  payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
}

function headerValue(m: ThreadMessageMeta, name: string): string {
  const h = (m.payload?.headers || []).find(
    (x) => (x?.name || "").toLowerCase() === name.toLowerCase()
  );
  return h?.value || "";
}

export function isOurReply(m: ThreadMessageMeta, sellerEmail: string): boolean {
  if ((m.labelIds || []).includes("SENT")) return true;
  const from = headerValue(m, "From").toLowerCase();
  if (sellerEmail && from.includes(sellerEmail.toLowerCase())) return true;
  if (from.includes("donotreply@amazon.com") && /your e-mail to/i.test(headerValue(m, "Subject")))
    return true;
  return false;
}

/**
 * True when a reply from us exists in the thread after `buyerMessageId`.
 * If the buyer message is not in the thread (should not happen) we only look
 * for any reply from us at all.
 */
export function answeredAfter(
  messages: ThreadMessageMeta[] | null | undefined,
  buyerMessageId: string,
  sellerEmail: string
): boolean {
  const list = messages || [];
  const buyer = list.find((m) => m.id === buyerMessageId);
  const buyerAt = Number(buyer?.internalDate || 0);
  return list.some(
    (m) =>
      m.id !== buyerMessageId &&
      Number(m.internalDate || 0) >= buyerAt &&
      isOurReply(m, sellerEmail)
  );
}
