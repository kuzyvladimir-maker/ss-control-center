import { ACTIVE_CS_STORES } from "./config";
/**
 * Amazon buyer cancellation notices → AmazonCancelRequest, and the
 * "requested before shipment?" verdict per order (owner, topic 42, 2026-11-02).
 * Rules and wording: cancel-rules.ts. Read-only towards Gmail and Veeqo.
 */
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { createOAuth2Client } from "@/lib/gmail-api";
import { veeqoFetch } from "@/lib/veeqo/client";
import { veeqoShipments } from "@/lib/veeqo/tracking";
import {
  CANCEL_NOTICE_QUERY,
  parseCancelNotice,
  requestedBeforeLabel,
  type CancelRequestFact,
} from "./cancel-rules";

export * from "./cancel-rules";

interface GmailAccount {
  storeIndex: number;
  email: string;
  refreshToken: string;
}

/**
 * Pull cancellation notices from every connected store mailbox. Deduped by
 * Gmail message id, so a wide window (backfill) is safe to repeat.
 */
export async function syncCancelNotices(
  accounts: GmailAccount[],
  window = "2d"
): Promise<{ created: number; errors: string[] }> {
  let created = 0;
  const errors: string[] = [];
  for (const a of accounts.filter((a) => ACTIVE_CS_STORES.includes(a.storeIndex))) {
    try {
      const gmail = google.gmail({ version: "v1", auth: createOAuth2Client(a.refreshToken) });
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const r = await gmail.users.messages.list({
          userId: "me",
          q: `${CANCEL_NOTICE_QUERY} newer_than:${window}`,
          maxResults: 100,
          pageToken,
        });
        for (const m of r.data.messages || []) if (m.id) ids.push(m.id);
        pageToken = r.data.nextPageToken || undefined;
      } while (pageToken && ids.length < 500);
      if (!ids.length) continue;
      const known = new Set(
        (
          await prisma.amazonCancelRequest.findMany({
            where: { gmailMessageId: { in: ids } },
            select: { gmailMessageId: true },
          })
        ).map((r) => r.gmailMessageId)
      );
      for (const id of ids) {
        if (known.has(id)) continue;
        const m = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject", "Date"],
        });
        const h = (n: string) => m.data.payload?.headers?.find((x) => x.name?.toLowerCase() === n)?.value || "";
        const notice = parseCancelNotice(h("subject"));
        if (!notice) continue;
        const date = h("date") ? new Date(h("date")) : m.data.internalDate ? new Date(Number(m.data.internalDate)) : null;
        if (!date || Number.isNaN(date.getTime())) continue;
        await prisma.amazonCancelRequest.create({
          data: {
            storeIndex: a.storeIndex,
            amazonOrderId: notice.orderId,
            kind: notice.kind,
            requestedAt: date,
            gmailMessageId: id,
            subject: h("subject").slice(0, 300),
          },
        });
        created++;
      }
    } catch (e) {
      errors.push(`store${a.storeIndex} cancel notices: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  return { created, errors };
}

/**
 * When did we buy the label? Veeqo shipment.created_at (earliest shipment on
 * the order) is exact; a stored ship date (YYYY-MM-DD) is the date-only
 * fallback.
 */
export async function labelPurchased(
  orderId: string
): Promise<{ at: Date; precise: boolean; source: "veeqo" | "ship-date" } | null> {
  try {
    const orders = await veeqoFetch(`/orders?query=${encodeURIComponent(orderId)}&page_size=5`);
    const list = Array.isArray(orders) ? orders : [];
    const order = list.find((o: { number?: string }) => String(o?.number || "") === orderId) || null;
    const times = order
      ? veeqoShipments(order)
          .map((s) => (s.createdAt ? Date.parse(s.createdAt) : NaN))
          .filter((t) => Number.isFinite(t))
      : [];
    if (times.length) return { at: new Date(Math.min(...times)), precise: true, source: "veeqo" };
  } catch {
    /* Veeqo down / key rejected — fall back to a stored ship date */
  }
  const msg = await prisma.buyerMessage.findFirst({
    where: { amazonOrderId: orderId, shipDate: { not: null } },
    select: { shipDate: true },
  });
  const ship =
    msg?.shipDate ||
    (
      await prisma.amazonOrderShipment.findFirst({
        where: { amazonOrderId: orderId, shipDate: { not: null } },
        select: { shipDate: true },
      })
    )?.shipDate;
  if (ship && /^\d{4}-\d{2}-\d{2}/.test(ship))
    return { at: new Date(`${ship.slice(0, 10)}T12:00:00Z`), precise: false, source: "ship-date" };
  return null;
}

const SHIPPED = /shipped/i;
const RESOLVE_RETRY_MS = 6 * 3600_000;

/**
 * The buyer's cancellation request on this order as a case-data fact, or null
 * when Amazon sent none. Resolves (and caches) the label time while the
 * verdict is still unknown.
 */
export async function cancelFactForOrder(orderId: string, storeIndex?: number): Promise<CancelRequestFact | null> {
  const rows = await prisma.amazonCancelRequest.findMany({
    where: { amazonOrderId: orderId, ...(storeIndex === undefined ? {} : { storeIndex }) },
    orderBy: { requestedAt: "asc" },
  });
  if (!rows.length) return null;
  const first = rows.find((r) => r.kind === "REQUEST") || rows[0];
  const order = await prisma.amazonOrder.findUnique({
    where: { amazonOrderId: orderId },
    select: { orderTotal: true, status: true },
  });
  let { labelPurchasedAt, labelSource, beforeShipment } = first;
  // Resolve once; retry (every 6 h) while the verdict is unknown or rests on
  // a date-only ship date rather than Veeqo's exact label time.
  const stale = !first.resolvedAt || Date.now() - first.resolvedAt.getTime() > RESOLVE_RETRY_MS;
  if (
    first.kind === "REQUEST" &&
    (beforeShipment === null || labelSource !== "veeqo") &&
    stale &&
    (!order || SHIPPED.test(order.status))
  ) {
    const label = await labelPurchased(orderId);
    labelPurchasedAt = label?.at ?? null;
    labelSource = label?.source ?? "none";
    beforeShipment = requestedBeforeLabel(first.requestedAt, label);
    await prisma.amazonCancelRequest.update({
      where: { id: first.id },
      data: { labelPurchasedAt, labelSource, beforeShipment, resolvedAt: new Date() },
    });
  }
  return {
    requestedAt: first.requestedAt.toISOString(),
    source: "amazon-notification",
    kind: first.kind === "CANCELLED" ? "CANCELLED" : "REQUEST",
    labelPurchasedAt: labelPurchasedAt ? labelPurchasedAt.toISOString() : null,
    labelSource: (labelSource as CancelRequestFact["labelSource"]) || "none",
    beforeShipment,
    orderTotal: order?.orderTotal ?? null,
  };
}

export interface CancelRequestRow extends CancelRequestFact {
  storeIndex: number;
  orderId: string;
  orderStatus: string | null;
  purchaseDate: string | null;
  shipBy: string | null;
}

/** Every order with a cancellation notice in the last `days` days. */
export async function listCancelRequests(opts: { days?: number; onlyBeforeShipment?: boolean } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000);
  const rows = await prisma.amazonCancelRequest.findMany({
    where: { requestedAt: { gte: since }, storeIndex: { in: ACTIVE_CS_STORES } },
    orderBy: { requestedAt: "asc" },
    select: { amazonOrderId: true, storeIndex: true },
  });
  const seen = new Set<string>();
  const out: CancelRequestRow[] = [];
  for (const r of rows) {
    if (seen.has(r.amazonOrderId)) continue;
    seen.add(r.amazonOrderId);
    const fact = await cancelFactForOrder(r.amazonOrderId);
    if (!fact) continue;
    const o = await prisma.amazonOrder.findUnique({
      where: { amazonOrderId: r.amazonOrderId },
      select: { status: true, purchaseDate: true, latestShipDate: true },
    });
    out.push({
      ...fact,
      storeIndex: r.storeIndex,
      orderId: r.amazonOrderId,
      orderStatus: o?.status ?? null,
      purchaseDate: o?.purchaseDate?.toISOString() ?? null,
      shipBy: o?.latestShipDate?.toISOString() ?? null,
    });
  }
  return opts.onlyBeforeShipment ? out.filter((x) => x.beforeShipment === true) : out;
}
