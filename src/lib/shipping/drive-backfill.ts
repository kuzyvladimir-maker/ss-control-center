// Shared core for the Drive back-fill flow. Used by:
//   - /api/cron/drive-backfill          (cron / n8n trigger, bounded batch)
//   - /api/integrations/drive-backfill  (admin on-demand, bigger batch)
//
// Both find purchased labels whose PDFs didn't end up on Drive (labelPdfUrl
// missing OR still pointing at our /api/shipping/label-pdf proxy), pull the
// PDF from Veeqo, upload to Drive, and rewrite labelPdfUrl on the row.

import { prisma } from "@/lib/prisma";
import { uploadLabelPdf } from "@/lib/google-drive";
import {
  buildFolderPath,
  buildPdfFilename,
} from "@/lib/shipping-label-files";

export interface BackfillResult {
  found: number;
  lookbackDays: number;
  uploaded: Array<{
    itemId: string;
    orderNumber: string;
    shipmentId: string;
    labelPath: string;
  }>;
  errors: Array<{ itemId: string; orderNumber: string; reason: string }>;
  skipped: Array<{ itemId: string; orderNumber: string; reason: string }>;
}

// Veeqo's bulk-label endpoint returns the PDF straight when filtered by one
// shipment id. Same pattern as label-drive-retry route.
async function fetchVeeqoLabelPdf(shipmentId: string): Promise<Buffer> {
  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const apiKey = process.env.VEEQO_API_KEY;
  if (!apiKey) throw new Error("VEEQO_API_KEY not configured");

  const url = `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, Accept: "application/pdf" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veeqo ${res.status}: ${text.slice(0, 200)}`);
  }
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length < 1000 || pdf.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(
      `Veeqo returned non-PDF: ${pdf.length} bytes, ` +
        pdf.slice(0, 80).toString("utf-8"),
    );
  }
  return pdf;
}

// labelPdfUrl set by /api/shipping/buy's proxy fallback looks like
// "/api/shipping/label-pdf?shipmentId=1196697352". Extract the id so we
// can re-pull the PDF from Veeqo. Returns null for any other shape
// (including Drive webViewLinks, which never need back-fill).
function extractShipmentId(labelPdfUrl: string | null): string | null {
  if (!labelPdfUrl) return null;
  const m = labelPdfUrl.match(/shipmentId=(\d+)/);
  return m ? m[1] : null;
}

export async function runDriveBackfill(opts: {
  lookbackDays: number;
  maxBatchSize: number;
}): Promise<BackfillResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - opts.lookbackDays);

  const candidates = await prisma.shippingPlanItem.findMany({
    where: {
      status: "bought",
      updatedAt: { gte: cutoff },
      OR: [
        { labelPdfUrl: null },
        { labelPdfUrl: { contains: "/api/shipping/label-pdf" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: opts.maxBatchSize,
  });

  const results: BackfillResult = {
    found: candidates.length,
    lookbackDays: opts.lookbackDays,
    uploaded: [],
    errors: [],
    skipped: [],
  };

  for (const item of candidates) {
    const shipmentId = extractShipmentId(item.labelPdfUrl);
    if (!shipmentId) {
      results.skipped.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: "Cannot extract shipmentId from labelPdfUrl",
      });
      continue;
    }
    try {
      const pdf = await fetchVeeqoLabelPdf(shipmentId);
      const filename = buildPdfFilename(item);
      const folderPath = buildFolderPath(item);
      const drive = await uploadLabelPdf({
        folderSegments: folderPath.split("/"),
        filename,
        pdf,
      });
      if (!drive.ok) {
        results.errors.push({
          itemId: item.id,
          orderNumber: item.orderNumber,
          reason: drive.reason,
        });
        continue;
      }
      await prisma.shippingPlanItem.update({
        where: { id: item.id },
        data: { labelPdfUrl: drive.result.webViewLink },
      });
      results.uploaded.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        shipmentId,
        labelPath: drive.result.webViewLink,
      });
    } catch (e) {
      results.errors.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}
