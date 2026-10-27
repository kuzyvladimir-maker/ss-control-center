/**
 * Label discard (void + carrier refund) — the guard rails around the cancel
 * call that /api/shipping/discard-label makes.
 *
 * Owner, 2026-10-27: the operator finds an already-shipped order through the
 * Shipping Labels search and cancels its label from there. Cancelling moves
 * money back, so:
 *   - every label is cancelled at most once: a per-tracking lock row
 *     (Setting `label_discard:<TRACKING>`) is written BEFORE the call;
 *   - the cancel call is sent once, never repeated; an unclear answer is
 *     settled by reading the order back;
 *   - a label the carrier already scanned or delivered isn't sent at all —
 *     a used label can't be refunded, and in Veeqo the cancel would still
 *     put a shipped order back into the fulfilment queue.
 *
 * The lock row doubles as the discard log: who/what/when and what the
 * carrier answered.
 */

import { prisma } from "@/lib/prisma";
import { trackAny } from "@/lib/carriers/track";
import type { UpsTrackingInfo } from "@/lib/carriers/ups-tracking";

export type DiscardState = "sending" | "done" | "failed" | "unknown";

export interface DiscardRecord {
  state: DiscardState;
  orderNumber: string;
  veeqoOrderId: string | null;
  channel: string;
  via: "veeqo" | "walmart";
  tracking: string;
  carrier: string | null;
  /** Veeqo shipment the cancel was sent for. */
  shipmentId: string | null;
  source: "queue" | "archive";
  startedAt: string;
  finishedAt?: string;
  /** What Veeqo / Walmart / the carrier answered, as plain text. */
  message?: string;
}

export const normTracking = (t: string) => t.trim().toUpperCase();
const discardKey = (tracking: string) => `label_discard:${normTracking(tracking)}`;

function parseRecord(value: string | null | undefined): DiscardRecord | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as DiscardRecord;
  } catch {
    return null;
  }
}

export async function readDiscard(tracking: string): Promise<DiscardRecord | null> {
  const row = await prisma.setting.findUnique({ where: { key: discardKey(tracking) } });
  return parseRecord(row?.value);
}

/** Discard records for many labels at once, keyed by normalised tracking. */
export async function readDiscards(
  trackings: string[],
): Promise<Map<string, DiscardRecord>> {
  const keys = [...new Set(trackings.filter(Boolean).map(discardKey))];
  const out = new Map<string, DiscardRecord>();
  if (keys.length === 0) return out;
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  for (const r of rows) {
    const rec = parseRecord(r.value);
    if (rec) out.set(normTracking(rec.tracking), rec);
  }
  return out;
}

/**
 * Take the lock before the cancel call. A failed earlier attempt may be
 * replaced (the operator retries on purpose); a running, finished or unclear
 * one blocks. Any DB error propagates — the caller then sends nothing.
 */
export async function takeDiscardLock(
  rec: DiscardRecord,
): Promise<{ ok: true } | { ok: false; existing: DiscardRecord }> {
  const key = discardKey(rec.tracking);
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) {
    try {
      await prisma.setting.create({ data: { key, value: JSON.stringify(rec) } });
      return { ok: true };
    } catch (e) {
      // Lost a race with a parallel click: whoever wrote first owns it.
      const now = await prisma.setting.findUnique({ where: { key } });
      const existing = parseRecord(now?.value);
      if (existing) return { ok: false, existing };
      throw e;
    }
  }
  const prev = parseRecord(row.value);
  if (prev && prev.state !== "failed") return { ok: false, existing: prev };
  // Compare-and-set on the exact old value so two retries can't both win.
  const taken = await prisma.setting.updateMany({
    where: { key, value: row.value },
    data: { value: JSON.stringify(rec) },
  });
  if (taken.count === 1) return { ok: true };
  const now = await prisma.setting.findUnique({ where: { key } });
  return { ok: false, existing: parseRecord(now?.value) ?? rec };
}

/** Bookkeeping after the call: a failed write is logged, never thrown — the
 *  cancel has already happened (or not) by then. */
export async function writeDiscard(rec: DiscardRecord): Promise<void> {
  try {
    await prisma.setting.update({
      where: { key: discardKey(rec.tracking) },
      data: { value: JSON.stringify(rec) },
    });
  } catch (e) {
    console.error(
      `[discard-label] log update failed for ${rec.tracking} (${rec.state}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * After a confirmed cancel: the plan row of that label stops counting as
 * bought (status "discarded" + a note), and a Walmart label record is marked
 * discarded so the order can be bought again. Non-fatal.
 */
export async function markLabelDiscarded(rec: DiscardRecord): Promise<void> {
  const at = new Date();
  const note = `Label ${rec.tracking} discarded ${at.toISOString()} via ${rec.via} (${rec.source})`;
  try {
    const rows = await prisma.shippingPlanItem.findMany({
      where: { trackingNumber: rec.tracking, status: "bought" },
      select: { id: true, notes: true },
    });
    for (const r of rows) {
      await prisma.shippingPlanItem.update({
        where: { id: r.id },
        data: { status: "discarded", notes: r.notes ? `${r.notes}\n${note}` : note },
      });
    }
    if (rec.via === "walmart") {
      await prisma.walmartLabelPurchase.updateMany({
        where: { trackingNumber: rec.tracking, discardedAt: null },
        data: { discardedAt: at },
      });
    }
  } catch (e) {
    console.error(
      `[discard-label] label ${rec.tracking} IS discarded, but our plan/label record wasn't updated:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// ── Carrier pre-check ───────────────────────────────────────────────────

export interface CarrierCheck {
  /** false = no carrier answered (lookup failed / unsupported carrier). */
  checked: boolean;
  carrier: string | null;
  status: string | null;
  lastEvent: string | null;
  deliveredOn: string | null;
  delivered: boolean;
  /** The carrier physically has (or had) the package. */
  scanned: boolean;
  /** The carrier already shows the label as cancelled / voided. */
  cancelled: boolean;
}

// Events that only say "a label exists": FedEx OC, UPS M (manifest), USPS
// pre-shipment. Anything else is the carrier touching the package.
const LABEL_ONLY_CODES = new Set(["OC", "M", "MP"]);
const LABEL_ONLY_TEXT =
  /label (has been )?created|shipping label created|label printed|shipment information sent|shipper created a label|pre-?shipment|awaiting item|billing information received|order (information )?(created|received)|information received|electronic(ally)? (shipping )?info/i;
const CANCELLED_TEXT = /cancel|void/i;

export function classifyTracking(
  info: Pick<UpsTrackingInfo, "currentStatus" | "delivered" | "actualDelivery" | "events">,
): Omit<CarrierCheck, "checked" | "carrier"> {
  const events = info.events ?? [];
  const isLabelOnly = (code: string | null, text: string | null) =>
    (code != null && LABEL_ONLY_CODES.has(code.toUpperCase())) ||
    (text != null && LABEL_ONLY_TEXT.test(text));
  const isCancelled = (text: string | null) => text != null && CANCELLED_TEXT.test(text);

  const last = events[events.length - 1];
  const lastEvent = last
    ? [last.description, [last.date, last.time].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(" — ") || null
    : null;
  const cancelled =
    isCancelled(info.currentStatus) || events.some((e) => isCancelled(e.description));
  const scanned =
    info.delivered ||
    events.some((e) => !isLabelOnly(e.status, e.description) && !isCancelled(e.description)) ||
    (events.length === 0 &&
      !!info.currentStatus &&
      !isLabelOnly(null, info.currentStatus) &&
      !isCancelled(info.currentStatus));
  return {
    status: info.currentStatus,
    lastEvent: lastEvent ?? info.currentStatus,
    deliveredOn: info.actualDelivery,
    delivered: info.delivered,
    scanned,
    cancelled,
  };
}

const CARRIER_CHECK_TIMEOUT_MS = 12_000;

/** Read-only carrier lookup with a deadline; never throws. */
export async function checkCarrier(
  tracking: string,
  carrierHint: string | null,
): Promise<CarrierCheck> {
  const none: CarrierCheck = {
    checked: false,
    carrier: null,
    status: null,
    lastEvent: null,
    deliveredOn: null,
    delivered: false,
    scanned: false,
    cancelled: false,
  };
  try {
    const found = await Promise.race([
      trackAny(tracking, carrierHint),
      new Promise<null>((r) => setTimeout(() => r(null), CARRIER_CHECK_TIMEOUT_MS)),
    ]);
    if (!found) return none;
    return { checked: true, carrier: found.carrier, ...classifyTracking(found.info) };
  } catch (e) {
    console.warn("[discard-label] carrier check failed:", e instanceof Error ? e.message : e);
    return none;
  }
}

// ── Error text ──────────────────────────────────────────────────────────

/**
 * HTTP status + a short plain-text message from whatever the cancel call
 * threw. Veeqo errors are "Veeqo API error 422: <text>" (HTML already
 * stripped by veeqoFetch); Walmart throws WalmartApiError with a JSON body.
 */
export function cancelErrorInfo(e: unknown): { status: number | null; text: string } {
  const anyE = e as { status?: unknown; errorBody?: unknown; message?: unknown } | null;
  if (anyE && typeof anyE.status === "number" && "errorBody" in (anyE as object)) {
    const body = anyE.errorBody as
      | { errors?: Array<{ description?: string; info?: string; code?: string }>; error?: unknown }
      | string
      | null;
    let text = "";
    if (body && typeof body === "object" && Array.isArray(body.errors) && body.errors.length) {
      text = body.errors
        .map((x) => x.description || x.info || x.code || "")
        .filter(Boolean)
        .join("; ");
    } else if (typeof body === "string") {
      text = body;
    }
    return { status: anyE.status, text: plain(text) || `Walmart answered HTTP ${anyE.status}` };
  }
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^Veeqo API error (\d{3}): ([\s\S]*)$/.exec(msg);
  if (m) return { status: Number(m[1]), text: plain(m[2]) || `Veeqo answered HTTP ${m[1]}` };
  return { status: null, text: plain(msg) };
}

function plain(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** 4xx (except timeout / rate limit) = the other side read the request and
 *  said no — nothing was cancelled. Anything else is an unclear outcome. */
export function isDefinitiveRefusal(status: number | null): boolean {
  return status != null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
