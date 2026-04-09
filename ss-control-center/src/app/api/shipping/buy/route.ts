import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buyShippingLabel, addEmployeeNote, veeqoDateToLocal } from "@/lib/veeqo";
import { sendTelegramMessage } from "@/lib/telegram";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

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
      bought: [] as { orderNumber: string; tracking: string; itemId: string; labelPath: string | null }[],
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

        // Buy the label
        const shipment = await buyShippingLabel({
          allocationId: item.allocationId,
          carrierId: item.carrierId,
          remoteShipmentId: item.remoteShipmentId,
          serviceType: item.serviceType,
          subCarrierId: item.subCarrierId,
          serviceCarrier: item.serviceCarrier,
          totalNetCharge: item.totalNetCharge,
          baseRate: item.baseRate,
        });

        // Extract tracking — Veeqo returns snake_case
        const tracking = String(
          shipment?.tracking_number ||
          shipment?.shipment?.tracking_number ||
          shipment?.trackingNumber ||
          "N/A"
        );

        // Save PDF locally
        let labelPath: string | null = null;
        try {
          const labelUrl =
            shipment?.label_url ||
            shipment?.shipment?.label_url ||
            shipment?.label?.url ||
            null;

          if (labelUrl) {
            const folderRel = `labels/${buildFolderPath(item)}`;
            const folderAbs = join(process.cwd(), "public", folderRel);
            if (!existsSync(folderAbs)) mkdirSync(folderAbs, { recursive: true });

            const filename = buildPdfFilename(item);
            const filePath = join(folderAbs, filename);
            const pdfRes = await fetch(labelUrl);
            if (pdfRes.ok) {
              const buf = Buffer.from(await pdfRes.arrayBuffer());
              writeFileSync(filePath, buf);
              labelPath = `/${folderRel}/${encodeURIComponent(filename)}`;
            }
          }
        } catch (pdfErr) {
          console.error("PDF save error:", pdfErr);
        }

        // Add employee note
        await addEmployeeNote(
          parseInt(item.orderId),
          `✅ Label Purchased: ${item.carrier} ${item.service} $${item.price} | Tracking: ${tracking} | ${new Date().toISOString().split("T")[0]}`
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

        results.bought.push({ orderNumber: item.orderNumber, tracking, itemId: item.id, labelPath });
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

    return NextResponse.json(results);
  } catch (error) {
    console.error("Buy labels error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to buy labels" },
      { status: 500 }
    );
  }
}
