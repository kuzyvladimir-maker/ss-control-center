/**
 * Walmart quantity-clarification inquiry — pure helpers shared by the
 * procurement UI (client) and the send endpoint / poll cron (server).
 *
 * Keep this module free of server-only imports (no prisma, no googleapis) so
 * the client ProcurementCard can import `isQuantityAnomaly` and the compose
 * modal can import `buildInquiryEmail` without pulling Node-only code into the
 * browser bundle.
 *
 * Background: multipack listings ("Pack of 8") get mis-ordered by buyers who
 * read the quantity selector as "number of bags" — they pick 3 thinking
 * 3 bags and receive 3 × 8 = 24. We can't change Walmart's checkout, but we
 * CAN email the buyer through their per-order relay address to confirm the
 * quantity before we ship. See docs/wiki/walmart-quantity-inquiry.md.
 */

/**
 * Registered Customer-service contact email for the Sirius Trading
 * International Walmart account (Seller Center → Manage Contacts). Walmart's
 * per-order relay only accepts mail sent FROM this address, so it's both the
 * sender of the inquiry and the inbox the buyer's reply lands in. Connect it
 * in Settings (Gmail OAuth) before the feature can send.
 */
export const WALMART_SIRIUS_CS_EMAIL = "info.siriustrading@gmail.com";

/**
 * Heuristic for "this looks like a multipack mis-order worth double-checking".
 *
 * We flag when BOTH hold:
 *   - the listing is itself a multipack (packSize >= 2), AND
 *   - the buyer ordered 2+ of them.
 *
 * Ordering ONE pack-of-8 is normal (they want the 8). Ordering 2–3 of a
 * pack-of-8 is the classic "I thought quantity = units" confusion — 16, 24
 * physical units. This is only a REVIEW flag (Vladimir decides whether to
 * actually message the buyer), so we'd rather over-surface than miss one.
 */
export const QUANTITY_ANOMALY_MIN_PACK = 2;
export const QUANTITY_ANOMALY_MIN_ORDERED = 2;

export function isQuantityAnomaly(
  quantityOrdered: number,
  packSize: number | null | undefined
): boolean {
  if (!packSize || packSize < QUANTITY_ANOMALY_MIN_PACK) return false;
  return quantityOrdered >= QUANTITY_ANOMALY_MIN_ORDERED;
}

/** First name (or whole string if no space) for a friendly greeting. */
function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export interface InquiryEmailInput {
  /** Walmart customer order number (the 2000… number shown to the buyer). */
  orderNumber: string;
  customerName?: string | null;
  productTitle: string;
  /** Number of listings the buyer ordered (the quantity selector value). */
  orderedQty: number;
  /** Pack label for context, e.g. "Pack of 8". Null when not a known pack. */
  packLabel?: string | null;
  /** Total physical units = orderedQty × packSize. */
  totalUnits: number;
}

/**
 * Build the subject + body for the clarification email.
 *
 * Strictly order-related customer service — no marketing, no feedback request,
 * no tracking, no emoji, factual brand voice. This keeps the message inside
 * the only outreach Walmart's Customer Care Policy permits ("communication
 * necessary for the order"). The subject mirrors Walmart's own
 * "Regarding Walmart order# …" format that the buyer sees in Seller Center.
 */
export function buildInquiryEmail(input: InquiryEmailInput): {
  subject: string;
  body: string;
} {
  const greetingName = firstName(input.customerName);
  const greeting = greetingName ? `Hello ${greetingName},` : "Hello,";
  const packClause = input.packLabel
    ? ` This item is sold as a multipack (${input.packLabel}).`
    : "";

  const subject = `Regarding Walmart order# ${input.orderNumber}`;
  const body = [
    greeting,
    "",
    `Thank you for your order of ${input.productTitle}.`,
    `Before we pack and ship it, we want to confirm the quantity.${packClause} ` +
      `Your order is for ${input.orderedQty} ${
        input.orderedQty === 1 ? "unit" : "units"
      }, which is ${input.totalUnits} ${
        input.totalUnits === 1 ? "item" : "items"
      } in total.`,
    "",
    "Could you confirm this is the quantity you intended? If you would like " +
      "to adjust it, just reply to this message and we will take care of it " +
      "before your order ships.",
    "",
    "Thank you,",
    "Sirius Trading International",
  ].join("\n");

  return { subject, body };
}
