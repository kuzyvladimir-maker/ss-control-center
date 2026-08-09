/**
 * GET /api/cron/walmart-offer-restoration
 *
 * Every four hours, inspect three recently sold legacy Walmart items on the
 * public buyer surface. Notify only when STARFITSTORE's exact offer changes to
 * buyer-available. This route never writes to Walmart and never calls a paid
 * scraping provider.
 */

import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { sendWalmartTelegram } from "@/lib/telegram";
import {
  advanceWalmartOfferRestorationState,
  fetchWalmartOwnOfferObservation,
  formatWalmartRestorationTelegram,
  markWalmartRestorationNotificationsDelivered,
  parseWalmartOfferRestorationState,
  pendingWalmartRestorationSkus,
  WALMART_OFFER_RESTORATION_STATE_KEY,
  WALMART_OFFER_RESTORATION_TARGETS,
} from "@/lib/walmart/offer-restoration-monitor";

export const maxDuration = 120;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function saveState(value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: WALMART_OFFER_RESTORATION_STATE_KEY },
    create: { key: WALMART_OFFER_RESTORATION_STATE_KEY, value },
    update: { value },
  });
}

export async function GET(request: NextRequest) {
  const authFailure = requireCronAuth(request);
  if (authFailure) return authFailure;

  const startedAt = new Date().toISOString();
  try {
    const previousRow = await prisma.setting.findUnique({
      where: { key: WALMART_OFFER_RESTORATION_STATE_KEY },
      select: { value: true },
    });
    const previous = parseWalmartOfferRestorationState(previousRow?.value);
    const observations = await Promise.all(
      WALMART_OFFER_RESTORATION_TARGETS.map((target) =>
        fetchWalmartOwnOfferObservation(target, fetch, startedAt)),
    );
    let state = advanceWalmartOfferRestorationState(
      previous,
      observations,
      startedAt,
    );

    // Persist the transition before the external notification. If Telegram is
    // unavailable, pendingNotification survives and the next cron retries it.
    await saveState(JSON.stringify(state));

    const pendingSkus = pendingWalmartRestorationSkus(state);
    let notification:
      | { attempted: false; sent: false }
      | { attempted: true; sent: boolean; reason?: string } = {
        attempted: false,
        sent: false,
      };
    if (pendingSkus.length > 0) {
      const result = await sendWalmartTelegram(
        formatWalmartRestorationTelegram(state, pendingSkus),
      );
      notification = {
        attempted: true,
        sent: result.sent,
        ...(result.sent ? {} : { reason: result.reason }),
      };
      if (result.sent) {
        state = markWalmartRestorationNotificationsDelivered(
          state,
          pendingSkus,
        );
        await saveState(JSON.stringify(state));
      }
    }

    const counts = {
      available: observations.filter((item) => item.status === "AVAILABLE").length,
      unavailable: observations.filter((item) => item.status === "UNAVAILABLE").length,
      unknown: observations.filter((item) => item.status === "UNKNOWN").length,
    };
    return NextResponse.json({
      ok: true,
      startedAt,
      readOnly: true,
      paidProviderCalls: 0,
      walmartWrites: 0,
      counts,
      notification,
      observations,
    });
  } catch (error) {
    console.error("[walmart-offer-restoration] monitor failed", error);
    return NextResponse.json(
      {
        ok: false,
        startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
