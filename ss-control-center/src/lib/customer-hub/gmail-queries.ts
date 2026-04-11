/**
 * Gmail search queries для polling уведомлений Amazon.
 * Справочник: docs/AMAZON_NOTIFICATIONS_MAP.md
 *
 * Phase 1: buyerMessages, chargebacks
 * Phase 1.5: returns, refunds, deliveryFailures, buyerAbuse
 * Phase 2: listingIssues, pricingAlerts
 */

export const GMAIL_QUERIES = {
  // ===== PHASE 1 (Customer Hub — Messages + Chargebacks) =====

  /** Buyer messages — основной канал получения сообщений покупателей */
  buyerMessages: (accountEmail: string) =>
    `from:marketplace.amazon.com to:${accountEmail} newer_than:12h`,

  /** Chargebacks — единственный канал (нет в SP-API) */
  chargebacks: "from:cb-seller-notification@amazon.com newer_than:7d",

  // ===== PHASE 1.5 (Returns, Refunds, Messaging issues) =====

  /** Pending Returns — триггер для Customer Hub */
  returns:
    'from:seller-notification@amazon.com subject:"return" newer_than:2d',

  /** Refund Notifications — триггер для Adjustments синхронизации */
  refunds:
    'from:seller-notification@amazon.com subject:"refund" newer_than:2d',

  /** Delivery Failures — сообщение не дошло до покупателя */
  deliveryFailures:
    'from:seller-notification@amazon.com subject:"delivery failure" newer_than:7d',

  /** Buyer Abuse Prevention — для Feedback таба */
  buyerAbuse:
    'from:seller-notification@amazon.com subject:"abuse" newer_than:7d',

  /** Buyer Opt-out — покупатель отказался от сообщений */
  buyerOptOut:
    'from:seller-notification@amazon.com subject:"opt-out" newer_than:7d',

  // ===== PHASE 2 (Account Health, Listings, Pricing) =====

  /** Listing issues — compliance, removals, suppressions */
  listingIssues:
    'from:seller-notification@amazon.com subject:("compliance" OR "removed" OR "suppressed") newer_than:7d',

  /** Pricing & Featured Offer alerts */
  pricingAlerts:
    'from:seller-notification@amazon.com subject:("featured offer" OR "pricing") newer_than:7d',

  /** Inbound Shipment Problems — для Shipping Labels */
  inboundProblems:
    'from:ship-notify@amazon.com subject:"problem" newer_than:7d',
} as const;

// NOTE: email→store mapping lives in `src/lib/gmail-api.ts` and is loaded
// dynamically from the Setting table via `loadEmailToStoreMap()`. Do not
// reintroduce a hardcoded copy here.

/** Типы уведомлений для логирования и фильтрации */
export type NotificationType =
  | "buyer_message"
  | "chargeback"
  | "return"
  | "refund"
  | "delivery_failure"
  | "buyer_abuse"
  | "buyer_optout"
  | "listing_issue"
  | "pricing_alert"
  | "inbound_problem";
