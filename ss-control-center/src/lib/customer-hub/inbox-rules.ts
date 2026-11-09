/**
 * Inbox watch rules — pure (no DB), shared by inbox-watch.ts, answered.ts and
 * the tests. Owner, topic 42, 2026-11-01: no buyer message may sit unanswered
 * or go overdue without the owner knowing.
 */

export const RESPONSE_WINDOW_H = 24;
export const DUE_SOON_H = 6;
export const CARD_STALE_H = 2;
/** An approved reply the VPS agent has not sent within this time is flagged. */
export const SEND_STUCK_MIN = 60;
const LIVE_TASK = ["QUEUED", "CLAIMED"];

/** A reply answers a buyer message only if it went out after the message. */
export function replyAnswers(receivedAt: Date, replySentAt: Date): boolean {
  return replySentAt.getTime() > receivedAt.getTime();
}

/** Closed cards and answers must never become owner decisions again. */
export function needsOwnerDecision(input: {
  fresh: boolean; cardStatus?: string | null; messageStatus?: string | null;
  responseSentAt?: Date | null;
}): boolean {
  return input.fresh && !input.responseSentAt &&
    !["SENT", "SUPERSEDED", "CLOSED", "RESOLVED"].includes(input.cardStatus || "") &&
    !["SENT", "CLOSED", "RESOLVED"].includes(input.messageStatus || "");
}

export type UrgencyLevel = "overdue" | "due_soon" | "card_stale" | "no_card" | "send_stuck" | "ok";

export interface Urgency {
  level: UrgencyLevel;
  /** Every condition that holds, most severe first. */
  flags: UrgencyLevel[];
  deadline: string;
  hoursLeft: number;
}

const SEVERITY: UrgencyLevel[] = ["overdue", "due_soon", "no_card", "send_stuck", "card_stale"];

export function urgencyOf(i: {
  /** Oldest unanswered buyer message of the case — Amazon's clock starts there. */
  receivedAt: Date;
  now: Date;
  card?: { status: string; createdAt: Date } | null;
  sendTask?: { status: string; createdAt: Date } | null;
  covered: boolean;
}): Urgency {
  const deadline = new Date(i.receivedAt.getTime() + RESPONSE_WINDOW_H * 3600_000);
  const hoursLeft = Math.round(((deadline.getTime() - i.now.getTime()) / 3600_000) * 10) / 10;
  const set = new Set<UrgencyLevel>();
  if (hoursLeft <= 0) set.add("overdue");
  else if (hoursLeft < DUE_SOON_H) set.add("due_soon");
  if (!i.covered) set.add("no_card");
  if (
    i.card &&
    ["PENDING", "PUBLISHED"].includes(i.card.status) &&
    i.now.getTime() - i.card.createdAt.getTime() > CARD_STALE_H * 3600_000
  )
    set.add("card_stale");
  if (
    i.sendTask &&
    LIVE_TASK.includes(i.sendTask.status) &&
    i.now.getTime() - i.sendTask.createdAt.getTime() > SEND_STUCK_MIN * 60_000
  )
    set.add("send_stuck");
  const flags = SEVERITY.filter((l) => set.has(l));
  return { level: flags[0] ?? "ok", flags, deadline: deadline.toISOString(), hoursLeft };
}

export interface InboxItem {
  orderId: string | null;
  buyerName: string | null;
  subject: string | null;
  /** When the buyer wrote, if the agent could read it (ISO or Seller Central text). */
  receivedAt: string | null;
  /** The buyer's message text, if the agent copied it. */
  text: string | null;
  overSla: boolean;
  deadline?: string | null;
  sellerReplyAt?: string | null;
}

/** INBOX_SCAN result → items. Accepts {items:[…]} or {responseNeeded:[…]}. */
export function parseInboxResult(result: unknown): InboxItem[] {
  const r = (result || {}) as Record<string, unknown>;
  const raw = (Array.isArray(r.items) ? r.items : Array.isArray(r.responseNeeded) ? r.responseNeeded : []) as Record<
    string,
    unknown
  >[];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return raw.map((x) => {
    const orderText = str(x.orderId) || str(x.order_id) || str(x.order) || "";
    const order = orderText.match(/\d{3}-\d{7}-\d{7}/)?.[0] ?? null;
    return {
      orderId: order,
      buyerName: str(x.buyerName) || str(x.buyer) || str(x.customer),
      subject: str(x.subject),
      receivedAt: str(x.receivedAt) || str(x.received_at) || str(x.date),
      text: str(x.text) || str(x.message),
      deadline: str(x.deadline),
      sellerReplyAt: str(x.sellerReplyAt),
      overSla: x.overSla === true || x.over_sla === true || /over\s*sla/i.test(String(x.status || "")),
    };
  });
}

/** A full two-folder observation is required before absence can close a case. */
export function validateInboxScan(result: unknown, now = new Date()) {
  const r = result as Record<string, unknown> | null;
  if (!r || r.complete !== true || r.storeIndex !== 1 || r.accountName !== "Salutem Solutions" ||
      !Array.isArray(r.items) || !Array.isArray(r.resolved) || typeof r.scannedAt !== "string")
    throw new Error("INBOX_SCAN requires complete Salutem store 1 Response Needed + Resolved snapshot");
  const at = new Date(r.scannedAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 60_000 || now.getTime() - at.getTime() > 3600_000)
    throw new Error("INBOX_SCAN observation time is invalid or stale");
  for (const list of [r.items, r.resolved]) {
    if (list.some((x) => !x || typeof x !== "object")) throw new Error("Invalid inbox item");
    if (list === r.items && parseInboxResult({ items: list }).some((x) => !x.orderId)) throw new Error("Inbox item missing order ID");
  }
  return { scannedAt: at, items: parseInboxResult(r), resolved: parseInboxResult({ items: r.resolved }) };
}
