/**
 * The shipping rate-selection profile switch (topic 135).
 *
 *   GET  /api/shipping/rate-profile → { profile: "summer"|"shadow"|"live" }
 *   PUT  /api/shipping/rate-profile  body { profile }  → sets it.
 *
 * One Setting row (`shipping_rate_profile`) that the owner flips with a single
 * call:
 *   summer — engine OFF, pure Master Prompt v3.5 (the rollback)
 *   shadow — show the temperature-aware pick + saving, buy by summer (launch)
 *   live   — buy the temperature-aware pick
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  RATE_PROFILE_SETTING_KEY,
  parseRateProfile,
  __clearRateProfileCache,
} from "@/lib/shipping/temp-class";

export async function GET() {
  const row = await prisma.setting.findUnique({
    where: { key: RATE_PROFILE_SETTING_KEY },
  });
  return NextResponse.json({ profile: parseRateProfile(row?.value) });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { profile?: string };
  const raw = String(body?.profile ?? "").trim().toLowerCase();
  if (raw !== "summer" && raw !== "shadow" && raw !== "live") {
    return NextResponse.json(
      { error: 'profile must be "summer", "shadow" or "live"' },
      { status: 400 },
    );
  }
  await prisma.setting.upsert({
    where: { key: RATE_PROFILE_SETTING_KEY },
    create: { key: RATE_PROFILE_SETTING_KEY, value: raw },
    update: { value: raw },
  });
  __clearRateProfileCache();
  return NextResponse.json({ success: true, profile: raw });
}
