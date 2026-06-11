/**
 * GET /api/cron/reprice-amazon
 *
 * Featured-Offer repricer. For each enabled store, lowers our listing price
 * just enough to win back the Featured Offer (Buy Box) when a competitor
 * holds it at a lower LANDED price — exactly the "Match Featured Offer Price"
 * card Vladimir clicks by hand on the Seller Central dashboard.
 *
 * Enabled stores: 1 (Salutem) and 3 (AMZ Commerce). Store 4 has no SP-API;
 * store 5 is US-suspended; store 2 is excluded for now.
 *
 * Safety: only lowers price, never more than 10% in one run (bigger cuts are
 * flagged for manual review), $1.00 absolute floor. See reprice-engine.ts.
 *
 * Modes:
 *   ?dryRun=true   compute + log + notify, but DO NOT change any price.
 *   (default)      live — applies price changes.
 *
 * Schedule (vercel.json): every 2 hours.
 *
 * Auth: CRON_SECRET via Bearer header (Vercel sets this automatically).
 * After each run a summary is sent to Telegram (Jackie).
 */

import { NextRequest, NextResponse } from "next/server";
import { repriceStore, type RunResult } from "@/lib/reprice/reprice-engine";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { sendTelegramMessage } from "@/lib/telegram";

export const maxDuration = 300;

const ENABLED_STORES = [1, 3];

function fmtMoney(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

function buildSummary(results: RunResult[], dryRun: boolean): string {
  const tag = dryRun ? "🧪 Репрайсер (ТЕСТ, цены не менялись)" : "💰 Репрайсер";
  const lines: string[] = [tag];

  for (const r of results) {
    const note = r.timedOut
      ? " ⏳(продолжу в след. запуск)"
      : r.sweepComplete
        ? ""
        : "";
    const floorNote = r.skippedFloor > 0 ? `, придержано по марже ${r.skippedFloor}` : "";
    lines.push(
      `\n<b>store${r.storeIndex}</b>: проверено ${r.scanned}, изменено ${r.repriced}, на ручную проверку ${r.skippedCap}${floorNote}, ошибок ${r.errors}${note}`,
    );
    for (const c of r.changes.slice(0, 15)) {
      const title = (c.title ?? c.sku).slice(0, 40);
      lines.push(
        `  • ${title}: ${fmtMoney(c.oldPrice)} → ${fmtMoney(c.newPrice)}`,
      );
    }
    if (r.changes.length > 15) {
      lines.push(`  …и ещё ${r.changes.length - 15}`);
    }
    for (const f of r.flagged.slice(0, 10)) {
      const title = (f.title ?? f.sku).slice(0, 40);
      lines.push(`  ⚠️ ${title}: ${f.reason ?? "нужна проверка"}`);
    }
  }

  const totalChanged = results.reduce((s, r) => s + r.repriced, 0);
  if (totalChanged === 0) {
    lines.push("\nИзменений нет — везде выигрываешь Featured Offer или нет конкуренции.");
  }
  return lines.join("\n");
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const startedAt = Date.now();
  const results: RunResult[] = [];

  for (const storeIndex of ENABLED_STORES) {
    if (!getStoreCredentials(storeIndex)) continue;
    try {
      const r = await repriceStore(storeIndex, { dryRun, startedAt });
      results.push(r);
    } catch (err) {
      results.push({
        storeIndex,
        scanned: 0,
        repriced: 0,
        skippedCap: 0,
        skippedFloor: 0,
        noCompetition: 0,
        errors: 1,
        changes: [],
        flagged: [],
        sweepComplete: false,
        timedOut: false,
      });
      console.error(`[reprice-amazon] store${storeIndex} failed:`, err);
    }
  }

  // Telegram summary OFF by default (Vladimir 2026-06-08 — the every-2h pings
  // cluttered Jackie's DM and reprice results are visible in the Control
  // Center UI). Flip TELEGRAM_REPRICE_ENABLED=true on Vercel to restore them.
  // When enabled, notify only when something actionable happened, or always in
  // dryRun so a first run can be confirmed.
  const notifyEnabled = process.env.TELEGRAM_REPRICE_ENABLED === "true";
  const actionable =
    dryRun ||
    results.some((r) => r.repriced > 0 || r.skippedCap > 0 || r.errors > 0);
  if (notifyEnabled && actionable) {
    try {
      await sendTelegramMessage(buildSummary(results, dryRun));
    } catch (e) {
      console.error("[reprice-amazon] telegram failed:", e);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}
