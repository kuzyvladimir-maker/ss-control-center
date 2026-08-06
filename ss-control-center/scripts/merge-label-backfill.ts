// Backfill the label PDF for merged groups bought before the buy endpoint
// started saving one.
//
// Until 2026-08-05 /api/shipping/merge/buy purchased the label and recorded
// the tracking, but never touched the PDF — so a merged box came out of the
// flow with nothing to print. This walks the bought groups that have no
// `labelPdfUrl`, finds the shipment Veeqo created for the primary member,
// stores the PDF in Drive when Drive is available, and always leaves a
// working link behind (the authenticated proxy route otherwise).
//
// Read-only against the marketplaces: it buys nothing and ships nothing. The
// only write is `labelPdfUrl` on our own record.
//
//   node --import tsx scripts/merge-label-backfill.ts [--dry-run]

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { veeqoFetch } from "../src/lib/veeqo";
import { uploadLabelPdf } from "../src/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "../src/lib/shipping-label-files";

const dryRun = process.argv.includes("--dry-run");

interface VeeqoAllocation {
  id?: number | string;
  shipment?: {
    id?: number | string;
    tracking_number?: unknown;
    service_name?: string;
  } | null;
}

async function fetchVeeqoPdf(shipmentId: string): Promise<Buffer | null> {
  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const res = await fetch(
    `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`,
    {
      headers: {
        "x-api-key": process.env.VEEQO_API_KEY || "",
        Accept: "application/pdf",
      },
    },
  );
  if (!res.ok) {
    console.warn(`  ! Veeqo PDF HTTP ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    console.warn(`  ! not a PDF (${buf.length} bytes)`);
    return null;
  }
  return buf;
}

async function main() {
  const groups = await prisma.mergeGroup.findMany({
    where: { status: "bought", labelPdfUrl: null },
    include: { members: true },
  });
  console.log(`bought groups without a label PDF: ${groups.length}`);

  for (const g of groups) {
    console.log(`\n── ${g.id} ${g.channelKind} tracking=${g.trackingNumber}`);
    if (g.channelKind === "walmart") {
      // Walmart labels are fetched by carrier + tracking, not by a shipment
      // id, and re-downloading one is a different call path. Left for the
      // buy endpoint going forward rather than guessed at here.
      console.log("  skipped — Walmart group, no recovery path in this script");
      continue;
    }
    const primary = g.members.find((m) => m.orderId === g.primaryOrderId);
    if (!primary) {
      console.log("  skipped — no primary member");
      continue;
    }
    const order = (await veeqoFetch(`/orders/${primary.orderId}`)) as {
      allocations?: VeeqoAllocation[];
    };
    // Match the shipment by the tracking number we recorded at purchase, so a
    // group can never adopt a label bought for something else.
    const trackingOf = (s: VeeqoAllocation["shipment"]): string => {
      const t = s?.tracking_number;
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        for (const v of [o.tracking_number, o.value, o.number]) {
          if (typeof v === "string" && v) return v;
        }
      }
      return "";
    };
    const alloc = (order.allocations ?? []).find(
      (a) => trackingOf(a.shipment) === g.trackingNumber,
    );
    const shipmentId = alloc?.shipment?.id;
    if (!shipmentId) {
      console.log("  skipped — no Veeqo shipment matches the recorded tracking");
      continue;
    }
    console.log(`  shipment ${shipmentId} (${alloc?.shipment?.service_name})`);

    let url = `/api/shipping/label-pdf?shipmentId=${shipmentId}`;
    const pdf = await fetchVeeqoPdf(String(shipmentId));
    if (pdf) {
      try {
        const drive = await uploadLabelPdf({
          folderSegments: buildFolderPath({
            actualShipDay: (g.boughtAt ?? new Date()).toISOString().slice(0, 10),
            channel: g.storeName ?? g.channelKind,
            channelKind: g.channelKind,
          }).split("/"),
          filename: buildPdfFilename({
            edd: null,
            deliveryBy: null,
            product: `MERGED ${g.members.map((m) => m.orderNumber).join(" + ")}`,
            qty: g.members.length,
          }),
          pdf,
        });
        if (drive.ok) {
          url = drive.result.webViewLink;
          console.log(`  Drive: ${url}`);
        } else {
          console.log(`  Drive upload failed (${drive.reason}) — using proxy link`);
        }
      } catch (e) {
        console.log(
          `  Drive upload threw (${e instanceof Error ? e.message : e}) — using proxy link`,
        );
      }
    }
    if (dryRun) {
      console.log(`  DRY RUN — would set labelPdfUrl=${url}`);
      continue;
    }
    await prisma.mergeGroup.update({
      where: { id: g.id },
      data: { labelPdfUrl: url },
    });
    console.log(`  saved labelPdfUrl=${url}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
