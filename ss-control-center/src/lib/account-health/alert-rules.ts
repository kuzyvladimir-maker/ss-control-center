/**
 * Critical Alert thresholds for Amazon + Walmart Account Health.
 *
 * Each rule names a metric key (matching what evaluateCriticalAlerts reads
 * from the snapshot), a direction-aware threshold, and two label generators
 * for the Telegram + UI surfaces. Adding a rule = one entry here, no other
 * code changes needed.
 */

export type AlertSeverity = "CRITICAL" | "HIGH" | "WARNING";
export type AlertChannel = "Amazon" | "Walmart";

export interface AlertRule {
  metric: string;
  channel: AlertChannel;
  threshold: { value: number; direction: "gte" | "lte" };
  severity: AlertSeverity;
  title: (value: number) => string;
  message: (value: number, storeName: string) => string;
}

export const ALERT_RULES: AlertRule[] = [
  // ─── AMAZON ─────────────────────────────────────────────────────────────
  {
    metric: "accountHealthRating",
    channel: "Amazon",
    threshold: { value: 200, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Amazon AHR dropped to ${v} (At Risk of Deactivation)`,
    message: (v, store) =>
      `Account Health Rating for ${store} = ${v}. Deactivation risk zone (< 200). Check Policy Compliance now.`,
  },
  {
    metric: "orderDefectRate",
    channel: "Amazon",
    threshold: { value: 1.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon ODR breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `ODR = ${v.toFixed(2)}% is over the 1% threshold on ${store}.`,
  },
  {
    metric: "lateShipmentRate30d",
    channel: "Amazon",
    threshold: { value: 4.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon LSR(30d) breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Late Shipment Rate (30 days) = ${v.toFixed(2)}% is over the 4% threshold on ${store}.`,
  },
  {
    metric: "preFulfillmentCancelRate",
    channel: "Amazon",
    threshold: { value: 2.5, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon Cancel Rate breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Pre-fulfillment Cancel Rate = ${v.toFixed(2)}% > 2.5% on ${store}.`,
  },
  {
    metric: "validTrackingRate",
    channel: "Amazon",
    threshold: { value: 95.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Amazon VTR dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Valid Tracking Rate = ${v.toFixed(2)}% fell below 95% on ${store}.`,
  },
  {
    metric: "onTimeDeliveryRate",
    channel: "Amazon",
    threshold: { value: 90.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Amazon OTDR dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `On-Time Delivery Rate = ${v.toFixed(2)}% fell below 90% on ${store}.`,
  },
  // Policy violations — metric is "newPolicyViolation_<CATEGORY>" with value
  // = newly-added count since the previous snapshot.
  {
    metric: "newPolicyViolation_FOOD_SAFETY",
    channel: "Amazon",
    threshold: { value: 1, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `New Food Safety violation${v > 1 ? "s" : ""}: ${v}`,
    message: (v, store) =>
      `${v} new Food Safety violations on ${store}. Critical for a frozen-food business.`,
  },
  {
    metric: "newPolicyViolation_SUSPECTED_IP",
    channel: "Amazon",
    threshold: { value: 1, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `New IP violation${v > 1 ? "s" : ""}: ${v}`,
    message: (v, store) =>
      `${v} new suspected IP violations on ${store}.`,
  },
  {
    metric: "newPolicyViolation_LISTING_POLICY",
    channel: "Amazon",
    threshold: { value: 1, direction: "gte" },
    severity: "HIGH",
    title: (v) => `New Listing Policy violations: ${v}`,
    message: (v, store) =>
      `${v} new Listing Policy violations on ${store}.`,
  },

  // ─── WALMART ────────────────────────────────────────────────────────────
  // Metric keys here MUST match what persist-performance.ts emits via
  // toFlatAlertKey() — `{metric}{window}d`. Walmart Insights v2 returns
  // `onTimeShipment` (the on-time %), not its inverse — alerting against
  // "on-time below 99%" is equivalent to "late above 1%" and avoids the
  // double-inversion this codebase suffered through in v1.
  {
    metric: "onTimeShipment30d",
    channel: "Walmart",
    threshold: { value: 99.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Walmart On-Time Shipment dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart On-Time Shipment = ${v.toFixed(2)}% fell below 99% (so Late Shipment > 1%) on ${store}.`,
  },
  {
    metric: "cancellations30d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Walmart Cancellations breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Cancellations = ${v.toFixed(2)}% > 2% on ${store}.`,
  },
  {
    metric: "validTracking30d",
    channel: "Walmart",
    threshold: { value: 99.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Walmart Valid Tracking dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Valid Tracking = ${v.toFixed(2)}% fell below 99% on ${store}.`,
  },
  {
    metric: "onTimeDelivery30d",
    channel: "Walmart",
    threshold: { value: 90.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Walmart On-Time Delivery dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart On-Time Delivery = ${v.toFixed(2)}% fell below 90% on ${store}.`,
  },
  {
    metric: "sellerResponse30d",
    channel: "Walmart",
    threshold: { value: 95.0, direction: "lte" },
    severity: "HIGH",
    title: (v) => `Walmart Seller Response dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Seller Response = ${v.toFixed(2)}% fell below 95% on ${store}.`,
  },
  {
    metric: "negativeFeedback60d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Negative Feedback elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Negative Feedback = ${v.toFixed(2)}% > 2% on ${store}.`,
  },
  {
    metric: "returns60d",
    channel: "Walmart",
    threshold: { value: 6.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Returns elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Returns = ${v.toFixed(2)}% > 6% on ${store}.`,
  },
  {
    metric: "itemNotReceived60d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Item Not Received elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Item Not Received = ${v.toFixed(2)}% > 2% on ${store}.`,
  },
  {
    metric: "newItemCompliance",
    channel: "Walmart",
    threshold: { value: 1, direction: "gte" },
    severity: "HIGH",
    title: (v) => `New Walmart Item Compliance issues: ${v}`,
    message: (_v, store) =>
      `New item-compliance problems on ${store}.`,
  },
];

/** Convenience accessor used by docs + the evaluator. */
export function rulesFor(channel: AlertChannel): AlertRule[] {
  return ALERT_RULES.filter((r) => r.channel === channel);
}
