/**
 * Identity of a Procurement card = (order id, line item id), never the line
 * item id alone.
 *
 * 2026-11-17: Veeqo's broken body for 113-4365835-6488256 gave its card the
 * same line id (2625865649) as 114-8255419-4685824's card. The page matched
 * cards by line id only, so one "Bought" struck out BOTH orders. Every lookup,
 * selection and status flip on the page now goes through these helpers.
 */

export interface CardIdentity {
  orderId: string;
  lineItemId: string;
}

/** Stable key for React lists and the bulk-selection set. */
export function procurementCardKey(c: CardIdentity): string {
  return `${c.orderId}:${c.lineItemId}`;
}

export function isSameCard(
  c: CardIdentity,
  orderId: string,
  lineItemId: string,
): boolean {
  return c.orderId === orderId && c.lineItemId === lineItemId;
}

/** Apply `fn` to the one card of (orderId, lineItemId); every other card —
 *  including a card of another order that shares the line id — is untouched. */
export function patchCard<T extends CardIdentity>(
  cards: T[],
  orderId: string,
  lineItemId: string,
  fn: (c: T) => T,
): T[] {
  return cards.map((c) => (isSameCard(c, orderId, lineItemId) ? fn(c) : c));
}

/** Find the card a bulk-selection key points to. */
export function findCardByKey<T extends CardIdentity>(
  cards: T[],
  key: string,
): T | undefined {
  return cards.find((c) => procurementCardKey(c) === key);
}
