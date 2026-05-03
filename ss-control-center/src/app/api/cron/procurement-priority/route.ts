/**
 * GET /api/cron/procurement-priority
 *
 * Every 15 minutes (per vercel.json): scan awaiting_fulfillment orders,
 * filter by Procurement rules (no Placed / canceled / Заказано у Майка /
 * NAN-health), find priority-flagged ones, and Telegram-notify Vladimir
 * for any not yet logged in ProcurementNotificationLog.
 *
 * Auth: validates `Authorization: Bearer ${CRON_SECRET}` (Vercel adds it).
 *
 * Failure modes:
 *   - DB table missing (Phase 1 schema not pushed to Turso) → skips dedup
 *     and notifications, returns 200 with dbReady:false. No retries.
 *   - TELEGRAM_PROCUREMENT_CHAT_ID and TELEGRAM_CHAT_ID both unset → still
 *     runs detection and updates the log so when Vladimir sets the env
 *     var future cycles work; but no message is sent.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchAllOrders } from "@/lib/veeqo/client";
import { shouldIncludeOrderInProcurement } from "@/lib/procurement/filter-rules";
import { detectPriority } from "@/lib/procurement/priority-detector";
import { isMissingTableError } from "@/lib/procurement/store-list";
import { sendTelegramMessageTo } from "@/lib/telegram";

export const dynamic = "force-dynamic";

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ?? "https://salutemsolutions.info";

function requireCronAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev / local — allow
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

interface VeeqoOrder {
  id?: string | number;
  number?: string;
  channel?: { name?: string; type_code?: string };
  delivery_method?: { name?: string };
  deliver_by?: string;
  expected_dispatch_date?: string;
  is_premium?: boolean;
  priority?: string;
  line_items?: Array<{
    quantity?: number;
    sellable?: {
      title?: string;
      product?: { title?: string; name?: string };
    };
  }>;
  [k: string]: unknown;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMessage(order: VeeqoOrder, reason: string): string {
  const orderNum = order.number ?? String(order.id ?? "");
  const channel = order.channel?.type_code ?? order.channel?.name ?? "?";
  const shipping = order.delivery_method?.name ?? "?";
  const items = order.line_items ?? [];
  const productLines = items
    .slice(0, 3)
    .map((li) => {
      const t =
        li.sellable?.product?.title ??
        li.sellable?.product?.name ??
        li.sellable?.title ??
        "?";
      const q = li.quantity ?? 0;
      return `• ${escapeHtml(t)} — ${q} шт`;
    })
    .join("\n");
  const more =
    items.length > 3 ? `\n• …и ещё ${items.length - 3} товаров` : "";
  const shipBy =
    typeof order.deliver_by === "string" && order.deliver_by
      ? new Date(order.deliver_by).toLocaleString("ru-RU", {
          timeZone: "America/New_York",
          dateStyle: "short",
          timeStyle: "short",
        })
      : "—";

  return [
    "🚨 <b>Приоритетный заказ требует закупа</b>",
    `<i>${escapeHtml(reason)}</i>`,
    "",
    productLines + more,
    "",
    `Order: <code>${escapeHtml(orderNum)}</code> (${escapeHtml(channel)})`,
    `Доставка: ${escapeHtml(shipping)}`,
    `Ship by: ${escapeHtml(shipBy)} ET`,
    "",
    `<a href="${PUBLIC_BASE_URL}/procurement">Открыть Procurement</a>`,
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const authResp = requireCronAuth(req);
  if (authResp) return authResp;

  const chatId =
    process.env.TELEGRAM_PROCUREMENT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;

  let orders: VeeqoOrder[];
  try {
    orders = (await fetchAllOrders("awaiting_fulfillment")) as VeeqoOrder[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "veeqo fetch failed";
    console.error("[cron procurement-priority] fetch failed", e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Filter and detect priorities
  const candidates: Array<{
    order: VeeqoOrder;
    reason: string;
  }> = [];
  for (const o of orders) {
    if (!shouldIncludeOrderInProcurement(o)) continue;
    const reason = detectPriority(o);
    if (reason) {
      candidates.push({
        order: o,
        reason: humanReason(reason),
      });
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      checked: orders.length,
      candidates: 0,
      sent: 0,
    });
  }

  // Dedup against ProcurementNotificationLog (graceful if table missing)
  const candidateIds = candidates.map((c) => String(c.order.id ?? ""));
  let alreadyNotified = new Set<string>();
  let dbReady = true;
  try {
    const existing = await prisma.procurementNotificationLog.findMany({
      where: { orderId: { in: candidateIds } },
      select: { orderId: true },
    });
    alreadyNotified = new Set(existing.map((r) => r.orderId));
  } catch (e: unknown) {
    if (isMissingTableError(e)) {
      dbReady = false;
      console.warn(
        "[cron procurement-priority] ProcurementNotificationLog table missing — skipping dedup"
      );
    } else {
      throw e;
    }
  }

  let sent = 0;
  let logged = 0;
  for (const { order, reason } of candidates) {
    const orderId = String(order.id ?? "");
    if (!orderId) continue;
    if (alreadyNotified.has(orderId)) continue;

    const text = buildMessage(order, reason);

    let didSend = false;
    if (chatId) {
      const res = await sendTelegramMessageTo(chatId, text);
      if (res.sent) {
        didSend = true;
        sent++;
      }
    }

    // Log even if sending was skipped (no chatId) so we don't backlog notifs
    // when Vladimir later configures the chat. Spec: notify only NEW priority
    // orders going forward, not historical ones.
    if (dbReady) {
      try {
        await prisma.procurementNotificationLog.create({
          data: { orderId },
        });
        logged++;
      } catch (e: unknown) {
        // unique-constraint race or other; safe to ignore
        if (!isUniqueConstraintError(e)) {
          console.error("[cron procurement-priority] log insert failed", e);
        }
      }
    }
    void didSend;
  }

  return NextResponse.json({
    checked: orders.length,
    candidates: candidates.length,
    sent,
    logged,
    chatConfigured: Boolean(chatId),
    dbReady,
  });
}

function humanReason(r: ReturnType<typeof detectPriority>): string {
  if (!r) return "Приоритет";
  if (r.kind === "premium") return "Premium-заказ";
  if (r.kind === "express-shipping") return `Экспресс-доставка: ${r.detail}`;
  if (r.kind === "tight-dispatch") return `Срок отгрузки: ${r.detail}`;
  return "Приоритет";
}

interface PrismaErrorLike {
  code?: string;
}
function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as PrismaErrorLike).code === "P2002"
  );
}
