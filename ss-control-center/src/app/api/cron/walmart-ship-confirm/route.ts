/**
 * GET /api/cron/walmart-ship-confirm
 *
 * Daily "mark Walmart orders as shipped" automation for Jackie's workflow.
 * For every Acknowledged Walmart order that has a Buy Shipping label, verify
 * the package is PHYSICALLY MOVING (beyond the origin "label created" scan)
 * and only then confirm the shipment to Walmart.
 *
 * Pipeline per order:
 *   1. getLabelsByPurchaseOrder(po) — the Ship-with-Walmart label resource
 *      carries tracking while the order is still Acknowledged (the order
 *      resource does NOT — tracking only fills in on the ship write-call).
 *   2. carrier tracking (UPS/USPS/FedEx libs) — is it moving?
 *   3. ship gate — ship ONLY when there is movement beyond an origin-only
 *      scan ("Shipment information sent" / "Label created" do NOT count).
 *   4. shipOrderLines(po, lines) built from the label's boxItems.
 *
 * SAFETY: this is dry-run by default. It only ships when called with
 * ?dryRun=false. The scheduled cron entries in vercel.json deliberately pass
 * ?dryRun=false now that the gate is confirmed safe.
 *
 * SCHEDULE: three passes, all registered in vercel.json (Vercel cron is UTC
 * year-round; the ET-clock equivalents drift by 1 hour at DST transitions,
 * which doesn't matter for this use case):
 *   - 02:00 UTC = 22:00 ET (summer) / 21:00 ET (winter) — initial evening pass
 *   - 03:00 UTC = 23:00 ET (summer) / 22:00 ET (winter) — late-evening pass for
 *     fast-scanning carriers (UPS/FedEx label-bought-and-scanned same day)
 *   - 10:00 UTC = 06:00 ET (summer) / 05:00 ET (winter) — overnight catch-up.
 *     USPS routinely posts induction scans to their public API hours after the
 *     package physically moved (typical scan time 22:00–04:00 ET); without a
 *     morning pass those orders sit "label bought, not yet shipped" until the
 *     operator marks them manually.
 *
 * Auth: CRON_SECRET via Bearer header (same as the other walmart crons).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { getUpsTracking } from "@/lib/carriers/ups-tracking";
import { getUspsTracking } from "@/lib/carriers/usps-tracking";
import { getFedexTracking } from "@/lib/carriers/fedex-tracking";
import { sendWalmartTelegram } from "@/lib/telegram";
import type { UpsTrackingInfo } from "@/lib/carriers/ups-tracking";
import type { WalmartShipLineInput } from "@/lib/walmart/types";

export const maxDuration = 300;

const STORE_INDEX = 1;

// Origin-only scans — a label exists / carrier was notified, but the package
// has NOT physically moved. Never ship on these alone.
const ORIGIN_ONLY =
  /shipment information sent|label created|shipping label created|order processed|pre.?shipment|awaiting item|electronic.*notification|created.*label|ready for/i;
// Positive signs the package is actually in the carrier network.
const MOVEMENT =
  /picked up|in transit|on the way|on its way|departed|arrived|out for delivery|delivered|received by|scan/i;

function carrierFetcher(
  carrierName: string,
): ((tn: string) => Promise<UpsTrackingInfo | null>) | null {
  const c = carrierName.toUpperCase();
  if (c.includes("UPS")) return getUpsTracking;
  if (c.includes("FEDEX") || c.includes("FED EX")) return getFedexTracking;
  if (c.includes("USPS")) return getUspsTracking;
  return null;
}

/** Decide whether tracking shows real movement beyond the origin scan. */
function isMovingBeyondOrigin(info: UpsTrackingInfo): boolean {
  if (info.delivered) return true;
  const last = info.events[info.events.length - 1];
  const text = `${info.currentStatus ?? ""} ${last?.description ?? ""}`.trim();
  if (!text) return false;
  if (ORIGIN_ONLY.test(text) && info.events.length <= 1) return false;
  return MOVEMENT.test(text) || info.events.length > 1;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  // Dry-run UNLESS explicitly ?dryRun=false. Safe by default.
  const dryRun = url.searchParams.get("dryRun") !== "false";
  // `force` previously bypassed the now-removed 22:00-ET gate. Kept as a
  // no-op flag so any saved manual-trigger URLs (Bookmarks, runbooks) keep
  // working — the cron now respects the schedule(s) declared in vercel.json
  // verbatim, no per-hour gating in code.
  url.searchParams.get("force"); // intentionally read-and-discard

  let client;
  try {
    client = getWalmartClient(STORE_INDEX);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
  const api = new WalmartOrdersApi(client);

  const startedAt = Date.now();
  const shipped: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const noLabel: string[] = [];
  const errors: Array<Record<string, unknown>> = [];

  // SyncLog row so every run is auditable from the DB (previously the cron
  // had no DB trace at all — the only way to know if it ran was to grep
  // Vercel logs within their retention window).
  const syncLog = await prisma.syncLog.create({
    data: {
      jobName: `walmart-ship-confirm${dryRun ? "-dryrun" : ""}`,
      storeIndex: STORE_INDEX,
      status: "running",
    },
  });

  try {
    for await (const order of api.paginate({ status: "Acknowledged", limit: 100 })) {
      const po = order.purchaseOrderId;
      try {
        const labels = await api.getLabelsByPurchaseOrder(po);
        if (labels.length === 0) {
          noLabel.push(po);
          continue;
        }

        // Build ship lines + verify movement across all labels on the order.
        const shipLines: WalmartShipLineInput[] = [];
        let blockedReason: string | null = null;
        for (const label of labels) {
          const fetch = carrierFetcher(label.carrierName);
          if (!fetch || !label.trackingNumber) {
            blockedReason = `unsupported carrier "${label.carrierName}" or missing tracking`;
            break;
          }
          const info = await fetch(label.trackingNumber);
          if (!info) {
            blockedReason = `no tracking data yet for ${label.trackingNumber}`;
            break;
          }
          if (!isMovingBeyondOrigin(info)) {
            blockedReason = `${label.trackingNumber}: origin-only ("${info.currentStatus ?? "no status"}")`;
            break;
          }
          const shipDateTime = new Date();
          for (const box of label.boxItems) {
            shipLines.push({
              lineNumber: box.lineNumber,
              quantity: box.quantity,
              shipDateTime,
              carrierName: label.carrierName,
              methodCode: "Standard",
              trackingNumber: label.trackingNumber,
              trackingUrl: label.trackingUrl,
            });
          }
        }

        if (blockedReason) {
          skipped.push({ po, reason: blockedReason });
          continue;
        }
        if (shipLines.length === 0) {
          skipped.push({ po, reason: "label had no box items" });
          continue;
        }

        if (dryRun) {
          shipped.push({
            po,
            dry_run: true,
            would_ship_lines: shipLines.map((l) => ({
              line: l.lineNumber,
              qty: l.quantity,
              carrier: l.carrierName,
              tracking: l.trackingNumber,
            })),
          });
        } else {
          const updated = await api.shipOrderLines(po, shipLines);
          shipped.push({ po, status: updated.status, lines: shipLines.length });
        }
      } catch (err) {
        if (err instanceof WalmartApiError) {
          errors.push({ po, status: err.status, body: err.errorBody });
        } else {
          errors.push({ po, error: (err as Error).message });
        }
      }
    }
  } catch (err) {
    // Pagination itself failed — return what we have plus the error.
    errors.push({ stage: "list-acknowledged", error: (err as Error).message });
  }

  // Close out SyncLog with summary counts. itemsSynced = orders actually
  // shipped (or would-ship in dry-run) so the History panel surfaces the
  // useful number, not the total scanned count.
  await prisma.syncLog.update({
    where: { id: syncLog.id },
    data: {
      status: errors.length > 0 ? "error" : "done",
      completedAt: new Date(),
      itemsSynced: shipped.length,
      error:
        errors.length > 0
          ? `${errors.length} error(s); skipped ${skipped.length}; no-label ${noLabel.length}`
          : null,
    },
  });

  // Telegram summary to the Walmart group so the operator sees the run
  // outcome without needing to open Vercel logs. Only post when something
  // happened (shipped > 0 OR errors > 0) — otherwise we'd ping the chat
  // every night with a "0 shipped" no-op.
  if (shipped.length > 0 || errors.length > 0) {
    const lines: string[] = [];
    lines.push(
      dryRun
        ? "🧪 <b>Walmart ship-confirm (dry-run)</b>"
        : "🚚 <b>Walmart ship-confirm</b>",
    );
    lines.push("");
    lines.push(`Shipped: <b>${shipped.length}</b>`);
    if (skipped.length > 0) lines.push(`Skipped: ${skipped.length} (origin-only / no tracking yet)`);
    if (noLabel.length > 0) lines.push(`No label: ${noLabel.length}`);
    if (errors.length > 0) lines.push(`⚠️ Errors: ${errors.length}`);
    if (shipped.length > 0 && !dryRun) {
      lines.push("");
      lines.push(
        shipped
          .slice(0, 5)
          .map((s) => `• PO ${s.po}`)
          .join("\n"),
      );
      if (shipped.length > 5) {
        lines.push(`…and ${shipped.length - 5} more`);
      }
    }
    try {
      await sendWalmartTelegram(lines.join("\n"));
    } catch (e) {
      console.warn(
        "[ship-confirm] telegram summary failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    dry_run: dryRun,
    durationMs: Date.now() - startedAt,
    counts: {
      shipped: shipped.length,
      skipped: skipped.length,
      no_label: noLabel.length,
      errors: errors.length,
    },
    shipped,
    skipped,
    no_label: noLabel,
    errors,
  });
}
