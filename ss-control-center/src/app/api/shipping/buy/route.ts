import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buyShippingLabel,
  addEmployeeNote,
  updateOrderDispatchDate,
  getShippingRates,
  extractVasFromRate,
} from "@/lib/veeqo";
import { sendTelegramMessage } from "@/lib/telegram";
import { uploadLabelPdf } from "@/lib/google-drive";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

// Append a single JSON line per /api/shipping/buy call. The file lives
// outside `public/` so it's never served to the browser. Used as a
// last-resort audit trail in case the post-buy modal is dismissed
// before the operator screenshots it. Non-fatal on write error — the
// API response and Telegram message are still authoritative.
function appendBuyLog(entry: Record<string, unknown>) {
  try {
    const dir = join(process.cwd(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(dir, "shipping-buy.jsonl"), line + "\n");
  } catch (e) {
    console.error("[buy] audit log write failed:", e);
  }
}

// Walk a Veeqo shipment response looking for the tracking string.
// Handles every shape seen so far: top-level `tracking_number`, nested
// `shipment.tracking_number`, camelCase fallback, and the object form
// `{value: "1Z...", carrier: "UPS"}` returned by some carriers.
function pickTrackingString(shipment: unknown): string | null {
  if (!shipment || typeof shipment !== "object") return null;
  const s = shipment as Record<string, unknown>;
  const candidates: unknown[] = [
    s.tracking_number,
    s.trackingNumber,
    (s.shipment as Record<string, unknown> | undefined)?.tracking_number,
    (s.shipment as Record<string, unknown> | undefined)?.trackingNumber,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      const inner =
        (typeof obj.value === "string" && obj.value) ||
        (typeof obj.number === "string" && obj.number) ||
        (typeof obj.tracking_number === "string" && obj.tracking_number);
      if (inner) return inner;
    }
  }
  return null;
}

// Format date as "Mmm DD" (e.g. "Apr 07")
function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "N-A";
  const d = new Date(dateStr + "T12:00:00");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
}

// Build PDF filename per MASTER_PROMPT section 9
function buildPdfFilename(item: {
  edd: string | null;
  deliveryBy: string | null;
  product: string;
  qty: number;
}): string {
  const edd = fmtDate(item.edd);
  const dl = fmtDate(item.deliveryBy);
  const product = item.product.substring(0, 80).replace(/[/\\:*?"<>|]/g, "");
  return `(EDD ${edd} | DL ${dl}) ${product} -- ${item.qty}.pdf`;
}

// Build folder path per MASTER_PROMPT section 8
function buildFolderPath(item: {
  actualShipDay: string | null;
  channel: string;
}): string {
  const shipDay = item.actualShipDay || new Date().toISOString().split("T")[0];
  const d = new Date(shipDay + "T12:00:00");
  const monthNum = String(d.getMonth() + 1).padStart(2, "0");
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const monthName = monthNames[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const channelName = item.channel || "Amazon";
  // Shipping Labels / 04 April / 07 / Amazon /
  return `${monthNum} ${monthName}/${day}/${channelName}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { planId, itemIds } = body;

    if (!planId) {
      return NextResponse.json(
        { error: "planId is required" },
        { status: 400 }
      );
    }

    const plan = await prisma.shippingPlan.findUnique({
      where: { id: planId },
      include: { items: true },
    });

    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    let itemsToBuy = plan.items.filter((i) => i.status === "pending");
    if (itemIds && itemIds.length > 0) {
      itemsToBuy = itemsToBuy.filter((i) => itemIds.includes(i.id));
    }

    const results = {
      bought: [] as {
        orderNumber: string;
        tracking: string;
        itemId: string;
        labelPath: string | null;
        // Explicit so the post-buy modal can flag "label bought but PDF
        // not saved locally" — Veeqo has the label, our disk doesn't.
        pdfSaved: boolean;
        // Which persistence path actually placed the file. "drive"
        // means the operator can find it on the shared Drive; "proxy"
        // means it's only retrievable via our `/api/shipping/label-pdf`
        // pass-through (nothing was persisted on our side or on Drive).
        // Surfaced in the post-buy modal so silent Drive failures stop
        // looking like successes.
        pdfSource: "drive" | "disk" | "proxy" | "none";
        // Reason Drive upload didn't happen, if it didn't. Useful for
        // diagnosing without spelunking Vercel logs.
        driveError: string | null;
        carrier: string | null;
        service: string | null;
        price: number | null;
      }[],
      errors: [] as { orderNumber: string; error: string; itemId: string }[],
      total: itemsToBuy.length,
    };

    for (const item of itemsToBuy) {
      try {
        if (
          !item.allocationId || !item.carrierId || !item.remoteShipmentId ||
          !item.serviceType || !item.subCarrierId || !item.serviceCarrier ||
          !item.totalNetCharge || !item.baseRate
        ) {
          results.errors.push({ orderNumber: item.orderNumber, error: "Missing shipping data", itemId: item.id });
          continue;
        }

        // Ship Date Trick — if the plan picked a future ship day (e.g. the
        // Frozen Monday-shift won at plan time), push the order's
        // dispatch_date in Veeqo before buying so the carrier label prints
        // with the correct ship date and the warehouse worker files it in
        // the Monday folder via buildFolderPath() below.
        const todayIso = new Date().toISOString().split("T")[0];
        if (item.actualShipDay && item.actualShipDay > todayIso) {
          try {
            await updateOrderDispatchDate(
              item.orderId,
              `${item.actualShipDay}T06:59:59.000Z`
            );
          } catch (shiftErr) {
            // Non-fatal: log + carry on. Veeqo may still buy a usable label
            // with the original dispatch_date — the warehouse will read the
            // employee note (added below) for the actual ship instruction.
            console.warn(
              `[buy] Could not push dispatch_date for order ${item.orderId} to ${item.actualShipDay}:`,
              shiftErr instanceof Error ? shiftErr.message : shiftErr
            );
          }
        }

        // Re-fetch live rates so we can read the actual Value-Added-
        // Service requirements from the matching rate. Veeqo's Amazon
        // Shipping V2 errors with INVALID_VALUE_ADDED_SERVICES if the
        // request VAS doesn't match what the rate offers — the only
        // reliable source is GetRates at purchase time, not what was
        // stored on the plan when rates were originally pulled.
        let liveVas: Record<string, string> = {};
        // Captured here so we can splice it into the error message when
        // Veeqo rejects the purchase — Vercel logs aren't visible to the
        // operator, but the modal is, so we surface the diagnostic
        // straight through the UI for one-shot debugging.
        let rateDiagnostic = "";
        try {
          const liveResp = await getShippingRates(item.allocationId);
          const liveRates: Record<string, unknown>[] =
            (liveResp?.available as Record<string, unknown>[]) || [];
          // CRITICAL: match by `name` (= the per-service UUID), NOT by
          // `remote_shipment_id`. The latter is the same value for ALL
          // rates within one allocation (Veeqo verified 2026-05-15:
          // 16 different rates on one allocation, all rsi=prb1fd6e1be),
          // so find() by rsi returns whichever rate is FIRST in the
          // array — almost always FedEx Ground Economy (SmartPost) —
          // regardless of which carrier we actually picked. This caused
          // every buy to send the SmartPost VAS contract (or lack
          // thereof) to Veeqo, hitting INVALID_VALUE_ADDED_SERVICES on
          // every UPS Ground Saver, FedEx Home Delivery, etc.
          const match =
            liveRates.find((r) => String(r.name) === item.serviceType) ??
            // Fallback: match by sub_carrier_id + service title. Useful
            // if Veeqo regenerates `name` UUIDs between fetches (not
            // observed yet, but cheap to be defensive).
            liveRates.find(
              (r) =>
                String(r.sub_carrier_id) === item.subCarrierId &&
                String(r.title) === item.service
            );
          if (match) {
            liveVas = extractVasFromRate(match);
            // Capture every field whose name might hint at VAS or rate
            // requirements — the extractor uses `value_added_service*`
            // by convention, but Veeqo may have moved/renamed it.
            const suspiciousFields = Object.fromEntries(
              Object.entries(match).filter(([k]) => {
                const lk = k.toLowerCase();
                return (
                  lk.includes("value_added") ||
                  lk.includes("vas") ||
                  lk.includes("addon") ||
                  lk.includes("service") ||
                  lk.includes("requirement") ||
                  lk.includes("mandatory") ||
                  lk.includes("option")
                );
              })
            );
            rateDiagnostic =
              `rateKeys=[${Object.keys(match).join(",")}] · ` +
              `suspiciousFields=${JSON.stringify(suspiciousFields)} · ` +
              `extracted=${JSON.stringify(liveVas)}`;
            console.log(`[buy] ${item.orderNumber} · ${rateDiagnostic}`);
          } else {
            rateDiagnostic =
              `no rate match for remote_shipment_id=${item.remoteShipmentId}, ` +
              `service=${item.serviceType}, ` +
              `liveRatesCount=${liveRates.length}`;
            console.warn(
              `[buy] no live rate match for ${item.orderNumber} (${rateDiagnostic})`
            );
          }
        } catch (rateErr) {
          rateDiagnostic = `rate re-fetch failed: ${
            rateErr instanceof Error ? rateErr.message : String(rateErr)
          }`;
          console.warn(
            `[buy] live rate re-fetch failed for ${item.orderNumber}:`,
            rateErr instanceof Error ? rateErr.message : rateErr
          );
        }

        // Single-shot buy. Veeqo's contract:
        //   • shipping_service_options=null  → don't send any VAS keys.
        //     extractVasFromRate returns {} in this case.
        //   • shipping_service_options=array → send the extracted keys.
        // Both paths are handled inside extractVasFromRate, so we don't
        // need any per-carrier branching or retry-with-alternates here.
        let shipment: Awaited<ReturnType<typeof buyShippingLabel>>;
        try {
          shipment = await buyShippingLabel({
            allocationId: item.allocationId,
            carrierId: item.carrierId,
            remoteShipmentId: item.remoteShipmentId,
            serviceType: item.serviceType,
            subCarrierId: item.subCarrierId,
            serviceCarrier: item.serviceCarrier,
            totalNetCharge: item.totalNetCharge,
            baseRate: item.baseRate,
            vas: liveVas,
          });
        } catch (buyErr) {
          const baseMsg =
            buyErr instanceof Error ? buyErr.message : String(buyErr);
          throw new Error(`${baseMsg} || DIAG: ${rateDiagnostic}`);
        }

        // Extract tracking — Veeqo's shape is inconsistent across
        // carriers. tracking_number can be a string OR an object with
        // {value, carrier, …}; sometimes it lives on shipment.shipment.
        // Previous String(...) coercion of an object produced
        // "[object Object]" in the employee note and Telegram summary.
        const tracking = pickTrackingString(shipment) ?? "N/A";

        // Persist the PDF, with three escalating layers so a single
        // failure never loses the label:
        //   1. Google Drive (real persistent storage; matches the
        //      operator's expected folder structure on shared Drive).
        //   2. Local disk in public/labels/… (only useful for dev/
        //      self-hosted; on Vercel the file system is ephemeral).
        //   3. Veeqo's own hosted label_url (always available because
        //      we just got it back in the buy response; saved verbatim
        //      so the operator can always click "Open PDF" in the modal
        //      even if Drive and disk both failed).
        let labelPath: string | null = null;
        let pdfSource: "drive" | "disk" | "proxy" | "none" = "none";
        let driveError: string | null = null;
        const shipmentId =
          shipment?.id ?? shipment?.shipment?.id ?? null;

        // Build the Veeqo PDF URL from `shipment.id` directly rather
        // than trusting `shipment.label_url`. Empirically, Veeqo
        // sometimes omits `label_url` from the `POST /shipping/shipments`
        // response (observed 2026-05-14 on order 114-8515802-0978666 —
        // buy succeeded, but `label_url` was absent → Drive upload was
        // skipped entirely and the PDF never made it to Drive). The
        // `/shipping/labels?shipment_ids[]=X&format=pdf` endpoint is
        // identical to what `label_url` would point to, so deriving it
        // from `shipment.id` is more reliable and matches what the
        // `/api/shipping/label-pdf` proxy does anyway.
        let veeqoLabelUrl: string | null = null;
        let veeqoLabelFetchOpts: RequestInit | undefined;
        if (shipmentId) {
          const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
          veeqoLabelUrl =
            `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
          veeqoLabelFetchOpts = {
            headers: {
              "x-api-key": process.env.VEEQO_API_KEY || "",
              Accept: "application/pdf",
            },
          };
        }

        if (veeqoLabelUrl) {
          try {
            const pdfRes = await fetch(veeqoLabelUrl, veeqoLabelFetchOpts);
            if (!pdfRes.ok) {
              console.error(
                `[buy] PDF download from Veeqo failed: HTTP ${pdfRes.status}`
              );
            } else {
              const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
              // Magic-byte guard. Same endpoint without format=pdf
              // returns the JSON counter `{"labels_count": 1}` (~18
              // bytes). If we somehow got that back, skip persistence
              // rather than pollute Drive with junk masquerading as PDF.
              const isPdf =
                pdfBuf.length >= 1000 &&
                pdfBuf.slice(0, 5).toString("ascii") === "%PDF-";
              if (!isPdf) {
                console.error(
                  `[buy] Veeqo returned non-PDF (${pdfBuf.length} bytes): ${pdfBuf
                    .slice(0, 80)
                    .toString("utf-8")}`
                );
              } else {
              const filename = buildPdfFilename(item);
              const folderPath = buildFolderPath(item);

              // ── Drive upload (preferred) ────────────────────────────
              const drive = await uploadLabelPdf({
                folderSegments: folderPath.split("/"),
                filename,
                pdf: pdfBuf,
              });
              if (drive.ok) {
                labelPath = drive.result.webViewLink;
                pdfSource = "drive";
              } else {
                driveError = drive.reason;
                console.warn(
                  `[buy] Drive upload failed for ${item.orderNumber}: ${drive.reason}`
                );
              }

              // ── Local disk (dev only — on Vercel this writes to an
              //    ephemeral /tmp-style mount that's gone after the
              //    response). Skip if Drive succeeded so we don't waste
              //    invocation time on a write that won't outlive the
              //    request. ─────────────────────────────────────────
              if (!drive.ok) {
                try {
                  const folderRel = `labels/${folderPath}`;
                  const folderAbs = join(process.cwd(), "public", folderRel);
                  if (!existsSync(folderAbs)) {
                    mkdirSync(folderAbs, { recursive: true });
                  }
                  const filePath = join(folderAbs, filename);
                  writeFileSync(filePath, pdfBuf);
                  labelPath = `/${folderRel}/${encodeURIComponent(filename)}`;
                  pdfSource = "disk";
                } catch (diskErr) {
                  console.warn(
                    "[buy] local disk save failed (expected on Vercel):",
                    diskErr instanceof Error ? diskErr.message : diskErr
                  );
                }
              }
              }
            }
          } catch (pdfErr) {
            console.error("[buy] PDF persistence error:", pdfErr);
          }
        }

        // Always fall back to OUR proxy endpoint. We can't link the
        // operator directly to Veeqo's URL because it needs the
        // x-api-key header — `/api/shipping/label-pdf?shipmentId=X`
        // fetches the PDF on the server (with auth) and streams it
        // back. Same-origin, no auth issues, always works as long as
        // the shipment exists in Veeqo.
        if (!labelPath && shipmentId) {
          labelPath = `/api/shipping/label-pdf?shipmentId=${shipmentId}`;
          pdfSource = "proxy";
        }

        // Add employee note. Include a SHIP-DAY badge when the plan
        // shifted the dispatch date forward (e.g. Frozen Monday-trick),
        // so the warehouse worker knows not to drop the label off today.
        const shipDayNote =
          item.actualShipDay && item.actualShipDay > todayIso
            ? ` | 📅 SHIP ON ${item.actualShipDay}`
            : "";
        await addEmployeeNote(
          parseInt(item.orderId),
          `✅ Label Purchased: ${item.carrier} ${item.service} $${item.price} | Tracking: ${tracking} | ${todayIso}${shipDayNote}`
        );

        // Update DB
        await prisma.shippingPlanItem.update({
          where: { id: item.id },
          data: {
            status: "bought",
            trackingNumber: tracking,
            labelPdfUrl: labelPath,
          },
        });

        results.bought.push({
          orderNumber: item.orderNumber,
          tracking,
          itemId: item.id,
          labelPath,
          pdfSaved: labelPath != null,
          pdfSource,
          driveError,
          carrier: item.carrier,
          service: item.service,
          price: item.price,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Buy error for ${item.orderNumber}:`, error);
        results.errors.push({ orderNumber: item.orderNumber, error: msg, itemId: item.id });

        try {
          await prisma.shippingPlanItem.update({
            where: { id: item.id },
            data: { status: "error", notes: msg.substring(0, 500) },
          });
        } catch (dbErr) {
          console.error("DB update error:", dbErr);
        }
      }
    }

    // Update plan status if all bought
    const remaining = await prisma.shippingPlanItem.count({
      where: { planId, status: "pending" },
    });
    if (remaining === 0) {
      await prisma.shippingPlan.update({
        where: { id: planId },
        data: { status: "completed" },
      });
    }

    // Telegram
    const summary = [
      `📦 Shipping Labels — ${plan.date}`,
      `✅ Bought: ${results.bought.length}`,
      results.errors.length > 0
        ? `❌ Errors: ${results.errors.length}\n${results.errors.map((e) => `  ${e.orderNumber}: ${e.error}`).join("\n")}`
        : null,
    ].filter(Boolean).join("\n");
    await sendTelegramMessage(summary);

    appendBuyLog({
      planId,
      planDate: plan.date,
      requested: itemsToBuy.length,
      bought: results.bought.map((b) => ({
        orderNumber: b.orderNumber,
        tracking: b.tracking,
        pdfSaved: b.pdfSaved,
        labelPath: b.labelPath,
        carrier: b.carrier,
        service: b.service,
        price: b.price,
      })),
      errors: results.errors.map((e) => ({
        orderNumber: e.orderNumber,
        error: e.error,
      })),
    });

    return NextResponse.json(results);
  } catch (error) {
    console.error("Buy labels error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to buy labels" },
      { status: 500 }
    );
  }
}
