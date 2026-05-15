import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { uploadLabelPdf } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";

async function fetchVeeqoLabelPdf(shipmentId: string): Promise<Buffer> {
  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const apiKey = process.env.VEEQO_API_KEY;
  if (!apiKey) throw new Error("VEEQO_API_KEY not configured");

  const url = `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/pdf",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veeqo returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length < 1000 || pdf.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(
      `Veeqo did not return a PDF: ${pdf.length} bytes, ${pdf
        .slice(0, 80)
        .toString("utf-8")}`
    );
  }
  return pdf;
}

// POST /api/shipping/label-drive-retry
// Body: { "shipmentId": "1196697352", "itemId": "optional plan item id" }
//
// Re-fetches an already purchased Veeqo label and uploads it to Drive.
// Useful when the buy flow fell back to `/api/shipping/label-pdf?...`
// because Drive was not configured at purchase time.
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const shipmentId =
    typeof body.shipmentId === "string" ? body.shipmentId.trim() : "";
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";

  if (!/^\d+$/.test(shipmentId)) {
    return NextResponse.json(
      { error: "shipmentId is required and must be numeric" },
      { status: 400 }
    );
  }

  const item = itemId
    ? await prisma.shippingPlanItem.findUnique({ where: { id: itemId } })
    : await prisma.shippingPlanItem.findFirst({
        where: {
          labelPdfUrl: { contains: `shipmentId=${shipmentId}` },
        },
        orderBy: { updatedAt: "desc" },
      });

  if (!item) {
    return NextResponse.json(
      {
        error:
          "Shipping plan item not found. Pass itemId, or retry a label whose current URL contains this shipmentId.",
      },
      { status: 404 }
    );
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
      return NextResponse.json(
        {
          ok: false,
          shipmentId,
          itemId: item.id,
          orderNumber: item.orderNumber,
          driveError: drive.reason,
        },
        { status: 502 }
      );
    }

    await prisma.shippingPlanItem.update({
      where: { id: item.id },
      data: { labelPdfUrl: drive.result.webViewLink },
    });

    return NextResponse.json({
      ok: true,
      shipmentId,
      itemId: item.id,
      orderNumber: item.orderNumber,
      folderPath,
      filename,
      labelPath: drive.result.webViewLink,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
