/**
 * GET /api/cron/walmart-quantity-inquiry-poll
 *
 * Twice a day. For every open quantity-clarification inquiry (status SENT)
 * sent to a Walmart buyer's relay address, check the Sirius CS mailbox
 * (info.siriustrading@gmail.com) for the buyer's reply:
 *
 *   * A reply arrived (a message FROM the order's relay address, dated after
 *     we sent) → flip SENT → ANSWERED, store the reply text, ping Telegram so
 *     Vladimir sees it. The procurement card chip turns into "Ответ получен".
 *
 *   * No reply and it's been > 48h → flip SENT → TIMEOUT. The card chip shows
 *     "Нет ответа (48ч)" and we stop watching.
 *
 * The buyer's reply comes back THROUGH Walmart's relay, so its From address is
 * the same per-order relay we emailed — which is how we match a reply to an
 * inquiry deterministically.
 *
 * Mirrors the auth + SyncLog pattern of walmart-cancellation-watchdog.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getGmailAccountByEmail,
  searchMessages,
  readMessage,
} from "@/lib/gmail-api";
import { WALMART_SIRIUS_CS_EMAIL } from "@/lib/procurement/quantity-inquiry";
import { sendWalmartTelegram } from "@/lib/telegram";

export const maxDuration = 300;

const STORE_INDEX = 1;
const TIMEOUT_HOURS = 48;
// Don't keep polling forever — inquiries older than this are abandoned.
const MAX_AGE_DAYS = 30;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
};

function decodeB64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

/** Depth-first search for the first text/plain part with a body. */
function extractPlainText(part: GmailPart | undefined | null): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeB64Url(part.body.data);
  }
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  return null;
}

/** Strip the quoted original + signature noise and cap length for storage. */
function cleanReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    // Common quote markers — stop at the first one.
    if (/^On .+wrote:$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message/i.test(line.trim())) break;
    if (/^_{5,}/.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 2000);
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const syncLog = await prisma.syncLog.create({
    data: {
      jobName: "walmart-quantity-inquiry-poll",
      storeIndex: STORE_INDEX,
      status: "running",
    },
  });

  const startedAt = Date.now();
  const result = {
    open: 0,
    answered: 0,
    timedOut: 0,
    errors: 0,
    mailboxConnected: true,
  };

  try {
    const account = await getGmailAccountByEmail(WALMART_SIRIUS_CS_EMAIL);
    if (!account) {
      result.mailboxConnected = false;
      await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: "done",
          completedAt: new Date(),
          error: `${WALMART_SIRIUS_CS_EMAIL} not connected — nothing polled`,
        },
      });
      return NextResponse.json({ ok: true, ...result });
    }

    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000);
    const open = await prisma.walmartCustomerInquiry.findMany({
      where: { status: "SENT", sentAt: { gte: cutoff } },
      orderBy: { sentAt: "asc" },
    });
    result.open = open.length;

    const answeredSummaries: string[] = [];

    for (const inq of open) {
      try {
        const sentMs = inq.sentAt.getTime();
        // Newest-first; a handful is plenty since one relay address ↔ one order.
        const stubs = await searchMessages(
          account.refreshToken,
          `from:${inq.relayEmail} newer_than:${MAX_AGE_DAYS}d`,
          5,
        );

        let replyText: string | null = null;
        let replyMs = 0;
        for (const stub of stubs) {
          if (!stub.id) continue;
          const msg = await readMessage(account.refreshToken, stub.id);
          const internalMs = Number(msg.internalDate ?? 0);
          // Only count messages that arrived AFTER we sent the inquiry.
          if (!Number.isFinite(internalMs) || internalMs <= sentMs) continue;
          if (internalMs > replyMs) {
            replyMs = internalMs;
            const plain = extractPlainText(msg.payload as GmailPart);
            replyText = plain ? cleanReply(plain) : msg.snippet ?? null;
          }
        }

        if (replyText && replyMs > 0) {
          await prisma.walmartCustomerInquiry.update({
            where: { id: inq.id },
            data: {
              status: "ANSWERED",
              replyText,
              repliedAt: new Date(replyMs),
            },
          });
          result.answered++;
          answeredSummaries.push(
            `#${inq.customerOrderId ?? inq.purchaseOrderId} — ${
              inq.productTitle ?? "(item)"
            }: “${replyText.slice(0, 140)}”`,
          );
          continue;
        }

        // No reply yet — time out if it's been long enough.
        const ageHours = (Date.now() - sentMs) / 3_600_000;
        if (ageHours >= TIMEOUT_HOURS) {
          await prisma.walmartCustomerInquiry.update({
            where: { id: inq.id },
            data: { status: "TIMEOUT" },
          });
          result.timedOut++;
        }
      } catch (e) {
        result.errors++;
        console.error(
          `[quantity-inquiry-poll] ${inq.purchaseOrderId} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (answeredSummaries.length > 0) {
      const text = [
        `📨 <b>Walmart: ответы по уточнению количества (${answeredSummaries.length})</b>`,
        "",
        ...answeredSummaries,
        "",
        "Открой Procurement — карточки помечены «Ответ получен».",
      ].join("\n");
      await sendWalmartTelegram(text);
    }

    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: result.errors > 0 ? "error" : "done",
        completedAt: new Date(),
        itemsSynced: result.answered + result.timedOut,
        error:
          result.errors > 0
            ? `${result.errors} inquiry poll(s) failed; see logs`
            : null,
      },
    });

    return NextResponse.json({
      ok: result.errors === 0,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[quantity-inquiry-poll] fatal:", msg);
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: { status: "error", completedAt: new Date(), error: msg },
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
