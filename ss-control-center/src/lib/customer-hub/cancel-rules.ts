/**
 * Buyer cancellation requests — pure rules, no DB (owner, topic 42, 2026-11-02).
 *
 * Amazon tells the seller about a buyer's cancellation request only by email
 * ("Order cancelation request for Order ID: …" from donotreply@amazon.com),
 * never through buyer messaging. brenda (114-2471869-1927461) requested on
 * 17.10, we bought the label on 20.10, and every hub card said "no
 * cancellation on record" and drafted a refusal. Rule: a request made BEFORE
 * the label was bought means the shipment is on us — a refund refusal is
 * forbidden and the refund decision goes to the owner (over $50 — always
 * ask). The buyer text still never admits fault.
 */

/** Gmail query for every cancellation notice Amazon sends the seller. */
export const CANCEL_NOTICE_QUERY =
  'from:amazon.com (subject:"cancelation request" OR subject:"cancellation request" OR subject:"has been cancelled" OR subject:"has been canceled" OR subject:"order cancelled" OR subject:"order canceled")';

/** Above this order total the owner decides the refund; at or below the card proposes it. */
export const OWNER_ASK_OVER_USD = 50;

export type CancelNoticeKind = "REQUEST" | "CANCELLED";

const ORDER_ID_RE = /\b\d{3}-\d{7}-\d{7}\b/;

/**
 * Classify one notice by its subject. "Order cancelation request for Order
 * ID: X" → REQUEST; "Your order X has been cancelled as per customer's
 * request" → CANCELLED (Amazon cancelled it — nothing shipped).
 */
export function parseCancelNotice(subject: string | null | undefined): { orderId: string; kind: CancelNoticeKind } | null {
  const s = subject || "";
  const orderId = ORDER_ID_RE.exec(s)?.[0];
  if (!orderId) return null;
  if (/cancel+ation request/i.test(s)) return { orderId, kind: "REQUEST" };
  if (/(has been|order) cancel+ed/i.test(s)) return { orderId, kind: "CANCELLED" };
  return null;
}

/**
 * Was the cancellation requested before we bought the label?
 * `labelAt` with a time (Veeqo shipment.created_at) compares exactly. A
 * date-only label (YYYY-MM-DD, end of that day unknown) proves "before" only
 * when the request came on an earlier calendar day (US Eastern), and "after"
 * only on a later day; the same day stays unknown.
 */
export function requestedBeforeLabel(
  requestedAt: Date,
  label: { at: Date; precise: boolean } | null
): boolean | null {
  if (!label) return null;
  if (label.precise) return requestedAt.getTime() < label.at.getTime();
  const reqDay = easternDay(requestedAt);
  const labelDay = label.at.toISOString().slice(0, 10);
  if (reqDay < labelDay) return true;
  if (reqDay > labelDay) return false;
  return null;
}

/** YYYY-MM-DD in America/New_York (Seller Central's day). */
export function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "17.10 11:46 ET" */
export function etStamp(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.day}.${p.month} ${p.hour}:${p.minute} ET`;
}

/** Case-data fact about a buyer cancellation request (CaseDataSnapshot.cancelRequest). */
export interface CancelRequestFact {
  requestedAt: string;
  source: "amazon-notification";
  kind: CancelNoticeKind;
  labelPurchasedAt: string | null;
  labelSource: "veeqo" | "ship-date" | "none";
  /** true = requested before the label was bought → refusal forbidden. */
  beforeShipment: boolean | null;
  orderTotal: number | null;
}

/** English line for the analyzer prompt. */
export function cancelFactForPrompt(c: CancelRequestFact): string {
  const when = `${c.requestedAt.slice(0, 16).replace("T", " ")} UTC`;
  const label = c.labelPurchasedAt ? `${c.labelPurchasedAt.slice(0, 16).replace("T", " ")} UTC` : "unknown";
  if (c.kind === "CANCELLED") return `Amazon cancelled this order at the buyer's request on ${when}.`;
  if (c.beforeShipment === true)
    return `CANCELLATION REQUESTED BEFORE SHIPMENT: the buyer filed an official cancellation request on ${when} (Amazon notification); we bought the shipping label later (${label}). Refusing a refund is FORBIDDEN on this order.`;
  if (c.beforeShipment === false)
    return `The buyer filed a cancellation request on ${when}, AFTER we bought the shipping label (${label}) — the order had already shipped.`;
  return `The buyer filed a cancellation request on ${when}; label purchase time ${label} — whether it came before shipment is not proven.`;
}

/** Russian fact line for the owner's card. */
export function cancelFactRu(c: CancelRequestFact): string {
  const req = etStamp(new Date(c.requestedAt));
  const label = c.labelPurchasedAt
    ? c.labelSource === "veeqo"
      ? etStamp(new Date(c.labelPurchasedAt))
      : c.labelPurchasedAt.slice(0, 10)
    : "нет данных";
  if (c.kind === "CANCELLED") return `Amazon отменил заказ по просьбе покупателя ${req}`;
  if (c.beforeShipment === true) return `запрос отмены ${req} — ДО покупки этикетки (${label})`;
  if (c.beforeShipment === false) return `запрос отмены ${req} — после покупки этикетки (${label}), уже отгружен`;
  return `запрос отмены ${req}; этикетка ${label} — до или после, не доказано`;
}

/** Red line on the owner's card when the request came before shipment. */
export function cancelAlertRu(c: CancelRequestFact): string | null {
  if (c.kind !== "REQUEST" || c.beforeShipment !== true) return null;
  const total = c.orderTotal ?? null;
  const money =
    total === null
      ? "сумма неизвестна — решите вы"
      : total > OWNER_ASK_OVER_USD
        ? `сумма $${total.toFixed(2)} > $${OWNER_ASK_OVER_USD} — решите вы`
        : `сумма $${total.toFixed(2)} ≤ $${OWNER_ASK_OVER_USD} — движок предлагает полный возврат`;
  return `🔴 Отмена была запрошена до отгрузки (${etStamp(new Date(c.requestedAt))}), вина наша. Нужно решение по возврату: ${money}. Отказ в возврате запрещён; покупателю вину не признаём.`;
}

/** Instruction to the analyzer when the request came before shipment. */
export function cancelInstruction(c: CancelRequestFact): string | null {
  if (c.kind !== "REQUEST" || c.beforeShipment !== true) return null;
  const total = c.orderTotal ?? null;
  const small = total !== null && total <= OWNER_ASK_OVER_USD;
  return [
    "OWNER RULE — CANCELLATION REQUESTED BEFORE SHIPMENT (2026-11-02): the buyer asked to cancel before we bought the label, so a refund refusal is FORBIDDEN.",
    "Do NOT write that we cannot refund, do NOT redirect the buyer to A-to-Z, do NOT argue about the cancellation timing.",
    "Never admit fault or say we missed / overlooked the request.",
    small
      ? `Order total $${total!.toFixed(2)} (≤ $${OWNER_ASK_OVER_USD}): action full_refund — confirm we are processing a full refund for the order (no replacement offer, no return of the food).`
      : `Order total ${total === null ? "unknown" : `$${total.toFixed(2)}`} (> $${OWNER_ASK_OVER_USD} or unknown): the owner decides the refund — action investigate; write that we have reviewed the order together with the buyer's cancellation request and will follow up with a resolution shortly. No refund promise, no refusal.`,
  ].join(" ");
}
