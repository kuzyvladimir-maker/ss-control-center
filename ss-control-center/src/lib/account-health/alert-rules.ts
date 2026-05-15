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
      `Account Health Rating для ${store} = ${v}. Зона риска деактивации (< 200). Срочно проверь Policy Compliance.`,
  },
  {
    metric: "orderDefectRate",
    channel: "Amazon",
    threshold: { value: 1.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon ODR breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `ODR = ${v.toFixed(2)}% превысил порог 1% на магазине ${store}.`,
  },
  {
    metric: "lateShipmentRate30d",
    channel: "Amazon",
    threshold: { value: 4.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon LSR(30d) breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Late Shipment Rate (30 дней) = ${v.toFixed(2)}% превысил порог 4% на ${store}.`,
  },
  {
    metric: "preFulfillmentCancelRate",
    channel: "Amazon",
    threshold: { value: 2.5, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Amazon Cancel Rate breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Pre-fulfillment Cancel Rate = ${v.toFixed(2)}% > 2.5% на ${store}.`,
  },
  {
    metric: "validTrackingRate",
    channel: "Amazon",
    threshold: { value: 95.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Amazon VTR dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Valid Tracking Rate = ${v.toFixed(2)}% упал ниже 95% на ${store}.`,
  },
  {
    metric: "onTimeDeliveryRate",
    channel: "Amazon",
    threshold: { value: 90.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Amazon OTDR dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `On-Time Delivery Rate = ${v.toFixed(2)}% упал ниже 90% на ${store}.`,
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
      `Обнаружено ${v} новых Food Safety нарушений на ${store}. Критично для frozen food бизнеса.`,
  },
  {
    metric: "newPolicyViolation_SUSPECTED_IP",
    channel: "Amazon",
    threshold: { value: 1, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `New IP violation${v > 1 ? "s" : ""}: ${v}`,
    message: (v, store) =>
      `Обнаружено ${v} новых подозрений на IP-нарушения на ${store}.`,
  },
  {
    metric: "newPolicyViolation_LISTING_POLICY",
    channel: "Amazon",
    threshold: { value: 1, direction: "gte" },
    severity: "HIGH",
    title: (v) => `New Listing Policy violations: ${v}`,
    message: (v, store) =>
      `Обнаружено ${v} новых нарушений Listing Policy на ${store}.`,
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
      `Walmart On-Time Shipment = ${v.toFixed(2)}% упал ниже 99% (значит Late Shipment > 1%) на ${store}.`,
  },
  {
    metric: "cancellations30d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "CRITICAL",
    title: (v) => `Walmart Cancellations breached: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Cancellations = ${v.toFixed(2)}% > 2% на ${store}.`,
  },
  {
    metric: "validTracking30d",
    channel: "Walmart",
    threshold: { value: 99.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Walmart Valid Tracking dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Valid Tracking = ${v.toFixed(2)}% упал ниже 99% на ${store}.`,
  },
  {
    metric: "onTimeDelivery30d",
    channel: "Walmart",
    threshold: { value: 90.0, direction: "lte" },
    severity: "CRITICAL",
    title: (v) => `Walmart On-Time Delivery dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart On-Time Delivery = ${v.toFixed(2)}% упал ниже 90% на ${store}.`,
  },
  {
    metric: "sellerResponse30d",
    channel: "Walmart",
    threshold: { value: 95.0, direction: "lte" },
    severity: "HIGH",
    title: (v) => `Walmart Seller Response dropped: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Seller Response = ${v.toFixed(2)}% упал ниже 95% на ${store}.`,
  },
  {
    metric: "negativeFeedback60d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Negative Feedback elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Negative Feedback = ${v.toFixed(2)}% > 2% на ${store}.`,
  },
  {
    metric: "returns60d",
    channel: "Walmart",
    threshold: { value: 6.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Returns elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Returns = ${v.toFixed(2)}% > 6% на ${store}.`,
  },
  {
    metric: "itemNotReceived60d",
    channel: "Walmart",
    threshold: { value: 2.0, direction: "gte" },
    severity: "HIGH",
    title: (v) => `Walmart Item Not Received elevated: ${v.toFixed(2)}%`,
    message: (v, store) =>
      `Walmart Item Not Received = ${v.toFixed(2)}% > 2% на ${store}.`,
  },
  {
    metric: "newItemCompliance",
    channel: "Walmart",
    threshold: { value: 1, direction: "gte" },
    severity: "HIGH",
    title: (v) => `New Walmart Item Compliance issues: ${v}`,
    message: (_v, store) =>
      `Обнаружены новые проблемы с item compliance на ${store}.`,
  },
];

/** Convenience accessor used by docs + the evaluator. */
export function rulesFor(channel: AlertChannel): AlertRule[] {
  return ALERT_RULES.filter((r) => r.channel === channel);
}
